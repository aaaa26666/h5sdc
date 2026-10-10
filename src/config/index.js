// 配置装配与校验
//
// 依据《流程文档》第 8.3 节：配置表必须提供结构校验，包含**引用完整性**检查。
// 为什么必须在启动时校验而不是等运行时报错：
//   武器表里写错一个 ammoType，如果只在开火时才去查表，那要等到玩家捡到那把枪、
//   打光一梭子才会崩 —— 这类问题在自动化测试里也很难覆盖到每条分支。
//   启动即校验可以把"表写错"变成"启动就报错并指出是哪一行"。
//
// 校验失败一律抛错并中止启动。配置错误属于开发期错误，静默降级只会让它更晚被发现。
//
// M3-1 增补：地图由**地图表**驱动（此前是种子随机生成）。
//   地图表是尺寸/出生点/墙体/掩体/容器/撤离点/AI 配额的唯一来源，
//   本文件把它**派生成既有字段**（level.playerSpawnCell / extract.zones /
//   loot.containerCells），这样下游模块（player / extract / loot / main）零改动。
//   派生而不是复制，是为了避免同一份数据存在两处、然后慢慢分叉。

// 注意：这里显式使用 import attributes（with { type: 'json' }）。
// 原因是本文件必须**同时**能在浏览器（Vite）和 Node（tools/ttk.mjs 等纯函数工具）里加载。
// 若只写 `import x from './x.json'`，Vite 可以但 Node 会拒绝，
// 于是工具侧就只能自己再拼一份配置 —— 那会造成两份装配逻辑分叉，
// 而"两处各算一份"正是本项目反复踩过的坑。
import tunables from './tunables.json' with { type: 'json' };
import weaponsTable from './weapons.json' with { type: 'json' };
import combatTable from './combat.json' with { type: 'json' };
import aiTable from './ai.json' with { type: 'json' };
import mapTable from './maps/industrial-01.json' with { type: 'json' };

function fail(msg) {
  throw new Error(`[config] ${msg}`);
}

/**
 * 配置表约定：以 `_` 开头的键是**注释**，不是数据。
 * 凡是要遍历配置对象的代码都必须经过本函数过滤。
 * 这个约定是被自己的校验器抓出来的 —— 首版直接把 hitZones 的 `_comment`
 * 当成一个命中部位，报出"武器缺少部位伤害 _comment"。宁可在启动时报错，
 * 也不要让它悄悄变成一个永远命中不了的"幽灵部位"。
 */
function dataEntries(obj) {
  return Object.entries(obj).filter(([k]) => !k.startsWith('_'));
}

function dataKeys(obj) {
  return Object.keys(obj).filter((k) => !k.startsWith('_'));
}

function assertUnique(rows, key, tableName) {
  const seen = new Set();
  for (const r of rows) {
    if (!r[key]) fail(`${tableName} 存在缺少 ${key} 的行`);
    if (seen.has(r[key])) fail(`${tableName} 中 ${key}="${r[key]}" 重复`);
    seen.add(r[key]);
  }
}

