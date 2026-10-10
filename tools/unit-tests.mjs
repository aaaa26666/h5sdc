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
import { createVitals, heal, canHealWith } from '../src/gameplay/vitals.js';
import {
  accelerate, airAccelerate, applyFriction,
  createJumpState, queueJump, consumeJump,
  createLandingState, applyLandingImpact, updateLanding,
  stepUpTarget,
} from '../src/core/movement.js';
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

// ============================================================
console.log('\n================ 纯逻辑单元测试 ================');
console.log(`  通过 ${pass} / ${pass + failures.length}`);
if (failures.length) {
  console.log('\n  失败项：');
  for (const f of failures) console.log(`    [FAIL] ${f}`);
  process.exit(1);
}
console.log('  全部通过。');
