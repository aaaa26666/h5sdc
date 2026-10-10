// M3-2 动线图渲染器
//
// 为什么要有这个脚本，而不是手画一张图：
//   手画的图和实现用的数据会脱节 —— 图改了代码没改、或反之。
//   这里**从地图表渲染**，所以评审看到的图就是 M3-1 将要用的那份数据，
//   不可能不一致。同时它把"动线是否单调"这类问题变成可计算的数字。
//
// 输出：
//   · ASCII 地图（分区字母 / 墙 / 容器 / 撤离点 / 动线）
//   · 分区统计（面积、容器数、按档位分布）
//   · 动线统计（长度、步行/冲刺耗时、暴露段比例）
//   · 校验（容器是否落在墙里、数量是否与 07 表预算一致、连通性）
//
// 用法：node tools/render-map.mjs [--table <路径>] [--legend] [--all-routes]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const optVal = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const TABLE = argv.includes('--table') ? path.resolve(optVal('--table', '')) : null;
const LOOT_TABLE = path.join(ROOT, 'docs', '07-loot-tables.json');

// M3-1b-2 ④：地图不止一张、而且有两层了。
//   · 缺省读**当前生效的那张地图**（与运行时同一份数据，不会出现"评审看到的图与实现不符"）
//   · `--table <path>` 仍可指定任意地图表
//   · `--floor <n>` 指定画哪一层（两层地图一次只画一层才有信息量）
const M0 = TABLE ? JSON.parse(fs.readFileSync(TABLE, 'utf8')) : config.map;
const L = JSON.parse(fs.readFileSync(LOOT_TABLE, 'utf8'));
const floorList = M0.floors || [{ id: 0, baseY: 0 }];
const FLOOR = Math.max(0, Math.min(floorList.length - 1, Number(optVal('--floor', 0)) || 0));
const floorBaseY = (f) => (floorList[f] || floorList[0]).baseY;

/** 把地图表切成"单层视图"：ASCII 图一次只画一层 */
const M = {
  ...M0,
  walls: (M0.walls || []).filter((w) => (w.floor || 0) === FLOOR),
  cover: (M0.cover || []).filter((c) => (c.floor || 0) === FLOOR),
  containers: (M0.containers || []).filter((c) => (c.floor || 0) === FLOOR),
  extracts: (M0.extracts || []).filter((e) => (e.floor || 0) === FLOOR),
  zones: (M0.zones || []).filter((z) => (z.floor || 0) === FLOOR),
  routes: FLOOR === 0 ? M0.routes || [] : [],
};
const { w: W, h: H, cell } = M.grid;

const failures = [];
const warnings = [];
let checks = 0;
function check(name, pass, detail) {
  checks++;
  if (!pass) failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —— ' + detail : ''}`);
}
function warn(m) {
  warnings.push(m);
  console.log(`  [警告] ${m}`);
}

// ---------------- 构建网格 ----------------
const blocked = new Uint8Array(W * H);
const inBounds = (x, z) => x >= 0 && z >= 0 && x < W && z < H;
const idx = (x, z) => z * W + x;

// 边界墙（与关卡现有规则一致：最外圈不可通行）
for (let x = 0; x < W; x++) { blocked[idx(x, 0)] = 1; blocked[idx(x, H - 1)] = 1; }
for (let z = 0; z < H; z++) { blocked[idx(0, z)] = 1; blocked[idx(W - 1, z)] = 1; }

for (const b of M.walls) {
  for (let dz = 0; dz < b.h; dz++) {
    for (let dx = 0; dx < b.w; dx++) {
      const x = b.x + dx;
      const z = b.z + dz;
      if (!inBounds(x, z)) {
        failures.push(`墙体 ${b.id} 越界: (${x},${z})`);
        continue;
      }
      blocked[idx(x, z)] = 1;
    }
  }
}

