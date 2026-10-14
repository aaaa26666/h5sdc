// M6 携行具（背包 / 弹挂）的**网格投放**（纯函数）
//
// 存在原因（docs/18 §3.2）：M6 起容量由**装备**决定，且弹药与消耗品不再是
// "不占格的数字"，而是真的摆在网格里的物体（销 [M5-TEMP-11]）。
// 这件事必须有一个**唯一的算法**，因为它同时被两处需要：
//   ① 局外进局时（core/loadout.js 的 buildRaidKit）—— 决定这一局身上带着什么、摆在哪个格；
//   ② 启动期交叉校验（config/index.js）—— 断言"起始配装一定塞得进兜底背包"。
// 若各写一遍，就会出现"校验说塞得下、进局却掉东西"这种只在特定配装下出现的分叉。
//
// 本文件**不 import 任何配置**：调用方把 carry 表 / 弹药表 / 物品视图传进来，
// 因此它能在 Node 单测里用合成数据独立运行（config/index.js 也要在校验期调用它）。
//
// 三条口径（都是裁定过的，别当成 bug 改掉）：
//   ① **一格可以放多件**：上限是该物品的 `stack`（弹药 60 发/格、绷带 4/格、急救包 2/格）。
//      这与仓库的堆叠口径同源 —— 否则"仓库里一格能放 4 个绷带、背包里只能放 1 个"会成为
//      玩家无法理解的两套规则。
//   ② **弹挂优先**：弹挂只收它 accepts 的类别（弹药 / 医疗），因此"马上要用的"与
//      "背回去卖的"从一开始就分开放。弹挂装不下才溢出到背包。
//   ③ 装不下**不静默丢弃**：全部记进 overflow，由调用方报给玩家（进局提示 + 大厅缺口提示）。
//
// ★ M6-4（制作人裁定）：携行网格从"按数字自动投放"改成**玩家自己拖出来的网格**
//   （`loadout.carry`）。planCarry 只剩一个用途 —— 把旧存档里的数字账迁移成网格，
//   日常路径一律走下面的 carryAddAt / carryMoveTo / carryRemove。

import { createGrid, findSlot, markArea, isAreaFree } from './packing.js';
import { itemShape } from './items.js';

/** 把 `count` 个存储单位按 stack 上限切成若干"盒"（每盒是网格里的一格）。 */
export function splitIntoBoxes(count, stack) {
  const cap = Math.max(1, Math.floor(stack) || 1);
  const out = [];
  let left = Math.max(0, Math.floor(count) || 0);
  while (left > 0) {
    const take = Math.min(cap, left);
    out.push(take);
    left -= take;
  }
  return out;
}

/** 携带具规格：优先用装备的那一只，否则用表里的兜底。 */
export function resolveCarrySpecs(loadout, carryTable) {
  const findBp = (id) => (carryTable.backpacks || []).find((b) => b.id === id) || null;
  const findRig = (id) => (carryTable.rigs || []).find((r) => r.id === id) || null;
  const eqBp = loadout && loadout.backpack ? findBp(loadout.backpack) : null;
  const d = carryTable.defaults || {};
  const def = d.backpack;
  if (!def) {
    // 刻意**不兜底**一个 1x1：那样"表坏了"会表现成"进局只能带一件东西"，
    // 而真正的原因（缺 defaults）永远查不出来。缺表就该在这里响。
    throw new Error('[carry] carry 表缺少 defaults.backpack（"没装备背包"时的兜底容量）');
  }
  const backpack = eqBp
    ? { id: eqBp.id, label: eqBp.label, w: eqBp.capacityW, h: eqBp.capacityH, weightLimitKg: eqBp.weightLimitKg, source: 'equipped' }
    : { id: null, label: '无背包（兜底）', w: def.w, h: def.h, weightLimitKg: def.weightLimitKg, source: 'default' };
  const eqRig = loadout && loadout.rig ? findRig(loadout.rig) : null;
  const rig = eqRig
    ? { id: eqRig.id, label: eqRig.label, w: eqRig.capacityW, h: eqRig.capacityH, accepts: [...(eqRig.accepts || [])] }
    : null;
  return { backpack, rig };
}

/**
 * 把配装里的弹药与消耗品摆进网格。
 *
 * @param {object} input
 * @param {object} input.loadout     配装（含 backpack / rig / ammo / consumables）
 * @param {object} input.carry       carry 表（carry.json 的内容）
 * @param {Array}  input.ammo        [{ id(口径), itemId }]
 * @param {Array}  input.consumables [{ id }]（消耗品的物品 id 就是它自己）
 * @param {object} input.itemDefs    物品视图（需含 category / w / h / stack）
 * @returns {{backpack:object, rig:object|null, placements:Array, overflow:Array}}
 */
