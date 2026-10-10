// M2-1 / M2-2 武器系统：多武器、切枪、弹药类型、后坐力、扩散、开镜
//
// 与 M1 的区别：M1 是"单把武器硬编码"（见 M1-TEMP-4），本文件是按配置表驱动的武器系统。
// 但请注意本文件**没有**做的事：没有配件槽、没有弹道下坠、没有穿透、没有武器熟练度。
// 那些不在 M2 范围内。
//
// 手感实现说明（对应 M2-2）：
//   后坐力 = 固定图案 + 少量随机偏航。用固定图案而不是纯随机，原因是
//   ① 玩家可以练习压枪，② 后坐力曲线成为可写进配置表、可被 tools/ttk.mjs 读取的量化对象。
//   扩散 = 逐发累积 + 随时间恢复，腰射与开镜各有一套基础值。
//
//   后坐力恢复（M2-TEMP-1 已修复）：
//     视角拆成两笔账 —— 玩家的瞄准（player.aimYaw/aimPitch，永久）
//     与后坐力偏移（player.recoilYaw/recoilPitch，会恢复到 0）。
//     恢复**只削减后者**，所以玩家主动压的枪不会被顶回去。
//     恢复速率分两档：连发期间按 recoveryWhileFiringScale 压低，
//     停火 recoveryDelayMs 之后全额恢复。
//     修复前恢复是无条件的，与连发抬升同量级、几乎抵消 ——
//     5 把武器里有 3 把的净抬升是**负数**（持续射击时视角往下走）。
//     不变量"每把武器的连发净抬升必须为正"已加进单测。
import { weaponById, ammoById } from '../config/index.js';
import {
  applySpread,
  recoilAt,
  baseSpread,
  spreadOnShot,
  spreadAfterRecovery,
} from '../core/ballistics.js';
import { applyHit } from './vitals.js';

const DEG = Math.PI / 180;

/** 射线 vs 球，返回最近命中距离；未命中返回 -1 */
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

