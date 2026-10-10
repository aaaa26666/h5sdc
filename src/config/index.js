// 配置装配与校验
//
// 依据《流程文档》第 8.3 节：配置表必须提供结构校验，包含**引用完整性**检查。
// 为什么必须在启动时校验而不是等运行时报错：
//   武器表里写错一个 ammoType，如果只在开火时才去查表，那要等到玩家捡到那把枪、
//   打光一梭子才会崩 —— 这类问题在自动化测试里也很难覆盖到每条分支。
//   启动即校验可以把"表写错"变成"启动就报错并指出是哪一行"。
//
// 校验失败一律抛错并中止启动。配置错误属于开发期错误，静默降级只会让它更晚被发现。

// 注意：这里显式使用 import attributes（with { type: 'json' }）。
// 原因是本文件必须**同时**能在浏览器（Vite）和 Node（tools/ttk.mjs 等纯函数工具）里加载。
// 若只写 `import x from './x.json'`，Vite 可以但 Node 会拒绝，
// 于是工具侧就只能自己再拼一份配置 —— 那会造成两份装配逻辑分叉，
// 而"两处各算一份"正是本项目反复踩过的坑。
import tunables from './tunables.json' with { type: 'json' };
import weaponsTable from './weapons.json' with { type: 'json' };
import combatTable from './combat.json' with { type: 'json' };
import aiTable from './ai.json' with { type: 'json' };

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
  // 这里刻意不用"1e6 之类拍脑袋的阈值"，而是从关卡配置算出真实最大距离 ——
  // 否则规则看起来在检查什么，其实只是检查了作者有没有写一个很大的数。
  const lv = tunables.level;
  const levelDiagonalM = Math.hypot(lv.gridW * lv.cell, lv.gridH * lv.cell);
  const upd = aiTable.updateTiers;
  for (let i = 1; i < upd.length; i++) {
    if (upd[i].maxDistanceM <= upd[i - 1].maxDistanceM) {
      fail('ai.updateTiers 必须按 maxDistanceM 严格升序');
    }
  }
  if (upd[upd.length - 1].maxDistanceM < levelDiagonalM) {
    fail(
      `ai.updateTiers 最后一项 maxDistanceM=${upd[upd.length - 1].maxDistanceM} ` +
        `小于关卡几何最大距离 ${levelDiagonalM.toFixed(1)}m —— 会有 AI 落不进任何分级`
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
}

validate();

export const config = {
  ...tunables,
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
