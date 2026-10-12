// M5 局外结算：把一局的结算结果写进玩家档案（幂等）
//
// 为什么单独成文件、且必须是纯函数：
//   ① 它是**唯一**改档案的玩法路径 —— 货币、仓库、经验、任务、统计、经济样本
//      都从这里落库。散在 main.js 里就变成"哪一步漏了没人知道"。
//   ② 它必须幂等：结算可能被触发两次（点提示看结算、又点进战区；
//      或者刷新补结算与正常结算撞在一起）。档案里的 `lastRaidId` 是幂等键，
//      同一个 raidId 第二次提交直接返回原档案（不累加、不重复推进任务）。
//
// 与 M4 的关系：buildRaidResult（core/raidResult.js）负责"这一局发生了什么"，
// 本文件负责"它给玩家带来什么"。前者是事实，后者是账。分开的理由见 M4 的报告。

import { alreadyApplied } from './profile.js';
import { applyExp, raidExp } from './progression.js';
import { stashAdd } from './stash.js';
import { advanceQuests } from './quests.js';
import { returnLoadout } from './loadout.js';
import { itemDef } from './items.js';

/**
 * @param {object} profile 当前档案
 * @param {object} input {
 *   raidId: string,
 *   atMs: number,
 *   result: buildRaidResult 的产物（outcome / loot / items / combat …）,
 *   facts: { kills, killsByTier, containersOpened, containersByType,
 *            keptItems:[{itemId,count}], keptValue, extractId, mapId },
 *   taken: takeLoadout 的产物（进局时从仓库扣掉的东西）,
 *   remaining: 局内剩余的弹药与消耗品 { ammo:{caliber:rounds}, consumables:{itemId:n} }
 * }
 * @returns {{ok:boolean, applied:boolean, reason?:string, profile:object, summary?:object}}
 */
export function applyRaidToProfile(profile, input, cfg) {
  const { raidId, result, facts, taken, remaining } = input;
  if (!raidId) return { ok: false, applied: false, reason: 'missing-raid-id', profile };
  if (!result) return { ok: false, applied: false, reason: 'missing-result', profile };

  // ★ 幂等键。注意它查的是"这个 raidId 是否已经进过档案"，而不是"调用了几次"。
  if (alreadyApplied(profile, raidId)) {
    return { ok: true, applied: false, reason: 'already-applied', profile };
  }

  const isExtract = result.outcome === 'extract';
  let next = profile;
  const overflow = [];
  const deposited = [];

  // ---- ① 配装的去留 ----
  // 撤离：把**没用完的**还回仓库（只扣消耗量）。阵亡 / 超时 / 放弃 / 断线：什么都不还，
  //       因为那些东西在 takeLoadout 时就已经离开仓库了 —— 这正是"死一次就丢装备"的实现。
  let returned = [];
  let consumed = [];
  if (taken && taken.length) {
    if (isExtract) {
      const r = returnLoadout(next, taken, remaining || {}, cfg);
      next = r.profile;
      returned = r.returned;
      consumed = r.consumed;
      overflow.push(...r.overflow);
    } else {
      consumed = taken.map((t) => ({ itemId: t.itemId, count: t.count, kind: t.kind }));
    }
  }

  // ---- ② 带出的战利品入库 ----
  // result.items 是 buildRaidResult 的逐件明细（阵亡时它就是安全箱保住的那几件）。
  // ★ 单位换算：局内按**件**计数，仓库按**存储单位**计数 —— 弹药的一件是一盒
  //   （= itemDef.unitsPerItem 发），其余物品一件就是 1 个。换算的唯一实现在 config。
  // 仓库放不下时走 overflow 通道 —— **不静默丢弃**，由结算界面明确告诉玩家。
  const byItem = new Map();
  for (const it of result.items || []) {
    const def = itemDef(it.id, cfg);
    const units = def ? def.unitsPerItem : 1;
    byItem.set(it.id, (byItem.get(it.id) || 0) + units);
  }
  for (const [itemId, count] of byItem) {
    const add = stashAdd(next.stash, itemId, count, cfg);
    if (add.leftover > 0) overflow.push({ itemId, count: add.leftover });
    deposited.push({ itemId, count: add.added, leftover: add.leftover });
    next = { ...next, stash: add.stash };
  }

  // ---- ③ 经验（升级时发技能点）----
  const gainedExp = raidExp(
    {
      outcome: result.outcome,
      kills: (facts && facts.kills) || 0,
      containersOpened: (facts && facts.containersOpened) || 0,
      keptValue: result.loot ? result.loot.keptValue : 0,
    },
    cfg
  );
  const expRes = applyExp(next, gainedExp, cfg);
  next = expRes.profile;

  // ---- ④ 任务推进 ----
  // advanceQuests 自己按制作人裁定的口径处理：击杀/开箱在阵亡局照常推进，
  // collect/extract 只在成功撤离时推进。
  const qRes = advanceQuests(
    next,
    {
      outcome: result.outcome,
      kills: (facts && facts.kills) || 0,
      killsByTier: (facts && facts.killsByTier) || {},
      containersOpened: (facts && facts.containersOpened) || 0,
      containersByType: (facts && facts.containersByType) || {},
      keptItems: (facts && facts.keptItems) || [],
      keptValue: (facts && facts.keptValue) || 0,
      extractId: (facts && facts.extractId) || null,
      mapId: (facts && facts.mapId) || null,
    },
    cfg
  );
  next = qRes.profile;

  // ---- ⑤ 统计与经济样本 ----
  // 消耗口径：撤离时是"用掉的那部分"；阵亡时是"整套行头"（都丢了）。
  let spentValue = 0;
  for (const c of consumed) {
    const def = itemDef(c.itemId, cfg);
    // 用 unitValue：consumed 的 count 是**存储单位数**（发 / 个）
    if (def) spentValue += def.unitValue * c.count;
  }
  const stats = {
    ...next.stats,
    raids: next.stats.raids + 1,
    // deaths 的口径是"未撤离"（含阵亡 / 超时 / 放弃 / 断线）—— 它就该这么读：
    // 玩家关心的是"我有几局没出来"，不是具体死因（死因在结算里）。
    extracts: next.stats.extracts + (isExtract ? 1 : 0),
    deaths: next.stats.deaths + (isExtract ? 0 : 1),
    kills: next.stats.kills + ((facts && facts.kills) || 0),
    earned: next.stats.earned + (result.loot ? result.loot.keptValue : 0),
    lost: next.stats.lost + (result.loot ? result.loot.lostValue : 0),
    bestValue: Math.max(next.stats.bestValue, result.loot ? result.loot.keptValue : 0),
  };
  const samples = [
    ...next.economy.samples,
    {
      raidId,
      atMs: input.atMs || 0,
      outcome: isExtract ? 'extract' : 'death',
      income: result.loot ? result.loot.keptValue : 0,
      spent: spentValue,
    },
  ].slice(-cfg.economy.inflation.maxSamples);

  next = { ...next, stats, economy: { samples }, lastRaidId: raidId };

  return {
    ok: true,
    applied: true,
    profile: next,
    summary: {
      raidId,
      outcome: result.outcome,
      reason: result.reason,
      exp: gainedExp,
      level: expRes.after.level,
      leveledTo: expRes.leveledTo,
      skillPoints: next.progression.skillPoints,
      deposited,
      returned,
      consumed,
      overflow,
      questsAdvanced: qRes.advanced,
      questsCompleted: qRes.completedNow,
      spentValue,
      keptValue: result.loot ? result.loot.keptValue : 0,
      lostValue: result.loot ? result.loot.lostValue : 0,
    },
  };
}
