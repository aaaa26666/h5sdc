// M1-5 容器搜索与拾取
//
// 职责：容器摆放、掉落生成、按住 F 搜索、拾取入包、估值统计。
//
// [M1-TEMP-9] 搜索进度在"松开 F 或离开范围"时**直接清零**，没有断点续搜、
//             没有打断惩罚、没有搜索音效与高光表现。
//             M2 重写清单：定死"被打断则进度保留/清零"的规则并写入配置；
//             补搜索过程的表现与稀有度视觉引导。
// [M1-TEMP-10] 背包无容量、无负重、无堆叠上限，物品只进不出。
//             M2 重写清单：接入格子与负重系统（属 M3 范围，M1 仅需"能捡"）。
// [M1-TEMP-11] 容器开启后无表现变化（仅内部标记），玩家无法从外观判断是否搜过。
//             M2 重写清单：开启态外观与已搜标记。
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';

export function createLoot(cfg, level, scene) {
  const L = cfg.loot;
  const rnd = mulberry32(cfg.level.seed + 4231);

  const matClosed = new THREE.MeshLambertMaterial({ color: 0x9a7b4f });
  const matOpen = new THREE.MeshLambertMaterial({ color: 0x4e4636 });
  const geo = new THREE.BoxGeometry(1.1, 0.9, 0.8);

  function rollItems() {
    const n = L.itemsPerContainerMin + Math.floor(rnd() * (L.itemsPerContainerMax - L.itemsPerContainerMin + 1));
    const totalWeight = L.items.reduce((s, it) => s + it.weight, 0);
    const out = [];
    for (let i = 0; i < n; i++) {
      let r = rnd() * totalWeight;
      for (const it of L.items) {
        r -= it.weight;
        if (r <= 0) {
          out.push({ ...it });
          break;
        }
      }
    }
    return out;
  }

  const containers = L.containerCells.map((c, idx) => {
    const w = level.cellToWorld(c[0], c[1]);
    const mesh = new THREE.Mesh(geo, matClosed);
    mesh.position.set(w.x, 0.45, w.z);
    mesh.castShadow = true;
    scene.add(mesh);
    return {
      id: idx,
      x: w.x,
      z: w.z,
      opened: false,
      items: rollItems(),
      mesh,
      progress: 0,
    };
  });

  const inventory = [];
  let activeContainer = null;

  function update(dt, playerPos, interactHeld) {
    // 找范围内最近的可搜容器
    let nearest = null;
    let nearestD = Infinity;
    for (const c of containers) {
      if (c.opened) continue;
      const d = Math.hypot(c.x - playerPos.x, c.z - playerPos.z);
      if (d < L.interactRange && d < nearestD) {
        nearestD = d;
        nearest = c;
      }
    }

    // 换目标或松手则清零（见 [M1-TEMP-9]）
    if (activeContainer && activeContainer !== nearest) {
      activeContainer.progress = 0;
      activeContainer = null;
    }

    let justOpened = null;
    if (nearest && interactHeld) {
      activeContainer = nearest;
      nearest.progress += dt * 1000;
      if (nearest.progress >= L.searchMs) {
        nearest.opened = true;
        nearest.progress = L.searchMs;
        nearest.mesh.material = matOpen;
        for (const it of nearest.items) inventory.push(it);
        justOpened = nearest;
        activeContainer = null;
      }
    }

    return { nearest, activeContainer, justOpened };
  }

  function totalValue() {
    let v = 0;
    for (const it of inventory) v += it.value;
    return v;
  }

  return {
    containers,
    inventory,
    update,
    totalValue,
    openedCount: () => containers.filter((c) => c.opened).length,
  };
}
