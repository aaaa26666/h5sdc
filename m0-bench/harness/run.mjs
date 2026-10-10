// M0-2/M0-3 基准测试驱动。
// 职责：起静态服务 -> 起 Chrome（可控 GPU/垂直同步）-> 按矩阵跑场景 -> 汇总输出。
// 所有数据均为实测，任何一项未跑成功都不得写入报告。
// 用完即弃，不属于游戏产物。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';
import { startServer } from '../server.mjs';
import { judgeBudgets } from '../scenes/bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(ROOT, 'results');

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {
    engines: ['three', 'babylon'],
    mats: ['pbr'],
    syncs: ['off'],
    agents: [''],
    pfs: [''],
    throttles: [1],
    vsync: ['on'],
    gpu: ['default'],
    warmupMs: 3000,
    durationMs: 20000,
    repeats: 3,
    headless: false,
    tag: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--engines') (out.engines = v.split(',')), i++;
    else if (a === '--mat') (out.mats = v.split(',')), i++;
    else if (a === '--sync') (out.syncs = v.split(',')), i++;
    else if (a === '--agents') (out.agents = v.split(',')), i++;
    else if (a === '--pf') (out.pfs = v.split(',')), i++;
    else if (a === '--throttle') (out.throttles = v.split(',').map(Number)), i++;
    else if (a === '--vsync') (out.vsync = v.split(',')), i++;
    else if (a === '--gpu') (out.gpu = v.split(',')), i++;
    else if (a === '--warmup') (out.warmupMs = Number(v) * 1000), i++;
    else if (a === '--duration') (out.durationMs = Number(v) * 1000), i++;
    else if (a === '--repeats') (out.repeats = Number(v)), i++;
    else if (a === '--tag') (out.tag = v), i++;
    else if (a === '--headless') out.headless = true;
    else if (a === '--help') {
      console.log(`
用法: node harness/run.mjs [选项]
  --engines three,babylon   被测引擎（默认两者）
  --mat pbr,cheap            材质模型对照：pbr=标准PBR; cheap=两端同时降级为非PBR
  --sync off,on              on=每帧 gl.finish() 等待 GPU（测真实 GPU 耗时）; off=仅测 CPU 提交
  --agents 50,100,150        仅 AI 压测场景有效：扫描同屏 Agent 数量
  --pf astar,flow            仅 AI 压测场景有效：寻路方案对照
  --gpu default,swiftshader  GPU 模式（default=独显, swiftshader=软件渲染模拟低端）
  --throttle 1,4,6           CDP CPU 节流倍数
  --vsync on,off             on=正常垂直同步（测能否稳 60）; off=关闭锁帧（测吞吐上限）
  --warmup 3                 预热秒数
  --duration 20              采样秒数
  --repeats 3                每组合重复次数
  --headless                 无头模式（默认有头，有头数据更接近真实体验）
  --tag 名称                 输出文件后缀
`);
      process.exit(0);
    }
  }
  return out;
}

// ---------- Chrome 定位 ----------
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge 可执行文件，请设置环境变量 CHROME_PATH');
}

// ---------- 启动参数 ----------
const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
  '--enable-precise-memory-info', // 让 performance.memory 返回精确值
  '--force_high_performance_gpu', // 排除 MuMu 虚拟显示适配器
  '--window-size=1920,1080',
  '--window-position=0,0',
  '--hide-scrollbars',
  '--mute-audio',
];

function buildArgs(gpuMode, vsyncMode) {
  const args = [...BASE_ARGS];
  if (gpuMode === 'swiftshader') {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-compositing');
  }
  if (vsyncMode === 'off') {
    args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  }
  return args;
}

// ---------- 统计 ----------
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(3);
};
const pick = (rows, f) => rows.map(f).filter((v) => typeof v === 'number' && !Number.isNaN(v));

// ---------- 主流程 ----------
const opts = parseArgs(process.argv.slice(2));
const chromePath = findChrome();
const { server, port } = await startServer(0);
fs.mkdirSync(RESULTS, { recursive: true });

const runId = opts.tag || new Date().toISOString().replace(/[:.]/g, '-');
console.log(`[m0-bench] Chrome : ${chromePath}`);
console.log(`[m0-bench] 服务   : http://127.0.0.1:${port}/`);
console.log(
  `[m0-bench] 矩阵   : engines=${opts.engines} mat=${opts.mats} gpu=${opts.gpu} throttle=${opts.throttles} vsync=${opts.vsync} repeats=${opts.repeats}`
);
console.log(`[m0-bench] 采样   : 预热 ${opts.warmupMs / 1000}s + 采样 ${opts.durationMs / 1000}s`);

const rows = [];
const infoByEngine = {};
let browser = null;
let currentLaunchKey = null;
const rafCapByLaunch = {}; // 每个启动配置下的帧率天花板，仅在 vsync=on 时有效

