// M0-2 等价场景 · Babylon.js 端
// 严格遵守 scenes/spec.json，与 Three 端使用同一份规格与同一套运动数学。
// 用完即弃，不属于游戏产物。
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
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const engine = new BABYLON.Engine(
  canvas,
  spec.render.antialias,
  { preserveDrawingBuffer: false, stencil: false, powerPreference: 'high-performance' },
  false // 不随设备像素比自适应，保持与 Three 端一致的 pixelRatio = 1
);
engine.setHardwareScalingLevel(1 / spec.render.pixelRatio);
const engineInitMs = performance.now() - tEngine0;

// 仅同步模式下才取上下文引用，避免影响非同步路径
const glSync = syncMode ? canvas.getContext('webgl2') || canvas.getContext('webgl') : null;

// ---------- 场景构建 ----------
const tBuild0 = performance.now();
const scene = new BABYLON.Scene(engine);
scene.clearColor = BABYLON.Color4.FromHexString(spec.render.clearColor + 'ff');
scene.autoClear = true;
scene.skipPointerMovePicking = true;

// 对照开关：?mat=pbr（默认，与 Three 的 MeshStandardMaterial 语义对等）
//           ?mat=cheap（两端同时降级为非 PBR 廉价材质，用于分离"材质模型开销"与"引擎开销"）
const qs = new URLSearchParams(location.search);
const matMode = qs.get('mat') || 'pbr';
// ?sync=1 时每帧调用 gl.finish()，强制等待 GPU 完成，使帧时间包含真实 GPU 耗时
const syncMode = qs.get('sync') === '1';

const camera = new BABYLON.UniversalCamera('cam', new BABYLON.Vector3(0, spec.camera.height, spec.camera.orbitRadius), scene);
camera.fov = (spec.camera.fov * Math.PI) / 180; // Three 的 fov 是角度，Babylon 用弧度，垂直视角对齐
camera.minZ = spec.camera.near;
camera.maxZ = spec.camera.far;

// 程序化贴图（与 Three 端同一绘制算法）
const texSize = spec.render.proceduralTextureSize;
const dt = new BABYLON.DynamicTexture('tex', { width: texSize, height: texSize }, scene, false);
drawChecker(dt.getContext(), texSize, 8, spec.seed);
dt.update(false);
dt.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
dt.uScale = 24;
dt.vScale = 24;

// 光照：Hemispheric 的 groundColor 与 diffuse 都设为白，使效果等价于 Three 的 AmbientLight
const hemi = new BABYLON.HemisphericLight('amb', new BABYLON.Vector3(0, 1, 0), scene);
hemi.diffuse = BABYLON.Color3.White();
hemi.groundColor = BABYLON.Color3.White();
hemi.specular = BABYLON.Color3.Black();
hemi.intensity = spec.lighting.ambientIntensity;

const dir = new BABYLON.DirectionalLight('dir', new BABYLON.Vector3(-0.42, -0.73, -0.31), scene);
dir.position = new BABYLON.Vector3(40, 70, 30);
dir.intensity = spec.lighting.directionalIntensity;
dir.specular = BABYLON.Color3.Black();

let shadowGen = null;
if (spec.lighting.shadows) {
  shadowGen = new BABYLON.ShadowGenerator(spec.lighting.shadowMapSize, dir);
  shadowGen.usePercentageCloserFiltering = true;
  shadowGen.useContactHardeningShadow = false;
  shadowGen.bias = 0.0008;
  shadowGen.normalBias = 0.02;
}

// 材质：pbr 模式与 Three 的 MeshStandardMaterial 语义对齐；
// cheap 模式两端同时降级，用于分离材质模型开销与引擎本身开销。
function makeMat(name, { albedoColor, map, roughness, metallic }) {
  if (matMode === 'cheap') {
    const m = new BABYLON.StandardMaterial(name, scene);
    if (map) m.diffuseTexture = map;
    if (albedoColor) m.diffuseColor = albedoColor;
    m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    m.specularPower = 32;
    return m;
  }
  const m = new BABYLON.PBRMaterial(name, scene);
  if (map) m.albedoTexture = map;
  if (albedoColor) m.albedoColor = albedoColor;
  m.metallic = metallic;
  m.roughness = roughness;
  return m;
}