export function planCarry({ loadout, carry, ammo, consumables, itemDefs }) {
  const { backpack, rig } = resolveCarrySpecs(loadout, carry);
  const bpGrid = createGrid(backpack.w, backpack.h);
  const rigGrid = rig ? createGrid(rig.w, rig.h) : null;

  // ---- ① 列清单：弹药与消耗品都切成"盒" ----
  const boxes = [];
  const lo = loadout || {};
  for (const [caliber, rounds] of Object.entries(lo.ammo || {})) {
    const a = (ammo || []).find((x) => x.id === caliber);
    const def = a && a.itemId ? itemDefs[a.itemId] : null;
    if (!def) continue;
    for (const count of splitIntoBoxes(rounds, def.stack)) {
      boxes.push({ itemId: a.itemId, count, kind: 'ammo', caliber, def });
    }
  }
  for (const [id, n] of Object.entries(lo.consumables || {})) {
    const def = itemDefs[id];
    if (!def) continue;
    for (const count of splitIntoBoxes(n, def.stack)) {
      boxes.push({ itemId: id, count, kind: 'consumable', caliber: null, def });
    }
  }

  // ---- ② 摆放顺序 ----
  // 大件优先（急救包 2x1 先占位，1x1 的弹药与绷带填缝），同尺寸按 id 升序 ——
  // 顺序必须是**确定的**，否则"同一个配装两次进局摆得不一样"会让测试与复现都失效。
  boxes.sort((a, b) => (b.def.w * b.def.h) - (a.def.w * a.def.h) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

  const placements = [];
  const overflow = [];
  for (const box of boxes) {
    const acceptedByRig = !!(rigGrid && rig.accepts.includes(box.def.category));
    let gridName = 'backpack';
    let grid = bpGrid;
    let slot = null;
    if (acceptedByRig) {
      slot = findSlot(rigGrid, box.def);
      if (slot) {
        gridName = 'rig';
        grid = rigGrid;
      }
    }
    if (!slot) {
      slot = findSlot(bpGrid, box.def);
      gridName = 'backpack';
      grid = bpGrid;
    }
    if (!slot) {
      // 装不下：**不静默丢弃**，交给调用方报出来（进局提示 / 大厅缺口）
      overflow.push({ itemId: box.itemId, count: box.count, kind: box.kind, caliber: box.caliber, reason: 'space' });
      continue;
    }
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    placements.push({
      itemId: box.itemId,
      count: box.count,
      kind: box.kind,
      caliber: box.caliber,
      grid: gridName,
      x: slot.x,
      y: slot.y,
      w: slot.w,
      h: slot.h,
      rotated: slot.rotated,
    });
  }

  return { backpack, rig, placements, overflow };
}

// ---------------------------------------------------------------------------
// ★ M6-4 携行网格（玩家自己拖出来的那份）
//
// 与"仓库"的分工（这条分工决定了很多语义，改动前先读）：
//   · 仓库 = 家里。战利品撤离后入库，玩家在那里整理与出售。
//   · 携行网格 = 身上。包括背包 / 弹挂 / 保险箱三张网格，里面的东西**不在仓库里**
//     （拖进来那一步就已经从仓库移走了）。阵亡时背包与弹挂清空，保险箱保留 ——
//     那就是保险箱存在的理由。
//
// 三张网格共用同一套排放规则（core/packing.js）与同一个形状函数（core/items.js 的
// itemShape）："仓库摆得下、身上摆不下"必须能被归因成格子不够，而不是两套算法分叉。
// ---------------------------------------------------------------------------

/** 三张网格的固定顺序（背包在前：它是主网格；保险箱最后：它不参与消耗）。 */
export const CARRY_GRIDS = Object.freeze(['backpack', 'rig', 'safe']);

/** 只消耗弹药/药品的那两张网格（保险箱里的东西不会被打掉）。 */
export const SPENDABLE_GRIDS = Object.freeze(['backpack', 'rig']);

export function emptyCarry() {
  return { backpack: [], rig: [], safe: [] };
}

export function cloneCarry(carry) {
  const out = emptyCarry();
  for (const name of CARRY_GRIDS) {
    out[name] = ((carry && carry[name]) || []).map((e) => ({ ...e }));
  }
  return out;
}

/** 某网格是否收这个物品。accepts 是白名单，excludes 是黑名单，两者都不给 = 全收。 */
export function gridAccepts(spec, def) {
  if (!spec || !def) return false;
  if (spec.accepts) return spec.accepts.includes(def.category);
  if (spec.excludes) return !spec.excludes.includes(def.category);
  return true;
}

/**
 * 三张网格的规格。
 * @param {object} loadout 配装（读它的 backpack / rig）
 * @param {object} carryTable carry.json
 * @param {object|null} safeSpec 保险箱档位规格 {id,label,w,h,excludes}（档位来自档案，不在配装里）
 */
export function carrySpecs(loadout, carryTable, safeSpec) {
  const { backpack, rig } = resolveCarrySpecs(loadout, carryTable);
  const accepted = (carryTable.carryRules && carryTable.carryRules.acceptedCategories) || [];
  return {
    // 背包收 carryRules 声明的那些类别（弹药 / 医疗 / 消耗品）——
    // "我不小心把长枪拖进了背包"必须被拒，否则进局时会夹带一把没人能用的枪。
    backpack: { ...backpack, accepts: accepted.slice() },
    rig: rig
      ? { ...rig, accepts: accepted.filter((c) => (rig.accepts || []).includes(c)) }
      : null,
    safe: safeSpec ? { ...safeSpec } : null,
  };
}

/** 一张网格的占用图（与仓库同源：同一份 itemShape，不另写一份旋转规则）。 */
export function carryOccupancy(list, itemDefs, spec) {
  const grid = createGrid(spec.w, spec.h);
  for (const e of list || []) {
    const def = itemDefs[e.itemId];
    if (!def) continue;
    const sh = itemShape(def, e.rotated);
    if (e.x < 0 || e.y < 0 || e.x + sh.w > spec.w || e.y + sh.h > spec.h) continue;
    markArea(grid, e.x, e.y, sh.w, sh.h, true);
  }
  return grid;
}

function nextCarryUid(carry) {
  let max = 0;
  for (const name of CARRY_GRIDS) {
    for (const e of (carry && carry[name]) || []) {
      if (Number.isFinite(e.uid) && e.uid > max) max = e.uid;
    }
  }
  return max + 1;
}

/** 某个 uid 在哪张网格里（拖放要知道"它现在在哪"，才能排除自己重算占用）。 */
export function gridOfUid(carry, uid) {
  for (const name of CARRY_GRIDS) {
    if (((carry && carry[name]) || []).some((e) => e.uid === uid)) return name;
  }
  return null;
}

/**
 * 能不能在这一格放下一件（**判定与落库共用它**：先判后放，不会出现
 * "预览说行、放下去说不行"）。
 * @returns {{ok:boolean, reason?:string, shape?:{w:number,h:number}}}
 */
export function carryCanPlace(carry, name, entry, specs, itemDefs) {
  const spec = specs[name];
  if (!spec) return { ok: false, reason: 'no-such-grid' };
  const def = itemDefs[entry.itemId];
  if (!def) return { ok: false, reason: 'unknown-item' };
  if (!(entry.count > 0) || entry.count > def.stack) return { ok: false, reason: 'bad-count' };
  if (!gridAccepts(spec, def)) return { ok: false, reason: `grid-rejects:${def.category}` };
  const sh = itemShape(def, entry.rotated);
  if (entry.x < 0 || entry.y < 0 || entry.x + sh.w > spec.w || entry.y + sh.h > spec.h) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  const grid = carryOccupancy(carry[name] || [], itemDefs, spec);
  if (!isAreaFree(grid, entry.x, entry.y, sh.w, sh.h)) return { ok: false, reason: 'occupied' };
  return { ok: true, shape: sh };
}

/** 在指定格放下一件（不找空位）。@returns {{ok, reason?, carry?, uid?}} */
export function carryAddAt(carry, name, itemId, count, x, y, rotated, specs, itemDefs) {
  const base = cloneCarry(carry);
  const verdict = carryCanPlace(base, name, { itemId, count, x, y, rotated: !!rotated }, specs, itemDefs);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, carry: base };
  const uid = nextCarryUid(base);
  base[name] = [...base[name], { uid, itemId, count, x, y, rotated: !!rotated }];
  return { ok: true, carry: base, uid };
}

