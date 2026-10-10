// M1-1 灰盒关卡（M2 增补：低矮掩体与高度感知碰撞）
//
// 职责：网格地图生成、静态几何渲染、碰撞求解、网格射线。
// 设计依据：M0-5 已验证"网格 + DDA"方案在目标机上位可行，故 M1 直接沿用网格驱动。
// 约束依据：M0-TECH-01 约束 C-5 —— 关卡静态几何必须实例化，禁止逐个 Mesh 提交。
//          M1 虽禁止"优化性能"，但用 InstancedMesh 建墙并非优化工作（代码量更少），
//          而是不搭建一个已知不可扩展的结构。此为 M1/M0 约束冲突的裁决，已记入报告。
//
// ---------------------------------------------------------------------------
// M2 增补说明（M1-TEMP-3 台阶吸附的前提）
//
// M1-TEMP-3 记录的问题是"没有台阶吸附，3.5 高的墙永远上不去"。
// 但真正的原因是**关卡里根本没有可以踩上去的低矮几何**：所有阻挡体都是
// 统一 3.5 米高的墙，且 resolveCircle 是纯 2D 的（不接受 y），
// 射线也用固定 wallHeight —— 在这套几何上做台阶吸附既没有意义也无法验证。
//
// 因此本文件加入**低矮掩体**，并让碰撞与射线都变成**高度感知**的：
//   · 低掩体（可迈上）：玩家与 AI 都能直接走上去
//   · 高掩体（需跳上）：挡移动，且能挡子弹 —— 这才让 M2 的"掩体对抗"成立
//
// 【范围声明】这里加的是**最小夹具**，目的是让台阶吸附可被真实驱动与验证，
// 不是关卡设计。正式的掩体布局、通路与视线设计属 M3（关卡与搜刮系统）。
// 生成方式为种子驱动的确定性随机，因此可复现、可测试。
// ---------------------------------------------------------------------------
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

  // ---------- 低矮掩体 ----------
  // 高度存成 Uint8（单位：厘米），既省内存又避免浮点比较的边界抖动。
  const coverCm = new Uint8Array(W * H);
  const cover = cfg.level.lowCover;
  const coverList = [];
  if (cover && cover.count > 0) {
    // 这些格子附近不生成掩体：出生点/撤离点/容器格，以及它们的一圈邻居。
    // 否则会出现"玩家刷在掩体里"或"容器被掩体埋住"。
    const reserved = new Set();
    const reserve = (cx, cz, r) => {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) reserved.add((cz + dz) * W + (cx + dx));
      }
    };
    reserve(cfg.level.playerSpawnCell[0], cfg.level.playerSpawnCell[1], cover.clearRadiusCells);
    for (const z of cfg.extract.zones) reserve(z.cell[0], z.cell[1], cover.clearRadiusCells);
    for (const c of cfg.loot.containerCells) reserve(c[0], c[1], cover.clearRadiusCells);

    // 只在"四面都是空地"的格子上放掩体：贴着墙的掩体没有通行价值，
    // 而且会让 AI 的绕行路径变得难以预测。
    const candidates = [];
    for (const idx of free) {
      if (reserved.has(idx)) continue;
      const cx = idx % W;
      const cz = Math.floor(idx / W);
      let open = true;
      for (let dz = -1; dz <= 1 && open; dz++) {
        for (let dx = -1; dx <= 1 && open; dx++) {
          if (blocked[(cz + dz) * W + (cx + dx)]) open = false;
        }
      }
      if (open) candidates.push(idx);
    }
    // 打乱后按 count 取，保证分布均匀且可复现
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const n = Math.min(cover.count, candidates.length);
    for (let i = 0; i < n; i++) {
      const idx = candidates[i];
      const tall = rnd() < cover.tallRatio;
      const h = tall ? cover.tallHeight : cover.lowHeight;
      coverCm[idx] = Math.round(h * 100);
      coverList.push({ cell: idx % W, z: Math.floor(idx / W), height: h });
    }
  }

  /** 该格的地面高度（米）。0 表示地面，否则是掩体顶面。 */
  function groundHeightAt(x, z) {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return 0;
    return coverCm[cz * W + cx] / 100;
  }

  /** 该格阻挡体的有效高度（米）。墙为 wallHeight，掩体为其顶面，空地 0。 */
  function effectiveHeightAt(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return wallHeight;
    if (blocked[cz * W + cx]) return wallHeight;
    return coverCm[cz * W + cx] / 100;
  }

  // ---------- 坐标换算 ----------
  const cellToWorld = (cx, cz) => ({ x: (cx + 0.5) * cell, z: (cz + 0.5) * cell });
  const worldToCell = (x, z) => ({ cx: Math.floor(x / cell), cz: Math.floor(z / cell) });
  const isBlockedCell = (cx, cz) => cx <= 0 || cz <= 0 || cx >= W - 1 || cz >= H - 1 || blocked[cz * W + cx] === 1;

  /**
   * 寻路用的阻挡判定：墙，**加上迈不过去的高掩体**。
   * AI 不会迈台阶，如果不把高掩体算进寻路，AI 会直接穿模走过去。
   * 低掩体（≤ stepHeight）不算阻挡 —— 玩家和 AI 都能走上去，不该绕路。
   */
  const pathStepHeight = cfg.player.stepHeight || 0.55;
  function isPathBlockedCell(cx, cz) {
    if (isBlockedCell(cx, cz)) return true;
    if (cx <= 0 || cz <= 0 || cx >= W - 1 || cz >= H - 1) return true;
    return coverCm[cz * W + cx] / 100 > pathStepHeight;
  }

  // 供寻路网格直接使用（navgrid 接受的是 Uint8Array，不想为它改接口）
  const pathBlocked = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    pathBlocked[i] = isPathBlockedCell(i % W, Math.floor(i / W)) ? 1 : 0;
  }

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

  // 掩体渲染：视觉略微内缩，让相邻掩体之间看得出分隔（碰撞仍按整格，保持模型简单）
  const coverVisualScale = cover ? cover.visualScale ?? 0.94 : 0.94;
  const lowList = coverList.filter((c) => c.height <= pathStepHeight);
  const tallList = coverList.filter((c) => c.height > pathStepHeight);
  const coverMeshes = [];
  const buildCovers = (list, color) => {
    if (!list.length) return null;
    const geo = new THREE.BoxGeometry(cell * coverVisualScale, 1, cell * coverVisualScale);
    const mat = new THREE.MeshLambertMaterial({ color });
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.castShadow = true;
    im.receiveShadow = true;
    list.forEach((c, i) => {
      // 几何高度为 1，用缩放表达实际高度，底部贴合地面
      const s = new THREE.Matrix4().makeScale(1, c.height, 1);
      s.setPosition((c.cell + 0.5) * cell, c.height / 2, (c.z + 0.5) * cell);
      im.setMatrixAt(i, s);
    });
    im.instanceMatrix.needsUpdate = true;
    scene.add(im);
    coverMeshes.push(im);
    return im;
  };
  buildCovers(lowList, 0x6d6152);
  buildCovers(tallList, 0x7a6a55);

  // ---------- 碰撞求解：圆 vs 网格 AABB（高度感知）----------
  //
  // feetY      : 玩家脚底高度。高于阻挡体顶面时该格不再阻挡（人已在上面）。
  // stepHeight : 可迈上的高度。阻挡体顶面比脚底高出不超过它时**不阻挡** ——
  //              交给台阶吸附把玩家抬上去，而不是把人挡在台阶前。
  //              这一条同时统一了"低掩体可迈上"与"高掩体需跳上"：
  //                低掩体 0.45，脚底 0   → 0.45-0.55 < 0  → 不阻挡 → 迈上去
  //                高掩体 1.15，脚底 0   → 1.15-0.55 > 0  → 阻挡
  //                高掩体 1.15，脚底 0.7 → 1.15-0.55=0.6 < 0.7 → 不阻挡 → 跳上去
  //              不需要为掩体类型写任何分支。
  function resolveCircle(pos, radius, feetY = 0, stepHeight = 0) {
    const cx0 = Math.floor(pos.x / cell);
    const cz0 = Math.floor(pos.z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx0 + dx;
        const gz = cz0 + dz;
        const h = effectiveHeightAt(gx, gz);
        if (h <= 0) continue;
        // 已在阻挡体上方，或可以迈上去 → 不阻挡
        if (feetY >= h - stepHeight - 1e-6) continue;

        const minX = gx * cell;
        const minZ = gz * cell;
        const maxX = minX + cell;
        const maxZ = minZ + cell;
        const nx = clamp(pos.x, minX, maxX);
        const nz = clamp(pos.z, minZ, maxZ);
        const ddx = pos.x - nx;
        const ddz = pos.z - nz;
        const d2 = ddx * ddx + ddz * ddz;

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

  /** 该位置能否站人（用于台阶吸附判定）：四周没有"迈不上去"的阻挡 */
  function canStandAt(x, z, radius, feetY, stepHeight) {
    const probe = { x, z };
    resolveCircle(probe, radius, feetY, stepHeight);
    return Math.abs(probe.x - x) < 1e-4 && Math.abs(probe.z - z) < 1e-4;
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
  //
  // M2 增补：格子高度改用 effectiveHeightAt —— 因此**掩体能挡子弹**，
  //   这既是掩体有效的前提，也让"蹲在矮墙后射击"成为真实战术。
  function raycastWall(ox, oy, oz, dx, dy, dz, maxDist) {
    let cx = Math.floor(ox / cell);
    let cz = Math.floor(oz / cell);

    // 起点已在阻挡体内（含高度判定）
    const h0 = effectiveHeightAt(cx, cz);
    if (h0 > 0 && oy >= 0 && oy <= h0) return 0;

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
      const h = effectiveHeightAt(cx, cz);
      if (h <= 0) continue;

      const y = oy + dy * t;
      if (y >= 0 && y <= h) return t;

      // 入口点在阻挡体顶面之上
      if (y > h) {
        if (dy >= 0) return Infinity; // 继续升高，不可能再撞到
        // 向下穿过顶面：求 y = h 的交点，并确认落点仍在同一格内
        const tTop = (h - oy) / dy;
        if (tTop > t && tTop <= maxDist) {
          const px = ox + dx * tTop;
          const pz = oz + dz * tTop;
          if (Math.floor(px / cell) === cx && Math.floor(pz / cell) === cz) {
            return tTop;
          }
        }
        continue; // 前一面没落在本格，继续往前找
      }
      // y < 0：从下方掠过（M2 关卡没有地下室，直接放过）
    }
    return Infinity;
  }

  // 地面交点距离（考虑掩体顶面）。返回 { t, y } 或 null。
  function raycastGroundFull(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null;
    // 与地面平面
    if (dy < -1e-6) {
      const t = -oy / dy;
      if (t > 0 && t <= maxDist) best = { t, y: 0 };
    }
    // 与沿途每个掩体顶面
    const steps = Math.ceil(maxDist / (cell * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * maxDist;
      const x = ox + dx * t;
      const z = oz + dz * t;
      const y = oy + dy * t;
      const g = groundHeightAt(x, z);
      if (g > 0 && y <= g && dy < 0) {
        // 求与该顶面的精确交点
        const tg = (g - oy) / dy;
        if (tg > 0 && tg <= maxDist && (!best || tg < best.t)) {
          const gx = ox + dx * tg;
          const gz = oz + dz * tg;
          if (groundHeightAt(gx, gz) === g) best = { t: tg, y: g };
        }
      }
    }
    return best;
  }

  // 地面交点距离（y = 0 平面）——保留原签名，供既有调用方使用
  function raycastGround(oy, dy) {
    if (dy >= -1e-6) return Infinity;
    const t = -oy / dy;
    return t > 0 ? t : Infinity;
  }

  // 视线检测：两点之间是否无阻挡
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
    cellToWorld, worldToCell, isBlockedCell, isPathBlockedCell,
    resolveCircle, canStandAt,
    raycastWall, raycastGround, raycastGroundFull, hasLineOfSight,
    groundHeightAt, effectiveHeightAt,
    wallCount,
    coverCm, coverList, coverMeshes, stepHeight: pathStepHeight, pathBlocked,
  };
}
