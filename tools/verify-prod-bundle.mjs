// 生产产物校验：确认 DEV-only 调试接口已被完全剔除
//
// 背景：M1-TEMP-15 要求移除调试接口，但 60+ 条自动化断言全靠它驱动。
// 直接删掉会让测试全部失效，留在生产里又是把内部状态暴露给任意页面脚本。
// 采用的方案是 `if (import.meta.env.DEV)` 门控 —— Vite 在构建时把它替换为 false，
// 整块会被 tree-shake 掉。
//
// **但"我以为它会被摇掉"不算证据。** 本脚本直接扫描构建产物里的字符串，
// 把"应该被剔除"变成可执行的断言。
//
// 用法：先 npm run build，再 node tools/verify-prod-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist 不存在，请先运行 npm run build');
  process.exit(2);
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(DIST).filter((f) => /\.(js|html|css)$/.test(f));

// 必须不存在的字符串：调试接口名与它特有的方法名。
// 只查 "__m2" 有可能被变量名巧合命中，因此同时查几个独有的方法名，
// 降低"碰巧没匹配到"的假阴性风险。
const FORBIDDEN = [
  '__m2',
  'teleportNearAi',
  'placeBehindWall',
  'aiHealthList',
  'killOneAi',
  'teleportToSafeSpot',
  'setTimeLimitMs',
  // M3 新增的调试接口（M3-BUG-01 的回归夹具依赖 teleportToContainer 的 floor 参数，
  // 以及快照里的 embedded 判据 —— 它们同样必须只存在于开发构建）
  'teleportToContainer',
  'teleportToExtract',
  'debugContainerList',
  // M6-1 新增的调试接口（武器扩到 30 把后，端到端需要一个能授予**任意**武器的夹具；
  // 它同样必须只存在于开发构建）
  'grantWeapon',
  // M6-2 的测试隔离开关（同一理由：只应存在于开发构建）
  'aiStandDown',
  // M6 携行具容量化新增的夹具（补配装 / 清空仓库 / 装配携行具 / 塞满配装 / 读网格弹药）。
  // 加进来的理由与上面每一条相同：**"我以为它会被摇掉"不算证据**。
  'restockLoadout',
  'clearStash',
  'equipCarry',
  'stuffLoadout',
  'ammoInGrid',
];

console.log('\n================ 生产产物校验（调试接口必须已被剔除）================\n');
console.log(`  产物文件数  ${files.length}`);
console.log(`  检查字符串  ${FORBIDDEN.join(', ')}\n`);

let bad = 0;
for (const s of FORBIDDEN) {
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes(s)) hits.push(path.relative(DIST, f).replace(/\\/g, '/'));
  }
  if (hits.length) {
    bad++;
    console.log(`  [FAIL] "${s}" 出现在生产产物中：${hits.join(', ')}`);
  } else {
    console.log(`  [PASS] "${s}" 未出现在任何产物中`);
  }
}

// 反向确认：产物里应当仍然含有真实游戏逻辑，避免"整个文件是空的所以什么都没匹配到"
const jsFiles = files.filter((f) => f.endsWith('.js'));
let hasGameLogic = false;
for (const f of jsFiles) {
  const text = fs.readFileSync(f, 'utf8');
  if (text.includes('WebGLRenderer') || text.includes('rifle_m4')) hasGameLogic = true;
}
console.log('');
if (!hasGameLogic) {
  console.log('  [FAIL] 产物中找不到游戏逻辑 —— 可能是构建失败，本校验的"未匹配"没有意义');
  bad++;
} else {
  console.log('  [PASS] 产物中包含真实游戏逻辑（校验不是"因为文件为空而通过"）');
}

console.log('');
if (bad) {
  console.error(`校验未通过：${bad} 项`);
  process.exit(1);
}
console.log('校验通过：调试接口已从生产构建中完全剔除，且游戏逻辑完整。');
