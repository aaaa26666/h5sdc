// M2-6 / M2-7 AI：完整状态机 + 寻路 + 难度分级
//
// 约束遵守情况（这些不是可选项）：
//   C-1/C-2 所有寻路查询经 pathScheduler 排队，每帧限量限时。M0-5 实测过：
//           若允许 N 个 AI 同时无限制发起 A*，6x 节流下单帧可达 68ms，造成 1~4 帧冻结。
//   M2 硬性要求：更新频率必须分级（远处 AI 降频）。
//
// M1 的三个临时实现在此重写：
//   M1-TEMP-6  无寻路       → 走 A* + 路点跟随
//   M1-TEMP-7  感知无记忆   → lastKnownPos + SEARCH 状态 + 记忆超时 + 听觉
//   M1-TEMP-8  无受击/死亡表现 → 补了受击闪白与死亡移除（动画仍属美术范畴，不在 M2）
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';
import { pickUpdateTier } from '../core/navgrid.js';
import { createVitals, applyHit } from './vitals.js';

const DEG = Math.PI / 180;

export const AI_STATE = Object.freeze({
  PATROL: 'patrol',
  ALERT: 'alert',
  COMBAT: 'combat',
  SEARCH: 'search',
  RETREAT: 'retreat',
  DEAD: 'dead',
});

/**
 * AI 射击使用的「伪武器」。
 *
 * 为什么必须造这个东西，而不是直接扣血：
 *   M2-4 要求护甲与部位伤害生效。如果 AI 打玩家走的是"直接减 damagePerShot"，
 *   那么玩家身上的护甲、头盔、部位倍率**全部对 AI 无效** ——
 *   表现为"穿了三级甲还是掉一样多血"，而这正是 M2-4 的核心功能。
 *   造一个伪武器走同一条 resolveHit 路径，是保证双方伤害模型不分叉的唯一手段。
 */
function tierWeapon(tier) {
  const d = tier.damagePerShot;
  return {
    id: `ai_${tier.id}`,
    label: tier.label,
    class: 'ai',
    ammoType: `ai_${tier.id}`,
    fireMode: 'auto',
    fireIntervalMs: tier.fireIntervalMs,
    magazineSize: 999,
    reloadMs: 1,
    reloadTacticalMs: 1,
    adsMs: 1,
    adsFovDeg: 60,
    hipSpreadDeg: 0,
    adsSpreadDeg: 0,
    spreadPerShotDeg: 0,
    maxSpreadDeg: 0,
    spreadRecoveryPerSec: 1,
    moveSpreadScale: 1,
    recoil: { pattern: [[0, 0]], recoveryPerSec: 1, adsScale: 1, randomYawDeg: 0 },
    damage: {
      head: d * 1.9,
      chest: d,
      stomach: d * 0.9,
      limb: d * 0.75,
    },
    falloff: { startM: tier.fireRange, endM: tier.fireRange * 2, minScale: 0.6 },
    range: tier.fireRange,
    pellets: 1,
    adsMoveSpeedScale: 1,
  };
}

