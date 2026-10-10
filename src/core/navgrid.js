// 网格导航：A* / 流场 / 视线 + **寻路查询预算调度器**
//
// M3-1b-2 ②：网格从"二维格"泛化为**分层节点**（节点 = floor*W*H + cell）。
//   动机：二层的可走空间不是整个平面，而是被楼板覆盖的那部分 —— 同一个 (x,z)
//   在一层是地面、在二层可能是悬空。一个二维 blocked 表必然把两层混成一层。
//   做法：每格每层带一个**落脚高度区间**，格边要求"区间相距 ≤ stepHeight"；
//   楼梯的坡顶格上连一条跨层边。详见 createLayeredNavGrid 的注释。
//   单层地图下 floorCount=1、区间恒为 [0,0]、stepHeight 为 0，
//   所有新判据恒真 —— 与改造前逐条等价。
//
// 来源与依据：
//   A* 与流场沿用 M0-5 验证台已验证的实现（当次实测：A* 单次 0.0184ms、
//   流场全图重算 0.0718ms、视线单次 93ns）。
//   M0-5 同时实测出**最关键的结论**：当 N 个 AI 被同一事件同时触发重规划时，
//   每 Agent 独立 A* 的最坏帧达 68.29ms（6x 节流、N=400），而共享流场仅 2.38ms，
//   相差 20~30 倍，会造成 1~4 帧可见冻结。
//
// 因此本模块存在的意义不只是"提供寻路"，而是**强制限流**（M0-TECH-01 约束 C-1/C-2）：
//   禁止任何调用方直接"我要一条路径"就立刻算。所有查询一律经 QueryScheduler 排队，
//   每帧最多消耗 maxQueriesPerFrame 次查询与 maxMsPerFrame 毫秒。
// 这样即使 100 个 AI 同时被枪声惊动，也不会出现单帧卡死 —— 代价只是部分 AI 晚几帧才动。

import { mulberry32 } from '../core/rng.js';

export const DX = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const SQRT2 = 1.41421356;

/**
 * 单层网格：`createLayeredNavGrid` 在 floorCount=1 时的便捷包装。
 *
 * 保留它而不是删掉，是因为"单层"是分层模型的一个**真实退化情形**
 * （节点索引恒等于 cell），而不是历史包袱；测试也用它来证明
 * 分层实现没有把单层行为改掉。
 */
export function createNavGrid(W, H, cell, blocked) {
  const n = W * H;
  return createLayeredNavGrid({
    W, H, cell,
    floorCount: 1,
    stepHeight: 0,
    blocked,
    lo: new Float32Array(n),
    hi: new Float32Array(n),
    links: null,
  });
}

/** 分层节点编号：`floor * W*H + cell`。单层时恒等于 cell。 */
export function nodeIndex(floor, cell, W, H) {
  return floor * (W * H) + cell;
}
/** 分层节点 -> 层号 */
export function nodeFloor(node, W, H) {
  return (node / (W * H)) | 0;
}
/** 分层节点 -> 该层的 cell 索引（与 ai.js 的 cellOf 同一套编号） */
export function nodeCell(node, W, H) {
  return node % (W * H);
}

/**
 * 分层导航网格（M3-1b-2 ②）。
 *
 * 与单层网格的唯一结构差别是**节点空间**：
 *   节点 = floor * W*H + cell（floor = 0 时与旧编号完全相同）
 * 以及每条格边都要**同时**满足两个条件：
 *   ① 目标格在该层不是阻挡（墙 / 迈不过去的高掩体 / 上层悬空处）；
 *   ② 两格的落脚高度区间相距不超过 stepHeight。
 *
 * 为什么需要 ②：二层的地面标高是 3.6m。若只看"格可走"，从一层地面
 * 走进坡顶格（坡面 2.4~3.6m）会被判为合法，而实体的 y 是由
 * `level.surfaceAt` 从几何推出来的 —— 于是脚底会被**瞬间抬升 2.4m**，
 * 表现为瞬移/穿模。高度差门槛把这类边直接剪掉，不需要为楼梯写特例。
 *
 * 跨层边（楼梯）来自 `links`：只在**坡顶格**上连接相邻两层，代价为 0
 * （同一格、同一世界坐标，位移为 0；坡长已由同层的坡格序列计入）。
 * 代价为 0 也让启发式保持可采纳 —— A* 仍然给出最短路径。
 */
