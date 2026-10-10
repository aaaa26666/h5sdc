// M2 玩家：移动 + 护甲 + 医疗 + 探头命中体积
//
// M1 遗留项在本文件中的处理：
//   M1-TEMP-18（探头只动相机、不改变可命中体积 → 探头没有战术价值）已修复：
//     新增 hitZoneCenter()，把命中部位的中心按**探头偏移与蹲下高度**一起算出来。
//     AI 射击与玩家自身体积判定都走这个函数，因此探头出去真的会改变被弹面积，
//     蹲下也真的会降低被弹高度 —— 这两个动作至此才有决策价值。
//   M1-TEMP-2（移动无加速度/摩擦）与 M1-TEMP-3（无台阶）**仍在**，属 M2 主题但
//     本轮先保证系统正确性；见 docs/M2-TEMP-REGISTRY.md。
import * as THREE from 'three';
import { movementBasis, wishDirection, viewForward } from '../core/direction.js';
import { createVitals, applyHit, heal, canHealWith } from './vitals.js';

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
  };

  const wish = new THREE.Vector3();

  function applyLook(dx, dy) {
    player.yaw -= dx * P.mouseSensitivity;
    player.pitch -= dy * P.mouseSensitivity;
    const lim = P.pitchLimitDeg * DEG;
    player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
  }

  /** 由武器调用：后坐力直接作用于视角 */
  function addRecoil(yawRad, pitchRad) {
    player.yaw += yawRad;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch + pitchRad));
  }

  function clampLeanByWall() {
    if (player.leanCurrent === 0) return;
    const eyeY = player.pos.y + player.eyeHeightCurrent;
    const b = movementBasis(player.yaw);
    const maxReach = P.leanOffset + P.leanWallMargin;
    if (player.leanCurrent > 0) {
      const d = level.raycastWall(player.pos.x, eyeY, player.pos.z, b.rgtX, 0, b.rgtZ, maxReach);
      const allowed = Math.max(0, d - P.leanWallMargin) / P.leanOffset;
      if (player.leanCurrent > allowed) player.leanCurrent = allowed;
    } else {
      const d = level.raycastWall(player.pos.x, eyeY, player.pos.z, -b.rgtX, 0, -b.rgtZ, maxReach);
      const allowed = Math.max(0, d - P.leanWallMargin) / P.leanOffset;
      if (-player.leanCurrent > allowed) player.leanCurrent = -allowed;
    }
  }

  function leanLateralOffset() {
    return player.leanCurrent * P.leanOffset;
  }

  /** 蹲下时身体的整体高度缩放：眼睛从 1.65 降到 1.0，身体也应按比例压低 */
  function bodyHeightScale() {
    return Math.max(0.45, player.eyeHeightCurrent / P.eyeHeight);
  }

  function eyePosition(out) {
    const off = leanLateralOffset();
    const b = movementBasis(player.yaw);
    out.x = player.pos.x + b.rgtX * off;
    out.z = player.pos.z + b.rgtZ * off;
    out.y =
      player.pos.y +
      player.eyeHeightCurrent -
      Math.abs(player.leanCurrent) * P.leanHeadDrop;
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

  function update(dt, input, nowMs) {
    if (!player.alive) return;

    const m = input.consumeMouse();
    if (m.dx || m.dy) applyLook(m.dx, m.dy);

    player.crouching = input.crouchActive();
    player.sprinting = input.sprintActive() && !player.crouching;
    // 开镜时移动速度下降（由武器侧提供倍率，这里用一个保守常量）
    const speed = player.crouching ? P.crouchSpeed : player.sprinting ? P.sprintSpeed : P.walkSpeed;

    let fx = 0;
    let fz = 0;
    if (input.forward()) fz -= 1;
    if (input.back()) fz += 1;
    if (input.left()) fx -= 1;
    if (input.right()) fx += 1;

    if (fx || fz) {
      const len = Math.hypot(fx, fz);
      fx /= len;
      fz /= len;
      const w = wishDirection(player.yaw, fx, fz);
      player.vel.x = w.x * speed;
      player.vel.z = w.z * speed;
    } else {
      player.vel.x = 0;
      player.vel.z = 0;
    }
    void wish;

    player.vel.y += P.gravity * dt;
    if (input.jump() && player.onGround) {
      player.vel.y = P.jumpSpeed;
      player.onGround = false;
    }

    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;
    level.resolveCircle(player.pos, P.radius);

    player.pos.y += player.vel.y * dt;
    if (player.pos.y <= 0) {
      player.pos.y = 0;
      player.vel.y = 0;
      player.onGround = true;
    }

    const targetEye = player.crouching ? P.crouchEyeHeight : P.eyeHeight;
    const k = Math.min(1, dt * 12);
    player.eyeHeightCurrent += (targetEye - player.eyeHeightCurrent) * k;

    const l = input.leanLeft();
    const r = input.leanRight();
    player.leanTarget = l && r ? 0 : l ? -1 : r ? 1 : 0;
    const lk = Math.min(1, dt * P.leanSpeed);
    player.leanCurrent += (player.leanTarget - player.leanCurrent) * lk;
    if (Math.abs(player.leanCurrent) < 0.002) player.leanCurrent = 0;
    clampLeanByWall();

    tickConsumable(nowMs);
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
    takeDamage,
    applyIncomingHit,
    useConsumable,
    cancelUse,
    tickConsumable,
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
