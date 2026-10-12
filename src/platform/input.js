// M1-2 输入层（键鼠）
//
// 职责：键盘状态、鼠标视角增量、指针锁定。
// [M1-TEMP-1] 输入直接绑死键鼠，未做统一动作映射层。
//             原因：M1 只有 PC 键鼠一种输入。
//             M2 重写清单：改为动作语义映射层（前后左右/开火/换弹/交互），
//             为后续按键自定义与手柄预留，且业务逻辑不得直接读按键码。
// 平台范围依据：M0-TECH-01 —— 目标平台仅 PC 浏览器，故不处理触屏。
//
// ★ M5-8：键位表与改键校验已迁至 src/core/keybinds.js（那里是唯一真值）。
//   本文件改为从它取默认绑定，并在设置变更后重新解析生效绑定。
//   原因：改键需要输入层、设置界面、审计工具三处共用同一份键位知识，
//   写三份必然分叉（审计通过但游戏里冲突）。

import {
  ACTIONS,
  DEFAULT_BINDINGS,
  MOUSE_BINDINGS,
  FORBIDDEN_GAMEPLAY_MODIFIERS,
  TOGGLEABLE_ACTIONS,
  resolveBindings,
} from '../core/keybinds.js';

// 兼容性再导出：审计工具与单测此前从本文件取这几个常量。
// 保留出口可以让那些检查一行不改地继续工作，而真值已经只有一份。
export { DEFAULT_BINDINGS, MOUSE_BINDINGS, FORBIDDEN_GAMEPLAY_MODIFIERS, TOGGLEABLE_ACTIONS, ACTIONS };

/**
 * M1 默认按键绑定。
 *
 * 【必须遵守的硬约束】浏览器保留快捷键**无法通过 preventDefault 拦截** ——
 * 它们由浏览器 UI 层处理，不走页面的可取消路径。因此页面唯一能做的防御是
 * **不要把这些组合用作游戏动作键**。
 *
 * 已知会被浏览器抢走的组合（非完整列表）：
 *   Ctrl+W 关闭标签页      Ctrl+Shift+W 关闭窗口     Ctrl+T  新标签页
 *   Ctrl+N 新窗口          Ctrl+Tab     切换标签页   Ctrl+1..9 切换标签页
 *   Ctrl+R / F5 刷新       Ctrl+L       定位地址栏   Ctrl+D  收藏
 *   Ctrl+S 保存            Ctrl+P       打印         Ctrl+O  打开文件
 *   Ctrl+F 查找            Alt         （Windows 上可能激活菜单栏）
 *
 * 结论性规则：**游戏动作键严禁绑定 Ctrl / Alt / Meta**，
 * 因为玩家必然会把它与 WASD 同时按下，从而触发浏览器快捷键。
 *
 * 历史缺陷（真实发生）：蹲下曾绑定 Ctrl，于"按住 Ctrl 前进"= Ctrl+W
 * 直接关闭页面，在 QQ 浏览器等 Chromium 系浏览器上可复现。
 * 已改为 KeyC。回归防护见 tools/audit-keybindings.mjs（静态审计，CI 可跑），
 * 而**运行时**的防护是 core/keybinds.js 的 sanitizeBindings（改键时直接拒绝）。
 */

