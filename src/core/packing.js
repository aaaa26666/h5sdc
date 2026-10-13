// 二维网格装包（俄罗斯方块式背包）
//
// 存在原因：这份算法**同时**被两处使用 ——
//   ① tools/validate-loot-tables.mjs 的蒙特卡洛模拟（理论分布）
//   ② src/gameplay/inventory.js 的运行时背包（实际装包）
//
// 两边必须共用同一份实现。若各写一份"看起来一样"的，
// 当"理论分布"与"运行时实际掉落"对不上时，就无法区分是数值问题还是算法分叉 ——
// 而"两者必须能对上"正是 M3 DoD ① 要守的东西。
//
// 为什么需要真正的二维排放而不是"格数计数"：安全箱档位用 1x2 / 2x3 / 3x4 表达，
// 这是**行列**记法 —— 物品有形状，装包是排放。一个 2x1 的急救包放不进 1x2 的格子
// （只能旋转后才放得进），而"只算格数"的模型看不出这个区别。
//
// 贪心而不是最优解：玩家的实际行为就是"先捡单位体积最值钱的，能塞就塞"，
// 贪心更贴近真人，也不把模型做得比玩法更聪明。

/**
 * 批量排放：把一批物品按**给定顺序**（调用方负责排序）装进一张空网格。
 *
 * @param {number} gridW 网格宽（列）
 * @param {number} gridH 网格高（行）
 * @param {Array} items 物品数组（需含 w / h / vol / value / weightKg / category）
 * @param {number} [weightLimitKg=Infinity] 负重上限
 * @param {string[]} [excludeCategories=[]] 排除的类别（安全箱用它挡住武器与护甲）
 * @returns {{placed: Array, value: number, weightKg: number, vol: number, occupied: boolean[][]}}
 */
export function packGrid(gridW, gridH, items, weightLimitKg = Infinity, excludeCategories = []) {
  const occupied = Array.from({ length: gridH }, () => new Array(gridW).fill(false));
  const placed = [];
  let value = 0;
  let weightKg = 0;
  let vol = 0;

  const fits = (x, y, w, h) => {
    if (x + w > gridW || y + h > gridH) return false;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) if (occupied[y + dy][x + dx]) return false;
    }
    return true;
  };
  const mark = (x, y, w, h, v) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) occupied[y + dy][x + dx] = v;
    }
  };

  const excluded = new Set(excludeCategories);
  for (const it of items) {
    if (excluded.has(it.category)) continue;
    if (weightKg + it.weightKg > weightLimitKg) continue;
    let put = false;
    // 正放放不下就试旋转（90°）—— 真人一定会转一下再塞
    for (const [w, h] of [[it.w, it.h], [it.h, it.w]]) {
      if (put) break;
      for (let y = 0; y + h <= gridH && !put; y++) {
        for (let x = 0; x + w <= gridW && !put; x++) {
          if (!fits(x, y, w, h)) continue;
          mark(x, y, w, h, true);
          placed.push({ item: it, x, y, w, h, rotated: w !== it.w });
          value += it.value;
          weightKg += it.weightKg;
          vol += it.vol;
          put = true;
        }
      }
    }
  }
  return { placed, value, weightKg, vol, occupied };
}

/** 价值密度降序 —— "先捡单位体积最值钱的"这条贪心规则的**唯一**比较器。 */
export function byValueDensity(a, b) {
  return b.value / b.vol - a.value / a.vol;
}

/**
 * 在**已有占用**的网格里按给定顺序继续装包。
 *
 * 与 packGrid 的区别只有一个：它不清空占用图。存在的理由是 M6 的"整理背包"——
 * 配装件（弹药 / 医疗）是**被带进来的**，它们不该在整理时被重新摆到别处
 * （玩家会以为"整理把我的子弹弄丢了"），只有战利品需要重排。
 * 两者共用同一套"首次适配 + 可旋转"的判定，不是两份算法。
 *
 * @param {object} grid createGrid 的产物（**会被就地修改**）
 * @param {Array} items 物品数组（需含 w / h / vol / value / weightKg / category）
 * @returns {{placed:Array, leftovers:Array, weightKg:number}}
 */
