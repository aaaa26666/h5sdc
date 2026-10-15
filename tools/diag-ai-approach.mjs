// 诊断：AI 发现玩家后是否在靠近（还是漫无目的乱跑）
import { suppressPointerLock, launchBrowser } from './lib/browser.mjs';

const URL_BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchBrowser();
const page = await browser.newPage();
await suppressPointerLock(page); // 不抢用户鼠标（原理见 lib/browser.mjs）
await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
await page.click('#btnStart');
await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
await sleep(1200);

const shot = await page.evaluate(() => window.__m2.teleportNearAi(0, 12));
console.log(`\n  传送到 AI#0 附近: ${JSON.stringify(shot)}`);
// 开枪惊动
await page.mouse.down({ button: 'left' });
await sleep(300);
await page.mouse.up({ button: 'left' });

const cell = 2.5;
console.log('\n  t(ms)  AI# 状态     距玩家  pathLen pathIdx 目标格    (AI格 → 目标格是否朝向玩家)');
const t0 = Date.now();
const trace = [];
for (let i = 0; i < 26; i++) {
  const s = await page.evaluate(() => {
    const sn = window.__m2.snapshot();
    return { player: { x: sn.player.x, z: sn.player.z }, ai: sn.ai, flow: sn.flow };
  });
  if (s.flow !== 'raid') {
    console.log(`  ${String(Date.now() - t0).padStart(5)}  流程结束 flow=${s.flow}`);
    break;
  }
  // 找出距玩家最近且存活的 AI
  let best = null;
  for (const a of s.ai) {
    if (!a.alive) continue;
    const d = Math.hypot(a.x - s.player.x, a.z - s.player.z);
    if (!best || d < best.d) best = { a, d };
  }
  if (best) {
    const a = best.a;
    const gx = a.goal != null ? a.goal % 40 : null;
    const gz = a.goal != null ? Math.floor(a.goal / 40) : null;
    // 朝向玩家的判断：目标格是否比 AI 当前格更靠近玩家
    let toward = '-';
    if (gx != null) {
      const aiCx = Math.floor(a.x / cell);
      const aiCz = Math.floor(a.z / cell);
      const pCx = Math.floor(s.player.x / cell);
      const pCz = Math.floor(s.player.z / cell);
      const dGoal = Math.hypot(gx - pCx, gz - pCz);
      const dNow = Math.hypot(aiCx - pCx, aiCz - pCz);
      toward = dGoal < dNow - 1 ? '是' : dGoal > dNow + 1 ? '否(更远)' : '≈原地';
    }
    trace.push({ t: Date.now() - t0, d: best.d, state: a.state });
    console.log(
      `  ${String(Date.now() - t0).padStart(5)}  ${String(a.id).padEnd(4)} ${String(a.state).padEnd(8)} ` +
        `${best.d.toFixed(1).padStart(5)}m ${String(a.pathLen).padStart(6)} ${String(a.pathIdx).padStart(6)} ` +
        `${gx != null ? `(${gx},${gz})`.padEnd(9) : '—'.padEnd(9)} ${toward}`
    );
  }
  await sleep(300);
}

// 统计：进入交战状态后距离是否在下降
const combat = trace.filter((x) => x.state === 'combat' || x.state === 'search');
if (combat.length >= 3) {
  const first = combat[0].d;
  const last = combat[combat.length - 1].d;
  const min = Math.min(...combat.map((x) => x.d));
  console.log(`\n  交战/搜索状态共 ${combat.length} 个采样：首 ${first.toFixed(1)}m → 末 ${last.toFixed(1)}m，最近 ${min.toFixed(1)}m`);
  console.log(`  距离是否在下降：${last < first - 1 || min < first - 3 ? '是（有靠近）' : '否（没有有效靠近）'}`);
} else {
  console.log(`\n  交战/搜索状态采样不足（${combat.length} 个），AI 可能压根没进入交战`);
}
await browser.close();
