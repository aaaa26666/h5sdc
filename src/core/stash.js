// M5-2 仓库（纯函数，无 DOM / 无 localStorage）
//
// 定位：局外的物品容器。它与局内背包**共用同一套排放算法**（core/packing.js）——
// 这不是巧合而是要求：如果仓库用"A 算法"、背包用"B 算法"，那么"仓库里摆得下、
// 带进战区就摆不下"这类问题会被归因成数值问题，而实际是两套实现分叉。
//
// 与局内背包的三点差别（都是有意的）：
//   ① 仓库支持**堆叠**（弹药按 stack 上限归并），背包按件占位；
//   ② 仓库有排序与批量出售（局内没有）；
//   ③ 仓库永远不"负重"——重量只用于显示与配装决策。
//
// 本文件不读配置表对象，只接受调用方传入的 cfg（含 itemDefs / economy.stash），
// 因此可以在 Node 单测里独立驱动。

import { createGrid, findSlot, markArea } from './packing.js';
import { itemDef, itemShape, equivalentIds } from './items.js';

/** 仓库尺寸（来自经济表）。 */
export function stashSize(cfg) {
  const s = cfg.economy.stash;
  return { w: s.w, h: s.h };
}

function nextUid(entries) {
  let max = 0;
  for (const e of entries) if (Number.isFinite(e.uid) && e.uid > max) max = e.uid;
  return max + 1;
}

/** 按现有条目构建占用图（形状由物品定义 + rotated 推导，条目不存 w/h）。 */
export function stashGrid(entries, cfg) {
  const { w, h } = stashSize(cfg);
  const grid = createGrid(w, h);
  for (const e of entries) {
    const def = itemDef(e.itemId, cfg);
    if (!def) continue;
    const sh = itemShape(def, e.rotated);
    if (e.x < 0 || e.y < 0 || e.x + sh.w > w || e.y + sh.h > h) continue;
    markArea(grid, e.x, e.y, sh.w, sh.h, true);
  }
  return grid;
}

export function stashUsedSlots(entries, cfg) {
  let sum = 0;
  for (const e of entries) {
    const def = itemDef(e.itemId, cfg);
    if (!def) continue;
    const sh = itemShape(def, e.rotated);
    sum += sh.w * sh.h;
  }
  return sum;
}

export function stashCapacity(cfg) {
  const { w, h } = stashSize(cfg);
  return w * h;
}

/**
 * 仓库估值与重量：按**存储单位**（发 / 个）计数。
 *
 * 用 unitValue / unitWeightKg（= 每件 ÷ 每件的单位数）而不是 value / weightKg：
 * 弹药的"一件"是一盒（60 发），若按件计价，仓库里 60 发会被算成 60 件的价值 ——
 * 正好高估 60 倍。单位换算的唯一实现在 src/config/index.js 的 buildItemViews。
 */
export function stashValue(entries, cfg) {
  let sum = 0;
  for (const e of entries) {
    const def = itemDef(e.itemId, cfg);
    if (def) sum += def.unitValue * e.count;
  }
  return sum;
}

export function stashWeight(entries, cfg) {
  let sum = 0;
  for (const e of entries) {
    const def = itemDef(e.itemId, cfg);
    if (def) sum += def.unitWeightKg * e.count;
  }
  return sum;
}

/** 物品**件数**（含堆叠内的数量）。 */
export function stashItemCount(entries) {
  return entries.reduce((a, e) => a + e.count, 0);
}

/** 某物品（含等价 id：装备 ↔ 物品形态）在仓库里的总数量。 */
export function stashTotalOf(entries, itemId, cfg) {
  const ids = equivalentIds(itemId, cfg);
  let sum = 0;
  for (const e of entries) if (ids.has(e.itemId)) sum += e.count;
  return sum;
}

/** 某物品的第一条（用于配装时取"哪一件"——按 uid 升序，先入库的先被用）。 */
export function stashFirstOf(entries, itemId, cfg) {
  const ids = equivalentIds(itemId, cfg);
  let best = null;
  for (const e of entries) {
    if (!ids.has(e.itemId)) continue;
    if (!best || e.uid < best.uid) best = e;
  }
  return best;
}

/**
 * 放入物品：**先填已有堆叠，再开新条目**（真人也是先把子弹塞进半满的盒子）。
 * @returns {{stash:Array, added:number, leftover:number, addedUids:number[]}}
 *          leftover > 0 表示仓库放不下 —— 调用方必须把这件事显示给玩家（禁止静默丢弃）。
 */
