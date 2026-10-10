// 动态导入的关卡模块 —— 用于验证"关卡代码不进首包"。
// 这里刻意引入首包不需要的成员（Raycaster / Group / 更多几何体），
// 以便观察它们是否被正确隔离到独立 chunk。
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Color, Raycaster, Vector2 } from 'three';

export function initLevel(scene, seed) {
  const group = new Group();
  const geo = new BoxGeometry(1, 2, 1);
  const mat = new MeshStandardMaterial({ color: new Color(0x4a5560), roughness: 0.85 });
  for (let i = 0; i < 120; i++) {
    const m = new Mesh(geo, mat);
    m.position.set((i % 12) * 3 - 18, 1, Math.floor(i / 12) * 3 - 12);
    group.add(m);
  }
  scene.add(group);
  // 保留 raycast 能力：关卡里做拾取/命中检测需要。
  // 这里只构造实例不做实际投射（本模块仅用于体积测量，不参与运行）。
  const rc = new Raycaster();
  const ndc = new Vector2(0, 0);
  return { objects: group.children.length, hasRaycaster: !!rc, ndc, seed };
}