// ★ 第 0 层之外，"地面"是楼板：**没有楼板的格是洞**（掉下去），
//   坡顶格也算该层地面（它是二层的入口）。这一条不画出来的话，
//   二层图会显示成"整片可走"，而实际上一半是悬空的。
if (FLOOR > 0) {
  const onFloor = new Set();
  for (const s of M0.slabs || []) {
    if ((s.floor || 0) !== FLOOR) continue;
    for (let dz = 0; dz < s.h; dz++) {
      for (let dx = 0; dx < s.w; dx++) onFloor.add(idx(s.x + dx, s.z + dz));
    }
  }
  for (const r of M0.ramps || []) {
    if ((r.floor || 0) + 1 !== FLOOR) continue;
    const alongX = r.dir === '+x' || r.dir === '-x';
    const along = alongX ? r.w : r.h;
    const off = r.dir === '+x' || r.dir === '+z' ? along - 1 : 0;
    onFloor.add(idx(alongX ? r.x + off : r.x, alongX ? r.z : r.z + off));
  }
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (!onFloor.has(idx(x, z))) blocked[idx(x, z)] = 1;
    }
  }
}

const zoneAt = (x, z) => M.zones.find((zn) => x >= zn.x && x < zn.x + zn.w && z >= zn.z && z < zn.z + zn.h) || null;

// ---------------- ASCII 地图 ----------------
// 字符优先级：撤离点 > 容器 > 动线 > 分区 > 空地
const canvas = Array.from({ length: H }, () => new Array(W).fill(null));
for (let z = 0; z < H; z++) {
  for (let x = 0; x < W; x++) {
    if (blocked[idx(x, z)]) { canvas[z][x] = '#'; continue; }
    const zn = zoneAt(x, z);
    canvas[z][x] = zn ? zn.short : '·';
  }
}

// 动线（先画，之后被容器/撤离点覆盖）
const routeChars = ['a', 'b', 'c', 'd'];
const routeStats = [];
M.routes.forEach((r, i) => {
  const ch = routeChars[i] || '?';
  let lenCells = 0;
  for (let k = 0; k < r.waypoints.length - 1; k++) {
    const [x0, z0] = r.waypoints[k];
    const [x1, z1] = r.waypoints[k + 1];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps);
      const z = Math.round(z0 + ((z1 - z0) * s) / steps);
      if (inBounds(x, z) && !blocked[idx(x, z)] && canvas[z][x] !== ch) {
        canvas[z][x] = ch;
        lenCells++;
      }
    }
  }
  routeStats.push({ route: r, char: ch, lenCells });
});

// 掩体（在容器/撤离点之前画，后两者优先覆盖显示）
const coverSpec = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'config', 'tunables.json'), 'utf8')
).level.cover;
const coverCells = [];
for (const c of M.cover || []) {
  const h = c.type === 'tall' ? coverSpec.tallHeight : coverSpec.lowHeight;
  for (let dz = 0; dz < c.h; dz++) {
    for (let dx = 0; dx < c.w; dx++) {
      const x = c.x + dx;
      const z = c.z + dz;
      if (!inBounds(x, z) || blocked[idx(x, z)]) continue;
      canvas[z][x] = c.type === 'tall' ? '%' : ':';
      coverCells.push({ x, z, type: c.type, height: h });
    }
  }
}

// 容器计数按**全图**统计：07 表的预算是整张图的，不是单层的。
// （ASCII 图按层过滤是显示需要，不能让"显示口径"污染"预算口径"。）
const containerCounts = {};
for (const c of M0.containers) {
  containerCounts[c.type] = (containerCounts[c.type] || 0) + 1;
}
for (const c of M.containers) {
  if (!inBounds(c.x, c.z)) { failures.push(`容器越界: (${c.x},${c.z})`); continue; }
  if (blocked[idx(c.x, c.z)]) { failures.push(`容器落在墙里: ${c.type} (${c.x},${c.z})`); continue; }
  const def = L.containers.find((k) => k.id === c.type);
  const mark = { crate_civil: 'o', crate_military: 'O', safe: 'X', key_room: 'K' }[c.type] || '?';
  canvas[c.z][c.x] = def ? mark : '?';
}

