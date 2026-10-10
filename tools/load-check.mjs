// 快速加载自检：确认页面能起来、无异常、关键系统已初始化
// 用途：M2 改动量大，先跑这个再跑完整冒烟，避免在"根本没启动"的情况下等长测试
// 用法：node tools/load-check.mjs [url] [--headed]   默认无头，不占用你的鼠标与焦点
import { launchBrowser, describeMode } from './lib/browser.mjs';

const URL_BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5180/';

const browser = await launchBrowser({ protocolTimeout: 120000 });
const page = await browser.newPage();
console.log(`  运行模式: ${describeMode()}`);
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console.error: ' + m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) errs.push(`${r.status()} ${r.url()}`);
});

try {
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
  const s = await page.evaluate(() => window.__m2.snapshot());
  console.log('\n================ M2 加载自检 ================');
  console.log(`  flow            ${s.flow}`);
  console.log(`  关卡            ${s.level.W}x${s.level.W} 格 / cell=${s.level.cell} / 可通行 ${s.level.free} / 墙 ${s.level.walls}`);
  console.log(`  AI              ${s.ai.length} 个，分级 ${[...new Set(s.ai.map((a) => a.tier))].join(',')}`);
  console.log(`  武器槽          ${s.weapon.slots.join(' / ')}（当前 ${s.weapon.label}）`);
  console.log(`  玩家护甲        胸 ${s.player.armor.body.id}(${s.player.armor.body.durability}) · 头 ${s.player.armor.head.id}(${s.player.armor.head.durability})`);
  console.log(`  消耗品          ${JSON.stringify(s.consumables)}`);
  console.log(`  音频            unlocked=${s.audio.unlocked}`);
  console.log(`  寻路调度器      pending=${s.scheduler.pending}`);
  console.log('');
  console.log(`  页面错误        ${errs.length ? errs.slice(0, 6).join(' | ') : '无'}`);
  const ok = errs.length === 0 && s.ai.length > 0 && s.weapon.slots.length >= 2 && s.loot.total > 0;
  console.log(`\n  ${ok ? '[PASS] 加载正常' : '[FAIL] 加载存在问题'}`);
  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log('自检失败:', e.message);
  for (const x of errs.slice(0, 10)) console.log('  - ' + x);
  await browser.close();
  process.exit(1);
}
