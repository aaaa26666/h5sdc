// M3-1b-1 黄金基准录制 / 校验
//
// 为什么需要它：M3-1b-1 的验收标准是「**行为与改造前完全一致**」。
// 这句话如果只靠"我觉得应该一样"就是空话。所以先把现有几何实现的行为
// 录成一份基准数据，改完再逐条比对 —— 让"行为不变"成为**可证**的结论。
//
// 录制：node tools/capture-level-golden.mjs --out results/level-golden-<map>.json
// 校验：node tools/capture-level-golden.mjs --verify results/level-golden-<map>.json
//
// 本工具必须能**同时驱动改造前后两版实现**（旧函数改造后就不存在了），
// 因此按 `level.geometryVersion` 分支调用，而不是靠"某函数是否存在"去猜。
//
// 每条记录都是「输入 + 当时的输出」。校验时用同一实现重跑输入、比对输出。
// ★ 只有输出可以四舍五入，**输入必须原样保存** —— 这是被自检抓出来的工具 bug：
//   初版把输入也舍入到 5 位小数，重跑时自然得到略不同的结果，"基准对不上自己"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/index.js';
import { createLevel } from '../src/level/level.js';
import { mulberry32 } from '../src/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const optVal = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const VERIFY_PATH = argv.includes('--verify') ? path.resolve(optVal('--verify', '')) : null;
const OUT = path.resolve(optVal('--out', `results/level-golden-${config.map.id}.json`));

const STEP = config.player.stepHeight;
const BODY_H = 1.8; // 比对用的实体高度。单层世界里没有任何阻挡在头顶，因此取值不影响结果。

// three.js 的 Mesh/InstancedMesh 在 Node 里可以构造，只要 scene 是个接收 add 的桩。
// 因此不需要浏览器就能直接驱动**真实的** level 实现 —— 这是本工具能成立的前提。
const stubScene = { add() {}, remove() {} };
const level = createLevel(config, stubScene);
const V = level.geometryVersion || 1;

/**
 * 统一两版实现的调用方式。
 * 记录的是**语义等价**的量，而不是某个具体函数名：
 *   tallestTop  —— 该格最高实心体的顶面（旧：effectiveHeightAt）
 *   surface     —— 站在该格时的地面高度（旧：groundHeightAt；新：surfaceAt 带 y）
 *   resolve     —— 圆 vs 几何（新版本多一个实体高度参数）
 */
const api =
  V === 1
    ? {
        tallestTop: (cx, cz) => level.effectiveHeightAt(cx, cz),
        surface: (x, z, feetY) => level.groundHeightAt(x, z),
        resolve: (pos, r, feetY, step) => level.resolveCircle(pos, r, feetY, step),
        rayWall: (o, d, m) => level.raycastWall(o[0], o[1], o[2], d[0], d[1], d[2], m),
        rayGround: (o, d, m) => level.raycastGroundFull(o[0], o[1], o[2], d[0], d[1], d[2], m),
        los: (a, b) => level.hasLineOfSight(a[0], a[1], a[2], b[0], b[1], b[2]),
      }
    : {
        tallestTop: (cx, cz) => level.tallestSolidTopAt(cx, cz),
        surface: (x, z, feetY) => level.surfaceAt(x, z, feetY, STEP),
        resolve: (pos, r, feetY, step) => level.resolveCircle(pos, r, feetY, BODY_H, step),
        rayWall: (o, d, m) => level.raycastWall(o[0], o[1], o[2], d[0], d[1], d[2], m),
        rayGround: (o, d, m) => level.raycastGroundFull(o[0], o[1], o[2], d[0], d[1], d[2], m),
        los: (a, b) => level.hasLineOfSight(a[0], a[1], a[2], b[0], b[1], b[2]),
      };

const W = level.W;
const H = level.H;
const cell = level.cell;
const rnd = mulberry32(20260301); // 固定种子：同输入同采样，可比对
const r5 = (v) => +v.toFixed(5);
const fin = (v) => (Number.isFinite(v) ? r5(v) : -1);

