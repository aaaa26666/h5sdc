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
//   loot.containers），这样下游模块（player / extract / loot / main）零改动。
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
import mapTableIndustrial from './maps/industrial-01.json' with { type: 'json' };
import mapTableTvStation from './maps/tv-station-01.json' with { type: 'json' };
// M3-3 ~ M3-6 的运行时真值。此前它放在 docs/07-loot-tables.json，
// 只有 tools 读得到，src 里根本没有引用 —— 于是"89 个容器共用一套权重"。
// 与地图表的处理一致：迁入 src/config 作为**唯一真值**，docs 下的旧副本删除，
// 避免两份数据各自演化（地图表当年就是这么迁的）。
import lootTable from './loot.json' with { type: 'json' };
// M5-3 ~ M5-6 的运行时真值。沿用 loot.json 的迁入方式：唯一真值放 src/config，
// 派生视图由本文件产出，下游（player / weapon / briefing / main）读派生视图即可，
// 因此「配装只有一份真值」不需要下游配合改动。
import equipmentTable from './equipment.json' with { type: 'json' };
import economyTable from './economy.json' with { type: 'json' };
import progressionTable from './progression.json' with { type: 'json' };
import questsTable from './quests.json' with { type: 'json' };
// M6：携行具表（背包 / 弹挂）。它们决定局内能装多少，因此是装备而不是装饰。
import carryTable from './carry.json' with { type: 'json' };
import { OPEN_RULE, resolveMs } from '../core/extractRules.js';
import { resolveBackpack } from '../core/lootTable.js';
// M5-5：效果类型白名单与倍率聚合。它必须是纯函数模块（不反过来 import 本文件），
// 校验器才能安全地"用同一份实现"验证配置 —— 否则就成了两处各算一次。
import { skillModifiers, CONSUMED_MODIFIERS } from '../core/progression.js';
// M6：携行具的网格投放算法（纯函数）。启动期要用**同一个**实现断言
// "起始配装一定塞得进兜底背包" —— 各写一份就会出现"校验说塞得下、进局却掉东西"。
import { carrySpecs, carryUsedSlots, sanitizeCarry } from '../core/carry.js';

function fail(msg) {
  throw new Error(`[config] ${msg}`);
}

