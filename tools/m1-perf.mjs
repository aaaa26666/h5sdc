// M1 性能数据记录
//
// M1 明确"禁止优化性能，不设性能门禁，只记录数据"。本脚本只做记录，不做判定。
// 采用**外部注入**的 rAF 采样器，不修改任何游戏代码 —— 避免为了测性能而污染 M1 代码。
//
// 用法：另开终端跑 npm run dev，然后 node tools/m1-perf.mjs [url] [采样秒数]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const URL_BASE = process.argv[2] || 'http://127.0.0.1:5180/';
const SAMPLE_SEC = Number(process.argv[3] || 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome');
}

const browser = await launch({
  executablePath: findChrome(),
  headless: false,
  defaultViewport: null,
  args: [
    '--no-first-run',
    '--window-size=1600,1000',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
    '--enable-precise-memory-info',
    // 必须关掉垂直同步：本机显示器 165Hz，开着会把帧时间锁在 6.06ms，
    // 于是"待机"和"交战"测出来一模一样，等于没测出任何性能余量。
    // 依据 M0-TECH-01 约束 C-17：判定以帧时间为准，且必须避免被刷新率掩盖。
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
  protocolTimeout: 120000,
});

const page = await browser.newPage();
await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__m1 !== undefined', { timeout: 30000 });

const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
    dpr: window.devicePixelRatio,
    size: [window.innerWidth, window.innerHeight],
    timerResMs: (() => {
      let min = Infinity, prev = performance.now();
      for (let i = 0; i < 100000; i++) {
        const n = performance.now();
        const d = n - prev;
        if (d > 0 && d < min) min = d;
        prev = n;
      }
      return min;
    })(),
  };
});

await page.click('#btnStart');
await page.waitForFunction(() => window.__m1.snapshot().flow === 'raid', { timeout: 10000 });

// 在页面里注入独立采样器（不改游戏代码）
const sample = (ms) =>
  page.evaluate(
    (dur) =>
      new Promise((res) => {
        const ts = [];
        let t0 = 0;
        let prev = 0;
        function loop(now) {
          if (!t0) {
            t0 = now;
            prev = now;
            requestAnimationFrame(loop);
            return;
          }
          ts.push(now - prev);
          prev = now;
          if (now - t0 >= dur) {
            ts.sort((a, b) => a - b);
            const at = (q) => ts[Math.min(ts.length - 1, Math.max(0, Math.ceil(q * ts.length) - 1))];
            const span = now - t0;
            res({
              frames: ts.length,
              avgFps: +((ts.length * 1000) / span).toFixed(1),
              p50: +at(0.5).toFixed(2),
              p95: +at(0.95).toFixed(2),
              p99: +at(0.99).toFixed(2),
              max: +ts[ts.length - 1].toFixed(2),
              heapPeakMB: performance.memory
                ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
                : null,
            });
            return;
          }
          requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
      }),
    ms
  );

const idle = await sample(SAMPLE_SEC * 1000);

// 制造负载：把玩家送到 AI 聚集处，让多个 AI 同时警觉追击，并持续开火
await page.evaluate(() => {
  const s = window.__m1.snapshot();
  const alive = s.ai.filter((a) => a.alive);
  if (!alive.length) return;
  // 取所有存活 AI 的重心附近，制造最多 AI 同时参战的情形
  const cx = alive.reduce((t, a) => t + a.x, 0) / alive.length;
  const cz = alive.reduce((t, a) => t + a.z, 0) / alive.length;
  window.__m1.teleport(cx + 8, cz + 8);
});
await sleep(600);
await page.mouse.down({ button: 'left' });
const keepAiming = setInterval(() => {
  page.evaluate(() => window.__m1.aimNearestAi()).catch(() => {});
}, 200);
const combat = await sample(SAMPLE_SEC * 1000);
clearInterval(keepAiming);
await page.mouse.up({ button: 'left' });

const after = await page.evaluate(() => window.__m1.snapshot());

console.log('\n================ M1 性能数据记录（仅记录，不判定）================');
console.log(`  渲染器        ${info.renderer}`);
console.log(`  视口          ${info.size[0]}x${info.size[1]}  DPR=${info.dpr}`);
console.log(`  计时器分辨率  ${info.timerResMs} ms`);
console.log('');
console.log(`  ${'场景'.padEnd(14)} ${'avgFps'.padStart(8)} ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)} ${'max'.padStart(7)}`);
console.log(`  ${'局内待机'.padEnd(14)} ${String(idle.avgFps).padStart(8)} ${String(idle.p50).padStart(7)} ${String(idle.p95).padStart(7)} ${String(idle.p99).padStart(7)} ${String(idle.max).padStart(7)}`);
console.log(`  ${'交战中'.padEnd(14)} ${String(combat.avgFps).padStart(8)} ${String(combat.p50).padStart(7)} ${String(combat.p95).padStart(7)} ${String(combat.p99).padStart(7)} ${String(combat.max).padStart(7)}`);
console.log('');
console.log(`  局内待机 堆峰值 ${idle.heapPeakMB} MB | 交战 堆峰值 ${combat.heapPeakMB} MB`);
console.log(`  结束状态 flow=${after.flow} reason=${after.endReason} kills=${after.kills}`);
console.log('');
console.log('  说明：M1 不设性能门禁。以上数字仅供 M2 起做趋势对比，不作为达标依据。');

await browser.close();

fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(
  path.join(ROOT, 'results', `m1-perf-${stamp}.json`),
  JSON.stringify({ info, idle, combat, after: { flow: after.flow, endReason: after.endReason, kills: after.kills } }, null, 2),
  'utf8'
);
console.log(`\n  明细已写入 results/m1-perf-${stamp}.json`);
