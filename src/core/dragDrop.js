// M6-3 拖放的**唯一落点判定与落库**（纯函数）
//
// 存在原因（docs/18 §3.3 与 §五 的风险表）：
//   ① 界面里不允许出现格子碰撞判定 —— "这一格放不放得下"必须由 core/packing.js 的
//      isAreaFree（经 stashMoveTo / stashAddAt）回答。界面里另写一段双层循环，
//      就会出现两套边界规则（越界算不算、旋转后的 w/h 用哪个），而它们迟早分叉；
//   ② "拖动中给幽灵元素上色"与"松手时真正落库"若各判一次，就会出现
//      **看着能放、一松手又弹回去**，或者更糟的"看着不能放、松手却改了数据"。
//      这类缺陷极难从界面截图判断，因此本文件只提供**一个**入口：
//      dryRun 只决定"要不要把新档案交出去"，判定路径与落库路径是同一条代码。
//
// 返回的 reason 是机器串（occupied / out-of-bounds / slot-rejects:weapon …），
// 翻成人话在 ui/panels.js 的 reasonText —— 界面不显示机器串（M5 的既有口径）。
//
// 本文件不读配置表对象，只接受调用方传入的 cfg，因此能在 Node 单测里独立驱动。

import { stashMoveTo, stashGrid } from './stash.js';
import { isAreaFree } from './packing.js';
import {
  slotAcceptsItem,
  equipFromStash,
  unequipToStash,
  carryPlaceFromStash,
  carryTakeToStash,
  carryMove,
} from './loadout.js';

/**
 * 执行一次拖放。
 *
 * @param {object} profile 档案（纯函数：不改它，返回新档案）
 * @param {string} presetId 目标预设（配装面板显示的那一套）
 * @param {object} source `{kind:'stash', uid}` 或 `{kind:'slot', slotId}`
 * @param {object|null} target `{kind:'stash', x, y}` 或 `{kind:'slot', slotId}`；null = 没落在任何可放处
 * @param {boolean} rotated 拖动中按 R 之后的朝向（仓库格里的朝向）
 * @param {object} opts `{dryRun}` —— true 时只判定，不返回新档案（幽灵元素上色用它）
 * @returns {{ok:boolean, reason?:string, profile?:object}}
 */
export function dropItem(profile, presetId, source, target, rotated, cfg, opts = {}) {
  const dryRun = !!opts.dryRun;

  if (!source) return { ok: false, reason: 'no-source' };
  // 松手时没落在任何可放处（例如落在面板空白、或拖出了网格）—— 回原位。
  if (!target) return { ok: false, reason: 'no-target' };
  // ★ [M6-BUG-04] 落点必须是**整数格**。
  //   为什么单列一条而不是交给 isAreaFree：后者对非整数只回答 false，而 stashMoveTo
  //   把 false 一律翻成 'occupied' —— 于是"坐标算错了（NaN / 半格）"会显示成
  //   "这一格被别的物品占着"，把人往错误的方向带（实测：抓取偏移漏了源坐标时就是这个症状，
  //   排查花了整整一轮）。界面已经不可能送进 NaN，但这里是**唯一的落点入口**，
  //   坏数据必须在这里就被抓住并给出**说得通**的原因。
  if ((target.kind === 'stash' || target.kind === 'carry') && (!Number.isInteger(target.x) || !Number.isInteger(target.y))) {
    return { ok: false, reason: 'bad-target' };
  }
  // ★ M6-4：携行网格的落点必须指明**哪一张网格**（背包 / 弹挂 / 保险箱）。
  if (target.kind === 'carry' && target.grid !== 'backpack' && target.grid !== 'rig' && target.grid !== 'safe') {
    return { ok: false, reason: 'no-such-grid' };
  }

  // 落库动作**只有一个地方选**：下面按 (source.kind, target.kind) 选出唯一一个 core 调用。
  // 判定与落库共用它，因此不可能出现"预览说行、落库说不行"。
  let res;
  if (target.kind === 'slot') {
    if (source.kind === 'stash') {
      const entry = profile.stash.find((e) => e.uid === source.uid);
      if (!entry) return { ok: false, reason: 'unknown-uid' };
      const acc = slotAcceptsItem(target.slotId, entry.itemId, cfg);
      if (!acc.ok) return { ok: false, reason: acc.reason };
      // 白名单已经过了才落库：equipFromStash 内部会再走一遍同一条规则（它是权威），
      // 这里提前问一次是为了让**非法装备**在不产生任何副作用的前提下就被拒。
      res = equipFromStash(profile, presetId, source.uid, target.slotId, cfg);
    } else if (source.kind === 'carry') {
      // 身上网格 → 装备格：不做"就地穿上"（那需要一条从网格取件的独立路径）。
      // 玩家想穿就先拖回仓库再拖上去 —— 与"装备格之间不互换"同一条口径。
      return { ok: false, reason: 'carry-to-slot' };
    } else {
      // 装备格之间不互换：那需要"两件装备同时换手"，而界面上没有第二个槽位落点可预览。
      // 想做的是把它拖回仓库再拖上去（宁可多一步，也不要一次难以撤销的连带变化）。
      return { ok: false, reason: 'slot-to-slot' };
    }
  } else if (target.kind === 'carry') {
    if (source.kind === 'stash') {
      res = carryPlaceFromStash(profile, presetId, source.uid, target.grid, target.x, target.y, rotated, cfg);
    } else if (source.kind === 'carry') {
      // 网格内移动 / 跨网格搬运（背包 ↔ 弹挂 ↔ 保险箱）
      res = carryMove(profile, presetId, source.uid, target.grid, target.x, target.y, rotated, cfg);
    } else {
      // 身上穿着的装备塞进携行网格？那是"把枪塞进背包"，而携行网格只收弹药与消耗品。
      return { ok: false, reason: 'slot-to-carry' };
    }
  } else if (target.kind === 'stash') {
    if (source.kind === 'stash') {
      res = stashMoveTo(profile.stash, source.uid, target.x, target.y, rotated, cfg);
      if (res.ok) res = { ok: true, profile: { ...profile, stash: res.stash } };
    } else if (source.kind === 'carry') {
      res = carryTakeToStash(profile, presetId, source.uid, { x: target.x, y: target.y, rotated }, cfg);
    } else {
      res = unequipToStash(profile, presetId, source.slotId, { x: target.x, y: target.y, rotated }, cfg);
    }
  } else {
    return { ok: false, reason: 'unknown-target' };
  }

  if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'unknown-reason' };
  return dryRun ? { ok: true } : { ok: true, profile: res.profile };
}

/**
 * 找仓库里第一块 **w×h 的空位**（**只用于测试夹具与诊断**）。
 *
 * 为什么单独出来：端到端要"把某件东西拖到某个空格"，它必须知道哪一格是空的 ——
 * 若在测试里自己按坐标推算空闲，就等于把 packing 的边界规则又实现了一遍
 * （而测试的价值恰恰在于它独立于实现）。这里问的正是 stashMoveTo / stashAddAt
 * 落点判定的那一个谓词（packing.js 的 isAreaFree），因此不可能给出
 * "夹具认为合法、拖放认为非法"的格。
 *
 * @returns {{x:number,y:number}|null}
 */
export function freeSpotFor(entries, w, h, cfg) {
  const grid = stashGrid(entries, cfg);
  const { w: W, h: H } = cfg.economy.stash;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isAreaFree(grid, x, y, w, h)) return { x, y };
    }
  }
  return null;
}
