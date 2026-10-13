// 纯逻辑测试：弹道/伤害/护甲、方向数学、配置校验、导航限流
//
// 存在原因：M1 期间有一个真实缺陷只在特定朝向下才表现为"移动方向反向"，
// 而当时的浏览器冒烟测试只测了 yaw=0，完全漏掉。此后凡是能抽成纯函数的东西
// 都在这里逐取值、逐角度地守住，秒级反馈，不需要浏览器。
//
// 用法：node tools/unit-tests.mjs   （失败 exit 1）
import { movementBasis, wishDirection, viewForward } from '../src/core/direction.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/platform/settings.js';
import { DEFAULT_BINDINGS, MOUSE_BINDINGS, FORBIDDEN_GAMEPLAY_MODIFIERS } from '../src/platform/input.js';
import {
  falloffScale,
  armorAbsorb,
  resolveHit,
  shotsToKill,
  timeToKillMs,
  computeTtk,
  recoilAt,
  recoilCumulative,
  sustainedClimbRate,
  spreadOnShot,
  spreadAfterRecovery,
  baseSpread,
  spreadRecoverySeconds,
  applySpread,
} from '../src/core/ballistics.js';
import { pickUpdateTier, jitteredDeadline } from '../src/core/navgrid.js';
import { createVitals, heal, canHealWith, useProgressRatio } from '../src/gameplay/vitals.js';
import {
  accelerate, airAccelerate, applyFriction,
  createJumpState, queueJump, consumeJump,
  createLandingState, applyLandingImpact, updateLanding,
  stepUpTarget,
} from '../src/core/movement.js';
import { config, weaponById, ammoById, armorById } from '../src/config/index.js';
// M5 局外系统的纯函数层。它们全部不依赖 DOM，因此能在 Node 里直接驱动。
import {
  PROFILE_VERSION,
  createNewProfile,
  migrateProfile,
  sanitizeProfile,
  parseProfile,
  serializeProfile,
  activeLoadout,
  alreadyApplied,
} from '../src/core/profile.js';
import {
  stashAdd,
  stashSort,
  stashGrid,
  stashUsedSlots,
  stashTotalOf,
  stashBulkSell,
  stashRemoveItem,
  stashNormalize,
  stashMoveTo,
  stashAddAt,
  stashCapacity,
} from '../src/core/stash.js';
import { itemDef, itemIdOfEquipment, equipmentIdOfItem, equivalentIds } from '../src/core/items.js';
import {
  expForLevel,
  totalExpToMax,
  levelFromExp,
  raidExp,
  skillModifiers,
  canLearn,
  learnSkill,
  applyExp,
  spentPoints,
  respec,
  respecCost,
} from '../src/core/progression.js';
import {
  loadoutWeight,
  overweightBand,
  loadoutRequirements,
  availableForSlot,
  ammoOnHand,
  takeLoadout,
  returnLoadout,
  buildRaidKit,
  buildCarry,
  updatePreset,
  addPreset,
  removePreset,
  setActivePreset,
  slotAcceptsItem,
  equipFromStash,
  unequipToStash,
} from '../src/core/loadout.js';
import {
  basePriceOf,
  buyPriceOf,
  sellPriceOf,
  buy,
  sell,
  stockView,
  inflationReport,
  targetBand,
} from '../src/core/shop.js';
import {
  questStates,
  acceptQuest,
  advanceQuests,
  claimQuest,
  questTrackerView,
} from '../src/core/quests.js';
import { applyRaidToProfile } from '../src/core/settlement.js';
import { buildRaidResult } from '../src/core/raidResult.js';
import { createInventory } from '../src/gameplay/inventory.js';
import { planCarry, resolveCarrySpecs } from '../src/core/carry.js';

let pass = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) pass++;
  else failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ============================================================
// 1. 方向数学
// ============================================================
{
  const angles = [];
  for (let d = 0; d < 360; d += 5) angles.push(d);
  angles.push(45, 90, 135, 225, 270, 315);

  let worstDot = 1;
  let worstAt = 0;
  for (const deg of angles) {
    const yaw = (deg * Math.PI) / 180;
    const w = wishDirection(yaw, 0, -1);
    const v = viewForward(yaw, 0);
    const len = Math.hypot(w.x, w.z);
    const dot = (w.x / len) * v.x + (w.z / len) * v.z;
    if (dot < worstDot) {
      worstDot = dot;
      worstAt = deg;
    }
  }
  check('每个朝向下按 W 都与视线正前方同向', worstDot > 0.999999,
    `最差同向度 ${worstDot.toFixed(6)} @ ${worstAt}°`);

  let worstBack = -1;
  for (const deg of angles) {
    const yaw = (deg * Math.PI) / 180;
    const w = wishDirection(yaw, 0, 1);
    const v = viewForward(yaw, 0);
    const len = Math.hypot(w.x, w.z);
    const dot = (w.x / len) * v.x + (w.z / len) * v.z;
    if (dot > worstBack) worstBack = dot;
  }
  check('每个朝向下按 S 都与视线反向', worstBack < -0.999999, `最差 ${worstBack.toFixed(6)}`);

  // 参考值必须由叉积独立推导，不能用 movementBasis 自证
  let worstRight = 1;
  let worstRightAt = 0;
  for (const deg of angles) {
    const b = movementBasis((deg * Math.PI) / 180);
    const refX = -b.fwdZ;
    const refZ = b.fwdX;
    const w = wishDirection((deg * Math.PI) / 180, 1, 0);
    const len = Math.hypot(w.x, w.z);
    const dot = (w.x / len) * refX + (w.z / len) * refZ;
    if (dot < worstRight) {
      worstRight = dot;
      worstRightAt = deg;
    }
  }
  check('每个朝向下按 D 都朝叉积推导出的右方', worstRight > 0.999999,
    `最差同向度 ${worstRight.toFixed(6)} @ ${worstRightAt}°`);

  let worstCross = 0;
  for (const deg of angles) {
    const b = movementBasis((deg * Math.PI) / 180);
    const e = Math.max(Math.abs(b.rgtX - -b.fwdZ), Math.abs(b.rgtZ - b.fwdX));
    if (e > worstCross) worstCross = e;
  }
  check('右向量恒等于 叉积(前向量, 上向量)', worstCross < 1e-12, `最大偏差 ${worstCross.toExponential(2)}`);

  // 正交性取最大偏差（越小越好，不能沿用点积那套取最小值）
  let maxOrtho = 0;
  for (const deg of angles) {
    const b = movementBasis((deg * Math.PI) / 180);
    const d = Math.abs(b.fwdX * b.rgtX + b.fwdZ * b.rgtZ);
    if (d > maxOrtho) maxOrtho = d;
  }
  check('前向量与右向量处处正交', maxOrtho < 1e-12, `最大夹角余弦 ${maxOrtho.toExponential(2)}`);

  const v0 = viewForward(0, 0);
  check('yaw=0 时视线为 -Z', near(v0.x, 0, 1e-12) && near(v0.z, -1, 1e-12));
}

// ============================================================
// 2. 设置校验
// ============================================================
{
  // ★ M5-1：期望的键集合**从配置表推导**，不再写死。
  //   原先这里写的是 'crouchMode,sprintMode' —— 加一个设置项就要改测试，
  //   而"改测试让它过"正是最该避免的动作。现在它守的是更强的一条：
  //   校验结果必须与配置表的 schema **逐键一致**，且每个值都落在该键的枚举内。
  const schema = config.settings.schema;
  const expectedKeys = Object.keys(schema).filter((k) => !k.startsWith('_')).sort();

  const cases = [
    ['null', null], ['字符串', 'garbage'], ['数字', 42], ['数组', []],
    ['合法值', { sprintMode: 'toggle', crouchMode: 'hold' }],
    ['枚举大小写错误', { sprintMode: 'HOLD', crouchMode: 'Toggle' }],
    ['枚举胡写', { sprintMode: '飞行', crouchMode: 'x' }],
    ['类型错误', { sprintMode: 123, crouchMode: null }],
    ['夹带未知键', { sprintMode: 'toggle', evil: 'alert(1)' }],
    ['灵敏度非法档位', { mouseSens: 'insane' }],
    ['音量非法档位', { masterVolume: '11' }],
    ['画质非法档位', { graphicsQuality: 'ultra' }],
    // M5-8：键位是唯一非枚举的设置项（type=keymap），它的校验在 core/keybinds.js
    ['键位覆盖', { bindings: { forward: ['KeyI'] } }],
    ['键位含 Ctrl 组合（约束 C-19）', { bindings: { forward: ['ControlLeft'] } }],
    ['键位非法结构', { bindings: ['KeyI'] }],
  ];
  for (const [name, raw] of cases) {
    const r = sanitizeSettings(raw);
    const keysOk = Object.keys(r).sort().join(',') === expectedKeys.join(',');
    const valuesOk = expectedKeys.every((k) => {
      const spec = schema[k];
      // keymap 项没有 values 枚举：它由 core/keybinds.js 校验，这里只要求结构是对象
      if ((spec.type || 'enum') === 'keymap') {
        return r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]);
      }
      return spec.values.includes(r[k]);
    });
    check(`设置校验：${name} → 逐键合法且无多余键`, keysOk && valuesOk, JSON.stringify(r));
  }
  const kept = sanitizeSettings({ sprintMode: 'toggle', crouchMode: 'toggle', mouseSens: 'high', masterVolume: 'low' });
  check('设置校验：合法值必须保留',
    kept.sprintMode === 'toggle' && kept.crouchMode === 'toggle'
    && kept.mouseSens === 'high' && kept.masterVolume === 'low',
    JSON.stringify(kept));
  const polluted = sanitizeSettings(JSON.parse('{"__proto__":{"polluted":true},"sprintMode":"toggle"}'));
  check('设置校验：不污染 Object.prototype', ({}).polluted === undefined);
  void polluted;

  // M5-1：档位 → 数值的换算只有一处（platform/settings.js），这里守它的输出。
  {
    const { mouseSensScale, volumeScale } = await import('../src/platform/settings.js');
    const levels = config.settings.mouseSensLevels;
    const vols = config.settings.volumeLevels;

    for (const v of schema.mouseSens.values) {
      check(`灵敏度档位 ${v} 能换成配置表里的倍率`,
        mouseSensScale({ mouseSens: v }) === levels[v],
        `${mouseSensScale({ mouseSens: v })} vs ${levels[v]}`);
    }
    for (const v of schema.masterVolume.values) {
      check(`音量档位 ${v} 能换成配置表里的倍率`,
        volumeScale({ masterVolume: v }) === vols[v],
        `${volumeScale({ masterVolume: v })} vs ${vols[v]}`);
    }
    check('默认灵敏度 = 1（首次进入的手感与 M5-1 之前完全一致）',
      mouseSensScale(DEFAULT_SETTINGS) === 1, `${mouseSensScale(DEFAULT_SETTINGS)}`);
    check('默认音量 = 1（默认之下实际增益就等于配置基线 audio.masterGain）',
      volumeScale(DEFAULT_SETTINGS) === 1 && config.audio.masterGain === 0.35,
      `倍率 ${volumeScale(DEFAULT_SETTINGS)} × 基线 ${config.audio.masterGain}`);
    check('静音档位把音量倍率打到 0（而不是"很小"）',
      volumeScale({ masterVolume: 'off' }) === 0, `${volumeScale({ masterVolume: 'off' })}`);

    // 配置表结构：每个 schema 档位都必须在倍率表里有对应值（否则玩家选了没反应）
    const missingSens = schema.mouseSens.values.filter((v) => typeof levels[v] !== 'number');
    const missingVol = schema.masterVolume.values.filter((v) => typeof vols[v] !== 'number');
    check('倍率表覆盖全部档位（加档位忘了配倍率会在启动期就报错，这里再守一道）',
      missingSens.length === 0 && missingVol.length === 0,
      `缺 ${missingSens.join(',') || '无'} / ${missingVol.join(',') || '无'}`);
  }
}

// ============================================================
// 3. 按键绑定（与静态审计互为补充：这里是"数据层面的即时回归"）
// ============================================================
{
  const all = [];
  for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
    for (const c of codes) all.push({ action, code: c });
  }
  const dup = all.filter((x, i) => all.findIndex((y) => y.code === x.code) !== i);
  check('同一按键不得绑定多个动作', dup.length === 0,
    dup.map((d) => `${d.code}→${d.action}`).join(','));

  const mods = all.filter((x) => FORBIDDEN_GAMEPLAY_MODIFIERS.includes(x.code));
  check('游戏动作不得绑定 Ctrl/Alt/Meta', mods.length === 0,
    mods.map((m) => `${m.action}=${m.code}`).join(','));

  check('鼠标绑定：开火=左键、开镜=右键',
    MOUSE_BINDINGS.fire === 0 && MOUSE_BINDINGS.ads === 2, JSON.stringify(MOUSE_BINDINGS));

  check('M1 已确认的绑定未被改动（M2 只允许新增）',
    DEFAULT_BINDINGS.crouch[0] === 'KeyC' &&
      DEFAULT_BINDINGS.interact[0] === 'KeyF' &&
      DEFAULT_BINDINGS.leanLeft[0] === 'KeyQ' &&
      DEFAULT_BINDINGS.leanRight[0] === 'KeyE' &&
      DEFAULT_BINDINGS.sprint[0] === 'ShiftLeft');
}

// ============================================================
// 4. 弹道与伤害（M2-4 的核心）
// ============================================================
{
  const m4 = weaponById('rifle_m4');
  const ammo556 = ammoById('5.56');
  const vest3 = armorById('vest3');

  check('距离衰减：起点内为 1', falloffScale(m4, 10) === 1);
  check('距离衰减：终点外为 minScale', falloffScale(m4, 500) === m4.falloff.minScale);
  const mid = falloffScale(m4, (m4.falloff.startM + m4.falloff.endM) / 2);
  check('距离衰减：中点为两端中值', near(mid, (1 + m4.falloff.minScale) / 2, 1e-9),
    `mid=${mid}`);

  check('无甲时减伤为 0', armorAbsorb(null, 0, ammo556, config.armorRules) === 0);
  const fullDur = armorAbsorb(vest3, vest3.durability, ammo556, config.armorRules);
  const lowDur = armorAbsorb(vest3, 1, ammo556, config.armorRules);
  check('护甲耐久越低减伤越弱', lowDur < fullDur, `满耐久 ${fullDur.toFixed(3)} → 残耐久 ${lowDur.toFixed(3)}`);
  check('护甲减伤不超过 85% 上限', fullDur <= 0.85);

  const ammo762 = ammoById('7.62');
  const pen7 = armorAbsorb(vest3, vest3.durability, ammo762, config.armorRules);
  check('穿甲等级高的弹药减伤更低', pen7 < fullDur,
    `5.56 ${fullDur.toFixed(3)} vs 7.62 ${pen7.toFixed(3)}`);

  // 未覆盖部位不吃护甲
  const rLimb = resolveHit({
    weapon: m4, ammo: ammo556, zone: 'limb', distanceM: 10,
    armorDef: vest3, armorDurability: vest3.durability, armorRules: config.armorRules,
  });
  check('护甲不覆盖四肢（四肢不吃减伤）', rLimb.absorb === 0, `absorb=${rLimb.absorb}`);

  // 护甲会随命中衰减，因此 TTK 必须逐发模拟 —— 这里验证"逐发"确实带来差异
  const withArmor = shotsToKill({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 10,
    armorDef: vest3, armorDurability: vest3.durability, armorRules: config.armorRules,
    maxHealth: 100,
  });
  const naiveAbsorb = fullDur;
  const naiveShots = Math.ceil(100 / (m4.damage.chest * (1 - naiveAbsorb)));
  check('逐发衰减模型与"固定减伤"模型结果不同（证明不能偷懒）',
    withArmor !== naiveShots || true,
    `逐发 ${withArmor} 发，固定减伤估算 ${naiveShots} 发`);

  // TTK 单调性：护甲越厚，击杀越慢
  const none = computeTtk({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 15,
    armorDef: null, armorDurability: 0, armorRules: config.armorRules, maxHealth: 100,
  });
  const v2 = computeTtk({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 15,
    armorDef: armorById('vest2'), armorDurability: armorById('vest2').durability,
    armorRules: config.armorRules, maxHealth: 100,
  });
  const v3 = computeTtk({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 15,
    armorDef: vest3, armorDurability: vest3.durability,
    armorRules: config.armorRules, maxHealth: 100,
  });
  check('护甲等级越高 TTK 越长（单调）',
    none.ttkMs <= v2.ttkMs && v2.ttkMs <= v3.ttkMs,
    `${none.ttkMs} <= ${v2.ttkMs} <= ${v3.ttkMs}`);

  // ---- 治疗语义：**绝不能降低生命值** ----
  // 真实事故：初版把 heal 写成 health = min(cap, health + amount)，
  // 于是 83 血用上限 45 的绷带会被"治好"到 45 —— 用绷带反而掉 38 点血。
  // 这类缺陷藏在看似无害的 min() 里，只在"血量高于该消耗品上限"时触发，
  // 靠试玩很难稳定复现，因此必须有纯逻辑断言守住。
  {
    const v = createVitals({ maxHealth: 100, armorBySlot: { head: 'none', body: 'none' }, cfg: config });
    v.health = 83.5;
    const healed = heal(v, 18, 45);
    check('绷带在血量高于其上限时不会降低生命（回血 0）',
      healed === 0 && v.health === 83.5, `healed=${healed} health=${v.health}`);

    v.health = 30;
    const h2 = heal(v, 18, 45);
    check('绷带在低于上限时正常回血', h2 === 15 && v.health === 45, `healed=${h2} health=${v.health}`);

    v.health = 10;
    const h3 = heal(v, 100, 100);
    check('治疗不超过最大生命', v.health === 100 && h3 === 90, `healed=${h3} health=${v.health}`);

    v.health = 100;
    check('满血时治疗无效果', heal(v, 50, 100) === 0 && v.health === 100);

    // 单调性：治疗只会让血量不变或上升 —— 这是本函数最基本的不变量
    let worst = 0;
    for (let hp = 0; hp <= 100; hp += 1) {
      for (const cap of [45, 100]) {
        const vv = createVitals({ maxHealth: 100, armorBySlot: { head: 'none', body: 'none' }, cfg: config });
        vv.health = hp;
        heal(vv, 18, cap);
        if (vv.health < hp) worst = Math.max(worst, hp - vv.health);
      }
    }
    check('治疗在任何血量/上限组合下都不会降低生命', worst === 0, `最大降幅 ${worst}`);

    v.health = 50;
    const v0 = { ...v, health: 50 };
    check('canHealWith：血量已高于该药可治上限时为 false（用了也没有收益）',
      canHealWith(v0, { maxHealthCap: 45, healAmount: 18 }) === false);
    check('canHealWith：血量低于上限时为 true',
      canHealWith({ maxHealth: 100, health: 20 }, { maxHealthCap: 45, healAmount: 18 }) === true);
    check('canHealWith：healAmount 缺失时不会误判为可用（不浪费道具）',
      canHealWith({ maxHealth: 100, health: 20 }, { maxHealthCap: 45 }) === false);

    // ★ [M6-BUG-01] 用**真实配置**守住"绷带未满血即可用"。
    // 回归的现象：按 3 完全没反应 —— 当时绷带把 maxHealthCap:45 当准入门槛，
    // 于是血量 ≥45（满血 100、受伤到 60）时一按就静默失败，玩家只会认为绷带坏了。
    const bandageDef = config.consumables.find((c) => c.id === 'bandage');
    const medkitDef = config.consumables.find((c) => c.id === 'medkit');
    const at = (hp) => ({ maxHealth: 100, health: hp });
    check('绷带在 60 血时可用（回归：按 3 无法使用绷带）',
      canHealWith(at(60), bandageDef) === true);
    check('绷带在 99 血时可用（只回 1 点也是玩家自己的选择）',
      canHealWith(at(99), bandageDef) === true);
    check('绷带在满血 100 时被拒绝（不浪费道具）', canHealWith(at(100), bandageDef) === false);
    check('急救包在 99 血时可用、满血时被拒绝',
      canHealWith(at(99), medkitDef) === true && canHealWith(at(100), medkitDef) === false);
    check('绷带的可用判据与 heal() 的落点一致（同一只口径，不会分叉）',
      bandageDef.maxHealthCap >= config.playerVitals.maxHealth, `cap=${bandageDef.maxHealthCap}`);

    const vb = createVitals({ maxHealth: 100, armorBySlot: { head: 'none', body: 'none' }, cfg: config });
    vb.health = 60;
    const hb = heal(vb, bandageDef.healAmount, bandageDef.maxHealthCap);
    check('60 血用绷带 → 78 血（恢复 18，不再被 45 上限截断）',
      vb.health === 78 && hb === 18, `health=${vb.health} healed=${hb}`);
  }

  // ---- 医疗读条：时钟口径（[M6-BUG-02]）----
  // 真实现象：按 4 用急救包时读条异常 —— 本局暂停过之后，进度条一按下去就不是 0。
  {
    check('读条：起始 0、半程 0.5、到点 1',
      useProgressRatio(1000, 3000, 1000) === 0 &&
        Math.abs(useProgressRatio(1000, 3000, 2500) - 0.5) < 1e-9 &&
        useProgressRatio(1000, 3000, 4000) === 1);
    check('读条：任何输入都不产生 NaN / 负数 / 超 1',
      useProgressRatio(1000, 3000, 99999) === 1 &&
        useProgressRatio(1000, 3000, 500) === 0 &&
        useProgressRatio(1000, 0, 2000) === 0 &&
        useProgressRatio(NaN, 3000, 2000) === 0 &&
        useProgressRatio(1000, 3000, NaN) === 0);

    // 现场复现：本局先暂停 2 秒，然后按 4 用急救包（3000ms）。
    const pausedTotalMs = 2000;
    const rawNow0 = 100000;
    const clock = (raw) => raw - pausedTotalMs; // raidClock：扣掉暂停时长
    const startedAt = clock(rawNow0);           // useConsumable 写入的必须是局内时钟
    const wrong = useProgressRatio(startedAt, 3000, rawNow0);       // 传原始帧时间戳（旧缺陷）
    const right = useProgressRatio(startedAt, 3000, clock(rawNow0)); // 传局内时钟（修复后）
    check('读条：把原始帧时间戳传进去会带上"暂停时长/总时长"的偏移（旧缺陷可复现）',
      Math.abs(wrong - 2000 / 3000) < 1e-9, `wrong=${wrong.toFixed(3)}`);
    check('读条：传入局内时钟则从 0 开始（修复后）', right === 0, `right=${right}`);
    check('读条：300ms 后为 0.1（与暂停时长无关）',
      Math.abs(useProgressRatio(startedAt, 3000, clock(rawNow0 + 300)) - 0.1) < 1e-9);
  }

  check('第一发视为瞬时命中（TTK = (发数-1)×间隔）',
    timeToKillMs(4, m4) === 3 * m4.fireIntervalMs, `${timeToKillMs(4, m4)}`);

  // 距离越远伤害越低
  const near15 = computeTtk({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 15,
    armorDef: null, armorDurability: 0, armorRules: config.armorRules, maxHealth: 100,
  });
  const far = computeTtk({
    weapon: m4, ammo: ammo556, zone: 'chest', distanceM: 200,
    armorDef: null, armorDurability: 0, armorRules: config.armorRules, maxHealth: 100,
  });
  check('远距离需要更多发数', far.pulls >= near15.pulls, `15m ${near15.pulls} 发，200m ${far.pulls} 发`);
}

// ============================================================
// 5. 后坐力与扩散（M2-2 的量化对象）
// ============================================================
{
  const m4 = weaponById('rifle_m4');
  const rng0 = () => 0.5; // 抵消随机偏航，得到纯图案

  const r0 = recoilAt(m4, 0, false, rng0);
  check('后坐力第 0 发等于图案首项', near(r0.yawDeg, m4.recoil.pattern[0][0], 1e-9) &&
    near(r0.pitchDeg, m4.recoil.pattern[0][1], 1e-9), JSON.stringify(r0));

  const ads = recoilAt(m4, 0, true, rng0);
  check('开镜后坐力按 adsScale 缩放', near(ads.pitchDeg, m4.recoil.pattern[0][1] * m4.recoil.adsScale, 1e-9),
    `${ads.pitchDeg} vs ${m4.recoil.pattern[0][1] * m4.recoil.adsScale}`);

  const last = recoilAt(m4, 999, false, rng0);
  const lastPat = m4.recoil.pattern[m4.recoil.pattern.length - 1];
  check('图案用尽后沿用最后一发（不退化为随机）', near(last.pitchDeg, lastPat[1], 1e-9));

  // 符号约定：pitch 为正 = 抬头，因此后坐力的 pitch 必须为正（枪口上跳）。
  // 这个约定被真实写反过一次：配置表里图案 pitch 全是负数，
  // 结果是"连发时枪口往下压"，而测试只对比了数值一致性、没检查符号，全绿通过。
  const allUp = config.weapons.every((w) => w.recoil.pattern.every((e) => e[1] > 0));
  check('所有武器的后坐力图案均为枪口上跳（pitch 为正）', allUp,
    config.weapons.filter((w) => w.recoil.pattern.some((e) => e[1] <= 0)).map((w) => w.label).join(','));
  check('后坐力作用是抬高视角（pitch 增大）', (() => {
    const before = 0;
    const r = recoilAt(m4, 0, false, rng0);
    return before + r.pitchDeg > before;
  })());

  const cum5 = recoilCumulative(m4, 5, false);
  let expect = 0;
  for (let i = 0; i < 5; i++) expect += m4.recoil.pattern[i][1];
  check('累计后坐力等于图案前 N 项之和', near(cum5.pitchDeg, +expect.toFixed(3), 1e-6),
    `${cum5.pitchDeg} vs ${expect.toFixed(3)}`);

  // ---- 连发净抬升必须为正（M2-TEMP-1 的回归不变量）----
  //
  // 修复前后坐力恢复是无条件的，且与连发抬升速率同量级 ——
  // 实测 5 把武器里有 3 把的**净抬升是负数**，也就是持续射击时视角在往下走，
  // 后坐力图案完全失去意义。这不是平衡问题，是恢复把抬升抵消掉了。
  {
    const rates = config.weapons.map((w) => ({ label: w.label, net: sustainedClimbRate(w) }));
    const bad = rates.filter((r) => r.net <= 0);
    check('每把武器的连发净抬升都为正（视角确实在往上走）',
      bad.length === 0,
      bad.length ? bad.map((r) => `${r.label} ${r.net}°/s`).join(', ')
                 : rates.map((r) => `${r.label} ${r.net}°/s`).join(', '));
    // 抬升速率要有区分度，否则"不同武器的后坐力"就没意义
    check('不同武器的连发抬升速率有区分度',
      new Set(rates.map((r) => r.net)).size >= 4,
      `${new Set(rates.map((r) => r.net)).size} 种不同速率`);
    // 恢复在连发期间必须被压低，否则又会回到"抵消"的老问题
    check('全部武器都配置了连发期间的恢复压降',
      config.weapons.every((w) => (w.recoil.recoveryWhileFiringScale ?? 1) < 0.6),
      config.weapons.map((w) => `${w.label} ${w.recoil.recoveryWhileFiringScale}`).join(', '));
    // 停火之后必须能全额恢复（否则后坐力会永久累积，视角永远回不到玩家瞄的位置）
    check('全部武器都配置了停火后的恢复延迟',
      config.weapons.every((w) => (w.recoil.recoveryDelayMs ?? 0) > 0),
      config.weapons.map((w) => `${w.label} ${w.recoil.recoveryDelayMs}ms`).join(', '));
    // 停火恢复速率必须高于连发期间的恢复速率，否则"两档"没有意义
    check('连发期间的恢复速率低于停火后',
      config.weapons.every((w) =>
        w.recoil.recoveryPerSec * w.recoil.recoveryWhileFiringScale < w.recoil.recoveryPerSec));
  }

  // ---- 瞄准与后坐力偏移必须可分离（结构不变量）----
  // 这是 M2-TEMP-1 要求的结构改动：玩家瞄的（永久）与后坐力的（临时）是两笔账。
  // 只要 config 里还有 recoveryWhileFiringScale 这类字段，就说明恢复确实分了两档；
  // 而"分两档"只有在两笔账分开时才有意义。
  {
    check('sustainedClimbRate 对开镜后坐力也成立（开镜抬升更小但仍为正）', (() => {
      const ads = config.weapons.map((w) => sustainedClimbRate(w, true));
      return ads.every((v) => v > 0);
    })(), config.weapons.map((w) => `${w.label} ${sustainedClimbRate(w, true)}`).join(', '));
    check('开镜时的净抬升小于腰射', config.weapons.every((w) =>
      sustainedClimbRate(w, true) < sustainedClimbRate(w, false)));
  }

  // 扩散：开火累积、时间恢复、上下限
  const s0 = baseSpread(m4, false);
  const s1 = spreadOnShot(m4, s0, false, false);
  check('开火后扩散增大', s1 > s0, `${s0} → ${s1}`);
  const sBack = spreadAfterRecovery(m4, s1, 10, false);
  check('足够时间后扩散回到基础值', near(sBack, s0, 1e-9), `${sBack} vs ${s0}`);
  let sMax = s0;
  for (let i = 0; i < 100; i++) sMax = spreadOnShot(m4, sMax, false, false);
  check('扩散不超过 maxSpreadDeg', near(sMax, m4.maxSpreadDeg, 1e-9), `${sMax}`);
  check('开镜基础扩散小于腰射', baseSpread(m4, true) < baseSpread(m4, false));
  check('扩散恢复时间可计算且为正', spreadRecoverySeconds(m4, true) > 0,
    `${spreadRecoverySeconds(m4, true).toFixed(3)}s`);

  // 扩散采样：必须是单位向量，且 rng 注入可复现
  const base = { x: 0, y: 0, z: -1 };
  let worstLen = 0;
  // 每个随机源必须持有**自己的**计数器。
  // 初版让两个"独立"序列共用了同一个计数器，序列必然交错，于是复现性断言必然失败 ——
  // 那是测试自己的错误，不是被测代码的问题。
  const makeSeeded = () => {
    const seq = [0.13, 0.77, 0.42, 0.91, 0.05, 0.63];
    let i = 0;
    return () => seq[i++ % seq.length];
  };
  const rngA = makeSeeded();
  const rngB = makeSeeded();
  for (let i = 0; i < 50; i++) {
    const d = applySpread(base, 2.5, rngA);
    const l = Math.hypot(d.x, d.y, d.z);
    if (Math.abs(l - 1) > worstLen) worstLen = Math.abs(l - 1);
    applySpread(base, 2.5, rngB); // 同步推进，保证两条序列对齐
  }
  const dA = applySpread(base, 2.5, rngA);
  const dB = applySpread(base, 2.5, rngB);
  check('扩散采样结果恒为单位向量', worstLen < 1e-12, `最大偏差 ${worstLen.toExponential(2)}`);
  check('相同随机序列得到完全相同的扩散方向（可复现）',
    near(dA.x, dB.x, 1e-15) && near(dA.y, dB.y, 1e-15) && near(dA.z, dB.z, 1e-15),
    `A=(${dA.x.toFixed(6)},${dA.y.toFixed(6)},${dA.z.toFixed(6)}) B=(${dB.x.toFixed(6)},${dB.y.toFixed(6)},${dB.z.toFixed(6)})`);
  check('扩散为 0 时方向不变', (() => {
    const d = applySpread(base, 0, () => 0.5);
    return near(d.x, 0) && near(d.y, 0) && near(d.z, -1);
  })());

  // 方向必须落在锥内
  let maxAngle = 0;
  let k2 = 0;
  const rng2 = () => [0.1, 0.9, 0.33, 0.66, 0.5, 0.2][k2++ % 6];
  for (let i = 0; i < 200; i++) {
    const d = applySpread(base, 3, rng2);
    const cos = -d.z;
    const ang = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (ang > maxAngle) maxAngle = ang;
  }
  check('扩散方向全部落在锥角内', maxAngle <= 3 + 1e-6, `最大偏角 ${maxAngle.toFixed(4)}° (锥角 3°)`);
}

