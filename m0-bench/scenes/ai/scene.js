// M0-5 AI 寻路与同屏数量压测场景（一次性验证代码，用完即弃）。
// 目的：量出「每帧 AI 成本」的构成与规模，据此决定同屏 AI 上限与寻路方案。
// URL 参数：
//   n=100          Agent 数量
//   pf=astar|flow  寻路方案
//   walls=1        是否渲染墙体（0 可把渲染成本从 AI 成本里剥离出来）
//   replanMs=500   单 Agent 重新寻路间隔
//   losMs=100      单 Agent 视线检测间隔
//   sync=0|1       每帧 gl.finish()
import * as THREE from '/vendor/three.module.js';
import {
  readGlInfo,
  runBenchmark,
  calibrateRafCap,
} from '../bench.js';
import { makeGrid, collectFree, makeLos, createAStar, createFlowField, flowNext } from './nav.js';

const qs = new URLSearchParams(location.search);
const AGENT_COUNT = Number(qs.get('n') || 100);
const PF_MODE = qs.get('pf') || 'astar';
const DRAW_WALLS = qs.get('walls') !== '0';
const REPLAN_MS = Number(qs.get('replanMs') || 500);
const LOS_MS = Number(qs.get('losMs') || 100);
const SYNC = qs.get('sync') === '1';

const GRID_W = 48;
const GRID_H = 48;
const CELL = 2.5;
const MAXPATH = 600;
const SPEED = 3.2;        // 世界单位/秒
const LOS_RANGE = 28;     // 视线检测距离上限

const SEED = 20260101;
const SPEC = {
  seed: SEED,
  particles: { count: 400, size: 0.35, spread: 60, riseSpeed: 2.0, wrapHeight: 25 },
  lighting: { shadows: true, shadowMapSize: 1024, directionalIntensity: 2.0, ambientIntensity: 0.35 },
  camera: { fov: 75, near: 0.1, far: 400, orbitRadius: 60, orbitSpeed: 0.1, height: 45, lookAtHeight: 6 },
  render: { antialias: true, pixelRatio: 1, clearColor: '#101418' },
};

const hud = document.getElementById('hud');
const tNav = performance.now();

// ---------- 导航数据 ----------
// 两种方案都构造：主循环按 PF_MODE 选用，微基准则两者都测，便于横向比较
const grid = makeGrid(GRID_W, GRID_H, CELL, SEED, 0.22);
const free = collectFree(grid);
const los = makeLos(grid);
const findPath = createAStar(grid);
const flow = createFlowField(grid);
let flowGoalCell = free[0];
let lastFlowAt = -1e9;

// ---------- 引擎与场景 ----------
const tEngine0 = performance.now();
const renderer = new THREE.WebGLRenderer({ antialias: SPEC.render.antialias, powerPreference: 'high-performance', stencil: false });
renderer.setPixelRatio(SPEC.render.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = SPEC.lighting.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const engineInitMs = performance.now() - tEngine0;

const tBuild0 = performance.now();
const scene = new THREE.Scene();
scene.background = new THREE.Color(SPEC.render.clearColor);
const camera = new THREE.PerspectiveCamera(SPEC.camera.fov, window.innerWidth / window.innerHeight, SPEC.camera.near, SPEC.camera.far);

const amb = new THREE.AmbientLight(0xffffff, SPEC.lighting.ambientIntensity);
scene.add(amb);
const dir = new THREE.DirectionalLight(0xffffff, SPEC.lighting.directionalIntensity);
dir.position.set(40, 90, 30);
dir.castShadow = SPEC.lighting.shadows;
dir.shadow.mapSize.set(SPEC.lighting.shadowMapSize, SPEC.lighting.shadowMapSize);
const sc = dir.shadow.camera;
sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 400;
sc.updateProjectionMatrix();
scene.add(dir);
scene.add(dir.target);

// 地面
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GRID_W * CELL, GRID_H * CELL),
  new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.95, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.set((GRID_W * CELL) / 2, 0, (GRID_H * CELL) / 2);
ground.receiveShadow = true;
scene.add(ground);

