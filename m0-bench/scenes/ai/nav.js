// M0-5 寻路验证代码（一次性，用完即弃，不属于游戏产物）。
// 目的：在目标机上量出三种方案的每帧成本，据此决定 M1 之后的 AI 架构。
//   方案 A：每 Agent 独立 A*（网格，八向，禁止穿角）
//   方案 B：共享流场（BFS 一次，全体 Agent 读梯度）
//   专项  ：视线检测（网格 DDA 射线），FPS 里这部分常被低估
import { mulberry32 } from '../bench.js';

// 八邻域：先四个正交，再四个对角，便于用 k>=4 判定对角
export const DX = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const OPP = [1, 0, 3, 2, 7, 6, 5, 4];
const SQRT2 = 1.41421356;

/** 生成确定性网格地图 */
export function makeGrid(W, H, cellSize, seed, blockRatio) {
  const rnd = mulberry32(seed);
  const blocked = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const border = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      blocked[y * W + x] = border || rnd() < blockRatio ? 1 : 0;
    }
  }
  return { W, H, cellSize, blocked };
}

/** 收集可通行格子，供 Agent 出生点与目标点使用 */
export function collectFree(grid) {
  const { W, H, blocked } = grid;
  const out = [];
  for (let i = 0; i < W * H; i++) if (!blocked[i]) out.push(i);
  return out;
}

/** 网格 DDA 视线检测：返回两点之间是否无遮挡 */
export function makeLos(grid) {
  const { W, H, cellSize, blocked } = grid;
  return function los(x0, y0, x1, y1) {
    let cx = Math.floor(x0 / cellSize);
    let cy = Math.floor(y0 / cellSize);
    const ex = Math.min(W - 1, Math.max(0, Math.floor(x1 / cellSize)));
    const ey = Math.min(H - 1, Math.max(0, Math.floor(y1 / cellSize)));
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const invDx = dx !== 0 ? 1 / dx : 0;
    const invDy = dy !== 0 ? 1 / dy : 0;

    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cx + 1 : cx) * cellSize - x0) * invDx;
    let tMaxY = dy === 0 ? Infinity : ((dy > 0 ? cy + 1 : cy) * cellSize - y0) * invDy;
    const tDeltaX = dx === 0 ? Infinity : cellSize * Math.abs(invDx);
    const tDeltaY = dy === 0 ? Infinity : cellSize * Math.abs(invDy);

    for (let guard = 0; guard < W + H + 4; guard++) {
      if (blocked[cy * W + cx]) return false;
      if (cx === ex && cy === ey) return true;
      if (tMaxX < tMaxY) {
        if (tMaxX > 1) return true;
        cx += stepX;
        tMaxX += tDeltaX;
      } else {
        if (tMaxY > 1) return true;
        cy += stepY;
        tMaxY += tDeltaY;
      }
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return false;
    }
    return false;
  };
}

/**
 * 方案 A：A* 寻路器。
 * 关键实现约束：所有状态用 TypedArray + 世代戳复用，堆也预分配，
 * 目标是把"每帧分配"降到零，否则 GC 抖动会污染压测数据。
 */
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
    const gy = (goalCell / W) | 0;

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
      const cy = (cur / W) | 0;
      const gc = gScore[cur];
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (blocked[ni]) continue;
        const diag = k >= 4;
        // 禁止贴角穿越
        if (diag && (blocked[cy * W + nx] || blocked[ny * W + cx])) continue;
        const ng = gc + (diag ? SQRT2 : 1);
        if (seenGen[ni] !== gen || ng < gScore[ni]) {
          seenGen[ni] = gen;
          gScore[ni] = ng;
          cameFrom[ni] = cur;
          const hx = Math.abs(nx - gx);
          const hy = Math.abs(ny - gy);
          const hh = hx + hy + (SQRT2 - 2) * Math.min(hx, hy);
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
 * 方案 B：共享流场。一次 BFS 覆盖全图，任意多个 Agent 读同一份梯度。
 * 适合"大量 Agent 追同一个目标"的场景；对"每人不同目标"则不适用。
 */
export function createFlowField(grid) {
  const { W, H, blocked } = grid;
  const N = W * H;
  const dist = new Int32Array(N);
  const dirIdx = new Int8Array(N);
  const queue = new Int32Array(N);

  function compute(goalCell) {
    dist.fill(-1);
    dirIdx.fill(-1);
    if (blocked[goalCell]) return false;
    let head = 0;
    let tail = 0;
    dist[goalCell] = 0;
    queue[tail++] = goalCell;
    while (head < tail) {
      const c = queue[head++];
      const cx = c % W;
      const cy = (c / W) | 0;
      const nd = dist[c] + 1;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (blocked[ni] || dist[ni] !== -1) continue;
        const diag = k >= 4;
        if (diag && (blocked[cy * W + nx] || blocked[ny * W + cx])) continue;
        dist[ni] = nd;
        // 方向指向"走向 c"，即与 k 相反的方向
        dirIdx[ni] = OPP[k];
        queue[tail++] = ni;
      }
    }
    return true;
  }

  // dirIdx 必须暴露给调用方读取梯度，否则无法驱动 Agent
  return { compute, dirIdx };
}

/** 供流场方案使用：取某格子的下一步格子，-1 表示无法前进 */
export function flowNext(dirIdx, W, cell) {
  const d = dirIdx[cell];
  if (d < 0) return -1;
  return cell + DY[d] * W + DX[d];
}
