// M5-8 设置面板（独立模块）
//
// ★ 销 M5-TEMP-4：设置面板原先住在 ui/hud.js 里（那是"局内 UI"模块，
//   而设置是**局外/本机偏好**）。两者混在一起的结果是"局外也要 import hud"，
//   而 hud 的其余部分全是局内 HUD —— 一个模块同时承担两件事，改哪边都怕碰坏另一边。
//
// 本模块的职责边界：
//   · 只渲染（档位来自 tunables.settings.schema，**选项不在这里手写**）
//   · 只把点击转成"改哪一项、改成什么"，交给注入的 onChange
//   · 校验全在 core（sanitizeSettings / core/keybinds.js）—— 界面不判定合法性
//
// ★ 改键（M5-8）：
//   · 交互 = "点击 → 等待按键"（制作人裁定 R3）
//   · **仅大厅可用**（制作人裁定 S1）：局内如果捕获按键会与游戏输入打架
//     （例如把某动作改成 F，局内按下就会触发搜索）。由调用方通过 allowRebind 控制。
//   · 移动类动作固定不可改（制作人裁定 R3）：core/keybinds.js 的 LOCKED_ACTIONS。
//   · 鼠标键的改键不在 M5 范围（登记 M6）。

import { formatKey, isRebindable, FORBIDDEN_GAMEPLAY_MODIFIERS } from '../core/keybinds.js';

const $ = (id) => document.getElementById(id);

/** 设置项的显示名（**文案**，不是数值 —— 数值一律来自配置表） */
const LABELS = Object.freeze({
  sprintMode: '冲刺',
  crouchMode: '蹲下',
  mouseSens: '鼠标灵敏度',
  masterVolume: '主音量',
  sfxVolume: '音效音量',
  musicVolume: '音乐音量',
  graphicsQuality: '画质档位',
  touchLayout: '触屏布局',
});

/** 档位值的显示名（同样是文案） */
const VALUE_LABELS = Object.freeze({
  hold: '按住',
  toggle: '切换',
  off: '关',
  low: '低',
  normal: '标准',
  high: '高',
  veryHigh: '极高',
  medium: '中',
  auto: '自动',
  on: '开',
});

const valueLabel = (v) => VALUE_LABELS[v] || v;

export function createSettings({ onChange, onReset } = {}) {
  const el = {
    screen: $('screenSettings'),
    body: $('settingsBody'),
    toast: $('settingsToast'),
    btnClose: $('btnSettingsClose'),
    btnReset: $('btnSettingsReset'),
  };

  /** 正在等待按键的动作 id（null = 不在捕获态） */
  let capturing = null;
  /** 最近一次渲染用的视图（捕获态重绘要靠它） */
  let lastView = null;

  function toast(msg, warn) {
    if (!el.toast) return;
    el.toast.className = warn ? 'bad' : 'muted';
    el.toast.textContent = msg || '';
  }

  /** 事件委托：面板每次渲染都会重建 DOM */
  el.body.addEventListener('click', (ev) => {
    const seg = ev.target.closest('.seg[data-group]');
    if (seg) {
      onChange(seg.dataset.group, seg.dataset.value);
      return;
    }
    const rebind = ev.target.closest('[data-rebind]');
    if (rebind) {
      if (!lastView || !lastView.allowRebind) return;
      capturing = rebind.dataset.rebind;
      toast(`请按下新的按键（Esc 取消）—— ${rebind.dataset.label}`);
      render(lastView);
    }
  });

  /**
   * 捕获按键。
   * 注意：这里**不做合法性判断**，只把 code 交出去（合法性在 core/keybinds.js）。
   * 唯一的例外是修饰键组合 —— 它连"交出去"都不该发生：浏览器保留的组合
   * （Ctrl/Alt/Meta）在页面里根本拦不住，捕获它们毫无意义。
   */
  window.addEventListener('keydown', (ev) => {
    if (!capturing) return;
    ev.preventDefault();
    const action = capturing;
    const label = lastView && lastView.bindings.find((b) => b.id === action);
    if (ev.code === 'Escape') {
      capturing = null;
      toast('已取消改键');
      render(lastView);
      return;
    }
    if (ev.ctrlKey || ev.altKey || ev.metaKey || FORBIDDEN_GAMEPLAY_MODIFIERS.includes(ev.code)) {
      toast('这个组合被浏览器保留（会关标签页 / 刷新等），不能用作动作键', true);
      return; // 保持捕获态，让玩家换一个键
    }
    capturing = null;
    onChange('bindings', { action, code: ev.code });
    void label;
  });

  function render(view) {
    lastView = view;
    if (!view) {
      el.body.innerHTML = '';
      return;
    }

    const optRows = view.options
      .map((o) => {
        const segs = o.values
          .map(
            (v) =>
              `<span class="seg ${v === o.current ? 'on' : ''}" data-group="${o.key}" data-value="${v}">${valueLabel(v)}</span>`
          )
          .join('');
        return `<div class="row opt"><span class="k">${o.label}</span><span>${segs}</span></div>`;
      })
      .join('');

    const bindRows = view.bindings
      .map((b) => {
        const keys = b.keys.map(formatKey).join(' / ');
        if (b.locked) {
          return `<div class="row opt"><span class="k">${b.label}</span><span class="muted">${keys}（移动类固定，不可改）</span></div>`;
        }
        const waiting = capturing === b.id;
        return (
          `<div class="row opt"><span class="k">${b.label}</span><span>` +
          `<span class="mini ${waiting ? 'on' : ''}" data-rebind="${b.id}" data-label="${b.label}">` +
          `${waiting ? '按键中…（Esc 取消）' : `改键（当前 ${keys}）`}</span></span></div>`
        );
      })
      .join('');

    el.body.innerHTML =
      `<div class="row"><span class="k">操作方式</span><span class="muted">档位与键位都来自配置表 / 校验器</span></div>` +
      optRows +
      `<div class="row"><span class="k">键位</span><span class="muted">${
        view.allowRebind ? '点击后按新键；移动类不可改' : '仅大厅可改键（局内不开放）'
      }</span></div>` +
      bindRows +
      `<p class="muted" style="margin-top:12px">
         非法取值（改坏 localStorage、旧版本结构、Ctrl 组合键）会被校验并回落默认值，游戏不会因此崩。<br />
         画质档位的具体参数与音量分轨的倍率都在配置表里；音乐轨已接上总线，BGM 属 M7。${
           view.notes ? `<br />${view.notes}` : ''
         }
       </p>`;
  }

  el.btnClose.addEventListener('click', () => {
    capturing = null;
    if (lastView && lastView.onClose) lastView.onClose();
  });
  el.btnReset.addEventListener('click', () => {
    capturing = null;
    if (onReset) onReset();
  });

  return {
    el,
    render,
    show(on) {
      el.screen.classList.toggle('on', on);
      if (!on) capturing = null;
    },
    /** 是否正在等待按键（断言用：捕获态下按下的键不会被当成游戏内动作） */
    capturing: () => capturing,
    toast,
    isRebindable,
  };
}