/** 把某个 uid 的条目搬到指定格（可换网格、可改朝向）。 */
export function carryMoveTo(carry, uid, name, x, y, rotated, specs, itemDefs) {
  const base = cloneCarry(carry);
  const from = gridOfUid(base, uid);
  if (!from) return { ok: false, reason: 'unknown-uid', carry: base };
  const e = base[from].find((v) => v.uid === uid);
  // 占用图要**排除自己**：不排除的话它永远和自己重叠，怎么放都非法。
  const others = cloneCarry(base);
  others[from] = others[from].filter((v) => v.uid !== uid);
  const verdict = carryCanPlace(others, name, { ...e, x, y, rotated: !!rotated }, specs, itemDefs);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, carry: base };
  others[name] = [...others[name], { ...e, x, y, rotated: !!rotated, uid: e.uid }];
  return { ok: true, carry: others };
}

/** 整条移除（数量不拆：拖回仓库是整叠回去）。 */
export function carryRemove(carry, uid) {
  const base = cloneCarry(carry);
  const from = gridOfUid(base, uid);
  if (!from) return { ok: false, reason: 'unknown-uid', carry: base };
  const e = base[from].find((v) => v.uid === uid);
  base[from] = base[from].filter((v) => v.uid !== uid);
  return { ok: true, carry: base, removed: { ...e, grid: from } };
}

