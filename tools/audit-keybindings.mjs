// 按键绑定静态审计
//
// 存在原因：浏览器保留快捷键**无法通过 preventDefault 拦截**，且 CDP 合成的按键
// 走渲染进程、不会触发浏览器 UI 快捷键，因此**自动化冒烟测试天然抓不到这类缺陷**
// （真实事故：蹲下绑定 Ctrl + 前进 W = Ctrl+W 直接关闭标签页，用户试玩才发现）。
// 既然动态测试测不到，就必须用静态审计来防回归。
//
// 本脚本直接 import 游戏代码里的 DEFAULT_BINDINGS，不是正则抓文本 ——
// 因此只要绑定表被改动，审计结果一定随之变化，不会出现"改了代码但审计还绿"的情况。
//
// 用法：node tools/audit-keybindings.mjs   （违规时 exit 1，可接入 CI）
import { DEFAULT_BINDINGS, FORBIDDEN_GAMEPLAY_MODIFIERS } from '../src/platform/input.js';

// 浏览器保留组合（说明性清单，用于报告里指出"具体会撞上哪条"）
const RESERVED = [
  { combo: 'Ctrl+W', key: 'KeyW', what: '关闭标签页' },
  { combo: 'Ctrl+Shift+W', key: 'KeyW', what: '关闭窗口' },
  { combo: 'Ctrl+T', key: 'KeyT', what: '新建标签页' },
  { combo: 'Ctrl+N', key: 'KeyN', what: '新建窗口' },
  { combo: 'Ctrl+Tab', key: 'Tab', what: '切换标签页' },
  { combo: 'Ctrl+R / F5', key: 'KeyR', what: '刷新页面' },
  { combo: 'Ctrl+D', key: 'KeyD', what: '收藏' },
  { combo: 'Ctrl+S', key: 'KeyS', what: '保存页面' },
  { combo: 'Ctrl+P', key: 'KeyP', what: '打印' },
  { combo: 'Ctrl+O', key: 'KeyO', what: '打开文件' },
  { combo: 'Ctrl+F', key: 'KeyF', what: '查找' },
  { combo: 'Ctrl+L', key: 'KeyL', what: '定位地址栏' },
  { combo: 'Ctrl+A', key: 'KeyA', what: '全选' },
];

const problems = [];
const warnings = [];

// 规则 1（硬性）：游戏动作不得绑定 Ctrl / Alt / Meta
// 原因：玩家必然会把它与 WASD 同时按下，从而触发浏览器保留快捷键。
for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
  for (const code of codes) {
    if (FORBIDDEN_GAMEPLAY_MODIFIERS.includes(code)) {
      problems.push(
        `动作 "${action}" 绑定了修饰键 ${code} —— ` +
          `玩家与 WASD 同时按下时会触发浏览器快捷键，且页面无法拦截`
      );
    }
  }
}

// 规则 2（硬性）：同一个按键不得绑定到多个动作
//
// 为什么必须单独查这条：规则 1 只管"修饰键"，对"两个动作抢同一个键"完全无感。
// 本审计初版就只查规则 1，于是漏掉了真实发生的冲突 ——
// leanRight 与 interact 都绑了 KeyE，导致"右探头"和"搜刮"同时被触发。
// 教训：**一个只检查某类问题的守卫，会让人误以为其他类问题也有人管。**
const keyToActions = new Map();
for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
  for (const code of codes) {
    if (!keyToActions.has(code)) keyToActions.set(code, []);
    keyToActions.get(code).push(action);
  }
}
for (const [code, actions] of keyToActions) {
  if (actions.length > 1) {
    problems.push(
      `按键 ${code} 被多个动作同时占用：${actions.join(' / ')} —— ` +
        `一次按键会触发全部这些动作`
    );
  }
}

// 规则 3（提示）：动作键与某个保留组合的字母键重名，需要人工确认是否有风险组合
const boundKeys = new Set(keyToActions.keys());
for (const r of RESERVED) {
  if (boundKeys.has(r.key)) {
    warnings.push(
      `键 ${r.key} 被游戏动作使用；它与 Ctrl 组合是 "${r.combo}"（${r.what}）。` +
        `当前未绑定 Ctrl，故安全；但未来做按键自定义时**必须拒绝 Ctrl/Alt/Meta 组合**`
    );
  }
}

console.log('\n================ 按键绑定静态审计 ================\n');
console.log('当前绑定：');
for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
  console.log(`  ${action.padEnd(10)} ${codes.join(' / ')}`);
}

console.log('\n规则 1：游戏动作不得绑定 Ctrl / Alt / Meta');
if (problems.some((p) => p.includes('修饰键'))) {
  for (const p of problems.filter((p) => p.includes('修饰键'))) console.log(`  [FAIL] ${p}`);
} else {
  console.log('  [PASS] 未发现违规绑定');
}

console.log('\n规则 2：同一按键不得绑定到多个动作');
const dupProblems = problems.filter((p) => p.includes('被多个动作同时占用'));
if (dupProblems.length) {
  for (const p of dupProblems) console.log(`  [FAIL] ${p}`);
} else {
  console.log(`  [PASS] ${keyToActions.size} 个按键各自只对应一个动作`);
}

console.log('\n规则 3：与浏览器保留组合的潜在冲突提示');
for (const w of warnings) console.log(`  [提示] ${w}`);

console.log('');
if (problems.length) {
  console.error(`审计未通过：${problems.length} 项违规`);
  process.exit(1);
}
console.log('审计通过。');
console.log('注意：本审计只能防止"绑定表本身写错"这一类回归（修饰键、重复占用）；');
console.log('      按键自定义功能（M2/M5）上线后，必须在 UI 层同样执行这两条规则，');
console.log('      否则玩家自己就能绑出一个会关页面或一次触发两个动作的键。');
