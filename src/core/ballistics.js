// 弹道与伤害模型（纯函数，无引擎/无 DOM 依赖）
//
// 为什么必须是纯函数：M2 的硬性要求是"每次涉及 AI 或武器的改动必须提供 TTK 变化数据"。
// 如果伤害计算埋在渲染循环里，TTK 就只能靠打靶估摸，无法在 CI 里逐武器逐部位回归。
// 抽成纯函数后，tools/ttk.mjs 可以在 Node 里算出全表并做设计目标判定。
//
// 模型覆盖：距离衰减 → 部位倍率 → 护甲减伤（含耐久衰减与穿甲等级）→ 多次命中累积。

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 距离衰减系数：startM 内为 1，endM 外为 minScale，之间线性 */
export function falloffScale(weapon, distanceM) {
  const f = weapon.falloff;
  if (distanceM <= f.startM) return 1;
  if (distanceM >= f.endM) return f.minScale;
  const t = (distanceM - f.startM) / (f.endM - f.startM);
  return 1 + (f.minScale - 1) * t;
}

/** 单发（单弹丸）在指定部位与距离的原始伤害（未计护甲） */
export function rawZoneDamage(weapon, zone, distanceM) {
  const base = weapon.damage[zone];
  if (typeof base !== 'number') {
    throw new Error(`[ballistics] 武器 ${weapon.id} 未定义部位 ${zone} 的伤害`);
  }
  return base * falloffScale(weapon, distanceM);
}

/** 护甲是否覆盖该部位 */
export function armorCovers(armorDef, zone) {
  return !!armorDef && Array.isArray(armorDef.covers) && armorDef.covers.includes(zone);
}

/**
 * 护甲减伤比例。
 * 三个因子：
 *   1. 基础减伤（damageAbsorb）
 *   2. 耐久衰减 —— 甲被打烂后减伤显著下降，而不是一直满效
 *   3. 穿甲等级 —— 弹药穿甲等级相对护甲等级的收益
 *
 * 穿甲公式用 max(0, pen - class + 1) 而不是 max(0, pen - class)：
 *   后者意味着"穿甲等级刚好等于护甲等级"时收益为 0，于是 7.62（穿甲 3）
 *   打三级甲与 5.56（穿甲 2）完全相同 —— 高穿甲弹药在它最该有用的场合毫无优势。
 *   这个缺陷是被 tools/unit-tests.mjs 的"穿甲等级高的弹药减伤更低"断言抓出来的。
 */
export function armorAbsorb(armorDef, armorDurability, ammoDef, armorRules) {
  if (!armorDef || armorDef.class === 0) return 0;
  if (!(armorDurability > 0)) return armorRules.minAbsorbWhenBroken;

  const durRatio = clamp(armorDurability / armorDef.durability, 0, 1);
  const s = armorRules.durabilityToAbsorbScale;
  const effective = armorDef.damageAbsorb * (s + (1 - s) * durRatio);

  const penLevel = ammoDef ? ammoDef.armorPenetration : 0;
  const penBonus = Math.max(0, penLevel - armorDef.class + 1) * armorRules.penetrationLevelBonus;

  return clamp(effective - penBonus, 0, 0.85);
}

/**
 * 解算一次命中。
 * @returns {{zone, raw, absorb, damage, durabilityLoss, armorBroken}}
 */
export function resolveHit({ weapon, ammo, zone, distanceM, armorDef, armorDurability, armorRules }) {
  const raw = rawZoneDamage(weapon, zone, distanceM);
  const covered = armorCovers(armorDef, zone);
  const absorb = covered ? armorAbsorb(armorDef, armorDurability, ammo, armorRules) : 0;
  const damage = raw * (1 - absorb);
  const durabilityLoss = covered && armorDurability > 0 ? armorDef.durabilityLossPerHit : 0;
  return {
    zone,
    raw: +raw.toFixed(3),
    absorb: +absorb.toFixed(4),
    damage: +damage.toFixed(3),
    durabilityLoss,
    armorBroken: covered && armorDurability > 0 && armorDurability - durabilityLoss <= 0,
  };
}