/**
 * 从网格里扣掉 n 个存储单位的某物品（一局打完，按**实际消耗**扣）。
 * 顺序：先扣数量小的那盒 —— 小盒先清空才腾得出格子，这也是玩家的直觉。
 * @returns {{carry:object, removed:number}} removed < n 表示网格里不够（不该发生，但也不静默）
 */
export function carryDeduct(carry, itemId, n, grids = SPENDABLE_GRIDS) {
  const base = cloneCarry(carry);
  let need = Math.max(0, Math.floor(n) || 0);
  let removed = 0;
  const pool = [];
  for (const name of grids) {
    for (const e of base[name] || []) {
      if (e.itemId === itemId) pool.push({ name, e });
    }
  }
  pool.sort((a, b) => a.e.count - b.e.count || a.e.uid - b.e.uid);
  for (const { name, e } of pool) {
    if (need <= 0) break;
    const use = Math.min(e.count, need);
    e.count -= use;
    removed += use;
    need -= use;
  }
  for (const name of grids) base[name] = (base[name] || []).filter((e) => e.count > 0);
  return { carry: base, removed };
}

/**
 * 找一个能放下的空位（战利品入库、旧档迁移用）。
 *
 * ★ M6-4 修正：`itemDefs` 必须是**完整的物品表**，不能只给"待放的这一件"。
 *   旧写法传 `{ [def.id]: def }`，而 `carryOccupancy` 对查不到 def 的条目是 `continue`
 *   —— 于是网格里**已经放着的其它东西在占用图上根本不存在**，找出来的落点与它们重叠。
 *   后果不是报错，而是"第二件起永远放不进去"：找位成功 → `carryAddAt` 用完整表复核 →
 *   判重叠 → 拒绝。表现为"背包明明是空的，却只带得进第一样东西"。
 *
 * @param {object} itemDefs 完整物品表（cfg.itemDefs）
 * @returns {{spec, name, x, y, w, h, rotated}|null}
 */
export function findCarrySlot(carry, def, specs, itemDefs, order = SPENDABLE_GRIDS) {
  for (const name of order) {
    const spec = specs[name];
    if (!spec || !gridAccepts(spec, def)) continue;
    const grid = carryOccupancy(carry[name] || [], itemDefs, spec);
    const slot = findSlot(grid, def);
    if (slot) return { name, x: slot.x, y: slot.y, w: slot.w, h: slot.h, rotated: slot.rotated };
  }
  return null;
}

/** 网格里某物品一共有多少**存储单位**。 */
export function carryTotalOf(carry, itemId, grids = CARRY_GRIDS) {
  let n = 0;
  for (const name of grids) for (const e of (carry && carry[name]) || []) if (e.itemId === itemId) n += e.count;
  return n;
}

/** 按物品汇总（进局的 taken 清单、简报的"自带什么"都用它）。 */
export function carryTotals(carry, itemDefs, grids = CARRY_GRIDS) {
  const map = new Map();
  for (const name of grids) {
    for (const e of (carry && carry[name]) || []) {
      const row = map.get(e.itemId) || { itemId: e.itemId, count: 0, grids: [] };
      row.count += e.count;
      if (!row.grids.includes(name)) row.grids.push(name);
      map.set(e.itemId, row);
    }
  }
  return [...map.values()];
}

/** 身上这些东西有多重（按存储单位折算，与仓库同一口径）。 */
export function carryWeightKg(carry, itemDefs, grids = CARRY_GRIDS) {
  let kg = 0;
  for (const name of grids) {
    for (const e of (carry && carry[name]) || []) {
      const def = itemDefs[e.itemId];
      if (def) kg += (def.unitWeightKg !== undefined ? def.unitWeightKg : def.weightKg) * e.count;
    }
  }
  return kg;
}