// ---------------------------------------------------------------------------
function collect() {
  // 1) 逐格：最高实心体顶面 / 阻挡 / 寻路阻挡 / 该格中心的地面高度
  const perCell = [];
  for (let cz = 0; cz < H; cz++) {
    for (let cx = 0; cx < W; cx++) {
      const top = api.tallestTop(cx, cz);
      const isWall = level.isBlockedCell(cx, cz) ? 1 : 0;
      // 规范脚底高度：墙格取 0（墙顶 3.5m 不可达 —— 跳跃最高仅约 0.68m）；
      // 掩体格取 max(0, 顶面 - stepHeight)，这正是碰撞层允许进入该格的最低脚底高度。
      const feetY = !isWall && top > 0 ? Math.max(0, top - STEP) : 0;
      perCell.push([
        r5(top), isWall, level.isPathBlockedCell(cx, cz) ? 1 : 0,
        r5(api.surface((cx + 0.5) * cell, (cz + 0.5) * cell, feetY)),
      ]);
    }
  }

  // 2) surface：格子中心 + 四角 + 各边中点（几何 bug 几乎总在边界上）
  const ground = [];
  const offsets = [
    [0.5, 0.5], [0.02, 0.02], [0.98, 0.02], [0.02, 0.98], [0.98, 0.98],
    [0.5, 0.02], [0.5, 0.98], [0.02, 0.5], [0.98, 0.5],
  ];
  for (let cz = 0; cz < H; cz++) {
    for (let cx = 0; cx < W; cx++) {
      const top = api.tallestTop(cx, cz);
      const isWall = level.isBlockedCell(cx, cz);
      const feetY = !isWall && top > 0 ? Math.max(0, top - STEP) : 0;
      for (const [ox, oz] of offsets) {
        const x = (cx + ox) * cell;
        const z = (cz + oz) * cell;
        ground.push([x, z, feetY, r5(api.surface(x, z, feetY))]);
      }
    }
  }

  // 3) resolveCircle：输入 → 输出（该函数会原地修改 pos）
  const resolve = [];
  {
    const hs = new Set([0, 0.2, 0.44, 0.45, 0.46, 0.6, 0.9, 1.04, 1.05, 1.06, 1.5, 2.0, 3.0]);
    for (const c of level.coverList) {
      hs.add(+(c.height - 0.01).toFixed(3));
      hs.add(+c.height.toFixed(3));
      hs.add(+(c.height + 0.01).toFixed(3));
    }
    const heights = [...hs].sort((a, b) => a - b);
    const cells = new Set();
    for (const c of level.coverList) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = c.cell + dx;
          const z = c.z + dz;
          if (x > 0 && z > 0 && x < W - 1 && z < H - 1) cells.add(z * W + x);
        }
      }
    }
    for (let i = 0; i < 300; i++) cells.add(level.free[Math.floor(rnd() * level.free.length)]);
    for (const ci of cells) {
      const cx = ci % W;
      const cz = Math.floor(ci / W);
      for (const [ox, oz] of [[0.5, 0.5], [0.1, 0.1]]) {
        for (const r of [0.4]) {
          for (const fy of heights) {
            for (const st of [0, 0.6]) {
              const inX = (cx + ox) * cell;
              const inZ = (cz + oz) * cell;
              const pos = { x: inX, y: fy, z: inZ };
              api.resolve(pos, r, fy, st);
              resolve.push([inX, inZ, r5(pos.x), r5(pos.z), r, fy, st]);
            }
          }
        }
      }
    }
  }

  // 4) raycastWall：起点含"掩体顶面 ±1cm"，方向为 8 方位 × 5 俯仰
  const ray = [];
  {
    const dirs = [];
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      for (const pitch of [-0.5, -0.1, 0, 0.1, 0.5]) {
        const cy = Math.cos(pitch);
        dirs.push([Math.cos(th) * cy, Math.sin(pitch), Math.sin(th) * cy]);
      }
    }
    const origins = [];
    for (const c of level.coverList) {
      origins.push([(c.cell + 0.5) * cell, c.height + 0.01, (c.z + 0.5) * cell]);
      origins.push([(c.cell + 0.5) * cell, Math.max(0, c.height - 0.01), (c.z + 0.5) * cell]);
    }
    for (let i = 0; i < 300; i++) {
      const f = level.free[Math.floor(rnd() * level.free.length)];
      origins.push([(f % W + 0.5) * cell, [1.0, 1.65, 0.5][i % 3], (Math.floor(f / W) + 0.5) * cell]);
    }
    for (const o of origins) {
      for (const d of dirs) {
        ray.push([o[0], o[1], o[2], d[0], d[1], d[2], fin(api.rayWall(o, d, 60))]);
      }
    }
  }

  // 5) raycastGroundFull
  const groundRay = [];
  for (let i = 0; i < 1500; i++) {
    const f = level.free[Math.floor(rnd() * level.free.length)];
    const o = [(f % W + 0.5) * cell, 1.0 + rnd() * 2.5, (Math.floor(f / W) + 0.5) * cell];
    const th = rnd() * Math.PI * 2;
    const dy = -0.2 - rnd() * 0.8;
    const cy = Math.sqrt(Math.max(0, 1 - dy * dy));
    const d = [Math.cos(th) * cy, dy, Math.sin(th) * cy];
    const r = api.rayGround(o, d, 60);
    groundRay.push([o[0], o[1], o[2], d[0], d[1], d[2], r ? r5(r.t) : -1, r ? r5(r.y) : -1]);
  }

  // 6) hasLineOfSight
  const los = [];
  for (let i = 0; i < 1500; i++) {
    const a = level.free[Math.floor(rnd() * level.free.length)];
    const b = level.free[Math.floor(rnd() * level.free.length)];
    const pa = [(a % W + 0.5) * cell, 1.65, (Math.floor(a / W) + 0.5) * cell];
    const pb = [(b % W + 0.5) * cell, 1.65, (Math.floor(b / W) + 0.5) * cell];
    los.push([pa[0], pa[2], pb[0], pb[2], api.los(pa, pb) ? 1 : 0]);
  }

  return { perCell, ground, resolve, ray, groundRay, los };
}

