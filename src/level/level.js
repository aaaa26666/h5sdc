// M3-1 灰盒关卡（表驱动确定布局）
//
// 职责：按**地图表**构建网格、静态几何渲染、碰撞求解、网格射线。
// 设计依据：M0-5 已验证"网格 + DDA"方案在目标机上位可行，故沿用网格驱动。
// 约束依据：M0-TECH-01 约束 C-5 —— 关卡静态几何必须实例化，禁止逐个 Mesh 提交。
//          （用 InstancedMesh 建墙并非"优化工作"，代码量反而更少，
//           而是不搭建一个已知不可扩展的结构。此为 M1/M0 约束冲突的裁决，已记入报告。）
//
// ---------------------------------------------------------------------------
// M3-1 的变化：**生成方式**从"种子随机"改为"读地图表"
//
// M1/M2 的关卡是 `mulberry32(seed)` 按 blockRatio 随机撒墙生成的。
// 那种方式可复现、可测试，但**不能做关卡设计** —— 没有动线、没有分区、
// 没有"这里该放什么"的意图。M3-1 要求"灰盒确定布局"，因此改为：
//
//     src/config/maps/<id>.json  ->  墙体矩形 / 掩体矩形 / 出生点 / 容器 / 撤离点
//
// 由此产生的连带变化：
//   · 不再需要 carve/reserve（"把出生点和容器周围的墙挖掉"）——
//     手写坐标不允许出错，出错由 config 的**启动期校验**带着坐标报错，
//     而不是靠运行时悄悄挖洞把它藏起来。静默兜底会让地图错误永远浮不上来。
//   · seed 仍然保留，但不再参与地图生成（aiManager / loot / main 用它做 RNG）。
//   · M2 的"低矮掩体最小夹具"（随机撒 70 个）删除，改为地图表里的手写掩体布局。
//
// 【范围声明】本文件只负责"让地图表变成可玩的关卡"。
// 容器分级/搜索进度/掉落权重/背包属 M3-3 ~ M3-6；容器在此只作为静态灰盒物件。
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export function createLevel(cfg, scene) {
  const map = cfg.map;
  const { w: W, h: H, cell, wallHeight } = map.grid;

  // ---------- 网格：由地图表的墙体矩形构建 ----------
  const blocked = new Uint8Array(W * H);
  const idx = (x, z) => z * W + x;

  // 最外圈强制为墙（与既有约定一致，也与 config 的校验保持一致）
  for (let x = 0; x < W; x++) { blocked[idx(x, 0)] = 1; blocked[idx(x, H - 1)] = 1; }
  for (let z = 0; z < H; z++) { blocked[idx(0, z)] = 1; blocked[idx(W - 1, z)] = 1; }

  for (const b of map.walls) {
    for (let dz = 0; dz < b.h; dz++) {
      for (let dx = 0; dx < b.w; dx++) {
        blocked[idx(b.x + dx, b.z + dz)] = 1;
      }
    }
  }

  const free = [];
  for (let i = 0; i < W * H; i++) if (!blocked[i]) free.push(i);

  // ---------- 掩体：由地图表的掩体矩形构建 ----------
  // 高度存成 Uint8（单位：厘米），既省内存又避免浮点比较的边界抖动。
  // 高度取值来自 cfg.level.cover（跨地图共享的规格），地图表只给位置与类型 ——
  // 这样"低掩体多高"只有一处定义，M7 换皮时也不会有人去改地图表里的数字。
  const coverCm = new Uint8Array(W * H);
  const coverSpec = cfg.level.cover;
  const coverList = [];
  for (const c of map.cover || []) {
    const h = c.type === 'tall' ? coverSpec.tallHeight : coverSpec.lowHeight;
    for (let dz = 0; dz < c.h; dz++) {
      for (let dx = 0; dx < c.w; dx++) {
        const x = c.x + dx;
        const z = c.z + dz;
        coverCm[idx(x, z)] = Math.round(h * 100);
        coverList.push({ cell: x, z, height: h, type: c.type });
      }
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
  const coverVisualScale = coverSpec.visualScale ?? 0.94;
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
  //                低掩体 0.45，脚底 0   → 0.45-0.60 < 0  → 不阻挡 → 迈上去
  //                高掩体 1.05，脚底 0   → 1.05-0.60 > 0  → 阻挡
  //                高掩体 1.05，脚底 0.7 → 1.05-0.60=0.45 < 0.7 → 不阻挡 → 跳上去
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
        const nx = Math.max(minX, Math.min(pos.x, maxX));
        const nz = Math.max(minZ, Math.min(pos.z, maxZ));
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
      // y < 0：从下方掠过（本关卡没有地下室，直接放过）
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

  // AI 出生候选：空格**且没有掩体**。
  // 为什么单独给一份：free 只排除了墙，掩体格仍是"可通行"的，
  // 但让 AI 生成在掩体里（尤其是高掩体内部）会让它卡住或穿模。
  // 之前靠"生成时把出生点周围挖空"回避，改成手写地图后那个兜底没有了，
  // 因此改成显式发布一份可出生格列表。
  const spawnable = free.filter((i) => coverCm[i] === 0);

  return {
    W, H, cell, wallHeight, blocked, free, spawnable, worldW, worldH,
    mapId: map.id,
    cellToWorld, worldToCell, isBlockedCell, isPathBlockedCell,
    resolveCircle, canStandAt,
    raycastWall, raycastGround, raycastGroundFull, hasLineOfSight,
    groundHeightAt, effectiveHeightAt,
    wallCount,
    coverCm, coverList, coverMeshes, stepHeight: pathStepHeight, pathBlocked,
  };
}