// 撤离点
for (const e of M.extracts) {
  const rc = Math.round(e.radiusCells);
  for (let dz = -rc; dz <= rc; dz++) {
    for (let dx = -rc; dx <= rc; dx++) {
      const x = e.x + dx;
      const z = e.z + dz;
      if (!inBounds(x, z) || blocked[idx(x, z)]) continue;
      canvas[z][x] = 'E';
    }
  }
}

console.log(`\n================ M3-2 动线图：${M.label} ================`);
console.log(`  数据源: ${TABLE ? path.relative(ROOT, TABLE) : `src/config/maps（生效地图 ${M0.id}）`}`);
console.log(`  楼层  : 第 ${FLOOR} 层（baseY ${floorBaseY(FLOOR)}m，共 ${floorList.length} 层）`);
console.log(`  状态  : 待评审（本图由地图表渲染，与运行时同一份数据）\n`);
console.log(`  网格 ${W}x${H} 格，每格 ${cell}m  →  ${W * cell}m x ${H * cell}m\n`);

// 每行 40 字符；为可读性按 2 格一字符？不 —— 保持 1:1，40 列在终端可读
console.log('     ' + Array.from({ length: W }, (_, i) => (i % 10 === 0 ? String(i / 10) : ' ')).join(''));
for (let z = 0; z < H; z++) {
  console.log(String(z).padStart(3) + '  ' + canvas[z].join(''));
}
console.log('     ' + Array.from({ length: W }, (_, i) => (i % 10 === 0 ? String(i / 10) : ' ')).join(''));

console.log('\n  图例: # 墙   E 撤离点   o 民用箱   O 军用箱   X 保险箱   K 钥匙房');
console.log('        : 低掩体(可迈上)   % 高掩体(需跳上、挡子弹)');
console.log('        S 出生区   R 资源区   C 交战区   · 通道');
routeStats.forEach((rs) => console.log(`        ${rs.char} = ${rs.route.label}`));

// ---------------- 分区统计 ----------------
console.log('\n—— 分区统计 ——');
{
  const areaOf = (zn) => {
    let free = 0;
    let total = 0;
    for (let z = zn.z; z < zn.z + zn.h; z++) {
      for (let x = zn.x; x < zn.x + zn.w; x++) {
        if (!inBounds(x, z)) continue;
        total++;
        if (!blocked[idx(x, z)]) free++;
      }
    }
    return { free, total };
  };
  for (const zn of M.zones) {
    const a = areaOf(zn);
    const cs = M.containers.filter((c) => {
      const zz = zoneAt(c.x, c.z);
      return zz && zz.id === zn.id;
    });
    const byType = {};
    for (const c of cs) byType[c.type] = (byType[c.type] || 0) + 1;
    const dist = Object.entries(byType)
      .map(([k, v]) => `${L.containers.find((x) => x.id === k).label}${v}`)
      .join(' ');
    console.log(
      `  ${zn.label.padEnd(12)} 可通行 ${String(a.free).padStart(4)} 格 ` +
        `(${(a.free * cell * cell).toFixed(0)} m²)  容器 ${String(cs.length).padStart(2)}  ${dist}`
    );
  }
  // 分区之外的空地（走廊/开阔地）
  let outside = 0;
  for (let z = 0; z < H; z++) {
    for (let x = 0; x < W; x++) {
      if (blocked[idx(x, z)]) continue;
      if (!zoneAt(x, z)) outside++;
    }
  }
  console.log(`  ${'（分区外通道）'.padEnd(11)} 可通行 ${String(outside).padStart(4)} 格 (${(outside * cell * cell).toFixed(0)} m²)`);
}

