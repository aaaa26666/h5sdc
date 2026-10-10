// 诊断：视角瞬移到底是哪一路引起的
//
// 三个可疑来源，分别单独测量：
//   ① 探头（lean）被墙面**瞬间裁剪** —— 相机单帧横向跳最多 0.55m
//   ② 鼠标单次事件的增量异常大（指针锁定刚取得时的"光标归位"等）
//   ③ 后坐力/恢复造成的变化（正常量级很小，作为对照）
//
// 用法：node tools/diag-view-jump.mjs [url] [--headed]
import { launchBrowser, describeMode } from './lib/browser.mjs';

const URL_BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEG = 180 / Math.PI;

const browser = await launchBrowser();
const page = await browser.newPage();
console.log(`\n================ 视角瞬移诊断 ================`);
console.log(`  运行模式: ${describeMode()}\n`);

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
  await sleep(1200);

  const snap = () => page.evaluate(() => window.__m2.snapshot());
  const reset = () => page.evaluate(() => window.__m2.resetViewProbe());
  const call = (fn, ...a) => page.evaluate((f, args) => window.__m2[f](...args), fn, a);

  // ---------------------------------------------------------------
  // ① 探头被墙面裁剪
  // ---------------------------------------------------------------
  console.log('① 探头贴墙收回（站起来 → 探头 → 朝墙平移）');
  await reset();
  const wall = await call('placeNextToWall');
  if (!wall) {
    console.log('   未找到贴墙位置，跳过');
  } else {
    console.log(`   起始格 ${wall.cell}，墙面 x=${wall.wallFaceX}，玩家 x=${wall.playerX.toFixed(3)}`);
    // 先探头（E = 右探头；placeNextToWall 让右向量指向墙）
    await page.keyboard.down('KeyE');
    await sleep(900);
    const leaned = await snap();
    console.log(`   探头量 leanCurrent = ${leaned.player.leanCurrent}  侧移 = ${leaned.player.leanLateral} m`);
    // 朝墙平移，逼出墙面裁剪
    const before = await snap();
    await page.keyboard.down('KeyD');
    let maxLeanSeen = leaned.player.leanCurrent;
    for (let i = 0; i < 30; i++) {
      const s = await snap();
      maxLeanSeen = Math.max(maxLeanSeen, s.player.leanCurrent);
      await sleep(50);
    }
    await page.keyboard.up('KeyD');
    await page.keyboard.up('KeyE');
    await sleep(200);
    const after = await snap();
    const probe = await page.evaluate(() => window.__m2.snapshot().player.viewProbe);
    console.log(`   平移后 leanCurrent = ${after.player.leanCurrent}`);
    console.log(`   单帧最大探头变化 = ${probe.maxLeanJump.toFixed(4)}（归一化单位）`);
    console.log(`   折算相机横向位移 = ${(probe.maxLeanJump * 0.55).toFixed(4)} m`);
    console.log(`   单帧最大视角变化 = 偏航 ${(probe.maxYawJumpRad * DEG).toFixed(3)}°  俯仰 ${(probe.maxPitchJumpRad * DEG).toFixed(3)}°`);
    console.log(`   非鼠标来源的视角跳变 = ${(probe.maxNonMouseJumpRad * DEG).toFixed(3)}°`);
  }

  // ---------------------------------------------------------------
  // ② 鼠标异常增量
  // ---------------------------------------------------------------
  console.log('\n② 注入异常大的单次鼠标移动（模拟光标归位事件）');
  await reset();
  const s0 = await snap();
  for (const d of [50, 200, 800, 3000]) {
    await reset();
    const a = await snap();
    await page.evaluate((dd) => window.__m2.injectMouseMove(dd, 0), d);
    await sleep(120);
    const b = await snap();
    const dyaw = Math.abs(b.player.yaw - a.player.yaw) * DEG;
    const p = b.player.viewProbe;
    console.log(
      `   注入 movementX=${String(d).padStart(5)}  →  实际偏航变化 ${dyaw.toFixed(3)}°` +
        `   （探针记录非鼠标跳变 ${(p.maxNonMouseJumpRad * DEG).toFixed(3)}°，被丢弃的异常事件数 ${b.player.inputProbe.spikeEvents}）`
    );
  }

  // ---------------------------------------------------------------
  // ③ 对照：后坐力
  // ---------------------------------------------------------------
  console.log('\n③ 对照：连发后坐力造成的单帧变化（应当很小）');
  await reset();
  await call('teleportToSafeSpot');
  await sleep(200);
  await page.mouse.down({ button: 'left' });
  await sleep(1200);
  await page.mouse.up({ button: 'left' });
  await sleep(200);
  const recoilProbe = await page.evaluate(() => window.__m2.snapshot().player.viewProbe);
  console.log(
    `   单帧最大俯仰变化 = ${(recoilProbe.maxPitchJumpRad * DEG).toFixed(3)}°  ` +
      `单帧最大偏航变化 = ${(recoilProbe.maxYawJumpRad * DEG).toFixed(3)}°`
  );

  console.log(`\n  页面错误: ${errors.length ? errors.slice(0, 3).join(' | ') : '无'}`);
} catch (e) {
  console.log('  诊断失败: ' + e.message);
} finally {
  await browser.close();
}