/**
 * 击杀所需「扣扳机次数」。
 * 霰弹枪一次扣扳机发射多个弹丸，因此不能按"发数"算。
 * 护甲会随命中逐次衰减，所以必须逐次模拟，不能用首次减伤乘总数。
 */
export function shotsToKill({
  weapon,
  ammo,
  zone,
  distanceM,
  armorDef = null,
  armorDurability = 0,
  armorRules,
  maxHealth,
  pelletHitRatio = 1.0,
}) {
  const pellets = Math.max(1, weapon.pellets || 1);
  let hp = maxHealth;
  let dur = armorDurability;
  let pulls = 0;
  const GUARD = 200;

  while (hp > 0 && pulls < GUARD) {
    for (let p = 0; p < pellets; p++) {
      // pelletHitRatio 用于表达"弹丸并非全部命中"的现实情况
      const r = resolveHit({ weapon, ammo, zone, distanceM, armorDef, armorDurability: dur, armorRules });
      hp -= r.damage * pelletHitRatio;
      dur = Math.max(0, dur - r.durabilityLoss);
      if (hp <= 0) break;
    }
    pulls++;
  }
  return pulls;
}

/**
 * TTK（毫秒）= (扣扳机次数 - 1) × 射击间隔。
 * 第一发视为瞬时命中，所以减 1。
 */
export function timeToKillMs(pulls, weapon) {
  return Math.max(0, (pulls - 1) * weapon.fireIntervalMs);
}

/** 完整 TTK 解算，返回可直接进表格的结构 */
export function computeTtk(opts) {
  const pulls = shotsToKill(opts);
  return {
    pulls,
    ttkMs: timeToKillMs(pulls, opts.weapon),
    perHit: resolveHit(opts),
  };
}

// ============================================================
// 后坐力
// ============================================================

/**
 * 取第 shotIndex 发（0 起）的后坐力偏移。
 * 设计：使用**固定弹道图案**而不是纯随机 —— 这样玩家可以练习压枪，
 * 也让"后坐力曲线"成为可写进配置表、可被工具读取和对比的量化对象。
 * 图案用尽后沿用最后一发（避免退化为随机）。
 */
export function recoilAt(weapon, shotIndex, isAds, rng) {
  const pat = weapon.recoil.pattern;
  const e = pat[Math.min(shotIndex, pat.length - 1)];
  const scale = isAds ? weapon.recoil.adsScale : 1;
  const jitter = (rng() * 2 - 1) * (weapon.recoil.randomYawDeg || 0);
  return {
    yawDeg: (e[0] + jitter) * scale,
    pitchDeg: e[1] * scale,
  };
}

/** 后坐力在若干发之后的累计偏移（供 TTK 报表与评审看"压枪难度"） */
export function recoilCumulative(weapon, shots, isAds) {
  let yaw = 0;
  let pitch = 0;
  const noJitter = () => 0.5; // 让 jitter 抵消，得到纯图案累计
  for (let i = 0; i < shots; i++) {
    const r = recoilAt(weapon, i, isAds, noJitter);
    yaw += r.yawDeg;
    pitch += r.pitchDeg;
  }
  return { yawDeg: +yaw.toFixed(3), pitchDeg: +pitch.toFixed(3) };
}

/**
 * 连发时的**净抬升速率**（度/秒）—— 这是 M2-TEMP-1 的核心量化指标。
 *
 * 背景：后坐力恢复原先是无条件的（每帧都按 recoveryPerSec 把视角拉回），
 * 而连发抬升速率与恢复速率同量级，于是两者几乎抵消。
 * 实测修复前 5 把武器里有 3 把的净值为**负数** ——
 * 也就是持续射击时视角在往下走，后坐力图案完全失去意义。
 *
 * 修复后恢复分两档：距上次开火 `recoveryDelayMs` 以内只按
 * `recoveryWhileFiringScale` 生效，超过则全额恢复。
 * 本函数返回**连发期间**的净速率，因此它必须为正 —— 这条不变量已加进单测。
 *
 * @returns 度/秒。正值表示视角持续上抬。
 */
