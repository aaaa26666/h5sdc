// M1-6 撤离点
//
// 职责：撤离区判定、停留倒计时、离开重置、完成触发。
//
// [M1-TEMP-12] 撤离点全部为常驻点，无钥匙、无时间窗、无条件校验。
//              M2 重写清单：接入条件撤离点（钥匙/时间窗/任务解锁）与"禁止进入"的封锁点。
// [M1-TEMP-13] 倒计时期间可自由移动，不校验"是否仍在区内"以外的任何条件
//              （例如是否被击中、是否需要放下某物）。
//              M2 重写清单：明确撤离规则并写入配置。
import * as THREE from 'three';

export function createExtract(cfg, level, scene) {
  const E = cfg.extract;

  const zones = E.zones.map((z, idx) => {
    const w = level.cellToWorld(z.cell[0], z.cell[1]);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(z.radius - 0.35, z.radius, 40),
      new THREE.MeshBasicMaterial({ color: 0x4fd48a, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(w.x, 0.03, w.z);
    scene.add(ring);

    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(z.radius - 0.4, z.radius - 0.4, 6, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x4fd48a, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
    );
    pillar.position.set(w.x, 3, w.z);
    scene.add(pillar);

    return { id: idx, x: w.x, z: w.z, radius: z.radius, ring, pillar, progress: 0 };
  });

  let activeZone = null;

  /**
   * @returns {{inZone:boolean, zone:object|null, progress:number, completed:boolean}}
   */
  function update(dt, playerPos) {
    let inside = null;
    for (const z of zones) {
      if (Math.hypot(z.x - playerPos.x, z.z - playerPos.z) <= z.radius) {
        inside = z;
        break;
      }
    }

    if (inside !== activeZone) {
      if (activeZone) activeZone.progress = 0;
      activeZone = inside;
    }

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
      for (const z of zones) z.ring.material.opacity = 0.85;
    }

    return {
      inZone: !!activeZone,
      zone: activeZone,
      progress: activeZone ? Math.min(1, activeZone.progress / E.countdownMs) : 0,
      completed,
    };
  }

  return { zones, update, countdownMs: E.countdownMs };
}
