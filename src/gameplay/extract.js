// M1-6 撤离点 / M4-1 撤离点开放规则
//
// 职责：撤离区判定、开放规则求值（常驻/条件/时间窗）、停留倒计时、完成触发。
//
// 规则判定本身在 `src/core/extractRules.js`（纯函数，不依赖 three.js）。
// 本文件只负责把求值结果应用到"能不能进"与"倒计时算不算数"上 ——
// 《流程文档》3.3 要求逻辑层不得依赖渲染层，而这里要建环与光柱，
// 所以把可测的那部分拆出去单独放。
//
// 已销账：
//   [M1-TEMP-12] 撤离点全部为常驻点，无时间窗、无条件校验。
//                M4-1 已接入三类规则（always / timeAfter / timeWindow），
//                规则与数值全部来自地图表的 `extracts[].openRule`。
//
// 已销账：
//   [M1-TEMP-13] 倒计时期间不校验"是否仍在区内"以外的任何条件。
//                M4-2 已定死规则并写入配置：中断源**只有**"离开撤离区"一种，
//                离开超过 leaveGraceMs 宽限才中断，中断后按 keepFraction 处理（当前 0 = 清零）。
//                受击 / 开火 / 使用道具**不**中断 —— 这是明确裁定，
//                由 unit-tests 里那条「受击与开火不会中断」的断言钉住，防止日后被当成遗漏补上。
import * as THREE from 'three';
import { evaluateOpenRule } from '../core/extractRules.js';

// 未开放的撤离点用灰环表示。
// 为什么要改外观：不做区分的话，玩家站在条件点上按满了倒计时却毫无反应，
// 会当成 bug。这不是美化，是让规则**可见**。
//
// [M4-TEMP-1] 表现只有"环变灰"这一层，没有"还需 XX 秒开放"的空间内文字、
// 图标或提示音。完整的提示属 M4-6 的 HUD 完整化；目前玩家只能在屏幕下方的
// prompt 里看到一行文字。
const COLOR_OPEN = 0x4fd48a;
const COLOR_LOCKED = 0x6b7078;