// 墙体：一律独立 Mesh，不做实例化/合并，代表"未优化"的基线
let wallCount = 0;
if (DRAW_WALLS) {
  const wallGeo = new THREE.BoxGeometry(CELL, 4, CELL);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a5560, roughness: 0.85, metalness: 0 });
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    if (!grid.blocked[i]) continue;
    const x = i % GRID_W;
    const y = (i / GRID_W) | 0;
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set((x + 0.5) * CELL, 2, (y + 0.5) * CELL);
    m.castShadow = SPEC.lighting.shadows;
    m.receiveShadow = true;
    scene.add(m);
    wallCount++;
  }
}

// Agent 网格体：按状态改颜色，方便肉眼确认行为正确
const agentGeo = new THREE.BoxGeometry(1.2, 1.8, 1.2);
const agentMatIdle = new THREE.MeshStandardMaterial({ color: 0x8a9aa8, roughness: 0.6, metalness: 0 });
const agentMatEngaged = new THREE.MeshStandardMaterial({ color: 0xff5a4a, roughness: 0.6, metalness: 0 });
const agentMeshes = [];
for (let i = 0; i < AGENT_COUNT; i++) {
  const m = new THREE.Mesh(agentGeo, agentMatIdle);
  m.castShadow = SPEC.lighting.shadows;
  scene.add(m);
  agentMeshes.push(m);
}

// 玩家（AI 的感知目标）
const playerMesh = new THREE.Mesh(
  new THREE.BoxGeometry(1.4, 2.0, 1.4),
  new THREE.MeshStandardMaterial({ color: 0x6fb3ff, roughness: 0.5, metalness: 0.1 })
);
playerMesh.castShadow = SPEC.lighting.shadows;
scene.add(playerMesh);
const sceneBuildMs = performance.now() - tBuild0;