// ---------------- 动线统计 ----------------
console.log('\n—— 动线统计 ——');
{
  const walk = 5.0;
  const sprint = 7.5;
  for (const rs of routeStats) {
    // 沿折线累计真实长度（格），并统计有多少格处于"开阔无掩体"状态
    let lenCells = 0;
    let openCells = 0;
    for (let k = 0; k < rs.route.waypoints.length - 1; k++) {
      const [x0, z0] = rs.route.waypoints[k];
      const [x1, z1] = rs.route.waypoints[k + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const z = Math.round(z0 + ((z1 - z0) * s) / steps);
        if (!inBounds(x, z)) continue;
        lenCells++;
        // 掩体判定：周边 2 格内没有墙 = 暴露段
        let cover = false;
        for (let dz = -2; dz <= 2 && !cover; dz++) {
          for (let dx = -2; dx <= 2 && !cover; dx++) {
            if (inBounds(x + dx, z + dz) && blocked[idx(x + dx, z + dz)]) cover = true;
          }
        }
        if (!cover) openCells++;
      }
    }
    const meters = lenCells * cell;
    const exposure = lenCells ? openCells / lenCells : 0;
    console.log(
      `  ${rs.route.label}`
    );
    console.log(
      `    长度 ${meters.toFixed(0)}m   步行 ${(meters / walk).toFixed(1)}s   冲刺 ${(meters / sprint).toFixed(1)}s   ` +
        `暴露段 ${(exposure * 100).toFixed(0)}%`
    );
    console.log(`    设计意图: ${rs.route._why}`);
  }
  // 单调性检查：三条路线的暴露段比例必须有差异，否则"选择"是假的
  const exposures = routeStats.map((rs) => {
    let lenCells = 0;
    let openCells = 0;
    for (let k = 0; k < rs.route.waypoints.length - 1; k++) {
      const [x0, z0] = rs.route.waypoints[k];
      const [x1, z1] = rs.route.waypoints[k + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const z = Math.round(z0 + ((z1 - z0) * s) / steps);
        if (!inBounds(x, z)) continue;
        lenCells++;
        let cover = false;
        for (let dz = -2; dz <= 2 && !cover; dz++) {
          for (let dx = -2; dx <= 2 && !cover; dx++) {
            if (inBounds(x + dx, z + dz) && blocked[idx(x + dx, z + dz)]) cover = true;
          }
        }
        if (!cover) openCells++;
      }
    }
    return openCells / lenCells;
  });
  // ★ 判据是「每条动线都必须有存在的理由」，而不是「暴露度必须差多少 X 个百分点」。
  //
  // 初版用「暴露极差 >= 15pp」。它的问题是：极差是个**拍脑袋的阈值**，
  // 而且两条路线暴露度接近时未必没区别 —— 它们的区别可能在**路程**或**顺路能搜到多少**。
  // 真正该守的不变量是：**没有任何一条动线被另一条全面支配**
  // （即不存在"更短、更安全、还能顺路搜更多"的路线，否则被支配的那条就是废的）。
  const metrics = routeStats.map((rs) => {
    let lenCells = 0;
    let openCells = 0;
    const zonesHit = new Set();
    for (let k = 0; k < rs.route.waypoints.length - 1; k++) {
      const [x0, z0] = rs.route.waypoints[k];
      const [x1, z1] = rs.route.waypoints[k + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const z = Math.round(z0 + ((z1 - z0) * s) / steps);
        if (!inBounds(x, z)) continue;
        lenCells++;
        let cover = false;
        for (let dz = -2; dz <= 2 && !cover; dz++) {
          for (let dx = -2; dx <= 2 && !cover; dx++) {
            if (inBounds(x + dx, z + dz) && blocked[idx(x + dx, z + dz)]) cover = true;
          }
        }
        if (!cover) openCells++;
        const zn = zoneAt(x, z);
        if (zn && zn.role === 'resource') zonesHit.add(zn.id);
      }
    }
    return {
      label: rs.route.label,
      len: lenCells,
      exposure: openCells / lenCells,
      loot: zonesHit.size,
    };
  });
  // A 支配 B：A 不更差且至少一项更好（长度越短越好、暴露越低越好、顺路资源区越多越好）
  const dominates = (a, b) =>
    a.len <= b.len && a.exposure <= b.exposure && a.loot >= b.loot &&
    (a.len < b.len || a.exposure < b.exposure || a.loot > b.loot);
  let dominated = null;
  for (const a of metrics) {
    for (const b of metrics) {
      if (a === b) continue;
      if (dominates(a, b)) dominated = `${b.label} 被 ${a.label} 全面支配`;
    }
  }
  check('没有任何动线被另一条全面支配（每条路线都有存在的理由）',
    dominated === null,
    dominated ||
      metrics.map((m) => `${m.label.split('（')[0]} 长度${m.len}格 暴露${(m.exposure * 100).toFixed(0)}% 顺路资源区${m.loot}`).join('  |  '));
}

