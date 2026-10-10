// M2 玩家：移动 + 护甲 + 医疗 + 探头命中体积
//
// M1 遗留项在本文件中的处理：
//   M1-TEMP-18（探头只动相机、不改变可命中体积 → 探头没有战术价值）已修复：
//     新增 hitZoneCenter()，把命中部位的中心按**探头偏移与蹲下高度**一起算出来。
//     AI 射击与玩家自身体积判定都走这个函数，因此探头出去真的会改变被弹面积，
//     蹲下也真的会降低被弹高度 —— 这两个动作至此才有决策价值。
//
//   **M1-TEMP-2（移动无加速度/摩擦/落地缓冲）本轮已修复**：
//     移动从"直接设速度"改为惯性模型 —— 地面先摩擦后加速、空中只有受限控制、
//     落地按冲击速度产生相机下沉。数学部分在 src/core/movement.js（纯函数、可单测）。
//
//   **M1-TEMP-3（无台阶吸附）本轮已修复**：
//     配合 level.js 的高度感知碰撞：可迈上的高度差自动抬升，且抬升是**平滑**的。
//     前提是关卡中要有可踩的低矮几何 —— 见 level.js 顶部的范围声明。
import * as THREE from 'three';
import { movementBasis, wishDirection, viewForward } from '../core/direction.js';
import { createVitals, applyHit, heal, canHealWith } from './vitals.js';
import {
  accelerate,
  airAccelerate,
  applyFriction,
  createJumpState,
  queueJump,
  consumeJump,
  createLandingState,
  applyLandingImpact,
  updateLanding,
  stepUpTarget,
} from '../core/movement.js';

const DEG = Math.PI / 180;

