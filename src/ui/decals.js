// M2-3 弹孔（命中反馈的一部分）
//
// 用 InstancedMesh 固定池实现，不产生运行时分配 —— M2 虽然不追求画面表现，
// 但"每次开枪 new 一个 Mesh"会在持续交火时稳定制造 GC 抖动，那属于缺陷不属于表现。
//
// [M2-TEMP-3] 贴花只是朝向命中面的小方块，没有纹理、没有随时间淡出、没有数量溢出后的
//             优雅处理（直接环形覆盖最旧的）。真正的贴花系统需要纹理图集与 UV 映射。
//             M3 重写清单：贴图集 + 淡出 + 按材质分组。
import * as THREE from 'three';

const MAX_DECALS = 64;

export function createDecals(scene) {
  const geo = new THREE.PlaneGeometry(0.16, 0.16);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x14171a,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX_DECALS);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const zAxis = new THREE.Vector3(0, 0, 1);
  let cursor = 0;
  let placed = 0;

  const surfaceNormal = new THREE.Vector3();

  /**
   * 依据命中点与关卡网格推算表面法线。
   * 做法：看命中点在所属格子里离哪条边界最近，那条边界的外法线就是命中面法线。
   * 这比"永远朝向射击者"更接近真实 —— 斜着打在墙上的弹孔应该贴在墙面上。
   */
  function computeNormal(level, point) {
    const cell = level.cell;
    const lx = point.x - Math.floor(point.x / cell) * cell;
    const lz = point.z - Math.floor(point.z / cell) * cell;
    const dx = Math.min(lx, cell - lx);
    const dz = Math.min(lz, cell - lz);
    surfaceNormal.set(0, 0, 0);
    if (point.y <= cell * 0.02) {
      surfaceNormal.set(0, 1, 0); // 地面
    } else if (dx <= dz) {
      surfaceNormal.set(lx < cell - lx ? -1 : 1, 0, 0);
    } else {
      surfaceNormal.set(0, 0, lz < cell - lz ? -1 : 1);
    }
    return surfaceNormal;
  }

  return {
    get count() {
      return mesh.count;
    },
    get placedTotal() {
      return placed;
    },

    /** 在命中点放置一个弹孔 */
    add(level, point, kind) {
      computeNormal(level, point);
      // 沿法线推出一点，避免与墙面共面导致闪烁
      pos.set(
        point.x + surfaceNormal.x * 0.012,
        point.y + surfaceNormal.y * 0.012,
        point.z + surfaceNormal.z * 0.012
      );
      // 让平面朝向法线
      q.setFromUnitVectors(zAxis, surfaceNormal);
      const s = kind === 'ground' ? 0.9 : 1.0;
      scale.set(s, s, s);
      m4.compose(pos, q, scale);
      mesh.setMatrixAt(cursor, m4);
      cursor = (cursor + 1) % MAX_DECALS;
      if (mesh.count < MAX_DECALS) mesh.count++;
      mesh.instanceMatrix.needsUpdate = true;
      placed++;
    },

    clear() {
      mesh.count = 0;
      cursor = 0;
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