export function createAi({ cfg, level, scene, spawnCell, index, tier, scheduler, rngSeed }) {
  const rnd = mulberry32(rngSeed);
  const spawn = level.cellToWorld(spawnCell[0], spawnCell[1]);
  const pseudoWeapon = tierWeapon(tier);
  const pseudoAmmo = { id: pseudoWeapon.ammoType, damageScale: 1, armorPenetration: tier.armorPen ?? 2 };

  const zoneOrder = cfg.hitZoneNames;

  const ai = {
    id: `ai_${index}`,
    tier,
    position: { x: spawn.x, y: 0, z: spawn.z },
    yaw: rnd() * Math.PI * 2,
    vitals: createVitals({ maxHealth: tier.maxHealth, armorBySlot: tier.armor, cfg }),
    state: AI_STATE.PATROL,
    stateEnteredAt: 0,
    lastKnownPos: null,
    lastSeenAt: -1e9,
    lastHearAt: -1e9,
    nextThinkAt: 0,
    nextFireAt: 0,
    burstLeft: tier.burstShots,
    path: [],
    pathIdx: 0,
    pendingGoalCell: null,
    updateTier: null,
    lastUpdateAt: 0,
    updates: 0,
    shotsFired: 0,
    damageDealt: 0,
  };

  const geo = new THREE.BoxGeometry(0.9, 1.8, 0.9);
  const matBase = new THREE.MeshLambertMaterial({ color: parseInt(tier.color, 16) });
  const matAlert = new THREE.MeshLambertMaterial({ color: 0xd4553f });
  const matHit = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geo, matBase);
  mesh.castShadow = true;
  scene.add(mesh);

  let hitFlashUntil = 0;
  let dead = false;

  function cellOf(x, z) {
    const cx = Math.min(level.W - 1, Math.max(0, Math.floor(x / level.cell)));
    const cz = Math.min(level.H - 1, Math.max(0, Math.floor(z / level.cell)));
    return cz * level.W + cx;
  }

  function requestPath(targetCell) {
    if (ai.pendingGoalCell === targetCell) return;
    ai.pendingGoalCell = targetCell;
    scheduler.request(ai.id, cellOf(ai.position.x, ai.position.z), targetCell);
  }

  function setState(next, nowMs) {
    if (ai.state === next) return;
    ai.state = next;
    ai.stateEnteredAt = nowMs;
    if (next === AI_STATE.PATROL) {
      ai.lastKnownPos = null;
    }
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    matBase.dispose();
    matAlert.dispose();
    matHit.dispose();
  }

  function die() {
    if (dead) return;
    dead = true;
    ai.state = AI_STATE.DEAD;
    dispose();
  }

  function moveToward(tx, tz, moveDt, speedScale) {
    const dx = tx - ai.position.x;
    const dz = tz - ai.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return dist;
    const speed = tier.moveSpeed * speedScale;
    const stepLen = Math.min(dist, speed * moveDt);
    ai.yaw = Math.atan2(-dx, -dz);
    ai.position.x += (dx / dist) * stepLen;
    ai.position.z += (dz / dist) * stepLen;
    // AI 与玩家使用同一个 stepHeight：
    // 低掩体（climbable）不阻挡，AI 直接走上去；高掩体阻挡，且已在寻路网格里被排除，
    // 所以 AI 不会穿模、也不会卡在掩体前。若两边用不同数值，就会出现
    // "玩家能过 AI 不能过"或"AI 穿过掩体"的不一致。
    level.resolveCircle(ai.position, 0.45, ai.position.y, level.stepHeight);
    // 贴地：AI 站到该格的地面高度上（地面 0 / 低掩体顶面）
    ai.position.y = level.groundHeightAt(ai.position.x, ai.position.z);
    return dist;
  }

  function followPath(moveDt) {
    if (ai.pathIdx >= ai.path.length) return false;
    const cell = ai.path[ai.pathIdx];
    const cx = cell % level.W;
    const cz = (cell / level.W) | 0;
    const tx = (cx + 0.5) * level.cell;
    const tz = (cz + 0.5) * level.cell;
    const remaining = moveToward(tx, tz, moveDt, 1);
    if (remaining < 0.35) {
      ai.pathIdx++;
    }
    return ai.pathIdx < ai.path.length;
  }

  function canSee(player) {
    const eye = player.eyePosition();
    const dx = eye.x - ai.position.x;
    const dz = eye.z - ai.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > tier.viewRange) return false;
    if (ai.state === AI_STATE.PATROL || ai.state === AI_STATE.SEARCH) {
      const facingX = -Math.sin(ai.yaw);
      const facingZ = -Math.cos(ai.yaw);
      const cos = (dx * facingX + dz * facingZ) / Math.max(1e-6, dist);
      if (cos < Math.cos((tier.viewAngleDeg * DEG) / 2)) return false;
    }
    return level.hasLineOfSight(
      ai.position.x,
      ai.position.y + cfg.hitZones.head.centerY,
      ai.position.z,
      eye.x,
      eye.y,
      eye.z
    );
  }

  function think(nowMs, player, ctx, seen, distToPlayer) {
    const healthRatio = ai.vitals.health / ai.vitals.maxHealth;

    if (
      healthRatio <= tier.retreatHealthRatio &&
      ai.state !== AI_STATE.RETREAT &&
      ai.state !== AI_STATE.DEAD
    ) {
      setState(AI_STATE.RETREAT, nowMs);
    }

    switch (ai.state) {
      case AI_STATE.PATROL: {
        if (seen) {
          setState(AI_STATE.ALERT, nowMs);
          break;
        }
        if (nowMs - ai.lastHearAt < 1500) {
          setState(AI_STATE.ALERT, nowMs);
          break;
        }
        if (ai.pathIdx >= ai.path.length) {
          requestPath(level.free[Math.floor(rnd() * level.free.length)]);
        }
        break;
      }
      case AI_STATE.ALERT: {
        if (nowMs - ai.stateEnteredAt >= (ctx.reactScale || 1) * tier.reactMs) {
          setState(seen ? AI_STATE.COMBAT : AI_STATE.SEARCH, nowMs);
        }
        break;
      }
      case AI_STATE.COMBAT: {
        if (!seen && nowMs - ai.lastSeenAt > 1200) {
          setState(AI_STATE.SEARCH, nowMs);
          break;
        }
        if (seen) {
          const eye = player.eyePosition();
          if (distToPlayer > cfg.aiCombat.preferredRangeM + 3) {
            requestPath(cellOf(eye.x, eye.z));
          } else if (distToPlayer < cfg.aiCombat.minRangeM) {
            const bx = ai.position.x - (eye.x - ai.position.x);
            const bz = ai.position.z - (eye.z - ai.position.z);
            requestPath(cellOf(bx, bz));
          }
        }
        break;
      }
      case AI_STATE.SEARCH: {
        if (seen) {
          setState(AI_STATE.COMBAT, nowMs);
          break;
        }
        const expired = nowMs - ai.stateEnteredAt > tier.searchDurationMs;
        const memoryGone = nowMs - ai.lastSeenAt > cfg.aiPerception.memoryMs;
        if (expired || memoryGone) {
          setState(AI_STATE.PATROL, nowMs);
          break;
        }
        if (ai.lastKnownPos) {
          const d = Math.hypot(ai.lastKnownPos.x - ai.position.x, ai.lastKnownPos.z - ai.position.z);
          if (d < 1.5) ai.lastKnownPos = null;
          else requestPath(cellOf(ai.lastKnownPos.x, ai.lastKnownPos.z));
        }
        break;
      }
      case AI_STATE.RETREAT: {
        const dx = ai.position.x - player.state.pos.x;
        const dz = ai.position.z - player.state.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        requestPath(
          cellOf(
            ai.position.x + (dx / len) * cfg.aiCombat.retreatDistanceM,
            ai.position.z + (dz / len) * cfg.aiCombat.retreatDistanceM
          )
        );
        if (healthRatio > tier.retreatHealthRatio * 1.6 && nowMs - ai.stateEnteredAt > 4000) {
          setState(AI_STATE.COMBAT, nowMs);
        }
        break;
      }
      default:
        break;
    }
  }

  /** 射击：命中部位用与武器完全相同的球体定义，因此头盔/护甲对 AI 同样生效 */
  function tryShoot(nowMs, player, ctx) {
    if (ai.state !== AI_STATE.COMBAT) return;
    if (nowMs < ai.nextFireAt) return;

    const eye = player.eyePosition();
    const ox = ai.position.x;
    const oy = ai.position.y + cfg.hitZones.head.centerY;
    const oz = ai.position.z;
    let dx = eye.x - ox;
    let dy = eye.y - oy;
    let dz = eye.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > tier.fireRange) return;
    dx /= dist; dy /= dist; dz /= dist;

    const accuracy = tier.accuracyDeg * (ctx.accuracyScale || 1);
    const rad = accuracy * DEG;
    if (rad > 0) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * Math.tan(rad);
      const upx = Math.abs(dy) > 0.99 ? 1 : 0;
      const upy = Math.abs(dy) > 0.99 ? 0 : 1;
      let rx = -dz * upy;
      const rz = dx * upy - -dy * upx;
      let ry = 0;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl;
      const rz2 = rz / rl;
      const ux = ry * dz - rz2 * dy;
      const uy = rz2 * dx - rx * dz;
      const uz = rx * dy - ry * dx;
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      const nx = dx + rx * ca + ux * sa;
      const ny = dy + ry * ca + uy * sa;
      const nz = dz + rz2 * ca + uz * sa;
      const nl = Math.hypot(nx, ny, nz) || 1;
      dx = nx / nl; dy = ny / nl; dz = nz / nl;
    }

    ai.shotsFired++;
    ai.nextFireAt = nowMs + tier.fireIntervalMs;
    ai.burstLeft--;
    if (ai.burstLeft <= 0) {
      ai.burstLeft = tier.burstShots;
      ai.nextFireAt = nowMs + tier.burstPauseMs;
    }

    const wallT = level.raycastWall(ox, oy, oz, dx, dy, dz, tier.fireRange);

    // 逐部位求交，取最近；同距离时按 zoneOrder 优先（头部在前）
    let best = wallT;
    let zone = null;
    for (const z of zoneOrder) {
      const g = cfg.hitZones[z];
      const t = raySphere(
        ox, oy, oz, dx, dy, dz,
        player.state.pos.x, player.state.pos.y + g.centerY, player.state.pos.z, g.radius
      );
      if (t >= 0 && t < best) {
        best = t;
        zone = z;
      }
    }

    if (zone) {
      ctx.onPlayerHit({
        weapon: pseudoWeapon,
        ammo: pseudoAmmo,
        zone,
        distanceM: best,
        point: { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best },
        fromAi: ai.id,
        tierId: tier.id,
      });
      ai.damageDealt += tier.damagePerShot;
    }
  }

  function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
    const ex = cx - ox;
    const ey = cy - oy;
    const ez = cz - oz;
    const tca = ex * dx + ey * dy + ez * dz;
    if (tca < 0) return -1;
    const d2 = ex * ex + ey * ey + ez * ez - tca * tca;
    const r2 = r * r;
    if (d2 > r2) return -1;
    const thc = Math.sqrt(r2 - d2);
    const t = tca - thc;
    return t >= 0 ? t : tca + thc;
  }

  return {
    id: ai.id,
    state: ai,
    get tier() {
      return tier;
    },
    get position() {
      return ai.position;
    },
    get vitals() {
      return ai.vitals;
    },
    get isDead() {
      return dead;
    },
    /**
     * 当前更新分级。**必须对外可读**：M2 的硬性要求是"更新频率必须支持分级"，
     * 如果分级只存在于内部而外部观测不到，就无法断言它真的生效。
     * 这个 getter 在重写时被漏掉过一次，正是被"每个 AI 都有更新分级"的断言抓出来的。
     */
    get updateTier() {
      return ai.updateTier;
    },
    get mesh() {
      return mesh;
    },

    hearGunshot(nowMs, x, z) {
      if (dead) return;
      const d = Math.hypot(x - ai.position.x, z - ai.position.z);
      if (d > cfg.aiPerception.hearingGunshotRangeM) return;
      ai.lastHearAt = nowMs;
      if (!ai.lastKnownPos) ai.lastKnownPos = { x, z };
    },

    /**
     * 由武器调用。AI **自己**处理死亡，而不是让武器去猜 ——
     * 否则被击杀的 AI 会留在场上（其 update 要等下一次才可能发现血量归零，
     * 对远处低频 AI 可能延迟 400ms，表现为"打死了还站着"）。
     */
    applyHitFrom(weapon, ammo, zone, distanceM) {
      if (dead) return null;
      const r = applyHit(ai.vitals, { weapon, ammo, zone, distanceM, cfg });
      hitFlashUntil = performance.now() + 90;
      if (r.dead) die();
      else if (ai.state === AI_STATE.PATROL || ai.state === AI_STATE.SEARCH) {
        setState(AI_STATE.ALERT, performance.now());
      }
      return r;
    },

    update(dt, nowMs, player, ctx) {
      if (dead) return { ran: false, dead: true, tier: ai.updateTier, distToPlayer: Infinity };

      const distToPlayer = Math.hypot(
        player.state.pos.x - ai.position.x,
        player.state.pos.z - ai.position.z
      );
      const tierCfg = pickUpdateTier(cfg.aiUpdateTiers, distToPlayer);
      ai.updateTier = tierCfg;

      if (nowMs < ai.nextThinkAt) {
        return { ran: false, dead: false, tier: tierCfg, distToPlayer };
      }

      // 位移必须按「距上次更新经过的真实时间」推进。
      // 若低频 AI 也只用 dt，则 400ms 更新一次的 AI 每帧只走 16ms 的距离 ——
      // 速度会慢 25 倍，表现为"远处的敌人几乎不动"。
      const elapsedSec = ai.lastUpdateAt ? Math.min(0.6, (nowMs - ai.lastUpdateAt) / 1000) : dt;
      ai.lastUpdateAt = nowMs;
      ai.nextThinkAt = nowMs + tierCfg.intervalMs;
      ai.updates++;

      const seen = canSee(player);
      if (seen) {
        ai.lastSeenAt = nowMs;
        ai.lastKnownPos = { x: player.state.pos.x, z: player.state.pos.z };
      }

      think(nowMs, player, ctx, seen, distToPlayer);
      tryShoot(nowMs, player, ctx);

      if (ai.pathIdx < ai.path.length) {
        followPath(elapsedSec);
      } else if (ai.state === AI_STATE.COMBAT && seen) {
        const eye = player.eyePosition();
        moveToward(eye.x, eye.z, elapsedSec, cfg.aiCombat.strafeSpeedScale);
      }

      const r = scheduler.takeResult(ai.id);
      if (r) {
        ai.path = Array.from(r.buf);
        ai.pathIdx = 0;
        ai.pendingGoalCell = null;
      }

      mesh.position.set(ai.position.x, ai.position.y + 0.9, ai.position.z);
      mesh.rotation.y = ai.yaw;
      mesh.material = nowMs < hitFlashUntil ? matHit : ai.state === AI_STATE.PATROL ? matBase : matAlert;

      return { ran: true, dead: false, tier: tierCfg, distToPlayer, seen };
    },
  };
}
