// M3-5 拾取、丢弃、背包格子与容量、负重
// M3-6 安全箱（阵亡时其中物品保留）
//
// 职责：二维网格背包、负重上限、物品形状排放、安全箱自动装填、死亡结算。
//
// 数值来源：`src/config/loot.json`（backpack / safeContainer），不是本文件硬编码。
// 背包 6×5=30 格、战利品净重 22kg（不含身上装备：护甲 ≈4kg + 步枪 ≈4.6kg + 弹药等 ≈10kg）。
//
// 装包算法只此一份：`src/core/packing.js`，与掉落表校验脚本（理论分布）共用 ——
// 这样"理论能装多少"和"运行时实际装了多少"才是可比的两件事。
import { createGrid, findSlot, markArea, repack } from '../core/packing.js';

/**
 * @param {object} cfg 配置（需含 lootTable）
 * @param {object} [opts]
 * @param {string} [opts.safeTierId] 安全箱档位，默认新账号档（tiers[0] = 1×2）
 */
export function createInventory(cfg, opts = {}) {
  const table = cfg.lootTable;
  const bpDef = table.backpack;
  const safeDef = table.safeContainer;
  const excluded = safeDef.excludeCategories || [];

  const grid = createGrid(bpDef.w, bpDef.h);
  const weightLimitKg = bpDef.weightLimitKg;

  const tierId = opts.safeTierId || safeDef.tiers[0].id;
  const tier = safeDef.tiers.find((t) => t.id === tierId) || safeDef.tiers[0];
  const safeGrid = createGrid(tier.w, tier.h);

  /** 背包内物品：{ uid, item, x, y, w, h, rotated, inSafe } */
  let items = [];
  let uidSeq = 1;

  const weightOf = (list) => list.reduce((a, e) => a + e.item.weightKg, 0);
  const valueOf = (list) => list.reduce((a, e) => a + e.item.value, 0);

  /**
   * 安全箱里已经装了什么（按价值密度降序自动装填，与理论模拟的口径一致）。
   *
   * [M3-TEMP-2] 装填是**自动**的：玩家不能指定"这个进保险箱"。
   * 自动策略取"价值密度最高且类别允许"，与掉落表校验脚本的模拟口径一致；
   * 但真人有更细的偏好（例如优先保任务物品）。显式指定要等 M5 的背包 UI。
   */
  function refillSafe() {
    // 先清空安全箱的占位，但保留"哪些物品在安全箱里"的标记由重新装填决定
    for (let y = 0; y < safeGrid.h; y++) safeGrid.occupied[y].fill(false);
    for (const e of items) e.inSafe = false;

    // 候选：类别允许、且在背包里的物品，按价值密度降序 —— 玩家会把最值钱的塞进保命口袋
    const candidates = items
      .filter((e) => !excluded.includes(e.item.category))
      .sort((a, b) => b.item.value / b.item.vol - a.item.value / a.item.vol);

    for (const e of candidates) {
      const slot = findSlot(safeGrid, e.item);
      if (!slot) continue;
      markArea(safeGrid, slot.x, slot.y, slot.w, slot.h, true);
      e.inSafe = true;
      e.safeSlot = slot;
    }
  }

  /**
   * 尝试把一件物品放进背包。
   * @returns {{ok:boolean, reason?:string, entry?:object}}
   */
  function tryAdd(item) {
    if (weightKg() + item.weightKg > weightLimitKg) {
      return { ok: false, reason: 'weight' };
    }
    const slot = findSlot(grid, item);
    if (!slot) return { ok: false, reason: 'space' };
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    const entry = { uid: uidSeq++, item, ...slot, inSafe: false };
    items.push(entry);
    refillSafe();
    return { ok: true, entry };
  }

  /** 不实际放入，只判断能不能放（用于"背包满了"的提前提示）。 */
  function canAdd(item) {
    if (weightKg() + item.weightKg > weightLimitKg) return false;
    return !!findSlot(grid, item);
  }

  /** 丢弃（或从背包移除）一件。返回被移除的条目。 */
  function remove(uid) {
    const i = items.findIndex((e) => e.uid === uid);
    if (i < 0) return null;
    const [e] = items.splice(i, 1);
    // 重建整张占用图：增量腾空容易与其他物品的旋转状态不一致
    rebuildOccupancy();
    refillSafe();
    return e;
  }

  function rebuildOccupancy() {
    for (let y = 0; y < grid.h; y++) grid.occupied[y].fill(false);
    for (const e of items) markArea(grid, e.x, e.y, e.w, e.h, true);
  }

  /**
   * 整理背包：按价值密度降序重新排放。
   * 运行时是"捡到什么塞什么"，整理后会向理论模拟的容量靠拢（见 packing.js 的说明）。
   */
  function tidy() {
    const before = items.map((e) => e.item);
    const res = repack(grid, before, weightLimitKg, []);
    items = res.placed.map((p) => ({
      uid: uidSeq++, item: p.item, x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated, inSafe: false,
    }));
    refillSafe();
    return { placed: items.length, leftovers: res.leftovers.length };
  }

  const weightKg = () => weightOf(items);
  const value = () => valueOf(items);
  const safeValue = () => valueOf(items.filter((e) => e.inSafe));

  /**
   * M3-6 死亡掉落结算。
   *   撤离成功 → 全部带出；阵亡 / 超时 / 断线 → 只保住安全箱里的。
   * @param {'extract'|'death'} outcome
   */
  function settle(outcome) {
    const kept = outcome === 'extract' ? items.slice() : items.filter((e) => e.inSafe);
    const lost = outcome === 'extract' ? [] : items.filter((e) => !e.inSafe);
    return {
      outcome,
      kept,
      lost,
      keptValue: valueOf(kept),
      lostValue: valueOf(lost),
      keptWeightKg: weightOf(kept),
    };
  }

  return {
    grid,
    safeGrid,
    safeTier: tier,
    weightLimitKg,
    get items() { return items; },
    get count() { return items.length; },
    weightKg,
    value,
    safeValue,
    /** 已用格数（按形状计，不是条目数） */
    usedSlots: () => items.reduce((a, e) => a + e.w * e.h, 0),
    totalSlots: () => bpDef.w * bpDef.h,
    tryAdd,
    canAdd,
    remove,
    tidy,
    settle,
    /** 安全箱能否装下某物品（类别限制 + 形状） */
    safeAccepts: (item) => !excluded.includes(item.category),
  };
}
