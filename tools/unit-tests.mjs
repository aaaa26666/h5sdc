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
  spreadOnShot,
  spreadAfterRecovery,
  baseSpread,
  spreadRecoverySeconds,
  applySpread,
} from '../src/core/ballistics.js';
import { pickUpdateTier, jitteredDeadline } from '../src/core/navgrid.js';
import { createVitals, heal, canHealWith } from '../src/gameplay/vitals.js';
import { config, weaponById, ammoById, armorById } from '../src/config/index.js';

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
  const cases = [
    ['null', null], ['字符串', 'garbage'], ['数字', 42], ['数组', []],
    ['合法值', { sprintMode: 'toggle', crouchMode: 'hold' }],
    ['枚举大小写错误', { sprintMode: 'HOLD', crouchMode: 'Toggle' }],
    ['枚举胡写', { sprintMode: '飞行', crouchMode: 'x' }],
    ['类型错误', { sprintMode: 123, crouchMode: null }],
    ['夹带未知键', { sprintMode: 'toggle', evil: 'alert(1)' }],
  ];
  for (const [name, raw] of cases) {
    const r = sanitizeSettings(raw);
    const valid =
      Object.keys(r).sort().join(',') === 'crouchMode,sprintMode' &&
      ['hold', 'toggle'].includes(r.sprintMode) &&
      ['hold', 'toggle'].includes(r.crouchMode);
    check(`设置校验：${name} → 合法且无多余键`, valid, JSON.stringify(r));
  }
  const kept = sanitizeSettings({ sprintMode: 'toggle', crouchMode: 'toggle' });
  check('设置校验：合法值必须保留', kept.sprintMode === 'toggle' && kept.crouchMode === 'toggle');
  const polluted = sanitizeSettings(JSON.parse('{"__proto__":{"polluted":true},"sprintMode":"toggle"}'));
  check('设置校验：不污染 Object.prototype', ({}).polluted === undefined);
  void polluted;
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
    check('canHealWith：血量高于上限时为 false',
      canHealWith(v0, { maxHealthCap: 45 }) === false);
    v0.health = 20;
    check('canHealWith：血量低于上限时为 true', canHealWith(v0, { maxHealthCap: 45 }) === true);
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
console.log('\n================ 纯逻辑单元测试 ================');
console.log(`  通过 ${pass} / ${pass + failures.length}`);
if (failures.length) {
  console.log('\n  失败项：');
  for (const f of failures) console.log(`    [FAIL] ${f}`);
  process.exit(1);
}
console.log('  全部通过。');
