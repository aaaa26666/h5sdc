// M4-6 局内小地图（Canvas 2D）—— 圆形、局部、随角色朝向旋转
//
// 形态（制作人指定）：
//   · 圆形：裁掉四角，视野边缘与"看得见的范围"一致，不会暗示圆外还有信息。
//   · 局部：只画以角色为中心、半径 viewRadiusCells 格的范围 ——
//     全图缩略在 40×40 的图上每个房间只有几像素，看不出自己在哪条走廊。
//   · 旋转：以角色朝向为北（角色永远朝上、永远在圆心），
//     这样"前面有敌人"在地图和画面上是同一个方向，不用在脑子里做坐标变换。
//
// 旋转怎么做：整张地形仍然缓存成离屏画布（墙和地面一局不变，没必要每帧重画），
// 每帧只做一次"平移到圆心 → 旋转 → 平移到角色 → drawImage"的变换。
// 动态点（容器/撤离点/敌人）画在**同一个变换后的坐标系**里，于是自动跟着转。
// 角色本身不参与旋转：restore 之后单独画在圆心、朝上。
//
// 朝向换算（推导过，别凭感觉改）：
//   玩家朝向 forward = (-sin yaw, -cos yaw)，屏幕坐标 x 右 / z 下（z 增大 = 屏幕向下）。
//   canvas 的 rotate(θ) 是顺时针（y 轴向下）。令 θ = yaw 时，forward 恰好被转到 (0, -1)
//   即屏幕正上方 —— 与"角色朝上"一致。
//
// 本文件只做绘制，不参与任何游戏逻辑；数据由调用方（main.js）按帧组装后传入。

const COLORS = {
  floor: 'rgba(200,225,235,0.07)',
  wall: 'rgba(120,160,180,0.34)',
  containerOpen: 'rgba(255,204,102,0.18)',
  containerClosed: 'rgba(255,204,102,0.85)',
  extractOpen: '#7fe0a0',
  extractLocked: '#6b7078',
  ai: '#ff6b5a',
  player: '#cfe3ea',
};

export function createMinimap(canvas, cfg) {
  const size = cfg.minimap.sizePx;
  const radiusCells = cfg.minimap.viewRadiusCells;
  const rotateWithPlayer = cfg.minimap.rotateWithPlayer !== false;
  // 三个叠加层默认关闭：制作人要求小地图只显示地形。
  // 开关保留在配置表里而不是把绘制代码删掉 —— 日后要恢复只改值即可。
  const showContainers = cfg.minimap.showContainers === true;
  const showExtracts = cfg.minimap.showExtracts === true;
  const showAis = cfg.minimap.showAis === true;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const R = size / 2;
  /** 每格多少像素：由可见半径决定（可见半径 = 屏幕半径） */
  const cellPx = R / radiusCells;

  /** 每层一份地形缓存（按当前缩放渲染整图） */
  const terrainCache = new Map();

  function buildTerrain(view) {
    const { W, H, blocked } = view.level;
    const off = document.createElement('canvas');
    off.width = Math.ceil(W * cellPx);
    off.height = Math.ceil(H * cellPx);
    const c = off.getContext('2d');
    for (let z = 0; z < H; z++) {
      for (let x = 0; x < W; x++) {
        // blocked 是分层数组：floor * W*H + z*W + x
        const idx = view.floor * W * H + z * W + x;
        c.fillStyle = blocked[idx] === 1 ? COLORS.wall : COLORS.floor;
        c.fillRect(x * cellPx, z * cellPx, Math.ceil(cellPx), Math.ceil(cellPx));
      }
    }
    return off;
  }

  /**
   * @param {object} view
   * @param {object} view.level   { W, H, cell, blocked, floorCount }
   * @param {number} view.floor   当前层
   * @param {Array}  view.containers [{ x, z, floor, opened }]（格坐标）
   * @param {Array}  view.extracts   [{ x, z, floor, open }]（格坐标）
   * @param {Array}  view.ais        [{ x, z, floor, alive }]（格坐标，可为浮点）
   * @param {object} view.player     { x, z, yaw }（格坐标，可为浮点）
   */
  function draw(view) {
    if (!view || !view.level || !view.player) return;
    if (!terrainCache.has(view.floor)) terrainCache.set(view.floor, buildTerrain(view));

    ctx.clearRect(0, 0, size, size);
    ctx.save();

    // 圆形裁剪：圆外不留任何像素，避免"圆角矩形"暗示出圆外还有信息
    ctx.beginPath();
    ctx.arc(R, R, R - 1, 0, Math.PI * 2);
    ctx.clip();

    // 平移到圆心 → 旋转（角色朝向朝上）→ 平移到角色所在格
    ctx.translate(R, R);
    if (rotateWithPlayer) ctx.rotate(view.player.yaw || 0);
    ctx.translate(-view.player.x * cellPx, -view.player.z * cellPx);

    const { W, H } = view.level;
    ctx.drawImage(terrainCache.get(view.floor), 0, 0, W * cellPx, H * cellPx);

    // 容器：已开过的变暗，这样"附近还剩哪几个没搜"一眼可见
    if (showContainers) {
      for (const c of view.containers || []) {
        if ((c.floor || 0) !== view.floor) continue;
        ctx.fillStyle = c.opened ? COLORS.containerOpen : COLORS.containerClosed;
        ctx.beginPath();
        ctx.arc(c.x * cellPx, c.z * cellPx, Math.max(1.2, cellPx * 0.22), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 撤离点：灰 = 未开放，绿 = 可用。M4-1 的规则在地图上的直接呈现。
    if (showExtracts) {
      for (const e of view.extracts || []) {
        if ((e.floor || 0) !== view.floor) continue;
        ctx.strokeStyle = e.open ? COLORS.extractOpen : COLORS.extractLocked;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(e.x * cellPx, e.z * cellPx, Math.max(4, cellPx * 0.6), 0, Math.PI * 2);
        ctx.stroke();
        if (e.open) {
          ctx.fillStyle = COLORS.extractOpen;
          ctx.beginPath();
          ctx.arc(e.x * cellPx, e.z * cellPx, Math.max(1.5, cellPx * 0.18), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 敌人
    if (showAis) {
      for (const a of view.ais || []) {
        if (!a.alive) continue;
        if ((a.floor || 0) !== view.floor) continue;
        ctx.fillStyle = COLORS.ai;
        ctx.beginPath();
        ctx.arc(a.x * cellPx, a.z * cellPx, Math.max(2.2, cellPx * 0.3), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // 角色：固定在圆心、朝上。地图已经转过了，所以"地图上方"就是"角色正前方"。
    const r = Math.max(4, cellPx * 0.5);
    ctx.fillStyle = COLORS.player;
    ctx.beginPath();
    ctx.moveTo(R, R - r);
    ctx.lineTo(R - r * 0.62, R + r * 0.62);
    ctx.lineTo(R + r * 0.62, R + r * 0.62);
    ctx.closePath();
    ctx.fill();
  }

  return {
    draw,
    /** 换局或换图时清掉地形缓存（几何可能在两局之间改变） */
    invalidate() {
      terrainCache.clear();
    },
  };
}
