// AI 表校验器（M6-2 硬性要求："每新增一类 AI 必须同步更新配置表与校验规则"）
//
// 为什么是独立工具而不是塞进 config/index.js：
//   config 的启动期校验守的是"能不能跑起来"（引用存在、数值为正）；
//   本工具守的是"这张表是否**讲得通**"——兵种之间有没有真正的差异、
//   Boss 是不是真的更强、尸体掉落表是否配齐。后者属设计约束，
//   不该让游戏因为"设计没想清楚"而启动失败。
//
// ★ 组织方式（与 validate-loot-tables.mjs 的差异）：校验规则是**纯函数**，
//   `--self-test` 在**同进程内**注入坏数据并断言规则会失败 —— 不起子进程。
//   原因：本沙箱禁用 spawnSync（EBUSY），而靠起子进程的注入自检在那种环境下
//   会静默变成"全部未触发"的假绿（inject-loot-table-tests.mjs 就踩过）。
//   把注入做成纯函数调用，是**为环境约束做的正当适配**，不是放宽检查。
//
// 用法：
//   node tools/validate-ai-tables.mjs              # 校验真实表
//   node tools/validate-ai-tables.mjs --self-test  # 注入自检（证明每条规则真的会失败）

import { config } from '../src/config/index.js';

/** 数值必须为正的字段（缺一项都可能让 AI 在局内静止或永不开火） */
const POSITIVE = [
  'maxHealth', 'moveSpeed', 'viewRange', 'viewAngleDeg', 'reactMs', 'aimTimeMs',
  'accuracyDeg', 'burstShots', 'fireIntervalMs', 'fireRange', 'damagePerShot',
  'searchDurationMs', 'armorPen',
];

/**
 * 校验 AI 表。纯函数：不读文件、不打印、不改入参。
 * @returns {{checks: Array<{name:string, ok:boolean, detail:string}>}}
 */