// 路线不得穿墙（也不该穿过高掩体 —— 高掩体挡移动，AI 寻路也会绕开它）
{
  let bad = null;
  for (const r of M.routes) {
    for (let k = 0; k < r.waypoints.length - 1 && !bad; k++) {
      const [x0, z0] = r.waypoints[k];
      const [x1, z1] = r.waypoints[k + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const z = Math.round(z0 + ((z1 - z0) * s) / steps);
        if (!inBounds(x, z) || blocked[idx(x, z)]) {
          bad = `${r.id} 在 (${x},${z}) 穿过墙体`;
          break;
        }
        // 高掩体是可跳过的（玩家），但 AI 会绕路 —— 动线穿过它属于设计疏漏
        const tall = (M.cover || []).find(
          (c) =>
            (c.type === 'tall') &&
            x >= c.x && x < c.x + c.w && z >= c.z && z < c.z + c.h
        );
        if (tall) {
          bad = `${r.id} 在 (${x},${z}) 穿过高掩体（玩家要跳，AI 要绕）`;
          break;
        }
      }
    }
  }
  check('动线不穿墙、也不穿高掩体', bad === null, bad || '三条动线全程可通行');
}

// 每条动线顺路能经过哪些资源区 —— 这是「选路」的实质收益
{
  const through = [];
  for (const r of M.routes) {
    const zonesHit = new Set();
    for (let k = 0; k < r.waypoints.length - 1; k++) {
      const [x0, z0] = r.waypoints[k];
      const [x1, z1] = r.waypoints[k + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const z = Math.round(z0 + ((z1 - z0) * s) / steps);
        const zn = zoneAt(x, z);
        if (zn) zonesHit.add(zn.label);
      }
    }
    through.push({ label: r.label, zones: [...zonesHit] });
  }
  console.log('\n  —— 每条动线顺路经过的分区（「选路」的实质收益）——');
  for (const t of through) console.log(`    ${t.label}\n      ${t.zones.join(' / ')}`);
}

// ---------------- 逻辑校验 ----------------
console.log('\n—— 校验 ——');
check('地图表无结构性错误（越界 / 容器落墙里）',
  failures.filter((f) => f.includes('越界') || f.includes('墙里')).length === 0,
  failures.filter((f) => f.includes('越界') || f.includes('墙里')).join('; ') || '无');

{
  // 容器数量必须与 07 表的预算完全一致
  const budget = L.containerBudget;
  const bad = [];
  for (const k of Object.keys(budget)) {
    if (k.startsWith('_')) continue;
    const want = budget[k];
    const got = containerCounts[k] || 0;
    if (want !== got) bad.push(`${k} 期望 ${want} 实际 ${got}`);
  }
  const totalWant = budget._total;
  const totalGot = M0.containers.length;
  check('容器数量与 07 表预算完全一致', bad.length === 0 && totalWant === totalGot,
    bad.length ? bad.join('; ') : `共 ${totalGot} 个（预算 ${totalWant}）`);
}

{
  // 离心率：所有容器都必须落在某个分区内，否则是"没人管的角落"
  const orphan = M.containers.filter((c) => !zoneAt(c.x, c.z));
  check('所有容器都落在某个分区内（没有无人区容器）', orphan.length === 0,
    orphan.map((c) => `${c.type}(${c.x},${c.z})`).join(', ') || '全部在分区内');
}

{
  // 撤离点数量与 §2.4 规则 —— 这是**整张图**的规则，不是单层的，
  // 所以按全图（M0）判，否则两层图会在每层各判一次、各报一次假失败。
  const n = M0.extracts.length;
  check('撤离点数量在 2~4 个之间（§2.4）', n >= 2 && n <= 4, `${n} 个`);
  const cond = M0.extracts.filter((e) => e.conditional).length;
  check('存在条件撤离点（§2.4 要求分常驻与条件）', cond >= 1, `条件点 ${cond} 个，常驻 ${n - cond} 个`);
}

