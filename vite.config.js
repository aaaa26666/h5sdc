import { defineConfig } from 'vite';

// 跨源隔离响应头。
// 依据 M0-TECH-01 约束 C-15：所有子毫秒级性能测量必须在跨源隔离环境下进行，
// 否则 Chrome 会把 performance.now() 精度限制到 100µs，任何低于 0.1ms 的开销都会量成 0
// （M0-5 已真实踩到这个坑）。开发与预览服务都必须带上，否则本地剖析数据不可信。
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5180,
    headers: crossOriginIsolation,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: crossOriginIsolation,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // M0-TECH-01 约束 C-13：必须能看到首包体积趋势。
    // vite 自带的 reportCompressedSize 只给 gzip，brotli 由 tools/measure-bundle.mjs 产出并做门禁。
    reportCompressedSize: true,
    chunkSizeWarningLimit: 700,
  },
});