const groundMat = makeMat('gm', { map: dt, metallic: 0, roughness: 0.95 });
const obstacleMat = makeMat('om', { map: dt, metallic: 0, roughness: 0.8 });
const dynMat = makeMat('dm', {
  albedoColor: new BABYLON.Color3(0x6f / 255, 0xb3 / 255, 0xff / 255),
  metallic: 0.1,
  roughness: 0.5,
});

// 地面
const ground = BABYLON.MeshBuilder.CreateGround(
  'ground',
  { width: spec.ground.size, height: spec.ground.size, subdivisions: spec.ground.divisions },
  scene
);
ground.material = groundMat;
ground.receiveShadows = true;

// 静态障碍：一律独立 Mesh，禁止 thin instances，保证两端优化程度对等
const obstacleSource = BABYLON.MeshBuilder.CreateBox('obox', { size: 1 }, scene);
obstacleSource.material = obstacleMat;
obstacleSource.isVisible = false;
for (const o of layout.obstacles) {
  const m = obstacleSource.clone('o');
  m.isVisible = true;
  m.scaling.set(o.w, o.h, o.w);
  m.position.set(o.x, o.h / 2, o.z);
  m.rotation.y = o.rotY;
  m.receiveShadows = true;
  if (shadowGen) shadowGen.addShadowCaster(m);
}

// 动态物体
const dynSource = BABYLON.MeshBuilder.CreateBox('dbox', { size: spec.dynamicBodies.size }, scene);
dynSource.material = dynMat;
dynSource.isVisible = false;
const dynMeshes = layout.dynamics.map(() => {
  const m = dynSource.clone('d');
  m.isVisible = true;
  if (shadowGen) shadowGen.addShadowCaster(m);
  return m;
});

// 粒子：以点云材质渲染，语义对齐 Three 的 Points（点尺寸单位不同，属已知不可比项）
const pMesh = new BABYLON.Mesh('pts', scene);
const vd = new BABYLON.VertexData();
vd.positions = Array.from(layout.particlePositions);
vd.applyToMesh(pMesh, true);
const pMat = new BABYLON.StandardMaterial('pm', scene);
pMat.pointsCloud = true;
pMat.pointSize = spec.particles.size * 60;
pMat.disableLighting = true;
pMat.emissiveColor = new BABYLON.Color3(1, 0.85, 0.63);
pMat.alpha = 0.85;
pMesh.material = pMat;

const sceneBuildMs = performance.now() - tBuild0;

// ---------- 帧循环 ----------
const camPos = { x: 0, y: 0, z: 0 };
// 预先分配，避免每帧新建 Vector3 造成分配开销（否则会不公平地拖慢本端）
const lookTarget = new BABYLON.Vector3(0, spec.camera.lookAtHeight, 0);
let prevNow = 0;
let firstFrameMs = -1;
let lastHud = 0;
let hudFrames = 0;

window.addEventListener('resize', () => engine.resize());

function step(now) {
  const t = now / 1000;
  const dtSec = prevNow === 0 ? 1 / 60 : Math.min((now - prevNow) / 1000, 0.1);
  prevNow = now;

  advance(t, dtSec);

  for (let i = 0; i < dynMeshes.length; i++) {
    const d = layout.dynamics[i];
    dynMeshes[i].position.set(d.x, d.y, d.z);
  }
  pMesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, layout.particlePositions);

  computeCamera(t, spec, camPos);
  camera.position.set(camPos.x, camPos.y, camPos.z);
  camera.setTarget(lookTarget);

  scene.render();
  if (glSync) glSync.finish(); // 强制同步，使帧时间包含真实 GPU 耗时

  if (firstFrameMs < 0) firstFrameMs = performance.now();

  hudFrames++;
  if (now - lastHud > 500) {
    const fps = (hudFrames * 1000) / (now - lastHud);
    hud.textContent = `babylon ${BABYLON.Engine.Version}\nfps ${fps.toFixed(1)}\nobstacles ${layout.obstacles.length}\ndynamics ${dynMeshes.length}\nparticles ${spec.particles.count}`;
    lastHud = now;
    hudFrames = 0;
  }
}

// 先渲染一帧，使"首次出画面"的计时成立（同时触发着色器编译）
step(performance.now());
prevNow = 0;

window.__benchInfo = {
  engine: 'babylon',
  engineVersion: String(BABYLON.Engine.Version),
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
