// M6-3 指针拖放控制器（**只做界面的事**）
//
// 分工（这条分工就是 docs/18 §五 风险表里"拖放的两条判据不能各写一次"的落地）：
//   本文件 —— 指针 → 格坐标（纯几何）、幽灵元素跟随、拖动中按 R 换形、手势区分；
//   core/dragDrop.js —— 落点合不合法、以及落库。判定一律经注入的 decide/commit，
//   界面里**没有**任何格子碰撞、价格或容量的运算。
//
// 为什么不用 setPointerCapture：端到端在无头下会用 page.evaluate 派发**合成**
//   PointerEvent，而合成事件不是"活跃指针"，setPointerCapture 会抛 NotFoundError。
//   改在 window 上听 pointermove / pointerup —— 真实鼠标与合成事件都能工作，
//   代价是"指针移出窗口后松手"要靠 blur 兜底（见下面的 cancel()）。
//
// 为什么"没动就是点击"：仓库的批量出售靠点选条目（M5-2 的既有交互）。
//   拖动与点选共用 pointerdown，所以必须有一个位移阈值把它们分开 ——
//   否则"拖动时手指抖了 1px"会退化成切换选中，而玩家看到的只是"拖不动"。

/** 位移超过它才算拖动（px）。太小会把点击误判成拖动，太大则"轻轻一挪"没反应。 */
export const CLICK_SLOP_PX = 4;

/**
 * 指针在网格元素里的格坐标（纯函数，单测直接驱动）。
 * `inside` 表示指针是否落在元素矩形内 —— 落在外面时**不裁剪**坐标，
 * 让 core 的落点判定去回答"越界"，界面不替它下结论。
 */
export function cellFromPoint(rect, cell, clientX, clientY) {
  return {
    x: Math.floor((clientX - rect.left) / cell),
    y: Math.floor((clientY - rect.top) / cell),
    inside: rectContains(rect, clientX, clientY),
  };
}

export function rectContains(rect, clientX, clientY) {
  return clientX >= rect.left && clientY >= rect.top && clientX < rect.right && clientY < rect.bottom;
}

/**
 * 把"抓住的那一格"夹回物品形状之内。
 * 拖动中按 R 之后形状会换（2×1 → 1×2），而抓住的偏移可能是 (0,1) ——
 * 不夹一下，幽灵元素会画到指针的上方，看起来像"旋转把东西甩出去了"。
 */
export function wrapOffset(dx, dy, w, h) {
  return {
    dx: Math.min(Math.max(0, Math.floor(dx)), Math.max(0, w - 1)),
    dy: Math.min(Math.max(0, Math.floor(dy)), Math.max(0, h - 1)),
  };
}

