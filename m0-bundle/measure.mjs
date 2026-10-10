// M0-6 体积测量：遍历 dist，输出 raw / gzip / brotli 三种口径。
// 三种口径都要报：服务器实际传输取决于是否开 brotli，只看 raw 会严重高估。
// 用完即弃，不属于游戏产物。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

if (!fs.existsSync(DIST)) {
  console.error('dist 不存在，请先运行 node build.mjs');
  process.exit(1);
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const KB = (n) => +(n / 1024).toFixed(1);

function mb(n) {
  return +(n / 1048576).toFixed(2);
}

const variants = fs.readdirSync(DIST).filter((d) => fs.statSync(path.join(DIST, d)).isDirectory());

const report = {};
for (const v of variants) {
  const files = walk(path.join(DIST, v)).sort();
  const rows = files.map((f) => {
    const buf = fs.readFileSync(f);
    const rel = path.relative(path.join(DIST, v), f).replace(/\\/g, '/');
    const isHtml = f.endsWith('.html');
    // 只有可压缩文本才做压缩测量；图片/字体等二进制不参与
    const textLike = /\.(js|mjs|css|html|json|svg)$/.test(f);
    const gz = textLike ? zlib.gzipSync(buf, { level: 9 }).length : null;
    const br = textLike ? zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }).length : null;
    return { file: rel, isHtml, raw: buf.length, gzip: gz, brotli: br };
  });
  report[v] = rows;
}

// 判定"首包"：由 HTML 直接引用的资源（script src / link href）属于首包；
// 未被引用的 JS 是动态 import 产生的分包 chunk，不计入首包。
function splitFirstPayload(rows) {
  const html = rows.filter((r) => r.isHtml);
  const referenced = new Set();
  for (const h of html) {
    const text = fs.readFileSync(path.join(DIST, h.__variant, h.file), 'utf8');
    for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
      referenced.add(m[1].replace(/^\.?\//, ''));
    }
  }
  const first = [];
  const async_ = [];
  for (const r of rows) {
    if (r.isHtml || referenced.has(r.file)) first.push(r);
    else async_.push(r);
  }
  return { first, async: async_ };
}

console.log('\n================ M0-6 首包体积实测 ================\n');

const out = {};
for (const v of variants) {
  const rows = report[v].map((r) => ({ ...r, __variant: v }));
  console.log(`—— 变体 ${v} ——`);
  console.log(
    `${'文件'.padEnd(34)} ${'raw KB'.padStart(9)} ${'gzip KB'.padStart(9)} ${'brotli KB'.padStart(10)}  归属`
  );
  const { first, async: asyncChunks } = splitFirstPayload(rows);
  const firstSet = new Set(first.map((r) => r.file));
  for (const r of rows) {
    const tag = firstSet.has(r.file) ? '首包' : '分包';
    console.log(
      `${r.file.padEnd(34)} ${KB(r.raw).toString().padStart(9)} ${
        r.gzip === null ? '-' : KB(r.gzip)
      }`.padEnd(54) + `${r.brotli === null ? '-' : KB(r.brotli)}`.padStart(10) + `  ${tag}`
    );
  }

  const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
  const fp = { raw: sum(first, 'raw'), gzip: sum(first, 'gzip'), brotli: sum(first, 'brotli') };
  const ac = { raw: sum(asyncChunks, 'raw'), gzip: sum(asyncChunks, 'gzip'), brotli: sum(asyncChunks, 'brotli') };
  console.log(
    `${'★ 首包合计'.padEnd(34)} ${KB(fp.raw).toString().padStart(9)} ${KB(fp.gzip).toString().padStart(9)} ${KB(fp.brotli).toString().padStart(10)}`
  );
  console.log(
    `${'  分包合计(不占首包)'.padEnd(32)} ${KB(ac.raw).toString().padStart(9)} ${KB(ac.gzip).toString().padStart(9)} ${KB(ac.brotli).toString().padStart(10)}`
  );
  console.log('');
  out[v] = { rows, first: fp, asyncChunks: ac };
}

// 对照结论
console.log('================ 对照结论（首包 brotli）================');
for (const v of variants) {
  if (out[v]) console.log(`  ${v.padEnd(7)} : ${KB(out[v].first.brotli)} KB`);
}
if (out.ns && out.named) {
  const d = out.ns.first.brotli - out.named.first.brotli;
  console.log(
    `\n  命名空间导入 vs 命名导入差额：${d > 0 ? '+' : ''}${KB(d)} KB` +
      (d === 0 ? '  → 该版打包器对命名空间导入同样做了 tree-shaking，写法不构成体积差异' : '')
  );
}
if (out.full && out.named) {
  const d = out.full.first.brotli - out.named.first.brotli;
  console.log(
    `  全量保留 vs 最小集差额：+${KB(d)} KB（tree-shaking 实际省下的量，即优化上限）`
  );
}
console.log('');

const jsonPath = path.join(HERE, 'dist', 'bundle-report.json');
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`明细已写入 ${jsonPath}`);
