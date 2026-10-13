// 首包体积门禁
//
// 依据 M0-TECH-01 约束 C-13：每次构建必须输出首包 brotli 大小并记录趋势，超标即阻断合入。
//   ★ C-13 冻结的是**机制**（门禁 + 趋势 + 超标阻断），不含具体数值 —— 数值在 M0-TECH-02。
// 依据 M0-TECH-02 第 1.3 节「资源预算分配框架」：JS 运行时首包上限。
//
// 对比基线：M0 实测最小可运行骨架 106.7 KB brotli。
//
// ★★ 2026-10-13 制作人裁定：JS 运行时首包上限 **200 KB → 2 MB（2048 KB）**。
//    理由与该表的性质有关：M0-TECH-02 §1.3 自标【待定】——
//    "具体数值须在 M5（局外界面成型）与 M7（资源替换）后填入实测值"。
//    M5 已完成，该行本就到期重填；本次裁定即重填。
//    该裁定**不修改** docs/01 §7.3 的任何冻结项（C-13 只规定机制，未规定数值）。
//
//    ⚠ 提高上限**不会让游戏变慢** —— 它移除的是一个保护，不是增加负担。因此这里保留
//    WARN_BROTLI_KB 预警线：《流程文档》第 14 章把「首包体积超标导致流失」登记为风险 R03，
//    取消硬线而不留任何可见信号，等于把 R03 的应对策略一并删掉。
//    预警线只打印，不阻断。
//
// 用法：先 npm run build，再 node tools/measure-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const BUDGET_BROTLI_KB = 2048;     // 2026-10-13 制作人裁定：200 → 2048（2 MB）。硬上限，超标阻断。
const WARN_BROTLI_KB = 512;        // 预警线：不阻断，只在超过时提醒（R03 的可观测性）
const M0_BASELINE_BROTLI_KB = 106.7; // M0-6 实测最小骨架

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

const html = walk(DIST).filter((f) => f.endsWith('.html'));
const referenced = new Set();
for (const h of html) {
  const text = fs.readFileSync(h, 'utf8');
  for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
    referenced.add(path.basename(m[1]));
  }
}

const rows = walk(DIST)
  .filter((f) => /\.(js|mjs|css|html)$/.test(f))
  .map((f) => {
    const buf = fs.readFileSync(f);
    const name = path.relative(DIST, f).replace(/\\/g, '/');
    const br = zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }).length;
    return {
      name,
      raw: buf.length,
      gzip: zlib.gzipSync(buf, { level: 9 }).length,
      brotli: br,
      // 首包 = HTML 直接引用的资源 + HTML 自身；其余为按需加载 chunk
      first: name.endsWith('.html') || referenced.has(path.basename(f)),
    };
  });

const KB = (n) => +(n / 1024).toFixed(1);

console.log('\n================ M1 首包体积门禁 ================\n');
console.log(`${'文件'.padEnd(38)} ${'raw KB'.padStart(9)} ${'gzip KB'.padStart(9)} ${'brotli KB'.padStart(10)}  归属`);
for (const r of rows.sort((a, b) => Number(b.first) - Number(a.first) || b.raw - a.raw)) {
  console.log(
    `${r.name.padEnd(38)} ${KB(r.raw).toString().padStart(9)} ${KB(r.gzip).toString().padStart(9)} ${KB(r.brotli).toString().padStart(10)}  ${r.first ? '首包' : '分包'}`
  );
}

const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
const first = rows.filter((r) => r.first);
const asyncChunks = rows.filter((r) => !r.first);

const firstBr = KB(sum(first, 'brotli'));
const firstGz = KB(sum(first, 'gzip'));
const firstRaw = KB(sum(first, 'raw'));

console.log('');
console.log(`★ 首包合计        raw ${firstRaw} KB | gzip ${firstGz} KB | brotli ${firstBr} KB`);
console.log(`  分包合计        brotli ${KB(sum(asyncChunks, 'brotli'))} KB（不计入首包）`);
console.log(`  门禁上限        ${BUDGET_BROTLI_KB} KB brotli（2 MB，2026-10-13 裁定）`);
console.log(`  预警线          ${WARN_BROTLI_KB} KB brotli（只提醒，不阻断）`);
console.log(`  M0 基线         ${M0_BASELINE_BROTLI_KB} KB brotli`);
console.log(`  相对 M0 基线    ${firstBr >= M0_BASELINE_BROTLI_KB ? '+' : ''}${(firstBr - M0_BASELINE_BROTLI_KB).toFixed(1)} KB`);
console.log(`  门禁余量        ${(BUDGET_BROTLI_KB - firstBr).toFixed(1)} KB`);
// 换算参考：本项目实测 brotli 压缩比约 4.3:1，上限 2 MB 对应约 8.5 MB raw。
// 流程文档 §9.2 要求"冷启动到大厅可交互 4G ≤ 20 秒"、"首包 ≤ 30 MB" ——
// 逼近预警线时这两条要一并复核，别只看门禁过没过。
console.log(`  （参考：按实测压缩比换算，2 MB brotli ≈ ${(BUDGET_BROTLI_KB * 4.26 / 1024).toFixed(1)} MB raw；`
  + `预警线 ≈ ${(WARN_BROTLI_KB * 4.26 / 1024).toFixed(1)} MB raw）`);

const outDir = path.join(ROOT, 'results');
fs.mkdirSync(outDir, { recursive: true });
const record = path.join(outDir, 'bundle-history.jsonl');
const entry = {
  at: new Date().toISOString(),
  firstRawKB: firstRaw,
  firstGzipKB: firstGz,
  firstBrotliKB: firstBr,
  asyncBrotliKB: KB(sum(asyncChunks, 'brotli')),
  budgetKB: BUDGET_BROTLI_KB,
  warnKB: WARN_BROTLI_KB,
  pass: firstBr <= BUDGET_BROTLI_KB,
};
fs.appendFileSync(record, JSON.stringify(entry) + '\n', 'utf8');
console.log(`\n  趋势已追加到 results/bundle-history.jsonl`);

if (firstBr > BUDGET_BROTLI_KB) {
  console.error(`\n  [FAIL] 首包 brotli ${firstBr} KB 超过上限 ${BUDGET_BROTLI_KB} KB`);
  process.exit(1);
}
if (firstBr > WARN_BROTLI_KB) {
  console.warn(
    `\n  [WARN] 首包 brotli ${firstBr} KB 已超过预警线 ${WARN_BROTLI_KB} KB（未越硬上限，不阻断）。\n` +
      `         风险登记 R03「首包体积超标导致流失」—— 建议复核流程文档 §9.2 的冷启动指标。`
  );
}
console.log(`\n  [PASS] 首包 brotli ${firstBr} KB，在预算内（上限 ${BUDGET_BROTLI_KB} KB）`);
