// 射线-球相交。武器命中判定与 AI 射击判定共用，避免两处各写一份。

/** @returns 最近命中距离；未命中返回 -1 */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = cx - ox;
  const ey = cy - oy;
  const ez = cz - oz;
  const tca = ex * dx + ey * dy + ez * dz;
  if (tca < 0) return -1;
  const d2 = ex * ex + ey * ey + ez * ez - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t = tca - thc;
  return t >= 0 ? t : tca + thc;
}