export function createInput(domElement, cfg, settings) {
  const keys = new Set();
  // ★ M5-8：生效绑定（默认 + 玩家覆盖）。设置变更后由 main.js 调 syncSettings 重建，
  //   而不是每次查询都重新解析 —— 一次 resolveBindings 要遍历全部动作，
  //   而动作查询每帧会被调用几十次。
  let currentSettings = settings;
  let bindings = resolveBindings(currentSettings);
  const state = {
    // 鼠标累计增量，消费后清零
    mouseDX: 0,
    mouseDY: 0,
    firePressed: false,   // 本帧是否有开火请求（单发式，消费后清零）
    fireHeld: false,      // 左键是否按住（连发用）
    adsHeld: false,       // 右键是否按住（开镜）
    wheelDelta: 0,        // 滚轮累计（消费后清零）
    pointerLocked: false,
    lockedChangeHandlers: [],
    // 视角瞬移诊断：本会话见到的最大单事件增量、被判定为异常而丢弃的事件数
    maxEventDelta: 0,
    spikeEvents: 0,
    lastSpikeDelta: 0,
    lastSpikeSpeed: 0,
  };

  // 异常鼠标事件的判定参数（见 onMouseMove）
  const spikeThresholdPx = cfg.player.mouseSpikeThresholdPx ?? 400;
  const maxSpeedPxPerMs = cfg.player.mouseMaxSpeedPxPerMs ?? 30;
  let ignoreMovesUntil = 0;
  let lastMoveAt = 0;

  const anyDown = (codes) => {
    for (let i = 0; i < codes.length; i++) if (keys.has(codes[i])) return true;
    return false;
  };

  // 本帧新按下的键（用于"切换"模式的边沿检测）。
  // 必须在 beginFrame() 里处理并清空 —— 边沿信息跨帧累积会误触发。
  const justPressed = new Set();

  /**
   * 本帧的边沿集合。justPressed 在 beginFrame 里被清空，但**一次性动作**
   * （切枪、换弹、用消耗品）必须在整个帧内都能查到这次按下，因此单独留一份。
   *
   * 为什么必须有它：动作查询原本全是电平式（keys.has），而自动化测试与真实玩家的
   * "轻点一下"完全可能整个落在两帧之间 —— 表现为"按了 2 但没切枪"。
   * 这类漏触发在真人手里同样会发生（快速点按），不是测试环境特有的。
   */
  const frameEdges = new Set();

  // "按住/切换"两种模式的运行态
  const toggleOn = { sprint: false, crouch: false };
  const activeState = { sprint: false, crouch: false };

  // 需要阻止默认行为的按键（能被拦的才拦；浏览器保留组合拦不住，见 DEFAULT_BINDINGS 注释）
  const PREVENT_DEFAULT_CODES = new Set(['Space', 'Tab', 'F1']);

  const onKeyDown = (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    justPressed.add(e.code);
    // 阻止页面滚动/焦点跳转等默认行为。
    // 注意：Ctrl+W 这类浏览器保留快捷键走到这里也拦不住，页面无法阻止关闭标签页。
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
  };
  const onKeyUp = (e) => keys.delete(e.code);

  const onMouseMove = (e) => {
    if (!state.pointerLocked) return;

    // ★ 指针锁定刚取得时，浏览器可能把"光标归位到窗口中心"也报成一次移动，
    // movementX/Y 会是一个异常大的值（量级等于窗口尺寸，可达上千像素）。
    // 直接应用它的后果就是**视角瞬移**：一次事件转掉上百度。
    if (performance.now() < ignoreMovesUntil) return;

    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    const mag = Math.max(Math.abs(dx), Math.abs(dy));

    // ★ 判定"异常单次事件"用**物理推断速度**，而不是固定像素数。
    //
    // 为什么不用固定像素阈值：它无法区分两种情况 ——
    //   · 一帧内被合并的合法快速甩枪（位移大但速度正常）
    //   · 光标归位产生的异常事件（位移大且速度物理上不可能）
    // 用事件时间戳算出隐含速度就能分开，而且与帧率、鼠标回报率都无关。
    //
    // 量级依据：人手甩枪上限约 1000~1500°/s，换算约 8000~12000 px/s。
    // 阈值取 30 px/ms（=30000 px/s）留了约 2.5 倍余量；
    // 而光标归位事件是"1ms 内移动几百像素"级别（>100000 px/s），必定被拦下。
    const dtMs = e.timeStamp - lastMoveAt;
    lastMoveAt = e.timeStamp;
    let spike = mag > spikeThresholdPx; // 绝对兜底（时间戳不可用时）
    let impliedSpeed = 0;
    if (!spike && dtMs > 0 && dtMs < 100) {
      impliedSpeed = mag / dtMs;
      if (impliedSpeed > maxSpeedPxPerMs) spike = true;
    }
    if (spike) {
      state.spikeEvents++;
      state.lastSpikeDelta = mag;
      state.lastSpikeSpeed = +impliedSpeed.toFixed(1);
      return;
    }

    state.mouseDX += dx;
    state.mouseDY += dy;
    if (mag > state.maxEventDelta) state.maxEventDelta = mag;
  };

  const onMouseDown = (e) => {
    if (e.button === MOUSE_BINDINGS.fire) {
      state.firePressed = true;
      state.fireHeld = true;
    } else if (e.button === MOUSE_BINDINGS.ads) {
      state.adsHeld = true;
    }
  };
  const onMouseUp = (e) => {
    if (e.button === MOUSE_BINDINGS.fire) state.fireHeld = false;
    else if (e.button === MOUSE_BINDINGS.ads) state.adsHeld = false;
  };
  const onWheel = (e) => {
    state.wheelDelta += Math.sign(e.deltaY);
  };
  // 右键会弹出上下文菜单，必须屏蔽，否则开镜时菜单会打断操作
  const onContextMenu = (e) => e.preventDefault();

  const onLockChange = () => {
    state.pointerLocked = document.pointerLockElement === domElement;
    if (!state.pointerLocked) {
      // 失焦时清空按键，避免"卡住一直前进"
      keys.clear();
      state.fireHeld = false;
      state.mouseDX = 0;
      state.mouseDY = 0;
    } else {
      // 刚拿回锁定：丢弃紧随其后的一小段移动（那段里可能夹着光标归位事件），
      // 并清掉可能在失焦期间残留的累计量。
      ignoreMovesUntil = performance.now() + 80;
      state.mouseDX = 0;
      state.mouseDY = 0;
    }
    for (const h of state.lockedChangeHandlers) h(state.pointerLocked);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerlockchange', onLockChange);

  return {
    state,
    /** 当前设置（按住/切换模式）。由 main.js 在设置页变更时同步过来 */
    get settings() {
      return currentSettings;
    },
    /**
     * 设置变更后重建生效绑定（M5-8）。
     * 改键必须**立刻生效**：若要求"重进游戏才生效"，玩家会以为改键失败。
     */
    syncSettings(next) {
      currentSettings = next;
      bindings = resolveBindings(currentSettings);
    },
    /** 当前生效的键位表（供界面显示"实际生效的是什么"，避免与默认表分叉） */
    bindingsOf: () => bindings,

    /**
     * 每帧最开始调用一次：处理"切换"模式的边沿，并清空边沿缓冲。
     * 必须在任何动作查询之前调用，否则切换模式会读到上一帧的状态。
     */
    beginFrame() {
      // 先把本帧边沿快照下来，再清空 justPressed
      const snapshotEdges = Array.from(justPressed);
      for (const action of TOGGLEABLE_ACTIONS) {
        const codes = bindings[action];
        const down = anyDown(codes);
        let edge = false;
        for (const c of codes) {
          if (justPressed.has(c)) {
            edge = true;
            break;
          }
        }
        const mode = currentSettings[action + 'Mode'];
        if (mode === 'toggle') {
          if (edge) toggleOn[action] = !toggleOn[action];
          activeState[action] = toggleOn[action];
        } else {
          activeState[action] = down;
          // 从"切换"切回"按住"时同步一次，避免切换模式遗留的常开状态残留
          toggleOn[action] = down;
        }
      }
      justPressed.clear();
      // 保留本帧边沿供一次性动作查询（见 frameEdges 说明）
      frameEdges.clear();
      for (const c of snapshotEdges) frameEdges.add(c);
    },

    /** 冲刺是否生效（已按模式解析） */
    sprintActive: () => activeState.sprint,
    /** 蹲下是否生效（已按模式解析） */
    crouchActive: () => activeState.crouch,

    /**
     * 本帧是否**新按下**某个动作（边沿）。
     * 适用于"一次性"动作：切枪、换弹、用消耗品。
     * 不适用于持续动作：移动、开镜、探头、搜索。
     */
    pressedAction(action) {
      const codes = bindings[action];
      if (!codes) return false;
      for (const c of codes) if (frameEdges.has(c)) return true;
      return false;
    },

    /** 请求指针锁定（必须在用户手势回调内调用） */
    requestLock() {
      if (!domElement.requestPointerLock) return;
      try {
        const p = domElement.requestPointerLock();
        // Chrome 新版返回 Promise，失败会 reject。**必须吞掉**：
        //   指针锁定是"可失败的外部权限"（用户可拒绝、浏览器策略可阻止、
        //   文档状态不满足时也会失败），失败绝不能中断游戏逻辑，
        //   更不能变成未捕获的 Promise 拒绝污染控制台。
        //   失败后的兜底：玩家点击画面会再次请求（见 main.js 的 canvas click）。
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {
        // 旧版同步抛错的路径同样静默降级
      }
    },
    exitLock() {
      if (document.exitPointerLock) document.exitPointerLock();
    },
    onLockedChange(fn) {
      state.lockedChangeHandlers.push(fn);
    },

    isDown(code) {
      return keys.has(code);
    },
    /** 消费本帧鼠标增量 */
    consumeMouse() {
      const dx = state.mouseDX;
      const dy = state.mouseDY;
      state.mouseDX = 0;
      state.mouseDY = 0;
      return { dx, dy };
    },
    /** 消费本帧开火请求 */
    consumeFirePressed() {
      const v = state.firePressed;
      state.firePressed = false;
      return v;
    },

    // 动作查询。仍直接读按键码（见 [M1-TEMP-1]），但按键集合统一来自
    // DEFAULT_BINDINGS，避免键位散落在多处而漏改。
    // sprint / crouch 已改走 beginFrame() 解析后的状态，以支持"按住/切换"。
    forward: () => anyDown(bindings.forward),
    back: () => anyDown(bindings.back),
    left: () => anyDown(bindings.left),
    right: () => anyDown(bindings.right),
    jump: () => anyDown(bindings.jump),
    reload: () => anyDown(bindings.reload),
    interact: () => anyDown(bindings.interact),
    // 探头固定为按住式，见 TOGGLEABLE_ACTIONS 的说明
    leanLeft: () => anyDown(bindings.leanLeft),
    leanRight: () => anyDown(bindings.leanRight),

    // ---- M2 新增动作 ----
    ads: () => state.adsHeld,
    /**
     * 左键是否按住。M3-3 的搜索打断规则需要"开火即打断"这个信号
     * （规则本体在 loot.json 的 interruptRules，这里只提供事实）。
     */
    firing: () => state.fireHeld,
    slotPrimary: () => anyDown(bindings.slotPrimary),
    slotSecondary: () => anyDown(bindings.slotSecondary),
    useConsumable1: () => anyDown(bindings.useConsumable1),
    useConsumable2: () => anyDown(bindings.useConsumable2),
    /** 消费滚轮增量（正=向下滚） */
    consumeWheel() {
      const d = state.wheelDelta;
      state.wheelDelta = 0;
      return d;
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerlockchange', onLockChange);
    },
  };
}