// ---------------------------------------------------------------------------
// 地图表 -> 网格（校验与派生共用同一份构建逻辑，避免两处各算一份）
// ---------------------------------------------------------------------------
function buildMapGrid(map) {
  const W = map.grid.w;
  const H = map.grid.h;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 8 || H < 8) {
    fail(`地图 ${map.id} 的网格尺寸非法：${W}x${H}`);
  }

  const blocked = new Uint8Array(W * H);
  const idx = (x, z) => z * W + x;
  const inBounds = (x, z) => x >= 0 && z >= 0 && x < W && z < H;

  // 最外圈强制为墙（与既有约定一致：玩家不可能走出地图）
  for (let x = 0; x < W; x++) { blocked[idx(x, 0)] = 1; blocked[idx(x, H - 1)] = 1; }
  for (let z = 0; z < H; z++) { blocked[idx(0, z)] = 1; blocked[idx(W - 1, z)] = 1; }

  assertUnique(map.walls, 'id', `map(${map.id}).walls`);
  const wallCells = new Set();
  for (const b of map.walls) {
    if (!(b.w > 0 && b.h > 0)) fail(`墙体 ${b.id} 的尺寸非法`);
    for (let dz = 0; dz < b.h; dz++) {
      for (let dx = 0; dx < b.w; dx++) {
        const x = b.x + dx;
        const z = b.z + dz;
        if (!inBounds(x, z)) fail(`墙体 ${b.id} 越界到 (${x},${z})，网格为 ${W}x${H}`);
        blocked[idx(x, z)] = 1;
        wallCells.add(idx(x, z));
      }
    }
  }

  // 掩体：高度取自 tunables.level.cover（共享规格），本表只给位置与类型
  const coverSpec = tunables.level.cover;
  if (!coverSpec) fail('缺少 tunables.level.cover（掩体高度规格）');
  const coverCm = new Uint8Array(W * H);
  const coverList = [];
  for (const c of map.cover || []) {
    const h = c.type === 'tall' ? coverSpec.tallHeight : coverSpec.lowHeight;
    if (typeof h !== 'number' || !(h > 0)) fail(`掩体类型 ${c.type} 未在 tunables.level.cover 中定义高度`);
    for (let dz = 0; dz < c.h; dz++) {
      for (let dx = 0; dx < c.w; dx++) {
        const x = c.x + dx;
        const z = c.z + dz;
        if (!inBounds(x, z)) fail(`掩体 (${x},${z}) 越界`);
        if (wallCells.has(idx(x, z))) fail(`掩体 (${x},${z}) 与墙体重叠 —— 掩体不该埋进墙里`);
        coverCm[idx(x, z)] = Math.round(h * 100);
        coverList.push({ cell: x, z, height: h, type: c.type });
      }
    }
  }

  return { W, H, blocked, coverCm, coverList, wallCells, idx, inBounds };
}

