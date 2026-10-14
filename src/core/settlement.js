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
import { advanceQuests } from './quests.js';
import { settleCarryAfterRaid } from './loadout.js';
import { stashAdd } from './stash.js';
import { valueReadout } from './items.js';

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

  // ---- ① 消耗：按"带进去多少 − 局内还剩多少"算，装备不计（M5 没有耐久持久化）----
  const consumed = [];
  //
  // ★ M6-4：`taken` 里的携行件是**一格一条**（120 发 = 两盒 60），
  //   而"局内还剩多少"是按物品报的总数。若逐条相减，每一条都会各自被"剩下 90 发"
  //   减成负数再夹回 0 —— 于是 30 发的消耗被算成 0，账目凭空多出 30 发。
  //   （这是"一格一条"模型带来的新陷阱：同类物品必须先按物品汇总再对账。）
  const takenByItem = new Map();
  if (taken && taken.length) {
    for (const t of taken) {
      if (t.kind === 'equipment') continue;
      const cur = takenByItem.get(t.itemId) || { itemId: t.itemId, kind: t.kind, caliber: t.caliber, count: 0 };
      cur.count += t.count;
      takenByItem.set(t.itemId, cur);
    }
  }
  for (const t of takenByItem.values()) {
    const left =
      t.kind === 'ammo'
        ? (remaining && remaining.ammo && remaining.ammo[t.caliber]) || 0
        : (remaining && remaining.consumables && remaining.consumables[t.itemId]) || 0;
    const used = Math.max(0, Math.min(t.count, t.count - Math.max(0, left)));
    if (used > 0) consumed.push({ itemId: t.itemId, count: used, kind: t.kind });
  }

  // ---- ② 携行网格的账（★ M6-4：战利品先回网格，网格塞不下才进仓库）----
  //
  // 撤离：从网格扣掉真实消耗 → 战利品塞回网格（弹挂优先）→ 塞不下的进仓库。
  // 未撤离：背包与弹挂清空，保险箱保留 —— 那就是"保险箱"三个字的意思。
  //
  // ★ M6-4：**补结算**（上局没走完就刷新 / 关闭页面）绝不能碰玩家的携行网格。
  //
  //   补结算发生在**下一局开始之前**（点提示看结算、或直接点进战区），
  //   那一刻网格里已经是玩家为下一局摆好的东西。而快照的口径恒为"未撤离"
  //   （checkpointToFacts 写死 outcome:'death'），照常规路径走就会把背包与弹挂清空 ——
  //   表现为"我在大厅摆好的一包子弹，点进战区时被上一局的账清掉了"。
  //
  //   那时"上一局身上的东西"其实已经随页面一起没了，没有别处可退；
  //   快照里真正保住的只有保险箱那几件（checkpointToFacts 已按 inSafe 切好），
  //   直接入库就是它全部的账。
  let stowed = [];
  if (input.interrupted) {
    for (const it of result.items || []) {
      const def = cfg.itemDefs[it && it.id];
      if (!def) continue;
      const units = Number.isFinite(it.count) ? it.count : def.unitsPerItem;
      const add = stashAdd(next.stash, def.id, units, cfg);
      next = { ...next, stash: add.stash };
      if (add.added > 0) deposited.push({ itemId: def.id, count: add.added, grid: 'stash', leftover: 0 });
      if (add.leftover > 0) overflow.push({ itemId: def.id, count: add.leftover });
    }
  } else {
    const carryRes = settleCarryAfterRaid(
      next,
      {
        survived: isExtract,
        consumed,
        loot: result.items || [],
        // 装备（武器 / 护甲 / 背包 / 弹挂）：撤离才还回仓库，阵亡整份丢失。
        equipment: (taken || []).filter((t) => t.kind === 'equipment'),
      },
      cfg
    );
    next = carryRes.profile;
    stowed = carryRes.stowed;
    for (const d of carryRes.deposited) deposited.push({ ...d, leftover: 0 });
    for (const r of carryRes.returned) deposited.push({ ...r, leftover: 0 });
    overflow.push(...carryRes.overflow);
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
    // 用 unitValue：consumed 的 count 是**存储单位数**（发 / 个）；读数取整（M6-4）
    spentValue += valueReadout(cfg.itemDefs[c.itemId], c.count);
  }
  spentValue = Math.round(spentValue);
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
      /** ★ M6-4：撤离后**留在身上网格里**的战利品（不再自动还回仓库） */
      stowed,
      returned: [],
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
