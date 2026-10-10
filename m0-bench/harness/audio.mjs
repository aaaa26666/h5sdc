// M0-7 音频自动播放限制验证驱动。
// 对两种自动播放策略各跑一遍，对比"浏览器允许"与"浏览器拦截"两种世界。
// 用完即弃，不属于游戏产物。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';
import { startServer } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(ROOT, 'results');

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome，请设置 CHROME_PATH');
}

// 两档策略：默认（要求用户手势） vs 放宽（模拟用户已授权/企业策略放开）
const POLICIES = [
  { name: 'default', args: [], label: '默认策略：要求用户手势' },
  { name: 'no-gesture-required', args: ['--autoplay-policy=no-user-gesture-required'], label: '放宽策略：无需手势' },
];

// 兼容矩阵要求覆盖的浏览器；装了的都跑
function findBrowsers() {
  const cands = [
    { name: 'chrome', path: process.env.CHROME_PATH || 'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'chrome-pf', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
    { name: 'edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { name: 'edge-pf', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  ];
  const found = [];
  const seen = new Set();
  for (const c of cands) {
    if (!fs.existsSync(c.path)) continue;
    if (seen.has(c.name.replace('-pf', ''))) continue;
    seen.add(c.name.replace('-pf', ''));
    found.push({ name: c.name.replace('-pf', ''), path: c.path });
  }
  return found;
}

const browsers = findBrowsers();
if (!browsers.length) throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH');

const { server, port } = await startServer(0);
fs.mkdirSync(RESULTS, { recursive: true });

const all = {};

for (const br of browsers) {
for (const pol of POLICIES) {
  const key = `${br.name}/${pol.name}`;
  console.log(`\n=============== ${br.name} · 策略 ${pol.name} —— ${pol.label} ===============`);
  const browser = await launch({
    executablePath: br.path,
    headless: false,
    defaultViewport: null,
    // 注意：不传 --mute-audio，避免静音相关的自动播放豁免干扰结论
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', ...pol.args],
    protocolTimeout: 120000,
  });

  const page = await browser.newPage();
  const issues = [];
  page.on('pageerror', (e) => issues.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') issues.push('console.error: ' + m.text());
  });

  try {
    await page.goto(`http://127.0.0.1:${port}/scenes/audio/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__audioProbe && window.__audioProbe.ready === true', { timeout: 30000 });

    // 等过 800ms 判定窗口，让"是否 settle"有结论
    await new Promise((r) => setTimeout(r, 1500));
    const before = await page.evaluate(() => window.__audioProbe.beforeGesture);

    // 用 CDP 派发真实输入事件（trusted event），才会被计为用户激活
    await page.mouse.click(400, 400);
    await page.waitForFunction('window.__audioProbeDone === true', { timeout: 30000 });

    const after = await page.evaluate(() => window.__audioProbe.afterGesture);
    const formats = await page.evaluate(() => window.__audioProbe.formatSupport);
    const errors = await page.evaluate(() => window.__audioProbe.errors);

    all[key] = { browser: br.name, policy: pol.name, label: pol.label, before, after, formats, errors, pageIssues: issues };

    console.log('\n-- 手势前 --');
    console.log(`  AudioContext.state            : ${before.contextState}`);
    console.log(`  AudioContext 创建耗时         : ${before.contextCreateMs} ms`);
    console.log(`  sampleRate / baseLatency      : ${before.sampleRate} Hz / ${before.baseLatency}`);
    console.log(`  outputLatency                 : ${before.outputLatency}`);
    console.log(`  userActivation                : ${JSON.stringify(before.userActivation)}`);
    console.log(`  resume() 结果                 : ${before.resumeSettled}`);
    console.log(`  <audio>.play() 结果           : ${before.audioElPlay}`);

    console.log('\n-- 手势后 --');
    console.log(`  手势类型                      : ${after.gestureType}`);
    console.log(`  手势时 userActivation.isActive: ${JSON.stringify(after.userActivationAtGesture)}`);
    console.log(`  resume() 耗时                 : ${after.resumeMs} ms`);
    console.log(`  AudioContext.state            : ${after.contextStateAfterResume}`);
    console.log(`  <audio>.play() 结果           : ${after.audioElPlayAfterResume}`);
    console.log(`  解锁总耗时                    : ${after.totalUnlockMs} ms`);
    if (after.decode) {
      console.log(`  解码 30s 立体声 WAV           : ${after.decode.decodeMs} ms（源 ${after.decode.sourceKB} KB）`);
    }

    console.log('\n-- 音频格式支持（canPlayType）--');
    for (const [k, v] of Object.entries(formats)) console.log(`  ${k.padEnd(28)} ${v}`);

    if (errors.length || issues.length) {
      console.log('\n-- 错误 --');
      for (const e of [...errors, ...issues]) console.log('  ' + e);
    }
  } catch (e) {
    console.log(`  失败: ${e.message}`);
    all[key] = { browser: br.name, policy: pol.name, label: pol.label, error: e.message, pageIssues: issues };
  } finally {
    await browser.close();
  }
}
}

server.close();

const outPath = path.join(RESULTS, `audio-probe-${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(all, null, 2), 'utf8');

console.log('\n================ 对照结论 ================');
for (const [k, v] of Object.entries(all)) {
  if (v.error) {
    console.log(`  ${k.padEnd(26)} 运行失败: ${v.error}`);
    continue;
  }
  console.log(
    `  ${k.padEnd(26)} 手势前 state=${v.before.contextState} resume=${v.before.resumeSettled} play=${v.before.audioElPlay} || 手势后 play=${v.after.audioElPlayAfterResume} 解锁=${v.after.totalUnlockMs}ms`
  );
}
console.log(`\n明细已写入 ${outPath}`);