export function stashAdd(entries, itemId, count, cfg) {
  const def = itemDef(itemId, cfg);
  if (!def) return { stash: entries.slice(), added: 0, leftover: count, addedUids: [] };
  const out = entries.map((e) => ({ ...e }));
  const maxStack = def.stack;
  let left = count;
  const addedUids = [];

  for (const e of out) {
    if (left <= 0) break;
    if (e.itemId !== itemId) continue;
    const room = maxStack - e.count;
    if (room <= 0) continue;
    const take = Math.min(room, left);
    e.count += take;
    left -= take;
    if (!addedUids.includes(e.uid)) addedUids.push(e.uid);
  }

  const grid = stashGrid(out, cfg);
  let uid = nextUid(out);
  while (left > 0) {
    // findSlot 自带旋转尝试（allowRotate 默认 true），不需要在这里再试一次
    const slot = findSlot(grid, def);
    if (!slot) break;
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    const take = Math.min(maxStack, left);
    out.push({ uid: uid++, itemId, count: take, x: slot.x, y: slot.y, rotated: slot.rotated });
    addedUids.push(uid - 1);
    left -= take;
  }

  return { stash: out, added: count - left, leftover: left, addedUids };
}

/** 按 uid 移除若干件（数量归零则删除条目）。 */
export function stashRemove(entries, uid, count, cfg) {
  const out = entries.map((e) => ({ ...e }));
  const e = out.find((x) => x.uid === uid);
  if (!e) return { stash: entries.slice(), removed: 0 };
  const take = Math.max(0, Math.min(e.count, count));
  e.count -= take;
  return { stash: out.filter((x) => x.count > 0), removed: take, itemId: e.itemId };
}

/**
 * 按 itemId 移除若干件（配装时"从仓库里取装备"用它）。
 * 等价 id 一并匹配：装 dmr_sr25 时能扣掉仓库里的 rifle_sr25。
 */
export function stashRemoveItem(entries, itemId, count, cfg) {
  const ids = equivalentIds(itemId, cfg);
  const out = entries.map((e) => ({ ...e }));
  let left = count;
  const lines = [];
  for (const e of out) {
    if (left <= 0) break;
    if (!ids.has(e.itemId)) continue;
    const take = Math.min(e.count, left);
    e.count -= take;
    left -= take;
    lines.push({ uid: e.uid, itemId: e.itemId, count: take });
  }
  return { stash: out.filter((x) => x.count > 0), removed: count - left, leftover: left, lines };
}

/**
 * 规范仓库内容：丢弃未知物品 / 非法数量 → 拆分超量堆叠 → 合并同种物品 → 重新排放。
 *
 * 为什么必须存在：存档是**外部输入**（玩家可改、旧版本可写、可能被别的脚本污染）。
 * 直接信任它的后果是"某一格重叠了"或"堆叠数超过上限"，而这类问题在游戏里表现为
 * 说不清的拾取行为。这里做一次收敛，并返回 overflow 让调用方记一笔修复记录。
 */
export function stashNormalize(entries, cfg) {
  const dropped = [];
  const work = [];

  for (const raw of Array.isArray(entries) ? entries : []) {
    const def = itemDef(raw && raw.itemId, cfg);
    if (!def) {
      dropped.push({ reason: 'unknown-item', itemId: raw && raw.itemId });
      continue;
    }
    let count = Math.floor(Number(raw.count));
    if (!Number.isFinite(count) || count <= 0) {
      dropped.push({ reason: 'bad-count', itemId: raw.itemId, count: raw.count });
      continue;
    }
    // 超量堆叠拆成多份（而不是截断 —— 截断就是丢玩家的东西）
    while (count > 0) {
      const take = Math.min(def.stack, count);
      work.push({ itemId: raw.itemId, count: take });
      count -= take;
    }
  }

  // 合并同种物品（上限 stack），再统一排放
  const merged = new Map();
  for (const w of work) {
    const def = itemDef(w.itemId, cfg);
    let left = w.count;
    let acc = merged.get(w.itemId) || [];
    for (const box of acc) {
      if (left <= 0) break;
      const room = def.stack - box.count;
      if (room <= 0) continue;
      const take = Math.min(room, left);
      box.count += take;
      left -= take;
    }
    while (left > 0) {
      const take = Math.min(def.stack, left);
      acc.push({ count: take });
      left -= take;
    }
    merged.set(w.itemId, acc);
  }

  const flat = [];
  for (const [itemId, boxes] of merged) for (const b of boxes) flat.push({ itemId, count: b.count });
  // 稳定顺序：按物品 id 排序，保证同一份存档每次规范化得到同一个布局（可复现）
  flat.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const grid = createGrid(cfg.economy.stash.w, cfg.economy.stash.h);
  const placed = [];
  const overflow = [];
  let uid = 1;
  for (const f of flat) {
    const def = itemDef(f.itemId, cfg);
    const slot = findSlot(grid, def);
    if (!slot) {
      overflow.push(f);
      continue;
    }
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    placed.push({ uid: uid++, itemId: f.itemId, count: f.count, x: slot.x, y: slot.y, rotated: slot.rotated });
  }

  return { stash: placed, dropped, overflow };
}

