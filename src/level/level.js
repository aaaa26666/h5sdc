// M3-1b-1 灰盒关卡（**分层竖直跨度**几何）
//
// 职责：按地图表构建几何、静态渲染、碰撞求解、网格射线。
// 约束依据：M0-TECH-01 约束 C-5 —— 关卡静态几何必须实例化，禁止逐个 Mesh 提交。
//
// ---------------------------------------------------------------------------
// M3-1b-1 的变化：几何模型从「每格一个高度」改为「每格一组竖直实心跨度」
//
// 旧模型（几何版本 1）：
//     blocked : Uint8Array(W*H)   1 = 从地面到 wallHeight 的实心墙
//     coverCm : Uint8Array(W*H)   厘米；从地面实心到该高度（顶面可站）
//   它**表达不了两层**：`coverCm` 是 Uint8，最大只有 2.55m，装不下 3.6m 的楼板；
//   更根本的是"从地面实心到顶"这个语义意味着楼板下方不能通行。
//
// 新模型（几何版本 2）：每格一个按 y 升序、互不重叠的**跨度列表**
//     墙        [0.0, 3.5]   kind=wall
//     掩体      [0.0, 1.05]  kind=cover
//     （M3-1b-2 追加）楼板 [3.6, 3.9] kind=slab —— 下方是通的，一层可走
//     （M3-1b-2 追加）楼梯  斜坡          kind=ramp
//
// 这是**泛化**而不是另起一套：墙就是 [0, 3.5] 的跨度，掩体就是 [0, h] 的跨度，
// 因此现有语义可无损表达 —— 这一点由 tools/capture-level-golden.mjs 逐条证明。
//
// 【本步的范围与验收】M3-1b-1 **只改几何引擎，不改地图数据**。
// 因此它的验收标准是「**行为与改造前完全一致**」——
// 由黄金基准工具比对 6 万余条采样的输入输出得出，而不是靠"我觉得应该一样"。
// 楼板/楼梯/二层地图属 M3-1b-2。
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const KIND_WALL = 0;
const KIND_COVER = 1;
// 楼板：水平实心薄板。**下方是通的**（一层可以在二层楼板下行走）——
// 这正是旧模型（"从地面实心到顶"）表达不了两层的原因。
const KIND_SLAB = 2;
// 斜坡：连续倾斜的可走表面（楼梯用它）。
// 为什么楼梯必须是斜坡而不是台阶：层高 3.6m ÷ stepHeight 0.60m = 6 级 = 6 格 = 15m 长的楼梯，
// 不可用；而真实级高 0.18m 要 20 级，更不可能。28° 斜坡的水平投影只有约 2.7 格。
const KIND_RAMP = 3;

