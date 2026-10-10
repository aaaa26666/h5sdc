// 网格导航：A* / 流场 / 视线 + **寻路查询预算调度器**
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

export function createNavGrid(W, H, cell, blocked) {
  return { W, H, cell, blocked, size: W * H };
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

/** A* 求解器。所有状态用 TypedArray + 世代戳复用，堆预分配，目标是每帧零分配 */
export function createAStar(grid) {
  const { W, H, blocked } = grid;
  const N = W * H;
  const gScore = new Float32Array(N);
  const cameFrom = new Int32Array(N);
  const seenGen = new Int32Array(N);
  const closedGen = new Int32Array(N);
  let gen = 0;

  const CAP = N * 8;
  const hNode = new Int32Array(CAP);
  const hKey = new Float32Array(CAP);
  let heapSize = 0;

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
  function findPath(startCell, goalCell) {
    if (blocked[startCell] || blocked[goalCell]) return { buf: pathBuf, len: 0 };
    gen++;
    heapSize = 0;
    const gx = goalCell % W;
    const gz = (goalCell / W) | 0;

    seenGen[startCell] = gen;
    gScore[startCell] = 0;
    cameFrom[startCell] = -1;
    heapPush(startCell, 0);

    let found = false;
    while (heapSize > 0) {
      const cur = heapPop();
      if (closedGen[cur] === gen) continue;
      closedGen[cur] = gen;
      if (cur === goalCell) {
        found = true;
        break;
      }
      const cx = cur % W;
      const cz = (cur / W) | 0;
      const gc = gScore[cur];
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const nz = cz + DY[k];
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const ni = nz * W + nx;
        if (blocked[ni]) continue;
        const diag = k >= 4;
        if (diag && (blocked[cz * W + nx] || blocked[nz * W + cx])) continue;
        const ng = gc + (diag ? SQRT2 : 1);
        if (seenGen[ni] !== gen || ng < gScore[ni]) {
          seenGen[ni] = gen;
          gScore[ni] = ng;
          cameFrom[ni] = cur;
          const hx = Math.abs(nx - gx);
          const hz = Math.abs(nz - gz);
          const hh = hx + hz + (SQRT2 - 2) * Math.min(hx, hz);
          heapPush(ni, ng + hh);
        }
      }
    }

    if (!found) return { buf: pathBuf, len: 0 };
    let len = 0;
    let c = goalCell;
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