const RARITY_ORDER = (rarityId, cfg) => {
  const list = cfg.lootTable.rarity;
  const i = list.findIndex((r) => r.id === rarityId);
  return i < 0 ? -1 : i;
};

/**
 * 排序：**先合并堆叠，再按模式排序，最后从左上角重新排放**。
 *
 * 口径：排序只改坐标，不改内容。单测会断言"排序前后仓库内容的多重集合相等"——
 * 因为"整理一下东西少了"是最容易被忽略、也最不可原谅的一类缺陷。
 */
export function stashSort(entries, mode, cfg) {
  const norm = stashNormalize(entries, cfg);
  const items = norm.stash.map((e) => ({ ...e }));
  const defOf = (e) => itemDef(e.itemId, cfg);

  const cmp = {
    category: (a, b) => {
      const da = defOf(a);
      const db = defOf(b);
      if (da.category !== db.category) return da.category < db.category ? -1 : 1;
      const ra = RARITY_ORDER(da.rarity, cfg);
      const rb = RARITY_ORDER(db.rarity, cfg);
      if (ra !== rb) return rb - ra;
      if (da.value !== db.value) return db.value - da.value;
      return da.label < db.label ? -1 : 1;
    },
    rarity: (a, b) => {
      const da = defOf(a);
      const db = defOf(b);
      const ra = RARITY_ORDER(da.rarity, cfg);
      const rb = RARITY_ORDER(db.rarity, cfg);
      if (ra !== rb) return rb - ra;
      if (da.value !== db.value) return db.value - da.value;
      return da.label < db.label ? -1 : 1;
    },
    value: (a, b) => {
      const da = defOf(a);
      const db = defOf(b);
      if (da.value !== db.value) return db.value - da.value;
      return da.label < db.label ? -1 : 1;
    },
    name: (a, b) => {
      const da = defOf(a);
      const db = defOf(b);
      if (da.label !== db.label) return da.label < db.label ? -1 : 1;
      return a.uid - b.uid;
    },
  }[mode];

  if (!cmp) throw new Error(`[stash] 未知排序模式 ${mode}`);
  items.sort(cmp);

  const grid = createGrid(cfg.economy.stash.w, cfg.economy.stash.h);
  const placed = [];
  let uid = 1;
  for (const e of items) {
    const def = defOf(e);
    const slot = findSlot(grid, def);
    if (!slot) continue; // 规范化后不该发生；真发生也不能凭空少东西（调用方比对内容）
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    placed.push({ uid: uid++, itemId: e.itemId, count: e.count, x: slot.x, y: slot.y, rotated: slot.rotated });
  }
  return { stash: placed, overflow: norm.overflow, dropped: norm.dropped };
}

/**
 * 批量出售。
 *
 * 价格由**注入的 priceOf(itemId, count)** 提供 —— 于是"卖价怎么算"只有一处
 * （core/shop.js），而本文件不依赖经济表，也不会出现第二套价格算法。
 *
 * @returns {{stash:Array, currency:number, lines:Array<{uid,itemId,count,unit,amount}>}}
 */
export function stashBulkSell(entries, uids, cfg, priceOf) {
  const wanted = new Set(uids);
  const out = [];
  const lines = [];
  let currency = 0;
  for (const e of entries) {
    if (!wanted.has(e.uid)) {
      out.push({ ...e });
      continue;
    }
    const def = itemDef(e.itemId, cfg);
    if (!def) continue; // 未知物品：直接丢掉（它本来就不该在仓库里）
    const amount = priceOf(e.itemId, e.count, e);
    currency += amount;
    lines.push({ uid: e.uid, itemId: e.itemId, count: e.count, unit: priceOf(e.itemId, 1, e), amount, label: def.label });
  }
  return { stash: out, currency, lines };
}

/** 仓库概览（界面与简报共用同一份口径）。 */
export function stashSummary(entries, cfg) {
  return {
    entries: entries.length,
    items: stashItemCount(entries),
    value: stashValue(entries, cfg),
    weightKg: stashWeight(entries, cfg),
    used: stashUsedSlots(entries, cfg),
    total: stashCapacity(cfg),
  };
}
