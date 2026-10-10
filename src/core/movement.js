// 移动手感 —— 纯函数层
//
// 本文件解决 M1-TEMP-2（移动无加速度/摩擦/落地缓冲）。
//
// ---- 为什么"直接设速度"手感差 ----
// M1 的实现是：有输入就 `vel = 方向 × 速度`，没输入就 `vel = 0`。
// 这带来三个可感知的问题：
//   ① 从静止到全速、从全速到静止都是**瞬间**发生的，角色像被瞬移而不是被推动；
//   ② 急停时画面没有任何缓冲，转向时显得"生硬"；
//   ③ 空中可以像地面一样随意变向，跳跃轨迹完全可控，缺少重量感。
//
// 现在改成 Quake/Source 系的经典模型：**速度是惯性的结果，不是输入的直接映射**。
//   · 地面：先施加摩擦，再沿期望方向做有上限的加速
//   · 空中：只有受限的空气控制，且**不能凭空中输入获得超过上限的速度**
//   · 落地：按落地冲击速度给相机一个下沉，再回弹
//
// 全部为纯函数，不依赖 DOM / Three.js / 时间源，因此可以直接单测。
// 这对"手感"类改动尤其重要：手感参数错了肉眼很难发现，但方程错了测一下就出来。

const EPS = 1e-9;

/**
 * 地面加速。
 *
 * 核心是**按期望方向上的速度分量差来补**，而不是直接把速度设成目标值：
 * 只补差额，且单帧补的量有上限 —— 这就是"加速度"的来源。
 *
 * @param vel     {x,z} 速度（就地修改）
 * @param wishX   期望方向的单位向量
 * @param wishZ
 * @param wishSpeed 该状态下的目标速度（走/跑/蹲不同）
 * @param accel   加速度系数（越大越"跟手"，越小越"沉"）
 * @param dt      秒
 * @returns 本帧实际沿期望方向增加的速度
 */
export function accelerate(vel, wishX, wishZ, wishSpeed, accel, dt) {
  const current = vel.x * wishX + vel.z * wishZ; // 沿期望方向已有的分量
  const add = wishSpeed - current;
  // 已经达到或超过目标速度：不再加速。
  // 这一条同时也保证了"斜向移动不会因为两个轴分别加速而变快"。
  if (add <= 0) return 0;
  let accelSpeed = accel * wishSpeed * dt;
  if (accelSpeed > add) accelSpeed = add;
  vel.x += wishX * accelSpeed;
  vel.z += wishZ * accelSpeed;
  return accelSpeed;
}

/**
 * 空气加速。
 *
 * 与地面加速的区别是**目标速度被 airWishCap 截断**：
 * 期望方向上的速度分量一旦达到 airWishCap 就完全不再加速，
 * 因此玩家**无法靠空中输入把水平速度刷上去**（那样会变成可利用的位移技巧）。
 *
 * 仍然保留一定的空中微调能力，否则跳跃会完全不可控。
 */
export function airAccelerate(vel, wishX, wishZ, wishSpeed, airAccel, airWishCap, dt) {
  const capped = Math.min(wishSpeed, airWishCap);
  const current = vel.x * wishX + vel.z * wishZ;
  const add = capped - current;
  if (add <= 0) return 0;
  // 注意增量用的是 capped 而不是 wishSpeed ——
  // 若用 wishSpeed，冲刺起跳后能在空中持续获得大加速度，正是要避免的位移技巧。
  let accelSpeed = airAccel * capped * dt;
  if (accelSpeed > add) accelSpeed = add;
  vel.x += wishX * accelSpeed;
  vel.z += wishZ * accelSpeed;
  return accelSpeed;
}

/**
 * 摩擦（减速）。
 *
 * ---- 这里曾经有一个会让游戏完全不能玩的 bug ----
 * 初版写法是"speed < stopSpeed 就把速度直接归零"，本意是避免低速无限滑行。
 * 但它与加速的交互是致命的：每帧加速增量是 `accel × wishSpeed × dt`，
 * 在 165Hz 下只有 `11 × 5 / 165 ≈ 0.33`，**小于 stopSpeed(1.2)**，
 * 于是每一帧摩擦都把刚加上的那点速度清零，玩家永远加不起速度 ——
 * 实测最高只能到 0.33 m/s，角色基本无法移动。
 * 60Hz 下是 0.917，同样小于 1.2，所以**任何帧率下都跑不动**，只是数值不同。
 * 这个 bug 靠试玩未必能立刻说清原因（表现为"怎么走不动"），
 * 但"输入方向后能达到目标速度"是可断言的事实。
 *
 * 正确做法（Quake PM_Friction 的 control 项）：
 *   减速量按 `max(speed, stopSpeed)` 计算，而不是按 speed。
 *   效果是：高于 stopSpeed 时按比例减速（手感自然），
 *   低于 stopSpeed 时是**恒定减速度** —— 仍然能在有限时间内精确停到 0，
 *   但不会在加速过程中把速度掐死。
 *
 * @returns 本帧减少的速度大小
 */
export function applyFriction(vel, friction, stopSpeed, dt) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed < EPS) {
    vel.x = 0;
    vel.z = 0;
    return 0;
  }
  const control = speed < stopSpeed ? stopSpeed : speed;
  const drop = control * friction * dt;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
  return speed - newSpeed;
}