export function createLevel(cfg, scene) {
  const map = cfg.map;
  const { w: W, h: H, cell, wallHeight } = map.grid;

  // ---------- 跨度存储（CSR：压缩稀疏行）----------
  //
  // 为什么用扁平类型化数组而不是"每格一个 JS 数组"：
  //   查询发生在每帧的碰撞与射线上（每帧可达上千次），
  //   对象数组会带来指针追逐与 GC 抖动。CSR 把同一格的数据放在连续内存里。
  //
  // spanStart[i] .. spanStart[i+1] 是第 i 格的跨度区间。
  const spanStart = new Int32Array(W * H + 1);
  const spanY0 = [];
  const spanY1 = [];
  const spanKind = [];

  const idx = (x, z) => z * W + x;

  // ---------- 各层标高（必须最先声明）----------
  // 墙、掩体、楼板、斜坡都要用它，而且它在**常量初始化顺序上**必须早于第一次调用。
  // 我一度把它放在掩体之后，结果墙体循环先调到它 —— 报的是
  // "Cannot access 'floorBases' before initialization"（TDZ），
  // 而不是"读到 undefined"。函数声明会提升，但它引用的 const 不会。
  const floorBases = (map.floors || [{ id: 0, baseY: 0 }]).map((f) => f.baseY);
  const slabThickness = map.slabThickness || 0.3;
  function floorBaseY(floorIdx) {
    const i = floorIdx || 0;
    if (i < 0 || i >= floorBases.length) {
      throw new Error(`[level] 引用了不存在的地板层 ${floorIdx}`);
    }
    return floorBases[i];
  }

  // 先按格收集临时列表（构建期用普通数组最直观，最后再压实成类型化数组）
  const perCellSpans = new Array(W * H);
  const pushSpan = (x, z, y0, y1, kind) => {
    const i = idx(x, z);
    if (!perCellSpans[i]) perCellSpans[i] = [];
    perCellSpans[i].push([y0, y1, kind]);
  };

  // 最外圈强制为墙（与既有约定一致，也与 config 的启动期校验一致）
  for (let x = 0; x < W; x++) {
    pushSpan(x, 0, 0, wallHeight, KIND_WALL);
    pushSpan(x, H - 1, 0, wallHeight, KIND_WALL);
  }
  for (let z = 0; z < H; z++) {
    pushSpan(0, z, 0, wallHeight, KIND_WALL);
    pushSpan(W - 1, z, 0, wallHeight, KIND_WALL);
  }
  for (const b of map.walls) {
    const baseY = floorBaseY(b.floor);
    for (let dz = 0; dz < b.h; dz++) {
      for (let dx = 0; dx < b.w; dx++) {
        pushSpan(b.x + dx, b.z + dz, baseY, baseY + wallHeight, KIND_WALL);
      }
    }
  }

  // 各层标高已在本文件靠前处声明（见"各层标高（必须最先声明）"）。
  const coverSpec = cfg.level.cover;
  const coverList = [];
  for (const c of map.cover || []) {
    const h = c.type === 'tall' ? coverSpec.tallHeight : coverSpec.lowHeight;
    const baseY = floorBaseY(c.floor);
    for (let dz = 0; dz < c.h; dz++) {
      for (let dx = 0; dx < c.w; dx++) {
        const x = c.x + dx;
        const z = c.z + dz;
        pushSpan(x, z, baseY, baseY + h, KIND_COVER);
        coverList.push({ cell: x, z, height: baseY + h, type: c.type, floor: c.floor || 0 });
      }
    }
  }

  // ---------- 楼板（二层地面）----------
  //
  // 楼板是 [baseY - thickness, baseY] 的**薄板**，不是从地面实心到顶。
  // 下方留出的净高就是一层天花板高度 —— 一层因此可以在二层楼板下正常通行，
  // 这是"两层"与"一个大台子"的本质区别。
  const slabList = [];
  for (const s of map.slabs || []) {
    const top = floorBaseY(s.floor);
    for (let dz = 0; dz < s.h; dz++) {
      for (let dx = 0; dx < s.w; dx++) {
        const x = s.x + dx;
        const z = s.z + dz;
        pushSpan(x, z, top - slabThickness, top, KIND_SLAB);
        slabList.push({ cell: x, z, top, floor: s.floor });
      }
    }
  }

  // ---------- 斜坡（楼梯）----------
  //
  // 每格记录"沿 dir 进入该格时的表面高度 lo"与"离开时的表面高度 hi"，格内线性插值。
  // 斜坡格**不产生实心跨度**（它是可走的斜面，不是盒子）——
  // 否则人会撞在楼梯上。射线与实心判定改为按插值出的表面高度处理。
  const rampLo = new Map();
  const rampList = [];
  const DIRS = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };
  for (const r of map.ramps || []) {
    if (!DIRS[r.dir]) throw new Error(`[level] 斜坡 dir 非法：${r.dir}（应为 +x/-x/+z/-z）`);
    const from = floorBaseY(r.floor);
    const to = floorBaseY((r.floor || 0) + 1);
    const alongX = r.dir === '+x' || r.dir === '-x';
    const along = alongX ? r.w : r.h;
    if (along < 1) throw new Error(`[level] 斜坡 (${r.x},${r.z}) 沿 ${r.dir} 方向长度为 0`);
    const step = (to - from) / along;
    for (let k = 0; k < along; k++) {
      // 沿 dir 的方向推进格坐标；反向（-x/-z）时从矩形末端起步
      const off = r.dir === '+x' || r.dir === '+z' ? k : along - 1 - k;
      const cx = alongX ? r.x + off : r.x;
      const cz = alongX ? r.z : r.z + off;
      rampLo.set(cz * W + cx, { lo: from + step * k, hi: from + step * (k + 1), dir: r.dir });
      rampList.push({ cell: cx, z: cz, lo: from + step * k, hi: from + step * (k + 1), dir: r.dir });
    }
  }

  /** 斜坡格内的表面高度（按世界坐标在该格内的位置线性插值）。不是斜坡格返回 null。 */
  function rampSurfaceAt(cx, cz, x, z) {
    const r = rampLo.get(cz * W + cx);
    if (!r) return null;
    const fx = x / cell - cx;
    const fz = z / cell - cz;
    let t;
    if (r.dir === '+x') t = fx;
    else if (r.dir === '-x') t = 1 - fx;
    else if (r.dir === '+z') t = fz;
    else t = 1 - fz;
    return r.lo + (r.hi - r.lo) * Math.min(1, Math.max(0, t));
  }

  // 压实成 CSR。
  //
  // ★ 必须先合并重叠/相邻的同种跨度：边界墙在四个角会被压入两次
  //   （x 循环一次、z 循环一次），地图里的墙体矩形也可能彼此相接。
  //   旧实现用 `blocked[i] = 1` 天然幂等，跨度列表则必须显式合并 ——
  //   否则"同一格有两条 [0,3.5] 的墙"会让后续所有区间运算重复计数。
  //
  //   不同种类的跨度重叠则**报错**：那意味着地图数据把掩体埋进了墙里，
  //   是这个几何模型下无法有意义表达的状态（应当由启动期校验拦下）。
  {
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      spanStart[i] = n;
      const list = perCellSpans[i];
      if (list) {
        list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [];
        for (const sp of list) {
          const last = merged[merged.length - 1];
          if (last && sp[0] <= last[1] + 1e-6) {
            if (sp[2] !== last[2]) {
              throw new Error(
                `[level] 格子 (${i % W},${Math.floor(i / W)}) 存在不同种类的重叠跨度：` +
                  `kind=${last[2]}[${last[0]},${last[1]}] 与 kind=${sp[2]}[${sp[0]},${sp[1]}]`
              );
            }
            if (sp[1] > last[1]) last[1] = sp[1];
            continue;
          }
          merged.push([sp[0], sp[1], sp[2]]);
        }
        for (const [y0, y1, kind] of merged) {
          spanY0.push(y0);
          spanY1.push(y1);
          spanKind.push(kind);
          n++;
        }
      }
    }
    spanStart[W * H] = n;
  }
  const spanY0f = Float32Array.from(spanY0);
  const spanY1f = Float32Array.from(spanY1);
  const spanKindU = Uint8Array.from(spanKind);

  /** 该格跨度区间的起止下标 */
  const spanRange = (cx, cz) => {
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return null;
    const i = cz * W + cx;
    return [spanStart[i], spanStart[i + 1]];
  };

  // 兼容视图：旧代码与调试接口仍在读 blocked / coverCm。
  // 它们是**派生**的只读快照，不是真值 —— 真值是上面的跨度表。
  const blocked = new Uint8Array(W * H);
  const coverCm = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    let hasWall = 0;
    let coverTop = 0;
    for (let s = spanStart[i]; s < spanStart[i + 1]; s++) {
      if (spanKindU[s] === KIND_WALL) hasWall = 1;
      else if (spanY1f[s] > coverTop) coverTop = spanY1f[s];
    }
    blocked[i] = hasWall;
    coverCm[i] = Math.round(coverTop * 100);
  }

  const free = [];
  for (let i = 0; i < W * H; i++) if (!blocked[i]) free.push(i);

  // AI 出生候选：空格**且没有掩体**（见 M3-1 的说明：让 AI 生成在掩体里会卡住）
  const spawnable = free.filter((i) => coverCm[i] === 0);

  /**
   * 该格最高实心体的顶面（米）。
   * 语义 = 旧 `effectiveHeightAt`：与"谁能站上去"无关，只回答"这里最高的东西多高"。
   */
  function tallestSolidTopAt(cx, cz) {
    const r = spanRange(cx, cz);
    if (!r) return wallHeight; // 越界按墙处理（与旧实现一致）
    let top = 0;
    for (let s = r[0]; s < r[1]; s++) if (spanY1f[s] > top) top = spanY1f[s];
    return top;
  }

  /** 某点是否落在实心体内 */
  function solidAtPoint(cx, cz, y) {
    // 斜坡：坡面以下是实心（楼梯是实体），按插值高度判定。
    // 用格心近似即可 —— 这个函数只用于"射线起点是否已在实心内"和台阶吸附的探针。
    const rs = rampSurfaceAt(cx, cz, (cx + 0.5) * cell, (cz + 0.5) * cell);
    if (rs !== null && y >= 0 && y <= rs) return true;
    const r = spanRange(cx, cz);
    if (!r) return true;
    for (let s = r[0]; s < r[1]; s++) {
      if (y >= spanY0f[s] && y <= spanY1f[s]) return true;
    }
    return false;
  }

  /**
   * 站在某位置时的**地面高度**（几何版本 2 的核心查询）。
   *
   * 定义：`max{ 跨度顶面 | 顶面 <= feetY + stepHeight }`
   *
   * 为什么是这个定义（而不是"最高实心体顶面"）：
   *   碰撞层允许实体进入某格的条件正是 `feetY >= 顶面 - stepHeight`，
   *   两者互为等价变形。因此**在所有可达状态下，本函数与旧 `groundHeightAt` 结果相同** ——
   *   这就是"行为不变"可被证明的依据。
   *   若写成"最高实心体顶面"，在一层世界里没问题，但到了两层就会返回二层楼板的高度。
   */
  function surfaceAt(x, z, feetY, stepHeight) {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    const limit = feetY + stepHeight + 1e-6;
    let best = 0;
    const r = spanRange(cx, cz);
    if (r) {
      for (let s = r[0]; s < r[1]; s++) {
        const top = spanY1f[s];
        if (top <= limit && top > best) best = top;
      }
    }
    // 斜坡表面同样可以站：按世界坐标插值出该点的坡面高度。
    // 这是斜坡与跨度唯一不同的地方 —— 它的顶面不是常数。
    const rs = rampSurfaceAt(cx, cz, x, z);
    if (rs !== null && rs <= limit && rs > best) best = rs;
    return best;
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

  // 墙的渲染仍然按"每格一堵到顶的墙"处理：本步地图没有两层，
  // 所有 WALL 跨度的顶面都是 wallHeight。M3-1b-2 引入楼板后这里改为按跨度渲染。
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

  // ---------- 碰撞求解：圆 vs 网格 AABB（竖直区间感知）----------
  //
  // feetY      : 实体脚底高度
  // height     : 实体竖直高度（头顶高度 = feetY + height）。楼板/天花板靠它才能挡人。
  // stepHeight : 可迈上的高度。跨度顶面比脚底高出不超过它时**不阻挡** ——
  //              交给台阶吸附把实体抬上去，而不是把它挡在台阶前。
  //              这一条同时统一了"低掩体可迈上"与"高掩体需跳上"：
  //                低掩体 0.45，脚底 0   → 可迈上    → 不阻挡
  //                高掩体 1.05，脚底 0   → 迈不上    → 阻挡
  //                高掩体 1.05，脚底 0.7 → 可迈上    → 不阻挡（跳上去了）
  //              不需要为掩体类型写任何分支。
  //
  // ★ 两个 continue 的顺序与常数必须与几何版本 1 完全一致，否则行为会变：
  //   `feetY >= 顶面 - stepHeight - 1e-6` 这一条是从旧实现逐字搬过来的。
  function resolveCircle(pos, radius, feetY = 0, height = 0, stepHeight = 0) {
    const cx0 = Math.floor(pos.x / cell);
    const cz0 = Math.floor(pos.z / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx0 + dx;
        const gz = cz0 + dz;
        const r = spanRange(gx, gz);
        if (!r) continue;
        for (let s = r[0]; s < r[1]; s++) {
          const y0 = spanY0f[s];
          const y1 = spanY1f[s];
          // 已在跨度上方，或可以迈上去 → 不阻挡
          if (feetY >= y1 - stepHeight - 1e-6) continue;
          // 整个实体都在跨度**下方**（例如站在一层楼板底下）→ 不阻挡
          if (feetY + height <= y0) continue;

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
  }

  /** 该位置能否站人（用于台阶吸附判定）：四周没有"迈不上去"的阻挡 */
  function canStandAt(x, z, radius, feetY, height, stepHeight) {
    const probe = { x, z };
    resolveCircle(probe, radius, feetY, height, stepHeight);
    return Math.abs(probe.x - x) < 1e-4 && Math.abs(probe.z - z) < 1e-4;
  }

  // ---------- 网格射线（DDA）----------
  // 来源：M0-5 nav.js 已验证的 DDA，此处扩展为考虑竖直跨度。
  // 返回射线到实心体表面的距离；未命中返回 Infinity。
  //
  // 历史（M1-TEMP-16 已修）：原实现只在"格子入口点"判定是否落在墙高范围内，
  //   于是从墙上方斜向下射入墙体内部的射线会漏判 —— 表现为**隔墙打中敌人**。
  //
  // ★ 几何版本 2 的做法：进入某格后，对该格每个跨度求
  //     「射线在该格内的 t 区间」∩「射线 y 落在 [y0,y1] 的 t 区间」
  //   取交集的下界作为命中 t。这**同时**解决了旧实现那两条特判，
  //   而且天然支持楼板（从下方打不中、从上方能打中）与挑空区（跨层可对射）——
  //   不需要为任何一种情况写特例。
  function raycastWall(ox, oy, oz, dx, dy, dz, maxDist) {
    let cx = Math.floor(ox / cell);
    let cz = Math.floor(oz / cell);

    // 起点已在实心体内
    if (solidAtPoint(cx, cz, oy)) return 0;

    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDz = dz !== 0 ? 1 / dz : 0;

    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) * cell - ox) * invDx;
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? cz + 1 : cz) * cell - oz) * invDz;
    const tDeltaX = dx === 0 ? Infinity : cell * Math.abs(invDx);
    const tDeltaZ = dz === 0 ? Infinity : cell * Math.abs(invDz);

    for (let guard = 0; guard < (W + H) * 4; guard++) {
      let tIn;
      if (tMaxX < tMaxZ) {
        tIn = tMaxX;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        tIn = tMaxZ;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (tIn > maxDist) return Infinity;
      const tOut = Math.min(tMaxX, tMaxZ);

      const r = spanRange(cx, cz);
      let best = Infinity;
      // 斜坡：把该格视为"从 0 实心到坡面"，坡面高度按射线进入该格的位置插值。
      // 这样子弹打在楼梯上会命中，而楼梯上方的空气不会误挡。
      const px0 = ox + dx * tIn;
      const pz0 = oz + dz * tIn;
      const rampY = rampSurfaceAt(cx, cz, px0, pz0);
      if (rampY !== null && rampY > 0) {
        let lo2;
        let hi2;
        if (dy === 0) {
          if (oy <= rampY) { lo2 = 0; hi2 = Infinity; } else { lo2 = 1; hi2 = 0; }
        } else {
          const ta = (0 - oy) / dy;
          const tb = (rampY - oy) / dy;
          lo2 = Math.min(ta, tb);
          hi2 = Math.max(ta, tb);
        }
        const a2 = Math.max(tIn, lo2);
        const b2 = Math.min(tOut, hi2);
        if (a2 <= b2 && a2 <= maxDist && a2 < best) best = a2;
      }
      if (r) {
        for (let s = r[0]; s < r[1]; s++) {
          const y0 = spanY0f[s];
          const y1 = spanY1f[s];
          let lo;
          let hi;
          if (dy === 0) {
            // 水平射线：要么整个格子内都在跨度高度区间里，要么完全不在
            if (oy < y0 || oy > y1) continue;
            lo = 0;
            hi = Infinity;
          } else {
            const ta = (y0 - oy) / dy;
            const tb = (y1 - oy) / dy;
            lo = Math.min(ta, tb);
            hi = Math.max(ta, tb);
          }
          const a = Math.max(tIn, lo);
          const b = Math.min(tOut, hi);
          if (a <= b && a <= maxDist && a < best) best = a;
        }
      }
      if (best < Infinity) return best;
    }
    return Infinity;
  }

  /** 该格最高**掩体**顶面（米）。刻意不含墙 —— 这个语义是给子弹落点用的，与旧实现一致。 */
  function coverTopAt(x, z) {
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return 0;
    return coverCm[cz * W + cx] / 100;
  }

  // 地面交点距离（考虑掩体顶面）。返回 { t, y } 或 null。
  //
  // ★ 这里刻意**逐字保留旧算法**（沿射线等距采样 + 用掩体顶面求交 + 校验交点仍在同类表面上），
  //   只把"取某个 x,z 的掩体高度"这一件事换成从跨度表派生。
  //
  //   为什么不是"顺手改成更优雅的与跨度求交"：我试过，结果引入 9 条真实回归
  //   （原本能命中掩体顶面的射线变成了打到地面）。原因是旧算法里的
  //   `groundHeightAt(gx,gz) === g` 这条校验允许交点落在**相邻的同高掩体格**上，
  //   而我换成"交点必须仍在采样格内"后就把它排除掉了 —— 一个看起来更严格的判据
  //   反而弄坏了正确行为。
  //   这条经验记在这里：**"更优雅"不等于"更正确"，在有黄金基准的情况下应当先保行为。**
  //   楼板/斜坡的落点判定留到 M3-1b-2（那时地图才有这些东西）。
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
      const g = coverTopAt(x, z);
      if (g > 0 && y <= g && dy < 0) {
        // 求与该顶面的精确交点
        const tg = (g - oy) / dy;
        if (tg > 0 && tg <= maxDist && (!best || tg < best.t)) {
          const gx = ox + dx * tg;
          const gz = oz + dz * tg;
          if (coverTopAt(gx, gz) === g) best = { t: tg, y: g };
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
    W, H, cell, wallHeight, blocked, free, spawnable, worldW, worldH,
    mapId: map.id,
    // 几何模型版本。1 = 单层单高度（blocked + coverCm）；2 = 分层竖直跨度。
    // 显式标出来是为了让 M3-1b-1 的黄金基准工具能同时驱动改造前后两版实现，
    // 而不是靠"某函数是否存在"去猜该怎么调 —— 那种写法在重构中间态必然出错。
    geometryVersion: 2,
    cellToWorld, worldToCell, isBlockedCell, isPathBlockedCell,
    resolveCircle, canStandAt,
    raycastWall, raycastGround, raycastGroundFull, hasLineOfSight,
    // 几何版本 2 的查询接口。旧名 groundHeightAt / effectiveHeightAt 已被**删除**而不是保留别名：
    // 它们不接收 y，在两层的世界里必然取错层；留一个"看起来还能用"的旧名字，
    // 等于给调用方留了一条静默出错的捷径。删掉才能让所有调用点显式面对 y。
    surfaceAt, tallestSolidTopAt, solidAtPoint,
    wallCount,
    coverCm, coverList, coverMeshes, stepHeight: pathStepHeight, pathBlocked,
    // 跨度表（供调试与 M3-1b-2 使用）
    spans: { start: spanStart, y0: spanY0f, y1: spanY1f, kind: spanKindU, count: spanY0f.length },
  };
}
