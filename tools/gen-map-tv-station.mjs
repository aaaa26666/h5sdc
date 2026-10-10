// 电视台式两层地图的**构建器**（M3-1b-2 ④）。
//
// 定位：地图表 `src/config/maps/tv-station-01.json` 是**运行时唯一真值**（config/level 只读它），
// 本工具是它的生产者。改布局就改这里的规则、重跑，而不是手抄几百个矩形 ——
// 手抄既容易出错，也无法保证"楼梯井不铺楼板""门洞对齐"这类跨层约束。
//
// 用法：node tools/gen-map-tv-station.mjs
//
// 两条规则是被**实测**逼出来的，改动前请先读：
//   ① 楼梯井（ramp 覆盖的每一格）在二层**不铺楼板**。
//      否则玩家在坡道上时身体竖直区间 [脚底, 脚底+1.8] 会与楼板 [3.3,3.6] 相交，
//      被 resolveCircle 挡住 —— 症状就是"楼梯上不去、被地板塞满"。
//   ② 一层墙格的投影在二层必然是洞（楼板 [3.3,3.6] 与一层墙 [0,3.5] 几何重叠），
//      所以二层不能有自己的隔墙（会正好压在一层门洞形成的 1 格宽"桥"上，把桥堵死）。
//      二层的格局变化只能靠"哪里铺楼板"（挑空、电梯井）表达。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------- 可调参数（房间尺寸直接决定墙体密度）----------------
// 隔墙周期 = 9 格（房间 8 格 = 20m x 20m 的大房间）。
// 上一版用 6 格周期（房间 5 格）+ 满地 2x2 结构柱，墙体占比 33.4%，
// 观感是"格子迷宫"—— 试玩反馈"一楼墙数量太多"。这一版去掉结构柱、房间放大一倍。
const SPINE_X = [9, 18, 27, 36];
const SPINE_Z = [9, 18, 27, 36];
const DOOR_W = 2;
const W = 40;
const H = 40;
const idx = (x, z) => z * W + x;

// ---------------- 隔墙 ----------------
const wall1 = new Set();
const wall2 = new Set();

/** 在 [a,b] 内以 mid 为中心留 gap 格空档 */
function splitSeg(a, b, mid, gap) {
  // 门洞不在这段里时必须原样返回，否则 Math.max(a, mid) 会把段末扩到 mid，
  // 等于把别处的门洞填死（上一版连通块只剩 284/870 就是这个原因）。
  if (mid < a || mid > b) return [[a, b]];
  const g0 = Math.max(a, mid - (gap >> 1));
  const g1 = Math.min(b, g0 + gap - 1);
  const segs = [];
  if (g0 > a) segs.push([a, g0 - 1]);
  if (b > g1) segs.push([g1 + 1, b]);
  return segs;
}
function fillV(set, x, z0, z1, gaps) {
  let segs = [[z0, z1]];
  for (const g of gaps) {
    const next = [];
    for (const [a, b] of segs) for (const s of splitSeg(a, b, g, DOOR_W)) next.push(s);
    segs = next;
  }
  for (const [a, b] of segs) for (let z = a; z <= b; z++) set.add(idx(x, z));
}
function fillH(set, z, x0, x1, gaps) {
  let segs = [[x0, x1]];
  for (const g of gaps) {
    const next = [];
    for (const [a, b] of segs) for (const s of splitSeg(a, b, g, DOOR_W)) next.push(s);
    segs = next;
  }
  for (const [a, b] of segs) for (let x = a; x <= b; x++) set.add(idx(x, z));
}

/** 每一段（两条隔墙之间）的中心 —— 保证**每个房间都有自己的门** */
function doorCenters(spine, lo, hi) {
  const bounds = [lo - 1, ...spine, hi + 1];
  const out = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k] + 1;
    const b = bounds[k + 1] - 1;
    if (b - a + 1 < DOOR_W + 2) continue; // 太窄的段不开门（开门等于把墙拆了）
    out.push(Math.floor((a + b) / 2));
  }
  return out;
}
const DOORS_X = doorCenters(SPINE_X, 1, 38);
const DOORS_Z = doorCenters(SPINE_Z, 1, 38);
for (const x of SPINE_X) fillV(wall1, x, 1, 38, DOORS_Z);
for (const z of SPINE_Z) fillH(wall1, z, 1, 38, DOORS_X);