/**
 * 把水平速度限制在上限内（用于冲刺结束、蹲下等需要立即压制速度的场合）。
 * 注意这不是摩擦：它只在超速时裁剪，不产生"减速过程"。
 */
export function clampHorizontalSpeed(vel, maxSpeed) {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed <= maxSpeed || speed < EPS) return 0;
  const scale = maxSpeed / speed;
  vel.x *= scale;
  vel.z *= scale;
  return speed - maxSpeed;
}

// ---------------------------------------------------------------------------
// 跳跃缓冲与土狼时间
//
// 这两个是"玩家觉得操作跟手"的关键，缺了会频繁出现"我明明按了跳却没跳"：
//   · 跳跃缓冲：落地**前**一点点按下的跳跃要记住，落地瞬间生效。
//     没有它，玩家必须精确到落地那一帧按下，成功率极低。
//   · 土狼时间：走出边缘**后**一点点仍然允许起跳。
//     没有它，走到边缘会"跳过按键直接掉下去"，感觉像游戏吞了输入。
// 两者都只放宽时间窗口，不改变跳跃高度与速度，因此不会影响平衡。
// ---------------------------------------------------------------------------

export function createJumpState() {
  return {
    // 用 -Infinity 而非 0：时间源是 performance.now()，初值为 0 会让开局第一帧
    // 被误判为"刚刚离地"，从而允许一次凭空起跳。
    lastGroundedAt: -Infinity,
    jumpQueuedAt: -Infinity,
  };
}

/** 记录一次跳跃输入 */
export function queueJump(js, nowMs) {
  js.jumpQueuedAt = nowMs;
}

/** 只更新"最后在地面的时刻"，不起跳 */
export function noteGrounded(js, nowMs, onGround) {
  if (onGround) js.lastGroundedAt = nowMs;
}

/**
 * 尝试消费一次跳跃。
 * @returns true 表示本帧应该起跳
 */
export function consumeJump(js, onGround, nowMs, coyoteMs, bufferMs) {
  if (onGround) js.lastGroundedAt = nowMs;
  const withinCoyote = nowMs - js.lastGroundedAt <= coyoteMs;
  const withinBuffer = nowMs - js.jumpQueuedAt <= bufferMs;
  if (withinBuffer && withinCoyote) {
    // 消费掉，避免一次按键触发两段跳跃
    js.jumpQueuedAt = -Infinity;
    js.lastGroundedAt = -Infinity;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 落地缓冲
//
// 落地冲击越大，相机下沉越多，然后按固定速度回弹。
// 这不是装饰：没有它，落地时画面完全不响应，玩家无法从视觉上判断自己落地了，
// 也就无法判断何时可以再次起跳。
// ---------------------------------------------------------------------------

export function createLandingState() {
  return { dip: 0, lastImpactSpeed: 0, landings: 0 };
}

/**
 * 落地：按冲击速度设置下沉量（取较大者，避免连续小落地覆盖掉一次大落地）
 * @returns 本次产生的下沉量
 */
export function applyLandingImpact(state, impactSpeed, maxDip, dipPerSpeed) {
  state.lastImpactSpeed = impactSpeed;
  state.landings++;
  if (impactSpeed <= 0) return 0;
  const target = Math.min(maxDip, impactSpeed * dipPerSpeed);
  // 已有更大的下沉量时不要被小落地减小
  if (target <= state.dip) return 0;
  state.dip = target;
  return target;
}

/** 每帧回弹 */
export function updateLanding(state, dt, recoverSpeed) {
  if (state.dip <= 0) {
    state.dip = 0;
    return 0;
  }
  state.dip = Math.max(0, state.dip - recoverSpeed * dt);
  return state.dip;
}

// ---------------------------------------------------------------------------
// 台阶吸附（M1-TEMP-3 的判定部分）
//
// 思路：可迈上的高度差就自动抬上去，不需要玩家按跳跃。
//
// 实际实现里，"低掩体不阻挡移动"这一条由 level.resolveCircle 负责
// （阻挡体顶面比脚底高出不超过 stepHeight 时不阻挡），
// 本函数只负责**抬升多少**这个决策。两者配合的完整链条：
//   1. 玩家水平走向 0.45 米高的平台
//   2. resolveCircle 判断 0.45-0.55 < 0 → 不阻挡，人走到了平台格上
//   3. groundHeightAt 返回 0.45，本函数判定 0.45-0 ≤ stepHeight → 抬到 0.45
//   4. 于是走上去是"迈一步"而不是"撞墙"或"瞬移"
//
// 只做判定，不碰几何与渲染，因此可以直接单测。
// ---------------------------------------------------------------------------

/**
 * @param currentY  当前脚底高度
 * @param groundY   目标位置的地面高度
 * @param stepHeight 可自动迈上的最大高度差
 * @returns 需要吸附到的脚底高度；不需要吸附则返回 false
 */
export function stepUpTarget(currentY, groundY, stepHeight) {
  if (groundY <= currentY) return false; // 比当前低或持平：交给重力，不吸附
  if (groundY - currentY > stepHeight) return false; // 太高：必须跳
  return groundY;
}