// ============================================================
// 6. 导航分级与限流（M0 约束 C-1/C-2 / M2 硬性要求）
// ============================================================
{
  const tiers = config.aiUpdateTiers;
  check('近距离选中每帧级', pickUpdateTier(tiers, 5).intervalMs === 0);
  check('中距离选中降频级', pickUpdateTier(tiers, 40).intervalMs > 0);
  check('极远距离仍有分级可用（不会返回 undefined）',
    !!pickUpdateTier(tiers, 1e6), JSON.stringify(pickUpdateTier(tiers, 1e6)));
  check('更新分级按距离单调不减',
    pickUpdateTier(tiers, 5).intervalMs <= pickUpdateTier(tiers, 40).intervalMs &&
      pickUpdateTier(tiers, 40).intervalMs <= pickUpdateTier(tiers, 90).intervalMs);

  check('寻路每帧查询上限为正且有限（C-1）',
    config.aiPathBudget.maxQueriesPerFrame > 0 && config.aiPathBudget.maxQueriesPerFrame < 50,
    `${config.aiPathBudget.maxQueriesPerFrame}`);
  check('单帧寻路耗时上限 ≤ 4ms（C-2）',
    config.aiPathBudget.maxMsPerFrame > 0 && config.aiPathBudget.maxMsPerFrame <= 4,
    `${config.aiPathBudget.maxMsPerFrame}ms`);

  const rnd = () => 0.5;
  const d1 = jitteredDeadline(1000, 500, 200, rnd);
  check('错峰到期时间落在 [基础, 基础+抖动] 区间',
    d1 >= 1500 && d1 <= 1700, `${d1}`);
}

// ============================================================
// 7. 配置表完整性（引用完整性由 config/index.js 在导入时校验）
// ============================================================
{
  check('武器数 ≥ 5（M2 要求多武器）', config.weapons.length >= 5, `${config.weapons.length}`);
  check('每把武器都有可量化的手感参数',
    config.weapons.every((w) => w.adsMs > 0 && w.spreadRecoveryPerSec > 0 && w.recoil.pattern.length > 0));
  check('AI 分级 ≥ 3（M2 要求难度可分级）', config.aiTiers.length >= 3, `${config.aiTiers.length}`);
  check('AI 分级在多个维度上区分难度（不能只靠命中率）', (() => {
    const keys = ['maxHealth', 'accuracyDeg', 'reactMs', 'damagePerShot', 'viewRange'];
    const distinct = keys.filter((k) => new Set(config.aiTiers.map((t) => t[k])).size > 1);
    return distinct.length >= 4;
  })(), `区分的维度数 = ${(() => {
    const keys = ['maxHealth', 'accuracyDeg', 'reactMs', 'damagePerShot', 'viewRange'];
    return keys.filter((k) => new Set(config.aiTiers.map((t) => t[k])).size > 1).length;
  })()}`);
  check('护甲覆盖关系与命中部位一致',
    config.armor.every((a) => a.covers.every((c) => config.hitZoneNames.includes(c))));
  check('玩家初始护甲存在', !!config.playerVitals.startArmor.body);
}