export function validateAiTable(aiTable, lootTable, armorList, weaponList) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const tiers = aiTable.tiers;
  const ids = tiers.map((t) => t.id);

  add('兵种 id 唯一', new Set(ids).size === ids.length, ids.join(','));

  // ---- 数值合法性 ----
  for (const t of tiers) {
    const bad = POSITIVE.filter((k) => !(t[k] > 0));
    add(`[${t.id}] 关键数值均为正`, bad.length === 0, bad.length ? `非法：${bad.join(',')}` : '');
  }

  // ---- 引用完整性 ----
  const armorIds = new Set(armorList.map((a) => a.id));
  for (const t of tiers) {
    const refs = Object.values(t.armor || {});
    const bad = refs.filter((r) => r && !armorIds.has(r));
    add(`[${t.id}] 护甲引用存在`, bad.length === 0, bad.join(','));
  }

  const weaponIds = new Set(weaponList.map((w) => w.id));
  for (const t of tiers) {
    if (!t.weaponId) continue;
    add(`[${t.id}] 声明的真实武器存在`, weaponIds.has(t.weaponId), `${t.weaponId}`);
  }
  // 只有 Boss 能拿真实武器：其它档走伪武器，"谁都能拿真枪"会让 15 个 AI 全部超模
  const nonBossWithWeapon = tiers.filter((t) => t.id !== 'boss' && t.weaponId).map((t) => t.id);
  add('只有 Boss 档声明 weaponId', nonBossWithWeapon.length === 0, nonBossWithWeapon.join(','));

  // ---- 尸体掉落表：**每档都必须配齐** ----
  // 没有它，击杀就是"只计数、不掉东西"——搜打撤里"打"的收益为零
  const corpse = lootTable.corpseByTier || {};
  const rarityIds = new Set(lootTable.rarity.map((r) => r.id));
  const missingCorpse = tiers.filter((t) => !corpse[t.id]).map((t) => t.id);
  add('每档都有尸体掉落表', missingCorpse.length === 0, missingCorpse.join(','));
  for (const t of tiers) {
    const c = corpse[t.id];
    if (!c) continue;
    const badRarity = Object.keys(c.rarityWeights || {}).filter((k) => !rarityIds.has(k));
    add(`[${t.id}] 尸体掉落的稀有度名合法`, badRarity.length === 0, badRarity.join(','));
    const sum = Object.values(c.rarityWeights || {}).reduce((a, b) => a + b, 0);
    add(`[${t.id}] 尸体掉落权重非全零`, sum > 0, `总和 ${sum}`);
    add(`[${t.id}] 尸体件数区间合法`, c.itemsMin >= 0 && c.itemsMax >= c.itemsMin,
      `${c.itemsMin}~${c.itemsMax}`);
  }

  // ---- 设计约束：兵种之间必须真的有差异 ----
  // 否则"新增一档"只是换了个名字 —— 这类"看起来加了内容"的空档最难在试玩前发现
  const by = Object.fromEntries(tiers.map((t) => [t.id, t]));
  const cmp = (name, ok, detail) => add(name, ok, detail);
  if (by.heavy && by.guard) {
    cmp('重装兵比守卫更肉', by.heavy.maxHealth > by.guard.maxHealth,
      `${by.heavy.maxHealth} vs ${by.guard.maxHealth}`);
    cmp('重装兵比守卫更慢', by.heavy.moveSpeed < by.guard.moveSpeed,
      `${by.heavy.moveSpeed} vs ${by.guard.moveSpeed}`);
    cmp('重装兵射程比守卫更短', by.heavy.fireRange < by.guard.fireRange,
      `${by.heavy.fireRange} vs ${by.guard.fireRange}`);
  }
  if (by.sniper && by.guard) {
    cmp('狙击手射程显著更远（≥1.5×守卫）', by.sniper.fireRange >= by.guard.fireRange * 1.5,
      `${by.sniper.fireRange} vs ${by.guard.fireRange}`);
    cmp('狙击手比守卫更脆', by.sniper.maxHealth < by.guard.maxHealth,
      `${by.sniper.maxHealth} vs ${by.guard.maxHealth}`);
    cmp('狙击手单发更高', by.sniper.damagePerShot > by.guard.damagePerShot,
      `${by.sniper.damagePerShot} vs ${by.guard.damagePerShot}`);
  }
  if (by.boss && by.elite) {
    cmp('Boss 血量高于精英（制作人裁定"血量翻倍"）',
      by.boss.maxHealth >= by.elite.maxHealth * 2, `${by.boss.maxHealth} vs 精英 ${by.elite.maxHealth}`);
    // 护甲要"更好" —— 用 class 比大小，而不是比 id 字符串
    const cls = (id) => (armorList.find((a) => a.id === id) || { class: -1 }).class;
    const bossBody = cls((by.boss.armor || {}).body);
    const bestNonBoss = Math.max(
      ...tiers.filter((t) => t.id !== 'boss').map((t) => cls((t.armor || {}).body))
    );
    cmp('Boss 护甲优于所有非 Boss 档', bossBody > bestNonBoss,
      `Boss 胸甲 class=${bossBody}，非 Boss 最高 ${bestNonBoss}`);
  }

  // ---- 配额口径 ----
  const bossCount = aiTable.spawnRules.bossCount ?? 0;
  cmp('bossCount 为非负整数', Number.isInteger(bossCount) && bossCount >= 0, `${bossCount}`);
  if (by.boss) {
    cmp('Boss 的 weight 必须为 0（走独立配额，不进普通权重池）', by.boss.weight === 0, `${by.boss.weight}`);
  }
  const normalWeight = tiers.filter((t) => t.id !== 'boss').reduce((a, t) => a + (t.weight || 0), 0);
  cmp('普通档权重总和为正', normalWeight > 0, `${normalWeight}`);
  cmp('普通档至少 3 档（否则"难度分级"名不副实）',
    tiers.filter((t) => t.id !== 'boss').length >= 3,
    `${tiers.filter((t) => t.id !== 'boss').length} 档`);

  return { checks };
}

// ---------------------------------------------------------------------------
const HERE_TIERS = { tiers: config.aiTiers, spawnRules: config.aiSpawn };

