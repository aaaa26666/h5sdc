// 首包体积门禁
//
// 依据 M0-TECH-01 约束 C-13：每次构建必须输出首包 brotli 大小并记录趋势，超标即阻断合入。
// 依据 M0-TECH-02 第 1.3 节：JS 运行时首包上限 200 KB（brotli）。
// 对比基线：M0 实测最小可运行骨架 106.7 KB brotli。
//
// 用法：先 npm run build，再 node tools/measure-bundle.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const BUDGET_BROTLI_KB = 200;      // M0-TECH-02 规定的 JS 运行时首包上限
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
console.log(`  门禁上限        ${BUDGET_BROTLI_KB} KB brotli`);
console.log(`  M0 基线         ${M0_BASELINE_BROTLI_KB} KB brotli`);
console.log(`  相对 M0 基线    ${firstBr >= M0_BASELINE_BROTLI_KB ? '+' : ''}${(firstBr - M0_BASELINE_BROTLI_KB).toFixed(1)} KB`);
console.log(`  门禁余量        ${(BUDGET_BROTLI_KB - firstBr).toFixed(1)} KB`);

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
  pass: firstBr <= BUDGET_BROTLI_KB,
};
fs.appendFileSync(record, JSON.stringify(entry) + '\n', 'utf8');
console.log(`\n  趋势已追加到 results/bundle-history.jsonl`);

if (firstBr > BUDGET_BROTLI_KB) {
  console.error(`\n  [FAIL] 首包 brotli ${firstBr} KB 超过上限 ${BUDGET_BROTLI_KB} KB`);
  process.exit(1);
}
console.log(`\n  [PASS] 首包 brotli ${firstBr} KB，在预算内`);