// ---------------------------------------------------------------------------
// 地图表校验：出生点/撤离点/容器/AI 配额都必须落在可通行且不被掩体占用的格子上
//
// 为什么值得在启动期查：这些是**手写坐标**，手写坐标出错（写进墙里、写出边界）
// 在运行时的表现是"玩家卡住""容器搜不到""AI 刷在墙里"这类难查的现象。
// 让它在启动时带着坐标报错，比事后从现象倒推便宜得多。
// ---------------------------------------------------------------------------
function validateMap(map, grid) {
  const { W, H, blocked, coverCm, idx, inBounds } = grid;

  const mustBeClear = (label, x, z) => {
    if (!inBounds(x, z)) fail(`${label} (${x},${z}) 越界，网格 ${W}x${H}`);
    if (blocked[idx(x, z)]) fail(`${label} (${x},${z}) 落在墙体里`);
    if (coverCm[idx(x, z)] > 0) fail(`${label} (${x},${z}) 落在掩体里 —— 会让玩家/容器卡住`);
  };

  mustBeClear('地图 playerSpawn', map.playerSpawn.x, map.playerSpawn.z);

  const zoneAt = (x, z) =>
    (map.zones || []).find((zn) => x >= zn.x && x < zn.x + zn.w && z >= zn.z && z < zn.z + zn.h) || null;

  assertUnique(map.zones, 'id', `map(${map.id}).zones`);
  assertUnique(map.extracts, 'id', `map(${map.id}).extracts`);
  if (!zoneAt(map.playerSpawn.x, map.playerSpawn.z)) fail('地图 playerSpawn 不在任何分区内');

  for (const e of map.extracts) {
    mustBeClear(`撤离点 ${e.id}`, e.x, e.z);
    if (!(e.radiusCells > 0)) fail(`撤离点 ${e.id} 的 radiusCells 必须为正`);
  }
  const extractCount = map.extracts.length;
  if (extractCount < 2 || extractCount > 4) fail(`撤离点必须为 2~4 个（§2.4），当前 ${extractCount} 个`);
  if (!map.extracts.some((e) => e.conditional)) fail('§2.4 要求区分常驻点与条件点，但没有任何条件点');

  // 容器：只校验**位置合法性**（不落墙里/掩体里/出界、且在分区内）。
  //
  // 「容器数量是否符合策划预算」刻意**不在这里查** —— 运行时不关心策划想要几个箱子，
  // 它只按地图表摆。那条属性属于**内容审核**，由 tools/render-map.mjs 拿地图表与
  // 掉落权重表对照检查（它已经在做）。在这里再存一份预算常量会变成第三处真值，
  // 而"同一份数据存在多处"正是本项目反复踩过的坑。
  for (const c of map.containers) {
    mustBeClear(`容器 ${c.type}`, c.x, c.z);
    if (!zoneAt(c.x, c.z)) fail(`容器 ${c.type} (${c.x},${c.z}) 不在任何分区内`);
  }
  if (!map.containers.length) fail('地图没有任何容器');

  // AI 配额：总和必须等于 ai.json 的 totalCount，否则会静默少刷/多刷
  const aiTotal = (map.aiSpawns || []).reduce((a, s) => a + s.count, 0);
  const wantAi = aiTable.spawnRules.totalCount;
  if (aiTotal !== wantAi) {
    fail(`地图 aiSpawns 配额之和 ${aiTotal} 与 ai.spawnRules.totalCount ${wantAi} 不一致`);
  }
  const zoneIds = new Set((map.zones || []).map((z) => z.id));
  for (const s of map.aiSpawns || []) {
    if (!zoneIds.has(s.zone)) fail(`地图 aiSpawns 引用了不存在的分区 ${s.zone}`);
    if (!(s.count >= 0)) fail(`地图 aiSpawns.${s.zone} 的数量必须为非负`);
  }
}

/**
 * 容器数量预算。
 *
 * 已移除：M3-1 初版在这里存了一份 MAP_CONTAINER_BUDGET 用于启动期比对，
 * 但它与掉落权重表的 containerBudget 重复，构成第三处真值。
 * 「数量是否符合策划预算」是内容审核属性，由 tools/render-map.mjs 检查
 * （它同时读地图表与掉落权重表）；运行时只需要位置合法。
 */