// ---------------------------------------------------------------------------
// 地图注册表与"当前生效地图"（M3-1b-2 ④）
//
// 从"只有一张地图"改为"可注册多张 + 由 `tunables.level.activeMap` 选择"。
// 为什么不是直接把 industrial-01 改造成两层：单层地图的几何黄金基准
// （results/level-golden-industrial_01.json，92012 条采样）需要一个稳定的对照物 ——
// 它正是"分层改造没有把单层行为改坏"的证据。旧图留着，新图并存，
// 黄金基准工具用 `--map <id>` 显式指定要验证哪一张。
// ---------------------------------------------------------------------------
const MAP_TABLES = {
  industrial_01: mapTableIndustrial,
  tv_station_01: mapTableTvStation,
};
const activeMapId = tunables.level.activeMap || 'industrial_01';
const mapTable = MAP_TABLES[activeMapId];
if (!mapTable) {
  fail(
    `tunables.level.activeMap="${activeMapId}" 没有对应的地图表` +
      `（已注册：${Object.keys(MAP_TABLES).join('、')}）`
  );
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
//
// M3-1b-2 ④：地图表支持**分层**（floors / slabs / ramps，以及 walls/cover 的
// floor 字段）。缺省时 floors = [{id:0, baseY:0}] —— 也就是原来的单层地图，
// 现有表一字不用改（这一点由"单层地图的派生结果不变"这条断言守着）。
//
// 这里刻意只做**纯数据**校验：坐标、层号、矩形是否越界、楼板与墙是否重叠。
// "可走性"属于几何，由 level.js 在构建跨度表时断言 —— 两份代码各管一段，
// 避免同一个判据在两处各算一份然后慢慢分叉（本项目反复踩过的坑）。
// ---------------------------------------------------------------------------
const RAMP_DIRS = ['+x', '-x', '+z', '-z'];

function buildMapGrid(map) {
  const W = map.grid.w;
  const H = map.grid.h;
  if (!Number.isInteger(W) || !Number.isInteger(H) || W < 8 || H < 8) {
    fail(`地图 ${map.id} 的网格尺寸非法：${W}x${H}`);
  }

  const idx = (x, z) => z * W + x;
  const inBounds = (x, z) => x >= 0 && z >= 0 && x < W && z < H;

  // ---- 层 ----
  const floors = map.floors || [{ id: 0, baseY: 0 }];
  if (!Array.isArray(floors) || floors.length === 0) fail(`地图 ${map.id} 的 floors 必须是非空数组`);
  for (let i = 0; i < floors.length; i++) {
    if (typeof floors[i].baseY !== 'number') fail(`floors[${i}] 缺少数值 baseY`);
    if (i > 0 && !(floors[i].baseY > floors[i - 1].baseY)) {
      fail(
        `floors 的 baseY 必须严格升序（floors[${i}]=${floors[i].baseY} 不大于 ${floors[i - 1].baseY}）`
      );
    }
  }
  const floorCount = floors.length;
  const baseYOf = (f) => floors[f || 0].baseY;
  const wallHeight = map.grid.wallHeight;
  const slabThickness = map.slabThickness ?? 0.3;
  if (!(slabThickness > 0)) fail('slabThickness 必须为正');

  const useFloor = (label, f) => {
    const v = f || 0;
    if (!Number.isInteger(v) || v < 0 || v >= floorCount) {
      fail(`${label} 的 floor=${f} 非法（地图共 ${floorCount} 层）`);
    }
    return v;
  };

  const wallCells = Array.from({ length: floorCount }, () => new Set());
  const coverCells = Array.from({ length: floorCount }, () => new Set());
  const slabCells = Array.from({ length: floorCount }, () => new Set());
  const rampCells = Array.from({ length: floorCount }, () => new Set());
  // 斜坡的**坡顶**格：它同时是上一层地面的一部分（level.js 的分层寻路用的是同一判据）
  const rampTopCells = Array.from({ length: floorCount }, () => new Set());
  const coverCmByFloor = Array.from({ length: floorCount }, () => new Uint16Array(W * H));

  // 最外圈强制为墙（每层都有，与既有约定一致：玩家不可能走出地图）
  for (let f = 0; f < floorCount; f++) {
    for (let x = 0; x < W; x++) {
      wallCells[f].add(idx(x, 0));
      wallCells[f].add(idx(x, H - 1));
    }
    for (let z = 0; z < H; z++) {
      wallCells[f].add(idx(0, z));
      wallCells[f].add(idx(W - 1, z));
    }
  }

  assertUnique(map.walls, 'id', `map(${map.id}).walls`);
  for (const b of map.walls) {
    const f = useFloor(`墙体 ${b.id}`, b.floor);
    if (!(b.w > 0 && b.h > 0)) fail(`墙体 ${b.id} 的尺寸非法`);
    for (let dz = 0; dz < b.h; dz++) {
      for (let dx = 0; dx < b.w; dx++) {
        const x = b.x + dx;
        const z = b.z + dz;
        if (!inBounds(x, z)) fail(`墙体 ${b.id} 越界到 (${x},${z})，网格为 ${W}x${H}`);
        wallCells[f].add(idx(x, z));
      }
    }
  }

  // 掩体：高度取自 tunables.level.cover（共享规格），本表只给位置、类型与层
  const coverSpec = tunables.level.cover;
  if (!coverSpec) fail('缺少 tunables.level.cover（掩体高度规格）');
  const coverList = [];
  for (const c of map.cover || []) {
    const f = useFloor('掩体', c.floor);
    const h = c.type === 'tall' ? coverSpec.tallHeight : coverSpec.lowHeight;
    if (typeof h !== 'number' || !(h > 0)) fail(`掩体类型 ${c.type} 未在 tunables.level.cover 中定义高度`);
    for (let dz = 0; dz < c.h; dz++) {
      for (let dx = 0; dx < c.w; dx++) {
        const x = c.x + dx;
        const z = c.z + dz;
        if (!inBounds(x, z)) fail(`掩体 (${x},${z}) 越界`);
        if (wallCells[f].has(idx(x, z))) {
          fail(`第 ${f} 层的掩体 (${x},${z}) 与墙体重叠 —— 掩体不该埋进墙里`);
        }
        coverCells[f].add(idx(x, z));
        coverCmByFloor[f][idx(x, z)] = Math.round((baseYOf(f) + h) * 100);
        coverList.push({ cell: x, z, height: h, type: c.type, floor: f });
      }
    }
  }

  // 楼板（第 f 层的地面）
  for (const s of map.slabs || []) {
    const f = useFloor('楼板', s.floor);
    if (f === 0) fail('楼板不能放在第 0 层 —— 地面本来就存在，不需要铺');
    if (!(s.w > 0 && s.h > 0)) fail(`楼板 (${s.x},${s.z}) 的尺寸非法`);
    for (let dz = 0; dz < s.h; dz++) {
      for (let dx = 0; dx < s.w; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        if (!inBounds(x, z)) fail(`楼板 (${x},${z}) 越界`);
        slabCells[f].add(idx(x, z));
      }
    }
  }

  // 楼梯
  for (const r of map.ramps || []) {
    const f = useFloor('楼梯', r.floor);
    if (f + 1 >= floorCount) fail(`楼梯 (${r.x},${r.z}) 在第 ${f} 层，但没有上一层可去`);
    if (!RAMP_DIRS.includes(r.dir)) {
      fail(`楼梯 (${r.x},${r.z}) 的 dir="${r.dir}" 非法（应为 +x/-x/+z/-z）`);
    }
    const alongX = r.dir === '+x' || r.dir === '-x';
    const along = alongX ? r.w : r.h;
    if (!(along >= 1)) fail(`楼梯 (${r.x},${r.z}) 沿 ${r.dir} 方向长度为 0`);
    for (let k = 0; k < along; k++) {
      const off = r.dir === '+x' || r.dir === '+z' ? k : along - 1 - k;
      const x = alongX ? r.x + off : r.x;
      const z = alongX ? r.z : r.z + off;
      if (!inBounds(x, z)) fail(`楼梯 (${r.x},${r.z}) 越界到 (${x},${z})`);
      rampCells[f].add(idx(x, z));
      if (k === along - 1) rampTopCells[f + 1].add(idx(x, z));
    }
  }

  // ★ M3-1b-2 ④（第二轮）："楼板压墙"从**报错**改为**允许**。
  //
  // 原判据是"第 f 层楼板与第 g 层墙不得重叠"。它在几何上确实重叠
  //（一层墙 [0,3.5] 与该格二层楼板 [3.3,3.6]），但由此推出的结论是错的：
  // 我原本据此让**一层墙格在二层不铺楼板**，结果二层地面到处是一格宽的沟，
  // 二层也没法有自己的隔墙（一加墙就正好压在那些 1 格宽的"桥"上，把二层切断）。
  //
  // 正确做法是让几何模型接受它：重叠的两条跨度合并成一条贯通实体
  //（[0,3.6]，kind 取更实心的 WALL），而"这一层有没有地板"改由**顶面高度**判定。
  // 这样一层墙顶照样是二层的楼面，二层是一个完整平面，两层可以各有一套隔墙。
  // 合并与判定的实现见 src/level/level.js 的跨度合并与 nav 构建。

  // 兼容视图：第 0 层的 blocked / coverCm。下游（loot / extract / main）读的是它，
  // 单层地图下这两个数组与改造前逐字节相同。
  const blocked = new Uint8Array(W * H);
  const coverCm = new Uint16Array(W * H);
  for (const i of wallCells[0]) blocked[i] = 1;
  coverCm.set(coverCmByFloor[0]);

  return {
    W, H, blocked, coverCm, coverList, wallCells: wallCells[0], idx, inBounds,
    floors, floorCount, baseYOf, slabThickness,
    wallCellsByFloor: wallCells,
    coverCellsByFloor: coverCells,
    slabCellsByFloor: slabCells,
    rampCellsByFloor: rampCells,
    rampTopCellsByFloor: rampTopCells,
  };
}

// ---------------------------------------------------------------------------
// 地图表校验：出生点/撤离点/容器/AI 配额都必须落在可通行且不被掩体占用的格子上
//
// 为什么值得在启动期查：这些是**手写坐标**，手写坐标出错（写进墙里、写出边界）
// 在运行时的表现是"玩家卡住""容器搜不到""AI 刷在墙里"这类难查的现象。
// 让它在启动时带着坐标报错，比事后从现象倒推便宜得多。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// M4-1 撤离点开放规则的结构校验
//
// 为什么在**启动期**校验而不是等玩家跑到撤离点才发现：
//   规则写错（类型拼错、只给了 from 没给 to、窗口 to <= from）的运行时表现
//   是"这个点怎么都开不了"或"这个点永远开着"，现场很难反推是哪张表哪一行写错了。
//   启动即报错可以直接指出是哪个撤离点的哪个字段。
//
// 另一条重要的是**一致性**：地图表原本有 `conditional: true/false` 这个标记，
// 而 M4-1 引入了 openRule。两者表达同一件事却可能各说各话 ——
// 那正是本项目反复踩过的"两份真值分叉"。因此这里强制二者一致。
// ---------------------------------------------------------------------------
function validateOpenRule(e) {
  const r = e.openRule;
  const tag = `撤离点 ${e.id} 的 openRule`;
  const type = r && r.type ? r.type : OPEN_RULE.ALWAYS;
  const isConditional = type !== OPEN_RULE.ALWAYS;

  if (!!e.conditional !== isConditional) {
    fail(
      `${tag} 与 conditional 标记不一致：` +
        `规则类型是 ${type}（= ${isConditional ? '条件点' : '常驻点'}），但 conditional=${!!e.conditional}`
    );
  }
  if (type === OPEN_RULE.ALWAYS) return;

  const legal = Object.values(OPEN_RULE);
  if (!legal.includes(type)) {
    fail(`${tag} 的类型 "${r.type}" 不是合法规则（可用：${legal.join(' / ')}）`);
  }

  const hasPair = (ms, fr) => (typeof ms === 'number' && ms >= 0) || (typeof fr === 'number' && fr >= 0);
  const checkFrac = (fr, name) => {
    if (typeof fr !== 'number') return;
    if (fr < 0 || fr > 1) fail(`${tag}.${name} = ${fr} 超出 [0, 1]（它是相对单局时限的比例）`);
  };

  if (type === OPEN_RULE.TIME_AFTER) {
    if (!hasPair(r.afterMs, r.afterFraction)) {
      fail(`${tag}（timeAfter）必须给出 afterMs 或 afterFraction，否则门槛是 0 —— 等于常驻点`);
    }
    checkFrac(r.afterFraction, 'afterFraction');
    return;
  }

  if (type === OPEN_RULE.KILLS_AFTER) {
    if (typeof r.kills !== 'number' || !Number.isInteger(r.kills) || !(r.kills > 0)) {
      fail(`${tag}（killsAfter）的 kills 必须是正整数，当前 ${r.kills}`);
    }
    return;
  }

  // timeWindow
  if (!hasPair(r.fromMs, r.fromFraction)) fail(`${tag}（timeWindow）必须给出 fromMs 或 fromFraction`);
  if (!hasPair(r.toMs, r.toFraction)) fail(`${tag}（timeWindow）必须给出 toMs 或 toFraction`);
  checkFrac(r.fromFraction, 'fromFraction');
  checkFrac(r.toFraction, 'toFraction');

  const limit = tunables.raid ? tunables.raid.timeLimitMs : 0;
  const from = resolveMs(r.fromMs, r.fromFraction, limit);
  const to = resolveMs(r.toMs, r.toFraction, limit);
  if (from !== null && to !== null && !(to > from)) {
    fail(`${tag}（timeWindow）的窗口无效：from=${from}ms 必须小于 to=${to}ms`);
  }
}

// ---------------------------------------------------------------------------
// M4-2 撤离倒计时中断规则的校验
//
// 与撤离点开放规则同理：这些数值决定"中断会不会发生、中断后还剩多少"，
// 写错了的运行时表现是"撤离永远重置"或"永远重置不了"，很难反推。
// 而且它们必须**显式存在** —— 缺失时不能悄悄退化成"永不中断"，
// 那等于用一个默认值替策划做了决定。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// M4-5 单局时限与超时告警阈值
//
// 告警阈值此前写死在 hud.js（30000），是典型的魔法数字 ——
// 改它必须改代码，而它明明是个策划数值。搬到表之后仍要校验，
// 免得填出一个"比单局时限还长"的阈值（那样告警永远不触发，且没人会发现）。
// ---------------------------------------------------------------------------
function validateRaidTiming() {
  const raid = tunables.raid || {};
  if (!(raid.timeLimitMs > 0)) fail(`tunables.raid.timeLimitMs 必须为正，当前 ${raid.timeLimitMs}`);
  if (typeof raid.warningThresholdMs !== 'number' || raid.warningThresholdMs < 0) {
    fail(`tunables.raid.warningThresholdMs 必须为非负数字，当前 ${raid.warningThresholdMs}`);
  }
  if (raid.warningThresholdMs > raid.timeLimitMs) {
    fail(
      `超时告警阈值 ${raid.warningThresholdMs}ms 超过单局时限 ${raid.timeLimitMs}ms ` +
        '—— 那样告警永远不会触发'
    );
  }
}

/**
 * M5-1：本机偏好设置表的结构校验。
 *
 * 为什么设置项也要走启动期校验：档位表与 schema 是**两张会各自演化的表** ——
 * 例如给 mouseSens 加一个 "insane" 档却忘了在 mouseSensLevels 里配倍率，
 * 症状是"玩家选了这一档但灵敏度没变"，肉眼极难发现。在启动期把它变成一行报错。
 */
function validateSettings() {
  const S = tunables.settings;
  if (!S || typeof S !== 'object') fail('缺少 tunables.settings（M5-1 起本机偏好设置的唯一真值）');
  if (!S.schema || typeof S.schema !== 'object') fail('缺少 tunables.settings.schema');

  // 档位表：schema 里声明了 levelsKey 的项，必须逐档配倍率。
  // ★ M5-8：原来这里硬编码 { mouseSens: S.mouseSensLevels, masterVolume: S.volumeLevels }，
  //   于是"加一个带倍率的设置项"必须同时改代码与表两处。现在映射由表里的 levelsKey 声明。
  const levelTableNames = dataKeys(S).filter((k) => k.endsWith('Levels'));

  for (const [key, spec] of dataEntries(S.schema)) {
    const type = spec.type || 'enum';

    if (type === 'keymap') {
      // 键位映射（bindings）：合法性与冲突由 core/keybinds.js 的 sanitizeBindings 负责
      // （它同时是运行时与审计工具用的那一份实现）。这里只要求默认值是空对象：
      // 空对象 = "全部用默认键位"，是唯一不会与 DEFAULT_BINDINGS 分叉的表达。
      if (!spec.default || typeof spec.default !== 'object' || Array.isArray(spec.default)) {
        fail(`settings.schema.${key} 是 keymap，default 必须是对象（空对象表示全部用默认键位）`);
      }
      if (Object.keys(spec.default).length !== 0) {
        fail(`settings.schema.${key} 的 default 必须为空对象 —— 默认键位的唯一真值是 core/keybinds.js`);
      }
      continue;
    }
    if (type !== 'enum') fail(`settings.schema.${key} 的 type "${type}" 未知（可用：enum / keymap）`);

    if (!Array.isArray(spec.values) || spec.values.length === 0) {
      fail(`settings.schema.${key} 缺少非空的 values`);
    }
    assertUnique(spec.values.map((v) => ({ v })), 'v', `settings.schema.${key}.values`);
    if (!spec.values.includes(spec.default)) {
      fail(`settings.schema.${key}.default="${spec.default}" 不在合法取值内（${spec.values.join('/')}）`);
    }
    if (!spec.levelsKey) {
      // tableKey：值不是"倍率"而是"一张参数对象"（画质档位用）。
      // 校验器要保证它覆盖了 schema 的每一个档位，且没有多余的档位 ——
      // "表里少一个档位"的表现是"切到这一档时画面参数变成 undefined"，极难从现象倒推。
      if (spec.tableKey) {
        const table = S[spec.tableKey];
        if (!table || typeof table !== 'object') {
          fail(`settings.schema.${key} 的 tableKey="${spec.tableKey}" 在 settings 里不存在`);
        }
        for (const v of spec.values) {
          if (table[v] === undefined) fail(`settings.${spec.tableKey} 缺少档位 "${v}"`);
        }
        for (const k of dataKeys(table)) {
          if (!spec.values.includes(k)) {
            fail(`settings.${spec.tableKey} 有未知档位 "${k}"（schema 合法取值为 ${spec.values.join('/')}）`);
          }
        }
      }
      continue;
    }
    if (!levelTableNames.includes(spec.levelsKey)) {
      fail(`settings.schema.${key} 的 levelsKey="${spec.levelsKey}" 在 settings 里不存在`);
    }
    const levels = S[spec.levelsKey];
    for (const v of spec.values) {
      const mul = levels[v];
      if (typeof mul !== 'number' || !(mul >= 0)) {
        fail(`settings.${spec.levelsKey} 的档位 "${v}" 没有合法数值（当前 ${mul}）`);
      }
    }
    for (const k of dataKeys(levels)) {
      if (!spec.values.includes(k)) {
        fail(`settings.${spec.levelsKey} 里有未知档位 "${k}"（schema 合法取值为 ${spec.values.join('/')}）`);
      }
    }
  }

  if (!(tunables.audio && typeof tunables.audio.masterGain === 'number' && tunables.audio.masterGain >= 0)) {
    fail('tunables.audio.masterGain 必须为非负数字（混音总线基础增益）');
  }

  // 画质表逐档校验（它走 tableKey 而不是 levelsKey，因此上面那段不检查它的字段）
  for (const [tier, q] of dataEntries(S.qualityTable)) {
    if (typeof q.shadows !== 'boolean') fail(`settings.qualityTable.${tier}.shadows 必须是布尔值`);
    if (!Number.isInteger(q.shadowMapSize) || q.shadowMapSize < 0) {
      fail(`settings.qualityTable.${tier}.shadowMapSize 必须为非负整数`);
    }
    if (!(q.pixelRatioMax > 0)) fail(`settings.qualityTable.${tier}.pixelRatioMax 必须为正`);
    if (q.shadows && q.shadowMapSize <= 0) {
      fail(`settings.qualityTable.${tier} 开了阴影却没给阴影贴图尺寸`);
    }
    if (!q.shadows && q.shadowMapSize !== 0) {
      fail(`settings.qualityTable.${tier} 关了阴影却给了尺寸 ${q.shadowMapSize} —— 那是个没人读的字段`);
    }
  }
}

function validateExtractInterrupt() {
  const ex = tunables.extract || {};
  if (!(ex.countdownMs > 0)) fail(`tunables.extract.countdownMs 必须为正，当前 ${ex.countdownMs}`);
  const it = ex.interrupt;
  if (!it) fail('tunables.extract.interrupt 缺失：撤离倒计时的中断规则必须有显式配置（M4-2）');
  if (typeof it.leaveGraceMs !== 'number' || it.leaveGraceMs < 0) {
    fail(`tunables.extract.interrupt.leaveGraceMs 必须为非负数字，当前 ${it.leaveGraceMs}`);
  }
  if (typeof it.keepFraction !== 'number' || it.keepFraction < 0 || it.keepFraction > 1) {
    fail(`tunables.extract.interrupt.keepFraction 必须落在 [0, 1]，当前 ${it.keepFraction}`);
  }
}

function validateMap(map, grid) {
  const { W, H, idx, inBounds } = grid;

  /**
   * 某位置在该层能不能放东西（出生点 / 容器 / 撤离点）。
   *
   * M3-1b-2 ④ 加了 floor 参数。第 0 层以外**还必须有落脚面**
   * （楼板或楼梯坡顶格）—— 否则那个容器会悬在半空，玩家走过去直接掉下去。
   * 这一条是手写两层坐标时最容易犯、也最难从现象倒推的错误。
   */
  const mustBeClear = (label, x, z, floor) => {
    const f = floor || 0;
    if (!inBounds(x, z)) fail(`${label} (${x},${z}) 越界，网格 ${W}x${H}`);
    if (grid.wallCellsByFloor[f].has(idx(x, z))) fail(`${label} (${x},${z}) 在第 ${f} 层落在墙体里`);
    if (grid.coverCellsByFloor[f].has(idx(x, z))) {
      fail(`${label} (${x},${z}) 在第 ${f} 层落在掩体里 —— 会让玩家/容器卡住`);
    }
    if (
      f > 0 &&
      !grid.slabCellsByFloor[f].has(idx(x, z)) &&
      !grid.rampTopCellsByFloor[f].has(idx(x, z))
    ) {
      fail(`${label} (${x},${z}) 在第 ${f} 层是**悬空**的（该格既没有楼板，也不是楼梯坡顶）`);
    }
  };

  mustBeClear('地图 playerSpawn', map.playerSpawn.x, map.playerSpawn.z, map.playerSpawn.floor);

  // 分区：M3-1b-2 ④ 起带 floor（缺省 0）。两层地图里不同层的分区必须用不同 id，
  // 否则 aiSpawns 的引用分不清是哪一层。
  const zoneAt = (x, z, f) =>
    (map.zones || []).find(
      (zn) =>
        (zn.floor || 0) === (f || 0) &&
        x >= zn.x &&
        x < zn.x + zn.w &&
        z >= zn.z &&
        z < zn.z + zn.h
    ) || null;

  assertUnique(map.zones, 'id', `map(${map.id}).zones`);
  assertUnique(map.extracts, 'id', `map(${map.id}).extracts`);
  const spawnFloor = map.playerSpawn.floor || 0;
  if (!zoneAt(map.playerSpawn.x, map.playerSpawn.z, spawnFloor)) {
    fail(
      `地图 playerSpawn (${map.playerSpawn.x},${map.playerSpawn.z}) ` +
        `不在第 ${spawnFloor} 层的任何分区内`
    );
  }

  for (const e of map.extracts) {
    mustBeClear(`撤离点 ${e.id}`, e.x, e.z, e.floor);
    if (!(e.radiusCells > 0)) fail(`撤离点 ${e.id} 的 radiusCells 必须为正`);
    validateOpenRule(e);
  }
  const extractCount = map.extracts.length;
  if (extractCount < 2 || extractCount > 4) fail(`撤离点必须为 2~4 个（§2.4），当前 ${extractCount} 个`);
  if (!map.extracts.some((e) => e.conditional)) fail('§2.4 要求区分常驻点与条件点，但没有任何条件点');

  // M3-1b-2 ④：撤离点必须**分布在不止一层**。
  // 否则二层只有风险没有回报出口，玩家上二层就只剩"下去一条路"——
  // 那正是方案 §10.6 要求"至少一个撤离点在二层"的原因。
  if (grid.floorCount > 1) {
    const extractFloors = new Set(map.extracts.map((e) => e.floor || 0));
    if (extractFloors.size < 2) {
      fail(`两层地图的撤离点必须分布在不止一层（当前只有第 ${[...extractFloors].join('/')} 层）`);
    }
  }

  // 容器：只校验**位置合法性**（不落墙里/掩体里/出界、不悬空、且在分区内）。
  //
  // 「容器数量是否符合策划预算」刻意**不在这里查** —— 运行时不关心策划想要几个箱子，
  // 它只按地图表摆。那条属性属于**内容审核**，由 tools/render-map.mjs 拿地图表与
  // 掉落权重表对照检查（它已经在做）。在这里再存一份预算常量会变成第三处真值，
  // 而"同一份数据存在多处"正是本项目反复踩过的坑。
  for (const c of map.containers) {
    mustBeClear(`容器 ${c.type}`, c.x, c.z, c.floor);
    if (!zoneAt(c.x, c.z, c.floor || 0)) {
      fail(`容器 ${c.type} (${c.x},${c.z}) 不在第 ${c.floor || 0} 层的任何分区内`);
    }
  }
  if (!map.containers.length) fail('地图没有任何容器');

  // AI 配额：总和必须等于 ai.json 的 totalCount，否则会静默少刷/多刷
  const aiTotal = (map.aiSpawns || []).reduce((a, s) => a + s.count, 0);
  const wantAi = aiTable.spawnRules.totalCount;
  if (aiTotal !== wantAi) {
    fail(`地图 aiSpawns 配额之和 ${aiTotal} 与 ai.spawnRules.totalCount ${wantAi} 不一致`);
  }
  const zoneIds = new Set((map.zones || []).map((z) => z.id));
  const zoneById = new Map((map.zones || []).map((z) => [z.id, z]));
  const floorCount = (map.floors || []).length || 1;
  const tierIds = new Set(aiTable.tiers.map((t) => t.id));
  for (const s of map.aiSpawns || []) {
    if (!zoneIds.has(s.zone)) fail(`地图 aiSpawns 引用了不存在的分区 ${s.zone}`);
    if (!(s.count >= 0)) fail(`地图 aiSpawns.${s.zone} 的数量必须为非负`);
    // [M6-2] 出生层：必须存在，且**必须与该分区自身的层号一致**。
    //   不一致是最隐蔽的一类错误：配置写 floor=1、分区其实在一层，
    //   运行时按层取格会取到"第 1 层的另一处"，AI 就刷在玩家意想不到的地方。
    const zf = zoneById.get(s.zone).floor || 0;
    const sf = s.floor || 0;
    if (sf !== zf) fail(`地图 aiSpawns.${s.zone} 写的 floor=${sf}，但该分区实际在第 ${zf} 层`);
    if (sf >= floorCount) fail(`地图 aiSpawns.${s.zone} 的 floor=${sf} 超出该图的层数 ${floorCount}`);
    // [M6-2] 分区兵种权重覆盖：引用的兵种必须存在，且不得含 boss
    if (s.tiers) {
      for (const [id, w] of Object.entries(s.tiers)) {
        if (!tierIds.has(id)) fail(`地图 aiSpawns.${s.zone}.tiers 引用了不存在的兵种 ${id}`);
        if (id === 'boss') fail(`地图 aiSpawns.${s.zone}.tiers 不得包含 boss —— Boss 走 spawnRules.bossCount 独立配额`);
        if (!(w >= 0)) fail(`地图 aiSpawns.${s.zone}.tiers.${id} 的权重必须为非负`);
      }
    }
  }
  // [M6-2] Boss 配额：数量与 spawnRules.bossCount 一致；分区与层必须存在
  const bossCount = aiTable.spawnRules.bossCount ?? 0;
  const bossSpawns = map.bossSpawns || [];
  if (bossSpawns.length !== bossCount) {
    fail(`地图 bossSpawns 条目数 ${bossSpawns.length} 与 ai.spawnRules.bossCount ${bossCount} 不一致`);
  }
  if (bossCount > 0 && !aiTable.tiers.some((t) => t.id === 'boss')) {
    fail('ai.spawnRules.bossCount > 0，但 ai.tiers 里没有 id 为 boss 的档位');
  }
  for (const b of bossSpawns) {
    if (!zoneIds.has(b.zone)) fail(`地图 bossSpawns 引用了不存在的分区 ${b.zone}`);
    const bf = zoneById.get(b.zone).floor || 0;
    if ((b.floor || 0) !== bf) fail(`地图 bossSpawns.${b.zone} 写的 floor=${b.floor || 0}，实际在第 ${bf} 层`);
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

// ---------------------------------------------------------------------------
// M5-3 / M5-4：物品与装备的统一视图
//
// 存在原因（本项目的核心纪律）：**同一件东西只能有一份数值**。
//   护甲 vest2 同时出现在掉落表（作为可搜刮的物品：估值 550 / 重 3.2kg / 2x2）
//   与战斗表（作为装备：等级 2 / 减伤 0.35 / 耐力 55）。
//   这两份描述并不冲突 —— 它们分别回答"它值多少钱"与"它能挡多少伤害"。
//   真正危险的是**同一件事写两遍**：价值、重量、形状。
//
// 因此本函数做的事是：把两张表按 id 对齐成**一张物品视图**，并在启动期断言
// 重叠字段逐字段相等（不等就报错，指出是哪两个文件哪一行）。这样：
//   · 下游（仓库 / 商店 / 配装 / 结算）只面对一种"物品"，
//   · 数值分叉会在启动时被抓住，而不是在"卖价看起来不对"时被猜出来。
//
// lootItemId 的作用：装备与物品的 id 不总相同（武器 dmr_sr25 在掉落表里叫
//   rifle_sr25）。装备表用 lootItemId 显式声明"我在掉落表里的物品条目"，避免
//   靠命名约定去猜。
// ---------------------------------------------------------------------------
function buildItemViews() {
  const items = {};
  const equipmentDefs = {};

  /**
   * 一件物品等于几个**存储单位**。
   *
   * ★ 制作人裁定「一格最多堆叠 60 发子弹」之后必须回答的问题：掉落表里的
   *   `value=110 / weightKg=0.3` 是"**一件**"的量，而仓库按**发**存储 ——
   *   两者相乘会把估值与重量都高估 60 倍。
   *   口径（本函数就是它的唯一实现）：
   *     · 弹药：1 件 = 一盒 = `stack` 发（一个容器里抽出的"一件弹药"就是一盒）
   *     · 其余：1 件 = 1 个（绷带的值/重本来就是"一个"的）
   *   于是 `unitValue = value / unitsPerItem` 是"每发/每个"的价值，
   *   仓库与商店一律按存储单位计数，局内与掉落一律按件计数。
   */
  const unitsOf = (def) => (def.category === 'ammo' ? def.stack : 1);

  // ① 掉落表的物品（战利品池）—— 它们是物品视图的基础
  for (const it of lootTable.items) {
    if (items[it.id]) fail(`loot.json 的物品 id 重复：${it.id}`);
    if (!(it.w > 0 && it.h > 0)) fail(`物品 ${it.id} 的形状非法（${it.w}x${it.h}）`);
    if (!(it.stack >= 1)) fail(`物品 ${it.id} 的 stack 必须为正整数`);
    const units = unitsOf(it);
    items[it.id] = {
      ...it,
      vol: it.w * it.h,
      isEquipment: false,
      equipmentId: null,
      price: null,
      unitsPerItem: units,
      unitValue: it.value / units,
      unitWeightKg: it.weightKg / units,
    };
  }

  // ② 装备（武器 / 护甲 / 携行具，class=0 的"无防护"不是物品）
  //
  // ★ M6：背包与弹挂并入这条同源路径 —— 它们的物品形态（估值/重量/形状/堆叠）
  //   由本函数统一派生，不在掉落表里另留副本。这与其他装备的处理完全一致。
  const equipmentSources = [
    ...weaponsTable.weapons.map((def) => ({ kind: 'weapon', def })),
    ...combatTable.armor.filter((a) => a.class > 0).map((def) => ({ kind: 'armor', def })),
    ...(carryTable.backpacks || []).map((def) => ({ kind: 'backpack', def })),
    ...(carryTable.rigs || []).map((def) => ({ kind: 'rig', def })),
  ];
  for (const { kind, def } of equipmentSources) {
    if (equipmentDefs[def.id]) fail(`装备 id 重复：${def.id}`);
    const w = def.item ? def.item.w : 0;
    const h = def.item ? def.item.h : 0;
    if (!(w > 0 && h > 0)) fail(`装备 ${def.id} 缺少合法的 item.{w,h}`);
    if (!(def.weightKg > 0)) fail(`装备 ${def.id} 的 weightKg 必须为正（当前 ${def.weightKg}）`);
    if (!(def.value >= 0)) fail(`装备 ${def.id} 的 value 必须为非负（当前 ${def.value}）`);
    if (!(def.price > 0)) fail(`装备 ${def.id} 的 price 必须为正（当前 ${def.price}）—— 它同时是商店基价`);

    const itemId = def.lootItemId || def.id;
    const target = items[itemId];
    if (target) {
      // ★ 交叉校验：两表必须对"值多少钱 / 有多重 / 占几格"给出同一答案
      const diffs = [];
      if (target.value !== def.value) diffs.push(`value ${target.value} ≠ ${def.value}`);
      if (target.weightKg !== def.weightKg) diffs.push(`weightKg ${target.weightKg} ≠ ${def.weightKg}`);
      if (target.w !== w || target.h !== h) diffs.push(`形状 ${target.w}x${target.h} ≠ ${w}x${h}`);
      if (diffs.length) {
        fail(
          `装备 ${def.id} 与掉落表的物品 ${itemId} 存在重复且不一致的字段：${diffs.join('；')}。` +
            '请只保留一处 —— 同一件事写两遍迟早分叉。'
        );
      }
      target.isEquipment = true;
      target.equipmentId = def.id;
      target.price = def.price;
    } else {
      if (def.lootItemId) {
        fail(`装备 ${def.id} 声明的 lootItemId="${def.lootItemId}" 在掉落表里不存在`);
      }
      // 没有掉落条目的装备：物品形态由装备表生成（武器不必同时是战利品，
      // 因此掉落池一字未改 —— M5 禁止扩充局内内容）。
      items[itemId] = {
        id: itemId,
        label: def.label,
        // 类别直接取自 kind（weapon / armor / backpack / rig）——
        // 原来写成 `kind === 'weapon' ? 'weapon' : 'armor'`，加入携行具后
        // 会把背包与弹挂标成 armor，进而在经济表里按护甲的价差买卖。
        category: kind,
        rarity: null,
        value: def.value,
        weightKg: def.weightKg,
        stack: 1,
        w, h,
        vol: w * h,
        isEquipment: true,
        equipmentId: def.id,
        price: def.price,
        // 装备一件就是一个（没有"一盒"的概念），因此存储单位 = 件
        unitsPerItem: 1,
        unitValue: def.value,
        unitWeightKg: def.weightKg,
      };
    }

    equipmentDefs[def.id] = {
      id: def.id,
      kind,
      label: def.label,
      value: def.value,
      weightKg: def.weightKg,
      price: def.price,
      w, h,
      lootItemId: def.lootItemId || null,
      itemId,
      def,
    };
  }

  return { items, equipmentDefs };
}

const ITEM_VIEWS = buildItemViews();

/**
 * ★ M6：背包容量改为**对携行具表的引用**，不再在 loot.json 里写数字。
 *
 * 为什么必须派生而不是两处各留一份：M6 起背包是可装备物，
 * `carry.json.backpacks` 是容量的唯一真值；loot.json 只声明“按哪只背包做经济模拟”。
 * 若两边各写一份 6x5，改了 A 忘了 B 就会变成“面板说 6x5、局内却是 4x3”这类静默分叉。
 *
 * 派生出的形状与原 backpack 完全一致（w / h / weightLimitKg），
 * 因此 inventory.js 等下游一行都不用改。
 */
function backpackView() {
  try {
    // 解析实现**只有一份**（core/lootTable.js 的 resolveBackpack）——
    // 校验器直读 loot.json、看不到这里的派生，若各写一份就会分叉。
    return resolveBackpack(lootTable, carryTable);
  } catch (e) {
    fail(e.message);
  }
}
const LOOT_VIEW = { ...lootTable, backpack: backpackView() };

/**
 * 口径视图：把"这个口径用哪种弹药条目"与"单发重量"派生出来。
 *
 * ★ 制作人裁定（M5-3）：弹药的**唯一**重量来源是掉落表的物品重量 ——
 *   每格 stack 发，单发重 weightKg / stack。此前 weapons.json 另有一份
 *   weightPerRoundKg，那是同一件事的两份真值，已删除。
 *   派生而不是复制，因此"改一格几发"只改掉落表一处。
 */
const AMMO_VIEW = weaponsTable.ammo.map((a) => {
  const def = a.lootItemId ? ITEM_VIEWS.items[a.lootItemId] : null;
  return {
    ...a,
    itemId: a.lootItemId || null,
    weightPerRoundKg: def ? def.weightKg / def.stack : 0,
  };
});

/** 起始配装（唯一真值在 equipment.json）。缺表时给空对象，让 validateEquipment 报出可读的错。 */
const STARTER = equipmentTable.starterLoadout || {};

/** 派生给局内的 playerVitals（startArmor / startConsumables 仍是 M2 的名字，来源已改为配装表） */
function playerVitalsView() {
  return {
    ...combatTable.playerVitals,
    // null（而不是缺键）表示"该槽位为空"。缺键会让 dataKeys 的遍历与界面渲染
    // 各自决定怎么处理，最终出现两种口径。
    startArmor: { body: STARTER.body ?? null, head: STARTER.head ?? null },
    // ★ M6-4：起始消耗品改成**数网格**（与局内的口径一致：网格才是真值）。
    //   以前它直接抄 starterLoadout.consumables 那个数字字典 —— 那份真值已经删了，
    //   继续抄就变成"两份真值里死掉的那一份"。
    startConsumables: starterConsumables(),
  };
}

/** 起始网格里每个口径各有多少发（派生自 starterLoadout.carry，不是副本）。 */
function starterReserveByAmmo() {
  const out = {};
  const byItem = new Map(AMMO_VIEW.filter((a) => a.itemId).map((a) => [a.itemId, a.id]));
  // 只数背包与弹挂：保险箱里的东西确实在身上，但局内不从保险箱里换弹，
  // 因此它不该出现在"备弹"这个读数里（否则 HUD 说有 120 发、实际打不出来）。
  for (const name of ['backpack', 'rig']) {
    for (const e of (STARTER.carry && STARTER.carry[name]) || []) {
      const cal = byItem.get(e && e.itemId);
      if (!cal) continue;
      out[cal] = (out[cal] || 0) + e.count;
    }
  }
  return out;
}

/** 起始配装网格里每种消耗品各有几个（派生自 starterLoadout.carry，不是副本）。 */
function starterConsumables() {
  const out = {};
  for (const c of combatTable.consumables) out[c.id] = 0;
  for (const name of ['backpack', 'rig']) {
    for (const e of (STARTER.carry && STARTER.carry[name]) || []) {
      if (e && out[e.itemId] !== undefined) out[e.itemId] += e.count;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// M5-3 配装表校验
// ---------------------------------------------------------------------------
function validateEquipment() {
  const eq = equipmentTable;
  if (!eq.starterLoadout) fail('缺少 equipment.starterLoadout（新账号配装的唯一真值）');

  assertUnique(eq.slots, 'id', 'equipment.slots');
  for (const s of eq.slots) {
    if (s.disabled) {
      // 被刻意停用的槽位必须写明原因 —— 否则下一个人会以为它是漏配的
      if (!s.reason) fail(`停用的槽位 ${s.id} 必须写明 reason`);
      continue;
    }
    if (!Array.isArray(s.accepts) || s.accepts.length === 0) {
      fail(`槽位 ${s.id} 的 accepts 不能为空（否则它接受任何东西）`);
    }
    for (const k of s.accepts) {
      // M6：白名单加入携行具 —— 背包/弹挂是装备，不是"任意类别"
      if (k !== 'weapon' && k !== 'armor' && k !== 'backpack' && k !== 'rig') {
        fail(`槽位 ${s.id} 的 accepts 含未知类别 "${k}"`);
      }
    }
  }

  const slotById = new Map(eq.slots.map((s) => [s.id, s]));
  const weaponById = new Map(weaponsTable.weapons.map((w) => [w.id, w]));
  const armorById = new Map(combatTable.armor.map((a) => [a.id, a]));

  // 槽位与装备类别 / 武器槽号 / 护甲覆盖部位必须匹配
  const weaponsBySlot = { 1: [], 2: [] };
  for (const w of weaponsTable.weapons) weaponsBySlot[w.slot].push(w);
  for (const [slotId, ws] of Object.entries(weaponsBySlot)) {
    const s = slotById.get(slotId === '1' ? 'primary' : 'secondary');
    if (!s) fail(`equipment.slots 缺少 ${slotId === '1' ? 'primary' : 'secondary'} 槽`);
    if (!s.accepts.includes('weapon')) fail(`${s.id} 槽必须接受 weapon`);
  }
  for (const w of weaponsTable.weapons) {
    if (w.slot !== 1 && w.slot !== 2) fail(`武器 ${w.id} 的 slot=${w.slot} 非法（只能是 1 或 2）`);
  }
  for (const s of eq.slots) {
    if (s.weaponSlot !== undefined && ![1, 2].includes(s.weaponSlot)) {
      fail(`槽位 ${s.id} 的 weaponSlot=${s.weaponSlot} 非法`);
    }
    if (s.armorCovers !== undefined && !['head', 'chest', 'stomach', 'limb'].includes(s.armorCovers)) {
      fail(`槽位 ${s.id} 的 armorCovers="${s.armorCovers}" 不是合法部位名`);
    }
  }

  // ---- 起始配装 ----
  // ★ 制作人裁定：起始**可以没有长枪**（新账号只有 P9 手枪）。
  //   因此这里允许 null，但一旦给了就必须落在正确的槽号上。
  const checkStarterWeapon = (field, wantSlot) => {
    const id = STARTER[field];
    if (id === null || id === undefined) return;
    const w = weaponById.get(id);
    if (!w) fail(`starterLoadout.${field} 引用了不存在的武器 ${id}`);
    if (w.slot !== wantSlot) {
      fail(`starterLoadout.${field}="${id}" 的 slot=${w.slot}，但该槽位要求 slot=${wantSlot}`);
    }
  };
  checkStarterWeapon('primary', 1);
  checkStarterWeapon('secondary', 2);

  for (const [field, covers] of [['body', 'chest'], ['head', 'head']]) {
    const id = STARTER[field];
    if (id === null || id === undefined) continue; // 允许空槽（不穿甲）
    const a = armorById.get(id);
    if (!a) fail(`starterLoadout.${field} 引用了不存在的护甲 ${id}`);
    if (!a.covers.includes(covers)) fail(`starterLoadout.${field}="${id}" 并不覆盖 ${covers}`);
  }

  // ---- 弹药携带 ----
  // ★ 制作人裁定：**不设数量上限**（原先的 maxReserveByCaliber 已删除）。
  //   这里只校验口径合法与非负数量 —— 真正约束携带量的是负重三档与仓库库存。
  if (!eq.ammo) fail('缺少 equipment.ammo（可携带的口径清单）');
  const caliberSet = new Set(weaponsTable.ammo.map((a) => a.id));
  // ★ 每个口径都必须有一个弹药物品条目：仓库供给、负重计重、商店购买全靠它。
  //   缺了它，那把枪在 M5 的配装系统里就是"带不出门"的 —— 而且界面上看不出来。
  for (const a of weaponsTable.ammo) {
    const def = a.lootItemId ? ITEM_VIEWS.items[a.lootItemId] : null;
    if (!def) {
      fail(
        `口径 ${a.id} 没有对应的弹药物品（lootItemId）—— 仓库无法供给它、负重也算不出来。` +
          '请在掉落表里补一个该口径的弹药条目。'
      );
    }
    if (def.category !== 'ammo') {
      fail(`口径 ${a.id} 指向的物品 ${a.lootItemId} 类别是 ${def.category}，不是 ammo`);
    }
    if (!(def.stack >= 1)) fail(`弹药物品 ${a.lootItemId} 的 stack 必须为正（它决定一格几发）`);
    if (!(def.weightKg > 0)) fail(`弹药物品 ${a.lootItemId} 的 weightKg 必须为正（负重靠它）`);
  }
  const weaponCalibers = new Set(weaponsTable.weapons.map((w) => w.ammoType));
  for (const cal of eq.ammo.carryCalibers) {
    if (!caliberSet.has(cal)) fail(`equipment.ammo.carryCalibers 含不存在的口径 ${cal}`);
  }
  for (const cal of weaponCalibers) {
    if (!eq.ammo.carryCalibers.includes(cal)) {
      fail(`口径 ${cal} 有武器在用，但不在 equipment.ammo.carryCalibers 里 —— 那类子弹永远带不进战区`);
    }
  }
  // ★ M6-4：起始配装的弹药与消耗品不再是两个数字字典，而是**直接写在携行网格里**
  //   （starterLoadout.carry）。这里只校验网格条目本身引用得到物品且数量合法 ——
  //   "塞不塞得进兜底背包"由 validateCarry 用同一份 sanitizeCarry 判，不在这里重复一遍。
  const consumableIds = new Set(combatTable.consumables.map((c) => c.id));
  const ammoItemIds = new Set(weaponsTable.ammo.map((a) => a.lootItemId).filter(Boolean));
  if (!STARTER.carry) fail('starterLoadout 缺少 carry（起始携带的弹药与药品现在写在携行网格里）');
  for (const [grid, list] of dataEntries(STARTER.carry || {})) {
    if (!Array.isArray(list)) {
      fail(`starterLoadout.carry.${grid} 必须是数组（网格条目列表）`);
      continue;
    }
    for (const e of list) {
      const def = ITEM_VIEWS.items[e && e.itemId];
      if (!def) {
        fail(`starterLoadout.carry.${grid} 含未知物品 ${e && e.itemId}`);
        continue;
      }
      if (!(Number.isInteger(e.count) && e.count > 0 && e.count <= def.stack)) {
        fail(`starterLoadout.carry.${grid} 的 ${e.itemId} 数量 ${e.count} 非法（1..${def.stack}）`);
      }
      if (!ammoItemIds.has(e.itemId) && !consumableIds.has(e.itemId)) {
        fail(`starterLoadout.carry.${grid} 的 ${e.itemId} 既不是弹药也不是消耗品 —— 起始不该带它`);
      }
      if (!Number.isInteger(e.x) || !Number.isInteger(e.y)) {
        fail(`starterLoadout.carry.${grid} 的 ${e.itemId} 缺 x / y（坐标是网格真值的一部分）`);
      }
    }
  }

  if (!(eq.maxPresets >= 1)) fail('equipment.maxPresets 必须 >= 1');

  // ---- 超重三档（制作人裁定） ----
  const ow = eq.overweight;
  if (!ow) fail('缺少 equipment.overweight（超重惩罚）');
  if (!Array.isArray(ow.bands) || ow.bands.length < 2) {
    fail('equipment.overweight.bands 至少要有两档（正常 + 一个惩罚档），否则超重没有意义');
  }
  let prevMax = 0;
  for (let i = 0; i < ow.bands.length; i++) {
    const b = ow.bands[i];
    const last = i === ow.bands.length - 1;
    if (!b.id || !b.label) fail(`overweight.bands[${i}] 缺少 id / label（界面要显示档位名）`);
    if (last) {
      if (b.maxKg !== null && b.maxKg !== undefined) {
        fail(`overweight.bands 最后一档（${b.id}）的 maxKg 必须为 null —— 否则超出最后一档的重量无档可落`);
      }
    } else if (!(b.maxKg > prevMax)) {
      fail(`overweight.bands[${i}].maxKg=${b.maxKg} 必须大于上一档的 ${prevMax}（阈值必须严格递增）`);
    } else {
      prevMax = b.maxKg;
    }
    if (!(b.speedScale > 0 && b.speedScale <= 1)) {
      fail(`overweight.bands[${i}].speedScale=${b.speedScale} 必须落在 (0, 1]`);
    }
    if (typeof b.noSprint !== 'boolean') fail(`overweight.bands[${i}].noSprint 必须是布尔值`);
    if (i > 0) {
      // 惩罚必须逐档加重：后一档不能比前一档更快，也不能把已经禁掉的冲刺又放开
      if (b.speedScale > ow.bands[i - 1].speedScale) {
        fail(`overweight.bands[${i}] 的移速系数比上一档更大 —— 越重反而越快`);
      }
      if (ow.bands[i - 1].noSprint && !b.noSprint) {
        fail(`overweight.bands[${i}] 放开了上一档已禁止的冲刺 —— 越重反而更灵活`);
      }
    }
  }
  if (ow.bands[0].speedScale !== 1 || ow.bands[0].noSprint) {
    fail('overweight.bands[0] 必须是"正常"档：speedScale=1 且允许冲刺');
  }
}

// ---------------------------------------------------------------------------
// M5-4 经济表校验
// ---------------------------------------------------------------------------
function validateEconomy() {
  const e = economyTable;
  const st = e.stash;
  if (!st) fail('缺少 economy.stash（仓库规格）');
  if (!(st.w > 0 && st.h > 0)) fail(`economy.stash 的尺寸非法：${st.w}x${st.h}`);

  // 每件物品都必须放得进仓库 —— 否则玩家搜到它时无处存放，而界面上看不出来
  for (const def of Object.values(ITEM_VIEWS.items)) {
    if (def.w > st.w || def.h > st.h) {
      fail(`物品 ${def.id} 的形状 ${def.w}x${def.h} 放不进 ${st.w}x${st.h} 的仓库`);
    }
  }
  for (const m of st.sortModes) {
    if (!['category', 'rarity', 'value', 'name'].includes(m)) fail(`未知的排序模式 "${m}"`);
  }
  if (!(st.limits && st.limits.maxBytes > 0)) fail('economy.stash.limits.maxBytes 必须为正');

  const buy = e.priceRules.buySpread;
  const sell = e.priceRules.sellRatio;
  const categories = new Set(Object.values(ITEM_VIEWS.items).map((d) => d.category));
  for (const c of categories) {
    if (!(c in sell)) {
      fail(`priceRules.sellRatio 缺少类别 "${c}"（物品表里有这类物品）—— 缺一类的表现是"这类东西卖不掉且没人知道为什么"`);
    }
  }
  for (const [c, r] of dataEntries(sell)) {
    if (typeof r !== 'number' || r < 0 || r > 1) fail(`sellRatio.${c}=${r} 必须落在 [0, 1]`);
  }
  for (const [c, s] of dataEntries(buy)) {
    if (!(s > 0)) fail(`buySpread.${c}=${s} 必须为正`);
    if (!(sell[c] < s)) {
      fail(`类别 ${c} 的 sellRatio(${sell[c]}) 必须小于 buySpread(${s}) —— 否则买入再卖出可以无限刷钱`);
    }
    if (!categories.has(c)) fail(`buySpread 含物品表里不存在的类别 "${c}"`);
  }
  if (!(e.priceRules.minSellPrice >= 0)) fail('priceRules.minSellPrice 必须为非负');

  // ---- 商店清单 ----
  // 条目 ref 可以是**装备 id**（dmr_sr25）或**物品 id**（ammo_556）。两者都要能查到：
  // 装备 id 指向它的物品形态（dmr_sr25 → rifle_sr25），因为**买入后进仓库的是物品形态**。
  const maxLevel = progressionTable.levelCurve.maxLevel;
  assertUnique(e.stock.items, 'id', 'economy.stock.items');
  for (const row of e.stock.items) {
    const equip = ITEM_VIEWS.equipmentDefs[row.ref];
    const def = equip ? ITEM_VIEWS.items[equip.itemId] : ITEM_VIEWS.items[row.ref];
    if (!def) fail(`商店条目 ${row.id} 引用了不存在的物品/装备 ${row.ref}`);
    if (!(row.unlockLevel >= 1 && row.unlockLevel <= maxLevel)) {
      fail(`商店条目 ${row.id} 的 unlockLevel=${row.unlockLevel} 超出 [1, ${maxLevel}]`);
    }
    if (!(row.qty === -1 || row.qty > 0)) fail(`商店条目 ${row.id} 的 qty 必须为 -1（无限）或正整数`);
    if (!(def.category in buy)) {
      fail(`商店在售的 ${row.ref} 属于类别 ${def.category}，但 buySpread 里没有这个类别 —— 它的买价无从计算`);
    }
    if (!((def.price !== null ? def.price : def.value) > 0)) {
      fail(`商店在售的 ${row.ref} 既没有 price 也没有 value，买价无从计算`);
    }
    if (equip && def.id !== row.ref) {
      // 有物品形态的装备：买入价以物品形态的 id 结算，因此必须能反向查到 —— 否则
      // "买进来叫 dmr_sr25、卖出去叫 rifle_sr25"会在同一件东西上出现两个价格。
      if (def.equipmentId !== row.ref) {
        fail(`商店条目 ${row.ref} 与其物品形态 ${def.id} 的 equipmentId(${def.equipmentId}) 不一致`);
      }
    }
  }

  const inf = e.inflation;
  if (!inf) fail('缺少 economy.inflation（通胀监控参数，M5 硬性要求）');
  if (!(inf.windowRaids >= 5)) fail('economy.inflation.windowRaids 至少为 5');
  if (!(inf.inflationRatio > 1)) fail('economy.inflation.inflationRatio 必须 > 1');
  if (!(inf.deflationRatio > 0 && inf.deflationRatio < 1)) fail('economy.inflation.deflationRatio 必须落在 (0, 1)');
  if (!(inf.maxSamples >= inf.windowRaids)) fail('economy.inflation.maxSamples 必须 >= windowRaids');

  if (!(e.starterCurrency > 0)) fail('economy.starterCurrency 必须为正');
}

// ---------------------------------------------------------------------------
// M5-5 成长表校验
// ---------------------------------------------------------------------------
function validateProgression() {
  const p = progressionTable;
  const c = p.levelCurve;
  if (!c) fail('缺少 progression.levelCurve');
  if (!(c.base > 0)) fail('levelCurve.base 必须为正');
  if (!(c.growth > 1)) fail('levelCurve.growth 必须 > 1（否则等级曲线不单调递增）');
  if (!(c.maxLevel >= 2 && Number.isInteger(c.maxLevel))) fail('levelCurve.maxLevel 必须为 >= 2 的整数');
  if (!(p.skillPointsPerLevel >= 0)) fail('skillPointsPerLevel 必须为非负');

  // ★ 效果类型：必须被局内真实消费（否则就是"看起来有用但什么都没改"的假技能）
  for (const kind of dataKeys(p.effectKinds)) {
    if (!CONSUMED_MODIFIERS[kind]) {
      fail(
        `效果 "${kind}" 不在 CONSUMED_MODIFIERS 白名单里：它没有任何局内消费点。` +
          '一个算出来没人读的数字，在界面上会完全正常，但游戏行为一点没变。'
      );
    }
    const kd = p.effectKinds[kind];
    if (kd.base !== 'fromLoot' && typeof kd.base !== 'number') {
      fail(`effectKinds.${kind}.base 必须是数字或 "fromLoot"`);
    }
  }
  for (const kind of Object.keys(CONSUMED_MODIFIERS)) {
    if (!p.effectKinds[kind]) {
      fail(`CONSUMED_MODIFIERS 声明了 ${kind}，但 progression.effectKinds 里没有它 —— 两处真值分叉了`);
    }
  }

  assertUnique(p.branches, 'id', 'progression.branches');
  const branchIds = new Set(p.branches.map((b) => b.id));
  assertUnique(p.skills, 'id', 'progression.skills');
  const byId = new Map(p.skills.map((s) => [s.id, s]));

  for (const sk of p.skills) {
    if (!branchIds.has(sk.branch)) fail(`技能 ${sk.id} 引用了不存在的分支 ${sk.branch}`);
    if (!(Number.isInteger(sk.maxLevel) && sk.maxLevel >= 1)) fail(`技能 ${sk.id} 的 maxLevel 非法`);
    if (!Array.isArray(sk.costPerLevel) || sk.costPerLevel.length !== sk.maxLevel) {
      fail(`技能 ${sk.id} 的 costPerLevel 长度必须等于 maxLevel(${sk.maxLevel})`);
    }
    for (const cc of sk.costPerLevel) {
      if (!(Number.isInteger(cc) && cc >= 1)) fail(`技能 ${sk.id} 的 costPerLevel 必须为正整数`);
    }
    // requires / minLevel 是**可选**字段：制作人裁定取消技能间的全部门槛，当前表里一个都没写。
    // 这里仍然支持它们（写了就校验），这样 M6 恢复树形结构时不必改校验器。
    if (sk.minLevel !== undefined && !(sk.minLevel >= 1 && sk.minLevel <= c.maxLevel)) {
      fail(`技能 ${sk.id} 的 minLevel 超出 [1, ${c.maxLevel}]`);
    }
    if (sk.requires !== undefined && !Array.isArray(sk.requires)) {
      fail(`技能 ${sk.id} 的 requires 必须是数组`);
    }
    for (const r of sk.requires || []) {
      if (!byId.has(r)) fail(`技能 ${sk.id} 的前置 ${r} 不存在`);
      if (r === sk.id) fail(`技能 ${sk.id} 的前置包含自己`);
      const req = byId.get(r);
      if (req && req.tier >= sk.tier) fail(`技能 ${sk.id}（tier ${sk.tier}）的前置 ${r} 的 tier 不小于它 —— 层次关系反了`);
    }
    if (!Array.isArray(sk.effects) || sk.effects.length === 0) fail(`技能 ${sk.id} 没有任何效果`);
    for (const e of sk.effects) {
      if (!p.effectKinds[e.kind]) fail(`技能 ${sk.id} 引用了未定义的效果 ${e.kind}`);
      if (typeof e.perLevel !== 'number' || e.perLevel === 0) fail(`技能 ${sk.id} 的 ${e.kind}.perLevel 必须为非零数字`);
    }
  }

  // 前置无环（沿 requires 上溯，步数不得超过技能总数）。当前表里没有 requires，
  // 但一旦有人写回过长的链，这里会立刻报错。
  for (const sk of p.skills) {
    let cur = sk;
    let hops = 0;
    while (cur && (cur.requires || []).length) {
      cur = byId.get(cur.requires[0]);
      if (++hops > p.skills.length) fail(`技能前置存在环（自 ${sk.id} 上溯 ${hops} 步仍未到顶）`);
    }
  }

  // 满级总点数必须够点满全树 —— 否则是一份永远点不满的死配置
  const totalPoints = (c.maxLevel - 1) * p.skillPointsPerLevel;
  const needPoints = p.skills.reduce((a, s) => a + s.costPerLevel.reduce((x, y) => x + y, 0), 0);
  if (totalPoints < needPoints) {
    fail(`满级共 ${totalPoints} 点技能点，但点满全树需要 ${needPoints} 点 —— 永远点不满`);
  }

  // 洗点（制作人裁定：要做，且要花货币）
  if (!p.respec) fail('缺少 progression.respec（洗点要花货币 —— M5-5 制作人裁定）');
  if (!(p.respec.costPerPoint > 0)) fail(`progression.respec.costPerPoint=${p.respec.costPerPoint} 必须为正`);
  // 洗点单价 × 满树点数不得大到"永远洗不起"（一串零通常是手滑多打了一位）
  const fullRespec = p.respec.costPerPoint * needPoints;
  if (fullRespec > 1000000) {
    fail(`点满全树后洗点需 ${fullRespec} 货币 —— 量级明显异常，请复核 costPerPoint`);
  }

  // 全技能点满后的等效倍率必须仍然合法（例如 recoilScale 不能变成 0 或负数）
  const maxed = {
    progression: { skills: Object.fromEntries(p.skills.map((s) => [s.id, s.maxLevel])) },
  };
  // ★ M6：这里必须传 **LOOT_VIEW** 而不是原始 lootTable ——
  //   skillModifiers 会用 `lootTable.backpack.weightLimitKg` 当负重基数，
  //   而 M6 起背包容量是**派生的**（loot.json 里只剩一个 referenceId）。
  //   传原始表会让它读到 undefined，进而在校验里变成 NaN。
  const mods = skillModifiers(maxed, { progression: p, lootTable: LOOT_VIEW });
  if (!(mods.weightLimitKg > 0)) fail(`点满负重技能后 weightLimitKg=${mods.weightLimitKg} 非法`);
  if (!(mods.moveSpeedScale >= 1)) fail(`点满机动技能后移速倍率 ${mods.moveSpeedScale} < 1（技能不该让人更慢）`);
  if (!(mods.recoilScale > 0 && mods.recoilScale <= 1)) fail(`点满后后坐力倍率 ${mods.recoilScale} 必须落在 (0, 1]`);
  if (!(mods.spreadScale > 0 && mods.spreadScale <= 1)) fail(`点满后扩散倍率 ${mods.spreadScale} 必须落在 (0, 1]`);
  if (!(mods.searchSpeedScale >= 1)) fail(`点满后搜刮速度倍率 ${mods.searchSpeedScale} < 1`);
  if (!(mods.healSpeedScale >= 1)) fail(`点满后医疗速度倍率 ${mods.healSpeedScale} < 1`);
  if (!(mods.sellBonusRatio >= 0)) fail(`点满后卖价加成 ${mods.sellBonusRatio} < 0`);
}

// ---------------------------------------------------------------------------
// M5-6 任务表校验
// ---------------------------------------------------------------------------
function validateQuests() {
  const q = questsTable;
  if (!(q.maxActive >= 1)) fail('quests.maxActive 必须 >= 1');
  assertUnique(q.quests, 'id', 'quests.quests');

  const byId = new Map(q.quests.map((x) => [x.id, x]));
  const KINDS = ['extract', 'kill', 'open', 'collect', 'value'];
  const itemIds = new Set(Object.keys(ITEM_VIEWS.items));
  const containerIds = new Set(lootTable.containers.map((c) => c.id));
  const safeTierIds = new Set(lootTable.safeContainer.tiers.map((t) => t.id));
  const aiTierIds = new Set(aiTable.tiers.map((t) => t.id));
  const maxLevel = progressionTable.levelCurve.maxLevel;

  // 某稀有度是否真的能从某个容器里掉出来（用于"任务物品可得"校验）
  const rarityDroppable = (rarity) =>
    lootTable.containers.some((c) => (c.rarityWeights[rarity] || 0) > 0);

  for (const quest of q.quests) {
    if (!quest.label || !quest.brief) fail(`任务 ${quest.id} 缺少 label / brief`);
    // level 是**可选**字段：制作人裁定任务全部取消等级门槛，当前表里一个都没写。
    if (quest.level !== undefined && !(quest.level >= 1 && quest.level <= maxLevel)) {
      fail(`任务 ${quest.id} 的等级门槛 ${quest.level} 超出 [1, ${maxLevel}]`);
    }
    for (const r of quest.requires) {
      if (!byId.has(r)) fail(`任务 ${quest.id} 的前置 ${r} 不存在`);
      if (r === quest.id) fail(`任务 ${quest.id} 的前置包含自己`);
    }
    if (!Array.isArray(quest.objectives) || quest.objectives.length === 0) fail(`任务 ${quest.id} 没有目标`);
    assertUnique(quest.objectives, 'id', `quests.${quest.id}.objectives`);

    for (const o of quest.objectives) {
      if (!KINDS.includes(o.kind)) fail(`任务 ${quest.id} 的目标 ${o.id} 类型 "${o.kind}" 非法（可用：${KINDS.join('/')}）`);
      if (!(o.need > 0)) fail(`任务 ${quest.id}.${o.id} 的 need 必须为正`);
      if (!o.text) fail(`任务 ${quest.id}.${o.id} 缺少 text（HUD 要显示它）`);
      if (o.kind === 'collect') {
        if (!itemIds.has(o.itemId)) fail(`任务 ${quest.id} 要收集的物品 ${o.itemId} 不存在`);
        const def = ITEM_VIEWS.items[o.itemId];
        if (!rarityDroppable(def.rarity)) {
          fail(`任务 ${quest.id} 要收集的 ${o.itemId}（稀有度 ${def.rarity}）不在任何容器的掉落池里 —— 这个任务永远做不完`);
        }
      }
      if (o.kind === 'open' && !containerIds.has(o.containerType)) {
        fail(`任务 ${quest.id} 要开的容器 ${o.containerType} 不存在`);
      }
      if (o.kind === 'kill' && o.tier && !aiTierIds.has(o.tier)) {
        fail(`任务 ${quest.id} 限定的 AI 分级 ${o.tier} 不存在`);
      }
    }

    const rw = quest.rewards || {};
    if (!(rw.currency >= 0)) fail(`任务 ${quest.id} 的货币奖励非法`);
    if (!(rw.exp >= 0)) fail(`任务 ${quest.id} 的经验奖励非法`);
    for (const it of rw.items || []) {
      if (!itemIds.has(it.itemId)) fail(`任务 ${quest.id} 的奖励引用了不存在的物品 ${it.itemId}`);
      if (!(it.count > 0)) fail(`任务 ${quest.id} 的奖励 ${it.itemId} 数量必须为正`);
    }
    if (rw.unlockSafeTier && !safeTierIds.has(rw.unlockSafeTier)) {
      fail(`任务 ${quest.id} 要解锁的安全箱档位 ${rw.unlockSafeTier} 不存在`);
    }
  }

  // 前置无环
  for (const quest of q.quests) {
    let cur = quest;
    let hops = 0;
    while (cur && cur.requires.length) {
      cur = byId.get(cur.requires[0]);
      if (++hops > q.quests.length) fail(`任务前置存在环（自 ${quest.id} 上溯）`);
    }
  }

  // 所有任务必须可达：任务链的第一环不能有前置（等级门槛已被制作人取消，
  // 因此"至少要有一个无前置的任务"就是唯一的可达性前提）
  const roots = q.quests.filter((x) => x.requires.length === 0);
  if (roots.length === 0) fail('没有任何无前置的任务 —— 玩家接不到第一个任务');
}

// ---------------------------------------------------------------------------
// M6 携行具表校验（背包 / 弹挂）
// ---------------------------------------------------------------------------
function validateCarry() {
  const bps = carryTable.backpacks || [];
  const rigs = carryTable.rigs || [];
  assertUnique(bps, 'id', 'carry.backpacks');
  assertUnique(rigs, 'id', 'carry.rigs');

  const knownCategories = new Set(Object.values(ITEM_VIEWS.items).map((i) => i.category));
  // 背包与弹挂共用的形状检查（两者的差别只在 accepts）
  const checkShape = (def, kindLabel) => {
    if (!(Number.isInteger(def.capacityW) && def.capacityW > 0)) fail(`${kindLabel} ${def.id} 的 capacityW 必须为正整数`);
    if (!(Number.isInteger(def.capacityH) && def.capacityH > 0)) fail(`${kindLabel} ${def.id} 的 capacityH 必须为正整数`);
    if (!(def.item && def.item.w > 0 && def.item.h > 0)) fail(`${kindLabel} ${def.id} 缺少合法的 item.{w,h}（它在仓库里也要占格）`);
    if (!(def.weightKg > 0)) fail(`${kindLabel} ${def.id} 的 weightKg 必须为正`);
    if (!(def.value >= 0)) fail(`${kindLabel} ${def.id} 的 value 必须为非负`);
    if (!(def.price > 0)) fail(`${kindLabel} ${def.id} 的 price 必须为正（它同时是商店基价）`);
  };
  for (const b of bps) {
    checkShape(b, '背包');
    if (!(b.weightLimitKg > 0)) fail(`背包 ${b.id} 的 weightLimitKg 必须为正`);
    // ★ slots 是**声明值**：这里核对它等于 capacityW×capacityH。
    //   若把它改成派生值，这条检查就永远为真 —— 等于没有检查。
    if (b.slots !== b.capacityW * b.capacityH) {
      fail(`背包 ${b.id} 声明的 slots=${b.slots} 与 capacityW×capacityH=${b.capacityW * b.capacityH} 不一致`);
    }
  }
  for (const r of rigs) {
    checkShape(r, '弹挂');
    if (!Array.isArray(r.accepts) || r.accepts.length === 0) fail(`弹挂 ${r.id} 的 accepts 不能为空（否则它等于第二只背包）`);
    for (const c of r.accepts) {
      if (!knownCategories.has(c)) fail(`弹挂 ${r.id} 的 accepts 含不存在的类别 "${c}"`);
    }
  }

  const d = carryTable.defaults || {};
  const dbp = d.backpack;
  if (!dbp) fail('carry.defaults.backpack 缺失 —— 它是"没装备背包"时的兜底容量，不能没有');
  if (!(dbp.w > 0 && dbp.h > 0)) fail('carry.defaults.backpack 的 w/h 必须为正');
  if (!(dbp.weightLimitKg > 0)) fail('carry.defaults.backpack 的 weightLimitKg 必须为正');

  // ★ 起始配装的携行物品**必须塞得进兜底背包**，而且不能刚好占满。
  //   为什么这条必须有：容量一旦由装备决定，"起始配装 + 没买背包"就是一个真实可达的状态，
  //   而它塞不下的表现是**进局时静默少带**（子弹不够、没有绷带）—— 玩家只会觉得"游戏坏了"。
  //   为什么还要管"剩几格"：3×2 的兜底容量是在"携行件不占格"的年代定的，那时 6 格全给战利品；
  //   M6 起携行件要占 4 格，同一个 3×2 就只剩 2 格 —— 新账号第一局几乎捡不了东西，
  //   而"搜"是这个玩法的核心动作。这个下限是**策划口径**（MIN_FREE_CELLS），不是随手取的值。
  const MIN_FREE_CELLS = 4;
  // ★ M6-4：起始配装的携带物已经是**网格坐标**（starterLoadout.carry），不再经过
  //   planCarry 自动投放。这里用与运行时**同一个** sanitizeCarry 去收它 ——
  //   校验器若自己另排一遍，就会变成"校验按 A 摆、进局按 B 摆"的第二套算法。
  const starterSpecs = carrySpecs(
    { backpack: STARTER.backpack ?? null, rig: STARTER.rig ?? null },
    carryTable,
    null
  );
  const starterSan = sanitizeCarry(STARTER.carry, starterSpecs, ITEM_VIEWS.items);
  const dropped = starterSan.repairs.length;
  if (dropped) {
    fail(
      `起始配装（equipment.starterLoadout.carry）有 ${dropped} 条塞不进兜底背包：${starterSan.repairs.join('；')}。` +
        ` 兜底背包 ${carryTable.defaults.backpack.w}×${carryTable.defaults.backpack.h}` +
        `（${carryTable.defaults.backpack.w * carryTable.defaults.backpack.h} 格）。` +
        ' 请调大兜底容量、给起始配装一只背包，或减少起始携带量 —— 三选一，别让玩家静默少带。'
    );
  }
  const starterTotal = carryTable.defaults.backpack.w * carryTable.defaults.backpack.h;
  const starterUsed = carryUsedSlots(starterSan.carry, ITEM_VIEWS.items, ['backpack']);
  if (starterTotal - starterUsed < MIN_FREE_CELLS) {
    fail(
      `兜底背包在装下起始携行件后只剩 ${starterTotal - starterUsed} 格（要求至少 ${MIN_FREE_CELLS} 格）：` +
        ` 兜底 ${carryTable.defaults.backpack.w}×${carryTable.defaults.backpack.h}=${starterTotal} 格，` +
        `起始携行件占 ${starterUsed} 格。` +
        ' 新账号一进战区就没有装战利品的地方，"搜"这个核心动作就没了。'
    );
  }
}

function validate() {
  const { weapons, ammo } = weaponsTable;
  const { armor, armorRules, hitZones, consumables } = combatTable;
  // ★ M5-3：playerVitals 改为**派生视图**（startArmor / startConsumables 来自 equipment.json）。
  //   它们仍在 combat.json 的语境里被引用（player.js 等下游读 cfg.playerVitals.startArmor），
  //   但真值已经只有一份 —— 就是 starterLoadout。
  const playerVitals = playerVitalsView();
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

  // ★ M5-3：原来这里校验 weapons.json 的 startLoadout（开局固定配装）。
  //   那份配置已迁至 equipment.json 的 starterLoadout，校验随之一并搬到
  //   validateEquipment()（它同时校验槽位、弹药口径、消耗品上限与超重规则）。
  //   刻意**不留**一份兼容校验：留副本就是留第二处真值。

  // 引用完整性：护甲覆盖的部位名必须存在于 hitZones
  const zoneSet = new Set(zoneNames);
  for (const a of armor) {
    for (const c of a.covers) {
      if (!zoneSet.has(c)) fail(`护甲 ${a.id} 覆盖了不存在的部位 ${c}`);
    }
    if (a.class > 0 && !(a.durability > 0)) fail(`护甲 ${a.id} 为非零等级但耐久不为正`);
  }

  // 引用完整性：玩家初始护甲必须存在（值来自 equipment.starterLoadout，此处只验引用）
  const armorIds = new Set(armor.map((a) => a.id));
  for (const [slot, id] of dataEntries(playerVitals.startArmor)) {
    if (id === null) continue; // 空槽是合法配置（不穿甲）
    if (!armorIds.has(id)) fail(`starterLoadout.${slot}（派生为 playerVitals.startArmor.${slot}）引用了不存在的护甲 ${id}`);
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
  validateExtractInterrupt();
  validateRaidTiming();
  validateSettings();
  // ★ M5：局外系统的四张表。顺序有依赖 —— 经济表要读成长表的 maxLevel、
  //   任务表要读物品视图与掉落表，因此放在后面。
  validateEquipment();
  validateCarry();
  validateProgression();
  validateEconomy();
  validateQuests();
}

validate();

/**
 * 派生给局内的 playerVitals。
 * 在 validate() **之后**取一次：validate 已经证明了 starterLoadout 的引用完整性，
 * 此处再把同一个对象交给下游，保证"校验的"与"运行时用的"是同一份。
 */
const PLAYER_VITALS = playerVitalsView();

// ---------------------------------------------------------------------------
// 地图表的派生视图
//
// 下游模块（player / extract / loot / aiManager / main）原本读的是 tunables 里的
// level.playerSpawnCell / extract.zones / loot.containers。这些字段现在由地图表
// 派生出来，因此**下游一行都不用改**，而数据的唯一来源变成了地图表。
// ---------------------------------------------------------------------------
const mapGrid = buildMapGrid(mapTable);
const CELL = mapTable.grid.cell;

export const map = mapTable;

/** 全部已注册的地图表（供黄金基准等工具按 id 取用，而不是只能拿到当前生效的那张） */
export const maps = MAP_TABLES;

/** 当前生效地图的 id（供报告与工具标注来源） */
export const activeMap = activeMapId;

/** 地图派生：把格坐标换算成运行时需要的形状 */
const derivedExtractZones = mapTable.extracts.map((e) => ({
  id: e.id,
  label: e.label,
  cell: [e.x, e.z],
  // floor 必须带上：两层图的撤离点分布在不止一层（tv_station_01 的 e2_roof 在二层），
  // 丢掉它之后判定只剩水平距离，站在一层同一 xz 就能触发二层的撤离点。
  // 单层图（industrial_01）的撤离点没有 floor 字段，缺省 0 不改变既有行为。
  floor: e.floor || 0,
  radius: e.radiusCells * CELL,
  conditional: !!e.conditional,
  // M4-1：开放规则随撤离点一起派生。它决定了"这个点什么时候能用"，
  // 与位置、层号一样属于地图表的真值，不能由代码另外猜一份。
  openRule: e.openRule || null,
}));

export const config = {
  ...tunables,
  map: mapTable,
  /** 已注册的全部地图表。测试与工具需要"显式指定某一张图"（例如单层对照）时用它 */
  maps: MAP_TABLES,
  /** 掉落表（M3-3/4/5/6 的唯一真值：容器分级、稀有度、物品池、背包、安全箱） */
  lootTable: LOOT_VIEW,
  weapons: weaponsTable.weapons,
  /** 口径表（派生视图：含 itemId 与 weightPerRoundKg，「每格几发」来自掉落表） */
  ammo: AMMO_VIEW,
  /**
   * 开局配装（M5-3 起由 equipment.json 派生）。
   *
   * 保留 M2 的字段名（primary / secondary / reserveByAmmo）是**有意的**：
   * weapon.js 与 briefing.js 读的就是它们，改名等于制造一次无收益的连锁改动。
   * 新增的 armor / consumables 让"整份配装"能从同一个对象读出来 ——
   * 局内不再需要分别去 combat.json 摸 startArmor 与 startConsumables。
   */
  startLoadout: {
    primary: STARTER.primary,
    secondary: STARTER.secondary,
    // ★ M6-4：起始配装的弹药/药品不再是两个数字，而是写在 starterLoadout.carry 网格里。
    //   这里把它们**数出来**派生回 M2 的两个字段名（下游读的还是这两个名字）。
    reserveByAmmo: starterReserveByAmmo(),
    armor: { body: STARTER.body ?? null, head: STARTER.head ?? null },
    consumables: starterConsumables(),
  },
  designTargets: weaponsTable._designTargets,
  armor: combatTable.armor,
  armorRules: combatTable.armorRules,
  hitZones: combatTable.hitZones,
  /** 命中部位名数组（已过滤注释键），供遍历使用 */
  hitZoneNames: dataKeys(combatTable.hitZones),
  consumables: combatTable.consumables,
  playerVitals: PLAYER_VITALS,
  // ---- M5 局外系统的四张表与两张派生视图 ----
  /** 配装表（槽位 / 起始配装 / 携带上限 / 超重惩罚） */
  equipment: equipmentTable,
  /** M6 携行具表（背包 / 弹挂）。**容量的唯一真值**，另见 lootTable.backpack 的 referenceId */
  carry: carryTable,
  /** 经济表（仓库规格 / 买卖价差 / 商店清单 / 通胀参数） */
  economy: economyTable,
  /** 成长表（等级曲线 / 经验规则 / 技能树） */
  progression: progressionTable,
  /** 任务表（目标 / 奖励 / 前置） */
  quests: questsTable,
  /** 物品视图：掉落表物品 ∪ 装备的**物品形态**（同一件事只有一份数值，启动期已交叉校验） */
  itemDefs: ITEM_VIEWS.items,
  /** 装备视图：武器与护甲（按装备 id 索引） */
  equipmentDefs: ITEM_VIEWS.equipmentDefs,
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
    // 形状从 [x, z] 改为对象，因为两个字段丢不得：
    //   floor —— 容器落在不同标高上。M3-1b-2 ④ 只映射 [x,z]，结果二层 44 个容器
    //            被摆到了一层高度，且判定不分层，站在一层能隔层搜二层的箱子。
    //   type  —— 民用/军用/保险箱/钥匙房。掉落分级按它取池（M3-4 接入 07 掉落表时用）。
    //            此前 89 个容器共用 tunables.loot.items 一套权重，价值梯度完全不存在。
    // 单层图（industrial_01）的容器没有 floor 字段，缺省 0 不改变既有行为。
    containers: mapTable.containers.map((c) => ({
      x: c.x,
      z: c.z,
      floor: c.floor || 0,
      type: c.type,
    })),
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