export function createPlayer(cfg, level) {
  const P = cfg.player;
  const spawn = level.cellToWorld(cfg.level.playerSpawnCell[0], cfg.level.playerSpawnCell[1]);

  const vitals = createVitals({
    maxHealth: cfg.playerVitals.maxHealth,
    armorBySlot: cfg.playerVitals.startArmor,
    cfg,
  });

  const player = {
    pos: { x: spawn.x, y: 0, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    // ---- 视角拆成两部分（M2-TEMP-1 的修复）----
    //   aim*    : 玩家用鼠标控制的瞄准。**永久**，不会被后坐力恢复改动。
    //   recoil* : 后坐力造成的临时偏移。会随时间恢复到 0。
    // 外部（相机、射线、AI 视线）只读 yaw/pitch，它们是两者之和。
    // 之所以要拆开：原先后坐力直接加到 yaw/pitch 上、恢复也直接从上面减，
    // 于是"玩家主动压的枪"与"后坐力的枪"混在同一个数值里 ——
    // 连发时恢复把抬升抵消掉，5 把武器里有 3 把的净抬升甚至是负的（视角往下走）。
    aimYaw: 0,
    aimPitch: 0,
    recoilYaw: 0,
    recoilPitch: 0,
    yaw: 0,
    pitch: 0,
    onGround: true,
    crouching: false,
    sprinting: false,
    leanTarget: 0,
    leanCurrent: 0,
    eyeHeightCurrent: P.eyeHeight,
    alive: true,
    shotsFired: 0,
    // 医疗
    usingItem: null,
    useEndAt: 0,
    useTotalMs: 0,
    lastDamageAt: -1e9,
    // 台阶
    lastStepUpAt: -1e9,
    stepUps: 0,
    steppingUp: false,
    // 运动探针：单帧脚底高度最大变化量，用于把"画面跳变"变成可断言的值
    lastFrameDY: 0,
    maxFrameDY: 0,
    maxFrameDYAt: 0,
    lastFrameDYSpeed: 0,
    maxFrameDYSpeed: 0,
    maxFrameDYSpeedAt: 0,
    // 视角跳变探针（见 probeView）
    maxMouseDelta: 0,
    maxMouseRad: 0,
    maxYawJump: 0,
    maxPitchJump: 0,
    maxLeanJump: 0,
    maxLeanSpeed: 0,
    maxNonMouseJump: 0,
  };

  const jumpState = createJumpState();
  const landing = createLandingState();

  /**
   * 把 aim + recoil 合成对外可见的视角。任何一路变化后都必须调用。
   */
  function syncView() {
    const lim = P.pitchLimitDeg * DEG;
    player.yaw = player.aimYaw + player.recoilYaw;
    player.pitch = Math.max(-lim, Math.min(lim, player.aimPitch + player.recoilPitch));
  }

  /**
   * 视角跳变探针。
   * 用途：把"视角有时候会瞬移"变成可测量、可归因的数字 ——
   * 分别记录单帧内 鼠标增量 / 后坐力 / 探头侧移 各自造成的最大变化，
   * 这样报告"瞬移"时能直接看出是哪一路引起的，而不是靠猜。
   */
  function probeView(before, mouseDx, mouseDy, dt) {
    const dyaw = Math.abs(player.yaw - before.yaw);
    const dpitch = Math.abs(player.pitch - before.pitch);
    const dlean = Math.abs(player.leanCurrent - before.lean);
    const dmouse = Math.hypot(mouseDx, mouseDy);
    if (dmouse > player.maxMouseDelta) player.maxMouseDelta = dmouse;
    if (dyaw > player.maxYawJump) player.maxYawJump = dyaw;
    if (dpitch > player.maxPitchJump) player.maxPitchJump = dpitch;
    if (dlean > player.maxLeanJump) player.maxLeanJump = dlean;
    // 探头侧移的**隐含速度**（m/s）。单帧变化量本身随帧率变化，
    // 拿固定阈值卡它会像"跳变"那样误判；速度才与帧率无关，
    // 也是"瞬移"的本质：一瞬间出现物理上不可能的移动速度。
    // 限速后上限是 leanClampRate × leanOffset（8 × 0.55 = 4.4 m/s，
    // 与冲刺速度 7.5 m/s 同量级）；未限速时可达约 60 m/s。
    if (dt > 1e-6) {
      const leanSpeed = (dlean * P.leanOffset) / dt;
      if (leanSpeed > player.maxLeanSpeed) player.maxLeanSpeed = leanSpeed;
    }
    // 归因：本帧视角变化里，鼠标贡献多少、后坐力+探头贡献多少
    const mouseRad = dmouse * P.mouseSensitivity;
    if (mouseRad > player.maxMouseRad) player.maxMouseRad = mouseRad;
    const residual = Math.max(0, Math.max(dyaw, dpitch) - mouseRad);
    if (residual > player.maxNonMouseJump) player.maxNonMouseJump = residual;
  }

  function applyLook(dx, dy) {
    player.aimYaw -= dx * P.mouseSensitivity;
    player.aimPitch -= dy * P.mouseSensitivity;
    const lim = P.pitchLimitDeg * DEG;
    player.aimPitch = Math.max(-lim, Math.min(lim, player.aimPitch));
    syncView();
  }

  /**
   * 由武器调用：后坐力加到**临时偏移**上，不污染玩家的瞄准。
   * 这样玩家压枪改变的是 aim，恢复只削减 recoil，两者不再互相抵消。
   */
  function addRecoil(yawRad, pitchRad) {
    player.recoilYaw += yawRad;
    player.recoilPitch += pitchRad;
    syncView();
  }

  /**
   * 后坐力恢复：只把**临时偏移**拉回 0，绝不动玩家的瞄准。
   *
   * 这是 M2-TEMP-1 的修复要点。恢复速率由武器侧决定（连发期间会被压低，
   * 否则恢复会再次抵消抬升 —— 那正是这个临时实现的病根）。
   *
   * @param rateDegPerSec 每秒恢复多少度
   */
  function recoverRecoil(rateDegPerSec, dt) {
    const step = rateDegPerSec * DEG * dt;
    if (step <= 0) return;
    const stepOne = (v) => {
      if (v === 0) return 0;
      const s = Math.min(Math.abs(v), step) * Math.sign(v);
      const next = v - s;
      return Math.abs(next) < 1e-4 ? 0 : next;
    };
    player.recoilYaw = stepOne(player.recoilYaw);
    player.recoilPitch = stepOne(player.recoilPitch);
    syncView();
  }

  /** 后坐力临时偏移的当前大小（度），用于可观测量与测试 */
  function recoilOffsetDeg() {
    return {
      yawDeg: +(player.recoilYaw / DEG).toFixed(4),
      pitchDeg: +(player.recoilPitch / DEG).toFixed(4),
    };
  }

  function clampLeanByWall(dt) {
    if (player.leanCurrent === 0) return;
    const eyeY = player.pos.y + player.eyeHeightCurrent;
    const b = movementBasis(player.yaw);
    const maxReach = P.leanOffset + P.leanWallMargin;
    // ★ 墙面限制**必须限速**，不能瞬间裁剪。
    // 瞬间裁剪会在单帧内吃掉最多 0.55m 的侧移 —— 相机一次性横向跳半米，
    // 与"跳上高箱子"那次是同一类错误：对**相机可见的值**做了瞬时改动。
    // 限速后同样的位移分摊到约 0.1s，看起来是"贴着墙收回来"而不是瞬移。
    const rate = (P.leanClampRate ?? 8) * dt;
    if (player.leanCurrent > 0) {
      const d = level.raycastWall(player.pos.x, eyeY, player.pos.z, b.rgtX, 0, b.rgtZ, maxReach);
      const allowed = Math.max(0, d - P.leanWallMargin) / P.leanOffset;
      if (player.leanCurrent > allowed) {
        player.leanCurrent = Math.max(allowed, player.leanCurrent - rate);
      }
    } else {
      const d = level.raycastWall(player.pos.x, eyeY, player.pos.z, -b.rgtX, 0, -b.rgtZ, maxReach);
      const allowed = Math.max(0, d - P.leanWallMargin) / P.leanOffset;
      if (-player.leanCurrent > allowed) {
        player.leanCurrent = Math.min(-allowed, player.leanCurrent + rate);
      }
    }
  }

  function leanLateralOffset() {
    return player.leanCurrent * P.leanOffset;
  }

  /** 蹲下时身体的整体高度缩放：眼睛从 1.65 降到 1.0，身体也应按比例压低 */
  function bodyHeightScale() {
    return Math.max(0.45, player.eyeHeightCurrent / P.eyeHeight);
  }

  /** 落地缓冲造成的相机下沉量（仅影响视角，不影响命中体积） */
  function landingDip() {
    return landing.dip;
  }

  function eyePosition(out) {
    const off = leanLateralOffset();
    const b = movementBasis(player.yaw);
    out.x = player.pos.x + b.rgtX * off;
    out.z = player.pos.z + b.rgtZ * off;
    out.y =
      player.pos.y +
      player.eyeHeightCurrent -
      Math.abs(player.leanCurrent) * P.leanHeadDrop -
      landingDip();
    return out;
  }

  const _eye = { x: 0, y: 0, z: 0 };
  const _zone = { x: 0, y: 0, z: 0 };
  const _dir = new THREE.Vector3();

  /**
   * 命中部位中心。**这是 M1-TEMP-18 的修复所在**：
   * 中心随探头横向偏移、随蹲下高度缩放，因此"探头"与"蹲下"真实改变被弹面积与高度。
   * AI 的开火判定使用本函数；玩家自身的受击判定也走同一条路径，不会两边不一致。
   */
  function hitZoneCenter(zone, out) {
    const g = cfg.hitZones[zone];
    const off = leanLateralOffset();
    const b = movementBasis(player.yaw);
    const hs = bodyHeightScale();
    out.x = player.pos.x + b.rgtX * off;
    out.z = player.pos.z + b.rgtZ * off;
    out.y = player.pos.y + g.centerY * hs - Math.abs(player.leanCurrent) * P.leanHeadDrop;
    return out;
  }

  function zoneRadius(zone) {
    return cfg.hitZones[zone].radius;
  }

  function viewDirection() {
    const v = viewForward(player.yaw, player.pitch);
    _dir.set(v.x, v.y, v.z);
    return _dir;
  }

  // ---- 医疗 ----
  function useConsumable(itemDef, nowMs) {
    if (!itemDef) return false;
    if (player.usingItem) return false;
    // 已达该消耗品能治到的上限时直接拒绝 —— 否则玩家会白白消耗一个绷带
    if (!canHealWith(vitals, itemDef)) return false;
    player.usingItem = itemDef;
    player.useTotalMs = itemDef.useMs;
    player.useEndAt = nowMs + itemDef.useMs;
    return true;
  }

  function cancelUse() {
    player.usingItem = null;
    player.useEndAt = 0;
    player.useTotalMs = 0;
  }

  function tickConsumable(nowMs) {
    if (!player.usingItem) return null;
    if (nowMs < player.useEndAt) return null;
    const item = player.usingItem;
    const healed = heal(vitals, item.healAmount, item.maxHealthCap);
    cancelUse();
    return { item, healed };
  }

  function takeDamage(amount) {
    // 兜底路径：只有无法确定部位时才走这里（正常 AI 射击会走 applyIncomingHit）
    vitals.health = Math.max(0, vitals.health - amount);
    player.lastDamageAt = performance.now();
    if (player.usingItem) cancelUse();
    if (vitals.health <= 0) player.alive = false;
  }

  /** AI 射击命中：完整走部位 + 护甲解算 */
  function applyIncomingHit({ weapon, ammo, zone, distanceM }) {
    const r = applyHit(vitals, { weapon, ammo, zone, distanceM, cfg });
    player.lastDamageAt = performance.now();
    if (player.usingItem) cancelUse(); // 受击打断治疗
    if (r.dead) player.alive = false;
    return r;
  }

  // ---- 移动 ----
  function update(dt, input, nowMs) {
    if (!player.alive) return;

    // 本帧起始高度 —— 用于运动探针（见竖直段末尾）
    const frameStartY = player.pos.y;
    // 本帧起始视角 —— 用于视角跳变探针
    const viewBefore = {
      yaw: player.yaw,
      pitch: player.pitch,
      lean: player.leanCurrent,
    };

    const m = input.consumeMouse();
    if (m.dx || m.dy) applyLook(m.dx, m.dy);

    player.crouching = input.crouchActive();
    player.sprinting = input.sprintActive() && !player.crouching;
    const targetSpeed = player.crouching
      ? P.crouchSpeed
      : player.sprinting
        ? P.sprintSpeed
        : P.walkSpeed;

    // ---- 期望方向 ----
    let fx = 0;
    let fz = 0;
    if (input.forward()) fz -= 1;
    if (input.back()) fz += 1;
    if (input.left()) fx -= 1;
    if (input.right()) fx += 1;
    let wishX = 0;
    let wishZ = 0;
    if (fx || fz) {
      const len = Math.hypot(fx, fz);
      fx /= len;
      fz /= len;
      const w = wishDirection(player.yaw, fx, fz);
      wishX = w.x;
      wishZ = w.z;
    }

    // ---- 水平速度：摩擦 + 加速（M1-TEMP-2 的核心改动）----
    // 顺序很重要：先摩擦再加速。反过来会让"松开按键"的那一帧仍获得加速，
    // 表现为松开后还会往前窜一下。
    if (player.onGround) {
      applyFriction(player.vel, P.friction, P.stopSpeed, dt);
      if (wishX || wishZ) {
        // 冲刺/蹲下时降低加速度：否则"最高速度不同"会因为加速度相同而几乎没有区别
        const scale = player.crouching
          ? P.crouchAccelScale
          : player.sprinting
            ? P.sprintAccelScale
            : 1;
        accelerate(player.vel, wishX, wishZ, targetSpeed, P.accel * scale, dt);
      }
    } else if (wishX || wishZ) {
      airAccelerate(player.vel, wishX, wishZ, targetSpeed, P.airAccel, P.airWishCap, dt);
    }

    // ---- 水平位移 + 碰撞 ----
    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;
    level.resolveCircle(player.pos, P.radius, player.pos.y, P.stepHeight);

    // ---- 竖直：抬升（台阶 / 跳上高台） / 站立 / 下落 ----
    //
    // ★ 这里曾经有一个导致"跳上高箱子时画面不自然卡顿"的 bug。
    //
    // 碰撞层允许"脚底位于阻挡体顶面下方 stepHeight 以内"就进入该格 ——
    // 这是必需的，否则永远跳不上 1.15m 的箱子（跳跃最高只有约 0.68m）。
    // 但进入该格后 groundY 会**突然**变成箱顶高度，而那一刻玩家是**离地**状态，
    // 于是走了"落地对齐"那条路：pos.y 从约 0.6 一步对齐到 1.15，
    // **相机单帧向上跳了近半米** —— 就是不自然卡顿的来源。
    //
    // 根因是"抬升"只在 onGround 分支里做了平滑，而跳上箱子的瞬间不在那个分支。
    // 修法：把"地面高于脚底"的处理提到 onGround 判断之前，
    // 让离地与在地面时走**同一条平滑抬升**路径 ——
    // 跳上高台与走上台阶因此共用一套逻辑，不需要分别处理。
    //
    // ★★ 顺序上有两个必须小心的地方（我在修上面这个问题时踩过）：
    //   ① 起跳只设置了 vel.y 与 onGround=false，**pos.y 当帧仍是地面高度**。
    //      如果"站在地面上"的判定不排除"有向上速度"，下一帧就会把起跳速度清零 ——
    //      表现为**跳跃完全无效**。
    //   ② 落地冲击必须在这里也结算一次。否则从低处落到台面上时，
    //      "站在地面上"分支会先接管，重力段根本没机会跑，落地缓冲就丢了。
    const wasAirborneAtFrameStart = !player.onGround;
    // 积分前的脚底高度。用于区分"落地"与"地面升到我脚下" —— 见下方说明。
    const yBeforeIntegration = player.pos.y;

    // 1) 先积分竖直速度：离地中，或刚获得向上速度（起跳的那一帧之后）
    if (!player.onGround || player.vel.y > 0) {
      player.vel.y += P.gravity * dt;
      player.pos.y += player.vel.y * dt;
    }

    const groundY = level.groundHeightAt(player.pos.x, player.pos.z);

    // ★ 判断顺序至关重要：**必须先判落地，再判抬升**。
    //
    // 我第一版把 `groundY > pos.y`（地面高于脚底）放在最前面当"抬升"，
    // 结果它把**正常落地**也吞了：玩家落到地面时脚底会略微穿过地面
    // （pos.y 约 -0.01），于是 `0 > -0.01` 成立，被当成"地面升到脚下"走了平滑抬升，
    // 于是 ①落地冲击永远不触发（落地缓冲恒为 0）②从低位落到台面也被当成爬升。
    //
    // 区分依据是"本帧是否穿过了脚下的地面"：
    //   落地   ：积分前在地面之上，积分后在地面之下 → 穿过 → 应当吸附并结算冲击
    //   抬升   ：积分前后**都**在地面之下（地面是突然出现在脚下的，例如迈台阶
    //            或跳上高台时进入了该格）→ 没有"穿过"这回事 → 应当平滑抬升
    const crossedGround =
      player.vel.y <= 0 &&
      yBeforeIntegration >= groundY - 1e-4 &&
      player.pos.y <= groundY + 1e-4;

    if (crossedGround) {
      // 2) 落地。超调量最多 |vy|·dt（165Hz 下约 0.03m），瞬间对齐不可见。
      const impactSpeed = wasAirborneAtFrameStart ? Math.max(0, -player.vel.y) : 0;
      player.pos.y = groundY;
      player.vel.y = 0;
      player.onGround = true;
      player.steppingUp = false;
      if (impactSpeed > 0) {
        applyLandingImpact(landing, impactSpeed, P.landingDipMax, P.landingDipPerSpeed);
      }
    } else if (groundY > player.pos.y + 1e-4) {
      // 3) 地面高于脚底：迈台阶，或跳跃中落到了高台的格子里。
      //    这是**平滑抬升**而不是瞬间对齐 —— 后者会造成一次近半米的单帧相机位移，
      //    也就是"跳上高箱子时画面不自然卡顿"。
      const target = stepUpTarget(player.pos.y, groundY, P.stepHeight);
      if (target !== false) {
        // 以**恒定速度**爬升，而不是指数逼近（pos.y += 差值 × k）。
        //
        // 指数逼近的每帧比例 k = dt × stepSmooth 会随帧率变化：
        // 帧率一低 k 就趋近 1，高差大时单帧位移重新变大 ——
        // 实测同一份代码：有头 165Hz 下单帧最大 0.041m，无头 122Hz 下变成 0.212m。
        // 也就是说**在配置较差的机器上卡顿会回来**，而用户的机器恰好是高刷屏，
        // 所以只有低帧率场景才会暴露。
        // 恒定速度则保证爬升耗时只与高差有关（0.55m ÷ 3.5m/s ≈ 0.16s），与帧率无关。
        const delta = target - player.pos.y;
        player.pos.y += Math.min(delta, P.stepClimbSpeed * dt);
        if (target - player.pos.y < 0.005) player.pos.y = target;
        // 抬升期间视为**受支撑**：否则重力会在爬升途中把人往下拉，
        // 抬升与下落互相拉扯，表现为抖动。
        player.vel.y = 0;
        player.onGround = true;
        player.lastStepUpAt = nowMs;
        // 计数器只在**开始**一次抬升时 +1。
        // 平滑抬升会持续多帧，若每帧都计数，"台阶吸附了 36 次"这种读数
        // 会让断言和日志都失去意义。
        if (!player.steppingUp) {
          player.steppingUp = true;
          player.stepUps++;
        }
      } else {
        // 高出可迈上限：正常不应发生（碰撞层已阻止进入该格）。
        // 兜底**不做瞬间抬高** —— 那正是要避免的行为 —— 只清掉标记，
        // 交给碰撞与重力处理。
        player.steppingUp = false;
      }
    } else if (player.pos.y <= groundY + 1e-4 && player.vel.y <= 0) {
      // 4) 停在地面上（未离地，也没有下落）
      player.pos.y = groundY;
      player.vel.y = 0;
      player.onGround = true;
      player.steppingUp = false;
    } else {
      // 5) 在空中。走到这里必然是以下两者之一：
      //      · pos.y 明显高于地面，或 · 有向上的速度
      //    两者都表示离地，直接判定为空中即可。
      player.steppingUp = false;
      player.onGround = false;
    }

    // ---- 运动探针：记录单帧脚底高度的最大变化量 ----
    // 用途：把"画面有没有跳变"变成可断言的数字。
    // 靠肉眼判断"这算不算卡顿"既不可靠也无法回归，单帧位移可以直接断言上限。
    //
    // 注意：**单帧位移本身是随帧率变化的量**（同样 3.5m/s 的爬升，165Hz 下每帧 0.021m，
    // 30Hz 下每帧 0.117m），拿固定阈值去卡它在不同机器上会误判。
    // 因此同时记录**隐含的竖直速度** Δy/Δt —— 它才与帧率无关，
    // 也是"跳变"的本质：瞬间对齐会产生一个物理上不可能的速度（几十 m/s）。
    {
      const dy = Math.abs(player.pos.y - frameStartY);
      if (dy > player.maxFrameDY) player.maxFrameDY = dy;
      const speed = dt > 1e-6 ? dy / dt : 0;
      if (speed > player.maxFrameDYSpeed) {
        player.maxFrameDYSpeed = speed;
        player.maxFrameDYSpeedAt = nowMs;
      }
      player.lastFrameDY = dy;
      player.lastFrameDYSpeed = speed;
    }

    // ---- 跳跃（缓冲 + 土狼时间）----
    // 边沿触发入队：按住不放不应连跳（那会变成自动连跳）
    if (input.pressedAction('jump')) queueJump(jumpState, nowMs);
    if (consumeJump(jumpState, player.onGround, nowMs, P.coyoteMs, P.jumpBufferMs)) {
      player.vel.y = P.jumpSpeed;
      player.onGround = false;
    }

    // ---- 落地缓冲回弹 ----
    updateLanding(landing, dt, P.landingDipRecover);

    // ---- 蹲下视高 ----
    const targetEye = player.crouching ? P.crouchEyeHeight : P.eyeHeight;
    const k = Math.min(1, dt * 12);
    player.eyeHeightCurrent += (targetEye - player.eyeHeightCurrent) * k;

    // ---- 探头 ----
    const l = input.leanLeft();
    const r = input.leanRight();
    player.leanTarget = l && r ? 0 : l ? -1 : r ? 1 : 0;
    const lk = Math.min(1, dt * P.leanSpeed);
    player.leanCurrent += (player.leanTarget - player.leanCurrent) * lk;
    if (Math.abs(player.leanCurrent) < 0.002) player.leanCurrent = 0;
    clampLeanByWall(dt);

    tickConsumable(nowMs);

    // ---- 视角跳变探针（本帧末尾结算）----
    probeView(viewBefore, m.dx, m.dy, dt);
  }

  return {
    state: player,
    vitals,
    update,
    eyePosition: () => eyePosition(_eye),
    hitZoneCenter: (zone) => hitZoneCenter(zone, _zone),
    zoneRadius,
    viewDirection,
    leanLateralOffset,
    leanRollRad: () => -player.leanCurrent * P.leanRollDeg * DEG,
    addRecoil,
    recoverRecoil,
    recoilOffsetDeg,
    /** 合成 aim + recoil 到对外视角。外部若直接改了 aim/recoil 字段，必须调用它。 */
    syncView,
    aimAngles: () => ({ yaw: player.aimYaw, pitch: player.aimPitch }),
    takeDamage,
    applyIncomingHit,
    useConsumable,
    cancelUse,
    tickConsumable,
    landingDip,
    landingState: landing,
    jumpState,
    /** 重置运动探针（测试用）：返回重置前的峰值，便于同一次会话里分段测量 */
    resetMotionProbe() {
      const peak = { maxDY: player.maxFrameDY, maxSpeed: player.maxFrameDYSpeed };
      player.maxFrameDY = 0;
      player.lastFrameDY = 0;
      player.maxFrameDYSpeed = 0;
      player.lastFrameDYSpeed = 0;
      return peak;
    },
    onGround: () => player.onGround,
    horizontalSpeed: () => Math.hypot(player.vel.x, player.vel.z),
    get maxHealth() {
      return vitals.maxHealth;
    },
    get health() {
      return vitals.health;
    },
    useProgress: (nowMs) => {
      if (!player.usingItem) return 0;
      return Math.min(1, 1 - (player.useEndAt - nowMs) / player.useTotalMs);
    },
    isUsing: () => !!player.usingItem,
  };
}
