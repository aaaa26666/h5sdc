// M4-7 单局快照（纯函数，不含任何存储 API）
//
// 职责：把"这一局到目前为止的样子"压缩成一个可序列化对象，并把它校验回来。
//
// 为什么需要它：《流程文档》§2.6 与 M4 约束词要求
//   · 断线 / 关闭浏览器视为"未撤离"（不是静默丢弃）；
//   · 禁止在断线/刷新场景下静默丢弃玩家进度。
// 做法是"本地双写"：局内定期写一份快照作为兜底，关闭瞬间再写一份最新的。
// 下次进来若发现快照还在（说明上局没走完），就按未撤离口径补一次结算。
//
// 为什么单独成文件：快照要能被纯逻辑单测（尤其是**校验**部分）——
// localStorage 里的内容是**外部输入**，可能被改坏、可能是旧版本留下的，
// 直接 JSON.parse 就用的话，一个坏字段能让整个结算界面崩掉。

import { valueReadout } from './items.js';

export const CHECKPOINT_VERSION = 1;

/** 单个物品在快照里的形态：只留结算需要的东西，不塞整个 item 定义 */
function itemToSnapshot(e) {
  const units = e.item.unitsPerItem || 1;
  const count = Number.isFinite(e.count) ? e.count : units;
  return {
    id: e.item.id,
    label: e.item.label,
    // ★ M6：一格可以只装半盒（打剩 30 发），因此入仓单位数与估值都按这一格实际剩多少算。
    count,
    // ★ M6-4：估值读数取整（与仓库 / HUD / 结算页共用 core/items.js 的 valueReadout）
    value: valueReadout(e.item, count),
    rarity: e.item.rarity || null,
    inSafe: !!e.inSafe,
  };
}

/**
 * 生成快照。
 * @param {object} facts
 * @param {string} facts.raidId      本局唯一标识（幂等结算的依据）
 * @param {number} facts.elapsedMs   局内已过时间
 * @param {Array}  facts.inventory   inventory.items（含 inSafe 标记）
 * @param {object} facts.combat      { kills, aiTotal, containersOpened, containersTotal, shotsFired, health }
 */
export function buildCheckpoint(facts) {
  return {
    version: CHECKPOINT_VERSION,
    raidId: String(facts.raidId),
    elapsedMs: Math.max(0, Math.round(facts.elapsedMs || 0)),
    combat: {
      kills: facts.combat.kills | 0,
      aiTotal: facts.combat.aiTotal | 0,
      containersOpened: facts.combat.containersOpened | 0,
      containersTotal: facts.combat.containersTotal | 0,
      shotsFired: facts.combat.shotsFired | 0,
      health: Math.max(0, facts.combat.health || 0),
    },
    items: (facts.inventory || []).map(itemToSnapshot),
  };
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验并规范化一份快照（外部输入）。
 * @returns {object|null} 合法返回规范化后的对象；任何一处不对就返回 null。
 *
 * 刻意**不做宽松修复**：宁可整份丢弃（上局按无物品结算），
 * 也不要把半坏的数据喂给结算界面 —— 那会产出一个"看起来对其实错"的结果。
 */
export function sanitizeCheckpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== CHECKPOINT_VERSION) return null;
  if (typeof raw.raidId !== 'string' || !raw.raidId) return null;
  if (!isFiniteNum(raw.elapsedMs) || raw.elapsedMs < 0) return null;

  const c = raw.combat;
  if (!c || typeof c !== 'object') return null;
  const num = (v) => (isFiniteNum(v) ? v : 0);
  const combat = {
    kills: num(c.kills),
    aiTotal: num(c.aiTotal),
    containersOpened: num(c.containersOpened),
    containersTotal: num(c.containersTotal),
    shotsFired: num(c.shotsFired),
    health: Math.max(0, num(c.health)),
  };

  if (!Array.isArray(raw.items)) return null;
  const items = [];
  for (const it of raw.items) {
    if (!it || typeof it !== 'object') return null;
    if (typeof it.id !== 'string' || typeof it.label !== 'string') return null;
    if (!isFiniteNum(it.value)) return null;
    items.push({
      id: it.id,
      label: it.label,
      // count 是 M6 新增字段：旧快照没有它 → 保持 undefined，
      // 结算侧会退回"一件 = unitsPerItem 个存储单位"的老口径（见 core/settlement.js）。
      count: isFiniteNum(it.count) ? it.count : undefined,
      value: it.value,
      rarity: typeof it.rarity === 'string' ? it.rarity : null,
      inSafe: !!it.inSafe,
    });
  }

  return {
    version: CHECKPOINT_VERSION,
    raidId: raw.raidId,
    elapsedMs: raw.elapsedMs,
    combat,
    items,
  };
}

/**
 * 把快照还原成结算所需的事实（口径：断线 = 未撤离 = 只保住安全箱里的）。
 *
 * 注意这里**不**调用 inventory.settle —— 快照里没有真正的 inventory 实例，
 * 而且断线的语义本身就等同于 death，直接按 inSafe 切分即可，结果一致。
 */
export function checkpointToFacts(cp, rarityTable = []) {
  const kept = cp.items.filter((i) => i.inSafe);
  const lost = cp.items.filter((i) => !i.inSafe);
  const sum = (list) => list.reduce((a, i) => a + i.value, 0);
  return {
    reason: 'disconnected',
    outcome: 'death',
    elapsedMs: cp.elapsedMs,
    kills: cp.combat.kills,
    aiTotal: cp.combat.aiTotal,
    containersOpened: cp.combat.containersOpened,
    containersTotal: cp.combat.containersTotal,
    shotsFired: cp.combat.shotsFired,
    health: cp.combat.health,
    // inSafe 一并带上：结算结果里的"保险箱保住了这几件"依赖它，
    // 而它原本挂在 item 上（那是快照的存储形态），不是结算条目的形态。
    kept: kept.map((i) => ({ item: i, count: i.count, inSafe: true })),
    lost: lost.map((i) => ({ item: i, count: i.count, inSafe: false })),
    keptValue: sum(kept),
    lostValue: sum(lost),
    safeValue: sum(kept),
    rarityTable,
  };
}