/** 独立设备间：4×4 围合、留一格门。不参与网格切分，因此不会切断既有通道 */
function addCloset(set, x, z, side) {
  for (let dz = 0; dz < 4; dz++) {
    for (let dx = 0; dx < 4; dx++) {
      if (dx === 0 || dz === 0 || dx === 3 || dz === 3) set.add(idx(x + dx, z + dz));
    }
  }
  const door =
    side === 'n' ? [x + 1, z] : side === 's' ? [x + 1, z + 3] : side === 'w' ? [x, z + 1] : [x + 3, z + 1];
  set.delete(idx(door[0], door[1]));
}
// 六个设备间 / 卫生间 / 配电间：给大房间做出内间，提供层次又不切碎地图
for (const [x, z, side] of [
  [3, 3, 's'], [12, 3, 's'], [30, 3, 's'],
  [3, 21, 'e'], [21, 12, 'e'], [30, 30, 's'],
]) addCloset(wall1, x, z, side);

// ---------------- 二层：**自己的**一套隔墙 ----------------
// 这在这一版才成为可能。上一版一层墙格在二层没有楼板（楼板会与墙重叠），
// 二层因此被迫"没有自己的墙"—— 一加墙就正好压在一层门洞形成的 1 格宽"桥"上，
// 把二层切断。现在楼板压墙被几何模型接受（合并成贯通实体），二层是一个完整平面，
// 于是两层可以各有一套格局。
const SPINE2_X = [8, 16, 24, 32];
const SPINE2_Z = [8, 16, 24, 32];
const DOORS2 = doorCenters(SPINE2_X, 1, 38);
for (const x of SPINE2_X) fillV(wall2, x, 1, 38, DOORS2);
for (const z of SPINE2_Z) fillH(wall2, z, 1, 38, DOORS2);
for (const [x, z, side] of [
  [3, 11, 'e'], [11, 25, 's'], [27, 11, 'e'], [33, 33, 'n'], [19, 3, 's'],
]) addCloset(wall2, x, z, side);

// ---------------- 垂直连接 ----------------
// 楼梯：水平投影 3 格 = 7.5m，层高 3.6m → 坡度 25.6°（方案 §3.3 建议 28° 附近）
const ramps = [
  { x: 13, z: 29, w: 2, h: 3, dir: '-z', floor: 0, label: '主楼梯A（安检大厅 → 二层演播厅）' },
  { x: 22, z: 4, w: 2, h: 3, dir: '+z', floor: 0, label: '主楼梯B（货运通道 → 二层走廊）' },
];
const rampCells1 = new Set();  // 楼梯覆盖的全部格（首层）
const rampTop2 = new Set();    // 坡顶格（同时属于二层）
for (const r of ramps) {
  const alongX = r.dir === '+x' || r.dir === '-x';
  const along = alongX ? r.w : r.h;
  const cross = alongX ? r.h : r.w;
  for (let k = 0; k < along; k++) {
    const off = r.dir === '+x' || r.dir === '+z' ? k : along - 1 - k;
    for (let t = 0; t < cross; t++) {
      const cx = alongX ? r.x + off : r.x + t;
      const cz = alongX ? r.z + t : r.z + off;
      rampCells1.add(idx(cx, cz));
      if (k === along - 1) rampTop2.add(idx(cx, cz));
    }
  }
}

// 电梯井：二层不铺楼板的一片，只能跳下
const shaft = { x: 31, z: 31, w: 2, h: 2 };
const shaftCells = new Set();
for (let dz = 0; dz < shaft.h; dz++) for (let dx = 0; dx < shaft.w; dx++) shaftCells.add(idx(shaft.x + dx, shaft.z + dz));

// 挑空中庭：二层不铺楼板，可俯视一层中厅（整间房）
const atrium = { x: 19, z: 28, w: 8, h: 8 };
const inAtrium = (x, z) => x >= atrium.x && x < atrium.x + atrium.w && z >= atrium.z && z < atrium.z + atrium.h;

// ---------------- 保留格 ----------------
const keep1 = new Set();
const addAround = (set, x, z, r) => {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) set.add(idx(x + dx, z + dz));
};
const playerSpawn = { x: 6, z: 34 };
const extracts = [
  { id: 'e1_gate', label: '一层安检出口', x: 3, z: 36, radiusCells: 1.4, conditional: false, floor: 0 },
  { id: 'e2_roof', label: '二层天台门', x: 35, z: 30, radiusCells: 1.4, conditional: false, floor: 1 },
  { id: 'e3_dock', label: '货运装卸口', x: 34, z: 4, radiusCells: 1.2, conditional: true, floor: 0,
    conditionNote: '需在局内时间过半后开放（时间条件点）。条件判定属 M4，本表只登记。' },
];
addAround(keep1, playerSpawn.x, playerSpawn.z, 1);
for (const e of extracts) if ((e.floor || 0) === 0) addAround(keep1, e.x, e.z, 1);
for (const i of rampCells1) keep1.add(i);
for (const i of shaftCells) keep1.add(i);
// 坡顶格及其四邻居在**两层都不设墙**：坡顶格要能走进二层，所以它旁边至少要有楼板
const keep2seed = new Set();
for (const i of rampTop2) {
  const x = i % W;
  const z = (i / W) | 0;
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 1 || nx > 38 || nz < 1 || nz > 38) continue;
    keep1.add(idx(nx, nz));
    keep2seed.add(idx(nx, nz));
  }
}
for (const i of keep1) wall1.delete(i);