// ---------------------------------------------------------------------------
// 旧实现（几何版本 1）的 raycastWall —— **仅用于归因分析**，不参与游戏运行。
//
// 为什么需要它：改造后 raycastWall 有 922 条与基准不一致。直接说"那是修 bug"
// 就成了空口无凭 —— 必须能证明**每一条分歧都出在旧算法的那条缺陷路径上**，
// 否则就可能是回归被"修 bug"这个说法盖过去了。
//
// 缺陷路径（标 early=true）：射线进入某格后，若入口点高于该格阻挡体顶面且不下降，
//   旧实现**直接返回 Infinity**。这条捷径假设"所有阻挡体一样高"——
//   而掩体 0.45m、墙 3.5m 推翻了它：在低掩体上方完全不代表在墙上方。
//   后果：擦过一格低掩体上方后，射线穿过后面所有的墙（子弹穿墙）。
// ---------------------------------------------------------------------------
function oldRaycastWall(level, ox, oy, oz, dx, dy, dz, maxDist) {
  const cell = level.cell;
  const W = level.W;
  const H = level.H;
  let cx = Math.floor(ox / cell);
  let cz = Math.floor(oz / cell);
  const h0 = level.tallestSolidTopAt(cx, cz);
  if (h0 > 0 && oy >= 0 && oy <= h0) return { t: 0, early: false };
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const invDx = dx !== 0 ? 1 / dx : 0;
  const invDz = dz !== 0 ? 1 / dz : 0;
  let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) * cell - ox) * invDx;
  let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? cz + 1 : cz) * cell - oz) * invDz;
  const tDeltaX = dx === 0 ? Infinity : cell * Math.abs(invDx);
  const tDeltaZ = dz === 0 ? Infinity : cell * Math.abs(invDz);
  for (let g = 0; g < (W + H) * 4; g++) {
    let t;
    if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDeltaX; }
    else { t = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
    if (t > maxDist) return { t: Infinity, early: false };
    const h = level.tallestSolidTopAt(cx, cz);
    if (h <= 0) continue;
    const y = oy + dy * t;
    if (y >= 0 && y <= h) return { t, early: false };
    if (y > h) {
      if (dy >= 0) return { t: Infinity, early: true }; // ← 缺陷路径
      const tTop = (h - oy) / dy;
      if (tTop > t && tTop <= maxDist) {
        const px = ox + dx * tTop;
        const pz = oz + dz * tTop;
        if (Math.floor(px / cell) === cx && Math.floor(pz / cell) === cz) return { t: tTop, early: false };
      }
      continue;
    }
  }
  return { t: Infinity, early: false };
}

