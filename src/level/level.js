// M1-1 灰盒关卡
//
// 职责：网格地图生成、静态几何渲染、碰撞求解、网格射线。
// 设计依据：M0-5 已验证"网格 + DDA"方案在目标机上位可行，故 M1 直接沿用网格驱动。
// 约束依据：M0-TECH-01 约束 C-5 —— 关卡静态几何必须实例化，禁止逐个 Mesh 提交。
//          M1 虽禁止"优化性能"，但用 InstancedMesh 建墙并非优化工作（代码量更少），
//          而是不搭建一个已知不可扩展的结构。此为 M1/M0 约束冲突的裁决，已记入报告。
import * as THREE from 'three';
import { mulberry32, clamp } from '../core/rng.js';

export function createLevel(cfg, scene) {
  const { gridW: W, gridH: H, cell, wallHeight, blockRatio, seed } = cfg.level;
  const rnd = mulberry32(seed);

  // ---------- 网格生成 ----------
  const blocked = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      blocked[y * W + x] = border || rnd() < blockRatio ? 1 : 0;
    }
  }
  // 出生点与撤离点周围强制清空，避免刷在墙里
  const carve = (cx, cz, r) => {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const z = cz + dz;
        if (x <= 0 || z <= 0 || x >= W - 1 || z >= H - 1) continue;
        blocked[z * W + x] = 0;
      }
    }
  };
  carve(cfg.level.playerSpawnCell[0], cfg.level.playerSpawnCell[1], 2);
  for (const z of cfg.extract.zones) carve(z.cell[0], z.cell[1], 2);
  // 容器格必须可站可搜，否则会出现"容器在墙里"
  for (const c of cfg.loot.containerCells) carve(c[0], c[1], 1);

  const free = [];
  for (let i = 0; i < W * H; i++) if (!blocked[i]) free.push(i);

  // ---------- 坐标换算 ----------
  const cellToWorld = (cx, cz) => ({ x: (cx + 0.5) * cell, z: (cz + 0.5) * cell });
  const worldToCell = (x, z) => ({ cx: Math.floor(x / cell), cz: Math.floor(z / cell) });
  const isBlockedCell = (cx, cz) => cx <= 0 || cz <= 0 || cx >= W - 1 || cz >= H - 1 || blocked[cz * W + cx] === 1;

  // ---------- 渲染 ----------
  const worldW = W * cell;
  const worldH = H * cell;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(worldW, worldH),
    new THREE.MeshLambertMaterial({ color: 0x2b3238 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(worldW / 2, 0, worldH / 2);
  ground.receiveShadow = true;
  scene.add(ground);

  // 灰盒参考网格：不是美化，是让玩家能判断移动距离与位置的可用性需求
  const grid = new THREE.GridHelper(worldW, W, 0x3c464e, 0x333c43);
  grid.position.set(worldW / 2, 0.01, worldH / 2);
  scene.add(grid);

  let wallCount = 0;
  for (let i = 0; i < W * H; i++) if (blocked[i]) wallCount++;

  const wallGeo = new THREE.BoxGeometry(cell, wallHeight, cell);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x59636d });
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, wallCount);
  walls.castShadow = true;
  walls.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  let w = 0;
  for (let cz = 0; cz < H; cz++) {
    for (let cx = 0; cx < W; cx++) {
      if (!blocked[cz * W + cx]) continue;
      m4.makeTranslation((cx + 0.5) * cell, wallHeight / 2, (cz + 0.5) * cell);
      walls.setMatrixAt(w++, m4);
    }
  }
  walls.instanceMatrix.needsUpdate = true;
  scene.add(walls);

  // ---------- 碰撞求解：圆 vs 网格 AABB ----------
  // 就地修改传入的 {x, z}
  function resolveCircle(pos, radius) {
    const cx0 = Math.floor(pos.x / cell);
    const cz0 = Math.floor(pos.z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx0 + dx;
        const gz = cz0 + dz;
        if (!isBlockedCell(gx, gz)) continue;
        const minX = gx * cell;
        const minZ = gz * cell;
        const maxX = minX + cell;
        const maxZ = minZ + cell;
        const nx = clamp(pos.x, minX, maxX);
        const nz = clamp(pos.z, minZ, maxZ);
        let ddx = pos.x - nx;
        let ddz = pos.z - nz;
        let d2 = ddx * ddx + ddz * ddz;

        if (d2 > radius * radius) continue;

        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = radius - d;
          pos.x += (ddx / d) * push;
          pos.z += (ddz / d) * push;
        } else {
          // 圆心落在方块内部：沿穿透最浅的一边推出
          const toLeft = pos.x - minX;
          const toRight = maxX - pos.x;
          const toBack = pos.z - minZ;
          const toFront = maxZ - pos.z;
          const m = Math.min(toLeft, toRight, toBack, toFront);
          if (m === toLeft) pos.x = minX - radius;
          else if (m === toRight) pos.x = maxX + radius;
          else if (m === toBack) pos.z = minZ - radius;
          else pos.z = maxZ + radius;
        }
      }
    }
  }

  // ---------- 网格射线（DDA）----------
  // 来源：M0-5 nav.js 已验证的 DDA，此处扩展为考虑墙体高度。
  // 返回射线到墙面的距离；未命中返回 Infinity。
  //
  // M1-TEMP-16 已修复：原实现只在"格子入口点"判定是否落在墙高范围内，
  //   因此从墙上方斜向下射入墙体内部的射线会漏判 —— 表现为**隔墙打中敌人**。
  //   现在补了两件事：
  //     ① 入口点高于墙顶且射线向下时，额外求与墙顶面（y=wallHeight）的交点；
  //     ② 入口点高于墙顶且射线向上/水平时，才真正放过这个格子。
  function raycastWall(ox, oy, oz, dx, dy, dz, maxDist) {
    let cx = Math.floor(ox / cell);
    let cz = Math.floor(oz / cell);

    // 起点已在墙体内（含高度判定）
    if (isBlockedCell(cx, cz) && oy >= 0 && oy <= wallHeight) return 0;

    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDz = dz !== 0 ? 1 / dz : 0;

    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) * cell - ox) * invDx;
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? cz + 1 : cz) * cell - oz) * invDz;
    const tDeltaX = dx === 0 ? Infinity : cell * Math.abs(invDx);
    const tDeltaZ = dz === 0 ? Infinity : cell * Math.abs(invDz);

    for (let guard = 0; guard < (W + H) * 4; guard++) {
      let t;
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        t = tMaxZ;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (t > maxDist) return Infinity;
      if (!isBlockedCell(cx, cz)) continue;

      const y = oy + dy * t;
      if (y >= 0 && y <= wallHeight) return t;

      // 入口点在墙顶之上
      if (y > wallHeight) {
        if (dy >= 0) return Infinity; // 继续升高，不可能再撞到墙
        // 向下穿过墙顶面：求 y = wallHeight 的交点，并确认落点仍在同一格内
        const tTop = (wallHeight - oy) / dy;
        if (tTop > t && tTop <= maxDist) {
          const px = ox + dx * tTop;
          const pz = oz + dz * tTop;
          if (Math.floor(px / cell) === cx && Math.floor(pz / cell) === cz) {
            return tTop;
          }
        }
        continue; // 前一面没落在本格，继续往前找
      }
      // y < 0：从墙下方掠过（M2 关卡没有地下室，直接放过）
    }
    return Infinity;
  }

  // 地面交点距离（y = 0 平面）
  function raycastGround(oy, dy) {
    if (dy >= -1e-6) return Infinity;
    const t = -oy / dy;
    return t > 0 ? t : Infinity;
  }

  // 视线检测：两点之间是否无墙遮挡
  function hasLineOfSight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return true;
    const hit = raycastWall(ax, ay, az, dx / dist, dy / dist, dz / dist, dist);
    return hit >= dist;
  }

  return {
    W, H, cell, wallHeight, blocked, free, worldW, worldH,
    cellToWorld, worldToCell, isBlockedCell,
    resolveCircle, raycastWall, raycastGround, hasLineOfSight,
    wallCount,
  };
}
