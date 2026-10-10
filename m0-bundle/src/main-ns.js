// M0-6 体积对照 · 反面教材：命名空间导入
// 功能与 main-named.js 完全一致，唯一差别是 import 写法。
// 目的：量化"图省事写 import * as THREE"要多付多少首包体积。
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101418);
scene.fog = new THREE.Fog(0x101418, 40, 200);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 2, 6);

scene.add(new THREE.AmbientLight(0xffffff, 0.4));

const dir = new THREE.DirectionalLight(0xffffff, 2);
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
const tex = new THREE.CanvasTexture(cvs);
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, metalness: 0 });

const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
box.castShadow = true;
box.position.y = 0.5;
scene.add(box);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), mat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
scene.add(new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.15, color: 0xffd9a0 })));

const clock = new THREE.Clock();
const tmp = new THREE.Vector3();

// 分包验证：关卡模块必须走动态导入，不能进首包
export function loadLevel() {
  return import('./level.js').then((m) => m.initLevel(scene, THREE.MathUtils.clamp(tmp.x, 0, 1)));
}

function frame() {
  const dt = clock.getDelta();
  box.rotation.y += dt;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__m0bundle = { renderer, scene, camera, loadLevel };