// ---------- Agent 初始化 ----------
const rnd = (() => {
  let a = SEED >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const agents = [];
for (let i = 0; i < AGENT_COUNT; i++) {
  const cell = free[Math.floor(rnd() * free.length)];
  const now0 = performance.now();
  agents.push({
    cell,
    x: ((cell % GRID_W) + 0.5) * CELL,
    z: (((cell / GRID_W) | 0) + 0.5) * CELL,
    goalCell: free[Math.floor(rnd() * free.length)],
    path: new Int32Array(MAXPATH),
    pathLen: 0,
    pathIdx: 0,
    // 错开首次触发时间：避免所有 Agent 在同一帧集中寻路（真实 AI 调度也会这样错峰）
    lastReplan: now0 - rnd() * REPLAN_MS,
    lastLos: now0 - rnd() * LOS_MS,
    engaged: false,
  });
}

const camPos = { x: 0, y: 0, z: 0 };
let prevNow = 0;
let firstFrameMs = -1;
let lastHud = 0;
let hudFrames = 0;
let playerX = 0;
let playerZ = 0;
let playerCell = free[0];

// 分阶段计时累加器（仅在采样窗口内记录）
let rec = null;
const blankRec = () => ({ pf: [], los: [], move: [], render: [], frame: [] });
rec = blankRec();

function stats(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  let sum = 0;
  for (const v of arr) sum += v;
  // max 必须报告：AI 成本是尖峰型的，单帧集中重规划会造成可见卡顿，
  // 而 p95 会把这种尖峰平均掉。
  return {
    p50: +at(0.5).toFixed(4),
    p95: +at(0.95).toFixed(4),
    max: +s[s.length - 1].toFixed(4),
    mean: +(sum / arr.length).toFixed(4),
  };
}

function step(now) {
  const t = now / 1000;
  const dt = prevNow === 0 ? 1 / 60 : Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  // 玩家沿确定性圆周运动
  const cxw = (GRID_W * CELL) / 2;
  const czw = (GRID_H * CELL) / 2;
  playerX = cxw + Math.cos(t * 0.35) * 22;
  playerZ = czw + Math.sin(t * 0.35) * 22;
  playerMesh.position.set(playerX, 1.0, playerZ);
  playerCell = (((playerZ / CELL) | 0) * GRID_W + ((playerX / CELL) | 0));

  let pfT = 0;
  let losT = 0;
  let moveT = 0;

  // 流场模式：按 replanMs 整体重算一次，全体 Agent 共用同一份梯度
  if (PF_MODE === 'flow' && now - lastFlowAt >= REPLAN_MS) {
    lastFlowAt = now;
    const tp = performance.now();
    if (!grid.blocked[playerCell]) flowGoalCell = playerCell;
    flow.compute(flowGoalCell);
    pfT += performance.now() - tp;
  }

  // ---- AI ----
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];

    // 重新寻路（按间隔触发，而不是每帧）
    if (now - a.lastReplan >= REPLAN_MS) {
      a.lastReplan = now;
      const tp = performance.now();
      if (PF_MODE === 'astar') {
        const r = findPath(a.cell, a.goalCell);
        a.pathLen = Math.min(r.len, MAXPATH);
        for (let k = 0; k < a.pathLen; k++) a.path[k] = r.buf[k];
        a.pathIdx = 0;
      }
      pfT += performance.now() - tp;
    }

    // 视线检测（先做距离粗筛，再做射线，符合真实 AI 做法）
    if (now - a.lastLos >= LOS_MS) {
      a.lastLos = now;
      const tl = performance.now();
      const dxp = playerX - a.x;
      const dzp = playerZ - a.z;
      a.engaged = dxp * dxp + dzp * dzp <= LOS_RANGE * LOS_RANGE ? los(a.x, a.z, playerX, playerZ) : false;
      losT += performance.now() - tl;
    }

    // 移动
    const tm = performance.now();
    let tx = a.x;
    let tz = a.z;
    if (PF_MODE === 'astar') {
      if (a.pathLen > 0 && a.pathIdx < a.pathLen) {
        let c = a.path[a.pathIdx];
        tx = ((c % GRID_W) + 0.5) * CELL;
        tz = (((c / GRID_W) | 0) + 0.5) * CELL;
        const ddx = tx - a.x;
        const ddz = tz - a.z;
        if (ddx * ddx + ddz * ddz < 0.16) {
          a.pathIdx++;
          if (a.pathIdx < a.pathLen) {
            c = a.path[a.pathIdx];
            tx = ((c % GRID_W) + 0.5) * CELL;
            tz = (((c / GRID_W) | 0) + 0.5) * CELL;
          }
        }
      }
    } else {
      const nxt = flowNext(flow.dirIdx, GRID_W, a.cell);
      if (nxt >= 0) {
        tx = ((nxt % GRID_W) + 0.5) * CELL;
        tz = (((nxt / GRID_W) | 0) + 0.5) * CELL;
      }
    }
    const vdx = tx - a.x;
    const vdz = tz - a.z;
    const dist2 = vdx * vdx + vdz * vdz;
    if (dist2 > 1e-6) {
      const inv = 1 / Math.sqrt(dist2);
      const stepLen = Math.min(SPEED * dt, Math.sqrt(dist2));
      a.x += vdx * inv * stepLen;
      a.z += vdz * inv * stepLen;
    }
    const newCell = (((a.z / CELL) | 0) * GRID_W + ((a.x / CELL) | 0));
    if (newCell >= 0 && newCell < GRID_W * GRID_H && !grid.blocked[newCell]) a.cell = newCell;

    // 到达目标则换一个目标（流场模式下目标是共享的，不逐个换目标）
    if (PF_MODE === 'astar' && a.cell === a.goalCell) {
      a.goalCell = free[Math.floor(rnd() * free.length)];
      a.lastReplan = -1e9;
    }

    const mesh = agentMeshes[i];
    mesh.position.set(a.x, 0.9, a.z);
    if (mesh.material !== (a.engaged ? agentMatEngaged : agentMatIdle)) {
      mesh.material = a.engaged ? agentMatEngaged : agentMatIdle;
    }
    moveT += performance.now() - tm;
  }

  // ---- 渲染 ----
  const tr = performance.now();
  const c = SPEC.camera;
  camPos.x = cxw + Math.cos(t * c.orbitSpeed) * c.orbitRadius;
  camPos.z = czw + Math.sin(t * c.orbitSpeed) * c.orbitRadius;
  camPos.y = c.height;
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(cxw, c.lookAtHeight, czw);
  renderer.render(scene, camera);
  if (SYNC) renderer.getContext().finish();
  const renderT = performance.now() - tr;

  if (rec) {
    rec.pf.push(pfT);
    rec.los.push(losT);
    rec.move.push(moveT);
    rec.render.push(renderT);
  }

  if (firstFrameMs < 0) firstFrameMs = performance.now();

  hudFrames++;
  if (now - lastHud > 500) {
    const fps = (hudFrames * 1000) / (now - lastHud);
    let engaged = 0;
    for (const a of agents) if (a.engaged) engaged++;
    hud.textContent = `M0-5 AI 压测\nagents ${agents.length}  engaged ${engaged}\npf ${PF_MODE}  walls ${DRAW_WALLS ? wallCount : 'off'}\nfps ${fps.toFixed(1)}`;
    lastHud = now;
    hudFrames = 0;
  }
}