function validate() {
  const { weapons, ammo, startLoadout } = weaponsTable;
  const { armor, armorRules, hitZones, consumables, playerVitals } = combatTable;
  const { tiers } = aiTable;

  assertUnique(weapons, 'id', 'weapons');
  assertUnique(ammo, 'id', 'ammo');
  assertUnique(armor, 'id', 'armor');
  assertUnique(tiers, 'id', 'ai.tiers');
  assertUnique(consumables, 'id', 'consumables');

  // 引用完整性：武器的弹药类型必须存在
  const ammoIds = new Set(ammo.map((a) => a.id));
  const zoneNames = dataKeys(hitZones);
  for (const w of weapons) {
    if (!ammoIds.has(w.ammoType)) fail(`武器 ${w.id} 引用了不存在的弹药 ${w.ammoType}`);
    if (!w.damage) fail(`武器 ${w.id} 缺少 damage`);
    for (const zone of zoneNames) {
      if (typeof w.damage[zone] !== 'number') fail(`武器 ${w.id} 缺少部位伤害 ${zone}`);
    }
    if (!w.recoil || !Array.isArray(w.recoil.pattern) || w.recoil.pattern.length === 0) {
      fail(`武器 ${w.id} 缺少后坐力图案`);
    }
    for (const [i, e] of w.recoil.pattern.entries()) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'number' || typeof e[1] !== 'number') {
        fail(`武器 ${w.id} 后坐力图案第 ${i} 项必须是 [yawDeg, pitchDeg]`);
      }
    }
    if (!(w.spreadRecoveryPerSec > 0)) fail(`武器 ${w.id} 必须定义正数的扩散恢复速率`);
    if (!(w.adsMs > 0)) fail(`武器 ${w.id} 必须定义开镜时间`);
    if (w.adsSpreadDeg > w.hipSpreadDeg) fail(`武器 ${w.id} 的开镜扩散不应大于腰射扩散`);
    if (!(w.fireIntervalMs > 0)) fail(`武器 ${w.id} 射击间隔必须为正`);
  }

  // 引用完整性：开局配装的武器与弹药必须存在
  const weaponIds = new Set(weapons.map((w) => w.id));
  for (const slot of ['primary', 'secondary']) {
    if (!weaponIds.has(startLoadout[slot])) {
      fail(`startLoadout.${slot} 引用了不存在的武器 ${startLoadout[slot]}`);
    }
  }
  for (const [ammoId, count] of Object.entries(startLoadout.reserveByAmmo)) {
    if (!ammoIds.has(ammoId)) fail(`startLoadout.reserveByAmmo 引用了不存在的弹药 ${ammoId}`);
    if (!(count >= 0)) fail(`startLoadout.reserveByAmmo.${ammoId} 必须为非负数`);
  }

  // 引用完整性：护甲覆盖的部位名必须存在于 hitZones
  const zoneSet = new Set(zoneNames);
  for (const a of armor) {
    for (const c of a.covers) {
      if (!zoneSet.has(c)) fail(`护甲 ${a.id} 覆盖了不存在的部位 ${c}`);
    }
    if (a.class > 0 && !(a.durability > 0)) fail(`护甲 ${a.id} 为非零等级但耐久不为正`);
  }

  // 引用完整性：玩家初始护甲必须存在
  const armorIds = new Set(armor.map((a) => a.id));
  for (const [slot, id] of dataEntries(playerVitals.startArmor)) {
    if (!armorIds.has(id)) fail(`playerVitals.startArmor.${slot} 引用了不存在的护甲 ${id}`);
  }

  // AI 难度分级的引用与取值
  for (const t of tiers) {
    for (const slot of dataKeys(playerVitals.startArmor)) {
      if (t.armor && t.armor[slot] && !armorIds.has(t.armor[slot])) {
        fail(`AI ${t.id} 引用了不存在的护甲 ${t.armor[slot]}`);
      }
    }
    if (!(t.maxHealth > 0)) fail(`AI ${t.id} 生命值必须为正`);
    if (!(t.viewRange > 0)) fail(`AI ${t.id} 视野距离必须为正`);
  }

  // 更新分级必须按距离升序，且最后一项必须覆盖关卡的几何最大距离。
  // 这里刻意不用"1e6 之类拍脑袋的阈值"，而是从**地图表**算出真实最大距离 ——
  // 否则规则看起来在检查什么，其实只是检查了作者有没有写一个很大的数。
  const levelDiagonalM = Math.hypot(mapTable.grid.w * mapTable.grid.cell, mapTable.grid.h * mapTable.grid.cell);
  const upd = aiTable.updateTiers;
  for (let i = 1; i < upd.length; i++) {
    if (upd[i].maxDistanceM <= upd[i - 1].maxDistanceM) {
      fail('ai.updateTiers 必须按 maxDistanceM 严格升序');
    }
  }
  if (upd[upd.length - 1].maxDistanceM < levelDiagonalM) {
    fail(
      `ai.updateTiers 最后一项 maxDistanceM=${upd[upd.length - 1].maxDistanceM} ` +
        `小于地图几何最大距离 ${levelDiagonalM.toFixed(1)}m —— 会有 AI 落不进任何分级`
    );
  }

  // M0-TECH-01 约束 C-1/C-2：寻路预算必须存在且为有限正数
  const pb = aiTable.pathBudget;
  if (!(pb.maxQueriesPerFrame > 0)) fail('ai.pathBudget.maxQueriesPerFrame 必须为正（C-1 要求寻路限流）');
  if (!(pb.maxMsPerFrame > 0) || pb.maxMsPerFrame > 4) {
    fail('ai.pathBudget.maxMsPerFrame 必须为 (0, 4] 区间（C-2 要求单帧寻路上限约 2ms）');
  }

  // 生命值只能有一个来源，避免两处各写一份
  if (typeof tunables.player.maxHealth === 'number') {
    fail('player.maxHealth 与 combat.playerVitals.maxHealth 重复定义，请只保留后者');
  }

  // 地图表：构建网格 + 校验 + 派生
  const grid = buildMapGrid(mapTable);
  validateMap(mapTable, grid);
}

