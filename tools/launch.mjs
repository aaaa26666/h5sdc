// 一键启动器
//
// 设计取舍：
//   1) 默认服务**生产构建**（dist/）而不是 dev server。
//      理由：dev 构建里带着测试接口（虽然已 DEV 门控，但 dev 模式下它确实存在），
//      且首次编译明显更慢。玩家启动器应当跑产物，与 tools/verify-prod-bundle.mjs
//      验证过的那个构建保持一致。
//   2) 自己起静态服务而不用 `vite preview`：
//      可以自行控制 MIME、缓存头、COOP/COEP，并且**端口被占时能自动换一个**，
//      不会因为上次没关干净就起不来。
//   3) 启动前做"源码比产物新"的检查并自动重建 ——
//      否则会出现"我明明改了代码，启动的还是旧版本"这种最难排查的困惑。
//   4) 依赖缺失时自动 npm install，且**默认源失败后回退到镜像**
//      （本机实测 registry.npmjs.org 不可达，npmmirror 可达）。
//
// 用法：node tools/launch.mjs [--port 5180] [--no-open] [--rebuild] [--dev]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const optVal = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const WANT_PORT = Number(optVal('--port', '5180'));
const AUTO_OPEN = !has('--no-open');
const FORCE_REBUILD = has('--rebuild');
const DEV_MODE = has('--dev');

const MIRROR = 'https://registry.npmmirror.com';

function banner(title) {
  const line = '='.repeat(64);
  console.log('');
  console.log(line);
  console.log('  ' + title);
  console.log(line);
}
function step(msg) {
  console.log('  · ' + msg);
}
function ok(msg) {
  console.log('  ✓ ' + msg);
}
function warn(msg) {
  console.log('  ! ' + msg);
}
function fail(msg) {
  console.error('  ✗ ' + msg);
}

// ---------------- 1. 依赖 ----------------
function ensureDependencies() {
  const vitePkg = path.join(ROOT, 'node_modules', 'vite', 'package.json');
  const threePkg = path.join(ROOT, 'node_modules', 'three', 'package.json');
  if (fs.existsSync(vitePkg) && fs.existsSync(threePkg)) {
    ok('依赖已就绪');
    return true;
  }
  warn('缺少依赖，正在安装（首次运行需要联网，可能需要一两分钟）…');
  // 注意：Windows 上 npm 是 .cmd，Node 无法直接 spawn，必须经过 shell。
  // 但 shell:true 与"args 数组"混用会触发 DEP0190（参数只拼接不转义），
  // 因此这里把整条命令作为**单个字符串**传入，参数全部是代码里的字面量，无注入面。
  let r = runShell('npm install --no-audit --no-fund');
  if (r.status !== 0) {
    warn('默认源安装失败，改用镜像源重试…');
    r = runShell(`npm install --no-audit --no-fund --registry=${MIRROR}`);
  }
  if (r.status !== 0) {
    fail('依赖安装失败。请检查网络后手动执行：npm install');
    return false;
  }
  ok('依赖安装完成');
  return true;
}

/** 经 shell 执行一条命令。Windows 下 npm/npx 是 .cmd，必须走 shell */
function runShell(command) {
  return spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
}

// ---------------- 2. 构建 ----------------
function newestMtime(dir, filter) {
  let newest = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!filter || filter(p)) {
        const t = fs.statSync(p).mtimeMs;
        if (t > newest) newest = t;
      }
    }
  };
  walk(dir);
  return newest;
}

function needsBuild() {
  if (FORCE_REBUILD) return '指定了 --rebuild';
  const indexHtml = path.join(DIST, 'index.html');
  if (!fs.existsSync(indexHtml)) return '产物不存在';
  const distTime = fs.statSync(indexHtml).mtimeMs;
  const srcTime = newestMtime(path.join(ROOT, 'src'), (p) => p.endsWith('.js') || p.endsWith('.json'));
  const htmlTime = fs.existsSync(path.join(ROOT, 'index.html'))
    ? fs.statSync(path.join(ROOT, 'index.html')).mtimeMs
    : 0;
  const cfgTime = fs.existsSync(path.join(ROOT, 'vite.config.js'))
    ? fs.statSync(path.join(ROOT, 'vite.config.js')).mtimeMs
    : 0;
  const newestSource = Math.max(srcTime, htmlTime, cfgTime);
  if (newestSource > distTime) {
    return `源码比产物新（产物 ${new Date(distTime).toLocaleString()}，源码 ${new Date(newestSource).toLocaleString()}）`;
  }
  return null;
}

function build() {
  step('正在构建生产版本…');
  const r = runShell('npm run build');
  if (r.status !== 0) {
    fail('构建失败。请先手动运行 npm run build 查看具体错误。');
    return false;
  }
  ok('构建完成');
  return true;
}