export function createWeaponSystem({ cfg, level, player, rng, emit }) {
  const zoneOrder = cfg.hitZoneNames; // ['head','chest','stomach','limb']

  // ---- 装备与弹药 ----
  const loadout = [cfg.startLoadout.primary, cfg.startLoadout.secondary];
  const reserve = { ...cfg.startLoadout.reserveByAmmo };

  const states = loadout.map((id) => {
    const def = weaponById(id);
    return {
      id,
      def,
      ammo: ammoById(def.ammoType),
      magazine: def.magazineSize,
      cooldownUntil: 0,
      reloading: false,
      reloadEndAt: 0,
      reloadWasTactical: false,
      spread: def.hipSpreadDeg,
    };
  });

  let activeIndex = 0;
  let adsT = 0;               // 0=腰射 1=完全开镜
  // 后坐力偏移**不再由本模块持有** —— 它归 player 的 recoilYaw/recoilPitch 管，
  // 这样"玩家瞄的"与"后坐力的"是两笔账，恢复不会去动玩家的瞄准（M2-TEMP-1）。
  // 这里只记录**最近一次开火时间**，用于决定恢复走哪一档。
  let lastShotAt = -1e9;

  const active = () => states[activeIndex];

  const stats = {
    shotsFired: 0,
    hits: 0,
    headshots: 0,
    kills: 0,
    damageDealtTotal: 0,
    reloads: 0,
    swaps: 0,
  };

  function reserveOf(ammoType) {
    return reserve[ammoType] || 0;
  }

  function swapTo(index) {
    if (index === activeIndex || index < 0 || index >= states.length) return false;
    const cur = active();
    if (cur.reloading) {
      cur.reloading = false; // 切枪打断换弹（M2 的简化处理，不退还已装填的子弹）
    }
    cur.spread = baseSpread(cur.def, adsT > 0.5);
    activeIndex = index;
    adsT = 0; // 切枪后退镜
    stats.swaps++;
    emit({ type: 'swap', weapon: active().def });
    return true;
  }

  function cycleWeapon(dir) {
    if (states.length < 2) return;
    swapTo((activeIndex + (dir > 0 ? 1 : states.length - 1)) % states.length);
  }

  function startReload(nowMs) {
    const s = active();
    if (s.reloading) return false;
    if (s.magazine >= s.def.magazineSize) return false;
    if (reserveOf(s.def.ammoType) <= 0) {
      emit({ type: 'empty', weapon: s.def, reason: 'no-reserve' });
      return false;
    }
    // 弹匣未打空走战术换弹（更快），打空走空仓换弹
    const tactical = s.magazine > 0;
    s.reloading = true;
    s.reloadWasTactical = tactical;
    s.reloadEndAt = nowMs + (tactical ? s.def.reloadTacticalMs : s.def.reloadMs);
    emit({ type: 'reloadStart', weapon: s.def, tactical });
    return true;
  }

  function finishReload() {
    const s = active();
    const need = s.def.magazineSize - s.magazine;
    const avail = reserveOf(s.def.ammoType);
    const take = Math.min(need, avail);
    s.magazine += take;
    reserve[s.def.ammoType] = avail - take;
    s.reloading = false;
    stats.reloads++;
    emit({ type: 'reloadEnd', weapon: s.def, loaded: take });
  }

  /**
   * 解算一条弹丸。
   * 命中优先级：取所有候选里最近的一个；距离相同时按 zoneOrder 取靠前的部位
   * （这样头部优先于躯干，符合直觉且规则确定，不依赖遍历顺序的偶然性）。
   */
  function resolvePellet(ox, oy, oz, dir, wdef, ammo, targets, maxRange) {
    const wallT = level.raycastWall(ox, oy, oz, dir.x, dir.y, dir.z, maxRange);
    const groundT = level.raycastGround(oy, dir.y);
    let best = Math.min(wallT, groundT, maxRange);
    let kind = wallT <= groundT ? 'wall' : 'ground';
    let bestTarget = null;
    let bestZone = null;

    for (const t of targets) {
      if (!t.vitals || t.vitals.health <= 0) continue;
      const p = t.position;
      for (const zone of zoneOrder) {
        const g = cfg.hitZones[zone];
        const hitT = raySphere(ox, oy, oz, dir.x, dir.y, dir.z, p.x, p.y + g.centerY, p.z, g.radius);
        if (hitT < 0) continue;
        // 严格更近才替换 —— 因此同距离时保留先遍历到的（zoneOrder 在前的部位）
        if (hitT < best) {
          best = hitT;
          kind = 'combatant';
          bestTarget = t;
          bestZone = zone;
        }
      }
    }

    const point = { x: ox + dir.x * best, y: oy + dir.y * best, z: oz + dir.z * best };
    if (kind === 'combatant') {
      // 由目标自己解算并处理死亡（见 ai.js applyHitFrom 的说明）：
      // 若在这里直接改 vitals，被击杀的 AI 不会立刻清理，会出现"打死了还站着"。
      // 传入**开火者位置**：AI 挨打后据此知道该往哪还手。
      // 不传的话它只会切个 ALERT、没有最后已知位置，随即掉回巡逻乱跑 ——
      // 这就是"被玩家攻击后不会靠近还击"的直接原因。
      const res = bestTarget.applyHitFrom(wdef, ammo, bestZone, best, ox, oz, oy);
      if (!res) return { kind: 'wall', point, distance: best };
      stats.hits++;
      if (bestZone === 'head') stats.headshots++;
      stats.damageDealtTotal += res.damage;
      return { kind, point, distance: best, zone: bestZone, target: bestTarget, damage: res };
    }
    return { kind, point, distance: best };
  }

  function fire(nowMs, targets) {
    const s = active();
    const wdef = s.def;
    if (s.reloading) return false;
    if (nowMs < s.cooldownUntil) return false;
    if (s.magazine <= 0) {
      emit({ type: 'empty', weapon: wdef, reason: 'magazine' });
      return false;
    }

    s.magazine--;
    s.cooldownUntil = nowMs + wdef.fireIntervalMs;
    stats.shotsFired++;

    // ---- 后坐力：加到 player 的临时偏移上（不污染玩家的瞄准）----
    const rc = recoilAt(wdef, Math.max(0, wdef.magazineSize - s.magazine - 1), adsT > 0.5, rng);
    player.addRecoil(rc.yawDeg * DEG, rc.pitchDeg * DEG);
    lastShotAt = nowMs;

    // ---- 扩散：开火后扩大 ----
    const moving = Math.hypot(player.state.vel.x, player.state.vel.z) > 0.6;
    const spreadForShot = s.spread;
    s.spread = spreadOnShot(wdef, s.spread, adsT > 0.5, moving);

    // ---- 逐弹丸解算 ----
    const eye = player.eyePosition();
    const base = player.viewDirection();
    const baseDir = { x: base.x, y: base.y, z: base.z };
    const pellets = Math.max(1, wdef.pellets || 1);
    const results = [];
    for (let i = 0; i < pellets; i++) {
      const d = applySpread(baseDir, spreadForShot, rng);
      const r = resolvePellet(eye.x, eye.y, eye.z, d, wdef, s.ammo, targets, wdef.range);
      results.push(r);
      if (r.kind === 'combatant') {
        emit({
          type: 'hit',
          weapon: wdef,
          zone: r.zone,
          damage: r.damage.damage,
          point: r.point,
          target: r.target,
          killed: r.damage.dead,
          distance: r.distance,
        });
        if (r.damage.dead) stats.kills++;
      } else {
        emit({ type: 'impact', kind: r.kind, point: r.point, weapon: wdef });
      }
    }

    emit({ type: 'fire', weapon: wdef, magazine: s.magazine });
    return true;
  }

  function update(dt, nowMs, input, targets) {
    const s = active();

    // ---- 开镜 ----
    const wantAds = input.ads() && !s.reloading;
    const adsRate = 1000 / s.def.adsMs;
    adsT = wantAds
      ? Math.min(1, adsT + (dt * adsRate))
      : Math.max(0, adsT - (dt * adsRate * 1.25)); // 退镜略快于开镜

    // ---- 扩散恢复 ----
    s.spread = spreadAfterRecovery(s.def, s.spread, dt, adsT > 0.5);

    // ---- 后坐力恢复（M2-TEMP-1 的核心改动）----
    //
    // 原实现是"无条件把视角拉回"，每帧都按 recoveryPerSec 全额恢复。
    // 而连发抬升速率与恢复速率同量级，于是两者几乎抵消 ——
    // 实测修复前 5 把武器里有 3 把的**净抬升是负数**（持续射击时视角往下走），
    // 后坐力图案完全失去意义。
    //
    // 现在分两档：
    //   · 距上次开火 recoveryDelayMs 以内 → 只按 recoveryWhileFiringScale 生效
    //     （留一点自恢复，避免长弹匣时后坐力无限累积到无法控制）
    //   · 超过该时间（已停火）→ 全额恢复，视角平滑回到玩家瞄的位置
    // 恢复只作用于 player 的 recoil 偏移，**不碰玩家的瞄准** ——
    // 所以玩家主动压的枪不会被恢复顶回去。
    const justFired = nowMs - lastShotAt <= (s.def.recoil.recoveryDelayMs ?? 0);
    const recoverRate =
      s.def.recoil.recoveryPerSec *
      (justFired ? (s.def.recoil.recoveryWhileFiringScale ?? 1) : 1);
    player.recoverRecoil(recoverRate, dt);

    // ---- 切枪（边沿：轻点也要生效）----
    if (input.pressedAction('slotPrimary')) swapTo(0);
    if (input.pressedAction('slotSecondary')) swapTo(1);
    const wheel = input.consumeWheel();
    if (wheel) cycleWeapon(wheel);

    // ---- 换弹（边沿：轻点 R 也要生效）----
    if (input.pressedAction('reload')) startReload(nowMs);
    if (s.reloading && nowMs >= s.reloadEndAt) finishReload();

    // ---- 开火 ----
    // 边沿必须**每帧无条件消费**：若只在半自动分支里读，全自动模式下这个边沿会一直挂着，
    // 等玩家切到半自动武器时会立刻凭空打出一发（"切枪自动开火"）。
    const fireEdge = input.consumeFirePressed();
    const wantFire = s.def.fireMode === 'auto' ? input.state.fireHeld : fireEdge;
    if (wantFire) fire(nowMs, targets);

    return stats;
  }

  return {
    update,
    stats,
    states,
    statsSnapshot: () => ({ ...stats, activeWeapon: active().def.id }),
    get activeIndex() {
      return activeIndex;
    },
    active: () => {
      const s = active();
      return {
        def: s.def,
        magazine: s.magazine,
        reserve: reserveOf(s.def.ammoType),
        reloading: s.reloading,
        reloadWasTactical: s.reloadWasTactical,
        spread: s.spread,
      };
    },
    adsT: () => adsT,
    /** 当前应有的相机 FOV（由 main 应用到相机） */
    fovDeg: (hipFov) => hipFov + (active().def.adsFovDeg - hipFov) * adsT,
    reloadProgress: (nowMs) => {
      const s = active();
      if (!s.reloading) return 0;
      const total = s.reloadWasTactical ? s.def.reloadTacticalMs : s.def.reloadMs;
      return Math.min(1, 1 - (s.reloadEndAt - nowMs) / total);
    },
    reserveOf,
    swapTo,
  };
}