export function packIntoGrid(grid, items, weightLimitKg = Infinity, excludeCategories = []) {
  const excluded = new Set(excludeCategories);
  const placed = [];
  const leftovers = [];
  let weightKg = 0;
  for (const it of items) {
    if (excluded.has(it.category)) continue;
    if (weightKg + it.weightKg > weightLimitKg) {
      leftovers.push(it);
      continue;
    }
    const slot = findSlot(grid, it);
    if (!slot) {
      leftovers.push(it);
      continue;
    }
    markArea(grid, slot.x, slot.y, slot.w, slot.h, true);
    placed.push({ item: it, ...slot });
    weightKg += it.weightKg;
  }
  return { placed, leftovers, weightKg };
}

/** 创建一张空的占用图。 */
export function createGrid(w, h) {
  return { w, h, occupied: Array.from({ length: h }, () => new Array(w).fill(false)) };
}

/**
 * 在**已有**网格里找一件物品的位置（首次适配，可旋转）。
 * 运行时背包用它做增量拾取 —— 玩家是一件一件捡的，不是一次性重排。
 *
 * @returns {{x:number,y:number,w:number,h:number,rotated:boolean}|null} 放不下返回 null
 */
export function findSlot(grid, item, allowRotate = true) {
  const shapes = allowRotate && item.w !== item.h
    ? [[item.w, item.h], [item.h, item.w]]
    : [[item.w, item.h]];
  for (const [w, h] of shapes) {
    for (let y = 0; y + h <= grid.h; y++) {
      for (let x = 0; x + w <= grid.w; x++) {
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++) {
          for (let dx = 0; dx < w; dx++) {
            if (grid.occupied[y + dy][x + dx]) { ok = false; break; }
          }
        }
        if (ok) return { x, y, w, h, rotated: w !== item.w };
      }
    }
  }
  return null;
}

/** 占用一块区域（传 false 表示腾空）。 */
export function markArea(grid, x, y, w, h, v = true) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) grid.occupied[y + dy][x + dx] = v;
  }
}

/**
 * 整理：把已放入的物品**按价值密度降序**重新排放一遍。
 *
 * 为什么需要它：运行时是"捡到什么塞什么"（首次适配），
 * 而理论模拟是"全部收集后按价值密度排序再装" —— 后者能装下更多。
 * 这是**真实存在的差距**，不是 bug：真人背包也是先乱塞、回头再整理。
 * 玩家手动整理后，运行时结果会向理论值靠拢。
 *
 * [M3-TEMP-9] 运行时与理论模拟用的不是同一个顺序（首次适配 vs 价值密度排序），
 * 因此运行时能装下的 ≤ 理论值。是否默认整理、以及真实差距有多大，
 * 需要试玩采集后决定 —— 现在刻意保留这个差距，好让它可被测量而不是被掩盖。
 *
 * @returns {{placed: Array, value: number, weightKg: number, leftovers: Array}} leftovers 是整理后仍放不下的
 */
export function repack(grid, placedItems, weightLimitKg = Infinity, excludeCategories = []) {
  const sorted = [...placedItems].sort(byValueDensity);
  const res = packGrid(grid.w, grid.h, sorted, weightLimitKg, excludeCategories);
  // 用排放结果重建占用图
  markAreaRect(grid, res.occupied);
  return {
    placed: res.placed,
    value: res.value,
    weightKg: res.weightKg,
    leftovers: sorted.filter((it) => !res.placed.some((p) => p.item === it)),
  };
}

function markAreaRect(grid, occupied) {
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) grid.occupied[y][x] = !!occupied[y][x];
  }
}