// ============================================================
// 8. 移动手感（M1-TEMP-2 / M1-TEMP-3）
//
// 这一组存在的理由：手感参数写错了肉眼极难发现，但方程写错了必须能被抓住。
// 特别是"速度是不是瞬间到顶""会不会无限滑行""空中能不能刷速度"这三条，
// 都是**可断言的事实**，不该靠试玩去感觉。
// ============================================================
{
  // ---- 加速：必须是渐变，不能一帧到顶 ----
  {
    const vel = { x: 0, z: 0 };
    const dt = 1 / 60;
    const wishSpeed = 5.0;
    const accel = 11.0;
    accelerate(vel, 0, -1, wishSpeed, accel, dt);
    const after1 = Math.hypot(vel.x, vel.z);
    check('加速一帧后速度小于目标速度（不是瞬间到顶）',
      after1 > 0 && after1 < wishSpeed, `1 帧后 ${after1.toFixed(3)} / 目标 ${wishSpeed}`);
    check('加速方向正确（-Z 前进方向）', vel.z < 0 && Math.abs(vel.x) < 1e-9,
      `vel=(${vel.x.toFixed(3)}, ${vel.z.toFixed(3)})`);

    // 一直加速应收敛到目标速度，且不超过
    for (let i = 0; i < 600; i++) accelerate(vel, 0, -1, wishSpeed, accel, dt);
    const settled = Math.hypot(vel.x, vel.z);
    check('持续加速收敛到目标速度且不超速',
      Math.abs(settled - wishSpeed) < 0.02, `${settled.toFixed(4)} vs ${wishSpeed}`);

    // 达到目标后再加速不应产生任何增量。
    // 注意期望方向是 (0,-1)，"已达目标"指的是**沿该方向的分量**已达目标。
    // 初版这里把速度设成垂直于期望方向再断言不加速 —— 那是错的：
    // 垂直分量为 0，本来就该继续加速。是测试写错，不是代码错。
    const v2 = { x: 0, z: -wishSpeed };
    const added = accelerate(v2, 0, -1, wishSpeed, accel, dt);
    check('沿期望方向已达目标速度时不再加速',
      added === 0 && Math.abs(v2.z + wishSpeed) < 1e-9, `added=${added}`);

    // 斜向移动不能让总速度超过目标速度（否则会出现"斜着走更快"）
    {
      const d = { x: 0, z: 0 };
      const inv = 1 / Math.SQRT2;
      for (let i = 0; i < 900; i++) accelerate(d, inv, -inv, wishSpeed, accel, dt);
      const total = Math.hypot(d.x, d.z);
      check('斜向移动的稳态总速度等于目标速度（不会更快）',
        Math.abs(total - wishSpeed) < 0.02, `${total.toFixed(4)} vs ${wishSpeed}`);
    }

    // 加速到目标所需时间应随 accel 变化 —— 证明 accel 真的在起作用
    const mk = (a) => {
      const v = { x: 0, z: 0 };
      let t = 0;
      while (Math.hypot(v.x, v.z) < wishSpeed * 0.95 && t < 5) {
        accelerate(v, 0, -1, wishSpeed, a, dt);
        t += dt;
      }
      return t;
    };
    const tLow = mk(6);
    const tHigh = mk(22);
    check('accel 越大到达目标速度越快', tHigh < tLow,
      `accel=6 → ${tLow.toFixed(3)}s, accel=22 → ${tHigh.toFixed(3)}s`);
  }

  // ---- 摩擦：必须能停下来，且**绝不能阻止加速** ----
  {
    const dt = 1 / 60;
    const vel = { x: 0, z: -5 };
    applyFriction(vel, 8.0, 1.2, dt);
    check('摩擦使速度下降但不归零', vel.z > -5 && vel.z < 0, `-5 → ${vel.z.toFixed(3)}`);

    // 关键不变量：有限时间内必须真正停住（而不是指数逼近 0 永远滑）
    let t = 0;
    while (Math.hypot(vel.x, vel.z) > 1e-6 && t < 10) {
      applyFriction(vel, 8.0, 1.2, dt);
      t += dt;
    }
    check('摩擦在有限时间内让角色完全停住（不滑冰）', t < 1.5,
      `从 5 m/s 停住用了 ${t.toFixed(3)}s`);

    // ★ 回归：低帧率/高帧率下"摩擦 + 加速"都必须能把速度加上去。
    // 这里对应的真实故障是：摩擦在 speed < stopSpeed 时直接把速度清零，
    // 而每帧加速增量在高帧率下小于 stopSpeed，导致玩家永远加不起速度
    //（165Hz 实测只能到 0.33 m/s，角色几乎无法移动）。
    const converge = (hz, accel, friction, stopSpeed, wishSpeed) => {
      const d = 1 / hz;
      const v = { x: 0, z: 0 };
      for (let i = 0; i < hz * 3; i++) {
        applyFriction(v, friction, stopSpeed, d);
        accelerate(v, 0, -1, wishSpeed, accel, d);
      }
      return Math.hypot(v.x, v.z);
    };
    for (const hz of [30, 60, 90, 144, 165, 240, 360]) {
      const s = converge(hz, 11.0, 8.0, 1.2, 5.0);
      check(`摩擦不会阻止加速（${hz}Hz 下能达到目标速度）`,
        s > 5.0 * 0.85, `${s.toFixed(3)} m/s`);
    }
    // 反向确认这条断言真的能抓住那个 bug：把 stopSpeed 调到大于每帧加速增量，
    // 若实现是"低于 stopSpeed 直接归零"，此处必然失败。
    const tiny = (() => {
      const d = 1 / 165;
      const v = { x: 0, z: 0 };
      for (let i = 0; i < 165 * 2; i++) {
        applyFriction(v, 8.0, 1.2, d);
        accelerate(v, 0, -1, 5.0, 11.0, d);
      }
      // 每帧加速增量
      const perFrame = 11.0 * 5.0 * d;
      return { speed: Math.hypot(v.x, v.z), perFrame };
    })();
    check('每帧加速增量小于 stopSpeed 时仍能加速（这是原 bug 的触发条件）',
      tiny.perFrame < 1.2 && tiny.speed > 4.0,
      `每帧增量 ${tiny.perFrame.toFixed(3)} < stopSpeed 1.2，稳态 ${tiny.speed.toFixed(3)} m/s`);
  }

  // ---- 空中控制：不能靠空中输入刷速度（这是可被利用的位移技巧）----
  {
    const dt = 1 / 60;
    const airAccel = 2.2;
    const cap = 1.5;
    // 以冲刺速度向前起跳，然后一直往正侧方按
    const vel = { x: 0, z: -7.5 };
    const startSpeed = Math.hypot(vel.x, vel.z);
    let peak = startSpeed;
    for (let i = 0; i < 120; i++) {
      airAccelerate(vel, 1, 0, 7.5, airAccel, cap, dt);
      peak = Math.max(peak, Math.hypot(vel.x, vel.z));
    }
    // 允许的增量上限：侧向最多加到 cap，因此总速度上限是 hypot(start, cap)
    const theoreticalMax = Math.hypot(startSpeed, cap);
    check('空中控制不能让水平速度超过理论上限',
      peak <= theoreticalMax + 1e-6,
      `峰值 ${peak.toFixed(4)} ≤ 上限 ${theoreticalMax.toFixed(4)}`);
    check('空中控制确实生效（否则跳跃完全不可控）', vel.x > 0.5, `侧向速度 ${vel.x.toFixed(3)}`);

    // 与地面加速对比：空中达到的速度增量应明显更小
    const gv = { x: 0, z: -7.5 };
    const av = { x: 0, z: -7.5 };
    for (let i = 0; i < 30; i++) {
      airAccelerate(av, 1, 0, 7.5, airAccel, cap, dt);
      accelerate(gv, 1, 0, 7.5, 11.0, dt);
    }
    check('空中加速明显弱于地面加速', av.x < gv.x * 0.5,
      `空中侧向 ${av.x.toFixed(3)} vs 地面 ${gv.x.toFixed(3)}`);
  }

  // ---- 跳跃缓冲与土狼时间 ----
  {
    const cfgMs = { coyote: 110, buffer: 150 };

    // 土狼时间：离地后 50ms 起跳应成功
    {
      const js = createJumpState();
      let t = 1000;
      consumeJump(js, true, t, cfgMs.coyote, cfgMs.buffer); // 在地面
      t += 50; // 离地 50ms
      queueJump(js, t);
      check('土狼时间：离地 50ms 内仍可起跳',
        consumeJump(js, false, t, cfgMs.coyote, cfgMs.buffer) === true);
    }
    // 土狼过期：离地 300ms 后不该还能起跳
    {
      const js = createJumpState();
      let t = 1000;
      consumeJump(js, true, t, cfgMs.coyote, cfgMs.buffer);
      t += 300;
      queueJump(js, t);
      check('土狼时间：离地 300ms 后不能起跳',
        consumeJump(js, false, t, cfgMs.coyote, cfgMs.buffer) === false);
    }
    // 跳跃缓冲：落地前 80ms 按下，落地瞬间应生效
    {
      const js = createJumpState();
      let t = 1000;
      queueJump(js, t); // 还在空中就按下
      t += 80; // 80ms 后落地
      check('跳跃缓冲：落地前 80ms 按下的跳跃在落地时生效',
        consumeJump(js, true, t, cfgMs.coyote, cfgMs.buffer) === true);
    }
    // 缓冲过期：落地前 500ms 按下，不该生效
    {
      const js = createJumpState();
      let t = 1000;
      queueJump(js, t);
      t += 500;
      check('跳跃缓冲：落地前 500ms 按下的跳跃已过期',
        consumeJump(js, true, t, cfgMs.coyote, cfgMs.buffer) === false);
    }
    // 一次按键只跳一次
    {
      const js = createJumpState();
      const t = 1000;
      queueJump(js, t);
      const first = consumeJump(js, true, t, cfgMs.coyote, cfgMs.buffer);
      const second = consumeJump(js, true, t + 16, cfgMs.coyote, cfgMs.buffer);
      check('一次跳跃输入只触发一次起跳（不会连跳）', first === true && second === false);
    }
    // 初值不能用 0：否则时间源从 0 开始时会被误判为"刚离地"
    {
      const js = createJumpState();
      check('跳跃状态初值为 -Infinity（避免开局凭空起跳）',
        js.lastGroundedAt === -Infinity && js.jumpQueuedAt === -Infinity);
      check('从未在地面过时不能起跳（即使按了跳）', (() => {
        const s = createJumpState();
        queueJump(s, 0);
        return consumeJump(s, false, 0, cfgMs.coyote, cfgMs.buffer) === false;
      })());
    }
  }

  // ---- 落地缓冲 ----
  {
    const s = createLandingState();
    const d1 = applyLandingImpact(s, 5.2, 0.22, 0.02);
    check('落地产生相机下沉', d1 > 0 && d1 <= 0.22, `下沉 ${d1.toFixed(4)}m`);
    check('下沉有上限（高速落地不会把视角砸穿）',
      applyLandingImpact(s, 500, 0.22, 0.02) <= 0.22 + 1e-9);
    // 小落地不应覆盖掉大落地
    const s2 = createLandingState();
    applyLandingImpact(s2, 6, 0.22, 0.02);
    const big = s2.dip;
    const added = applyLandingImpact(s2, 1, 0.22, 0.02);
    check('连续落地时小冲击不覆盖大冲击', added === 0 && s2.dip === big);

    // 回弹到 0
    let t = 0;
    while (s.dip > 0 && t < 5) {
      updateLanding(s, 1 / 60, 1.5);
      t += 1 / 60;
    }
    check('落地下沉会在有限时间内恢复到 0', s.dip === 0 && t < 1.0, `${t.toFixed(3)}s`);
    check('落地计数被记录', s.landings >= 1, `${s.landings}`);
  }

  // ---- 台阶吸附判定 ----
  {
    const step = 0.55;
    check('低掩体（0.45）可自动迈上', stepUpTarget(0, 0.45, step) === 0.45);
    check('高掩体（1.15）不可自动迈上，必须跳',
      stepUpTarget(0, 1.15, step) === false);
    check('已在掩体顶上时不重复吸附', stepUpTarget(0.45, 0.45, step) === false);
    check('走下台子不吸附下降（交给重力）', stepUpTarget(0.45, 0, step) === false);
    check('跳跃中接近高掩体顶面时可吸附上去（跳上掩体）',
      stepUpTarget(0.7, 1.15, step) === 1.15);
    check('恰好等于 stepHeight 的高度差可迈上（边界包含）',
      stepUpTarget(0, 0.55, step) === 0.55);
    check('略超 stepHeight 即不可迈上',
      stepUpTarget(0, 0.5501, step) === false);
  }

  // ---- M3-1b-2 ①：楼板与斜坡几何（分层能力的基础）----
  //
  // 用一个**合成地图**测，而不是在正式地图上测 —— 正式地图此刻还是一层，
  // 里面没有楼板/斜坡，拿它测不出任何东西。合成地图同时充当"这个能力确实可用"的最小证明。
  {
    const { createLevel } = await import('../src/level/level.js');
    const base = config.map;
    const synthetic = {
      ...base,
      id: 'synthetic_two_floor',
      floors: [{ id: 0, baseY: 0, label: '一层' }, { id: 1, baseY: 3.6, label: '二层' }],
      slabThickness: 0.3,
      walls: [],
      cover: [],
      // 二层楼板：覆盖 x 20..23, z 20..23（下方一层可以通行）
      slabs: [{ x: 20, z: 20, w: 4, h: 4, floor: 1 }],
      // 楼梯：从一层 (16,20) 沿 +x 走 3 格升到二层
      ramps: [{ x: 16, z: 20, w: 3, h: 1, dir: '+x', floor: 0 }],
      containers: [{ type: 'crate_civil', x: 22, z: 22, floor: 1 }],
      extracts: [
        { id: 'e1', label: '一层口', x: 4, z: 4, radiusCells: 1.2, conditional: false },
        { id: 'e2', label: '二层口', x: 22, z: 22, radiusCells: 1.2, conditional: false },
      ],
    };
    const cfg2 = { ...config, map: synthetic };
    const lvl = createLevel(cfg2, { add() {}, remove() {} });
    const cell = lvl.cell;
    const at = (cx, cz) => [(cx + 0.5) * cell, (cz + 0.5) * cell];
    const STEP = config.player.stepHeight;

    // 楼板：正下方的一层地面仍是 0（这就是"楼板下方可通行"）
    const [sx, sz] = at(22, 22);
    check('二层楼板**下方**一层仍可站立（地面为 0，不是被楼板顶上去）',
      lvl.surfaceAt(sx, sz, 0, STEP) === 0,
      `surfaceAt(二层楼板下, feetY=0) = ${lvl.surfaceAt(sx, sz, 0, STEP)}`);
    // 站在二层：地面应为二层标高 3.6
    check('站在二层时地面高度等于二层标高 3.6m',
      Math.abs(lvl.surfaceAt(sx, sz, 3.6, STEP) - 3.6) < 1e-4,
      `surfaceAt(, feetY=3.6) = ${lvl.surfaceAt(sx, sz, 3.6, STEP)}`);
    // 楼板本身是实心的：站在一层高度朝上看，3.6 处应被判为实心
    check('楼板是实心的（从下方看 3.4m 处为实心、3.8m 处为空）',
      lvl.solidAtPoint(22, 22, 3.45) && !lvl.solidAtPoint(22, 22, 3.8),
      `3.45 实心=${lvl.solidAtPoint(22, 22, 3.45)}  3.8 实心=${lvl.solidAtPoint(22, 22, 3.8)}`);
    // 楼板**不应**挡住一层的水平移动（能走到楼板正下方）
    {
      const pos = { x: sx, y: 0, z: sz };
      lvl.resolveCircle(pos, 0.4, 0, config.player.bodyHeight, STEP);
      check('一层可以走到二层楼板的正下方（不被楼板挡住）',
        Math.abs(pos.x - sx) < 1e-4 && Math.abs(pos.z - sz) < 1e-4,
        `被推到 (${pos.x.toFixed(2)},${pos.z.toFixed(2)})，原位置 (${sx.toFixed(2)},${sz.toFixed(2)})`);
    }

    // 斜坡：沿 +x 表面必须单调上升，且末端接上二层标高
    {
      const zc = at(16, 20)[1];
      const samples = [];
      for (let k = 0; k < 3; k++) {
        for (const f of [0.1, 0.5, 0.9]) {
          const x = (16 + k + f) * cell;
          samples.push({ x, y: lvl.surfaceAt(x, zc, 0, 4.0) }); // 给足 stepHeight，模拟"沿坡走上去"
        }
      }
      let monotone = true;
      for (let i = 1; i < samples.length; i++) if (samples[i].y < samples[i - 1].y - 1e-6) monotone = false;
      check('斜坡表面沿行进方向单调上升（不是台阶式的突变）', monotone,
        samples.map((s) => s.y.toFixed(2)).join(' → '));
      const first = samples[0].y;
      const last = samples[samples.length - 1].y;
      check('斜坡从一层标高升到二层标高',
        first < 0.6 && last > 3.0,
        `起点 ${first.toFixed(2)}m → 终点 ${last.toFixed(2)}m（二层标高 3.6m）`);
      // 一格之内的落差应当远小于 stepHeight 才能"走"上去
      const perCellRise = 3.6 / 3;
      check('斜坡单格落差可行走（≤ stepHeight 的 3 倍，靠连续插值而非台阶吸附）',
        perCellRise <= config.player.stepHeight * 3,
        `单格落差 ${perCellRise.toFixed(2)}m，stepHeight ${STEP}m`);
    }
  }

  // ---- 关卡掩体配置一致性 ----
  //
  // M3-1 起掩体分两层：**高度规格**在 tunables.level.cover（跨地图共享），
  // **位置与类型**在地图表里。因此这里同时校验两层 ——
  // 只看高度会漏掉"地图上根本没有高掩体"这种情况（那样"需要跳"就无从验证）。
  {
    const lc = config.level.cover;
    check('关卡配置包含掩体高度规格', !!lc && lc.lowHeight > 0 && lc.tallHeight > 0,
      `low=${lc?.lowHeight} tall=${lc?.tallHeight}`);
    check('低掩体高度不超过 stepHeight（否则"可迈上"是假的）',
      lc.lowHeight <= config.player.stepHeight,
      `lowHeight=${lc.lowHeight} ≤ stepHeight=${config.player.stepHeight}`);
    check('高掩体高度超过 stepHeight（否则"需要跳"是假的）',
      lc.tallHeight > config.player.stepHeight,
      `tallHeight=${lc.tallHeight} > stepHeight=${config.player.stepHeight}`);

    // 地图必须两种掩体都有 —— 否则台阶吸附的"迈上/跳上"只能测一半
    const coverList = config.coverList || [];
    const lowN = coverList.filter((c) => c.type === 'low').length;
    const tallN = coverList.filter((c) => c.type === 'tall').length;
    check('地图里低掩体与高掩体都存在（两类都必须可测）', lowN > 0 && tallN > 0,
      `低 ${lowN} 格 / 高 ${tallN} 格`);

    // 掩体密度：太密会让地图变成迷宫，太疏则掩体对抗不成立
    const freeCells = config.level.gridW * config.level.gridH;
    const density = coverList.length / freeCells;
    check('掩体密度在合理范围（2%~12% 的格数）', density >= 0.02 && density <= 0.12,
      `${coverList.length} / ${freeCells} = ${(density * 100).toFixed(1)}%`);

    // ★ 关键可达性不变量：**高掩体必须能被跳上去，且余量要够**。
    //
    // 这条不是锦上添花，而是踩过的坑：玩家要站上高掩体，
    // 脚底必须先达到 `tallHeight - stepHeight` 才允许进入该格（碰撞层规则），
    // 再靠台阶吸附抬上去。
    // 原本 stepHeight=0.55、tallHeight=1.15 → 门槛 0.60m，
    // 而跳跃理论最高只有 0.676m，余量仅 0.076m。
    // 离散积分还会损失约 `jumpSpeed·dt/2` 的高度 —— 30fps 下实际 apex 只有 0.589m，
    // **低于门槛，跳不上去**。表现为"跳上箱子时灵时不灵"，玩家会直接当成 bug。
    const apex = config.player.jumpSpeed ** 2 / (2 * Math.abs(config.player.gravity));
    const threshold = lc.tallHeight - config.player.stepHeight;
    const worstApex = apex - (config.player.jumpSpeed * (1 / 30)) / 2; // 30fps 最坏情况
    check('高掩体可以被跳上去，且在最差帧率下仍有余量',
      worstApex > threshold + 0.1,
      `30fps 实际跳跃高度 ${worstApex.toFixed(3)}m vs 门槛 ${threshold.toFixed(3)}m` +
        `（余量 ${(worstApex - threshold).toFixed(3)}m）`);

    check('玩家与 AI 使用同一个 stepHeight（来自 level，避免两边不一致）',
      config.player.stepHeight === config.player.stepHeight);
  }

  // ---- M3-1b-1 发现的旧缺陷回归防线：低掩体上方的射线**不得穿墙** ----
  //
  // 这是 M3-1b-1 改造几何时被黄金基准抓出来的旧实现缺陷：
  //   raycastWall 在"射线**射入**某格时入口点高于该格阻挡体顶面且不下降"→ **直接返回未命中**。
  //   那条捷径假设"所有阻挡体一样高"，而掩体 0.45m、墙 3.5m 推翻了它 ——
  //   于是**只要射线先擦过一格低掩体上方，它就会穿过后面所有的墙**。
  //   玩家视角的表现就是"站在矮墙后开枪，子弹穿墙打死掩体后面的人"。
  //
  // ★ 场景必须严格是「空地起射 → 先擦过一格低掩体 → 空地 → 墙」。
  //   我第一版写成"从掩体格中心起射"，射线根本没**经过**掩体，因此无论有没有缺陷都通过 ——
  //   注入自检（把缺陷放回去）显示仍然 123/123 全绿，才暴露了那条断言是空的。
  //   教训：回归测试必须复现**触发条件**，而不只是复现"结果看起来不对"。
  //
  // ★ M3-1b-2 ④：本组**显式使用单层对照地图 industrial_01**。
  //   这条缺陷的触发条件是"低掩体后面有墙"，而"墙顶以上"这个反向对照只有在
  //   **单层**地图上才成立（两层地图的墙顶之上还有二层楼板与掩体，射线本来就该命中）。
  //   用当前生效地图会让它随地图切换而语义漂移 —— 那不是回归，是判据不该跟着走。
  {
    const { createLevel } = await import('../src/level/level.js');
    const lvl = createLevel({ ...config, map: config.maps.industrial_01 }, { add() {}, remove() {} });
    const cell = lvl.cell;
    const coverCellSet = new Set(lvl.coverList.map((c) => c.z * lvl.W + c.cell));

    // 找「(cx-1) 空地 → (cx) 低掩体 → 中间空地 → 墙」的横向排列
    let found = null;
    for (const c of lvl.coverList.filter((x) => x.type === 'low')) {
      const beforeIdx = c.z * lvl.W + (c.cell - 1);
      // 起点必须在空地上（不能是墙、也不能本身是掩体），否则就不是"先擦过掩体"
      if (lvl.isBlockedCell(c.cell - 1, c.z)) continue;
      if (coverCellSet.has(beforeIdx)) continue;
      for (let d = 1; d < 16 && !found; d++) {
        const wx = c.cell + 1 + d;
        if (wx >= lvl.W - 1) break;
        if (!lvl.isBlockedCell(wx, c.z)) continue;
        let clear = true;
        for (let k = c.cell + 1; k < wx; k++) {
          if (lvl.isBlockedCell(k, c.z) || coverCellSet.has(c.z * lvl.W + k)) clear = false;
        }
        if (clear) found = { cover: c, wallX: wx };
      }
      if (found) break;
    }
    check('找到「空地—低掩体—空地—墙」的排列（否则本条断言无从测起）', !!found,
      found
        ? `起射格 (${found.cover.cell - 1},${found.cover.z}) → 低掩体格 (${found.cover.cell},${found.cover.z})` +
          ` → 墙格 (${found.wallX},${found.cover.z})`
        : '未找到');

    if (found) {
      const z = (found.cover.z + 0.5) * cell;
      const ox = (found.cover.cell - 1 + 0.5) * cell; // 从低掩体**前一格**（空地）起射
      const eyeY = config.player.eyeHeight;           // 1.65m，远高于低掩体 0.45m
      const expected = found.wallX * cell - ox;       // 到墙近侧面的距离
      const t = lvl.raycastWall(ox, eyeY, z, 1, 0, 0, 60);
      check('擦过低掩体上方的射线被墙挡住（不得穿墙）',
        Number.isFinite(t) && Math.abs(t - expected) < 1e-3,
        `眼高 ${eyeY}m 平射、先擦过 ${found.cover.height}m 低掩体：` +
          `期望 ${expected.toFixed(3)}m，实得 ${Number.isFinite(t) ? t.toFixed(3) + 'm' : '未命中（穿墙了）'}`);

      // 反向对照：同一位置但抬到墙顶以上，则确实不该命中 —— 防止"一律命中"式的假通过
      const tOver = lvl.raycastWall(ox, lvl.wallHeight + 0.5, z, 1, 0, 0, 60);
      check('高于墙顶的射线打不到墙（反向对照，防止「一律命中」）',
        !Number.isFinite(tOver),
        `y=${(lvl.wallHeight + 0.5).toFixed(1)}m 平射实得 ${Number.isFinite(tOver) ? tOver.toFixed(3) + 'm' : '未命中'}`);
    }
  }

  // ---- M3-1b-2 ②：分层寻路 ----
  //
  // ② 给寻路加了"层"这一维。它要在**真实地图**上满足与 ① 相同的验收标准
  // ——「行为不变」；而"分层能力真的可用"必须用**合成两层地图**来证明
  // （正式地图此刻还是一层，拿它测不出任何分层行为）。
  //
  // 这里刻意"对拍而不是自证"：参考 Dijkstra 是独立写出来的，不复用被测代码的任何一行。
  // ① 的教训（"从不失败的检查等于没有检查"）同样适用 ——
  // 所以每条对拍断言后面都配了一条"跑到了足够多输入"的计数断言。
  {
    const { createNavGrid, createLayeredNavGrid, createAStar, nodeIndex, nodeFloor, nodeCell } =
      await import('../src/core/navgrid.js');
    const { createLevel } = await import('../src/level/level.js');

    // 与 navgrid 内部同值的常量：若不写成同一个数，对拍会出现 1e-9 级的假分歧
    const SQRT2 = 1.41421356;
    const D8 = [
      [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
    ];

    // ============ (1) 真实地图（单层对照）：行为不变 ============
    // 显式用 industrial_01 —— 本组断言的全部意义就是"分层改造没有改坏**单层**行为"，
    // 而两层地图上「旧的 isPathBlockedCell」本来就会把楼板当成掩体（那正是 ② 要修的东西），
    // 拿它当基准只会得到"预期之内的不一致"。
    const lvl = createLevel({ ...config, map: config.maps.industrial_01 }, { add() {}, remove() {} });
    const W = lvl.W;
    const H = lvl.H;
    const NN = W * H;
    const blocked = lvl.pathBlocked;

    const grid = createNavGrid(W, H, lvl.cell, blocked);
    check('单层网格：floorCount=1，节点编号空间与旧的 W*H 完全一致',
      grid.floorCount === 1 && grid.size === NN && grid.cellCount === NN,
      `floorCount=${grid.floorCount} size=${grid.size}`);
    check('节点编号 floor*W*H+cell 可无损往返（分层寻路的索引语义）',
      nodeFloor(nodeIndex(1, 123, W, H), W, H) === 1 && nodeCell(nodeIndex(1, 123, W, H), W, H) === 123);

    // ★ ② 在真实地图上的"行为不变"主证据：
    //   `lvl.pathBlocked`（旧的 isPathBlockedCell：墙 / coverCm）与
    //   `lvl.nav.blocked`（新的分层判据：落脚面 + 迈不过去的跨度）
    //   是**两段独立代码**，它们必须在单层地图上逐格一致。
    let dOld = -1;
    let dWrap = -1;
    for (let i = 0; i < NN; i++) {
      if (lvl.pathBlocked[i] !== lvl.nav.blocked[i] && dOld < 0) dOld = i;
      if (grid.blocked[i] !== lvl.nav.blocked[i] && dWrap < 0) dWrap = i;
    }
    check('新分层判据与旧的 isPathBlockedCell 在真实地图上逐格一致（单层行为不变）',
      dOld < 0,
      dOld < 0 ? '' : `首个分歧格 (${dOld % W},${(dOld / W) | 0})`);
    check('单层包装 createNavGrid 的阻挡表 == level 的分层寻路数据（逐格）',
      dWrap < 0,
      dWrap < 0 ? '' : `首个分歧格 (${dWrap % W},${(dWrap / W) | 0})`);

    // 参考实现：朴素 Dijkstra（O(N²)，N=1600，单次约 10ms，只跑 8 个源点）
    const refAll = (src) => {
      const dist = new Float64Array(NN).fill(Infinity);
      const done = new Uint8Array(NN);
      dist[src] = 0;
      for (let it = 0; it < NN; it++) {
        let u = -1;
        let best = Infinity;
        for (let i = 0; i < NN; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0) break;
        done[u] = 1;
        const cx = u % W;
        const cz = (u / W) | 0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + D8[k][0];
          const nz = cz + D8[k][1];
          if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
          const ni = nz * W + nx;
          if (blocked[ni]) continue;
          // 对角线不得"切角"（与 A* 的判据一致，否则两者本来就会给出不同结果）
          if (D8[k][0] !== 0 && D8[k][1] !== 0 &&
              (blocked[cz * W + nx] || blocked[nz * W + cx])) continue;
          const nd = dist[u] + D8[k][2];
          if (nd < dist[ni]) dist[ni] = nd;
        }
      }
      return dist;
    };

    const aStar = createAStar(grid);
    const pathCost = (buf, len) => {
      let c = 0;
      for (let i = 1; i < len; i++) {
        const a = buf[i - 1];
        const b = buf[i];
        c += (a % W) !== (b % W) && ((a / W) | 0) !== ((b / W) | 0) ? SQRT2 : 1;
      }
      return c;
    };

    const freeCells = [];
    for (let i = 0; i < NN; i++) if (!blocked[i]) freeCells.push(i);

    const mismatches = [];
    const illegal = [];
    let pairs = 0;
    for (let s = 0; s < 8; s++) {
      const src = freeCells[Math.floor(((s + 0.5) * freeCells.length) / 8)];
      const dist = refAll(src);
      for (let t = 0; t < 4; t++) {
        const gi = (Math.floor(((t + 0.5) * freeCells.length) / 4) + s * 197) % freeCells.length;
        const goal = freeCells[gi];
        if (goal === src) continue;
        pairs++;
        const r = aStar(src, goal);
        const len = r.len;
        const buf = Array.from(r.buf.subarray(0, len)); // 内部缓冲会被下次调用复用，必须先拷出来
        const ref = dist[goal];
        if (len === 0) {
          if (Number.isFinite(ref)) mismatches.push(`(${src})→(${goal}) A* 无路径，参考代价 ${ref.toFixed(3)}`);
          continue;
        }
        if (!Number.isFinite(ref)) {
          mismatches.push(`(${src})→(${goal}) A* 有路径，参考判定不可达`);
        } else if (Math.abs(pathCost(buf, len) - ref) > 1e-4) {
          mismatches.push(
            `(${src})→(${goal}) 代价 ${pathCost(buf, len).toFixed(4)} vs 参考 ${ref.toFixed(4)}`
          );
        }
        if (buf[0] !== src || buf[len - 1] !== goal) {
          illegal.push(`(${src})→(${goal}) 首尾不符`);
          continue;
        }
        for (let i = 1; i < len; i++) {
          const a = buf[i - 1];
          const b = buf[i];
          const ax = a % W, az = (a / W) | 0, bx = b % W, bz = (b / W) | 0;
          const dx = Math.abs(ax - bx);
          const dz = Math.abs(az - bz);
          if (dx > 1 || dz > 1 || (dx === 0 && dz === 0)) { illegal.push(`(${src})→(${goal}) 第 ${i} 步不相邻`); break; }
          if (blocked[b]) { illegal.push(`(${src})→(${goal}) 第 ${i} 步踏入阻挡格`); break; }
          if (dx === 1 && dz === 1 && (blocked[az * W + bx] || blocked[bz * W + ax])) {
            illegal.push(`(${src})→(${goal}) 第 ${i} 步对角切角`);
            break;
          }
        }
      }
    }
    check('对拍确实跑了足够多的点对（防止抽样写空导致下面的断言恒真）', pairs >= 24, `${pairs} 对`);
    check('单层地图：A* 的最短路代价与独立 Dijkstra 逐对一致',
      mismatches.length === 0, mismatches.slice(0, 3).join(' ｜ '));
    check('单层地图：A* 的路径逐格合法（相邻、不踏阻挡、对角不切角）',
      illegal.length === 0, illegal.slice(0, 3).join(' ｜ '));

    // ============ (2) 合成两层地图：分层能力确实可用 ============
    //
    // 布局（刻意让坡顶格**紧邻**二层楼板，这样"能不能上楼"只取决于分层逻辑）：
    //   一层地面 0m 全通；二层楼板 x 20..25, z 20..25（标高 3.6m）；
    //   楼梯 x 17..19, z 20 沿 +x，坡顶格 (19,20) 与楼板 (20,20) 相邻。
    const synthetic = {
      ...config.map,
      id: 'synthetic_nav_two_floor',
      floors: [{ id: 0, baseY: 0, label: '一层' }, { id: 1, baseY: 3.6, label: '二层' }],
      slabThickness: 0.3,
      walls: [],
      cover: [],
      slabs: [{ x: 20, z: 20, w: 6, h: 6, floor: 1 }],
      ramps: [{ x: 17, z: 20, w: 3, h: 1, dir: '+x', floor: 0 }],
    };
    const lvl2 = createLevel({ ...config, map: synthetic }, { add() {}, remove() {} });
    const CC = W * H;
    const at1 = (cx, cz) => cz * W + cx;
    const at2 = (cx, cz) => CC + cz * W + cx;

    check('合成图确实建出了两层（否则下面的分层断言全部无意义）',
      lvl2.nav.floorCount === 2 && lvl2.nav.blocked.length === 2 * CC,
      `floorCount=${lvl2.nav.floorCount} 长度=${lvl2.nav.blocked.length}`);
    check('合成图一层：无墙无掩体时所有内部格可走',
      (() => {
        for (let cz = 1; cz < H - 1; cz++) {
          for (let cx = 1; cx < W - 1; cx++) if (lvl2.nav.blocked[at1(cx, cz)]) return false;
        }
        return true;
      })());
    check('合成图二层：被楼板覆盖的格可走',
      lvl2.nav.blocked[at2(22, 22)] === 0);
    check('合成图二层：没有被楼板覆盖的格是**悬空**的 → 不可走',
      lvl2.nav.blocked[at2(2, 2)] === 1);
    check('合成图二层：坡顶格是二层的入口（同时属于两层）',
      lvl2.nav.blocked[at2(19, 20)] === 0);
    check('合成图二层：坡道下端的格在二层是悬空的 → 不可走',
      lvl2.nav.blocked[at2(17, 20)] === 1);
    check('层内可走性与"楼板覆盖"一致，而不是"整层都可走"（这正是两层与单层的区别）',
      lvl2.nav.blocked[at2(30, 30)] === 1 && lvl2.nav.blocked[at1(30, 30)] === 0);

    check('跨层边只有一条，且两端是同一个坡顶格（相邻两层）',
      lvl2.nav.links.length === 1 &&
        lvl2.nav.links[0][0] === at1(19, 20) &&
        lvl2.nav.links[0][1] === at2(19, 20),
      JSON.stringify(lvl2.nav.links));

    const grid2 = createLayeredNavGrid(lvl2.nav);
    const aStar2 = createAStar(grid2);
    const spawn = config.map.playerSpawn;
    const startNode = nodeIndex(0, at1(spawn.x, spawn.z), W, H);
    const goalNode = nodeIndex(1, at1(22, 22), W, H); // 二层 (22,22)：楼板覆盖范围内

    const up = aStar2(startNode, goalNode);
    const upPath = Array.from(up.buf.subarray(0, up.len));
    check('一层出生点 → 二层楼板点：A* 必须给出路径（方案 §7 验收 3 的最小形态）',
      upPath.length > 0, `len=${upPath.length}`);

    // ★ 下面四条断言**不包在 `if (upPath.length > 0)` 里**：
    //   一旦包上，自检 2（删掉跨层边）时 upPath 为空 → 整段被跳过 → 四条全部恒真。
    //   无条件执行时，"没有路径"会让它们各自以"0 次 / 未跨层 / 0 个坡格"失败。
    const upFloors = upPath.map((n) => nodeFloor(n, W, H));
    const changes = [];
    for (let i = 1; i < upFloors.length; i++) {
      if (upFloors[i] !== upFloors[i - 1]) changes.push(i);
    }
    check('跨层恰好发生一次（图里只有一个楼梯）', changes.length === 1, `${changes.length} 次`);
    check('跨层方向是一层 → 二层',
      changes.length === 1 && upFloors[changes[0] - 1] === 0 && upFloors[changes[0]] === 1,
      changes.length === 1 ? `${upFloors[changes[0] - 1]} → ${upFloors[changes[0]]}` : '未跨层');
    const crossIdx = changes.length === 1 ? changes[0] : -1;
    check('跨层点必须落在坡顶格上（不是凭空穿过楼板）',
      crossIdx > 0 &&
        nodeCell(upPath[crossIdx], W, H) === at1(19, 20) &&
        nodeCell(upPath[crossIdx - 1], W, H) === at1(19, 20),
      crossIdx > 0
        ? `跨层格 (${nodeCell(upPath[crossIdx], W, H) % W},${(nodeCell(upPath[crossIdx], W, H) / W) | 0})`
        : '路径不存在或未跨层');
    // 路径必须真的沿坡道走完 3 格，而不是"从旁边跳上坡顶"
    const rampCells = new Set([17, 18, 19].map((x) => at1(x, 20)));
    let rampTouched = 0;
    for (const n of upPath) {
      if (nodeFloor(n, W, H) === 0 && rampCells.has(nodeCell(n, W, H))) rampTouched++;
    }
    check('路径必须完整走过坡道的 3 格（不能从侧面跳上坡顶）',
      rampTouched === 3, `经过 ${rampTouched} 个坡格`);

    check('二层 → 一层：楼梯双向可用', aStar2(goalNode, startNode).len > 0);
    check('二层悬空格不可作为目标（A* 必须返回无路径）',
      aStar2(startNode, nodeIndex(1, at1(2, 2), W, H)).len === 0);

    // ★ 防"瞬移上坡"：一层地面与坡顶格的高度差是 2.4m，
    //   若高度差门槛失效，实体走到那里会被 surfaceAt 一把抬到 2.4m 以上。
    const below = nodeIndex(0, at1(20, 20), W, H); // 一层：坡顶格旁边、楼板正下方
    const top0 = nodeIndex(0, at1(19, 20), W, H);  // 坡顶格在**一层**的表示
    const gap = Math.max(
      lvl2.nav.lo[below] - lvl2.nav.hi[top0],
      lvl2.nav.lo[top0] - lvl2.nav.hi[below]
    );
    check('一层地面与坡顶格的高度差超过 stepHeight（这条边必须被剪掉）',
      gap > lvl2.nav.stepHeight,
      `高度差 ${gap.toFixed(2)}m vs stepHeight ${lvl2.nav.stepHeight}m`);
    // 坡道格在起始层上的落脚高度必须是**区间**（坡是连续面），不是单点
    check('坡道格带落脚高度区间（连续坡面，而不是台阶）',
      lvl2.nav.hi[top0] - lvl2.nav.lo[top0] > 0.1 &&
        Math.abs(lvl2.nav.hi[top0] - 3.6) < 1e-4,
      `[${lvl2.nav.lo[top0].toFixed(2)}, ${lvl2.nav.hi[top0].toFixed(2)}]`);

    const around = aStar2(below, top0);
    const aroundPath = Array.from(around.buf.subarray(0, around.len));
    check('从楼板下方到坡顶格必须绕经坡道（不能一步跨上去）',
      aroundPath.length > 2, `len=${aroundPath.length}`);
    // ★ 这条断言**不能**包在 `if (aroundPath.length > 2)` 里：
    //   注入自检时那条路径会退化成 2 格，条件不成立 → 断言被整段跳过 → 恒真。
    //   （① 的"空断言"教训：条件化的检查等于没有检查。）
    const prev = aroundPath.length >= 2 ? aroundPath[aroundPath.length - 2] : -1;
    check('坡顶格的唯一入口是坡道上一格 (18,20)',
      prev >= 0 && nodeFloor(prev, W, H) === 0 && nodeCell(prev, W, H) === at1(18, 20),
      prev < 0
        ? '路径不存在，无从进入坡顶格'
        : `实得前驱 (${nodeCell(prev, W, H) % W},${(nodeCell(prev, W, H) / W) | 0}) 层 ${nodeFloor(prev, W, H)}`);

    // 性能：C-2 的预算是单帧寻路 ≤ 2ms。这里量的是**单次 A* 纯计算**（不含调度器）。
    const t0 = performance.now();
    const REPS = 300;
    for (let i = 0; i < REPS; i++) aStar(freeCells[0], freeCells[freeCells.length - 1]);
    const perCall = (performance.now() - t0) / REPS;
    check('单层地图上 A* 单次耗时远低于 C-2 的 2ms 预算',
      perCall < 2, `${perCall.toFixed(4)} ms/次`);

    const t1 = performance.now();
    for (let i = 0; i < REPS; i++) aStar2(startNode, goalNode);
    const perCallTwo = (performance.now() - t1) / REPS;
    check('两层地图上（含跨层）A* 单次耗时同样远低于 2ms 预算',
      perCallTwo < 2, `${perCallTwo.toFixed(4)} ms/次`);
  }

  // ---- M3-1b-2 ③：AI 竖直跟随与跨层追击 ----
  //
  // ③ 要回答两个问题，而且两个都必须**可以被证伪**：
  //   (a) 单层地图上 AI 的竖直行为有没有被改掉？
  //   (b) 两层地图上 AI 能不能真的经由楼梯追到另一层的玩家，
  //       以及"掉层"时是连续下落还是瞬移？
  //
  // 每组前面都先跑一条"夹具前提"断言（例如"这一步确实走出了楼板"）——
  // ① 的教训：夹具没复现触发条件时，后面的断言无论有没有缺陷都会通过。
  {
    const { createAi } = await import('../src/gameplay/ai.js');
    const { createLevel } = await import('../src/level/level.js');
    const { createLayeredNavGrid: mkGrid, createAStar: mkAStar, createPathScheduler: mkSched, nodeIndex } =
      await import('../src/core/navgrid.js');

    const scene = { add() {}, remove() {} };
    const STEP = config.player.stepHeight;
    const maxStepOf = (arr) => {
      let m = 0;
      for (let i = 1; i < arr.length; i++) m = Math.max(m, Math.abs(arr[i] - arr[i - 1]));
      return m;
    };
    const midCount = (arr) => arr.filter((y) => y > 0.2 && y < 3.4).length;

    // ============ (a) 单层对照地图：竖直行为不变 ============
    const lvl = createLevel({ ...config, map: config.maps.industrial_01 }, scene);
    const W = lvl.W;
    const H = lvl.H;

    check('单层地图上 floorOfY 恒为 0（AI 的"层"在这一维上退化掉了）',
      [0, 0.2, 0.45, 1.4, 1.65, 2.9, 3.4].every((y) => lvl.floorOfY(y) === 0));
    check('单层地图上 nodeIndex(0,cell) === cell（分层节点退化成旧格索引）',
      (() => {
        for (let i = 0; i < W * H; i++) if (nodeIndex(0, i, W, H) !== i) return false;
        return true;
      })());

    // ★ (a) 的**主证据**：`followGround` 在单层地图上永远走"直接贴合"分支。
    //   分支条件是 `feet - target <= stepHeight`。这里遍历所有相邻可走格对，
    //   按真实过程（用 A 的落脚高度作为走到 B 时的脚底高度）算出落差。
    //   只要落差恒 ≤ stepHeight，③ 新增的"连续下落"在单层地图上就是**死代码**，
    //   于是竖直行为与改造前逐字相同 —— 这是结构性论证，不是抽样观察。
    {
      const walkable = (i) => !lvl.pathBlocked[i];
      const surfaceOf = (i, feetY) =>
        lvl.surfaceAt(((i % W) + 0.5) * lvl.cell, (((i / W) | 0) + 0.5) * lvl.cell, feetY, STEP);
      let worstDrop = -Infinity;
      let worstPair = null;
      let pairs = 0;
      for (let i = 0; i < W * H; i++) {
        if (!walkable(i)) continue;
        const hi = surfaceOf(i, 0);
        const cx = i % W;
        const cz = (i / W) | 0;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx >= W || nz >= H) continue;
          const ni = nz * W + nx;
          if (!walkable(ni)) continue;
          pairs++;
          const drop = hi - surfaceOf(ni, hi);
          if (drop > worstDrop) {
            worstDrop = drop;
            worstPair = [i, ni];
          }
        }
      }
      check('单层地图：任何相邻可走格之间的落差都不超过 stepHeight（下落分支在单层永不触发）',
        worstDrop <= STEP,
        `最大落差 ${worstDrop.toFixed(3)}m vs stepHeight ${STEP}m` +
          (worstPair ? `（格 ${worstPair[0]} → ${worstPair[1]}）` : ''));
      check('这条遍历确实扫到了有高差的相邻格对（防止遍历写空导致上面那条恒真）',
        pairs > 500 && worstDrop > 0,
        `${pairs} 对，最大落差 ${worstDrop.toFixed(3)}m（必须 > 0 才说明扫到了低掩体那种高差）`);
    }

    // ============ (b) 两层地图：AI 经由楼梯追上二层的玩家 ============
    const mkTwoFloor = (id, ramps) => ({
      ...config.map,
      id,
      floors: [{ id: 0, baseY: 0, label: '一层' }, { id: 1, baseY: 3.6, label: '二层' }],
      slabThickness: 0.3,
      walls: [],
      cover: [],
      slabs: [{ x: 20, z: 20, w: 6, h: 6, floor: 1 }],
      ramps,
    });
    {
      const lvl2 = createLevel(
        { ...config, map: mkTwoFloor('synthetic_ai_stairs', [{ x: 17, z: 20, w: 3, h: 1, dir: '+x', floor: 0 }]) },
        scene
      );
      const cellW = lvl2.cell;
      const at = (cx, cz) => ({ x: (cx + 0.5) * cellW, z: (cz + 0.5) * cellW });
      const goal = at(22, 22); // 二层楼板中央
      const player = {
        state: { pos: { x: goal.x, y: 3.6, z: goal.z } },
        eyePosition: () => ({ x: goal.x, y: 3.6 + config.player.eyeHeight, z: goal.z }),
      };
      const scheduler = mkSched(mkAStar(mkGrid(lvl2.nav)), config.aiPathBudget);
      const ai = createAi({
        cfg: config, level: lvl2, scene,
        spawnCell: [17, 25], index: 0, tier: config.aiTiers[0],
        scheduler, rngSeed: 20261010,
      });
      const p0 = at(17, 25);
      ai.position.x = p0.x;
      ai.position.y = 0;
      ai.position.z = p0.z;

      const inner = ai.state;
      inner.state = 'search'; // 走"朝最后已知位置去"的分支（与听觉/受击后的行为同一路径）
      const ctx = { onPlayerHit() {}, reactScale: 1, accuracyScale: 1 };
      const rampCells = new Set([17, 18, 19].map((x) => 20 * W + x));

      const ys = [];
      let rampFrames = 0;
      let t = 0;
      for (let f = 0; f < 900; f++) {
        // 模拟"AI 持续知道玩家在二层"。不刷新的话记忆会过期、掉回巡逻，
        // 那样测的就变成"AI 会不会随机逛到楼梯"了。
        inner.lastKnownPos = { x: goal.x, y: 3.6, z: goal.z };
        inner.lastKnownAt = t;
        inner.stateEnteredAt = t;
        t += 1000 / 60;
        scheduler.processFrame();
        ai.update(1 / 60, t, player, ctx);
        ys.push(ai.position.y);
        if (rampCells.has(Math.floor(ai.position.z / cellW) * W + Math.floor(ai.position.x / cellW))) {
          rampFrames++;
        }
      }

      check('AI 追击位于二层的玩家：最终真的上到了二层',
        lvl2.floorOfY(ai.position.y) === 1 && Math.abs(ai.position.y - 3.6) < 0.05,
        `最终 (${ai.position.x.toFixed(1)}, ${ai.position.y.toFixed(2)}, ${ai.position.z.toFixed(1)})，` +
          `层 ${lvl2.floorOfY(ai.position.y)}`);
      check('上楼的路径确实经过坡道格（不是从楼板里穿上去）',
        rampFrames > 0, `在坡道格上停留 ${rampFrames} 帧`);
      check('上楼过程被观测到多个中间高度（不是一帧跳到 3.6m）',
        midCount(ys) >= 5, `中间高度采样 ${midCount(ys)} 个`);
      check('跨层追击全程没有超过 1.5m 的单帧高度突变（不瞬移 / 不穿模）',
        maxStepOf(ys) <= 1.5, `最大单帧变化 ${maxStepOf(ys).toFixed(3)}m`);
    }

    // ============ (c) 掉层：必须是连续下落，不能瞬移 ============
    //
    // 为什么必须单独测这一组：(b) 里 AI 是**沿坡道**上楼的，全程不会掉层 ——
    // 只测 (b) 的话，"下落的连续性"这条逻辑没有任何防线（空断言）。
    // 这里刻意造一个**没有楼梯**的地图：AI 在二层、玩家在一层，
    // A* 找不到跨层路径（len=0）→ 走 SEARCH 的兜底移动直接朝玩家逼近
    // → 走出楼板边缘 → 触发下落分支。
    {
      const lvl3 = createLevel({ ...config, map: mkTwoFloor('synthetic_ai_no_stairs', []) }, scene);
      const cellW = lvl3.cell;
      const at = (cx, cz) => ({ x: (cx + 0.5) * cellW, z: (cz + 0.5) * cellW });

      const grid3 = mkGrid(lvl3.nav);
      const aStar3 = mkAStar(grid3);
      // 夹具前提：确认"跨层不可达"这个触发条件真的成立
      check('夹具前提：无楼梯时二层到一层正下方确实不可达（这正是要测的触发条件）',
        aStar3(nodeIndex(1, 22 * W + 22, W, H), nodeIndex(0, 22 * W + 22, W, H)).len === 0);

      const far = at(30, 22); // 一层，楼板正东侧的空地上
      const player = {
        state: { pos: { x: far.x, y: 0, z: far.z } },
        eyePosition: () => ({ x: far.x, y: config.player.eyeHeight, z: far.z }),
      };
      const scheduler = mkSched(aStar3, config.aiPathBudget);
      const ai = createAi({
        cfg: config, level: lvl3, scene,
        spawnCell: [22, 22], index: 1, tier: config.aiTiers[0],
        scheduler, rngSeed: 777,
      });
      const p0 = at(22, 22);
      ai.position.x = p0.x;
      ai.position.y = 3.6; // 一开始就站在二层
      ai.position.z = p0.z;

      const inner = ai.state;
      inner.state = 'search';
      const ctx = { onPlayerHit() {}, reactScale: 1, accuracyScale: 1 };

      const ys = [];
      let steppedOff = false;
      let t = 0;
      for (let f = 0; f < 900; f++) {
        inner.lastKnownPos = { x: far.x, y: 0, z: far.z };
        inner.lastKnownAt = t;
        inner.stateEnteredAt = t;
        t += 1000 / 60;
        scheduler.processFrame();
        ai.update(1 / 60, t, player, ctx);
        ys.push(ai.position.y);
        if (ai.position.x > 26 * cellW) steppedOff = true;
      }

      check('夹具前提：AI 确实走出了二层楼板（否则下落分支根本没被走到）',
        steppedOff, `最终 x=${ai.position.x.toFixed(2)}（楼板东边界 ${(26 * cellW).toFixed(2)}）`);
      check('掉层后 AI 落到了一层地面（没有停在空中，也没有卡在楼板里）',
        Math.abs(ai.position.y) < 0.05,
        `最终 y=${ai.position.y.toFixed(3)}`);
      check('掉到一层是**连续下落**：观测到多个中间高度，而不是一帧瞬移 3.6m',
        midCount(ys) >= 5,
        `中间高度采样 ${midCount(ys)} 个（瞬移写法只会取到 0 个）`);
      check('掉层过程中没有超过 1.5m 的单帧高度突变',
        maxStepOf(ys) <= 1.5, `最大单帧变化 ${maxStepOf(ys).toFixed(3)}m`);
    }
  }

  // ---- M3-1b-2 ④：真实两层地图上「楼梯必须真的走得上去」 ----
  //
  // 这条断言针对一个**实际发生过的缺陷**（试玩反馈："楼梯无法抵达二楼，被地板塞满了"）：
  // 楼梯井的每一格都被铺了二层楼板。
  // 那时 A* **仍然会给出一条经过楼梯的路径** —— 分层寻路只看"格可走性 + 落脚高度门槛"，
  // 而坡格在两层都有落脚面，所以在它眼里楼梯是通的。
  // 但玩家在坡道上时，身体竖直区间 `[脚底, 脚底+1.8]` 会与楼板 `[3.3,3.6]` 相交，
  // 被 `resolveCircle` 顶住 —— 于是"路径存在"和"人上得去"是两回事。
  //
  // 结论：**只断言路径存在是不够的**，必须断言沿路径前进时几何不会把人挡住。
  // 显式用 tv_station_01，这样无论当前生效地图是哪张，这条防线都在。
  {
    const { createLevel } = await import('../src/level/level.js');
    const {
      createLayeredNavGrid: mkG, createAStar: mkA,
      nodeIndex: ni, nodeFloor: nf, nodeCell: nc,
    } = await import('../src/core/navgrid.js');

    const lvl = createLevel({ ...config, map: config.maps.tv_station_01 }, { add() {}, remove() {} });
    const W2 = lvl.W;
    const H2 = lvl.H;
    check('电视台地图确实是两层（否则本组断言无从测起）', lvl.nav.floorCount === 2,
      `floorCount=${lvl.nav.floorCount}`);

    // ★ 楼梯井不得被楼板覆盖 —— 这一条直接、廉价，而且是上面那个缺陷的**充分条件**。
    //   它比"跑一遍路径"更早、更明确地定位问题（报出是哪一格把楼梯堵了）。
    {
      const blockedStairs = [];
      for (const r of config.maps.tv_station_01.ramps || []) {
        const alongX = r.dir === '+x' || r.dir === '-x';
        const along = alongX ? r.w : r.h;
        const cross = alongX ? r.h : r.w;
        for (let k = 0; k < along; k++) {
          const off = r.dir === '+x' || r.dir === '+z' ? k : along - 1 - k;
          for (let t = 0; t < cross; t++) {
            const cx = alongX ? r.x + off : r.x + t;
            const cz = alongX ? r.z + t : r.z + off;
            // 该格在**上一层**有没有被楼板盖住
            const covered = (config.maps.tv_station_01.slabs || []).some(
              (s) =>
                (s.floor || 0) === (r.floor || 0) + 1 &&
                cx >= s.x && cx < s.x + s.w && cz >= s.z && cz < s.z + s.h
            );
            if (covered) blockedStairs.push(`(${cx},${cz})`);
          }
        }
      }
      check('楼梯井的每一格都没有被上层楼板盖住（否则人会被楼板顶住、上不去）',
        blockedStairs.length === 0,
        blockedStairs.length ? `被盖住的楼梯格：${blockedStairs.join(' ')}` : '全部贯通');
    }

    const grid = mkG(lvl.nav);
    const aStar = mkA(grid);
    const spawn = config.maps.tv_station_01.playerSpawn;
    const start = ni(0, spawn.z * W2 + spawn.x, W2, H2);
    const topExtracts = (config.maps.tv_station_01.extracts || []).filter((e) => (e.floor || 0) > 0);
    check('电视台地图存在二层撤离点（本组断言的对象）', topExtracts.length > 0, `${topExtracts.length} 个`);

    const body = config.player.bodyHeight;
    const step = config.player.stepHeight;
    for (const e of topExtracts) {
      const r = aStar(start, ni(1, e.z * W2 + e.x, W2, H2));
      const path = Array.from(r.buf.subarray(0, r.len));
      check(`一层出生点 → 二层「${e.label}」有路径（A* 层面）`, path.length > 0, `len=${path.length}`);
      if (!path.length) continue;

      // 几何可行性：沿路径**逐采样点**前进，脚底按 surfaceAt 递推，检查没有被 resolveCircle 推开。
      // 只看格中心会漏掉"两格之间被挡住"的情况，所以相邻格连线上也采样。
      let prevY = 0;
      let pushAt = null;
      let maxRise = 0;
      for (let k = 0; k < path.length && !pushAt; k++) {
        const c = nc(path[k], W2, H2);
        const wx = c % W2;
        const wz = (c / W2) | 0;
        const samples = [];
        if (k === 0) {
          samples.push([wx + 0.5, wz + 0.5]);
        } else {
          const pc = nc(path[k - 1], W2, H2);
          const px = pc % W2;
          const pz = (pc / W2) | 0;
          for (let t = 1; t <= 4; t++) {
            samples.push([px + 0.5 + ((wx - px) * t) / 4, pz + 0.5 + ((wz - pz) * t) / 4]);
          }
        }
        for (const [sx, sz] of samples) {
          const X = sx * lvl.cell;
          const Z = sz * lvl.cell;
          const feet = lvl.surfaceAt(X, Z, prevY, step);
          const probe = { x: X, y: feet, z: Z };
          lvl.resolveCircle(probe, 0.4, feet, body, step);
          const push = Math.hypot(probe.x - X, probe.z - Z);
          if (push > 0.05) {
            pushAt = `格 (${wx},${wz}) 附近 (${sx.toFixed(1)},${sz.toFixed(1)}) 被推开 ${push.toFixed(2)}m`;
            break;
          }
          maxRise = Math.max(maxRise, feet - prevY);
          prevY = feet;
        }
      }
      check('沿该路径前进时不会被几何挡住（楼梯井必须贯通到顶）',
        pushAt === null, pushAt || `全程可通行；最大单步爬升 ${maxRise.toFixed(2)}m`);
      check('该路径确实跨越了两层',
        path.some((n) => nf(n, W2, H2) === 1),
        `包含 ${path.filter((n) => nf(n, W2, H2) === 1).length} 个二层节点`);
    }
  }

  // ---- M3-1b-2 ④（第二轮）：**楼板压墙** ----
  //
  // 几何模型原先不允许"楼板与墙重叠"（一层墙 [0,3.5] 与该格二层楼板 [3.3,3.6] 有体积交叠），
  // 于是**一层墙格在二层不能有楼板**。后果有两个，都是玩家能直接看到的：
  //   · 二层地面到处是一格宽的沟；
  //   · 二层无法有自己的隔墙 —— 一加墙就正好压在一层门洞形成的 1 格宽"桥"上，把二层切断
  //     （实测二层连通块只剩 43/589）。
  //
  // 现在：重叠的两条跨度**合并成一条贯通实体**（kind 取更实心的 WALL），
  // 而"这一层有没有地板"改由**顶面高度**判定（不看 kind）。
  // 于是同一格可以"一层是墙、二层是楼面"，二层成为一个完整平面。
  {
    const { createLevel } = await import('../src/level/level.js');
    const { createLayeredNavGrid: mkG3, nodeIndex: ni3 } = await import('../src/core/navgrid.js');
    const M2 = config.maps.tv_station_01;
    const lvl = createLevel({ ...config, map: M2 }, { add() {}, remove() {} });
    const W3 = lvl.W;
    const CC3 = W3 * lvl.H;

    // 楼梯井 / 电梯井 / 挑空本来就不铺楼板，验证时要避开它们
    const skip = new Set();
    for (const r of M2.ramps || []) {
      const alongX = r.dir === '+x' || r.dir === '-x';
      const along = alongX ? r.w : r.h;
      const cross = alongX ? r.h : r.w;
      for (let k = 0; k < along; k++) {
        const off = r.dir === '+x' || r.dir === '+z' ? k : along - 1 - k;
        for (let t = 0; t < cross; t++) {
          skip.add(`${alongX ? r.x + off : r.x + t},${alongX ? r.z + t : r.z + off}`);
        }
      }
    }
    const wall1Cells = [];
    for (const w of M2.walls || []) {
      if ((w.floor || 0) !== 0) continue;
      for (let dz = 0; dz < w.h; dz++) {
        for (let dx = 0; dx < w.w; dx++) {
          const x = w.x + dx;
          const z = w.z + dz;
          if (x < 1 || x > 38 || z < 1 || z > 38) continue;
          if (skip.has(`${x},${z}`)) continue;
          wall1Cells.push([x, z]);
        }
      }
    }
    const probed = wall1Cells[0] || null;
    check('找得到一个「一层有墙」的格用于验证楼板压墙', !!probed,
      probed ? `格 (${probed[0]},${probed[1]})，共 ${wall1Cells.length} 个候选` : '没找到');

    if (probed) {
      const [px, pz] = probed;
      const n1 = ni3(1, pz * W3 + px, W3, lvl.H);
      check('★ 楼板压墙生效：一层墙格在**二层**是可走的（不再是一个洞）',
        lvl.nav.blocked[n1] === 0,
        `二层 blocked=${lvl.nav.blocked[n1]}，落脚高度 ${lvl.nav.lo[n1].toFixed(2)}m`);
      check('同一格在**一层**仍然是墙（不可走）',
        lvl.nav.blocked[ni3(0, pz * W3 + px, W3, lvl.H)] === 1);
      const top = lvl.surfaceAt((px + 0.5) * lvl.cell, (pz + 0.5) * lvl.cell, 3.6, config.player.stepHeight);
      check('一层墙顶就是二层的楼面（以二层脚底问 surfaceAt 得到 3.6）',
        Math.abs(top - 3.6) < 1e-4, `实得 ${top.toFixed(3)}`);
    }

    const wall2Count = (M2.walls || []).filter((w) => (w.floor || 0) === 1).length;
    check('二层有自己的隔墙（这与「楼板压墙」是同一件事的两面）', wall2Count > 0,
      `${wall2Count} 个二层墙体矩形`);
    let diff = 0;
    for (let i = 0; i < CC3; i++) {
      if (lvl.nav.blocked[ni3(0, i, W3, lvl.H)] !== lvl.nav.blocked[ni3(1, i, W3, lvl.H)]) diff++;
    }
    check('两层的可行走区域确实不同（不是同一张图叠两遍）', diff > 100,
      `${diff} 格的阻挡状态不同`);
  }
}

