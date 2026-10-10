// M0-2 一次性静态服务。仅用于给验证场景提供 HTTP 环境（ESM 与 fetch 在 file:// 下受限）。
// 用完即弃，不属于游戏产物。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 引擎改用被测对象本身，直接映射到 node_modules，不经构建。
// 注意：three r167+ 把核心拆到 three.core.js，three.module.js 会相对导入它，必须一并映射。
const VENDOR_FILES = {
  '/vendor/three.module.js': 'node_modules/three/build/three.module.js',
  '/vendor/three.core.js': 'node_modules/three/build/three.core.js',
  '/vendor/three.webgpu.js': 'node_modules/three/build/three.webgpu.js',
  '/vendor/babylon.js': 'node_modules/babylonjs/babylon.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    // 跨源隔离：浏览器据此把 performance.now() 精度从 100µs 提升到 ~5µs。
    // 不开这两个头，任何低于 0.1ms 的测量（AI 寻路/视线检测）都会量成 0。
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(body);
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/') {
      res.writeHead(302, {
        Location: '/scenes/three/index.html',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      return res.end();
    }

    let rel = VENDOR_FILES[pathname];
    if (!rel) {
      if (pathname.startsWith('/vendor/')) return send(res, 404, 'vendor not mapped: ' + pathname);
      rel = pathname.replace(/^\/+/, '');
    }

    const abs = path.resolve(ROOT, rel);
    // 目录穿越防护：确认解析结果仍在 m0-bench 内
    if (!abs.startsWith(ROOT)) return send(res, 403, 'forbidden');

    fs.readFile(abs, (err, buf) => {
      if (err) return send(res, 404, 'not found: ' + rel);
      send(res, 200, buf, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// 允许直接 node server.mjs 手测
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const { port } = await startServer(8080);
  console.log(`m0-bench static server: http://127.0.0.1:${port}/`);
}
