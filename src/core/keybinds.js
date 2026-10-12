// M5-8 键位定义与改键校验（纯函数）
//
// 为什么把键位表从 platform/input.js 搬到这里：
//   改键需要**三处**用同一份键位知识 —— 运行时的输入层、设置界面、以及审计工具
//   （tools/audit-keybindings.mjs）。写三份必然分叉：审计通过但游戏里冲突、
//   或者界面显示的键与实际生效的键不一致。因此键位表与校验规则只有这一份，
//   input.js 反过来从这里取。
//
// ★ 硬约束（M0-TECH-01 约束 C-19）：**游戏动作键严禁使用 Ctrl / Alt / Meta 组合**。
//   浏览器保留的快捷键无法通过 preventDefault 拦截（它们由浏览器 UI 层处理），
//   唯一可行的防御是不绑它们。历史上真实发生过：蹲下曾绑 Ctrl，"按住 Ctrl 前进"
//   = Ctrl+W 直接关闭页面。改键功能必须把这条约束**做成拒绝**，而不是靠提示。

/**
 * 动作表：id / 中文名 / 默认键位 / 是否支持"按住-切换"。
 * 这是键位的**唯一真值**（此前在 platform/input.js 里，M5-8 迁入此处）。
 */
export const ACTIONS = Object.freeze([
  { id: 'forward', label: '前进', defaults: ['KeyW'] },
  { id: 'back', label: '后退', defaults: ['KeyS'] },
  { id: 'left', label: '左移', defaults: ['KeyA'] },
  { id: 'right', label: '右移', defaults: ['KeyD'] },
  { id: 'sprint', label: '冲刺', defaults: ['ShiftLeft', 'ShiftRight'], toggleable: true },
  { id: 'crouch', label: '蹲下', defaults: ['KeyC'], toggleable: true },
  { id: 'jump', label: '跳跃', defaults: ['Space'] },
  { id: 'reload', label: '换弹', defaults: ['KeyR'] },
  { id: 'interact', label: '搜索 / 交互', defaults: ['KeyF'] },
  { id: 'leanLeft', label: '左探头', defaults: ['KeyQ'] },
  { id: 'leanRight', label: '右探头', defaults: ['KeyE'] },
  { id: 'slotPrimary', label: '主武器', defaults: ['Digit1'] },
  { id: 'slotSecondary', label: '副武器', defaults: ['Digit2'] },
  { id: 'useConsumable1', label: '绷带', defaults: ['Digit3'] },
  { id: 'useConsumable2', label: '急救包', defaults: ['Digit4'] },
]);

export const ACTION_IDS = Object.freeze(ACTIONS.map((a) => a.id));

/**
 * **锁定的动作（不可改键）** —— 制作人裁定：移动类固定。
 *
 * 理由：把 WASD 改坏之后玩家会"走不动"，而改键界面本身又在大厅里 ——
 * 一个能让自己无法移动的设置项，是最容易被误触、也最难自救的一类。
 *
 * 边界口径（**本数组就是唯一定义**，若制作人要放宽到只锁 WASD 四个方向键，
 * 改这一个数组即可，校验、界面与审计都会跟着变）：
 *   凡"影响位移"的动作都锁定 —— 前后左右 / 冲刺 / 蹲下 / 跳跃。
 *   其余 8 个（换弹 / 交互 / 左右探头 / 两个武器槽 / 两种医疗）可改。
 */
export const LOCKED_ACTIONS = Object.freeze([
  'forward', 'back', 'left', 'right', 'sprint', 'crouch', 'jump',
]);

const LOCKED_SET = new Set(LOCKED_ACTIONS);

/** 该动作是否允许改键（设置界面据此决定显示"改键"还是"固定"）。 */
export function isRebindable(actionId) {
  return ACTION_IDS.includes(actionId) && !LOCKED_SET.has(actionId);
}