// ---------------------------------------------------------------------------
if (VERIFY_PATH) {
  const base = JSON.parse(fs.readFileSync(VERIFY_PATH, 'utf8'));
  const now = collect();
  const EPS = 1e-4;

  let checked = 0;
  const regressions = [];   // 必须为 0：不该变的地方变了
  const bugfixes = [];      // 允许：已**逐条归因**到旧算法缺陷路径的反向变化
  const unexplained = [];   // 必须为 0：有分歧但无法归因
  const divCount = {};      // 每类分歧数

  const mark = (cat) => { divCount[cat] = (divCount[cat] || 0) + 1; };

  // 逐条严格比对的类别：这些地方**不允许任何分歧**。
  // 它们的输出完全由几何决定，不经过 raycastWall 那条缺陷路径。
  const strict = (what, i, a, b, fields) => {
    for (const k of fields) {
      const av = a[k];
      const bv = b[k];
      const bad =
        typeof av === 'number' && typeof bv === 'number' ? Math.abs(av - bv) > EPS : av !== bv;
      checked++;
      if (!bad) continue;
      mark(what);
      if (regressions.length < 30) {
        regressions.push(`${what}[${i}] 字段${k} 基准=${av} 实得=${bv}`);
      }
    }
  };

  base.perCell.forEach((row, i) => strict('perCell', i, row, now.perCell[i], [0, 1, 2, 3]));
  base.ground.forEach((row, i) => strict('surface', i, row, now.ground[i], [3]));
  base.resolve.forEach((row, i) => strict('resolve', i, row, now.resolve[i], [2, 3]));
  base.groundRay.forEach((row, i) => strict('groundRay', i, row, now.groundRay[i], [6, 7]));

  // raycastWall：允许"旧漏判 → 新命中"，但必须逐条归因到缺陷路径
  base.ray.forEach((row, i) => {
    const [ox, oy, oz, dx, dy, dz, bt] = row;
    const t = level.raycastWall(ox, oy, oz, dx, dy, dz, 60);
    const got = Number.isFinite(t) ? +t.toFixed(5) : -1;
    checked++;
    if (Math.abs(got - bt) <= EPS) return;
    mark('ray');
    if (bt >= 0) {
      if (regressions.length < 30) regressions.push(`ray[${i}] 旧命中=${bt} 新=${got}（旧能命中而新不同）`);
      return;
    }
    const oldRes = oldRaycastWall(level, ox, oy, oz, dx, dy, dz, 60);
    if (oldRes.early) bugfixes.push({ cat: 'ray', i });
    else if (unexplained.length < 30) unexplained.push(`ray[${i}] 旧=${bt} 新=${got}，旧算法未走缺陷路径`);
  });

  // hasLineOfSight：它建立在 raycastWall 之上，因此同样可能被那条缺陷路径影响。
  // 表现为 旧=通畅(1) / 新=被挡(0) —— 也就是旧实现"隔墙有视线"。
  base.los.forEach((row, i) => {
    const [ax, az, bx, bz, bv] = row;
    const ay = 1.65;
    const got = level.hasLineOfSight(ax, ay, az, bx, ay, bz) ? 1 : 0;
    checked++;
    if (got === bv) return;
    mark('los');
    if (bv === 0 && got === 1) {
      // 旧说被挡、新说通畅 —— 这是**更宽松**的变化，必须算回归
      if (regressions.length < 30) regressions.push(`los[${i}] 旧=被挡 新=通畅（变宽松，属回归）`);
      return;
    }
    // 旧=通畅、新=被挡：检查这条射线在旧算法下是否走了缺陷路径
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, 0, dz);
    const oldRes = oldRaycastWall(level, ax, ay, az, dx / dist, 0, dz / dist, dist);
    if (oldRes.early) bugfixes.push({ cat: 'los', i });
    else if (unexplained.length < 30) unexplained.push(`los[${i}] 旧=通畅 新=被挡，但旧算法未走缺陷路径`);
  });

  console.log(`\n================ M3-1b-1 行为等价校验 ================`);
  console.log(`  基准文件: ${path.relative(ROOT, VERIFY_PATH)}`);
  console.log(`  基准地图: ${base.mapId}   当前地图: ${config.map.id}`);
  console.log(`  基准几何版本: ${base.geometryVersion}   当前: ${V}`);
  console.log(`  比对条目: ${checked}（容差 ${EPS}）`);
  if (base.mapId !== config.map.id) {
    console.log('  ✗ 地图不一致，基准不可用于本次比对');
    process.exit(1);
  }

  console.log('\n  —— 逐类分歧 ——');
  const cats = ['perCell', 'surface', 'resolve', 'groundRay', 'ray', 'los'];
  for (const c of cats) {
    const n = divCount[c] || 0;
    console.log(`    ${c.padEnd(10)} ${String(n).padStart(5)}  ${n === 0 ? '✓ 完全一致' : ''}`);
  }

  const regByCat = regressions.length;
  console.log(`\n  回归（不该变的地方变了）：${regByCat}  ${regByCat === 0 ? '✓' : '✗'}`);
  for (const r of regressions) console.log('    ✗ ' + r);
  console.log(`  无法归因的分歧：${unexplained.length}  ${unexplained.length === 0 ? '✓' : '✗'}`);
  for (const u of unexplained) console.log('    ✗ ' + u);
  const byCat = {};
  for (const b of bugfixes) byCat[b.cat] = (byCat[b.cat] || 0) + 1;
  console.log(
    `  已归因的旧缺陷修复：${bugfixes.length} 条` +
      `（${Object.entries(byCat).map(([k, v]) => k + ' ' + v).join('，')}）` +
      `\n    全部命中旧算法 raycastWall 的"上方提前返回"缺陷路径 —— 即子弹/视线穿过低掩体后方的墙`
  );

  if (regressions.length || unexplained.length) {
    console.log('\n  ✗ 未通过');
    process.exit(1);
  }
  console.log('\n  ✓ 通过：除已逐条归因的旧缺陷修复外，行为完全一致');
  process.exit(0);
}

// ---------------------------------------------------------------------------
const data = {
  _comment:
    'M3-1b-1 几何行为黄金基准。M3-1b-1 的验收标准是"行为与改造前完全一致"，本文件是它的依据。' +
    '改造（几何版本 1 -> 2）后：node tools/capture-level-golden.mjs --verify <本文件> 必须全部一致。',
  mapId: config.map.id,
  geometryVersion: V,
  grid: { W, H, cell, wallHeight: level.wallHeight },
  stepHeight: STEP,
  bodyHeight: BODY_H,
  ...collect(),
};
data.counts = Object.fromEntries(
  Object.entries(data).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(data), 'utf8');
console.log(`\n================ M3-1b-1 黄金基准已录制 ================`);
console.log(`  地图: ${config.map.id}   几何版本: ${V}`);
for (const [k, v] of Object.entries(data.counts)) console.log(`  ${k.padEnd(10)} ${v} 条`);
console.log(`  文件: ${path.relative(ROOT, OUT)}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