export function createLayeredNavGrid(spec) {
  const { W, H, cell, blocked, lo, hi } = spec;
  const floorCount = spec.floorCount ?? 1;
  const stepHeight = spec.stepHeight ?? 0;
  const cellCount = W * H;
  const size = floorCount * cellCount;
  if (blocked.length !== size) {
    throw new Error(`[navgrid] blocked 长度 ${blocked.length} 与 floorCount*W*H ${size} 不符`);
  }
  if (lo.length !== size || hi.length !== size) {
    throw new Error(`[navgrid] 落脚高度区间长度 ${lo.length}/${hi.length} 与节点数 ${size} 不符`);
  }

  // 跨层边的 CSR（与关卡几何一样用扁平数组，避免对象数组的指针追逐）
  const links = spec.links || [];
  const linkStart = new Int32Array(size + 1);
  const linkTo = new Int32Array(links.length * 2);
  for (const [a, b] of links) {
    linkStart[a + 1]++;
    linkStart[b + 1]++;
  }
  for (let i = 0; i < size; i++) linkStart[i + 1] += linkStart[i];
  {
    const cursor = Int32Array.from(linkStart.subarray(0, size));
    for (const [a, b] of links) {
      linkTo[cursor[a]++] = b;
      linkTo[cursor[b]++] = a;
    }
  }

  return {
    W, H, cell, floorCount, cellCount, size, stepHeight,
    blocked, lo, hi, linkStart, linkTo, linkCount: links.length,
  };
}

/** 网格 DDA 视线：两点之间是否无遮挡 */
export function makeLos(grid) {
  const { W, H, cell, blocked } = grid;
  return function los(x0, z0, x1, z1) {
    let cx = Math.floor(x0 / cell);
    let cz = Math.floor(z0 / cell);
    const ex = Math.min(W - 1, Math.max(0, Math.floor(x1 / cell)));
    const ez = Math.min(H - 1, Math.max(0, Math.floor(z1 / cell)));
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return false;

    const dx = x1 - x0;
    const dz = z1 - z0;
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDz = dz !== 0 ? 1 / dz : 0;

    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) * cell - x0) * invDx;
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? cz + 1 : cz) * cell - z0) * invDz;
    const tDeltaX = dx === 0 ? Infinity : cell * Math.abs(invDx);
    const tDeltaZ = dz === 0 ? Infinity : cell * Math.abs(invDz);

    for (let guard = 0; guard < W + H + 4; guard++) {
      if (blocked[cz * W + cx]) return false;
      if (cx === ex && cz === ez) return true;
      if (tMaxX < tMaxZ) {
        if (tMaxX > 1) return true;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        if (tMaxZ > 1) return true;
        cz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (cx < 0 || cz < 0 || cx >= W || cz >= H) return false;
    }
    return false;
  };
}

/**
 * A* 求解器。所有状态用 TypedArray + 世代戳复用，堆预分配，目标是每帧零分配。
 *
 * M3-1b-2 ②：从"二维格"泛化为"分层节点"（节点 = floor*W*H + cell）。
 * 单层网格下 cellCount == N、所有 lo/hi == 0、stepHeight == 0，
 * 因此每条新加的判据都恒真 —— 行为与改造前**结构性等价**，不是靠特判维持。
 */