/** 默认绑定（动作 → 键码数组）。从 ACTIONS 派生，不手写第二份。 */
export const DEFAULT_BINDINGS = Object.freeze(
  Object.fromEntries(ACTIONS.map((a) => [a.id, Object.freeze(a.defaults.slice())]))
);

/** 鼠标按键绑定（与键盘分开维护，但同样受审计约束）。改键不支持鼠标键 —— 属 M6+。 */
export const MOUSE_BINDINGS = Object.freeze({ fire: 0, ads: 2 });

/** 哪些动作支持"按住 / 切换"（见 input.js 的 TOGGLEABLE_ACTIONS 说明） */
export const TOGGLEABLE_ACTIONS = Object.freeze(ACTIONS.filter((a) => a.toggleable).map((a) => a.id));

/** 浏览器保留的组合键修饰符：任何游戏动作绑定到它们都视为违规（约束 C-19） */
export const FORBIDDEN_GAMEPLAY_MODIFIERS = Object.freeze([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

/**
 * 不可绑定的键码（除修饰键外）：
 *   Escape 是暂停/解锁指针的入口，绑成动作键会让玩家无法暂停；
 *   F5 / F11 / F12 与浏览器功能重复（刷新、全屏、开发者工具）；
 *   Tab 会移动焦点（阻止默认行为在部分浏览器上仍会破坏可访问性）。
 */
export const RESERVED_CODES = Object.freeze(['Escape', 'F5', 'F11', 'F12', 'Tab', 'F1']);

/** 允许绑定的键码白名单（物理键码 KeyboardEvent.code，与键盘布局无关）。 */
const LETTERS = Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`);
const DIGITS = Array.from({ length: 10 }, (_, i) => `Digit${i}`);
const FUNC = Array.from({ length: 10 }, (_, i) => `F${i + 1}`); // F11/F12 被 RESERVED 排除
const NUMPAD = Array.from({ length: 10 }, (_, i) => `Numpad${i}`);
const PUNCT = [
  'Comma', 'Period', 'Slash', 'Semicolon', 'Quote',
  'BracketLeft', 'BracketRight', 'Backslash', 'Backquote', 'Minus', 'Equal',
];
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
const MISC = ['Space', 'ShiftLeft', 'ShiftRight', 'CapsLock', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'];

export const BINDABLE_CODES = Object.freeze([
  ...LETTERS, ...DIGITS, ...FUNC, ...NUMPAD, ...PUNCT, ...ARROWS, ...MISC,
]);

const BINDABLE_SET = new Set(BINDABLE_CODES);
const RESERVED_SET = new Set(RESERVED_CODES);

/** 该键码能不能绑（用于设置界面的"这个键不行"即时反馈）。 */
export function isBindableCode(code) {
  if (typeof code !== 'string') return false;
  if (RESERVED_SET.has(code)) return false;
  return BINDABLE_SET.has(code);
}

/** 键码 → 显示名（界面与提示共用；不在这里做本地化框架，只有中英混排的短名）。 */
export function formatKey(code) {
  if (typeof code !== 'string' || !code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `小键盘${code.slice(6)}`;
  const named = {
    Space: '空格', ShiftLeft: '左Shift', ShiftRight: '右Shift', CapsLock: '大写锁定',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
    Minus: '-', Equal: '=', Insert: 'Insert', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Escape: 'Esc', Tab: 'Tab',
  };
  return named[code] || code;
}

export function actionLabel(actionId) {
  const a = ACTIONS.find((x) => x.id === actionId);
  return a ? a.label : actionId;
}

/**
 * 校验一张"覆盖绑定"表（只放被玩家改过的动作）。
 *
 * @param {object} raw 形如 { forward: ['KeyI'], ... }（也可能是任意脏数据）
 * @returns {{bindings:object, rejected:Array<{action:string, code?:string, reason:string}>}}
 *   bindings 只包含**合法**的覆盖项；被拒绝的逐条给出原因（界面要显示它，
 *   否则玩家会以为"改了没生效"是 bug）。
 */
export function sanitizeBindings(raw) {
  const bindings = {};
  const rejected = [];
  if (raw === null || raw === undefined) return { bindings, rejected };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { bindings, rejected: [{ action: '*', reason: 'not-an-object' }] };
  }

  // 先算出"默认布局"作为冲突判据的基线：一个键被默认占用，则不能改给别的动作
  const taken = new Map(); // code → action
  for (const a of ACTIONS) for (const c of a.defaults) taken.set(c, a.id);

  const entries = Object.entries(raw);
  for (const [action, codes] of entries) {
    const spec = ACTIONS.find((a) => a.id === action);
    if (!spec) {
      rejected.push({ action, reason: 'unknown-action' });
      continue;
    }
    if (LOCKED_SET.has(action)) {
      // 制作人裁定：移动类固定。这里**拒绝而不是忽略** —— 界面要能显示
      // "这个动作不可改"，否则玩家会以为改键坏了。
      rejected.push({ action, reason: 'locked-action' });
      continue;
    }
    if (!Array.isArray(codes)) {
      rejected.push({ action, reason: 'not-an-array' });
      continue;
    }
    const clean = [];
    for (const code of codes) {
      if (typeof code !== 'string') {
        rejected.push({ action, code: String(code), reason: 'not-a-string' });
        continue;
      }
      if (FORBIDDEN_GAMEPLAY_MODIFIERS.includes(code)) {
        // 约束 C-19：Ctrl/Alt/Meta 组合由浏览器保留，页面拦不住
        rejected.push({ action, code, reason: 'browser-reserved-modifier' });
        continue;
      }
      if (!isBindableCode(code)) {
        rejected.push({ action, code, reason: RESERVED_SET.has(code) ? 'reserved-key' : 'unbindable-key' });
        continue;
      }
      // 冲突判据：该键已被**另一个**动作占用（无论那个动作是默认还是本次改的）
      const owner = taken.get(code);
      if (owner && owner !== action) {
        rejected.push({ action, code, reason: `conflict-with:${owner}` });
        continue;
      }
      if (clean.includes(code)) {
        rejected.push({ action, code, reason: 'duplicate-in-same-action' });
        continue;
      }
      clean.push(code);
    }
    if (clean.length === 0) {
      // 全部键都被拒 → 这一项整体不写入（否则会出现"某个动作没有键"）
      if (!rejected.some((r) => r.action === action)) {
        rejected.push({ action, reason: 'empty-after-sanitize' });
      }
      continue;
    }
    // 生效：更新占用表（先释放该动作的默认键，再占用新键）
    for (const c of spec.defaults) if (taken.get(c) === action) taken.delete(c);
    for (const c of clean) taken.set(c, action);
    bindings[action] = clean;
  }
  return { bindings, rejected };
}

/**
 * 解析出**当前生效**的完整绑定表（默认 + 玩家覆盖）。
 *
 * 为什么运行时也必须走这里：否则"默认表"与"生效表"会变成两份，
 * 而玩家改了键之后 `input.js` 读哪一份就成了一个隐式决定。
 */
export function resolveBindings(settings) {
  const custom = settings && settings.bindings ? sanitizeBindings(settings.bindings).bindings : {};
  const out = {};
  for (const a of ACTIONS) {
    out[a.id] = custom[a.id] ? custom[a.id].slice() : a.defaults.slice();
  }
  return out;
}

/** 一张绑定表里是否有重复占用（审计工具用；sanitizeBindings 已保证不产生）。 */
export function findConflicts(bindings) {
  const seen = new Map();
  const conflicts = [];
  for (const [action, codes] of Object.entries(bindings)) {
    for (const code of codes || []) {
      if (seen.has(code)) conflicts.push({ code, actions: [seen.get(code), action] });
      else seen.set(code, action);
    }
  }
  return conflicts;
}

/** 某键码是否属于被禁止的修饰键（审计与设置界面共用一条判据）。 */
export function isForbiddenModifier(code) {
  return FORBIDDEN_GAMEPLAY_MODIFIERS.includes(code);
}