export function createExtract(cfg, level, scene) {
  const E = cfg.extract;
  // M4-2 中断规则。数值与开关全部来自配置表（tunables.extract.interrupt），
  // 这里不做缺省兜底 —— 配置缺失应在启动期被拦下，而不是悄悄退化成"永不中断"。
  const INT = E.interrupt;
  const graceMs = INT.leaveGraceMs;
  const keepFraction = INT.keepFraction;

  const zones = E.zones.map((z, idx) => {
    const floor = z.floor || 0;
    const w = level.cellToWorld(z.cell[0], z.cell[1]);
    // 环与光柱要画在撤离点**所在的那一层**。
    // 此前 y 写死（0.03 / 3），tv_station_01 的 e2_roof（二层，3.6m）会把绿环画在一层地面上。
    const baseY = level.floorBaseY(floor);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(z.radius - 0.35, z.radius, 40),
      new THREE.MeshBasicMaterial({ color: COLOR_OPEN, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(w.x, baseY + 0.03, w.z);
    scene.add(ring);

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(z.radius - 0.4, z.radius - 0.4, 6, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: COLOR_OPEN, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    pillar.position.set(w.x, baseY + 3, w.z);
    scene.add(pillar);

    return {
      id: idx,
      x: w.x,
      y: baseY,
      z: w.z,
      floor,
      radius: z.radius,
      openRule: z.openRule || null,
      // 本帧的开放状态。初始按"常驻"给一个占位，第一帧 update 就会覆盖成真值 ——
      // 这里必须给初值，否则第一帧读取 open.open 会拿到 undefined。
      //
      // ★ 形状必须与 `evaluateOpenRule` 的返回值**逐字段一致**（含 remainingKills）：
      //   少了字段就不是"占位值"，而是"一个形状不对的状态"，读它的人会拿到 undefined，
      //   于是"还没求值"与"规则说不需要击杀"在读数上长得一样 —— 那是能骗过断言的假信号。
      open: { open: true, reason: 'always', opensInMs: 0, closesInMs: null, remainingKills: null },
      /** 规则是否已被求值过（初值是占位，不是判定结果）。 */
      evaluated: false,
      ring,
      pillar,
      progress: 0,
    };
  });

  let activeZone = null;
  /** 离开当前锁定撤离区的累计时长（毫秒）。用于宽限判定。 */
  let leaveMs = 0;

  /** 开放状态变化时更新外观。只在**变化时**改材质，避免每帧写 GPU 状态。 */
  function applyVisual(z) {
    const open = z.open.open;
    if (z._lastOpen === open) return;
    z._lastOpen = open;
    const c = open ? COLOR_OPEN : COLOR_LOCKED;
    z.ring.material.color.setHex(c);
    z.pillar.material.color.setHex(c);
    z.pillar.material.opacity = open ? 0.12 : 0.05;
  }

  /**
   * @param {number} dt 秒
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {object} ctx 规则求值所需的局内时间
   * @param {number} ctx.elapsedMs   局内已过时间
   * @param {number} ctx.timeLimitMs 单局时限（解析 afterFraction / fromFraction 用）
   */
  function update(dt, playerPos, ctx = {}) {
    // ---- ① 先算每个撤离点本帧的开放状态 ----
    // 分层判定与开放判定是两件独立的事：前者决定"是不是这个点"，后者决定"这个点能不能用"。
    for (const z of zones) {
      z.open = evaluateOpenRule(z.openRule, ctx);
      z.evaluated = true;
      applyVisual(z);
    }

    const playerFloor = level.floorOfY(playerPos.y);
    let inside = null;
    let blocked = null; // 站在范围内但点没开 —— 用来告诉玩家"还要等多久"
    for (const z of zones) {
      if (z.floor !== playerFloor) continue;
      if (Math.hypot(z.x - playerPos.x, z.z - playerPos.z) > z.radius) continue;
      if (z.open.open) {
        inside = z;
        break;
      }
      if (!blocked) blocked = z;
    }

    // ---- ②-a 倒计时中途开放状态失效（例如时间窗关闭）----
    // 这是 M4-1 规则的直接后果，与下面的"离开区域"是两种不同的中断来源。
    let interrupted = null;
    if (activeZone && !activeZone.open.open) {
      activeZone.progress = 0;
      interrupted = { zone: activeZone, cause: 'closed', keptProgress: 0 };
      activeZone = null;
      leaveMs = 0;
    }

    // ---- ②-b M4-2：离开撤离区 = 唯一的中断源 ----
    // 中断源**只有**这一条（受击 / 开火 / 使用道具都不中断，是明确裁定）。
    // 宽限的意义：玩家在圈边缘抖动时不该被反复重置，所以"离开"要累计到
    // leaveGraceMs 才算数；宽限内回到**同一个**区则继续计时。
    if (activeZone && inside !== activeZone) {
      leaveMs += dt * 1000;
      if (inside) {
        // 直接跨进了另一个撤离区：没有"中断"这回事，但进度从头开始
        const prev = activeZone;
        prev.progress = 0;
        activeZone = inside;
        leaveMs = 0;
        interrupted = interrupted || { zone: prev, cause: 'switched', keptProgress: 0 };
      } else if (leaveMs > graceMs) {
        // 真的离开了，且超过宽限 → 中断，进度按 keepFraction 处理（当前配置为 0，即清零）
        activeZone.progress = Math.max(0, activeZone.progress * keepFraction);
        interrupted = { zone: activeZone, cause: 'left', keptProgress: activeZone.progress };
        activeZone = null;
        leaveMs = 0;
      }
    } else if (inside) {
      // 在区内（含宽限内回到同一个区）：清掉离开计时，进度继续累积
      activeZone = inside;
      leaveMs = 0;
    }

    // ---- ③ 推进倒计时 ----
    let completed = false;
    if (activeZone) {
      activeZone.progress += dt * 1000;
      const t = Math.min(1, activeZone.progress / E.countdownMs);
      activeZone.ring.material.opacity = 0.4 + 0.6 * t;
      if (activeZone.progress >= E.countdownMs) {
        completed = true;
        activeZone.progress = E.countdownMs;
      }
    } else {
      for (const z of zones) z.ring.material.opacity = z.open.open ? 0.85 : 0.4;
    }

    return {
      // inZone 表示"**当前**是否站在撤离区内"，而不是"是否还锁着某个区"。
      // 这两者在宽限期内是分离的：玩家走出圈的瞬间 inZone 就该变 false
      // （HUD 要立刻提示"已离开"），但锁定仍保留、进度仍在 —— 那才是宽限的意义。
      inZone: !!inside,
      zone: activeZone,
      progress: activeZone ? Math.min(1, activeZone.progress / E.countdownMs) : 0,
      completed,
      /** 玩家站在某个**未开放**的点里（HUD 用它提示还需多久/已关闭） */
      blocked: blocked
        ? {
            zone: blocked,
            reason: blocked.open.reason,
            opensInMs: blocked.open.opensInMs,
            closesInMs: blocked.open.closesInMs,
            remainingKills: blocked.open.remainingKills,
          }
        : null,
      /** 本帧是否发生了中断，以及原因（left / switched / closed） */
      interrupted,
      /** 已离开当前撤离区多久（毫秒）。HUD 可用它提示"即将中断" */
      leaveMs,
      /** 全部撤离点的开放状态（结算与断言需要，HUD 也可用） */
      openStates: zones.map((z) => ({ id: z.id, floor: z.floor, ...z.open })),
    };
  }

  return {
    zones,
    update,
    countdownMs: E.countdownMs,
    /** 供 DEV 接口与断言读取：每个点的规则类型与当前是否开放 */
    snapshot: () => zones.map((z) => ({ id: z.id, floor: z.floor, rule: z.openRule, open: z.open.open, reason: z.open.reason })),
  };
}
