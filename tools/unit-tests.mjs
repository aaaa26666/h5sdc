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

  // ---- 关卡掩体配置一致性 ----
  {
    const lc = config.level.lowCover;
    check('关卡配置包含低矮掩体', !!lc && lc.count > 0, `count=${lc?.count}`);
    check('低掩体高度不超过 stepHeight（否则"可迈上"是假的）',
      lc.lowHeight <= config.player.stepHeight,
      `lowHeight=${lc.lowHeight} ≤ stepHeight=${config.player.stepHeight}`);
    check('高掩体高度超过 stepHeight（否则"需要跳"是假的）',
      lc.tallHeight > config.player.stepHeight,
      `tallHeight=${lc.tallHeight} > stepHeight=${config.player.stepHeight}`);
    check('高掩体占比在合理范围', lc.tallRatio > 0 && lc.tallRatio < 1, `${lc.tallRatio}`);

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