export function sustainedClimbRate(weapon, isAds = false) {
  const pat = weapon.recoil.pattern;
  const first = pat[0];
  const shotRate = 1000 / weapon.fireIntervalMs; // 每秒发数
  const scale = isAds ? weapon.recoil.adsScale : 1;
  const climbPerSec = first[1] * scale * shotRate;
  const recovery =
    (weapon.recoil.recoveryPerSec || 0) * (weapon.recoil.recoveryWhileFiringScale ?? 1);
  return +(climbPerSec - recovery).toFixed(3);
}

/** 停火后恢复所需的近似时间（秒）：从当前累计偏移回到 0 */
export function recoverySeconds(weapon, accumulatedPitchDeg) {
  const rate = weapon.recoil.recoveryPerSec || 1;
  return +(Math.abs(accumulatedPitchDeg) / rate).toFixed(3);
}

// ============================================================
// 扩散
// ============================================================

export function baseSpread(weapon, isAds) {
  return isAds ? weapon.adsSpreadDeg : weapon.hipSpreadDeg;
}

/** 开一枪后的扩散；移动会放大扩散增长 */
export function spreadOnShot(weapon, currentSpreadDeg, isAds, isMoving) {
  const move = isMoving ? weapon.moveSpreadScale : 1;
  return Math.min(weapon.maxSpreadDeg, currentSpreadDeg + weapon.spreadPerShotDeg * move);
}

/** 经过 dtSec 恢复后的扩散；不会低于该姿态的基础扩散 */
export function spreadAfterRecovery(weapon, currentSpreadDeg, dtSec, isAds) {
  const recovered = currentSpreadDeg - weapon.spreadRecoveryPerSec * dtSec;
  return Math.max(baseSpread(weapon, isAds), recovered);
}

/** 从满扩散恢复到基础扩散所需时间（秒）—— 手感量化指标之一 */
export function spreadRecoverySeconds(weapon, isAds) {
  return (weapon.maxSpreadDeg - baseSpread(weapon, isAds)) / weapon.spreadRecoveryPerSec;
}

// ============================================================
// 扩散锥采样（纯数学，rng 注入以保证可复现）
// ============================================================

/**
 * 在视线方向周围按扩散角采样一个方向。
 * @param baseDir {x,y,z} 单位向量
 * @param spreadDeg 扩散半角（度）
 * @param rng 返回 [0,1) 的随机源
 */
export function applySpread(baseDir, spreadDeg, rng) {
  if (!(spreadDeg > 0)) return { x: baseDir.x, y: baseDir.y, z: baseDir.z };
  const rad = (spreadDeg * Math.PI) / 180;
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * Math.tan(rad);

  // 构造正交基
  const upx = Math.abs(baseDir.y) > 0.99 ? 1 : 0;
  const upy = Math.abs(baseDir.y) > 0.99 ? 0 : 1;
  // right = dir × up
  let rx = baseDir.y * 0 - baseDir.z * upy;
  let ry = baseDir.z * upx - baseDir.x * 0;
  let rz = baseDir.x * upy - baseDir.y * upx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // realUp = right × dir
  const ux = ry * baseDir.z - rz * baseDir.y;
  const uy = rz * baseDir.x - rx * baseDir.z;
  const uz = rx * baseDir.y - ry * baseDir.x;

  const ca = Math.cos(a) * r;
  const sa = Math.sin(a) * r;
  let ox = baseDir.x + rx * ca + ux * sa;
  let oy = baseDir.y + ry * ca + uy * sa;
  let oz = baseDir.z + rz * ca + uz * sa;
  const ol = Math.hypot(ox, oy, oz) || 1;
  return { x: ox / ol, y: oy / ol, z: oz / ol };
}

/** 后坐力方向应用到瞄准方向（yaw/pitch 偏移） */
export function applyRecoilToAim(yaw, pitch, recoil) {
  return {
    yaw: yaw + (recoil.yawDeg * Math.PI) / 180,
    pitch: clamp(pitch + (recoil.pitchDeg * Math.PI) / 180, -1.55, 1.55),
  };
}