async function ensureBrowser(gpuMode, vsyncMode) {
  const key = `${gpuMode}|${vsyncMode}`;
  if (currentLaunchKey === key) return;
  if (browser) await browser.close();
  browser = await launch({
    executablePath: chromePath,
    headless: opts.headless,
    defaultViewport: null,
    args: buildArgs(gpuMode, vsyncMode),
    protocolTimeout: 300000,
  });
  currentLaunchKey = key;
}

try {
  for (const gpuMode of opts.gpu) {
    for (const vsyncMode of opts.vsync) {
      await ensureBrowser(gpuMode, vsyncMode);

      for (const engineName of opts.engines) {
        for (const matMode of opts.mats) {
        for (const syncMode of opts.syncs) {
        for (const agentCount of opts.agents) {
        for (const pfMode of opts.pfs) {
        const url =
          `http://127.0.0.1:${port}/scenes/${engineName}/index.html?mat=${matMode}&sync=${syncMode === 'on' ? 1 : 0}` +
          (agentCount ? `&n=${agentCount}` : '') +
          (pfMode ? `&pf=${pfMode}` : '');

        for (const throttle of opts.throttles) {
          for (let rep = 1; rep <= opts.repeats; rep++) {
            const page = await browser.newPage();
            const label = `${engineName} n=${agentCount || '-'} pf=${pfMode || '-'} mat=${matMode} sync=${syncMode} gpu=${gpuMode} vsync=${vsyncMode} throttle=${throttle}x rep=${rep}`;
            // 采集页面侧错误：没有这层捕获时，页面加载失败只会表现为超时，无法定位原因
            const pageIssues = [];
            page.on('pageerror', (e) => pageIssues.push(`pageerror: ${e.message}`));
            page.on('console', (m) => {
              if (m.type() === 'error' || m.type() === 'warning') pageIssues.push(`console.${m.type()}: ${m.text()}`);
            });
            page.on('requestfailed', (r) => pageIssues.push(`requestfailed: ${r.url()} (${r.failure()?.errorText})`));
            page.on('response', (r) => {
              if (r.status() >= 400) pageIssues.push(`http ${r.status()}: ${r.url()}`);
            });
            try {
              await page.goto(url, { waitUntil: 'load', timeout: 60000 });
              await page.waitForFunction('window.__benchReady === true', { timeout: 120000 });

              const info = await page.evaluate(() => window.__benchInfo);
              if (!infoByEngine[engineName]) infoByEngine[engineName] = info;

              // 校准帧率天花板：仅在 vsync=on 时有意义（off 模式下天花板已被解除）
              const measuredCap = await page.evaluate(() => window.__benchCalibrate());
              if (rep === 1 && throttle === 1 && vsyncMode === 'on') {
                rafCapByLaunch[`${gpuMode}|${vsyncMode}`] = measuredCap;
              }

              // 批量微基准（若该场景提供）：得到与计时器分辨率无关的单次操作成本
              let micro = null;
              if (await page.evaluate(() => typeof window.__benchMicro === 'function')) {
                micro = await page.evaluate(() => window.__benchMicro());
              }

              let cdp = null;
              if (throttle > 1) {
                cdp = await page.createCDPSession();
                await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
              }

              const m = await page.evaluate(
                (cfg) => window.__benchRun(cfg),
                { warmupMs: opts.warmupMs, durationMs: opts.durationMs }
              );

              if (cdp) await cdp.detach();

              rows.push({
                engine: engineName,
                engineVersion: info.engineVersion,
                mat: matMode,
                sync: syncMode,
                agents: agentCount ? Number(agentCount) : null,
                pfMode: pfMode || null,
                gpu: gpuMode,
                vsync: vsyncMode,
                throttle,
                repeat: rep,
                avgFps: m.avgFps,
                low1Fps: m.low1Fps,
                frameP50: m.frameMs.p50,
                frameP95: m.frameMs.p95,
                frameP99: m.frameMs.p99,
                cpuP50: m.cpuMs.p50,
                cpuP95: m.cpuMs.p95,
                frames: m.frames,
                heapPeakMB: m.heap.unsupported ? null : m.heap.peakMB,
                heapEndMB: m.heap.unsupported ? null : m.heap.endMB,
                engineInitMs: info.engineInitMs,
                sceneBuildMs: info.sceneBuildMs,
                firstFrameFromNavMs: rep === 1 ? info.firstFrameFromNavMs : null,
                renderer: info.gl && info.gl.renderer ? info.gl.renderer : 'unknown',
                pfP95: m.phases && m.phases.pf ? m.phases.pf.p95 : null,
                losP95: m.phases && m.phases.los ? m.phases.los.p95 : null,
                moveP95: m.phases && m.phases.move ? m.phases.move.p95 : null,
                renderP95: m.phases && m.phases.render ? m.phases.render.p95 : null,
                pfMax: m.phases && m.phases.pf ? m.phases.pf.max : null,
                losMax: m.phases && m.phases.los ? m.phases.los.max : null,
                timerResMs: micro ? micro.timerResolutionMs : null,
                astarPerQueryMs: micro ? micro.astar.perQueryMs : null,
                astarAvgPathCells: micro ? micro.astar.avgPathCells : null,
                flowPerComputeMs: micro ? micro.flow.perComputeMs : null,
                losPerRayMs: micro ? micro.los.perRayMs : null,
              });
              const ph = m.phases
                ? `  [pf p95/max ${m.phases.pf?.p95 ?? '-'}/${m.phases.pf?.max ?? '-'} | los ${m.phases.los?.p95 ?? '-'}/${m.phases.los?.max ?? '-'} | move ${m.phases.move?.p95 ?? '-'} | render ${m.phases.render?.p95 ?? '-'} ms]`
                : '';
              if (micro) {
                console.log(
                  `      微基准: 计时器分辨率=${micro.timerResolutionMs}ms | A* ${micro.astar.perQueryMs}ms/次(路径${micro.astar.avgPathCells}格) | 流场 ${micro.flow.perComputeMs}ms/次 | 视线 ${micro.los.perRayMs}ms/次`
                );
              }
              console.log(`  ok  ${label}  avgFps=${m.avgFps}  low1%=${m.low1Fps}  cpuP95=${m.cpuMs.p95}ms${ph}`);
              if (pageIssues.length) console.log(`      [页面告警] ${pageIssues.slice(0, 4).join(' | ')}`);
            } catch (e) {
              console.log(`  FAIL ${label}  -> ${e.message}`);
              if (pageIssues.length) {
                console.log(`      [页面错误]`);
                for (const s of [...new Set(pageIssues)].slice(0, 10)) console.log(`        - ${s}`);
              }
              rows.push({ engine: engineName, mat: matMode, sync: syncMode, agents: agentCount ? Number(agentCount) : null, pfMode: pfMode || null, gpu: gpuMode, vsync: vsyncMode, throttle, repeat: rep, error: e.message });
            } finally {
              await page.close();
            }
          }
        }
        }
        }
        }
        }
      }
    }
  }
} finally {
  if (browser) await browser.close();
  server.close();
}