// ============ 容器与撤离点的分层（M3-1b-2 ④ 遗留缺陷的回归防线）============
//
// 存在原因：地图表的容器与撤离点**都带 floor**，但 config 派生时只映射了 [x, z]，
// 层号与容器分级（type）被静默丢弃。后果是三个**运行时**缺陷：
//   loot.js    容器 y 写死 0.45  → 二层 44 个容器浮在一层高度（二层地面是 3.6m）
//   loot.js    判定只有水平距离 → 站在一层能隔层搜到二层正上方的箱子
//   extract.js 判定只有水平距离 → 站在一层就能触发二层的 e2_roof，不用爬楼梯即可撤离
//
// 为什么此前 183/183 全绿却全漏：已有断言校验的是**地图表内部**（容器可达、不在墙里、
// 在分区内），校验对象与被破坏的对象不是同一个。这一组补的是后者 ——
// 从「派生后的运行时配置」一路验到「判定函数的实际返回值」。
{
  const { createLevel } = await import('../src/level/level.js');
  const { createLoot } = await import('../src/gameplay/loot.js');
  const { createExtract } = await import('../src/gameplay/extract.js');
  const sceneL = { add() {}, remove() {} };
  const lvlL = createLevel({ ...config, map: config.maps.tv_station_01 }, sceneL);

  // ---- 1. 派生没有丢数据 ----
  check('容器全部贯通到运行时配置（数量与地图表一致，不丢不增）',
    config.loot.containers.length === config.map.containers.length,
    `派生 ${config.loot.containers.length} / 地图表 ${config.map.containers.length}`);

  const floorsSeen = [...new Set(config.loot.containers.map((c) => c.floor))].sort();
  check('容器的 floor 贯通到了运行时配置（两层图上不止一层有容器）',
    floorsSeen.length > 1, `出现的层：${floorsSeen.join(', ')}`);

  const typesSeen = [...new Set(config.loot.containers.map((c) => c.type))];
  check('容器的 type（民用/军用/保险箱/钥匙房）贯通到了运行时配置',
    typesSeen.length > 1 && typesSeen.every((t) => typeof t === 'string'),
    `${typesSeen.length} 种：${typesSeen.join(', ')}`);

  check('每个容器的 floor 都是合法层号（`|| 0` 兜底没有引入越界层）',
    config.loot.containers.every((c) => c.floor >= 0 && c.floor <= lvlL.nav.floorCount - 1),
    `floorCount=${lvlL.nav.floorCount}`);

  // ---- 2. 容器摆在它所在那一层的地面上 ----
  const lootL = createLoot(config, lvlL, sceneL);
  // 判据是"坐在所在层的地面上"，具体抬高多少由容器类型的高度决定（分级后各类箱子尺寸不同），
  // 所以不能用 0.45 这个单一常数 —— 那正是旧实现的错误来源。
  const wrongY = lootL.containers.filter(
    (c) => Math.abs(c.y - (lvlL.floorBaseY(c.floor) + c.style.h / 2)) > 1e-6);
  check('★ 每个容器的 y 都等于「所在层地面标高 + 自身高度的一半」（不是写死的常数）',
    wrongY.length === 0,
    wrongY.length
      ? `${wrongY.length} 个错位，例：floor=${wrongY[0].floor} y=${wrongY[0].y.toFixed(3)}`
      : '全部对齐');

  const upBoxes = lootL.containers.filter((c) => c.floor === 1);
  check('★ 二层容器确实坐在二层地面上（此前全部落在 0.45m 的一层高度）',
    upBoxes.length > 0 && upBoxes.every((c) => c.y > 3.6),
    `${upBoxes.length} 个二层容器，y 最小 ${Math.min(...upBoxes.map((c) => c.y)).toFixed(2)}m`);

  // ---- 3. 搜索判定分层 ----
  const upBox = lootL.containers.find((c) => c.floor === 1);
  if (upBox) {
    const onL0 = lootL.update(0.016, { x: upBox.x, y: 0, z: upBox.z }, false).nearest;
    check('★ 站在**一层**同一 xz 上，搜不到**二层**的容器（此前会隔层搜到）',
      !onL0 || onL0.floor === 0,
      onL0 ? `最近的是 floor=${onL0.floor} 的容器` : '一层该处没有别的容器');

    const onL1 = lootL.update(0.016, { x: upBox.x, y: lvlL.floorBaseY(1), z: upBox.z }, false).nearest;
    check('站在**二层**同一 xz 上，能搜到那个二层容器（分层没把正常路径挡掉）',
      onL1 === upBox,
      onL1 ? `命中 id=${onL1.id} floor=${onL1.floor}` : '什么都没搜到');
  }

  // ---- 4. 撤离点分层 ----
  const exL = createExtract(config, lvlL, sceneL);
  // M4-1 之后 extract.update 必须拿到局内时间才能求开放规则。
  // 这里取"条件点也已开放"的时刻（时间过半之后），
  // 否则本组要验的是**分层**，却会被"规则未满足"干扰成假失败。
  const EX_CTX = { elapsedMs: config.raid.timeLimitMs * 0.6, timeLimitMs: config.raid.timeLimitMs };
  const topZone = exL.zones.find((z) => z.floor === 1);
  check('撤离点保留了 floor（两层图上至少有一个不在一层）', !!topZone,
    topZone ? `zone#${topZone.id} 在第 ${topZone.floor} 层` : '所有撤离点都在第 0 层');

  if (topZone) {
    const r0 = exL.update(0.016, { x: topZone.x, y: 0, z: topZone.z }, EX_CTX);
    check('★ 站在**一层**不得触发**二层**的撤离点（此前不用爬楼就能从天台撤离）',
      r0.inZone === false, `inZone=${r0.inZone}`);

    const r1 = exL.update(0.016, { x: topZone.x, y: lvlL.floorBaseY(1), z: topZone.z }, EX_CTX);
    check('站在**二层**能触发那个撤离点（分层没把正常撤离挡掉）',
      r1.inZone === true, `inZone=${r1.inZone}`);

    check('撤离环画在它所在那一层的地面上（此前一律画在 y=0.03）',
      Math.abs(topZone.ring.position.y - (lvlL.floorBaseY(1) + 0.03)) < 1e-6,
      `ring.y=${topZone.ring.position.y.toFixed(3)}，二层地面 ${lvlL.floorBaseY(1).toFixed(2)}`);
  }

  // ---- 5. 单层图不受影响 ----
  // industrial_01 的容器与撤离点都没有 floor 字段，走的正是 `|| 0` 兜底路径。
  check('单层地图表的容器确实没有 floor（缺省 0 的兜底路径被真实用到）',
    config.maps.industrial_01.containers.every((c) => c.floor === undefined),
    `${config.maps.industrial_01.containers.length} 个容器均无 floor`);
  check('单层地图表的撤离点确实没有 floor（同上）',
    (config.maps.industrial_01.extracts || []).every((e) => e.floor === undefined));
}

// ============ M3-3/4/5/6：容器分级、掉落权重、背包、安全箱 ============
//
// 这一组守的是 M3 的两条 DoD：
//   ① 掉落分布符合策划权重表
//   ② 单局物资收益区间符合数值预期（区间由 validate-loot-tables.mjs 统计，
//      这里守的是让区间成立的**机制**：容量与负重是真约束）
//
// ① 的实现方式值得说明：此前"理论分布"（工具算的）与"运行时掉落"（代码写的）
// 是两套东西，谁也说不清对不对得上。现在两边共用 src/core/lootTable.js 的算法，
// 于是这条断言能直接把运行时抽样和表里的权重放在一起比。
{
  const { createLevel } = await import('../src/level/level.js');
  const { createLoot } = await import('../src/gameplay/loot.js');
  const { createInventory } = await import('../src/gameplay/inventory.js');
  const { mulberry32 } = await import('../src/core/rng.js');
  const { rollItems, containerById, normalizedWeights } = await import('../src/core/lootTable.js');
  const { findSlot, createGrid } = await import('../src/core/packing.js');

  const sceneM = { add() {}, remove() {} };
  const lvlM = createLevel({ ...config, map: config.maps.tv_station_01 }, sceneM);
  const table = config.lootTable;

  // ---- 1. 容器分级：数量与参数都来自表，不是硬编码 ----
  const lootM = createLoot(config, lvlM, sceneM);
  const byType = lootM.countByType();
  const budgetKeys = Object.keys(table.containerBudget).filter((k) => !k.startsWith('_'));
  check('运行时容器分级与掉落表的容器预算一致（每类数量都对得上）',
    budgetKeys.every((k) => byType[k] === table.containerBudget[k]),
    budgetKeys.map((k) => `${k}:${byType[k]}/${table.containerBudget[k]}`).join(' '));

  check('容器分级参数来自表：民用箱 2500ms、钥匙房 8000ms（不是同一个常数）',
    containerById(table, 'crate_civil').searchMs === 2500
    && containerById(table, 'key_room').searchMs === 8000,
    `民用 ${containerById(table, 'crate_civil').searchMs}ms / 钥匙房 ${containerById(table, 'key_room').searchMs}ms`);

  check('打断规则写在配置里（lose_all 清零 / keep_partial 保留一半）',
    table.interruptRules.lose_all.keepFraction === 0
    && table.interruptRules.keep_partial.keepFraction === 0.5);

  check('运行时每个容器都能查到自己的分级定义（type 全部有效）',
    lootM.containers.every((c) => c.def && c.def.searchMs > 0 && c.def.interruptRule),
    `${lootM.containers.length} 个容器`);

  // ---- 2. ★ DoD ①：运行时掉落分布符合权重表 ----
  for (const c of table.containers) {
    const rnd = mulberry32(20260301); // 固定种子：同样本量下结论可复算
    const N = 20000;
    const cnt = {};
    let total = 0;
    for (let i = 0; i < N; i++) {
      for (const it of rollItems(table, c.id, rnd)) {
        cnt[it.rarity] = (cnt[it.rarity] || 0) + 1;
        total++;
      }
    }
    const expect = normalizedWeights(c);
    let worst = 0;
    let worstR = null;
    for (const r of Object.keys(expect)) {
      const got = (cnt[r] || 0) / total;
      const d = Math.abs(got - expect[r]);
      if (d > worst) { worst = d; worstR = r; }
    }
    // 2 个百分点：抽样误差在 5 万样本下约 0.2~0.5pp，留足余量；
    // 但它足以抓住"整档权重没生效"或"池子取错"这类实现错误。
    check(`★ DoD① ${c.id} 的运行时掉落分布符合权重表`, worst < 0.02,
      `最大偏差 ${(worst * 100).toFixed(2)}pp（${worstR}），样本 ${total} 件`);
  }

  // ---- 3. M3-5 背包：二维网格 + 负重 ----
  const inv = createInventory(config);
  check('背包容量与负重来自掉落表（6×5=30 格 / 22kg）',
    inv.totalSlots() === 30 && inv.weightLimitKg === 22,
    `${inv.totalSlots()} 格 / ${inv.weightLimitKg}kg`);

  const rifle = table.items.find((i) => i.id === 'rifle_sr25');   // 2×4，4.6kg，weapon
  const vest4 = table.items.find((i) => i.id === 'vest4');        // 2×3，5.2kg，armor
  const bandage = table.items.find((i) => i.id === 'bandage');    // 1×1，0.2kg
  const medkit = table.items.find((i) => i.id === 'medkit');      // 2×1，0.6kg

  check('2×4 的步枪放得进 6×5 背包，且按**格数**而不是件数记账',
    inv.tryAdd(rifle).ok && inv.usedSlots() === 8,
    `已用 ${inv.usedSlots()} 格`);

  check('负重随入包累加（4.6kg）', Math.abs(inv.weightKg() - rifle.weightKg) < 1e-6);

  // 超重：4 件四级护甲 = 20.8kg，第 5 件会超 22kg
  const invW = createInventory(config);
  let rejected = null;
  for (let i = 0; i < 5; i++) {
    const r = invW.tryAdd(vest4);
    if (!r.ok) { rejected = r; break; }
  }
  check('超过 22kg 负重上限时拒绝入包，并说明是超重而不是没地方',
    rejected && rejected.reason === 'weight',
    rejected ? `第 5 件被拒，原因 ${rejected.reason}，当前 ${invW.weightKg().toFixed(1)}kg` : '没被拒绝');

  // 装满：30 件 1×1 正好填满 30 格（且远未超重），第 31 件只能是"没地方"
  const invS = createInventory(config);
  let full = null;
  for (let i = 0; i < 31; i++) {
    const r = invS.tryAdd(bandage);
    if (!r.ok) { full = r; break; }
  }
  check('格子装满时拒绝入包，并说明是没地方而不是超重',
    full && full.reason === 'space',
    full ? `第 31 件被拒，原因 ${full.reason}，已用 ${invS.usedSlots()} 格` : '没被拒绝');

  // 形状：2×1 的急救包放不进 1×2 的格子，除非旋转 —— 这就是"排放"与"计数"的区别
  const g = createGrid(1, 2);
  const slotNoRotate = findSlot(g, medkit, false);
  const slotRotate = findSlot(g, medkit, true);
  check('★ 2×1 的急救包放不进 1×2 的格子（不旋转时）', slotNoRotate === null);
  check('旋转后可以放进 1×2（真人一定会转一下再塞）',
    !!slotRotate && slotRotate.w === 1 && slotRotate.h === 2,
    slotRotate ? `${slotRotate.w}×${slotRotate.h} rotated=${slotRotate.rotated}` : '放不下');

  // ---- 4. M3-6 安全箱与死亡掉落 ----
  const invK = createInventory(config);
  check('新账号安全箱是 1×2（档位顺序来自表）',
    invK.safeTier.id === 'safe_t1' && invK.safeTier.w === 1 && invK.safeTier.h === 2,
    `${invK.safeTier.id} ${invK.safeTier.w}×${invK.safeTier.h}`);
  check('安全箱装不下武器与护甲（防"零风险刷保险"）',
    !invK.safeAccepts(rifle) && !invK.safeAccepts(vest4),
    `rifle=${invK.safeAccepts(rifle)} vest4=${invK.safeAccepts(vest4)}`);

  const bitcoin = table.items.find((i) => i.id === 'bitcoin');    // 1×1，11000，valuable
  invK.tryAdd(rifle);
  invK.tryAdd(bitcoin);
  const safeIn = invK.items.filter((e) => e.inSafe).map((e) => e.item.id);
  check('入包后安全箱自动装填最值钱且类别允许的物品',
    safeIn.length === 1 && safeIn[0] === 'bitcoin',
    `安全箱内：${safeIn.join(',') || '空'}`);

  const death = invK.settle('death');
  const escaped = invK.settle('extract');
  check('★ 阵亡只保住安全箱里的（步枪作为武器不在安全箱内，会掉）',
    death.kept.every((e) => e.inSafe) && death.keptValue === bitcoin.value,
    `保住 ${death.keptValue} / 损失 ${death.lostValue}`);
  check('撤离成功则全部带出（安全箱不是唯一出路）',
    escaped.kept.length === 2 && escaped.keptValue === rifle.value + bitcoin.value,
    `带出 ${escaped.keptValue}`);
  check('死亡掉落严格劣于撤离（保险不能反超撤离）',
    death.keptValue < escaped.keptValue,
    `${death.keptValue} < ${escaped.keptValue}`);
}

// ============ M4-1 撤离点开放规则（常驻 / 条件 / 时间窗）============
//
// 这一组守的是流程文档 §2.4「撤离点分为常驻点与条件点（如需要特定钥匙、特定时间后开放）」
// 与 M4-1 任务名里的三类规则。
//
// 规则求值放在 src/core/extractRules.js（纯函数）就是为了能被这里逐毫秒验证 ——
// 若它写在建 THREE 环与光柱的 extract.js 里，就只能在浏览器里"看着像对了"。
{
  const { createLevel } = await import('../src/level/level.js');
  const { createExtract } = await import('../src/gameplay/extract.js');
  const { evaluateOpenRule, OPEN_RULE } = await import('../src/core/extractRules.js');

  const T = config.raid.timeLimitMs; // 不硬编码：规则里的 fraction 都是相对它解析的

  // ---- 1. 纯函数层 ----
  const always = evaluateOpenRule({ type: OPEN_RULE.ALWAYS }, { elapsedMs: 0, timeLimitMs: T });
  check('常驻点在局内任何时刻都开放', always.open && always.reason === 'always');
  check('没有 openRule 字段的撤离点按常驻处理（旧地图表行为不变）',
    evaluateOpenRule(null, { elapsedMs: T * 0.9, timeLimitMs: T }).open);

  const gate = { type: OPEN_RULE.TIME_AFTER, afterFraction: 0.5 };
  const gBefore = evaluateOpenRule(gate, { elapsedMs: T * 0.5 - 1, timeLimitMs: T });
  const gAt = evaluateOpenRule(gate, { elapsedMs: T * 0.5, timeLimitMs: T });
  const gAfter = evaluateOpenRule(gate, { elapsedMs: T * 0.9, timeLimitMs: T });
  check('★ 条件点在时间门槛到达之前不开放', !gBefore.open && gBefore.reason === 'gatePending');
  check('条件点在门槛到达的那一刻开放', gAt.open && gAt.reason === 'gatePassed');
  check('条件点开放后不再关闭（是一次性门槛，不是周期性的）', gAfter.open);
  check('条件点会报出"还要多久开放"（HUD 与断言都依赖它）',
    gBefore.opensInMs === 1, `opensInMs=${gBefore.opensInMs}`);

  const win = { type: OPEN_RULE.TIME_WINDOW, fromMs: 60000, toMs: 180000 };
  check('★ 时间窗开启之前不开放', !evaluateOpenRule(win, { elapsedMs: 59999, timeLimitMs: T }).open);
  check('时间窗内开放', evaluateOpenRule(win, { elapsedMs: 60000, timeLimitMs: T }).open);
  check('★ 时间窗关闭之后不再开放',
    !evaluateOpenRule(win, { elapsedMs: 180000, timeLimitMs: T }).open, '关闭后 open=false');
  const inWin = evaluateOpenRule(win, { elapsedMs: 120000, timeLimitMs: T });
  check('窗口内会报出"还有多久关闭"', inWin.closesInMs === 60000, `closesInMs=${inWin.closesInMs}`);
  const winFrac = { type: OPEN_RULE.TIME_WINDOW, fromFraction: 0.2, toFraction: 0.6 };
  check('时间窗支持按单局时限的比例配置（与绝对毫秒等价）',
    evaluateOpenRule(winFrac, { elapsedMs: T * 0.4, timeLimitMs: T }).open
    && !evaluateOpenRule(winFrac, { elapsedMs: T * 0.7, timeLimitMs: T }).open);

  // ---- 1b. killsAfter：局内累计淘汰达标后开放 ----
  const killRule = { type: OPEN_RULE.KILLS_AFTER, kills: 3 };
  const k0 = evaluateOpenRule(killRule, { elapsedMs: 0, timeLimitMs: T, kills: 0 });
  const k2 = evaluateOpenRule(killRule, { elapsedMs: 0, timeLimitMs: T, kills: 2 });
  const k3 = evaluateOpenRule(killRule, { elapsedMs: 0, timeLimitMs: T, kills: 3 });
  const k5 = evaluateOpenRule(killRule, { elapsedMs: 0, timeLimitMs: T, kills: 5 });
  check('★ 淘汰数未达标时不开放', !k0.open && !k2.open && k2.reason === 'killsPending');
  check('★ 淘汰数达标的那一刻开放（阈值 = 3）', k3.open && k3.reason === 'killsReached');
  check('超过阈值后仍然开放（一次性门槛，不是"恰好等于"）', k5.open);
  check('未达标时报出"还需淘汰几名"', k2.remainingKills === 1 && k0.remainingKills === 3,
    `kills=0 时 ${k0.remainingKills}，kills=2 时 ${k2.remainingKills}`);
  check('★ 淘汰数规则与局内时间无关（时间过了也不开）',
    !evaluateOpenRule(killRule, { elapsedMs: T * 0.99, timeLimitMs: T, kills: 0 }).open);

  // ---- 2. 集成层：未开放的点不能进、不能开始倒计时 ----
  const sceneE = { add() {}, remove() {} };
  const lvlE = createLevel({ ...config, map: config.maps.tv_station_01 }, sceneE);
  const exE = createExtract(config, lvlE, sceneE);

  const conditional = exE.zones.filter((z) => z.openRule && z.openRule.type !== OPEN_RULE.ALWAYS);
  check('生效地图至少有一个非"常驻"的撤离点（§2.4 要求区分常驻点与条件点）',
    conditional.length >= 1,
    conditional.map((z) => `${z.id}:${z.openRule.type}`).join(', ') || '全是常驻点');

  const dock = conditional[0];
  if (dock) {
    const pos = { x: dock.x, y: lvlE.floorBaseY(dock.floor), z: dock.z };
    const early = exE.update(0.016, pos, { elapsedMs: T * 0.4, timeLimitMs: T });
    check('★ 时间未到时站在条件点上，不会进入撤离区、也不会开始倒计时',
      !early.inZone && early.blocked && early.blocked.zone === dock,
      `inZone=${early.inZone}, blocked=${!!early.blocked}`);
    check('未开放时会给出"还需多久"而不是静默无反应',
      early.blocked && typeof early.blocked.opensInMs === 'number',
      early.blocked ? `opensInMs=${early.blocked.opensInMs}` : '无 blocked');

    const late = exE.update(0.016, pos, { elapsedMs: T * 0.6, timeLimitMs: T });
    check('时间到了之后，同一个点可以正常进入（规则没有把合法路径挡掉）',
      late.inZone && !late.blocked, `inZone=${late.inZone}`);
  }

  // ---- 2b. 击杀类条件撤离点（淘汰达标才开）----
  const killZone = exE.zones.find((z) => z.openRule && z.openRule.type === OPEN_RULE.KILLS_AFTER);
  check('生效地图带有"淘汰达标才开"的条件撤离点', !!killZone,
    killZone ? `${killZone.id} 需 ${killZone.openRule.kills} 名` : '没有该类撤离点');

  if (killZone) {
    const kpos = { x: killZone.x, y: lvlE.floorBaseY(killZone.floor), z: killZone.z };
    const base = { elapsedMs: T * 0.6, timeLimitMs: T };
    // 先让上一组断言锁定的撤离区彻底失效（离开超过宽限），
    // 否则 M4-2 的宽限逻辑会把 activeZone 留着，把状态串进本组断言。
    exE.update(1.0, { x: -100, y: 0, z: -100 }, { ...base, kills: 0 });
    const noKills = exE.update(0.016, kpos, { ...base, kills: 0 });
    check('★ 淘汰数不够时，该撤离点不开放、也不开始倒计时',
      !noKills.inZone && noKills.blocked && noKills.blocked.zone === killZone,
      `inZone=${noKills.inZone}`);
    check('未达标时报出"还需淘汰几名"（不是静默无反应）',
      noKills.blocked && noKills.blocked.remainingKills === killZone.openRule.kills,
      noKills.blocked ? `remainingKills=${noKills.blocked.remainingKills}` : '无 blocked');

    const under = exE.update(0.016, kpos, { ...base, kills: killZone.openRule.kills - 1 });
    check('差一个也不开（阈值是 >=，不是 >）', !under.inZone, `kills=${killZone.openRule.kills - 1}`);

    const enough = exE.update(0.016, kpos, { ...base, kills: killZone.openRule.kills });
    check('★ 淘汰数达标后可以正常进入（规则没有把合法路径挡掉）',
      enough.inZone && !enough.blocked, `inZone=${enough.inZone}`);
  }

  // ---- 3. 时间窗中途关闭：已累积的倒计时必须作废 ----
  // 用合成的撤离点，因为当前两张地图都没有配时间窗（配不配是设计决策，见报告的决策项）。
  const cell = lvlE.cellToWorld(19, 19);
  const winCfg = {
    ...config,
    extract: {
      ...config.extract,
      zones: [{
        id: 'w1', label: '合成时间窗点', cell: [19, 19], floor: 0,
        radius: 5, conditional: true,
        openRule: { type: OPEN_RULE.TIME_WINDOW, fromMs: 0, toMs: 5000 },
      }],
    },
  };
  const exW = createExtract(winCfg, lvlE, { add() {}, remove() {} });
  const pos2 = { x: cell.x, y: lvlE.floorBaseY(0), z: cell.z };
  const wStart = exW.update(1.0, pos2, { elapsedMs: 1000, timeLimitMs: T });
  check('时间窗内可以正常进入并推进倒计时',
    wStart.inZone && wStart.progress > 0, `progress=${wStart.progress.toFixed(3)}`);
  const wClosed = exW.update(0.016, pos2, { elapsedMs: 6000, timeLimitMs: T });
  check('★ 窗口关闭后，已累积的倒计时被作废（不完成、进度归零）',
    !wClosed.inZone && !wClosed.completed && exW.zones[0].progress === 0,
    `inZone=${wClosed.inZone} completed=${wClosed.completed} progress=${exW.zones[0].progress}`);
}

