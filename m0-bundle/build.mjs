// M0-6 分包策略验证的构建脚本。
// 关键设计：两次构建分开跑，各自独立 tree-shake，避免 Rollup 把 three 抽成共享 vendor chunk
// 从而掩盖"命名导入 vs 命名空间导入"的体积差异。
// 用完即弃，不属于游戏产物。
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const variants = [
  { name: 'ns', entry: 'index-ns.html', label: '命名空间导入 import * as THREE（反面教材假设）' },
  { name: 'named', entry: 'index-named.html', label: '命名导入 import { ... }（推荐做法）' },
  { name: 'full', entry: 'index-full.html', label: '整个引擎全量保留（tree-shaking 收益上限对照）' },
];

fs.rmSync(path.join(HERE, 'dist'), { recursive: true, force: true });

for (const v of variants) {
  console.log(`\n[build] ${v.name} —— ${v.label}`);
  await build({
    root: HERE,
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: `dist/${v.name}`,
      emptyOutDir: true,
      // vite 8 默认使用 oxc 压缩；不要再指定 minify:'esbuild'，
      // 该路径已废弃且要求单独安装 esbuild。
      target: 'es2020',
      reportCompressedSize: false,
      rollupOptions: {
        input: path.join(HERE, v.entry),
      },
    },
  });
}

console.log('\n[build] 完成');
