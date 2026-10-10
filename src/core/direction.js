// 方向数学（纯函数，无引擎/无 DOM 依赖）
//
// 为什么单独成文件：这些公式曾经出过一次真实缺陷，而且那个缺陷**只在特定朝向下
// 才表现为反向**（同向度 = cos(2θ)），靠手感极难诊断。
// 抽成纯函数后可以不启浏览器直接做单元测试覆盖（tools/unit-tests.mjs），
// 让这类坐标系错误在几毫秒内暴露，而不是等玩家试玩发现。
//
// 不变量（必须始终成立，单测会逐条断言）：
//   1. yaw=0 时前方为 -Z，即 viewForward(0,0) === (0,0,-1)
//   2. wishDirection(yaw, 0, -1) 与 viewForward(yaw, 0) 严格同向
//   3. 右向量 = 前向量 × 上向量(0,1,0)，且与前向量正交

/** 前 / 右 两个水平基向量。前向量与 viewForward 的水平分量一致 */
export function movementBasis(yaw) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    // yaw=0 时朝 -Z
    fwdX: -sin,
    fwdZ: -cos,
    // 右向量 = forward × up，up=(0,1,0) → (cos yaw, -sin yaw)
    rgtX: cos,
    rgtZ: -sin,
  };
}

/**
 * 输入 (fx, fz) → 世界水平方向。
 * 约定：fz = -1 表示前进，fz = +1 表示后退；fx = +1 表示右。
 * @returns {{x:number, z:number}} 非单位向量，长度等于输入向量长度
 */
export function wishDirection(yaw, fx, fz) {
  const b = movementBasis(yaw);
  // 前进分量取 -fz，因为 fz=-1 才是前进
  const f = -fz;
  return {
    x: b.rgtX * fx + b.fwdX * f,
    z: b.rgtZ * fx + b.fwdZ * f,
  };
}

/** 视线方向（单位向量）。yaw=0、pitch=0 时为 (0,0,-1) */
export function viewForward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}