// ---------------- 二层楼板 ----------------
// 楼板 = 内部格 − 电梯井 − 挑空 − **楼梯井**
//
// ★ 这里**不再排除一层墙格**（上一版排除，因为"楼板与墙重叠"会报错）。
//   那条排除正是"二层地面到处是一格宽的沟"的来源。现在几何模型接受楼板压墙
//   （重叠的两条跨度合并成一条贯通实体，kind 取更实心的 WALL），
//   一层墙顶照样是二层的楼面 —— 二层是一个完整平面。
const slabSet = new Set();
for (let z = 1; z <= 38; z++) {
  for (let x = 1; x <= 38; x++) {
    const i = idx(x, z);
    if (rampCells1.has(i)) continue;   // ★ 楼梯井必须贯通（否则人被楼板顶住、上不去）
    if (shaftCells.has(i)) continue;
    if (inAtrium(x, z)) continue;
    slabSet.add(i);
  }
}
// 二层保留格：撤离点周围、坡顶周围不得被墙挡
const keep2 = new Set(keep2seed);
for (const e of extracts) if ((e.floor || 0) === 1) addAround(keep2, e.x, e.z, 1);
for (const i of rampTop2) {
  const x = i % W;
  const z = (i / W) | 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 1 || nx > 38 || nz < 1 || nz > 38) continue;
    const j = idx(nx, nz);
    if (!rampCells1.has(j) && !shaftCells.has(j)) slabSet.add(j);
  }
}
for (const i of keep2) {
  wall1.delete(i);
  wall2.delete(i);
}

// ---------------- 掩体 ----------------
// 一层的"工位/机柜"、二层的"控制台/座椅"。位置挑在房间内的空地，脚本会自动丢弃落墙里的。
const coverRaw = [];
const pushCover = (floor, type, x, z, w, h) => coverRaw.push({ type, x, z, w, h, floor });
for (let k = 0; k < 12; k++) pushCover(0, 'low', 11 + (k % 4) * 2, 11 + Math.floor(k / 4) * 3, 2, 1);
for (let k = 0; k < 8; k++) pushCover(0, 'tall', 20 + (k % 4) * 2, 11 + Math.floor(k / 4) * 3, 1, 1);
for (let k = 0; k < 8; k++) pushCover(0, 'low', 29 + (k % 4) * 2, 11 + Math.floor(k / 4) * 3, 1, 1);
for (let k = 0; k < 6; k++) pushCover(0, 'low', 11 + (k % 3) * 3, 20, 2, 1);
for (let k = 0; k < 10; k++) pushCover(1, 'low', 11 + (k % 5) * 2, 11 + Math.floor(k / 5) * 2, 1, 1);
for (let k = 0; k < 8; k++) pushCover(1, 'tall', 29 + (k % 4) * 2, 11 + Math.floor(k / 4) * 3, 1, 1);
for (let k = 0; k < 6; k++) pushCover(1, 'low', 11 + (k % 3) * 2, 20 + Math.floor(k / 3) * 6, 2, 1);

const slabHas = (i) => slabSet.has(i);
const coverKept = [];
for (const c of coverRaw) {
  // 掩体必须落在**该层可站**的格上：一层 = 没被一层墙占；二层 = 有楼板且没被二层墙占
  const onFloor = (i) => ((c.floor || 0) === 0 ? !wall1.has(i) : slabHas(i) && !wall2.has(i));
  let ok = true;
  for (let dz = 0; dz < c.h && ok; dz++) {
    for (let dx = 0; dx < c.w && ok; dx++) {
      const i = idx(c.x + dx, c.z + dz);
      if (c.x + dx < 1 || c.x + dx > 38 || c.z + dz < 1 || c.z + dz > 38) ok = false;
      else if (!onFloor(i)) ok = false;
    }
  }
  if (ok) coverKept.push(c);
}
const coverCells = new Set();
for (const c of coverKept) {
  for (let dz = 0; dz < c.h; dz++) for (let dx = 0; dx < c.w; dx++) coverCells.add(`${c.floor || 0}:${idx(c.x + dx, c.z + dz)}`);
}