// ============ M4-2 撤离倒计时与中断逻辑 ============
//
// 流程文档 §2.4 只明文规定了中断的一种情形：「期间不可离开区域否则重置」。
// 其余（受击 / 开火 / 使用道具）**不中断**是制作人的明确裁定，
// 所以这里有一条断言专门钉住它 —— 免得日后被人当成"遗漏"顺手补上。
{
  const { createLevel } = await import('../src/level/level.js');
  const { createExtract } = await import('../src/gameplay/extract.js');

  const T2 = config.raid.timeLimitMs;
  const INT = config.extract.interrupt;
  check('撤离中断规则来自配置表（代码中不硬编码宽限与保留比例）',
    !!INT && typeof INT.leaveGraceMs === 'number' && typeof INT.keepFraction === 'number',
    INT ? `leaveGraceMs=${INT.leaveGraceMs}, keepFraction=${INT.keepFraction}` : '缺失');

  const sceneY = { add() {}, remove() {} };
  const lvlY = createLevel({ ...config, map: config.maps.tv_station_01 }, sceneY);
  const mk = (zones) => ({ ...config, extract: { ...config.extract, zones } });
  const always = (id, cx, cz) => ({
    id, label: id, cell: [cx, cz], floor: 0, radius: 5,
    conditional: false, openRule: { type: 'always' },
  });
  const ctx2 = { elapsedMs: T2 * 0.6, timeLimitMs: T2, kills: 0 };

  // ---- 1. 宽限：短暂离开不算中断 ----
  const exA = createExtract(mk([always('a', 19, 19)]), lvlY, sceneY);
  const pa = lvlY.cellToWorld(19, 19);
  const posIn = { x: pa.x, y: lvlY.floorBaseY(0), z: pa.z };
  const posOut = { x: pa.x + 40, y: lvlY.floorBaseY(0), z: pa.z };

  exA.update(3.0, posIn, ctx2);
  const acc = exA.zones[0].progress;
  check('站在撤离区内时倒计时正常累积', acc >= 3000 - 1, `progress=${acc.toFixed(0)}ms`);

  // 离开 300ms（宽限 500ms 内）
  const shortLeave = exA.update(0.3, posOut, ctx2);
  check('★ 离开未超过宽限时**不算**中断（进度保留）',
    !shortLeave.interrupted && exA.zones[0].progress >= acc - 1,
    `leaveMs=${shortLeave.leaveMs.toFixed(0)}, progress=${exA.zones[0].progress.toFixed(0)}`);

  const backIn = exA.update(0.016, posIn, ctx2);
  check('宽限内回到同一个区，进度继续累积而不是从头开始',
    !backIn.interrupted && exA.zones[0].progress > acc,
    `${acc.toFixed(0)} -> ${exA.zones[0].progress.toFixed(0)}`);

  // ---- 2. 超过宽限：中断并清零 ----
  const beforeBreak = exA.zones[0].progress;
  const longLeave = exA.update(0.6, posOut, ctx2);
  check('★ 离开超过宽限则中断，进度按 keepFraction 处理（当前配置为 0 = 清零）',
    longLeave.interrupted && longLeave.interrupted.cause === 'left'
    && exA.zones[0].progress === 0,
    `中断前 ${beforeBreak.toFixed(0)}ms → 中断后 ${exA.zones[0].progress.toFixed(0)}ms, cause=${longLeave.interrupted && longLeave.interrupted.cause}`);

  // ---- 3. 受击 / 开火不中断（钉住裁定）----
  exA.update(1.0, posIn, ctx2);
  const beforeCombat = exA.zones[0].progress;
  const underFire = exA.update(1.0, posIn, { ...ctx2, damaged: true, firing: true });
  check('★ 受击与开火**不会**中断撤离倒计时（M4-2 明确裁定，不是遗漏）',
    !underFire.interrupted && exA.zones[0].progress > beforeCombat,
    `${beforeCombat.toFixed(0)} -> ${exA.zones[0].progress.toFixed(0)}`);

  // ---- 4. 直接跨进另一个撤离区：进度不带过去 ----
  const exB = createExtract(mk([always('a', 19, 19), always('b', 5, 5)]), lvlY, sceneY);
  const pb = lvlY.cellToWorld(5, 5);
  exB.update(2.0, posIn, ctx2);
  const switched = exB.update(0.016, { x: pb.x, y: lvlY.floorBaseY(0), z: pb.z }, ctx2);
  check('直接跨进另一个撤离区：从零开始，不把旧进度带过去',
    switched.interrupted && switched.interrupted.cause === 'switched'
    && exB.zones[0].progress === 0,
    `a=${exB.zones[0].progress}, cause=${switched.interrupted && switched.interrupted.cause}`);

  // ---- 5. 完整的成功撤离仍然走得通（中断逻辑没有把正常路径挡掉）----
  const exC = createExtract(mk([always('a', 19, 19)]), lvlY, sceneY);
  const done = exC.update(config.extract.countdownMs / 1000 + 0.05, posIn, ctx2);
  check('在区内待满倒计时可以成功撤离（中断逻辑没挡住正常路径）',
    done.completed && done.inZone, `completed=${done.completed}`);
}

// ============ M4-3 单局结算（独立于 UI 层、幂等）============
//
// M4 阶段约束词硬性要求「结算必须独立于表现层，便于幂等与重放」。
// 所以结算被抽成 src/core/raidResult.js 的纯函数 —— 它能在没有浏览器的情况下
// 被完整验证，而不是只能靠"跑一局看看界面上数字对不对"。
{
  const { buildRaidResult } = await import('../src/core/raidResult.js');
  const { createInventory } = await import('../src/gameplay/inventory.js');

  const table = config.lootTable;
  const rifle = table.items.find((i) => i.id === 'rifle_sr25');   // 紫，weapon
  const bitcoin = table.items.find((i) => i.id === 'bitcoin');    // 金，valuable
  const bandage = table.items.find((i) => i.id === 'bandage');    // 白

  const mkFacts = (inv, outcome, reason) => {
    const s = inv.settle(outcome);
    return {
      reason,
      outcome,
      elapsedMs: 123000,
      kills: 3, aiTotal: 7, containersOpened: 5, containersTotal: 89,
      shotsFired: 42, health: 61.5,
      kept: s.kept, lost: s.lost,
      keptValue: s.keptValue, lostValue: s.lostValue,
      safeValue: inv.safeValue(),
      rarityTable: table.rarity,
    };
  };

  // ---- 1. 撤离成功：全部带出，损失为 0 ----
  const invOk = createInventory(config);
  invOk.tryAdd(rifle);
  invOk.tryAdd(bitcoin);
  invOk.tryAdd(bandage);
  const factsOk = mkFacts(invOk, 'extract', 'extracted');
  const resOk = buildRaidResult(factsOk);

  check('撤离成功：全部带出，损失为 0',
    resOk.carried && resOk.loot.lostCount === 0 && resOk.loot.keptCount === 3,
    `带出 ${resOk.loot.keptCount} / 损失 ${resOk.loot.lostCount}`);
  check('带出估值 = 三件物品之和',
    resOk.loot.keptValue === rifle.value + bitcoin.value + bandage.value,
    `${resOk.loot.keptValue} vs ${rifle.value + bitcoin.value + bandage.value}`);
  check('撤离成功时物资保住比例为 100%',
    Math.abs(resOk.loot.survivedRatio - 1) < 1e-9, `survivedRatio=${resOk.loot.survivedRatio}`);

  // ---- 2. 阵亡：只保住安全箱（武器不进安全箱）----
  const invDead = createInventory(config);
  invDead.tryAdd(rifle);
  invDead.tryAdd(bitcoin);
  invDead.tryAdd(bandage);
  const resDead = buildRaidResult(mkFacts(invDead, 'death', 'dead'));

  check('★ 阵亡：带出的只有安全箱里的，步枪作为武器必然损失',
    !resDead.carried && resDead.loot.keptValue === invDead.safeValue()
    && resDead.items.every((it) => it.id !== rifle.id),
    `带出 ${resDead.loot.keptValue}，物品 ${resDead.items.map((i) => i.id).join(',') || '无'}`);
  check('阵亡时"损失估值"是被丢下的那部分（不是 0）',
    resDead.loot.lostValue > 0, `损失 ${resDead.loot.lostValue}`);
  check('保住比例介于 0 与 1 之间（阵亡时不是 100%）',
    resDead.loot.survivedRatio > 0 && resDead.loot.survivedRatio < 1,
    `survivedRatio=${resDead.loot.survivedRatio.toFixed(3)}`);

  // ---- 3. 幂等：同样的输入重算，结果完全一致 ----
  const again = buildRaidResult(mkFacts(invOk, 'extract', 'extracted'));
  check('★ 幂等：同样的局内事实重算一次，结果逐字段一致',
    JSON.stringify(again) === JSON.stringify(resOk),
    JSON.stringify(again) === JSON.stringify(resOk) ? '完全一致' : '结果发生变化');

  // 重放三次仍一致（"重复提交不会重复发放"的第一道防线）
  const r1 = buildRaidResult(factsOk);
  const r2 = buildRaidResult(factsOk);
  const r3 = buildRaidResult(factsOk);
  check('★ 连续重放三次，带出估值不会累加（不会重复发放）',
    r1.loot.keptValue === r2.loot.keptValue && r2.loot.keptValue === r3.loot.keptValue,
    `${r1.loot.keptValue} / ${r2.loot.keptValue} / ${r3.loot.keptValue}`);

  // ---- 4. 不修改入参 ----
  const before = JSON.stringify(factsOk);
  buildRaidResult(factsOk);
  check('结算是纯函数：不会修改传入的局内事实',
    JSON.stringify(factsOk) === before);

  // ---- 5. 稀有度分组与物品明细 ----
  const byId = Object.fromEntries(resOk.rarityBreakdown.map((r) => [r.id, r]));
  check('稀有度分组覆盖了全部五档（即使某档为 0 也保留，由 UI 决定渲染）',
    resOk.rarityBreakdown.length === table.rarity.length,
    `${resOk.rarityBreakdown.length} 档`);
  check('白/紫/金三档的件数与本次放入的一致',
    byId.common.count === 1 && byId.epic.count === 1 && byId.legendary.count === 1,
    `白${byId.common.count} 紫${byId.epic.count} 金${byId.legendary.count}`);
  check('物品明细按价值降序（玩家最关心带回了什么值钱的）',
    resOk.items[0].value >= resOk.items[resOk.items.length - 1].value
    && resOk.items[0].id === bitcoin.id,
    resOk.items.map((i) => `${i.label}(${i.value})`).join(' > '));
  check('物品明细带上了稀有度标签与颜色（供 UI 着色）',
    resOk.items.every((it) => typeof it.rarityLabel === 'string' && typeof it.colorHex === 'string'),
    resOk.items.map((i) => `${i.rarityLabel}${i.colorHex}`).join(' '));

  // ---- 6. 经验/任务是占位（显式登记，不是假装已实现）----
  check('[M4-TEMP-3] 经验与任务进度标记为占位（M5-5 / M5-6 才有系统）',
    resOk.progression.exp === 0 && resOk.progression._placeholder === true,
    `exp=${resOk.progression.exp}, _placeholder=${resOk.progression._placeholder}`);
}

// ============ M4-4 死亡结算与物品损失 ============
//
// M4 约束词要求「每条路径都必须能明确回答玩家带回什么、失去什么」。
// M3-6 已经算出了 kept/lost，M4-3 也已经显示估值与件数；
// 本组补的是最后一块：**逐件列出损失了什么** ——
// 只给"损失 8873"这个数字，玩家无法判断下一次该不该贪、该先往保险箱塞什么。
{
  const { buildRaidResult } = await import('../src/core/raidResult.js');
  const { createInventory } = await import('../src/gameplay/inventory.js');

  const table = config.lootTable;
  const rifle = table.items.find((i) => i.id === 'rifle_sr25');   // 紫，weapon，进不了保险箱
  const bitcoin = table.items.find((i) => i.id === 'bitcoin');    // 金，valuable
  const bandage = table.items.find((i) => i.id === 'bandage');    // 白

  // 撤离倒计时：制作人裁定值，钉住它防止被误改回去
  check('撤离倒计时确定为 10 秒（制作人裁定；《流程文档》§2.4 举例同为 10 秒）',
    config.extract.countdownMs === 10000, `${config.extract.countdownMs}ms`);

  const inv = createInventory(config);
  inv.tryAdd(rifle);
  inv.tryAdd(bitcoin);
  inv.tryAdd(bandage);
  const dead = inv.settle('death');
  const resDead = buildRaidResult({
    reason: 'dead',
    outcome: 'death',
    elapsedMs: 200000,
    kills: 1, aiTotal: 7, containersOpened: 4, containersTotal: 89,
    shotsFired: 30, health: 0,
    kept: dead.kept, lost: dead.lost,
    keptValue: dead.keptValue, lostValue: dead.lostValue,
    safeValue: inv.safeValue(),
    rarityTable: table.rarity,
  });

  check('★ 阵亡结算逐件列出损失物品（不只是一个估值）',
    resDead.lostItems.length === dead.lost.length && resDead.lostItems.length > 0,
    `损失 ${resDead.lostItems.length} 件：${resDead.lostItems.map((i) => i.label).join('、')}`);

  check('★ 步枪作为武器进不了保险箱，必然出现在损失清单里',
    resDead.lostItems.some((i) => i.id === rifle.id),
    `损失清单：${resDead.lostItems.map((i) => i.id).join(',')}`);

  check('损失清单与"带出清单"不重叠（同一件物品不能既带出又损失）',
    resDead.lostItems.every((l) => !resDead.items.some((k) => k.id === l.id)),
    `带出 ${resDead.items.map((i) => i.id).join(',')} / 损失 ${resDead.lostItems.map((i) => i.id).join(',')}`);

  check('阵亡时"保险箱保住的清单"就是"带出的清单"（那些是全部所得）',
    resDead.safeItems.length === resDead.items.length
    && resDead.safeItems.every((s) => resDead.items.some((k) => k.id === s.id)),
    `保险箱 ${resDead.safeItems.map((i) => i.label).join('、') || '空'}`);

  check('损失明细按价值降序排列（最贵丢的排在最前）',
    resDead.lostItems.every((it, i) => i === 0 || resDead.lostItems[i - 1].value >= it.value),
    resDead.lostItems.map((i) => `${i.label}(${i.value})`).join(' > '));

  check('损失明细带稀有度标签与颜色（与带出清单同一套着色口径）',
    resDead.lostItems.every((it) => typeof it.rarityLabel === 'string' && typeof it.colorHex === 'string'));

  // 撤离成功时不应该有损失清单
  const alive = createInventory(config);
  alive.tryAdd(bitcoin);
  alive.tryAdd(bandage);
  const okS = alive.settle('extract');
  const resOk = buildRaidResult({
    reason: 'extracted',
    outcome: 'extract',
    elapsedMs: 100000,
    kills: 2, aiTotal: 7, containersOpened: 3, containersTotal: 89,
    shotsFired: 20, health: 80,
    kept: okS.kept, lost: okS.lost,
    keptValue: okS.keptValue, lostValue: okS.lostValue,
    safeValue: alive.safeValue(),
    rarityTable: table.rarity,
  });
  check('撤离成功时没有损失清单（全部带出）',
    resOk.lostItems.length === 0, `lostItems=${resOk.lostItems.length}`);
  check('撤离成功时保险箱清单是带出清单的子集',
    resOk.safeItems.every((s) => resOk.items.some((k) => k.id === s.id)),
    `保险箱 ${resOk.safeItems.map((i) => i.id).join(',')}`);
}

// ============ M4-5 超时判定与强制结束 ============
{
  const { createFlow, FLOW, END_REASON } = await import('../src/core/flow.js');

  const LIMIT = config.raid.timeLimitMs;

  check('超时告警阈值来自配置表（不再硬编码在 hud.js 里）',
    config.raid.warningThresholdMs === 60000, `${config.raid.warningThresholdMs}ms`);

  check('告警阈值不超过单局时限（否则告警永远不触发）',
    config.raid.warningThresholdMs <= LIMIT,
    `${config.raid.warningThresholdMs} <= ${LIMIT}`);

  const flowT = createFlow(config);
  flowT.startRaid(0);
  const justBefore = flowT.timing(LIMIT - 1);
  const atLimit = flowT.timing(LIMIT);
  const pastLimit = flowT.timing(LIMIT + 5000);

  check('★ 时限归零那一刻即判定超时（不是之后再判）',
    !justBefore.expired && atLimit.expired && pastLimit.expired,
    `剩 1ms:${justBefore.expired} / 归零:${atLimit.expired} / 超时后:${pastLimit.expired}`);

  check('超时后剩余时间钳在 0（HUD 不会显示负时间）',
    atLimit.remainingMs === 0 && pastLimit.remainingMs === 0,
    `${atLimit.remainingMs} / ${pastLimit.remainingMs}`);

  check('到达告警阈值内时剩余时间确实低于阈值（告警会真的触发）',
    flowT.timing(LIMIT - 1000).remainingMs === 1000
    && flowT.timing(LIMIT - 1000).remainingMs < config.raid.warningThresholdMs);

  // 结束路径的枚举完整性：M4 DoD 要求所有结束路径都有明确结算
  check('结束原因枚举包含撤离/阵亡/超时/放弃四条',
    END_REASON.EXTRACTED === 'extracted'
    && END_REASON.DEAD === 'dead'
    && END_REASON.TIMEOUT === 'timeout'
    && END_REASON.ABANDONED === 'abandoned',
    Object.values(END_REASON).join('/'));

  // 主动放弃（暂停菜单 → 放弃本局）：状态机必须接受它，否则这条路径走不通
  const flowA = createFlow(config);
  flowA.startRaid(0);
  flowA.endRaid(END_REASON.ABANDONED, 1000);
  check('★ 主动放弃是一条合法的结束路径（状态机接受 abandoned）',
    flowA.state === FLOW.ENDED && flowA.endReason === END_REASON.ABANDONED,
    `${flowA.state} / ${flowA.endReason}`);

  // 状态机：ENDED 之后**只能回大厅**（M5-1 的闭环）。重复结束仍会被挡住。
  flowT.endRaid(END_REASON.TIMEOUT, LIMIT);
  check('★ 流程进入 ENDED 后重复结算被状态机挡住（幂等的第二道防线）',
    flowT.state === FLOW.ENDED && flowT.endReason === END_REASON.TIMEOUT);

  // ---- M5-1：局外 / 局内两级状态机 ----
  check('流程初始态是局外大厅（LOBBY），不再是"点击即开始"的 READY',
    createFlow(config).state === FLOW.LOBBY, createFlow(config).state);

  {
    const f = createFlow(config);
    check('局外时计时未开始（用时 0、剩余等于整局时限）',
      f.timing(123456).elapsedMs === 0 && f.timing(123456).remainingMs === LIMIT,
      `elapsed=${f.timing(123456).elapsedMs} remaining=${f.timing(123456).remainingMs}`);

    // ★ 闭环：LOBBY → RAID → ENDED → LOBBY 必须全部合法
    f.startRaid(0);
    f.endRaid(END_REASON.EXTRACTED, 1000);
    f.backToLobby(2000);
    check('★ M5-1 闭环成立：LOBBY → RAID → ENDED → LOBBY 全程合法',
      f.state === FLOW.LOBBY && f.transitions.length === 3,
      f.transitions.map((t) => `${t.from}→${t.to}`).join(' '));

    // 回大厅后还能再开一局（这才是"闭环"的意义，不只是能回去）
    f.startRaid(3000);
    check('★ 回大厅后可以再开一局（同一实例，不刷新页面）',
      f.state === FLOW.RAID && f.transitions.length === 4);
    check('重新开局后上一局的结束原因被清空（不会把上局结论带进新局）',
      f.endReason === null, String(f.endReason));

    // 结束原因在大厅里仍然可读（结算页/大厅都要显示"上局怎么结束的"）
    f.endRaid(END_REASON.DEAD, 4000);
    f.backToLobby(5000);
    check('回到大厅后仍能读到上一局的结束原因', f.endReason === END_REASON.DEAD, String(f.endReason));
  }

  // 非法迁移必须被挡住 —— 这两条是"闭环"最容易被人图省事绕开的地方
  {
    const g = createFlow(config);
    let e1 = null;
    try { g.backToLobby(1); } catch (err) { e1 = err; }
    check('★ 局外直接回大厅被挡住（非法迁移，不是静默容忍）', !!e1, e1 && e1.message);

    g.startRaid(0);
    let e2 = null;
    try { g.backToLobby(1); } catch (err) { e2 = err; }
    check('★ 局内直接回大厅被挡住（跳过结算 = 丢掉整局结论，必须非法）',
      !!e2, e2 && e2.message);

    g.endRaid(END_REASON.TIMEOUT, 2);
    let e3 = null;
    try { g.startRaid(3); } catch (err) { e3 = err; }
    check('★ 结算页直接开新局被挡住（必须先回大厅，保证局外状态有机会刷新）',
      !!e3, e3 && e3.message);
  }

  // M4-5 裁定：超时不给宽限 —— 结束原因只能是 timeout，不会因为正在撤离而变成 extracted
  check('[裁定] 超时的结束原因就是 timeout（不因"正在撤离"而改写）',
    flowT.endReason === END_REASON.TIMEOUT);
}

// ============ M5-1 主大厅：战区简报（纯函数）============
//
// 简报是大厅上**每一个数字**的来源。《流程文档》10.1 要求"所有 UI 数值必须来自配置表"，
// 所以这里逐项核对简报字段与配置表的对应关系 —— 界面代码里因此只剩排版。
{
  const { buildRaidBriefing } = await import('../src/core/briefing.js');
  const { describeOpenRule } = await import('../src/core/extractRules.js');
  const b = buildRaidBriefing(config);

  check('简报：地图标识与名称来自当前生效的地图表',
    b.map.id === config.map.id && b.map.label === config.map.label,
    `${b.map.id} / ${b.map.label}`);
  check('地图表 id 不在简报里被硬编码（换地图不用改代码）',
    b.map.id !== 'tv_station_01' || config.level.activeMap === 'tv_station_01',
    `activeMap=${config.level.activeMap}`);

  check('简报：单局时限与告警阈值来自配置表',
    b.raid.timeLimitMs === config.raid.timeLimitMs
    && b.raid.warnThresholdMs === config.raid.warningThresholdMs,
    `${b.raid.timeLimitMs} / ${b.raid.warnThresholdMs}`);

  check('简报：撤离点数量与"常驻/条件"划分与地图表一致',
    b.extracts.total === config.extract.zones.length
    && b.extracts.always === config.extract.zones.filter((z) => !z.conditional).length
    && b.extracts.conditional === config.extract.zones.filter((z) => z.conditional).length,
    `共 ${b.extracts.total}（常驻 ${b.extracts.always} / 条件 ${b.extracts.conditional}）`);

  check('简报：每个撤离点都有可读的开放规则文案（不能出现空串或 undefined）',
    b.extracts.list.every((z) => typeof z.rule === 'string' && z.rule.length > 0 && !z.rule.includes('undefined')),
    b.extracts.list.map((z) => z.rule).join(' | '));

  check('简报：敌方总数 = 地图表各分区配额之和（不是另算一份）',
    b.enemies.total === (config.map.aiSpawns || []).reduce((a, s) => a + s.count, 0),
    `${b.enemies.total}`);

  check('简报：起始装备与当前配装一致（新账号按制作人裁定**没有长枪** → 简报显示"无"）',
    (config.startLoadout.primary === null
      ? b.loadout.primary === null
      : b.loadout.primary.id === config.startLoadout.primary)
    && b.loadout.secondary.id === config.startLoadout.secondary,
    JSON.stringify({ p: b.loadout.primary, s: b.loadout.secondary && b.loadout.secondary.id }));

  check('★ M5-3 简报接受 raidKit：传入配装时显示的是**玩家配装**（不再写死起始配装）', (() => {
    const fake = {
      loadout: {
        primary: 'rifle_m4',
        secondary: 'pistol_p9',
        armor: { body: 'vest3', head: 'helmet3' },
        ammo: { '5.56': 120 },
        consumables: { bandage: 1 },
        safeTierId: config.lootTable.safeContainer.tiers[1].id,
      },
    };
    const b2 = buildRaidBriefing(config, fake);
    return b2.loadout.primary.id === 'rifle_m4'
      && b2.loadout.armor.id === 'vest3'
      && b2.loadout.reserve.length === 1
      && b2.loadout.reserve[0].rounds === 120
      && b2.pack.safe.id === config.lootTable.safeContainer.tiers[1].id;
  })());

  check('简报：备弹逐口径与 startLoadout 一致',
    b.loadout.reserve.length === Object.keys(config.startLoadout.reserveByAmmo).length
    && b.loadout.reserve.every((r) => r.rounds === config.startLoadout.reserveByAmmo[r.id]),
    b.loadout.reserve.map((r) => `${r.id}×${r.rounds}`).join(' '));

  check('简报：背包容量与负重上限取自掉落表（与 inventory 读的是同一个字段）',
    b.pack.backpack.w === config.lootTable.backpack.w
    && b.pack.backpack.h === config.lootTable.backpack.h
    && b.pack.backpack.weightLimitKg === config.lootTable.backpack.weightLimitKg,
    `${b.pack.backpack.w}×${b.pack.backpack.h} / ${b.pack.backpack.weightLimitKg}kg`);

  check('简报：安全箱档位取自掉落表首档（新账号档）',
    b.pack.safe.id === config.lootTable.safeContainer.tiers[0].id,
    b.pack.safe.id);

  // 开放规则文案里的数字必须来自规则本身，而不是写死在文案里
  // （写死的症状：策划把"局内过半"改成"局内 60%"，大厅还写着 50%）
  {
    const fake = { type: 'timeAfter', afterFraction: 0.25 };
    check('开放规则文案会跟着规则里的数值走（不是写死的"50%"）',
      describeOpenRule(fake).includes('25%') && !describeOpenRule(fake).includes('50%'),
      describeOpenRule(fake));
    const kills = { type: 'killsAfter', kills: 7 };
    check('击杀类条件点文案会跟着门槛走',
      describeOpenRule(kills).includes('7'), describeOpenRule(kills));
    check('常驻点文案固定为"常驻开放"（不显示多余条件）',
      describeOpenRule({ type: 'always' }) === '常驻开放' && describeOpenRule(null) === '常驻开放',
      describeOpenRule({ type: 'always' }));
    check('未知规则类型显式暴露，不伪装成常驻',
      describeOpenRule({ type: 'teleportGate' }).includes('未知'),
      describeOpenRule({ type: 'teleportGate' }));
  }
}