// ---------------- 3. 静态服务 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function startServer(port) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const abs = path.resolve(DIST, '.' + rel);
    // 目录穿越防护
    if (!abs.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        // SPA 回退：找不到具体文件时返回 index.html（本项目当前是单页）
        fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
          if (e2) {
            res.writeHead(404).end('not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
        });
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        // 与 vite.config.js 保持一致：开启跨源隔离。
        // 玩法本身不依赖它，但保留可让"帧时间/子毫秒测量"在浏览器控制台里可信
        // （M0-TECH-01 约束 C-15）。
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        // 产物带内容哈希，可以放心长缓存；index.html 不缓存
        'Cache-Control': abs.endsWith('index.html')
          ? 'no-cache'
          : 'public, max-age=31536000, immutable',
      });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * 探测该端口上是否**已经跑着本游戏**。
 * 目的：一键启动器被连点两次时，不应该起两个服务、开两个标签页，
 * 而应该识别出"已经在运行"并直接把浏览器指向既有实例。
 */
function probeExistingGame(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: 1200 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 8192) req.destroy();
        });
        res.on('end', () => {
          // 用页面标题里的独有字样做判据：既是本游戏的标识，
          // 又不会把别人的 dev server 误认成我们的
          resolve(res.statusCode === 200 && body.includes('搜打撤'));
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function listenWithFallback(startPort, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const p = startPort + i;
    try {
      const server = await startServer(p);
      if (i > 0) warn(`端口 ${startPort} 被占用，已改用 ${p}`);
      return { server, port: p };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`从 ${startPort} 起连续 ${tries} 个端口都被占用`);
}

// ---------------- 4. 打开浏览器 ----------------
function openBrowser(url) {
  step('正在打开浏览器…');
  try {
    if (process.platform === 'win32') {
      // start 的第一个参数是窗口标题，必须给空串，否则会把 URL 当成标题
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) {
    warn('自动打开浏览器失败，请手动访问上面的地址');
    return false;
  }
}

// ---------------- 主流程 ----------------
banner('H5 搜打撤 PVE · 一键启动');

if (DEV_MODE) {
  warn('--dev 模式：将改用 vite dev server（含调试接口、首次编译较慢）');
  const child = spawn('npm run dev', { cwd: ROOT, stdio: 'inherit', shell: true });
  child.on('exit', (c) => process.exit(c ?? 0));
} else {
  if (!ensureDependencies()) process.exit(1);

  const reason = needsBuild();
  if (reason) {
    ok(`需要构建：${reason}`);
    if (!build()) process.exit(1);
  } else {
    ok('产物是最新的，跳过构建（如需强制重建，加 --rebuild）');
  }

  const size = (() => {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(DIST);
    return (total / 1024).toFixed(1);
  })();

  // 已经在跑就直接用，不重复起服务
  const existing = await probeExistingGame(WANT_PORT);
  if (existing) {
    const url = `http://127.0.0.1:${WANT_PORT}/`;
    console.log('');
    ok(`检测到游戏已在运行：${url}`);
    step('直接打开浏览器，不重复启动服务');
    console.log('');
    console.log('  如需停止，请关闭最初那个启动器窗口（或在其中按 Ctrl+C）。');
    console.log('');
    if (AUTO_OPEN) openBrowser(url);
    process.exit(0);
  }

  let started;
  try {
    started = await listenWithFallback(WANT_PORT);
  } catch (e) {
    fail(e.message);
    console.log('  提示：可以指定其它端口，例如  node tools/launch.mjs --port 6000');
    process.exit(1);
  }

  const url = `http://127.0.0.1:${started.port}/`;
  console.log('');
  ok(`服务已启动：${url}`);
  ok(`产物大小：${size} KB（生产构建，不含调试接口）`);
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  游戏已就绪，浏览器会自动打开。                          │');
  console.log('  │  若没有自动打开，请手动访问上面那个地址。                │');
  console.log('  │                                                          │');
  console.log('  │  操作：W A S D 移动 · 鼠标转视角 · 左键射击 · 右键开镜  │');
  console.log('  │        1/2 切枪 · R 换弹 · Shift 冲刺 · C 蹲下           │');
  console.log('  │        Q/E 左右探头 · F 搜索容器 · 3/4 用绷带/急救包      │');
  console.log('  │        Esc 解锁指针（可打开设置）                        │');
  console.log('  │                                                          │');
  console.log('  │  关闭本窗口 或 按 Ctrl+C 即可停止服务。                  │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  console.log('');

  if (AUTO_OPEN) openBrowser(url);

  const shutdown = () => {
    console.log('\n  正在停止服务…');
    started.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
