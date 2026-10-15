// 聚焦诊断：新地图下 AI 为什么不进入交战状态 / 没有路点 / 没有更新分级
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
await sleep(1500);

const dump = async (label) => {
  const d = await page.evaluate(() => {
    const s = window.__m2.snapshot();
    return {
      ai: s.ai,
      player: { x: s.player.x, z: s.player.z, cellBlocked: s.player.cellBlocked },
      mapId: s.mapId ?? null,
    };
  });
  console.log(`\n  === ${label} ===`);
  console.log(
    `  玩家 (${Number(d.player.x).toFixed(1)}, ${Number(d.player.z).toFixed(1)})  ` +
      `卡墙里=${d.player.cellBlocked}  地图 ${d.mapId}`
  );
  for (const a of d.ai) {
    console.log(
      `    AI#${a.id} ${String(a.tier).padEnd(6)} ${String(a.state).padEnd(8)} ` +
        `位置(${a.x.toFixed(1)},${a.z.toFixed(1)}) 路点 ${a.pathLen} 更新 ${a.updates} 分级 ${a.updateIntervalMs}`
    );
  }
  return d;
};

await dump('开局');

// 1) 把玩家传送到 AI#0 附近并开枪，看它是否进入交战
const near = await page.evaluate(() => window.__m2.teleportNearAi(0, 6));
console.log(`\n  teleportNearAi -> ${JSON.stringify(near)}`);
await page.mouse.down({ button: 'left' });
await sleep(400);
await page.mouse.up({ button: 'left' });
await sleep(3500);
await dump('传送到 AI#0 附近并开枪后');

// 2) 直接检查配置是否真的传到了 AI 里
const cfgProbe = await page.evaluate(() => {
  const s = window.__m2.snapshot();
  return {
    hasAiUpdateTiers: typeof window.__m2.debugAiUpdateTiers === 'function'
      ? window.__m2.debugAiUpdateTiers()
      : 'no-probe',
    scheduler: s.scheduler,
  };
});
console.log(`\n  cfg 探针: ${JSON.stringify(cfgProbe)}`);

await browser.close();