function runReal() {
  const { checks } = validateAiTable({ tiers: config.aiTiers, spawnRules: config.aiSpawn }, config.lootTable, config.armor, config.weapons);
  const failed = checks.filter((c) => !c.ok);
  console.log('\n================ AI 表校验（M6-2）================\n');
  for (const c of checks) {
    if (!c.ok) console.log(`  [FAIL] ${c.name}${c.detail ? '  —— ' + c.detail : ''}`);
  }
  console.log(`  校验项 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log('\n  失败明细：');
    for (const f of failed) console.log(`    [FAIL] ${f.name}  —— ${f.detail}`);
    process.exit(1);
  }
  console.log('  全部通过。\n');
}

/**
 * 注入自检：逐条把某个规则**故意弄坏**，断言它确实会报失败。
 * 一个从不失败的检查等于没有检查 —— 这组用例就是用来证明"它真的会失败"。
 */
function runSelfTest() {
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const base = () => clone(HERE_TIERS);
  const corpse = () => clone(config.lootTable.corpseByTier);
  const CASES = [
    ['兵种 id 重复', (t) => { t.tiers[1].id = t.tiers[0].id; }],
    ['数值改负', (t) => { t.tiers[0].maxHealth = -1; }],
    ['护甲引用不存在的 id', (t) => { t.tiers[0].armor.body = 'vest_不存在'; }],
    ['真实武器引用不存在的 id', (t) => { t.tiers.find((x) => x.id === 'boss').weaponId = 'no_such_gun'; }],
    ['非 Boss 档声明 weaponId', (t) => { t.tiers[0].weaponId = 'rifle_m4'; }],
    ['某档删掉尸体掉落表', (t, c) => { delete c.scav; }],
    ['尸体权重全零', (t, c) => { c.guard.rarityWeights = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 }; }],
    ['尸体件数区间倒挂', (t, c) => { c.elite.itemsMin = 5; }],
    ['重装兵变得比守卫更脆', (t) => { t.tiers.find((x) => x.id === 'heavy').maxHealth = 50; }],
    ['狙击手射程缩短到与守卫相当', (t) => { t.tiers.find((x) => x.id === 'sniper').fireRange = 38; }],
    ['Boss 血量没有翻倍', (t) => { t.tiers.find((x) => x.id === 'boss').maxHealth = 140; }],
    ['Boss 护甲不再是最好', (t) => { t.tiers.find((x) => x.id === 'boss').armor.body = 'vest2'; }],
    ['Boss 混进普通权重池', (t) => { t.tiers.find((x) => x.id === 'boss').weight = 10; }],
    ['所有普通档权重归零', (t) => { for (const x of t.tiers) if (x.id !== 'boss') x.weight = 0; }],
  ];

  console.log('\n================ AI 表校验器 · 注入自检 ================\n');
  let pass = 0;
  for (const [name, mutate] of CASES) {
    const t = base();
    const c = corpse();
    const before = validateAiTable({ tiers: t.tiers, spawnRules: t.spawnRules }, config.lootTable, config.armor, config.weapons).checks;
    mutate(t, c);
    const loot = { ...config.lootTable, corpseByTier: c };
    const after = validateAiTable({ tiers: t.tiers, spawnRules: t.spawnRules }, loot, config.armor, config.weapons).checks;
    const failedBefore = new Set(before.filter((x) => !x.ok).map((x) => x.name));
    const newlyFailed = after.filter((x) => !x.ok && !failedBefore.has(x.name));
    const ok = newlyFailed.length > 0;
    if (ok) pass++;
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] 注入「${name}」→ ${ok ? '被抓住' : '**未被抓住**'}${ok ? '' : '  ← 这条规则是假的'}`);
    if (ok) console.log(`         触发：${newlyFailed.map((x) => x.name).join('；')}`);
  }
  console.log(`\n  注入自检 ${pass} / ${CASES.length} 条被正确抓住`);
  if (pass !== CASES.length) process.exit(1);
}

if (process.argv.includes('--self-test')) runSelfTest();
else runReal();
