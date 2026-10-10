// M0-6 体积对照 · 推荐做法：命名导入
// 功能与 main-ns.js 完全一致，唯一差别是把用到的成员逐个具名引入，
// 让打包器能精确 tree-shake。
import {
  WebGLRenderer,
  PCFSoftShadowMap,
  SRGBColorSpace,
  Scene,
  Color,
  Fog,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  CanvasTexture,
  RepeatWrapping,
  MeshStandardMaterial,
  Mesh,
  BoxGeometry,
  PlaneGeometry,
  BufferGeometry,
  BufferAttribute,
  Points,
  PointsMaterial,
  Clock,
  Vector3,
  MathUtils,
} from 'three';

const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x101418);
scene.fog = new Fog(0x101418, 40, 200);

const camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 2, 6);

scene.add(new AmbientLight(0xffffff, 0.4));

const dir = new DirectionalLight(0xffffff, 2);
dir.position.set(20, 40, 15);
dir.castShadow = true;
dir.shadow.mapSize.set(1024, 1024);
const sc = dir.shadow.camera;
sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 200;
sc.updateProjectionMatrix();
scene.add(dir);
scene.add(dir.target);

const cvs = document.createElement('canvas');
cvs.width = cvs.height = 64;
const ctx = cvs.getContext('2d');
ctx.fillStyle = '#8899aa';
ctx.fillRect(0, 0, 64, 64);
const tex = new CanvasTexture(cvs);
tex.wrapS = tex.wrapT = RepeatWrapping;

const mat = new MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0 });

const box = new Mesh(new BoxGeometry(1, 1, 1), mat);
box.castShadow = true;
box.position.y = 0.5;
scene.add(box);

const ground = new Mesh(new PlaneGeometry(100, 100), mat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const pGeo = new BufferGeometry();
pGeo.setAttribute('position', new BufferAttribute(new Float32Array(300 * 3), 3));
scene.add(new Points(pGeo, new PointsMaterial({ size: 0.15, color: 0xffd9a0 })));

const clock = new Clock();
const tmp = new Vector3();

// 分包验证：关卡模块必须走动态导入，不能进首包
export function loadLevel() {
  return import('./level.js').then((m) => m.initLevel(scene, MathUtils.clamp(tmp.x, 0, 1)));
}

function frame() {
  const dt = clock.getDelta();
  box.rotation.y += dt;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__m0bundle = { renderer, scene, camera, loadLevel };