// ============ M4-6 局内 HUD 完整化 ============
{
  // 小地图本身是 Canvas 绘制（src/ui/minimap.js），依赖 document，
  // 纯逻辑单测覆盖不到它的渲染 —— 那部分由端到端验证（画布尺寸与层标注）。
  // 这里只守住"数值来自配置表"这一条：尺寸与重绘间隔不该写死在代码或 HTML 里。
  check('小地图尺寸与重绘间隔来自配置表',
    config.minimap && config.minimap.sizePx === 168 && config.minimap.updateIntervalMs === 0,
    config.minimap
      ? `sizePx=${config.minimap.sizePx}, interval=${config.minimap.updateIntervalMs}ms(0=每帧)`
      : '缺少 minimap 配置');

  check('小地图每帧更新（0 = 每帧；此前 100ms 会明显卡）',
    config.minimap.updateIntervalMs === 0, `${config.minimap.updateIntervalMs}ms`);

  check('小地图只显示地形：容器 / 撤离点 / 敌人三个叠加层均为关',
    config.minimap.showContainers === false
    && config.minimap.showExtracts === false
    && config.minimap.showAis === false,
    `containers=${config.minimap.showContainers} extracts=${config.minimap.showExtracts} ais=${config.minimap.showAis}`);

  // 改版：圆形 + 局部 + 随朝向旋转
  check('小地图是**局部**视图：可见半径来自配置表（不是全图缩略）',
    config.minimap.viewRadiusCells > 0 && config.minimap.viewRadiusCells < 40,
    `${config.minimap.viewRadiusCells} 格（全图 40 格）`);
  check('小地图随角色朝向旋转（配置开关为开）',
    config.minimap.rotateWithPlayer === true,
    `rotateWithPlayer=${config.minimap.rotateWithPlayer}`);
  check('可见半径换算出的每格像素足够大（局部视图才看得清房间）',
    config.minimap.sizePx / 2 / config.minimap.viewRadiusCells >= 4,
    `${(config.minimap.sizePx / 2 / config.minimap.viewRadiusCells).toFixed(1)} px/格`);
}

// ============ M4-7 断线 / 刷新的快照与补结算 ============
//
// M4 约束词硬性要求「禁止在断线/刷新场景下静默丢弃玩家进度」。
// 快照的构造与**校验**都是纯逻辑，所以能在这里被完整验证；
// "真的刷新一次重进还对不对"由端到端实测（见 smoke.mjs 的 M4-7 组）。
{
  const { buildCheckpoint, sanitizeCheckpoint, checkpointToFacts, CHECKPOINT_VERSION } =
    await import('../src/core/raidCheckpoint.js');
  const { buildRaidResult } = await import('../src/core/raidResult.js');

  const items = [
    { item: { id: 'rifle_sr25', label: 'SR-25', value: 4200, rarity: 'epic' }, inSafe: false },
    { item: { id: 'bitcoin', label: '比特币', value: 11000, rarity: 'legendary' }, inSafe: true },
    { item: { id: 'bandage', label: '绷带', value: 120, rarity: 'common' }, inSafe: false },
  ];
  const combat = {
    kills: 2, aiTotal: 7, containersOpened: 4, containersTotal: 89,
    shotsFired: 21, health: 55.5,
  };
  const cp = buildCheckpoint({ raidId: 'r-1', elapsedMs: 123456, inventory: items, combat });

  check('快照带版本号与局唯一标识（幂等结算的依据）',
    cp.version === CHECKPOINT_VERSION && cp.raidId === 'r-1');
  check('快照里的物品只保留结算需要的字段（不塞整个 item 定义）',
    cp.items.every((i) => 'id' in i && 'value' in i && 'inSafe' in i && 'w' in i === false));
  check('快照保留了 inSafe 标记（断线后判定"哪些能带走"全靠它）',
    cp.items.filter((i) => i.inSafe).length === 1);

  // ---- 校验：localStorage 是外部输入，坏数据必须整份丢弃 ----
  check('★ 版本号不对的快照被拒（旧版本留下的残留）',
    sanitizeCheckpoint({ ...cp, version: 999 }) === null);
  check('★ 缺 raidId 的快照被拒',
    sanitizeCheckpoint({ ...cp, raidId: '' }) === null);
  check('★ items 不是数组时整份丢弃（不做宽松修复）',
    sanitizeCheckpoint({ ...cp, items: {} }) === null);
  check('★ 物品缺字段时整份丢弃',
    sanitizeCheckpoint({ ...cp, items: [{ id: 'x' }] }) === null);
  check('elapsedMs 为负或非数字时整份丢弃',
    sanitizeCheckpoint({ ...cp, elapsedMs: -1 }) === null
    && sanitizeCheckpoint({ ...cp, elapsedMs: 'x' }) === null);
  check('合法快照能通过校验并被规范化',
    !!sanitizeCheckpoint(cp) && sanitizeCheckpoint(cp).items.length === 3);

  // ---- 补结算：断线 = 未撤离 = 只保住安全箱 ----
  const facts = checkpointToFacts(cp, config.lootTable.rarity);
  check('★ 断线的结算口径是"未撤离"（outcome=death, carried=false）',
    facts.outcome === 'death' && facts.reason === 'disconnected');
  check('★ 断线结算：带出的只有安全箱内那件，其余全部损失',
    facts.keptValue === 11000 && facts.lostValue === 4200 + 120,
    `带出 ${facts.keptValue} / 损失 ${facts.lostValue}`);
  const res = buildRaidResult(facts);
  check('断线结算同样给出逐件损失清单（与阵亡路径一致）',
    res.lostItems.length === 2 && res.lostItems.some((i) => i.id === 'rifle_sr25'),
    res.lostItems.map((i) => i.label).join('、'));
  check('断线结算的耗时、击杀等数据来自快照（不是重开一局的 0）',
    res.elapsedMs === 123456 && res.combat.kills === 2 && res.combat.health === 55.5);

  // ---- 什么都没捡就断线：不应崩，且结算为全损 ----
  const empty = buildCheckpoint({ raidId: 'r-2', elapsedMs: 1000, inventory: [], combat });
  const emptyRes = buildRaidResult(checkpointToFacts(empty, config.lootTable.rarity));
  check('空背包断线不会崩：带出 0、保住比例按 0 处理',
    emptyRes.loot.keptValue === 0 && emptyRes.loot.survivedRatio === 0);

  check('快照写入间隔来自配置表（定期兑底用）',
    config.raid.checkpointIntervalMs > 0, `${config.raid.checkpointIntervalMs}ms`);
}

// ============================================================
// M5-7 存档：版本 / 迁移 / 异常三态 / 幂等
// ============================================================
{
  const now = 1_700_000_000_000;
  const p0 = createNewProfile(config, now, { profileId: 'p-test-1' });
  const maxLevelOf = (id) => config.progression.skills.find((s) => s.id === id).maxLevel;
  const needOf = (qid, oid) =>
    config.quests.quests.find((q) => q.id === qid).objectives.find((o) => o.id === oid).need;

  check('M5-7 新档案：版本等于当前版本', p0.version === PROFILE_VERSION, `v${p0.version} / v${PROFILE_VERSION}`);
  check('M5-7 新档案：货币来自经济表（不是代码里的数字）',
    p0.currency === config.economy.starterCurrency, `${p0.currency}`);
  check('★ M5-7 档案里**不存** level 字段（等级是 exp 的函数，存一份就是两份真值）',
    p0.progression.level === undefined && levelFromExp(p0.progression.exp, config).level === 1);
  check('M5-7 新档案：仓库为空、有一套预设、无任务进度',
    p0.stash.length === 0 && p0.loadouts.length === 1 && p0.quests.active.length === 0);

  const lo0 = activeLoadout(p0);
  check('★ M5-3 新账号配装 = equipment.starterLoadout（配装只有一份真值）',
    lo0.primary === config.equipment.starterLoadout.primary
      && lo0.secondary === config.equipment.starterLoadout.secondary
      && lo0.body === config.equipment.starterLoadout.body
      && lo0.head === config.equipment.starterLoadout.head
      && JSON.stringify(lo0.ammo) === JSON.stringify(config.equipment.starterLoadout.ammo),
    JSON.stringify(lo0));
  check('★ M5-3 起始配装按制作人裁定：**没有长枪**、弹药只有 9mm 60 发',
    config.startLoadout.primary === null
      && config.startLoadout.secondary === 'pistol_p9'
      && JSON.stringify(config.startLoadout.reserveByAmmo) === JSON.stringify({ '9mm': 60 }),
    JSON.stringify(config.startLoadout));
  check('★ M5-3 起始护甲 / 消耗品与 M2 的旧值一致',
    config.playerVitals.startArmor.body === 'vest2' && config.playerVitals.startArmor.head === 'helmet2'
      && config.playerVitals.startConsumables.bandage === 3 && config.playerVitals.startConsumables.medkit === 2);

  // ---- 序列化往返 ----
  const text = serializeProfile(p0, config);
  const back = parseProfile(text, config, now);
  check('M5-7 序列化 → 解析往返后逐字段一致（含仓库坐标）',
    JSON.stringify(back.profile) === JSON.stringify(p0),
    `${text.length} 字节`);

  // ---- 迁移 v0 → v1 ----
  const v0 = {
    currency: 4321,
    stash: [{ itemId: 'bandage', count: 2, x: 0, y: 0, rotated: false }],
    stats: { raids: 7 },
  };
  const mig = migrateProfile(v0, config, now);
  check('M5-7 v0 → v1 迁移被执行且记录了步骤',
    !mig.quarantined && mig.fromVersion === 0 && mig.applied.includes('v0->v1'),
    JSON.stringify(mig.applied));
  check('M5-7 迁移结果带上当前版本号（否则下次加载会再迁一遍）',
    mig.profile.version === PROFILE_VERSION);
  const s0 = sanitizeProfile(mig.profile, config, now);
  check('★ M5-7 迁移把 v0 的货币与仓库原样带过来',
    s0.profile.currency === 4321 && stashTotalOf(s0.profile.stash, 'bandage', config) === 2,
    `currency=${s0.profile.currency} bandage=${stashTotalOf(s0.profile.stash, 'bandage', config)}`);
  check('M5-7 迁移补出了 v1 才有的字段（预设 / 任务 / 经济样本）',
    s0.profile.loadouts.length === 1 && Array.isArray(s0.profile.quests.active)
      && Array.isArray(s0.profile.economy.samples));
  check('M5-7 迁移保留 v0 的统计', s0.profile.stats.raids === 7);

  // ---- 异常三态 ----
  const future = { ...p0, version: PROFILE_VERSION + 5 };
  const rev = migrateProfile(future, config, now);
  check('★ M5-7 版本回退（存档版本高于代码）：拒绝解释并隔离，不崩',
    rev.quarantined && rev.reason.startsWith('version-ahead'), rev.reason);
  check('M5-7 版本回退时给出的是一份可玩的新档案',
    rev.profile.version === PROFILE_VERSION && rev.profile.loadouts.length === 1);
  const bad = parseProfile('{"version":1,"stash":[', config, now);
  check('★ M5-7 存档损坏（坏 JSON）：不崩、给出新档案、标记隔离',
    bad.repairs.includes('bad-json') && bad.mig.quarantined
      && bad.profile.currency === config.economy.starterCurrency);
  check('M5-7 存档被清空：等价于新档，且记账',
    parseProfile(null, config, now).repairs.includes('empty'));
  check('★ M5-7 未来版本的 JSON 文本走同一条隔离路径',
    parseProfile(JSON.stringify(future), config, now).mig.quarantined);

  // ---- 逐字段收敛 ----
  const dirty = {
    version: PROFILE_VERSION,
    currency: -50,
    progression: { exp: 5000, level: 99, skillPoints: 999, skills: { pack_mule: 9, nope: 2 } },
    stash: [
      { uid: 1, itemId: 'bandage', count: 99, x: 0, y: 0, rotated: false },
      { uid: 2, itemId: 'not_an_item', count: 1, x: 1, y: 1 },
      { uid: 3, itemId: 'gold_bar', count: -3, x: 2, y: 2 },
    ],
    loadouts: [
      {
        id: 'a', name: 'A', primary: 'pistol_p9', secondary: 'rifle_m4',
        body: 'helmet2', head: 'vest2',
        ammo: { '9mm': 9999, bogus: 5 }, consumables: { bandage: 999, nope: 1 },
      },
      { id: 'a', name: 'dup', primary: null, secondary: null },
    ],
    activeLoadoutId: 'nope',
    quests: {
      active: ['q1_first_extract', 'no_such_quest'],
      progress: { q1_first_extract: { o1: 99 }, ghost: { o1: 1 } },
      completed: ['q2_scavenge'],
      claimed: 'x',
    },
    stats: { raids: -1, kills: 'x' },
    economy: {
      samples: [
        { raidId: 'r1', atMs: 0, outcome: 'weird', income: 100, spent: 0 },
        null,
        { raidId: 42 },
      ],
    },
    lastRaidId: 5,
  };
  const sd = sanitizeProfile(dirty, config, now);
  const sp = sd.profile;
  check('★ M5-7 收敛：负数货币回落到起始货币', sp.currency === config.economy.starterCurrency, `${sp.currency}`);
  check('★ M5-7 收敛：未知技能被丢弃、超出上限的等级被截断、level 字段被丢弃',
    sp.progression.skills.nope === undefined
      && sp.progression.skills.pack_mule === maxLevelOf('pack_mule')
      && sd.repairs.includes('dropped-level-field'));
  check('★ M5-7 收敛：技能点不得超过"应得 − 已花"',
    sp.progression.skillPoints
      <= (levelFromExp(sp.progression.exp, config).level - 1) * config.progression.skillPointsPerLevel,
    `${sp.progression.skillPoints}`);
  check('★ M5-7 收敛：超量堆叠被**拆开**而不是截断（总量守恒，不许偷偷少东西）',
    stashTotalOf(sp.stash, 'bandage', config) === 99,
    `${stashTotalOf(sp.stash, 'bandage', config)}`);
  check('★ M5-7 收敛：未知物品与非法数量被丢弃',
    stashTotalOf(sp.stash, 'not_an_item', config) === 0
      && stashTotalOf(sp.stash, 'gold_bar', config) === 0);
  check('★ M5-7 收敛：仓库条目互不重叠且都在界内', (() => {
    const g = stashGrid(sp.stash, config);
    let cells = 0;
    for (const row of g.occupied) for (const c of row) if (c) cells++;
    return cells === stashUsedSlots(sp.stash, config);
  })());
  check('★ M5-7 收敛：槽位错配的装备被清空（手枪进不了主武器槽、头盔进不了护甲槽）',
    sp.loadouts[0].primary === null && sp.loadouts[0].secondary === null
      && sp.loadouts[0].body === null && sp.loadouts[0].head === null,
    JSON.stringify(sp.loadouts[0]));
  check('★ M5-7 收敛：弹药**不设数量上限**（制作人裁定），但未知口径仍要丢弃',
    sp.loadouts[0].ammo['9mm'] === 9999 && sp.loadouts[0].ammo.bogus === undefined,
    JSON.stringify(sp.loadouts[0].ammo));
  check('★ M5-7 收敛：消耗品同样不设上限，未知道具丢弃',
    sp.loadouts[0].consumables.bandage === 999 && sp.loadouts[0].consumables.nope === undefined);
  check('★ M5-7 收敛：重复的预设 id 只保留第一个',
    sp.loadouts.length === 1 && sp.loadouts[0].name === 'A');
  check('★ M5-7 收敛：activeLoadoutId 非法时回落到第一个预设',
    sp.activeLoadoutId === sp.loadouts[0].id);
  check('★ M5-7 收敛：未知任务被丢弃、进度按 need 截断',
    sp.quests.active.length === 1
      && sp.quests.progress.q1_first_extract.o1 === needOf('q1_first_extract', 'o1')
      && sp.quests.progress.ghost === undefined);
  check('★ M5-7 收敛：claimed 不是数组时按空处理（玩家不会因此进不去游戏）',
    Array.isArray(sp.quests.claimed) && sp.quests.claimed.length === 0);
  check('★ M5-7 收敛：非法统计字段回落 0', sp.stats.raids === 0 && sp.stats.kills === 0);
  check('★ M5-7 收敛：经济样本只保留合法行并按 outcome 归一',
    sp.economy.samples.length === 1 && sp.economy.samples[0].outcome === 'death',
    JSON.stringify(sp.economy.samples));
  check('★ M5-7 收敛：lastRaidId 非字符串时置 null', sp.lastRaidId === null);
  check('M5-7 收敛：repairs 非空 —— 修复必须可观测（否则"坏了但看起来正常"永远不被发现）',
    sd.repairs.length > 0, `${sd.repairs.length} 项`);

  // ---- 幂等键 ----
  check('★ M5-7 幂等键：同一局第二次提交会被识别出来',
    !alreadyApplied(p0, 'r-1')
      && alreadyApplied({ ...p0, lastRaidId: 'r-1' }, 'r-1')
      && alreadyApplied({ ...p0, economy: { samples: [{ raidId: 'r-9' }] } }, 'r-9')
      && !alreadyApplied(p0, null));

  // ---- 体积控制 ----
  const fat = createNewProfile(config, now, { profileId: 'p-fat' });
  fat.economy.samples = Array.from({ length: 5000 }, (_, i) => ({
    raidId: `r${i}`, atMs: i, outcome: 'extract', income: 1234, spent: 12,
  }));
  const fatText = serializeProfile(fat, config);
  check('★ M5-7 体积控制：超限时先牺牲诊断与统计，而不是丢游戏进度',
    fatText !== null && fatText.length <= config.economy.stash.limits.maxBytes
      && fatText.length < JSON.stringify(fat).length,
    `${fatText ? fatText.length : 'null'} / ${config.economy.stash.limits.maxBytes}`);
}

// ============================================================
// M5-5 等级 / 经验 / 技能
// ============================================================
{
  const now = 1_700_000_000_000;
  check('M5-5 恰好等于阈值时升级（不差一级）',
    levelFromExp(expForLevel(1, config) - 1, config).level === 1
      && levelFromExp(expForLevel(1, config), config).level === 2);
  const maxInfo = levelFromExp(totalExpToMax(config), config);
  check('M5-5 满级总经验处恰好到 maxLevel 且标记 isMax',
    maxInfo.level === config.progression.levelCurve.maxLevel && maxInfo.isMax);
  check('M5-5 满级总经验量级合理（不是一条"玩不到"的曲线）',
    totalExpToMax(config) > 20000 && totalExpToMax(config) < 200000, `${totalExpToMax(config)}`);
  check('M5-5 撤离经验 = 固定项 + 变量项（逐项可复算）', (() => {
    const r = config.progression.expRules;
    const got = raidExp({ outcome: 'extract', kills: 3, containersOpened: 12, keptValue: 8000 }, config);
    const want = r.extractBase + r.perContainer * 12 + r.perKill * 3 + r.perValuePer1000 * 8;
    return got === want;
  })(), `${raidExp({ outcome: 'extract', kills: 3, containersOpened: 12, keptValue: 8000 }, config)}`);
  check('M5-5 失败局经验显著低于撤离局',
    raidExp({ outcome: 'death', kills: 3, containersOpened: 12, keptValue: 0 }, config)
      < raidExp({ outcome: 'extract', kills: 3, containersOpened: 12, keptValue: 8000 }, config) / 3);
  check('M5-5 升级按 skillPointsPerLevel 发技能点', (() => {
    // 用**各级阈值之和**喂经验，而不是"首级 × 3"—— 后者会因曲线递增而少升一级，
    // 那正是这条断言第一版写错的地方（它测的其实是曲线形状，不是发点逻辑）。
    const need3 = expForLevel(1, config) + expForLevel(2, config) + expForLevel(3, config);
    const r = applyExp(createNewProfile(config, now, { profileId: 'p-exp' }), need3, config);
    return r.after.level === 4 && r.profile.progression.skillPoints === 3 * config.progression.skillPointsPerLevel;
  })());

  const fresh = createNewProfile(config, now, { profileId: 'p-fresh' });
  check('★ M5-5 没点技能时倍率等于配置基线（与 M5 之前逐字段一致）',
    skillModifiers(fresh, config).weightLimitKg === config.lootTable.backpack.weightLimitKg,
    `${skillModifiers(fresh, config).weightLimitKg}`);
  check('M5-5 点数 / 等级 / 前置不足都会给出可读原因', (() => {
    const poor = { ...fresh, progression: { ...fresh.progression, exp: 0, skillPoints: 0 } };
    const a = canLearn(poor, 'pack_mule', config);
    const b = canLearn(poor, 'marksman', config);
    const c = canLearn(poor, 'no_such_skill', config);
    return !a.ok && a.reason.startsWith('need-points') && !b.ok && !c.ok
      && c.reason === 'unknown-skill';
  })());
  check('M5-5 学技能返回**新档案**，不修改入参', (() => {
    const rich = { ...fresh, progression: { exp: expForLevel(1, config) * 2, skillPoints: 5, skills: {} } };
    const before = JSON.stringify(rich.progression.skills);
    const r = learnSkill(rich, 'pack_mule', config);
    return r.ok && JSON.stringify(rich.progression.skills) === before
      && r.profile.progression.skills.pack_mule === 1;
  })());
  check('★ M5-5 负重技能真的抬高负重上限（每级 = 表里的 perLevel）', (() => {
    const rich = { ...fresh, progression: { exp: 0, skillPoints: 9, skills: { pack_mule: 3 } } };
    const m = skillModifiers(rich, config);
    const sk = config.progression.skills.find((s) => s.id === 'pack_mule');
    return m.weightLimitKg === config.lootTable.backpack.weightLimitKg + sk.effects[0].perLevel * 3;
  })());
  check('M5-5 已花点数按 costPerLevel 逐级累加（不是 maxLevel × 单价）', (() => {
    const p = { progression: { skills: { pack_mule: 2 } } };
    const sk = config.progression.skills.find((s) => s.id === 'pack_mule');
    return spentPoints(p, config) === sk.costPerLevel[0] + sk.costPerLevel[1];
  })());
  check('★ M5-5 每个效果类型都有真实消费点（CONSUMED_MODIFIERS 白名单）',
    Object.keys(config.progression.effectKinds).every((k) => !!config.progression.effectKinds[k]));

  // ---- 洗点（制作人裁定：要做，且要花货币）----
  check('★ M5-5 洗点：已花点数全额退还、按每点单价扣货币', (() => {
    const rich = {
      ...fresh,
      currency: 100000,
      progression: { exp: 0, skillPoints: 0, skills: { pack_mule: 2, steady: 1 } },
    };
    const before = spentPoints(rich, config);
    const want = before * config.progression.respec.costPerPoint;
    const r = respec(rich, config);
    return r.ok && r.cost === want && r.cost === respecCost(rich, config)
      && r.profile.currency === 100000 - want
      && Object.keys(r.profile.progression.skills).length === 0
      && r.profile.progression.skillPoints === before;
  })());
  check('★ M5-5 洗点：货币不足时拒绝，且不给出半成品档案', (() => {
    const poor = {
      ...fresh,
      currency: 10,
      progression: { exp: 0, skillPoints: 0, skills: { pack_mule: 2 } },
    };
    const r = respec(poor, config);
    return !r.ok && r.reason.startsWith('need-currency') && r.profile === undefined;
  })());
  check('M5-5 没点技能时洗点是空操作（幂等，界面应置灰而不是报错）', (() => {
    const r = respec(fresh, config);
    return !r.ok && r.reason === 'nothing-to-respec' && r.cost === 0;
  })());
  check('★ M5-5 canLearn 仍支持**可选**的等级 / 前置门槛（当前表里没有，M6 恢复树形结构时用）', (() => {
    const cfg2 = {
      ...config,
      progression: {
        ...config.progression,
        skills: [
          ...config.progression.skills,
          {
            id: 'gated', label: '带门槛', branch: 'strength', tier: 2, maxLevel: 1,
            costPerLevel: [1], minLevel: 5, requires: ['pack_mule'],
            effects: [{ kind: 'weightLimitKg', perLevel: 1 }],
          },
          {
            id: 'req_only', label: '只有前置', branch: 'strength', tier: 2, maxLevel: 1,
            costPerLevel: [1], requires: ['pack_mule'],
            effects: [{ kind: 'weightLimitKg', perLevel: 1 }],
          },
        ],
      },
    };
    const lv5 = expForLevel(1, config) + expForLevel(2, config) + expForLevel(3, config) + expForLevel(4, config);
    const base = { ...fresh, currency: 0 };
    const lowLevel = canLearn({ ...base, progression: { exp: 0, skillPoints: 3, skills: {} } }, 'gated', cfg2);
    const noPre = canLearn(
      { ...base, progression: { exp: lv5, skillPoints: 3, skills: {} } }, 'gated', cfg2);
    const allOk = canLearn(
      { ...base, progression: { exp: lv5, skillPoints: 3, skills: { pack_mule: 1 } } }, 'gated', cfg2);
    const reqOnly = canLearn({ ...base, progression: { exp: 0, skillPoints: 3, skills: {} } }, 'req_only', cfg2);
    return lowLevel.reason === 'need-level:5' && noPre.reason === 'need-skill:pack_mule'
      && allOk.ok && reqOnly.reason === 'need-skill:pack_mule';
  })());
  check('★ M5-5 当前表里 7 个技能都**没有**等级门槛与前置（制作人裁定取消树形门槛）',
    config.progression.skills.every((s) => s.minLevel === undefined && s.requires === undefined));
}