// ---------------- 容器（§7.1：每 25 格可玩面积一个）----------------
const walk1 = [];
for (let z = 1; z <= 38; z++) {
  for (let x = 1; x <= 38; x++) {
    const i = idx(x, z);
    if (wall1.has(i) || coverCells.has(`0:${i}`)) continue;
    walk1.push([x, z]);
  }
}
const walk2 = [];
for (const i of slabSet) {
  if (wall2.has(i)) continue;               // 二层墙格不可走
  if (coverCells.has(`1:${i}`)) continue;
  walk2.push([i % W, (i / W) | 0]);
}
const playable = walk1.length + walk2.length;
const targetContainers = Math.round(playable / 25);

let seed = 20261010;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const typeMix = [['crate_civil', 0.636], ['crate_military', 0.227], ['safe', 0.091], ['key_room', 0.045]];
const containerTypes = [];
for (const [t, share] of typeMix) {
  const n = Math.round(targetContainers * share);
  for (let k = 0; k < n; k++) containerTypes.push(t);
}
while (containerTypes.length < targetContainers) containerTypes.push('crate_civil');
containerTypes.length = targetContainers;

// 双层平均分布：交替从两层取点
const containers = [];
const taken = new Set();
const pool1 = walk1.slice().sort(() => rnd() - 0.5);
const pool2 = walk2.slice().sort(() => rnd() - 0.5);
let i1 = 0;
let i2 = 0;
containerTypes.forEach((t, k) => {
  const useTop = k % 2 === 1;
  const pool = useTop ? pool2 : pool1;
  let ptr = useTop ? i2 : i1;
  for (; ptr < pool.length; ptr++) {
    const [x, z] = pool[ptr];
    const key = `${useTop ? 1 : 0}:${x},${z}`;
    if (taken.has(key)) continue;
    taken.add(key);
    containers.push({ type: t, x, z, floor: useTop ? 1 : 0 });
    break;
  }
  if (useTop) i2 = ptr + 1;
  else i1 = ptr + 1;
});

// ---------------- 分区（必须无缝铺满 1..38）----------------
const zoneNames1 = [
  ['warehouse', '仓储区', 1, 1, 12, 12],
  ['cargo', '货运通道', 13, 1, 13, 12],
  ['garage', '地下车库入口', 26, 1, 13, 12],
  ['server', '服务器机房', 1, 13, 12, 13],
  ['hall', '一层中厅', 13, 13, 13, 13],
  ['office_n', '办公区北', 26, 13, 13, 13],
  ['lobby', '安检大厅', 1, 26, 12, 13],
  ['courtyard', '一层中庭', 13, 26, 13, 13],
  ['office_s', '办公区南', 26, 26, 13, 13],
];
const zoneNames2 = [
  ['archive', '二层档案库', 1, 1, 12, 12],
  ['corridor2', '二层走廊', 13, 1, 13, 12],
  ['equipment', '设备间', 26, 1, 13, 12],
  ['office2', '二层办公', 1, 13, 12, 13],
  ['server2', '二层机房', 13, 13, 13, 13],
  ['control', '控制室', 26, 13, 13, 13],
  ['studio', '演播厅', 1, 26, 12, 13],
  ['atrium2', '挑空中庭', 13, 26, 13, 13],
  ['roof', '天台出口', 26, 26, 13, 13],
];
const zones = [];
for (const [id, label, x, z, w, h] of zoneNames1) {
  zones.push({ id: `z1_${id}`, label, short: label[0], role: 'loot', x, z, w, h, floor: 0 });
}
for (const [id, label, x, z, w, h] of zoneNames2) {
  zones.push({ id: `z2_${id}`, label, short: label[0], role: 'loot', x, z, w, h, floor: 1 });
}
zones.find((z) => z.id === 'z1_lobby').role = 'spawn';

// ---------------- 矩形合并 ----------------
function mergeRects(cells) {
  const used = new Set();
  const rects = [];
  for (let z = 1; z <= 38; z++) {
    for (let x = 1; x <= 38; x++) {
      const i = idx(x, z);
      if (!cells.has(i) || used.has(i)) continue;
      let w = 0;
      while (x + w <= 38 && cells.has(idx(x + w, z)) && !used.has(idx(x + w, z))) w++;
      let h = 1;
      outer: while (z + h <= 38) {
        for (let k = 0; k < w; k++) {
          const j = idx(x + k, z + h);
          if (!cells.has(j) || used.has(j)) break outer;
        }
        h++;
      }
      for (let dz = 0; dz < h; dz++) for (let dx = 0; dx < w; dx++) used.add(idx(x + dx, z + dz));
      rects.push({ x, z, w, h });
    }
  }
  return rects;
}

