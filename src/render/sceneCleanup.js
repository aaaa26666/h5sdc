// M5-1 局内世界的资源释放（渲染侧）
//
// 为什么需要它：M5-1 之前，一整局的生命周期等于一次页面加载 ——
// 局内世界创建后从不销毁，"再进一局"靠整页刷新让浏览器回收一切。
// 大厅闭环（结算 → 回大厅 → 再进战区，全程不刷新）之后，同一张页面里会
// 反复创建/销毁局内世界，**不释放就是稳定泄漏**（M8 的内存基线会直接不达标，
// 而且泄漏的量随局数增长，症状是"玩到第 N 局开始卡"）。
//
// 实现方式：局内所有对象都挂在**一个 THREE.Group**（由 main.js 创建并交给
// level / loot / extract / aiManager / decals 当作 scene 参数使用）。
// 因此释放 = 遍历这个子树 + 从真场景摘掉它。
// 这样做而不是给每个模块加 dispose()，是因为"哪些 mesh 属于这一局"这件事
// 只有一个答案：谁被挂进了这个 group。让六个模块各记一份自己的清单，
// 迟早会漏一个 —— 而漏掉的那个不会报错，只会慢慢吃内存。
//
// 注意（这是本函数**做不到**的部分，必须由调用方自己处理）：
//   任何在生命周期中途把 mesh 从场景里摘走的模块，它的几何/材质就不在这棵子树里了，
//   必须自己 dispose。当前只有 ai.js（AI 死亡时移除自己的 mesh）与 ui/decals.js 这么做，
//   它们各自实现了 dispose()，由 main.js 在摘子树之前显式调用。

import * as THREE from 'three';

/**
 * 释放一棵子树持有的几何与材质，并把它从父节点摘掉。
 *
 * 注意**不释放贴图**：当前项目全部材质都是程序化纯色（无 map/normalMap 等），
 * 没有贴图可释放。M7 换正式美术资源后，这里必须补上纹理遍历
 * （r150+ 可以把纹理一起交给 material.dispose 的时机不再有，需要显式遍历材质槽）。
 *
 * @param {THREE.Object3D|null} root
 * @returns {{objects:number, geometries:number, materials:number}} 实际释放的数量
 *          —— 返回数量而不是 void，是为了让调用方（含端到端断言）能证明
 *          "确实释放了东西"，而不是只看代码里有没有这一行。
 */
export function disposeSubtree(root) {
  const stats = { objects: 0, geometries: 0, materials: 0 };
  if (!root) return stats;

  root.traverse((obj) => {
    stats.objects++;
    if (obj.geometry && typeof obj.geometry.dispose === 'function') {
      obj.geometry.dispose();
      stats.geometries++;
    }
    const mat = obj.material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      if (m && typeof m.dispose === 'function') {
        m.dispose();
        stats.materials++;
      }
    }
  });

  if (root.parent) root.parent.remove(root);
  return stats;
}

/** 建一个空的"局内世界根节点"。所有局内对象都挂它下面，便于整体释放（见上）。 */
export function createRaidRoot(scene) {
  const root = new THREE.Group();
  root.name = 'raidRoot';
  scene.add(root);
  return root;
}