{
  // 连通性：从**该层的入口**出发做 BFS。
  //   第 0 层 = 出生区中心；第 1 层及以上 = 楼梯的坡顶格（上楼后的落脚点）。
  //   用 role==='spawn' 而不是硬编码分区 id —— id 会随地图变，role 不会。
  const spawnZone = M.zones.find((z) => z.role === 'spawn');
  let start = null;
  if (spawnZone) {
    start = [spawnZone.x + Math.floor(spawnZone.w / 2), spawnZone.z + Math.floor(spawnZone.h / 2)];
  } else {
    const top = (M0.ramps || []).find((r) => (r.floor || 0) + 1 === FLOOR);
    if (top) {
      const alongX = top.dir === '+x' || top.dir === '-x';
      const along = alongX ? top.w : top.h;
      const off = top.dir === '+x' || top.dir === '+z' ? along - 1 : 0;
      start = [alongX ? top.x + off : top.x, alongX ? top.z : top.z + off];
    }
  }
  check(`第 ${FLOOR} 层找得到连通性起点（出生区或楼梯坡顶）`, !!start,
    start ? `起点 (${start[0]},${start[1]})` : '既没有出生区、也没有通向本层的楼梯');
  const seen = new Set(start ? [idx(start[0], start[1])] : []);
  const queue = start ? [start] : [];
  while (queue.length) {
    const [x, z] = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const nz = z + dz;
      if (!inBounds(nx, nz) || blocked[idx(nx, nz)]) continue;
      if (seen.has(idx(nx, nz))) continue;
      seen.add(idx(nx, nz));
      queue.push([nx, nz]);
    }
  }
  const unreachable = M.extracts.filter((e) => !seen.has(idx(e.x, e.z)));
  check('全部撤离点从出生区可达', unreachable.length === 0,
    unreachable.map((e) => e.label).join(', ') || `可达格数 ${seen.size}`);
  const orphanContainers = M.containers.filter((c) => !seen.has(idx(c.x, c.z)));
  check('全部容器从出生区可达', orphanContainers.length === 0,
    orphanContainers.map((c) => `${c.type}(${c.x},${c.z})`).join(', ') || '全部可达');
  const freeTotal = W * H - blocked.reduce((a, b) => a + b, 0);
  if (seen.size < freeTotal) {
    warn(`有 ${freeTotal - seen.size} 个可通行格从出生区不可达（孤岛），评审时需确认是否有意为之`);
  }
}

{
  // 出生区到**最近的**撤离点的距离要短（「速撤」玩法要成立）。
  // 只有当层有出生区时才判 —— 二层没有出生区，这条对它不适用
  //（用 role 而不是写死 id，也不写死某个撤离点的 id：两者都会随地图变）。
  const spawn = M.zones.find((z) => z.role === 'spawn');
  if (!spawn) {
    check(`第 ${FLOOR} 层没有出生区 → 不适用「速撤距离」`, true, '跳过');
  } else {
    const cx = spawn.x + spawn.w / 2;
    const cz = spawn.z + spawn.h / 2;
    let nearest = null;
    for (const e of M.extracts) {
      const d = Math.hypot(e.x - cx, e.z - cz) * cell;
      if (!nearest || d < nearest.d) nearest = { d, e };
    }
    check('最近撤离点离出生区足够近（「速撤」玩法成立）',
      !!nearest && nearest.d < 45,
      nearest ? `${nearest.d.toFixed(0)}m（出生区中心 → ${nearest.e.label}）` : '本层没有撤离点');
  }
}

console.log(`\n  校验 ${checks} 项，失败 ${failures.length}，警告 ${warnings.length}`);
if (failures.length) {
  console.log('\n  失败项：');
  for (const f of failures) console.log('    ' + f);
}
process.exit(failures.length ? 1 : 0);
