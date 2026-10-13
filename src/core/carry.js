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

import { createGrid, findSlot, markArea } from './packing.js';

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
