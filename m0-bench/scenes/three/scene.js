// M0-2 等价场景 · Three.js 端
// 严格遵守 scenes/spec.json，另一端 Babylon 使用同一份规格。
// 用完即弃，不属于游戏产物。
import * as THREE from '/vendor/three.module.js';
import {
  buildLayout,
  createFrameState,
  computeCamera,
  drawChecker,
  readGlInfo,
  runBenchmark,
  calibrateRafCap,
} from '../bench.js';

const hud = document.getElementById('hud');
const tNav = performance.now();

const spec = await fetch('/scenes/spec.json').then((r) => r.json());
const layout = buildLayout(spec);
const advance = createFrameState(spec, layout);

// ---------- 引擎初始化 ----------
const tEngine0 = performance.now();
const renderer = new THREE.WebGLRenderer({
  antialias: spec.render.antialias,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(spec.render.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight, false);
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
else if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
renderer.shadowMap.enabled = spec.lighting.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
const engineInitMs = performance.now() - tEngine0;

// ---------- 场景构建 ----------
const tBuild0 = performance.now();
const scene = new THREE.Scene();
scene.background = new THREE.Color(spec.render.clearColor);

// 对照开关：?mat=pbr（默认）/?mat=cheap（两端同时降级，用于分离材质模型开销与引擎开销）
const qs = new URLSearchParams(location.search);
const matMode = qs.get('mat') || 'pbr';
// ?sync=1 时每帧调用 gl.finish()，强制等待 GPU 完成。
// 必要性：不等待时帧时间只反映 CPU 提交耗时（实测 frameP95≈cpuP95），会把"CPU 快"误读成"GPU 快"。
const syncMode = qs.get('sync') === '1';
const makeMat = (opts) => {
  if (matMode !== 'cheap') return new THREE.MeshStandardMaterial(opts);
  // Lambert 不支持 roughness/metalness，剔除以免产生无谓告警
  const { roughness, metalness, ...rest } = opts;
  return new THREE.MeshLambertMaterial(rest);
};

const camera = new THREE.PerspectiveCamera(
  spec.camera.fov,
  window.innerWidth / window.innerHeight,
  spec.camera.near,
  spec.camera.far
);

// 程序化贴图（两端同算法，避免外部资源差异）
const texSize = spec.render.proceduralTextureSize;
const cv = document.createElement('canvas');
cv.width = cv.height = texSize;
drawChecker(cv.getContext('2d'), texSize, 8, spec.seed);
const tex = new THREE.CanvasTexture(cv);
if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
tex.wrapS = THREE.RepeatWrapping;
tex.wrapT = THREE.RepeatWrapping;

// 光照
const amb = new THREE.AmbientLight(0xffffff, spec.lighting.ambientIntensity);
scene.add(amb);
const dir = new THREE.DirectionalLight(0xffffff, spec.lighting.directionalIntensity);
dir.position.set(40, 70, 30);
dir.castShadow = spec.lighting.shadows;
dir.shadow.mapSize.set(spec.lighting.shadowMapSize, spec.lighting.shadowMapSize);
const sc = dir.shadow.camera;
sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 300;
sc.updateProjectionMatrix();
dir.shadow.bias = -0.0005;
scene.add(dir);
scene.add(dir.target);

// 地面
const groundMat = makeMat({ map: tex, roughness: 0.95, metalness: 0.0 });
tex.repeat.set(24, 24);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(spec.ground.size, spec.ground.size, spec.ground.divisions, spec.ground.divisions),
  groundMat
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// 静态障碍：一律独立 Mesh，禁止实例化，保证两端优化程度对等
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const obstacleMat = makeMat({ map: tex, roughness: 0.8, metalness: 0.0 });
for (const o of layout.obstacles) {
  const m = new THREE.Mesh(boxGeo, obstacleMat);
  m.scale.set(o.w, o.h, o.w);
  m.position.set(o.x, o.h / 2, o.z);
  m.rotation.y = o.rotY;
  m.castShadow = spec.lighting.shadows;
  m.receiveShadow = true;
  scene.add(m);
}

// 动态物体
const dynGeo = new THREE.BoxGeometry(spec.dynamicBodies.size, spec.dynamicBodies.size, spec.dynamicBodies.size);
const dynMat = makeMat({ color: 0x6fb3ff, roughness: 0.5, metalness: 0.1 });
const dynMeshes = layout.dynamics.map(() => {
  const m = new THREE.Mesh(dynGeo, dynMat);
  m.castShadow = spec.lighting.shadows;
  scene.add(m);
  return m;
});

// 粒子
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(layout.particlePositions, 3));
const points = new THREE.Points(
  pGeo,
  new THREE.PointsMaterial({ size: spec.particles.size, color: 0xffd9a0, transparent: true, opacity: 0.85 })
);
scene.add(points);
const sceneBuildMs = performance.now() - tBuild0;

// ---------- 帧循环 ----------
const camPos = { x: 0, y: 0, z: 0 };
let prevNow = 0;
let firstFrameMs = -1;
let lastHud = 0;
let hudFrames = 0;
let hudT0 = 0;

function step(now) {
  const t = now / 1000;
  const dt = prevNow === 0 ? 1 / 60 : Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  advance(t, dt);

  for (let i = 0; i < dynMeshes.length; i++) {
    const d = layout.dynamics[i];
    dynMeshes[i].position.set(d.x, d.y, d.z);
  }
  pGeo.attributes.position.needsUpdate = true;

  computeCamera(t, spec, camPos);
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.lookAt(0, spec.camera.lookAtHeight, 0);

  renderer.render(scene, camera);
  if (syncMode) renderer.getContext().finish(); // 强制同步，使帧时间包含真实 GPU 耗时

  if (firstFrameMs < 0) firstFrameMs = performance.now();

  hudFrames++;
  if (now - lastHud > 500) {
    const fps = (hudFrames * 1000) / (now - lastHud);
    hud.textContent = `three r${THREE.REVISION}\nfps ${fps.toFixed(1)}\nobstacles ${layout.obstacles.length}\ndynamics ${dynMeshes.length}\nparticles ${spec.particles.count}`;
    lastHud = now;
    hudFrames = 0;
  }
}

function renderWarmupFrame() {
  step(performance.now());
}

// 先渲染一帧，使"首次出画面"的计时成立
renderWarmupFrame();
prevNow = 0;

window.__benchInfo = {
  engine: 'three',
  engineVersion: String(THREE.REVISION),
  matMode,
  syncMode,
  gl: readGlInfo(),
  engineInitMs: +engineInitMs.toFixed(2),
  sceneBuildMs: +sceneBuildMs.toFixed(2),
  firstFrameMs: +firstFrameMs.toFixed(2),
  firstFrameFromNavMs: +performance.now().toFixed(2),
  counts: {
    obstacles: layout.obstacles.length,
    dynamics: dynMeshes.length,
    particles: spec.particles.count,
    drawCallsApprox: layout.obstacles.length + dynMeshes.length + 2 + 1,
  },
  navStartOffsetMs: +tNav.toFixed(2),
};

window.__benchRun = (cfg) =>
  runBenchmark({ warmupMs: cfg.warmupMs, durationMs: cfg.durationMs, step });

// 校准帧率天花板：用于判定采样结果是否只是"被锁帧"
window.__benchCalibrate = () => calibrateRafCap(1000);

window.__benchReady = true;