export function createAStar(grid) {
  const { W, H, blocked, lo, hi, stepHeight, linkStart, linkTo } = grid;
  const cellCount = grid.cellCount ?? W * H;
  const N = grid.size ?? W * H;
  const gScore = new Float32Array(N);
  const cameFrom = new Int32Array(N);
  const seenGen = new Int32Array(N);
  const closedGen = new Int32Array(N);
  let gen = 0;

  const CAP = N * 8;
  const hNode = new Int32Array(CAP);
  const hKey = new Float32Array(CAP);
  let heapSize = 0;

  /**
   * 两格的落脚高度区间是否接得上（相距不超过 stepHeight）。
   * 区间相交或相接时差值为负 → 必然通过。
   * 单层地图里 lo = hi = 0 且 stepHeight = 0，因此恒真。
   */
  function stepOk(a, b) {
    return Math.max(lo[a] - hi[b], lo[b] - hi[a]) <= stepHeight + 1e-6;
  }

  function heapPush(node, key) {
    if (heapSize >= CAP) return;
    let i = heapSize++;
    hNode[i] = node;
    hKey[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hKey[p] <= hKey[i]) break;
      const tn = hNode[p], tk = hKey[p];
      hNode[p] = hNode[i]; hKey[p] = hKey[i];
      hNode[i] = tn; hKey[i] = tk;
      i = p;
    }
  }

  function heapPop() {
    const top = hNode[0];
    heapSize--;
    if (heapSize > 0) {
      hNode[0] = hNode[heapSize];
      hKey[0] = hKey[heapSize];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && hKey[l] < hKey[m]) m = l;
        if (r < heapSize && hKey[r] < hKey[m]) m = r;
        if (m === i) break;
        const tn = hNode[m], tk = hKey[m];
        hNode[m] = hNode[i]; hKey[m] = hKey[i];
        hNode[i] = tn; hKey[i] = tk;
        i = m;
      }
    }
    return top;
  }

  const pathBuf = new Int32Array(N);

  /** @returns {{buf:Int32Array, len:number}} len=0 表示无路径 */
  function findPath(startNode, goalNode) {
    if (blocked[startNode] || blocked[goalNode]) return { buf: pathBuf, len: 0 };
    gen++;
    heapSize = 0;
    const gFloor = (goalNode / cellCount) | 0;
    const gCell = goalNode - gFloor * cellCount;
    const gx = gCell % W;
    const gz = (gCell / W) | 0;

    seenGen[startNode] = gen;
    gScore[startNode] = 0;
    cameFrom[startNode] = -1;
    heapPush(startNode, 0);

    let found = false;
    while (heapSize > 0) {
      const cur = heapPop();
      if (closedGen[cur] === gen) continue;
      closedGen[cur] = gen;
      if (cur === goalNode) {
        found = true;
        break;
      }
      const base = ((cur / cellCount) | 0) * cellCount;
      const cCell = cur - base;
      const cx = cCell % W;
      const cz = (cCell / W) | 0;
      const gc = gScore[cur];

      // 同层 8 邻接
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const nz = cz + DY[k];
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const ni = base + nz * W + nx;
        if (blocked[ni]) continue;
        if (!stepOk(cur, ni)) continue;
        const diag = k >= 4;
        if (diag) {
          const s1 = base + cz * W + nx;
          const s2 = base + nz * W + cx;
          if (blocked[s1] || blocked[s2]) continue;
          // 对角两侧的落脚面也必须接得上，否则会"斜穿"过一段爬不上去的高度差
          if (!stepOk(cur, s1) || !stepOk(cur, s2)) continue;
        }
        const ng = gc + (diag ? SQRT2 : 1);
        if (seenGen[ni] !== gen || ng < gScore[ni]) {
          seenGen[ni] = gen;
          gScore[ni] = ng;
          cameFrom[ni] = cur;
          const hx = Math.abs(nx - gx);
          const hz = Math.abs(nz - gz);
          heapPush(ni, ng + hx + hz + (SQRT2 - 2) * Math.min(hx, hz));
        }
      }

      // 跨层边（楼梯坡顶）。代价为 0 —— 同一格、同一世界坐标，几何位移为 0；
      // 也正因为它非负且为 0，水平 octile 距离仍是真实代价的下界（启发式可采纳，
      // A* 的最优性不变），因此这里不需要给 h 补一个层差项。
      for (let e = linkStart[cur]; e < linkStart[cur + 1]; e++) {
        const ni = linkTo[e];
        if (blocked[ni]) continue;
        const ng = gc;
        if (seenGen[ni] !== gen || ng < gScore[ni]) {
          seenGen[ni] = gen;
          gScore[ni] = ng;
          cameFrom[ni] = cur;
          const nCell = ni - ((ni / cellCount) | 0) * cellCount;
          const nx = nCell % W;
          const nz = (nCell / W) | 0;
          const hx = Math.abs(nx - gx);
          const hz = Math.abs(nz - gz);
          heapPush(ni, ng + hx + hz + (SQRT2 - 2) * Math.min(hx, hz));
        }
      }
    }

    if (!found) return { buf: pathBuf, len: 0 };
    let len = 0;
    let c = goalNode;
    while (c !== -1 && len < N) {
      pathBuf[len++] = c;
      c = cameFrom[c];
    }
    for (let i = 0, j = len - 1; i < j; i++, j--) {
      const t = pathBuf[i];
      pathBuf[i] = pathBuf[j];
      pathBuf[j] = t;
    }
    return { buf: pathBuf, len };
  }

  return findPath;
}