/** 占了几个格（按形状，不是条目数）。 */
export function carryUsedSlots(carry, itemDefs, grids = CARRY_GRIDS) {
  let n = 0;
  for (const name of grids) {
    for (const e of (carry && carry[name]) || []) {
      const def = itemDefs[e.itemId];
      if (def) {
        const sh = itemShape(def, e.rotated);
        n += sh.w * sh.h;
      }
    }
  }
  return n;
}

/**
 * 收敛携行网格（存档是外部输入：可能被手改、被旧版本写过）。
 * 逐条校验：未知物品 / 非法数量 / 超堆叠（截断到 stack）/ 类别不被收 / 越界 / 重叠。
 * 任何一条不合法就丢弃并记一条 repair —— 宁可少一件，也不能让网格出现重叠的两个物件。
 * @returns {{carry:object, repairs:string[]}}
 */
export function sanitizeCarry(raw, specs, itemDefs) {
  const repairs = [];
  const out = emptyCarry();
  const src = raw && typeof raw === 'object' ? raw : {};
  let uid = 0;
  for (const name of CARRY_GRIDS) {
    const spec = specs[name];
    const list = Array.isArray(src[name]) ? src[name] : [];
    if (!spec) {
      if (list.length) repairs.push(`loadout.carry.${name}:no-space`);
      continue;
    }
    const grid = createGrid(spec.w, spec.h);
    for (const e of list) {
      if (!e || typeof e !== 'object') {
        repairs.push(`loadout.carry.${name}:bad-entry`);
        continue;
      }
      const def = itemDefs[e.itemId];
      if (!def) {
        repairs.push(`loadout.carry.${name}:unknown-item:${e.itemId}`);
        continue;
      }
      let count = Math.floor(Number(e.count));
      if (!Number.isFinite(count) || count <= 0) {
        repairs.push(`loadout.carry.${name}:bad-count`);
        continue;
      }
      if (count > def.stack) {
        count = def.stack;
        repairs.push(`loadout.carry.${name}:over-stack:${e.itemId}`);
      }
      if (!gridAccepts(spec, def)) {
        repairs.push(`loadout.carry.${name}:rejects:${e.itemId}`);
        continue;
      }
      const rotated = !!e.rotated;
      const sh = itemShape(def, rotated);
      const x = Math.floor(Number(e.x));
      const y = Math.floor(Number(e.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x + sh.w > spec.w || y + sh.h > spec.h) {
        repairs.push(`loadout.carry.${name}:out-of-bounds:${e.itemId}`);
        continue;
      }
      if (!isAreaFree(grid, x, y, sh.w, sh.h)) {
        repairs.push(`loadout.carry.${name}:overlap:${e.itemId}`);
        continue;
      }
      markArea(grid, x, y, sh.w, sh.h, true);
      out[name].push({ uid: ++uid, itemId: e.itemId, count, x, y, rotated });
    }
  }
  return { carry: out, repairs };
}

/**
 * 进局前的**可携带性检查**（制作人裁定：两类都查，进局前用警告页告诉玩家）。
 *
 *   ① 类别不合法（网格里混进了不该带的东西 —— 典型来源是上一局的战利品没拖回仓库）；
 *   ② 超出当前背包的容量（换了一只更小的包之后）。
 *
 * @returns {{ok:boolean, offenders:Array<{grid:string, uid:number, itemId:string, count:number, reason:string}>}}
 */
export function carryAudit(carry, specs, itemDefs) {
  const offenders = [];
  for (const name of CARRY_GRIDS) {
    const spec = specs[name];
    const list = (carry && carry[name]) || [];
    if (!spec) {
      for (const e of list) offenders.push({ grid: name, uid: e.uid, itemId: e.itemId, count: e.count, reason: 'no-space' });
      continue;
    }
    const grid = createGrid(spec.w, spec.h);
    for (const e of list) {
      const def = itemDefs[e.itemId];
      if (!def) {
        offenders.push({ grid: name, uid: e.uid, itemId: e.itemId, count: e.count, reason: 'unknown-item' });
        continue;
      }
      const sh = itemShape(def, e.rotated);
      const bad =
        !gridAccepts(spec, def)
          ? `grid-rejects:${def.category}`
          : e.x < 0 || e.y < 0 || e.x + sh.w > spec.w || e.y + sh.h > spec.h
            ? 'out-of-bounds'
            : !isAreaFree(grid, e.x, e.y, sh.w, sh.h)
              ? 'overlap'
              : null;
      if (bad) {
        offenders.push({ grid: name, uid: e.uid, itemId: e.itemId, count: e.count, reason: bad });
        continue;
      }
      markArea(grid, e.x, e.y, sh.w, sh.h, true);
    }
  }
  return { ok: offenders.length === 0, offenders };
}