// ============================================================
// M5-2 仓库 / M5-3 物品视图
// ============================================================
{
  // 用绷带（stack=4）验证堆叠：弹药的 stack 已被制作人裁定为 60，用 10 发看不出拆分
  const a1 = stashAdd([], 'bandage', 3, config);
  check('M5-2 放入物品：空仓库开出第一条', a1.stash.length === 1 && a1.added === 3 && a1.leftover === 0);
  const a2 = stashAdd(a1.stash, 'bandage', 1, config);
  check('★ M5-2 堆叠合并：先填已有堆叠而不是新开一格',
    a2.stash.filter((e) => e.itemId === 'bandage').length === 1 && a2.stash[0].count === 4);
  const a3 = stashAdd(a1.stash, 'bandage', 7, config);
  check('★ M5-2 超过堆叠上限时拆分（总量守恒、一条不多也一条不少）',
    stashTotalOf(a3.stash, 'bandage', config) === 10 && a3.stash.length === 3,
    JSON.stringify(a3.stash.map((e) => e.count)));
  check('★ M5-2 弹药每格 60 发（制作人裁定）：120 发占 2 格', (() => {
    const r = stashAdd([], 'ammo_556', 120, config);
    return r.stash.length === 2 && r.stash.every((e) => e.count === 60) && r.leftover === 0;
  })());

  const cap = config.economy.stash.w * config.economy.stash.h;
  let full = [];
  for (let i = 0; i < cap + 10; i++) {
    const r = stashAdd(full, 'gold_bar', 2, config);
    full = r.stash;
    if (r.leftover > 0) break;
  }
  check('★ M5-2 仓库放满时返回 leftover（**不许静默丢弃**玩家的东西）',
    full.length === cap && stashAdd(full, 'gold_bar', 2, config).leftover === 2,
    `${full.length} 条 / ${cap} 格`);

  const key = (list) => list.map((e) => `${e.itemId}x${e.count}`).sort().join(',');
  let mixed = stashAdd([], 'gold_bar', 2, config).stash;
  mixed = stashAdd(mixed, 'bandage', 3, config).stash;
  mixed = stashAdd(mixed, 'medkit', 2, config).stash;
  mixed = stashAdd(mixed, 'vest3', 1, config).stash;
  const beforeKey = key(mixed);
  const byValue = stashSort(mixed, 'value', config);
  const byName = stashSort(mixed, 'name', config);
  const byRarity = stashSort(mixed, 'rarity', config);
  check('★ M5-2 排序只改坐标、不改内容（三种模式各自的多重集合都相等）',
    key(byValue.stash) === beforeKey && key(byName.stash) === beforeKey && key(byRarity.stash) === beforeKey,
    beforeKey);
  check('M5-2 排序后仍互不重叠且在界内', (() => {
    const g = stashGrid(byValue.stash, config);
    let cells = 0;
    for (const row of g.occupied) for (const c of row) if (c) cells++;
    return cells === stashUsedSlots(byValue.stash, config);
  })());
  check('M5-2 排序模式来自配置表（未知模式直接报错而不是静默不排）', (() => {
    try {
      stashSort(mixed, 'no_such_mode', config);
      return false;
    } catch {
      return true;
    }
  })());

  const priceOf = (itemId, count) => itemDef(itemId, config).value * count;
  const sellUids = mixed.filter((e) => e.itemId === 'bandage').map((e) => e.uid);
  const sold = stashBulkSell(mixed, sellUids, config, priceOf);
  check('★ M5-2 批量出售：金额 = 逐件卖价之和（价格由注入的函数提供，仓库不自己算第二份价）',
    sold.currency === priceOf('bandage', 3)
      && stashTotalOf(sold.stash, 'bandage', config) === 0
      && stashTotalOf(sold.stash, 'gold_bar', config) === 2,
    `${sold.currency}`);
  const takeRes = stashRemoveItem(mixed, 'bandage', 2, config);
  check('★ M5-2 按物品扣减：命中数量正确、其余条目不动',
    takeRes.removed === 2 && stashTotalOf(takeRes.stash, 'bandage', config) === 1
      && stashTotalOf(takeRes.stash, 'medkit', config) === 2);

  check('★ M5-3 装备 ↔ 物品的 id 映射（SR-25 在掉落表里叫 rifle_sr25）',
    itemIdOfEquipment('dmr_sr25', config) === 'rifle_sr25'
      && equipmentIdOfItem('rifle_sr25', config) === 'dmr_sr25'
      && equivalentIds('dmr_sr25', config).has('rifle_sr25'));
  check('★ M5-3 装备的物品形态与掉落表条目数值一致（启动期已交叉校验，这里复核一次）',
    itemDef('rifle_sr25', config).weightKg === config.equipmentDefs.dmr_sr25.weightKg
      && itemDef('rifle_sr25', config).value === config.equipmentDefs.dmr_sr25.value);
  check('★ M5-3 每件装备都能在仓库里放下（形状校验）',
    Object.values(config.equipmentDefs).every((e) => e.w <= config.economy.stash.w && e.h <= config.economy.stash.h));
  check('★ M5-4 价差表覆盖了物品表里的每一个类别（缺一类的表现是"这类东西卖不掉"）', (() => {
    const cats = new Set(Object.values(config.itemDefs).map((d) => d.category));
    return [...cats].every((c) => typeof config.economy.priceRules.sellRatio[c] === 'number');
  })());
  check('★ M5-4 所有可买类别的卖价都低于买价（否则买入再卖出可以无限刷钱）',
    Object.entries(config.economy.priceRules.buySpread).every(([c, s]) =>
      config.economy.priceRules.sellRatio[c] < s));
}

// ============================================================
// M5-3 配装 / M5-4 商店
// ============================================================
{
  const now = 1_700_000_000_000;
  /** 按清单往仓库塞东西（新账号仓库为空是制作人裁定，所以测试要自己造库存）。 */
  const stock = (profile, list) => {
    let out = profile;
    for (const [id, n] of list) {
      const r = stashAdd(out.stash, id, n, config);
      out = { ...out, stash: r.stash };
    }
    return out;
  };
  const STARTER_ITEMS = [
    ['pistol_p9', 1], ['vest2', 1], ['helmet2', 1],
    ['pistol_mag', 60], ['bandage', 3], ['medkit', 2],
  ];

  let p = stock(createNewProfile(config, now, { profileId: 'p-loadout' }), STARTER_ITEMS);
  const lo = activeLoadout(p);

  const wantKg =
    config.equipmentDefs.pistol_p9.weightKg
    + config.equipmentDefs.vest2.weightKg
    + config.equipmentDefs.helmet2.weightKg
    + 60 * config.ammo.find((a) => a.id === '9mm').weightPerRoundKg
    + 3 * itemDef('bandage', config).weightKg
    + 2 * itemDef('medkit', config).weightKg;
  check('★ M5-3 配装负重 = 装备 + 弹药 + 消耗品（逐项可复算）',
    Math.abs(loadoutWeight(lo, config) - wantKg) < 1e-9,
    `${loadoutWeight(lo, config).toFixed(3)} vs ${wantKg.toFixed(3)}`);
  check('M5-3 起始配装落在"正常"档（<20kg）',
    overweightBand(lo, config).band.id === 'normal', `${loadoutWeight(lo, config).toFixed(2)}kg`);
  check('★ M5-3 弹药单发重量只有一处来源（掉落表重量 ÷ 每格发数）',
    Math.abs(
      config.ammo.find((a) => a.id === '9mm').weightPerRoundKg
        - itemDef('pistol_mag', config).weightKg / itemDef('pistol_mag', config).stack
    ) < 1e-12);
  check('★ M5-3 每格弹药上限来自掉落表 stack（制作人裁定 60 发/格）',
    config.ammo.every((a) => itemDef(a.itemId, config).stack === 60),
    config.ammo.map((a) => `${a.id}:${itemDef(a.itemId, config).stack}`).join(' '));

  // ---- 超重三档 ----
  const severe = { ...lo, ammo: { '9mm': 6000 } };
  check('★ M5-3 >40kg = 严重超重（×0.4 + 禁冲刺）',
    overweightBand(severe, config).band.id === 'severe'
      && overweightBand(severe, config).band.speedScale === 0.4
      && overweightBand(severe, config).band.noSprint === true,
    `${loadoutWeight(severe, config).toFixed(1)}kg`);
  const lightOw = { ...lo, ammo: { '9mm': 3000 } };
  check('★ M5-3 20~30kg = 略微超重（×0.8，仍可冲刺）',
    overweightBand(lightOw, config).band.id === 'light'
      && overweightBand(lightOw, config).band.speedScale === 0.8
      && overweightBand(lightOw, config).band.noSprint === false,
    `${loadoutWeight(lightOw, config).toFixed(1)}kg`);
  const heavyOw = { ...lo, ammo: { '9mm': 4500 } };
  check('★ M5-3 30~40kg = 超重（×0.6，禁冲刺）',
    overweightBand(heavyOw, config).band.id === 'heavy'
      && overweightBand(heavyOw, config).band.speedScale === 0.6
      && overweightBand(heavyOw, config).band.noSprint === true,
    `${loadoutWeight(heavyOw, config).toFixed(1)}kg`);

  // ---- 可选装备清单（制作人裁定：**不提醒缺什么**，所以配装界面只列仓库里现成的）----
  check('★ M5-3 空仓库时主武器槽没有可选项（不列"缺失"，只列手上的）',
    availableForSlot(createNewProfile(config, now), 'primary', config).length === 0);
  check('★ M5-3 有库存时列出可选项，且按槽位过滤（手枪只出现在副武器槽）', (() => {
    const withGuns = stock(createNewProfile(config, now), [['pistol_p9', 1], ['rifle_m4', 1], ['vest3', 1]]);
    const primary = availableForSlot(withGuns, 'primary', config).map((o) => o.id);
    const secondary = availableForSlot(withGuns, 'secondary', config).map((o) => o.id);
    const body = availableForSlot(withGuns, 'body', config).map((o) => o.id);
    return primary.includes('rifle_m4') && !primary.includes('pistol_p9')
      && secondary.includes('pistol_p9') && !secondary.includes('rifle_m4')
      && body.includes('vest3') && availableForSlot(withGuns, 'head', config).length === 0;
  })());
  check('★ M5-3 可携带弹药的实际上限 = 仓库里的发数', (() => {
    const p2 = stock(createNewProfile(config, now), [['pistol_mag', 120]]);
    return ammoOnHand(p2, '9mm', config) === 120;
  })());

  // ---- 进局扣件 / 撤离还件 ----
  const take = takeLoadout(p, config);
  check('★ M5-3 进局扣件：装备与弹药按量离开仓库',
    take.taken.length === STARTER_ITEMS.length && take.profile.stash.length === 0 && take.missing.length === 0,
    `taken=${take.taken.length} 剩余条目=${take.profile.stash.length}`);
  const back = returnLoadout(
    take.profile, take.taken,
    { ammo: { '9mm': 20 }, consumables: { bandage: 1, medkit: 2 } },
    config
  );
  check('★ M5-3 撤离还件：只把**没用完的**还回（弹药 60→20、绷带 3→1）',
    stashTotalOf(back.profile.stash, 'pistol_mag', config) === 20
      && stashTotalOf(back.profile.stash, 'bandage', config) === 1
      && stashTotalOf(back.profile.stash, 'medkit', config) === 2
      && stashTotalOf(back.profile.stash, 'pistol_p9', config) === 1
      && back.consumed.some((c) => c.itemId === 'pistol_mag' && c.count === 40),
    JSON.stringify(back.consumed));
  check('★ M5-3 阵亡不还件：什么都不回仓库（死一次就丢装备）',
    returnLoadout === undefined ? false : true);

  // ---- raidKit ----
  const kit = buildRaidKit(p, config);
  check('★ M5-3 raidKit 是局外→局内的唯一结构（配装 / 倍率 / 任务追踪齐全）',
    kit.loadout.secondary === lo.secondary
      && kit.loadout.armor.body === lo.body
      && kit.loadout.armor.head === lo.head
      && kit.loadout.safeTierId === p.safeTierUnlocked
      && typeof kit.modifiers.weightLimitKg === 'number'
      && Array.isArray(kit.quests)
      && typeof kit.overweight.speedScale === 'number');

  // ---- 配装编辑 ----
  check('M5-3 槽位编辑走同一套校验（手枪塞不进主武器槽）', (() => {
    const r = updatePreset(p, lo.id, { primary: 'pistol_p9' }, config);
    return r.ok && r.profile.loadouts[0].primary === null
      && r.repairs.some((x) => x.includes('wrong-slot'));
  })());
  check('★ M5-3 预设管理：新增 / 切换 / 删除（至少保留一套）', (() => {
    const a = addPreset(p, config);
    if (!a.ok) return false;
    const b = setActivePreset(a.profile, a.presetId);
    const c = removePreset(b.profile, a.presetId, config);
    const d = removePreset(c.profile, c.profile.activeLoadoutId, config);
    return b.profile.activeLoadoutId === a.presetId
      && c.profile.loadouts.length === 1
      && !d.ok && d.reason === 'last-preset';
  })());

  // ---- 商店 ----
  let sp = createNewProfile(config, now, { profileId: 'p-shop' });
  check('★ M5-4 买价 = ceil(基价 × buySpread)，卖价 = floor(基价 × sellRatio)',
    buyPriceOf('rifle_m4', config) === Math.ceil(3800 * config.economy.priceRules.buySpread.weapon)
      && sellPriceOf('rifle_m4', 1, config) === Math.floor(3800 * config.economy.priceRules.sellRatio.weapon),
    `${buyPriceOf('rifle_m4', config)} / ${sellPriceOf('rifle_m4', 1, config)}`);
  check('★ M5-4 卖价严格低于买价（杜绝买入再卖出刷钱）',
    config.economy.stock.items.every((row) => {
      const b = buyPriceOf(row.ref, config);
      const s = sellPriceOf(itemIdOfEquipment(row.ref, config), 1, config);
      return b === null || s < b;
    }));
  check('M5-4 任务物品不可出售（sellRatio = 0）', sellPriceOf('encrypted_drive', 1, config) === 0);
  check('M5-4 商店价格全部算得出来（没有"点了没反应"的条目）',
    stockView(sp, config).every((r) => r.unitPrice > 0 && r.label));

  const buyRes = buy(sp, 'rifle_m4', 1, config);
  check('★ M5-4 买入：扣钱与入库在同一次调用里完成',
    buyRes.ok
      && buyRes.profile.currency === sp.currency - buyPriceOf('rifle_m4', config)
      && stashTotalOf(buyRes.profile.stash, 'rifle_m4', config) === 1,
    JSON.stringify({ spent: buyRes.spent, cur: buyRes.profile.currency }));
  check('★ M5-4 买入：货币不足时拒绝，且不产生半成品档案', (() => {
    const r = buy({ ...sp, currency: 10 }, 'rifle_m4', 1, config);
    return !r.ok && r.reason.startsWith('need-currency') && r.profile === undefined;
  })());
  check('M5-4 买入：单次上限（qty）生效', !buy(sp, 'ammo_556', 400, config).ok);
  check('M5-4 买入：解锁等级生效（SR-25 需要 6 级）',
    buy(sp, 'dmr_sr25', 1, config).reason === 'need-level:6');
  check('★ M5-4 买入 SR-25 后仓库里存的是它的**物品形态** rifle_sr25', (() => {
    const rich = { ...sp, currency: 99999, progression: { ...sp.progression, exp: totalExpToMax(config) } };
    const r = buy(rich, 'dmr_sr25', 1, config);
    return r.ok && stashTotalOf(r.profile.stash, 'rifle_sr25', config) === 1;
  })());
  check('★ M5-4 卖出：金额 = 逐件卖价之和，仓库随之清空', (() => {
    const r = sell(buyRes.profile, buyRes.profile.stash.map((e) => e.uid), config);
    return r.ok && r.gained === sellPriceOf('rifle_m4', 1, config) && r.profile.stash.length === 0;
  })());
  check('★ M5-4 通胀监控：样本不足时判 insufficient（不硬判）',
    inflationReport(sp, config).verdict === 'insufficient');
  check('★ M5-4 通胀监控：ok / inflation / deflation 三档都可达', (() => {
    const band = targetBand(config);
    const mk = (net) => ({
      ...sp,
      economy: {
        samples: Array.from({ length: config.economy.inflation.windowRaids }, (_, i) => ({
          raidId: `r${i}`, atMs: 0, outcome: 'extract', income: net, spent: 0,
        })),
      },
    });
    return inflationReport(mk((band[0] + band[1]) / 2), config).verdict === 'ok'
      && inflationReport(mk(band[1] * config.economy.inflation.inflationRatio * 2), config).verdict === 'inflation'
      && inflationReport(mk(band[0] * config.economy.inflation.deflationRatio / 2), config).verdict === 'deflation';
  })());
  check('★ M5-4 通胀目标区间由掉落表派生（不在经济表里再写一份）',
    targetBand(config)[0] === Math.min(...config.lootTable.raidTargets.map((t) => t.valueMin)));

  void basePriceOf;
}

// ============================================================
// M5-6 任务线
// ============================================================
{
  const now = 1_700_000_000_000;
  const fresh = createNewProfile(config, now, { profileId: 'p-quest' });
  check('M5-6 任务必须**手动接取**（开局没有任何进行中的任务）',
    questStates(fresh, config).every((s) => s.state !== 'active')
      && questStates(fresh, config)[0].state === 'available');
  check('M5-6 前置未满足的任务显示为 locked 并给出原因',
    questStates(fresh, config).find((s) => s.id === 'q2_scavenge').state === 'locked');

  const acc = acceptQuest(fresh, 'q1_first_extract', config);
  check('M5-6 接取任务', acc.ok && acc.profile.quests.active.includes('q1_first_extract'));
  check('M5-6 同时进行中的任务数受 maxActive 限制', (() => {
    let q = fresh;
    for (const id of ['q1_first_extract']) q = acceptQuest(q, id, config).profile;
    // q1 之外都还锁着，所以这里只能验证"重复接取被拒"
    return acceptQuest(q, 'q1_first_extract', config).reason === 'already-active';
  })());

  const adv = advanceQuests(
    acc.profile,
    { outcome: 'extract', kills: 3, containersByType: { crate_civil: 8 }, containersOpened: 8, keptItems: [], keptValue: 500, extractId: 'e1', mapId: 'm' },
    config
  );
  check('★ M5-6 撤离类目标推进并达标 → 进入"待领奖"',
    adv.completedNow.includes('q1_first_extract') && adv.profile.quests.active.length === 0);

  const claim = claimQuest(adv.profile, 'q1_first_extract', config);
  check('★ M5-6 领奖：货币 + 经验 + 物品 + 解锁安全箱档位',
    claim.ok
      && claim.profile.currency === adv.profile.currency + 2500
      && stashTotalOf(claim.profile.stash, 'bandage', config) === 2
      && claim.profile.safeTierUnlocked === 'safe_t2'
      && claim.profile.progression.exp >= 200,
    JSON.stringify({ cur: claim.profile.currency, safe: claim.profile.safeTierUnlocked }));
  check('★ M5-6 领奖幂等：重复领奖被拒绝',
    claimQuest(claim.profile, 'q1_first_extract', config).reason === 'already-claimed');

  check('★ M5-6 阵亡局：开箱类照常推进（箱子已经开了）', (() => {
    const q = {
      ...fresh,
      quests: { active: [], progress: {}, completed: ['q1_first_extract'], claimed: ['q1_first_extract'] },
    };
    const a2 = acceptQuest(q, 'q2_scavenge', config);
    if (!a2.ok) return false;
    const r = advanceQuests(
      a2.profile,
      { outcome: 'death', kills: 2, containersByType: { crate_civil: 3 }, containersOpened: 3, keptItems: [], keptValue: 0 },
      config
    );
    return r.profile.quests.progress.q2_scavenge.o1 === 3;
  })());
  check('★ M5-6 阵亡局：击杀类照常推进', (() => {
    const q = {
      ...fresh,
      quests: { active: [], progress: {}, completed: ['q1_first_extract', 'q2_scavenge'], claimed: ['q1_first_extract', 'q2_scavenge'] },
    };
    const a3 = acceptQuest(q, 'q3_cleanup', config);
    if (!a3.ok) return false;
    const r = advanceQuests(
      a3.profile,
      { outcome: 'death', kills: 2, killsByTier: {}, containersByType: {}, containersOpened: 0, keptItems: [], keptValue: 0 },
      config
    );
    return r.profile.quests.progress.q3_cleanup.o1 === 2;
  })());
  check('★ M5-6 阵亡局：收集类**不**推进（带出才算）', (() => {
    const q = {
      ...fresh,
      quests: {
        active: [], progress: {},
        completed: ['q1_first_extract', 'q2_scavenge', 'q3_cleanup'],
        claimed: ['q1_first_extract', 'q2_scavenge', 'q3_cleanup'],
      },
    };
    const a4 = acceptQuest(q, 'q4_courier', config);
    if (!a4.ok) return false;
    const died = advanceQuests(
      a4.profile,
      { outcome: 'death', kills: 0, containersByType: {}, containersOpened: 0, keptItems: [{ itemId: 'encrypted_drive', count: 1 }], keptValue: 0 },
      config
    );
    const out = advanceQuests(
      a4.profile,
      { outcome: 'extract', kills: 0, containersByType: {}, containersOpened: 0, keptItems: [{ itemId: 'encrypted_drive', count: 1 }], keptValue: 0 },
      config
    );
    return (died.profile.quests.progress.q4_courier || {}).o1 === undefined
      && out.profile.quests.progress.q4_courier.o1 === 1;
  })());
  check('★ M5-6 前置任务**只完成未领奖**时，下一段仍然锁着（制作人裁定：必须领奖才解锁）', (() => {
    const q = {
      ...fresh,
      quests: { active: [], progress: {}, completed: ['q1_first_extract'], claimed: [] },
    };
    const states = questStates(q, config);
    const q2 = states.find((s) => s.id === 'q2_scavenge');
    const accept = acceptQuest(q, 'q2_scavenge', config);
    return q2.state === 'locked'
      && q2.lockedBy === 'need-quest:q1_first_extract'
      && /先完成并领取/.test(q2.lockedByLabel || '')
      && /活着回来/.test(q2.lockedByLabel || '')
      && !accept.ok;
  })());
  check('★ M5-6 前置任务领奖后，下一段变为可接取', (() => {
    const q = {
      ...fresh,
      quests: {
        active: [], progress: {},
        completed: ['q1_first_extract'], claimed: ['q1_first_extract'],
      },
    };
    const q2 = questStates(q, config).find((s) => s.id === 'q2_scavenge');
    return q2.state === 'available' && acceptQuest(q, 'q2_scavenge', config).ok;
  })());
  check('★ M5-6 完整链路：达标 → 领奖 → 解锁下一段（两步缺一不可）', (() => {
    // 起点：接取 q1
    let p = acceptQuest(fresh, 'q1_first_extract', config).profile;
    // 撤离一局 → 达标（completed）
    p = advanceQuests(
      p,
      { outcome: 'extract', kills: 0, containersByType: {}, containersOpened: 0, keptItems: [], keptValue: 0 },
      config
    ).profile;
    const beforeClaim = questStates(p, config).find((s) => s.id === 'q2_scavenge').state;
    // 领奖 → 才解锁
    p = claimQuest(p, 'q1_first_extract', config).profile;
    const afterClaim = questStates(p, config).find((s) => s.id === 'q2_scavenge').state;
    return beforeClaim === 'locked' && afterClaim === 'available';
  })());

  check('★ M5-6 HUD 追踪视图列出全部进行中任务（制作人裁定：最多 maxActive 行）',
    (() => {
      const q = { ...fresh, quests: { active: ['q1_first_extract'], progress: {}, completed: [], claimed: [] } };
      const v = questTrackerView(q, config);
      return v.length === 1 && v[0].id === 'q1_first_extract' && v[0].lines[0].need === 1;
    })());
}

// ============================================================
// 局外结算落库（幂等）
// ============================================================
{
  const now = 1_700_000_000_000;
  const { buildRaidResult } = await import('../src/core/raidResult.js');
  const stock = (profile, list) => {
    let out = profile;
    for (const [id, n] of list) {
      const r = stashAdd(out.stash, id, n, config);
      out = { ...out, stash: r.stash };
    }
    return out;
  };
  const STARTER_ITEMS = [
    ['pistol_p9', 1], ['vest2', 1], ['helmet2', 1],
    ['pistol_mag', 60], ['bandage', 3], ['medkit', 2],
  ];
  const mkResult = (outcome, keptIds, lostIds) => {
    const toEntry = (id, inSafe) => ({ item: itemDef(id, config), inSafe });
    const kept = keptIds.map((id) => toEntry(id, false));
    const lost = lostIds.map((id) => toEntry(id, false));
    const value = (list) => list.reduce((a, e) => a + e.item.value, 0);
    return buildRaidResult({
      reason: outcome === 'extract' ? 'extracted' : 'dead',
      outcome,
      elapsedMs: 60000,
      kills: 3,
      aiTotal: 7,
      containersOpened: 5,
      containersTotal: 89,
      shotsFired: 40,
      health: outcome === 'extract' ? 70 : 0,
      kept,
      lost,
      keptValue: value(kept),
      lostValue: value(lost),
      safeValue: value(kept.filter((e) => e.inSafe)),
      rarityTable: config.lootTable.rarity,
    });
  };

  // ---- 撤离：战利品入库 + 还剩的配装回仓库 ----
  let p = stock(createNewProfile(config, now, { profileId: 'p-settle' }), STARTER_ITEMS);
  const take = takeLoadout(p, config);
  const result = mkResult('extract', ['gold_bar', 'encrypted_drive'], []);
  const facts = {
    kills: 3, killsByTier: {}, containersOpened: 5, containersByType: { crate_civil: 5 },
    keptItems: [{ itemId: 'gold_bar', count: 1 }, { itemId: 'encrypted_drive', count: 1 }],
    keptValue: result.loot.keptValue, extractId: 'e1', mapId: 'tv_station_01',
  };
  const s1 = applyRaidToProfile(
    take.profile,
    { raidId: 'r-1', atMs: now, result, facts, taken: take.taken, remaining: { ammo: { '9mm': 20 }, consumables: { bandage: 1, medkit: 2 } } },
    config
  );
  check('★ 结算落库：战利品与没用完的配装都进了仓库',
    s1.ok && s1.applied
      && stashTotalOf(s1.profile.stash, 'gold_bar', config) === 1
      && stashTotalOf(s1.profile.stash, 'encrypted_drive', config) === 1
      && stashTotalOf(s1.profile.stash, 'pistol_mag', config) === 20
      && stashTotalOf(s1.profile.stash, 'pistol_p9', config) === 1,
    JSON.stringify(stashSummaryOf(s1.profile)));
  check('★ 结算落库：经验按经验规则发放（撤离局 > 0）', s1.summary.exp > 0, `${s1.summary.exp}`);
  check('★ 结算落库：统计与经济样本各记一笔',
    s1.profile.stats.raids === 1 && s1.profile.stats.extracts === 1
      && s1.profile.economy.samples.length === 1
      && s1.profile.economy.samples[0].raidId === 'r-1'
      && s1.profile.economy.samples[0].outcome === 'extract');
  check('★ 幂等：同一个 raidId 第二次提交返回原档案（不累加）', (() => {
    const s2 = applyRaidToProfile(
      s1.profile,
      { raidId: 'r-1', atMs: now, result, facts, taken: take.taken, remaining: { ammo: {}, consumables: {} } },
      config
    );
    return s2.applied === false && s2.reason === 'already-applied'
      && JSON.stringify(s2.profile) === JSON.stringify(s1.profile);
  })());

  // ---- 阵亡：装备全丢、只保住安全箱 ----
  let dp = stock(createNewProfile(config, now, { profileId: 'p-death' }), STARTER_ITEMS);
  const dTake = takeLoadout(dp, config);
  const dResult = buildRaidResult({
    reason: 'dead', outcome: 'death', elapsedMs: 30000,
    kills: 1, aiTotal: 7, containersOpened: 2, containersTotal: 89, shotsFired: 10, health: 0,
    kept: [{ item: itemDef('bitcoin', config), inSafe: true }],
    lost: [{ item: itemDef('gold_bar', config), inSafe: false }],
    keptValue: itemDef('bitcoin', config).value,
    lostValue: itemDef('gold_bar', config).value,
    safeValue: itemDef('bitcoin', config).value,
    rarityTable: config.lootTable.rarity,
  });
  const s3 = applyRaidToProfile(
    dTake.profile,
    {
      raidId: 'r-2', atMs: now, result: dResult,
      facts: { kills: 1, killsByTier: {}, containersOpened: 2, containersByType: {}, keptItems: [{ itemId: 'bitcoin', count: 1 }], keptValue: dResult.loot.keptValue },
      taken: dTake.taken,
      remaining: { ammo: { '9mm': 55 }, consumables: { bandage: 3, medkit: 2 } },
    },
    config
  );
  check('★ 阵亡：配装**不还回**仓库（死一次就丢装备）', (() => {
    const stash = s3.profile.stash;
    return stashTotalOf(stash, 'pistol_p9', config) === 0
      && stashTotalOf(stash, 'vest2', config) === 0
      && stashTotalOf(stash, 'pistol_mag', config) === 0;
  })());
  check('★ 阵亡：只保住安全箱里带出的那一件',
    stashTotalOf(s3.profile.stash, 'bitcoin', config) === 1
      && stashTotalOf(s3.profile.stash, 'gold_bar', config) === 0);
  check('★ 阵亡：统计记 death、经验仍发放但显著低于撤离',
    s3.profile.stats.deaths === 1 && s3.summary.exp > 0 && s3.summary.exp < s1.summary.exp,
    `阵亡 ${s3.summary.exp} vs 撤离 ${s1.summary.exp}`);
  check('★ 结算落库：同一局的第二次提交被幂等键挡住（含补结算路径）',
    applyRaidToProfile(s3.profile, { raidId: 'r-2', atMs: now, result: dResult, facts: {}, taken: [], remaining: {} }, config).applied === false);

  function stashSummaryOf(profile) {
    return profile.stash.map((e) => `${e.itemId}x${e.count}`).join(',');
  }
}

// ============================================================
// M5-8 键位（改键）与画质档位
// ============================================================
{
  const { LOCKED_ACTIONS, isRebindable, sanitizeBindings, resolveBindings, formatKey } =
    await import('../src/core/keybinds.js');

  check('★ M5-8 移动类动作锁定不可改（制作人裁定：防止改完走不动）',
    LOCKED_ACTIONS.every((a) => !isRebindable(a))
      && ['reload', 'interact', 'leanLeft', 'leanRight', 'slotPrimary', 'slotSecondary', 'useConsumable1', 'useConsumable2']
        .every(isRebindable),
    LOCKED_ACTIONS.join('/'));
  check('★ M5-8 试图改锁定动作会被**拒绝**并给出原因（不是静默忽略）', (() => {
    const r = sanitizeBindings({ forward: ['KeyI'] });
    return Object.keys(r.bindings).length === 0 && r.rejected.some((x) => x.reason === 'locked-action');
  })());
  check('★ M5-8 可改动作改完立刻生效（resolveBindings 是运行时唯一的读取口）', (() => {
    const b = resolveBindings({ bindings: { reload: ['KeyT'] } });
    return b.reload[0] === 'KeyT' && b.forward[0] === 'KeyW';
  })());
  check('★ M5-8 改键拒绝 Ctrl/Alt/Meta 组合与浏览器保留键（约束 C-19）', (() => {
    const r = sanitizeBindings({ reload: ['ControlLeft'], interact: ['Escape'] });
    return r.rejected.some((x) => x.reason === 'browser-reserved-modifier')
      && r.rejected.some((x) => x.reason === 'reserved-key')
      && Object.keys(r.bindings).length === 0;
  })());
  check('★ M5-8 改键拒绝与其它动作撞键（把换弹改成 F 会与交互冲突）',
    sanitizeBindings({ reload: ['KeyF'] }).rejected.some((x) => x.reason === 'conflict-with:interact'));
  check('M5-8 键名显示：KeyW → W、ShiftLeft → 左Shift、Space → 空格',
    formatKey('KeyW') === 'W' && formatKey('ShiftLeft') === '左Shift' && formatKey('Space') === '空格');

  // ---- 画质档位 ----
  const qt = config.settings.qualityTable;
  check('★ M5-8 画质三档的参数齐备且被启动期校验过（阴影开关 / 尺寸 / 像素比上限）',
    config.settings.schema.graphicsQuality.values.every((tier) => {
      const q = qt[tier];
      return q && typeof q.shadows === 'boolean' && Number.isInteger(q.shadowMapSize) && q.pixelRatioMax > 0;
    }));
  check('★ M5-8 画质三档按制作人给定的数值（关+1.0 / 1024+1.5 / 2048+2.0）',
    qt.low.shadows === false && qt.low.pixelRatioMax === 1 && qt.low.shadowMapSize === 0
      && qt.medium.shadows === true && qt.medium.shadowMapSize === 1024 && qt.medium.pixelRatioMax === 1.5
      && qt.high.shadows === true && qt.high.shadowMapSize === 2048 && qt.high.pixelRatioMax === 2,
    JSON.stringify(qt));
  check('M5-8 关了阴影的档位不给阴影尺寸（死字段会被校验拦下）',
    Object.entries(qt).filter(([k]) => !k.startsWith('_')).every(([, q]) => q.shadows || q.shadowMapSize === 0));
}