// ---------- 汇总 ----------
const groups = new Map();
for (const r of rows) {
  if (r.error) continue;
  const k = `${r.engine}|${r.mat}|${r.sync}|${r.agents}|${r.pfMode}|${r.gpu}|${r.vsync}|${r.throttle}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const summary = [];
for (const [k, rs] of groups) {
  const [engine, mat, sync, agents, pfMode, gpu, vsync, throttle] = k.split('|');
  const first = rs[0];
  const avgFps = median(pick(rs, (r) => r.avgFps));
  const frameP95 = median(pick(rs, (r) => r.frameP95));
  const budget = judgeBudgets(frameP95) || {};
  const cap = vsync === 'on' ? rafCapByLaunch[`${gpu}|${vsync}`] ?? null : null;
  summary.push({
    engine,
    engineVersion: first.engineVersion,
    mat,
    sync,
    agents: agents === 'null' ? null : Number(agents),
    pfMode: pfMode === 'null' ? null : pfMode,
    gpu,
    vsync,
    throttle: Number(throttle),
    samples: rs.length,
    avgFps,
    low1Fps: median(pick(rs, (r) => r.low1Fps)),
    frameP50: median(pick(rs, (r) => r.frameP50)),
    frameP95,
    frameP99: median(pick(rs, (r) => r.frameP99)),
    cpuP50: median(pick(rs, (r) => r.cpuP50)),
    cpuP95: median(pick(rs, (r) => r.cpuP95)),
    heapPeakMB: median(pick(rs, (r) => r.heapPeakMB)),
    pfP95: median(pick(rs, (r) => r.pfP95)),
    losP95: median(pick(rs, (r) => r.losP95)),
    moveP95: median(pick(rs, (r) => r.moveP95)),
    renderP95: median(pick(rs, (r) => r.renderP95)),
    pfMax: median(pick(rs, (r) => r.pfMax)),
    losMax: median(pick(rs, (r) => r.losMax)),
    timerResMs: first.timerResMs,
    astarPerQueryMs: median(pick(rs, (r) => r.astarPerQueryMs)),
    flowPerComputeMs: median(pick(rs, (r) => r.flowPerComputeMs)),
    losPerRayMs: median(pick(rs, (r) => r.losPerRayMs)),
    engineInitMs: first.engineInitMs,
    sceneBuildMs: first.sceneBuildMs,
    firstFrameFromNavMs: first.firstFrameFromNavMs,
    renderer: first.renderer,
    rafCapFps: cap,
    // capped=true 表示本次结果只是被刷新率锁住，FPS 不可用于比较引擎吞吐，必须看帧时间
    capped: cap ? avgFps >= cap * 0.97 : false,
    headroomVs60: budget.headroomVs60,
    meets60: budget.meets60,
    meets45: budget.meets45,
    meets30: budget.meets30,
  });
}
summary.sort(
  (a, b) =>
    a.engine.localeCompare(b.engine) ||
    a.mat.localeCompare(b.mat) ||
    a.sync.localeCompare(b.sync) ||
    String(a.agents).localeCompare(String(b.agents)) ||
    String(a.pfMode).localeCompare(String(b.pfMode)) ||
    a.gpu.localeCompare(b.gpu) ||
    a.vsync.localeCompare(b.vsync) ||
    a.throttle - b.throttle
);

// ---------- 落盘 ----------
const rawPath = path.join(RESULTS, `raw-${runId}.json`);
const sumPath = path.join(RESULTS, `summary-${runId}.csv`);
const csvPath = path.join(RESULTS, `raw-${runId}.csv`);

fs.writeFileSync(
  rawPath,
  JSON.stringify({ runId, chromePath, args: opts, engineInfo: infoByEngine, rows, summary }, null, 2),
  'utf8'
);

function toCsv(objs, cols) {
  const head = cols.join(',');
  const body = objs
    .map((o) => cols.map((c) => (o[c] === null || o[c] === undefined ? '' : String(o[c]).replace(/,/g, ';'))).join(','))
    .join('\n');
  return head + '\n' + body + '\n';
}

const sumCols = [
  'engine','engineVersion','mat','sync','agents','pfMode','gpu','vsync','throttle','samples','avgFps','low1Fps',
  'frameP50','frameP95','frameP99','cpuP50','cpuP95','heapPeakMB',
  'pfP95','losP95','moveP95','renderP95','pfMax','losMax',
  'timerResMs','astarPerQueryMs','flowPerComputeMs','losPerRayMs',
  'engineInitMs','sceneBuildMs','firstFrameFromNavMs','renderer',
  'rafCapFps','capped','headroomVs60','meets60','meets45','meets30',
];
fs.writeFileSync(sumPath, toCsv(summary, sumCols), 'utf8');
fs.writeFileSync(
  csvPath,
  toCsv(rows, ['engine','mat','sync','agents','pfMode','gpu','vsync','throttle','repeat','avgFps','low1Fps','frameP50','frameP95','frameP99','cpuP50','cpuP95','frames','heapPeakMB','heapEndMB','pfP95','losP95','moveP95','renderP95','timerResMs','astarPerQueryMs','flowPerComputeMs','losPerRayMs','error']),
  'utf8'
);

console.log('\n===== 汇总（各组取重复次数的中位数）=====');
console.table(summary);

console.log('\n===== 帧预算判定（判据为 frameP95 帧时间，而非 FPS）=====');
const caps = Object.entries(rafCapByLaunch).map(([k, v]) => `${k}=${v}fps`).join('  ');
console.log(`本机 rAF 天花板（仅 vsync=on 下测得）: ${caps || '未测'}`);
if (summary.some((s) => s.capped)) {
  console.log('!! 存在 capped=YES 的行：该组只是被刷新率锁住，FPS 不能用于比较引擎吞吐。');
  console.log('!! 这类组请以 frameP95 与预算对比判定，或用 --sync on 测真实 GPU 耗时。');
}
console.table(
  summary.map((s) => ({
    engine: s.engine,
    n: s.agents,
    pf: s.pfMode,
    mat: s.mat,
    sync: s.sync,
    gpu: s.gpu,
    vsync: s.vsync,
    throttle: s.throttle,
    capped: s.capped ? 'YES' : 'no',
    avgFps: s.avgFps,
    frameP95ms: s.frameP95,
    cpuP95ms: s.cpuP95,
    pfP95: s.pfP95,
    losP95: s.losP95,
    moveP95: s.moveP95,
    renderP95: s.renderP95,
    '60fps余量': s.headroomVs60,
    meets60: s.meets60 ? 'PASS' : 'FAIL',
    meets45: s.meets45 ? 'PASS' : 'FAIL',
    meets30: s.meets30 ? 'PASS' : 'FAIL',
  }))
);

console.log(`原始数据: ${rawPath}`);
console.log(`汇总数据: ${sumPath}`);
console.log(`逐次数据: ${csvPath}`);
console.log('\n各引擎实际使用的 WebGL 渲染器：');
for (const [k, v] of Object.entries(infoByEngine)) {
  console.log(`  ${k}: ${v.gl && v.gl.renderer ? v.gl.renderer : 'unknown'}`);
}