validate();

// ---------------------------------------------------------------------------
// 地图表的派生视图
//
// 下游模块（player / extract / loot / aiManager / main）原本读的是 tunables 里的
// level.playerSpawnCell / extract.zones / loot.containerCells。这些字段现在由地图表
// 派生出来，因此**下游一行都不用改**，而数据的唯一来源变成了地图表。
// ---------------------------------------------------------------------------
const mapGrid = buildMapGrid(mapTable);
const CELL = mapTable.grid.cell;

export const map = mapTable;

/** 地图派生：把格坐标换算成运行时需要的形状 */
const derivedExtractZones = mapTable.extracts.map((e) => ({
  id: e.id,
  label: e.label,
  cell: [e.x, e.z],
  radius: e.radiusCells * CELL,
  conditional: !!e.conditional,
}));

export const config = {
  ...tunables,
  map: mapTable,
  weapons: weaponsTable.weapons,
  ammo: weaponsTable.ammo,
  startLoadout: weaponsTable.startLoadout,
  designTargets: weaponsTable._designTargets,
  armor: combatTable.armor,
  armorRules: combatTable.armorRules,
  hitZones: combatTable.hitZones,
  /** 命中部位名数组（已过滤注释键），供遍历使用 */
  hitZoneNames: dataKeys(combatTable.hitZones),
  consumables: combatTable.consumables,
  playerVitals: combatTable.playerVitals,
  aiTiers: aiTable.tiers,
  aiSpawn: aiTable.spawnRules,
  aiUpdateTiers: aiTable.updateTiers,
  aiPathBudget: aiTable.pathBudget,
  aiPerception: aiTable.perception,
  aiCombat: aiTable.combat,

  // 由地图表派生的既有字段（覆盖 tunables 中的同名项，保证只有一处真值）
  level: {
    ...tunables.level,
    gridW: mapTable.grid.w,
    gridH: mapTable.grid.h,
    cell: mapTable.grid.cell,
    wallHeight: mapTable.grid.wallHeight,
    playerSpawnCell: [mapTable.playerSpawn.x, mapTable.playerSpawn.z],
  },
  extract: {
    ...tunables.extract,
    zones: derivedExtractZones,
  },
  loot: {
    ...tunables.loot,
    containerCells: mapTable.containers.map((c) => [c.x, c.z]),
  },
  /** 掩体的实际格子（校验后的结果，含高度与类型） */
  coverList: mapGrid.coverList,
};

export function weaponById(id) {
  const w = config.weapons.find((x) => x.id === id);
  if (!w) throw new Error(`[config] 未知武器 ${id}`);
  return w;
}

export function ammoById(id) {
  const a = config.ammo.find((x) => x.id === id);
  if (!a) throw new Error(`[config] 未知弹药 ${id}`);
  return a;
}

export function armorById(id) {
  const a = config.armor.find((x) => x.id === id);
  if (!a) throw new Error(`[config] 未知护甲 ${id}`);
  return a;
}

export function aiTierById(id) {
  const t = config.aiTiers.find((x) => x.id === id);
  if (!t) throw new Error(`[config] 未知 AI 分级 ${id}`);
  return t;
}