// ---------------- 自检 ----------------
function largestComponent(cells) {
  const seen = new Set();
  let best = 0;
  for (const start of cells) {
    if (seen.has(start)) continue;
    let n = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      n++;
      const cx = cur % W;
      const cz = (cur / W) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 1 || nx > 38 || nz < 1 || nz > 38) continue;
        const j = idx(nx, nz);
        if (cells.has(j) && !seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    if (n > best) best = n;
  }
  return best;
}
const comp1 = largestComponent(new Set(walk1.map(([x, z]) => idx(x, z))));
// ★ walk2 是 [x,z] 的数组，必须转成**索引**集合：largestComponent 用的是 cells.has(索引)。
//   直接传坐标数组时每一格的邻居都查不到（数组当 key），于是每格都自成一个"连通块"，
//   打印出来就是 1/1048 —— 那是自检写错了，不是地图断了。
const comp2 = largestComponent(new Set(walk2.map(([x, z]) => idx(x, z))));
// ★ 楼梯井必须完全不被楼板覆盖（这条是"楼梯上不去"的直接防线）
const slabOverRamp = [...rampCells1].filter((i) => slabSet.has(i)).length;

const mapOut = {
  _comment:
    'M3-1b-2 ④ 电视台式两层地图（灰盒）。由 tools/gen-map-tv-station.mjs 按规则生成 —— ' +
    '本表是**运行时唯一真值**，生成器是它的生产者；改布局改生成器的参数后重跑，不要手改本表。',
  _coordinateConvention: 'x 向右、z 向下（格坐标）。矩形用 x/z 为左上角、w/h 为宽高（格数）。',
  _renderCommand: 'node tools/render-map.mjs --floor 0  （二层用 --floor 1）',
  _twoFloorNotes: [
    '楼梯井（ramps 覆盖的格）在二层**不铺楼板** —— 否则玩家在坡道上身体会撞到楼板，上不去。',
    '一层墙格的投影在二层必然是洞（楼板 [3.3,3.6] 与一层墙 [0,3.5] 重叠），因此二层没有自己的隔墙；二层的格局由"哪里铺楼板"决定。',
    '一层的门洞同时是二层横跨这些洞的"桥"，所以每个房间都必须有自己的门。',
  ],
  id: 'tv_station_01',
  label: '电视台（两层）',
  grid: { w: W, h: H, cell: 2.5, wallHeight: 3.5 },
  floors: [
    { id: 0, baseY: 0, label: '一层' },
    { id: 1, baseY: 3.6, label: '二层' },
  ],
  slabThickness: 0.3,
  playerSpawn,
  walls: [
    ...mergeRects(wall1).map((r, k) => ({ id: `w1_${k}`, ...r, floor: 0 })),
    ...mergeRects(wall2).map((r, k) => ({ id: `w2_${k}`, ...r, floor: 1 })),
  ],
  slabs: mergeRects(slabSet).map((r, k) => ({ id: `s2_${k}`, ...r, floor: 1 })),
  ramps,
  zones,
  cover: coverKept,
  routes: [],
  extracts,
  containers,
  aiSpawns: [
    { zone: 'z1_cargo', count: 2 },
    { zone: 'z1_server', count: 2 },
    { zone: 'z1_garage', count: 1 },
    { zone: 'z1_office_s', count: 1 },
    { zone: 'z1_warehouse', count: 1 },
  ],
};

const outPath = path.join(ROOT, 'src', 'config', 'maps', 'tv-station-01.json');
fs.writeFileSync(outPath, JSON.stringify(mapOut, null, 2) + '\n', 'utf8');

const inner = 38 * 38;
console.log(JSON.stringify({
  wallCells: { f1: wall1.size, f2: wall2.size },
  wallRatio1: +(wall1.size / inner).toFixed(3),
  slabCells: slabSet.size,
  slabOverRamp,                       // 必须为 0
  playable: { f1: walk1.length, f2: walk2.length, total: playable },
  containers: containers.length,
  density: +(playable / containers.length).toFixed(1),
  perFloor: {
    f1: containers.filter((c) => c.floor === 0).length,
    f2: containers.filter((c) => c.floor === 1).length,
  },
  cover: coverKept.length,
  connectivity: {
    f1: `${comp1}/${walk1.length}`,
    f2: `${comp2}/${walk2.length}`,
  },
}, null, 1));