/**
 * 寻路查询预算调度器 —— 本模块的核心，对应约束 C-1/C-2。
 *
 * 用法：
 *   const ticket = scheduler.request(agentId, fromCell, toCell);
 *   scheduler.beginFrame(nowMs);
 *   const done = scheduler.processFrame();   // 内部限时限量
 *   // 通过 scheduler.takeResult(agentId) 取回结果
 *
 * 设计要点：
 *   - 同一 agent 重复请求只保留最新一个（旧目标已过期，没必要算两次）
 *   - 每帧同时受"查询次数"和"耗时"两个上限约束，任一触顶即停
 *   - 被跳过的请求留在队列里，下一帧继续 —— 表现为 AI 稍晚几帧才起步，而不是卡帧
 */
export function createPathScheduler(findPath, budget) {
  const pending = new Map(); // agentId -> {startCell, goalCell, seq}
  const results = new Map(); // agentId -> {buf copy, len, seq}
  const queue = [];
  let seq = 0;

  const stats = {
    requestedThisFrame: 0,
    processedThisFrame: 0,
    droppedThisFrame: 0,
    lastFrameMs: 0,
    peakFrameMs: 0,
    peakQueriesPerFrame: 0,
    totalProcessed: 0,
    deferrals: 0,
  };

  function request(agentId, startCell, goalCell) {
    // startCell / goalCell 实际是**分层节点编号**（floor*W*H + cell）。
    // 单层地图下它与旧的格索引是同一个数，因此调度器不需要为分层做任何改动：
    // 它只负责"排队 + 限流"，不关心节点空间长什么样。
    seq++;
    // 同 agent 的旧请求直接丢弃（目标已变，算它没意义）
    if (pending.has(agentId)) {
      pending.get(agentId).superseded = true;
    } else {
      queue.push(agentId);
    }
    pending.set(agentId, { startCell, goalCell, seq });
    stats.requestedThisFrame++;
  }

  function processFrame() {
    const t0 = performance.now();
    let processed = 0;
    stats.requestedThisFrame = 0;
    const maxQ = budget.maxQueriesPerFrame;
    const maxMs = budget.maxMsPerFrame;

    while (queue.length > 0 && processed < maxQ) {
      if (performance.now() - t0 >= maxMs) break;

      const agentId = queue.shift();
      const req = pending.get(agentId);
      if (!req || req.superseded) {
        // 已被更新的请求取代，无需计算
        if (req && req.superseded) pending.delete(agentId);
        stats.droppedThisFrame++;
        continue;
      }
      pending.delete(agentId);
      const r = findPath(req.startCell, req.goalCell);
      const copy = Int32Array.from(r.buf.subarray(0, r.len));
      results.set(agentId, { buf: copy, len: r.len, seq: req.seq });
      processed++;
      stats.totalProcessed++;
    }

    // 队列里还有剩的，说明本帧预算用完了 —— 记为一次延后
    if (queue.length > 0) stats.deferrals += queue.length;

    stats.processedThisFrame = processed;
    stats.lastFrameMs = performance.now() - t0;
    if (stats.lastFrameMs > stats.peakFrameMs) stats.peakFrameMs = stats.lastFrameMs;
    if (processed > stats.peakQueriesPerFrame) stats.peakQueriesPerFrame = processed;
    return processed;
  }

  return {
    request,
    processFrame,
    stats,
    pendingCount: () => pending.size,
    queueLength: () => queue.length,
    /** 取回结果；取走后即清除（一次性消费） */
    takeResult(agentId) {
      const r = results.get(agentId);
      if (!r) return null;
      results.delete(agentId);
      return r;
    },
    reset() {
      pending.clear();
      results.clear();
      queue.length = 0;
    },
  };
}

/** 依据 AI 与玩家的距离选取更新分级（硬性要求：远处 AI 必须降频） */
export function pickUpdateTier(tiers, distanceM) {
  for (const t of tiers) {
    if (distanceM <= t.maxDistanceM) return t;
  }
  return tiers[tiers.length - 1];
}

/** 生成错峰的首次到期时间，避免所有 AI 在同一帧集中触发 */
export function jitteredDeadline(nowMs, intervalMs, jitterMs, rnd) {
  return nowMs + intervalMs + rnd() * jitterMs;
}

export { mulberry32 };