step(performance.now());
prevNow = 0;

window.__benchInfo = {
  engine: 'three-ai',
  engineVersion: String(THREE.REVISION),
  gl: readGlInfo(),
  agentCount: AGENT_COUNT,
  pfMode: PF_MODE,
  walls: DRAW_WALLS ? wallCount : 0,
  replanMs: REPLAN_MS,
  losMs: LOS_MS,
  syncMode: SYNC,
  engineInitMs: +engineInitMs.toFixed(2),
  sceneBuildMs: +sceneBuildMs.toFixed(2),
  firstFrameMs: +firstFrameMs.toFixed(2),
  firstFrameFromNavMs: +performance.now().toFixed(2),
  grid: { W: GRID_W, H: GRID_H, cell: CELL, freeCells: free.length },
  navStartOffsetMs: +tNav.toFixed(2),
};

window.__benchRun = (cfg) =>
  runBenchmark({
    warmupMs: cfg.warmupMs,
    durationMs: cfg.durationMs,
    step,
    onWindowStart: () => {
      rec = blankRec();
    },
    onWindowEnd: () => {
      const out = {
        pf: stats(rec.pf),
        los: stats(rec.los),
        move: stats(rec.move),
        render: stats(rec.render),
      };
      rec = null;
      return out;
    },
  });

window.__benchCalibrate = () => calibrateRafCap(1000);

/**
 * 批量微基准：测量"单次操作"的成本。
 * 为什么必须有：per-frame 累加计时器受 performance.now() 精度限制，
 * 低于一个计时器刻度的开销会量成 0。批量执行 N 次再相除可以绕开这个限制，
 * 得到与计时器分辨率无关的单次成本，从而可以按任意 N 解析推算 AI 预算。
 */
window.__benchMicro = () => {
  const out = {};

  // 计时器实际分辨率自检（本项必须一并报告，否则无法判断数据是否可信）
  let resMin = Infinity;
  let prevT = performance.now();
  for (let i = 0; i < 200000; i++) {
    const n = performance.now();
    const d = n - prevT;
    if (d > 0 && d < resMin) resMin = d;
    prevT = n;
  }
  out.timerResolutionMs = +resMin.toFixed(6);

  // A* 单次查询
  const A_ITERS = 3000;
  let lenAcc = 0;
  let t0 = performance.now();
  for (let i = 0; i < A_ITERS; i++) {
    const s = free[(i * 37) % free.length];
    const g = free[(i * 91 + 13) % free.length];
    lenAcc += findPath(s, g).len;
  }
  const aTotal = performance.now() - t0;
  out.astar = {
    iters: A_ITERS,
    totalMs: +aTotal.toFixed(3),
    perQueryMs: +(aTotal / A_ITERS).toFixed(6),
    avgPathCells: +(lenAcc / A_ITERS).toFixed(1),
  };

  // 流场单次全图重算
  const F_ITERS = 300;
  t0 = performance.now();
  for (let i = 0; i < F_ITERS; i++) flow.compute(free[(i * 53) % free.length]);
  const fTotal = performance.now() - t0;
  out.flow = {
    iters: F_ITERS,
    totalMs: +fTotal.toFixed(3),
    perComputeMs: +(fTotal / F_ITERS).toFixed(6),
    cells: GRID_W * GRID_H,
  };

  // 视线检测单次射线
  const L_ITERS = 200000;
  const R = 24;
  t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < L_ITERS; i++) {
    const ang = (i * 0.618) % 6.2831853;
    const cx = ((i % 47) + 0.5) * CELL;
    const cz = (((i / 47) | 0) % 47 + 0.5) * CELL;
    if (los(cx, cz, cx + Math.cos(ang) * R, cz + Math.sin(ang) * R)) hits++;
  }
  const lTotal = performance.now() - t0;
  out.los = {
    iters: L_ITERS,
    totalMs: +lTotal.toFixed(3),
    perRayMs: +(lTotal / L_ITERS).toFixed(6),
    hitRate: +(hits / L_ITERS).toFixed(3),
  };

  return out;
};

window.__benchReady = true;