/** 旋转后的形状（布局用；朝向的**真值**来自 core 的视图，这里只负责换宽高）。 */
function shapeFor(src, rotated) {
  return rotated ? { w: src.h, h: src.w } : { w: src.w, h: src.h };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root        事件委托根（装备面板）
 * @param {HTMLElement} [opts.ghostHost] 幽灵元素的挂载点（默认 document.body）
 * @param {(node:HTMLElement) => object|null} opts.sourceOf DOM → 拖动源（不认识则返回 null）
 * @param {(src, target, rotated) => {ok:boolean, reason?:string}} opts.decide 只判定（幽灵上色）
 * @param {(src, target, rotated) => {ok:boolean, reason?:string}} opts.commit 落库
 * @param {(src) => void} opts.click     没位移就松手（仓库的点选）
 * @param {(reason:string) => void} opts.reject 非法落点：翻成人话提示
 */
export function createDragLayer(opts) {
  const { root, ghostHost = document.body, sourceOf, decide, commit, click, reject } = opts;

  /** 当前这次拖动（null = 没有）。它不是持久状态：松手即销毁。 */
  let drag = null;

  const gridEl = () => root.querySelector('[data-drop-grid]');

  /** 网格的格边长（px）。来自 CSS 变量 `--cell` —— 界面与判定的格定义只有这一份。 */
  function cellSize(el) {
    const v = parseFloat(getComputedStyle(el).getPropertyValue('--cell'));
    return Number.isFinite(v) && v > 0 ? v : 30;
  }

  /**
   * 指针落在哪个落点上。
   * 装备格优先于仓库网格（两者不重叠，但顺序写死能让"以后挪布局"不改变语义）。
   */
  function hitTest(clientX, clientY) {
    for (const slot of root.querySelectorAll('[data-drop-slot]')) {
      if (rectContains(slot.getBoundingClientRect(), clientX, clientY)) {
        return { kind: 'slot', slotId: slot.dataset.slot };
      }
    }
    const grid = gridEl();
    if (grid) {
      const r = grid.getBoundingClientRect();
      if (rectContains(r, clientX, clientY)) {
        const c = cellFromPoint(r, cellSize(grid), clientX, clientY);
        // 落点 = 指针所在格 − 抓住的那一格：玩家抓的是物品的哪一角，落下去就还是那一角。
        return { kind: 'stash', x: c.x - drag.grab.dx, y: c.y - drag.grab.dy };
      }
    }
    return null;
  }

  /** 指针在仓库网格里的格坐标（起拖时算抓取偏移用）。 */
  function gridCellAt(clientX, clientY) {
    const grid = gridEl();
    if (!grid) return null;
    const r = grid.getBoundingClientRect();
    if (!rectContains(r, clientX, clientY)) return null;
    return cellFromPoint(r, cellSize(grid), clientX, clientY);
  }

  function grabFor(src, ev) {
    if (src.kind === 'stash') {
      const c = gridCellAt(ev.clientX, ev.clientY);
      if (c) return wrapOffset(c.x - src.x, c.y - src.y, src.w, src.h);
    }
    // 从装备格拖出时没有"格内偏移"可言（装备格不是网格），
    // 用左上角对齐是唯一自洽的选择：玩家瞄准的那一格就是落点的左上角。
    return { dx: 0, dy: 0 };
  }

  function makeGhost() {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    const label = document.createElement('span');
    label.className = 'g-label';
    g.appendChild(label);
    ghostHost.appendChild(g);
    return g;
  }

  function updateGhost(ev) {
    if (!drag || !drag.ghost) return;
    const sh = shapeFor(drag.src, drag.rotated);
    const cell = cellSize(gridEl() || root);
    const g = drag.ghost;
    g.style.width = `${sh.w * cell}px`;
    g.style.height = `${sh.h * cell}px`;
    g.style.left = `${ev.clientX - (drag.grab.dx + 0.5) * cell}px`;
    g.style.top = `${ev.clientY - (drag.grab.dy + 0.5) * cell}px`;
    const label = g.querySelector('.g-label');
    label.textContent = drag.src.count > 1 ? `${drag.src.label} ×${drag.src.count}` : drag.src.label;
  }

  function onDown(ev) {
    if (drag) return;
    if (ev.button !== undefined && ev.button !== 0) return; // 只响应左键（指针事件里 button=0 才是主键）
    const node = ev.target && ev.target.closest ? ev.target.closest('[data-src]') : null;
    if (!node || !root.contains(node)) return;
    const src = sourceOf(node);
    if (!src) return;
    drag = {
      src,
      node,
      startX: ev.clientX,
      startY: ev.clientY,
      px: ev.clientX,
      py: ev.clientY,
      grab: grabFor(src, ev),
      // 起手的朝向 = **当前**朝向（视图给的 rotated），按一次 R 才变成另一个
      rotated: !!src.rotated,
      target: null,
      verdict: null,
      moved: false,
      ghost: null,
    };
    node.classList.add('dragging');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKey);
  }

  function onMove(ev) {
    if (!drag) return;
    drag.px = ev.clientX;
    drag.py = ev.clientY;
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < CLICK_SLOP_PX) return;
      drag.moved = true;
      drag.ghost = makeGhost();
    }
    updateGhost(ev);
    refreshVerdict();
  }

  /** 重新算一次落点与判定（移动、以及按 R 之后都要）。 */
  function refreshVerdict() {
    drag.target = hitTest(drag.px, drag.py);
    drag.verdict = decide(drag.src, drag.target, drag.rotated);
    if (drag.ghost) {
      drag.ghost.classList.toggle('ok', !!drag.verdict.ok);
      drag.ghost.classList.toggle('bad', !drag.verdict.ok);
    }
  }

  function onKey(ev) {
    if (!drag) return;
    if (ev.code !== 'KeyR') return;
    // 只有"已经在拖"的时候才响应：否则大厅里按 R 会静默吞掉一个按键。
    if (!drag.moved) return;
    ev.preventDefault();
    drag.rotated = !drag.rotated;
    const sh = shapeFor(drag.src, drag.rotated);
    drag.grab = wrapOffset(drag.grab.dx, drag.grab.dy, sh.w, sh.h);
    updateGhost({ clientX: drag.px, clientY: drag.py });
    refreshVerdict();
  }

  function detach() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', onCancel);
    window.removeEventListener('keydown', onKey);
  }

  /**
   * 收尾：删掉幽灵元素、去掉源元素的变暗。
   * 必须**把这次拖动的对象传进来**，而不是读模块级的 `drag` ——
   * `onUp`/`onCancel` 会先把 `drag` 置空（避免重入），那时读它就只能是 null。
   * （实测踩过：`drag = null` 后再 clearDom() 会抛
   *   "Cannot read properties of null (reading 'ghost')"，而异常发生在
   *   commit() 之前 —— 表现是"松手什么都没发生"，很难从界面上看出是异常。）
   */
  function clearDom(d) {
    if (d.ghost) d.ghost.remove();
    if (d.node) d.node.classList.remove('dragging');
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    detach();
    clearDom(d);
    // 没位移 = 点击（仓库的点选/取消点选）。判定一次都不做。
    if (!d.moved) {
      click(d.src);
      return;
    }
    const res = commit(d.src, d.target, d.rotated);
    if (!res || !res.ok) reject((res && res.reason) || 'unknown-reason');
  }

  /** 取消（指针被系统抢走 / 窗口失焦）：一律**回原位** —— 不落库、不提示。 */
  function onCancel() {
    if (!drag) return;
    const d = drag;
    drag = null;
    detach();
    clearDom(d);
  }

  root.addEventListener('pointerdown', onDown);

  return {
    /** 拖动中的可观测状态（DEV 断言读它，不去读幽灵元素的像素位置）。 */
    state() {
      if (!drag) return { dragging: false, rotated: false, target: null, verdict: null };
      const sh = shapeFor(drag.src, drag.rotated);
      return {
        dragging: drag.moved,
        rotated: drag.rotated,
        target: drag.target,
        verdict: drag.verdict,
        shape: sh,
        source: { kind: drag.src.kind, uid: drag.src.uid ?? null, slotId: drag.src.slotId ?? null },
      };
    },
  };
}