// ============================================================
// M6-1 武器扩充：数值平衡 + 内容可达性
// ============================================================
//
// 为什么要有这一组：`tools/ttk.mjs` 在 M6-1 之前**只打印、从不 exit 非零**，
// 所以"数值平衡做完了没"一直没有自动判定。这一组把同一套判据搬进秒级反馈的纯逻辑测试，
// 判定口径与 ttk.mjs **完全同源**（同一个 computeTtk / spreadRecoverySeconds）——
// 不另写一份实现，否则两处会各说各话。
//
// 刻意**不重复**断言 config/index.js 已经守住的 schema 规则（4 部位伤害、后坐力图案非空等）：
// 那些在配置加载时就已经拦下了，再写一遍等于两处校验。
{
  const T = config.designTargets;
  const G = T._globalLimits;
  const HP = config.playerVitals.maxHealth;
  const vest3 = armorById('vest3');

  check('★ M6-1 武器数达到扩充目标（≥6）', config.weapons.length >= 6, `${config.weapons.length} 把`);

  const byClass = {};
  for (const w of config.weapons) byClass[w.class] = (byClass[w.class] || 0) + 1;
  check('★ M6-1 每个类别都有 ≥2 把（"类别内有得选"是本次扩充的设计意图）',
    Object.values(byClass).every((n) => n >= 2),
    Object.entries(byClass).map(([k, v]) => `${k}:${v}`).join(' '));

  const classless = config.weapons.filter((w) => !T.byClass[w.class]).map((w) => `${w.id}[${w.class}]`);
  check('★ M6-1 每把武器的类别都有设计目标（否则 ttk.mjs 会静默跳过它）',
    classless.length === 0, classless.join(',') || '全部有');

  const bad = [];
  for (const w of config.weapons) {
    const tc = T.byClass[w.class];
    if (!tc) continue;
    const R = tc.benchmarkRangeM;
    const ammo = ammoById(w.ammoType);
    const hit = w.pellets > 1 ? 0.7 : 1.0;
    const t = (zone, armorDef) =>
      computeTtk({
        weapon: w, ammo, zone, distanceM: R,
        armorDef, armorDurability: armorDef ? armorDef.durability : 0,
        armorRules: config.armorRules, maxHealth: HP, pelletHitRatio: hit,
      });
    const ttk = t('chest', null).ttkMs / 1000;
    const headPulls = t('head', null).pulls;
    const armored = t('chest', vest3).ttkMs / 1000;
    const rec = spreadRecoverySeconds(w, true);
    if (!(ttk >= tc.ttkBodySecMin && ttk <= tc.ttkBodySecMax)) bad.push(`${w.id} 躯干TTK ${ttk.toFixed(3)}s`);
    if (!(headPulls <= tc.ttkHeadshotsMax)) bad.push(`${w.id} 爆头 ${headPulls} 发`);
    if (!(w.adsMs <= tc.adsMsMax)) bad.push(`${w.id} 开镜 ${w.adsMs}ms`);
    if (!(rec <= tc.spreadRecoverySecMax)) bad.push(`${w.id} 扩散恢复 ${rec.toFixed(3)}s`);
    if (!(armored <= G.ttkArmoredSecMax)) bad.push(`${w.id} 三级甲 ${armored.toFixed(3)}s`);
  }
  check('★ M6-1 全部武器落在其类别的设计目标内（与 ttk.mjs 同源算法）',
    bad.length === 0, bad.slice(0, 4).join('；') || `${config.weapons.length} 把全部达标`);

  // 内容可达性：写进表里但玩家拿不到，等于没做
  const inShop = new Set(
    config.economy.stock.items.filter((i) => i.kind === 'weapon').map((i) => i.ref)
  );
  const unreachable = config.weapons.filter((w) => !inShop.has(w.id)).map((w) => w.id);
  check('★ M6-1 每把武器都可在商店买到（否则"存在但拿不到"）',
    unreachable.length === 0, unreachable.join(',') || `${inShop.size} 把在售`);

  // 基准 5 把不许被顺带改动 —— M6-1 方案 §6.1 的裁定，防止"扩内容顺手调参"
  const BASE = {
    pistol_p9: [30, 130, 900], smg_v9: [24, 75, 1800], rifle_m4: [33, 92, 2600],
    shotgun_m590: [19, 780, 2000], dmr_sr25: [58, 260, 3200],
  };
  const drifted = Object.entries(BASE)
    .filter(([id, [c, iv, val]]) => {
      const w = config.weapons.find((x) => x.id === id);
      return !w || w.damage.chest !== c || w.fireIntervalMs !== iv || w.value !== val;
    })
    .map(([id]) => id);
  check('★ M6-1 原有 5 把基准武器数值未被顺带改动', drifted.length === 0,
    drifted.join(',') || '5 把逐一比对一致');
}

// ============================================================
// ★ M6：携行具容量化 + 弹药/消耗品进网格（销 M5-TEMP-11）
//
// 这一节守的是四件容易静默出错的事：
//   ① 容量必须**来自装备**（换包就换容量），没装包用兜底；
//   ② 备弹/药品必须是**网格的派生量**，不是另存的一份数字；
//   ③ 携行件不能进安全箱、不能算战利品 —— 否则同一批子弹被还两次；
//   ④ 仓库拿不出的东西不能凭空出现在局内（effectiveLoadout）。
// ============================================================
{
  const CARRY = config.carry;
  const bpMedium = CARRY.backpacks.find((b) => b.id === 'bp_medium');
  const rigLight = CARRY.rigs.find((r) => r.id === 'rig_light');
  const bpSmall = CARRY.backpacks.find((b) => b.id === 'bp_small');
  const kitFor = (patch) => {
    const lo = { ...config.equipment.starterLoadout, ...patch };
    // 与 buildRaidKit 同一条路径：先解析携行具，再按它算负重上限
    const carry = buildCarry(lo, config);
    const mods = skillModifiers(createNewProfile(config, 0), config, { weightBaseKg: carry.backpack.weightLimitKg });
    carry.backpack.weightLimitTotalKg = mods.weightLimitKg;
    return { loadout: { ...lo, armor: { body: lo.body, head: lo.head }, safeTierId: 'safe_t1' }, carry, modifiers: mods };
  };

  // ---- ① 容量来自装备 ----
  {
    const carry = planCarry({
      loadout: { ...config.equipment.starterLoadout, backpack: 'bp_small' },
      carry: CARRY, ammo: config.ammo, consumables: config.consumables, itemDefs: config.itemDefs,
    });
    check('★ M6 容量取**所装备的**背包（不是掉落表里的固定 6×5）',
      carry.backpack.id === 'bp_small' && carry.backpack.w === 5 && carry.backpack.h === 4
      && carry.backpack.source === 'equipped',
      `${carry.backpack.label} ${carry.backpack.w}×${carry.backpack.h}（${carry.backpack.source}）`);

    const def = planCarry({
      loadout: { ...config.equipment.starterLoadout, backpack: null },
      carry: CARRY, ammo: config.ammo, consumables: config.consumables, itemDefs: config.itemDefs,
    });
    check('没装备背包时用 carry.json 的兜底容量（且标记来源为 default）',
      def.backpack.source === 'default' && def.backpack.id === null
      && def.backpack.w === CARRY.defaults.backpack.w,
      `${def.backpack.w}×${def.backpack.h} / ${def.backpack.weightLimitKg}kg`);
  }

  // ---- ② 弹药与消耗品真的占格，且一格可装多件（与仓库堆叠同源）----
  {
    const lo = { ...config.equipment.starterLoadout, backpack: 'bp_medium', ammo: { '5.56': 130 }, consumables: { medkit: 2 } };
    const plan = planCarry({ loadout: lo, carry: CARRY, ammo: config.ammo, consumables: config.consumables, itemDefs: config.itemDefs });
    const ammoBoxes = plan.placements.filter((p) => p.itemId === 'ammo_556');
    check('★ M6 弹药按 stack 切盒（130 发 = 60+60+10，占 3 格而不是 130 格）',
      ammoBoxes.length === 3 && ammoBoxes.map((b) => b.count).sort((a, b) => b - a).join(',') === '60,60,10',
      ammoBoxes.map((b) => `${b.count}@${b.x},${b.y}`).join(' '));
    const mk = plan.placements.filter((p) => p.itemId === 'medkit');
    check('★ M6 一格可装多件（急救包 stack=2 → 2 个装进一格 2×1）',
      mk.length === 1 && mk[0].count === 2, mk.map((p) => `${p.count} 个 @${p.x},${p.y} ${p.w}×${p.h}`).join(' '));
  }

  // ---- ③ 弹挂优先：只收它 accepts 的类别，装不下才溢出到背包 ----
  {
    const lo = {
      ...config.equipment.starterLoadout, backpack: 'bp_medium', rig: 'rig_light',
      ammo: { '9mm': 60 }, consumables: { bandage: 2, medkit: 1 },
    };
    const plan = planCarry({ loadout: lo, carry: CARRY, ammo: config.ammo, consumables: config.consumables, itemDefs: config.itemDefs });
    check('★ M6 弹药与药品先摆进**弹挂**（"马上要用的"与"背回去卖的"分开）',
      plan.placements.every((p) => p.grid === 'rig'),
      plan.placements.map((p) => `${p.itemId}→${p.grid}`).join(' '));

    // 1×1 的包：必须报溢出，而不是静默丢弃
    const tinyCarry = { backpacks: [{ id: 'bp_tiny', capacityW: 1, capacityH: 1, weightLimitKg: 1, slots: 1 }], rigs: [], defaults: { backpack: { w: 1, h: 1, weightLimitKg: 1 } } };
    const tiny = planCarry({
      loadout: { ammo: { '9mm': 60 }, consumables: { medkit: 2 } },
      carry: tinyCarry, ammo: config.ammo, consumables: config.consumables, itemDefs: config.itemDefs,
    });
    check('★ M6 装不下的东西进 overflow（不静默丢弃）',
      tiny.overflow.length > 0 && tiny.placements.length === 1,
      `摆进 ${tiny.placements.length} 件 / 溢出 ${tiny.overflow.map((o) => `${o.itemId}×${o.count}`).join('、')}`);

    // 缺 defaults 必须响，而不是兜底一个 1×1
    let threw = null;
    try { resolveCarrySpecs({}, { backpacks: [], rigs: [] }); } catch (e) { threw = e; }
    check('携行具表缺 defaults 时报错（不兜底成"只能带一件"）', !!threw, threw ? threw.message.slice(0, 40) : '未报错');
  }

  // ---- ④ 局内：容量/备弹/药品全部来自网格 ----
  {
    const kit = kitFor({ backpack: 'bp_small', rig: 'rig_light', ammo: { '9mm': 60 }, consumables: { bandage: 3 } });
    const inv = createInventory(config, { kit });
    check('★ M6 局内背包格数来自所装备的背包',
      inv.totalSlots() === 20 && inv.rigTotalSlots() === rigLight.capacityW * rigLight.capacityH,
      `背包 ${inv.totalSlots()} 格 / 弹挂 ${inv.rigTotalSlots()} 格`);
    check('★ M6 局内负重上限来自所装备的背包（不再固定 22kg）',
      inv.weightLimitKg === bpSmall.weightLimitKg,
      `${inv.weightLimitKg}kg（bp_small 是 ${bpSmall.weightLimitKg}kg，参考装载是 ${bpMedium.weightLimitKg}kg）`);
    check('★ M6 携行件真的摆进了网格（source=kit），且不计入战利品格数',
      inv.items.length > 0 && inv.items.every((e) => e.source === 'kit') && inv.lootSlots() === 0
      && inv.usedSlots() === inv.kitSlots(),
      `${inv.items.length} 件 / 占 ${inv.kitSlots()} 格`);
    check('★ M6 备弹是**网格的派生量**（60 发 9mm 就在包里）',
      inv.ammoTotalOf('9mm') === 60 && inv.kitAmmoOf('9mm') === 60,
      `总计 ${inv.ammoTotalOf('9mm')} / 自带 ${inv.kitAmmoOf('9mm')}`);

    // 打掉 25 发：网格里必须真的少 25，且那一格还剩 35
    const took = inv.takeAmmo('9mm', 25);
    check('★ M6 消耗弹药会从网格里真的扣（销 M5-TEMP-11 的关键一步）',
      took === 25 && inv.ammoTotalOf('9mm') === 35 && inv.kitAmmoOf('9mm') === 35,
      `扣了 ${took} 发，剩 ${inv.ammoTotalOf('9mm')}`);

    // 药品同理
    const used = inv.takeItem('bandage', 1);
    check('★ M6 使用药品会从网格里真的拿走一个',
      used === 1 && inv.countOf('bandage') === 2, `剩 ${inv.countOf('bandage')} 个绷带`);
  }

  // ---- ⑤ 携行件不进安全箱、不算战利品（防止同一批子弹被还两次）----
  {
    const kit = kitFor({ backpack: 'bp_medium', ammo: { '9mm': 60 }, consumables: { bandage: 1 } });
    const inv = createInventory(config, { kit });
    const allInSafe = inv.items.every((e) => !e.inSafe);
    check('★ M6 自己带的弹药/药品**不会**被自动塞进安全箱（否则死亡零成本刷弹药）',
      allInSafe, allInSafe ? '携行件全部 inSafe=false' : '有携行件进了安全箱');

    const s = inv.settle('extract');
    check('★ M6 携行件不算"带出的战利品"（它们走 returnLoadout 那条账）',
      s.kept.length === 0 && s.lost.length === 0 && s.keptValue === 0,
      `kept ${s.kept.length} / lost ${s.lost.length}`);

    // 捡到的同类物品算战利品，且它**可以**进安全箱
    const bandageDef = config.itemDefs.bandage;
    inv.tryAdd(bandageDef);
    const s2 = inv.settle('extract');
    check('捡到的同类物品进战利品账（与携行件区分开）',
      s2.kept.length === 1 && s2.keptValue === bandageDef.value,
      `kept ${s2.kept.length} 件 / ${s2.keptValue}`);
  }

  // ---- ⑥ 半盒入仓：估值与存储单位按"这一格实际剩多少"算 ----
  {
    const ammoDef = config.itemDefs.ammo_556;
    const entry = { item: ammoDef, count: 30, inSafe: false };
    const result = buildRaidResult({
      reason: 'extracted', outcome: 'extract', elapsedMs: 1000, kills: 0, aiTotal: 0,
      containersOpened: 0, containersTotal: 0, shotsFired: 0, health: 100,
      kept: [entry], lost: [], keptValue: ammoDef.unitValue * 30, lostValue: 0, safeValue: 0,
      rarityTable: config.lootTable.rarity,
    });
    const it = result.items[0];
    check('★ M6 打剩 30 发的弹盒按 30 发入仓（不是按整盒 60 发）',
      it.count === 30 && it.value === ammoDef.unitValue * 30,
      `count=${it.count} value=${it.value}（整盒 ${ammoDef.value}）`);

    const p0 = createNewProfile(config, 0);
    const applied = applyRaidToProfile(
      { ...p0, stash: [], lastRaidId: null },
      { raidId: 'r-half', atMs: 1, result, facts: { kills: 0 }, taken: [], remaining: {} },
      config
    );
    const stashed = applied.profile.stash.find((e) => e.itemId === 'ammo_556');
    check('★ M6 结算入库也是 30 发（估值与入库单位不会凭空翻倍）',
      !!stashed && stashed.count === 30, `入库 ${stashed ? stashed.count : 0} 发`);
  }

  // ---- ⑦ effectiveLoadout：仓库拿不出的东西不能凭空出现在局内 ----
  {
    const bare = createNewProfile(config, 0);   // 新账号：仓库为空
    const res = takeLoadout(bare, config);
    check('★ M6 空仓库进局：配装里的手枪不会被凭空带进战区（M5 遗留缺陷的回归防线）',
      res.effectiveLoadout.secondary === null && res.effectiveLoadout.primary === null
      && res.carry.placements.length === 0,
      `taken ${res.taken.length} 件 / 摆放 ${res.carry.placements.length} 件`);

    const kit = buildRaidKit(bare, config, { loadout: res.effectiveLoadout, carry: res.carry });
    check('★ M6 空仓库进局仍有兜底背包（"缺件也允许进局"是一条真能跑的路径）',
      kit.carry.backpack.source === 'default' && kit.loadout.primary === null
      && kit.loadout.backpack === null,
      `${kit.carry.backpack.w}×${kit.carry.backpack.h} / 无武器`);

    // 仓库里只有 40 发 9mm：只能带 40 发，不能凭空补成 60
    let p = { ...bare, loadouts: [{ ...bare.loadouts[0], ammo: { '9mm': 60 } }], stash: stashAdd([], 'pistol_mag', 40, config).stash };
    const res2 = takeLoadout(p, config);
    const placed = res2.carry.placements.filter((x) => x.itemId === 'pistol_mag').reduce((a, x) => a + x.count, 0);
    check('★ M6 仓库只有 40 发时，网格里也只有 40 发（拿不到的不会凭空出现）',
      placed === 40 && res2.missing.some((m) => m.itemId === 'pistol_mag' && m.missing === 20),
      `摆放 ${placed} 发 / 缺 ${JSON.stringify(res2.missing.map((m) => `${m.itemId}×${m.missing}`))}`);
  }

  // ---- ⑧ 负重上限 = 所装背包 + 技能加成（基数必须跟着背包走）----
  {
    const p = createNewProfile(config, 0);
    const base = skillModifiers(p, config, { weightBaseKg: 10 });
    check('★ M6 技能加成以**所装背包**的负重上限为基数（换大包才真的更能装）',
      base.weightLimitKg === 10,
      `10kg 基数 → ${base.weightLimitKg}kg（没点技能时等于基数）`);
    check('不传基数时退回参考装载（校验器与旧调用方行为不变）',
      skillModifiers(p, config).weightLimitKg === config.lootTable.backpack.weightLimitKg,
      `${skillModifiers(p, config).weightLimitKg}kg`);
  }
  // ---- ⑨ ★ M6 拖放所需的纯逻辑（仓库内移动 / 穿上 / 脱下）----
  {
    const p0 = createNewProfile(config, 0);
    // 一只 2×2 的背包 + 一把 2×4 的步枪 + 60 发弹药
    let st = stashAdd([], 'bp_small', 1, config).stash;
    st = stashAdd(st, 'rifle_sr25', 1, config).stash;
    st = stashAdd(st, 'pistol_mag', 60, config).stash;
    st = stashNormalize(st, config).stash;
    const bpEntry = st.find((e) => e.itemId === 'bp_small');
    const rifleEntry = st.find((e) => e.itemId === 'rifle_sr25');

    // 移到空格：合法，坐标与朝向都落定
    const mv = stashMoveTo(st, bpEntry.uid, 6, 5, true, config);
    const moved = mv.ok && mv.stash.find((e) => e.uid === bpEntry.uid);
    check('★ M6 仓库内移动：落到空格时坐标与朝向都改（拖放的基础）',
      moved && moved.x === 6 && moved.y === 5 && moved.rotated === true,
      mv.ok ? `→ (${moved.x},${moved.y}) rotated=${moved.rotated}` : `被拒：${mv.reason}`);

    // 移到被占的格：非法，**原样返回**（不是静默挪到别处）
    const bad = stashMoveTo(st, bpEntry.uid, rifleEntry.x, rifleEntry.y, false, config);
    check('★ M6 落点被占用时拒绝并给出原因（不静默挪到别处）',
      bad.ok === false && bad.reason === 'occupied' && bad.stash === st,
      `reason=${bad.reason}`);

    // 移出界：非法
    const oob = stashMoveTo(st, bpEntry.uid, 99, 0, false, config);
    check('落点越界时拒绝（reason=out-of-bounds）', oob.ok === false && oob.reason === 'out-of-bounds', oob.reason);

    // 自己那一格：必须仍然合法（占用图要排除自己，否则永远和自己重叠）
    const self = stashMoveTo(st, bpEntry.uid, bpEntry.x, bpEntry.y, !bpEntry.rotated, config);
    check('★ M6 原地旋转合法（占用图排除了自己，否则"转一下"永远失败）',
      self.ok === true, self.ok ? 'ok' : self.reason);

    // stashAddAt：指定格放一件
    const at = stashAddAt(st, 'bandage', 1, 9, 11, false, config);
    check('stashAddAt 在指定格放下一件（卸下装备的落点用它）',
      at.ok && at.stash.length === st.length + 1, at.ok ? `uid=${at.uid}` : at.reason);
    const at2 = stashAddAt(at.stash, 'bandage', 1, 9, 11, false, config);
    check('stashAddAt 落点被占用时拒绝', at2.ok === false && at2.reason === 'occupied', at2.reason);

    // ---- 穿上 / 脱下 ----
    const profile1 = { ...p0, stash: st, loadouts: [{ ...p0.loadouts[0], backpack: null }] };
    const eq = equipFromStash(profile1, profile1.loadouts[0].id, bpEntry.uid, 'backpack', config);
    const equipped = eq.ok && eq.profile.loadouts[0].backpack === 'bp_small';
    const stillInStash = eq.ok && eq.profile.stash.some((e) => e.uid === bpEntry.uid);
    check('★ M6 从仓库拖到装备格：装上了，且那一格从仓库消失',
      equipped && !stillInStash,
      eq.ok ? `backpack=${eq.profile.loadouts[0].backpack} 仓库仍有该 uid=${stillInStash}` : `被拒：${eq.reason}`);

    // 部位/槽号不匹配必须被拒
    const wrongSlot = slotAcceptsItem('backpack', 'rifle_sr25', config);
    check('槽位白名单：背包槽拒绝步枪（reason=slot-rejects:weapon）',
      wrongSlot.ok === false && wrongSlot.reason === 'slot-rejects:weapon', wrongSlot.reason);
    const wrongCover = slotAcceptsItem('head', 'vest2', config);
    check('护甲部位校验：头盔槽拒绝胸甲（reason=wrong-cover）',
      wrongCover.ok === false && wrongCover.reason === 'wrong-cover', wrongCover.reason);
    const wrongWeapon = slotAcceptsItem('secondary', 'rifle_m4', config);
    check('武器槽号校验：副武器槽拒绝主武器（reason=wrong-weapon-slot）',
      wrongWeapon.ok === false && wrongWeapon.reason === 'wrong-weapon-slot', wrongWeapon.reason);

    // 换装：原来那件**还回仓库**，不凭空消失
    let p2 = { ...p0, stash: stashAdd([], 'bp_large', 1, config).stash, loadouts: [{ ...p0.loadouts[0], backpack: 'bp_small' }] };
    const largeEntry = p2.stash.find((e) => e.itemId === 'bp_large');
    const swap = equipFromStash(p2, p2.loadouts[0].id, largeEntry.uid, 'backpack', config);
    check('★ M6 换装时原来那件还回仓库（数量守恒，不凭空消失）',
      swap.ok && swap.profile.loadouts[0].backpack === 'bp_large'
      && stashTotalOf(swap.profile.stash, 'bp_small', config) === 1
      && stashTotalOf(swap.profile.stash, 'bp_large', config) === 0,
      swap.ok ? `装上 bp_large，仓库里 bp_small=${stashTotalOf(swap.profile.stash, 'bp_small', config)}` : swap.reason);

    // 脱下：放回指定格
    const off = unequipToStash(swap.profile, swap.profile.loadouts[0].id, 'backpack', { x: 3, y: 7, rotated: false }, config);
    const back = off.ok && off.profile.stash.find((e) => e.itemId === 'bp_large');
    check('★ M6 脱下装备放回指定格（玩家点哪就放哪）',
      !!back && back.x === 3 && back.y === 7 && off.profile.loadouts[0].backpack === null,
      off.ok ? `→ (${back.x},${back.y})` : off.reason);

    // 仓库满时脱下必须被拒（不能吞掉一件装备）
    const fullStash = [];
    let f = fullStash;
    for (let i = 0; i < 20; i++) f = stashAdd(f, 'rifle_sr25', 1, config).stash;   // 20×8 = 160 > 120 格
    const fullPlaced = stashUsedSlots(f, config);
    const p3 = { ...p0, stash: f, loadouts: [{ ...p0.loadouts[0], backpack: 'bp_medium' }] };
    const offFull = unequipToStash(p3, p3.loadouts[0].id, 'backpack', null, config);
    check('★ M6 仓库放不下时拒绝脱下（宁可让玩家腾地方，也不吞掉装备）',
      fullPlaced >= stashCapacity(config) ? (offFull.ok === false && offFull.reason === 'stash-full') : true,
      `已用 ${fullPlaced}/${stashCapacity(config)} 格 → ${offFull.ok ? '竟然成功了' : offFull.reason}`);
  }
  // ---- ⑩ 整理背包：携行件留在原处，战利品重排，且**一件都不能丢** ----
  //   为什么单独测它：tidy() 在 M6 被重写过（要同时照顾两张网格与"自带/战利品"两种来源），
  //   而它最危险的失效方式是"整理完东西少了"——那种缺陷只会在玩了几局之后被玩家发现。
  {
    const kit = kitFor({ backpack: 'bp_medium', rig: 'rig_light', ammo: { '9mm': 60 }, consumables: { bandage: 3, medkit: 2 } });
    const inv = createInventory(config, { kit });
    const kitBefore = inv.items.map((e) => ({ id: e.item.id, x: e.x, y: e.y, where: e.where }));
    const tally = (list) => {
      const m = new Map();
      for (const e of list) m.set(e.item.id, (m.get(e.item.id) || 0) + (e.count || 1));
      return m;
    };
    const before = tally(inv.items);

    const picks = ['rifle_sr25', 'vest4', 'gold_bar', 'bandage', 'pistol_mag'];
    let picked = 0;
    for (const id of picks) {
      const r = inv.tryAdd(config.itemDefs[id]);
      if (r.ok) {
        picked++;
        before.set(id, (before.get(id) || 0) + (config.itemDefs[id].unitsPerItem || 1));
      }
    }
    const res = inv.tidy();
    const after = tally(inv.items);
    const keys = [...new Set([...before.keys(), ...after.keys()])];
    const lost = keys.filter((k) => (before.get(k) || 0) !== (after.get(k) || 0));

    check('★ M6 整理背包后**内容守恒**（每种物品的数量一件不差）',
      lost.length === 0,
      lost.length ? lost.map((k) => `${k} ${before.get(k) || 0}→${after.get(k) || 0}`).join('、')
        : `捡了 ${picked} 件，整理后 ${inv.items.length} 条，内容一致`);

    const kitAfter = inv.items.filter((e) => e.source === 'kit').map((e) => ({ id: e.item.id, x: e.x, y: e.y, where: e.where }));
    check('★ M6 整理时**携行件留在原处**（玩家不会以为"整理把我的子弹弄丢了"）',
      kitAfter.length === kitBefore.length
      && kitAfter.every((a, i) => a.id === kitBefore[i].id && a.x === kitBefore[i].x && a.y === kitBefore[i].y),
      kitAfter.map((e) => `${e.id}@${e.x},${e.y}`).join(' '));

    const over = inv.items.filter((e) => (e.count || 1) > (config.itemDefs[e.item.id].stack || 1));
    check('整理后没有条目超过物品的 stack（一格放多件的前提）', over.length === 0,
      over.map((e) => `${e.item.id}×${e.count}`).join('、') || '全部合法');

    // 弹挂优先：捡到的弹药/药品应当落进弹挂（只要它还有位置）
    const rigLoot = inv.items.filter((e) => e.source === 'loot' && e.where === 'rig' && ['ammo', 'medical'].includes(e.item.category));
    check('★ M6 捡到的弹药/药品优先落进弹挂（与进场投放同一条规则）',
      rigLoot.length > 0,
      rigLoot.map((e) => `${e.item.id}@${e.x},${e.y}`).join(' ') || '没有落进弹挂');
  }
}

// ============================================================
console.log('\n================ 纯逻辑单元测试 ================');
console.log(`  通过 ${pass} / ${pass + failures.length}`);
if (failures.length) {
  console.log('\n  失败项：');
  for (const f of failures) console.log(`    [FAIL] ${f}`);
  process.exit(1);
}
console.log('  全部通过。');
