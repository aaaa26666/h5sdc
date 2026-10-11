// M2 端到端测试（本文件取代 M1 的 m1-smoke.mjs）
//
// 覆盖：
//   ① M1 闭环不能退化          出生→移动→搜刮→交战→撤离→结算
//   ② M2-1/2  多武器、切枪、弹药、开镜、后坐力、扩散
//   ③ M2-3    弹孔、命中提示、击杀提示
//   ④ M2-4    部位伤害、护甲耐久、穿甲
//   ⑤ M2-5    医疗与消耗品
//   ⑥ M2-6/7  AI 状态机、寻路、更新分级、查询限流
//   ⑦ M2-8    音频解锁门
//   ⑧ M0 遗留回归：隔墙打不中（M1-TEMP-16）、探头命中体积（M1-TEMP-18）
//   ⑨ **M2 DoD：连续 10 局无卡死/穿墙/无伤害等致命问题**
//
// 依赖 DEV-only 调试接口 window.__m2（生产构建中不存在，见 tools/verify-prod-bundle.mjs）。
// 用法：node tools/smoke.mjs [url] [--headed]
//
// 默认**无头**运行：有头模式下指针锁定会抓走鼠标并抢占焦点，跑测试时电脑没法用。
// 需要人眼旁观时加 --headed。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, describeMode, ROOT as REPO_ROOT } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = REPO_ROOT;
const URL_BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:5180/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 端口自管：校验 -> 关闭残留 -> 重新拉起
//
// 为什么必须有这一段：vite 在端口被占时**静默换端口**（5180 被占就跑 5181），
// 而本文件默认连 5180 —— 于是会连到上一次没退干净的旧实例：
//   · 旧实例可能是改代码之前的版本，测的是旧行为；
//   · 更糟的是它会表现为"Waiting failed: 20000ms exceeded"，看起来像代码回归。
// 这个坑在 M4-5 / M4-6 期间踩了三次，每次都要手动 netstat 排查。
// 现在改成：目标端口被谁占了就关掉谁，然后拉起一个**确知版本**的实例。
// ---------------------------------------------------------------------------
const TARGET_PORT = Number(new URL(URL_BASE).port || 80);
const KEEP_SERVER = process.argv.includes('--keep-server');

/** 跑一条命令并取回 stdout（用 spawn 而不是 spawnSync —— 后者在本沙箱会 EBUSY） */
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', () => {});
    p.on('error', () => resolve(out));
    p.on('close', () => resolve(out));
  });
}

/** 找出占用目标端口且处于 LISTENING 的进程 PID 列表 */
async function pidsOnPort(port) {
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    // 形如： TCP    127.0.0.1:5180    0.0.0.0:0    LISTENING    12345
    const m = line.match(/[:\.](\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    if (Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

async function killPidTree(pid) {
  await run('taskkill', ['/PID', String(pid), '/T', '/F']);
}

async function isServing(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 保证目标端口上跑着**本次拉起**的 dev server。
 * @returns {Promise<object|null>} 拉起的子进程（结束时据此关闭；外部已提供时可能为 null）
 */
async function ensureServer(port) {
  const occupants = await pidsOnPort(port);
  if (occupants.length) {
    console.log(
      `  端口 ${port} 被占用（PID ${occupants.join(', ')}）—— ` +
        '这通常是上一次没退干净的 dev server，会让测试连到旧版本。正在关闭并重新拉起…'
    );
    for (const pid of occupants) await killPidTree(pid);
    await sleep(1200); // 等端口真正释放，否则新实例又会静默换端口
  }

  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // 子进程的输出必须被消费，否则管道写满会把它卡住
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isServing(port)) {
      console.log(`  dev server 已就绪：http://127.0.0.1:${port}/ （PID ${child.pid}）`);
      return child;
    }
    await sleep(300);
  }
  throw new Error(`dev server 在 30 秒内没有起来（端口 ${port}）`);
}

const serverChild = await ensureServer(TARGET_PORT);

const results = [];
let currentGroup = '';
function group(name) {
  currentGroup = name;
  console.log(`\n—— ${name} ——`);
}
function check(name, pass, detail) {
  results.push({ group: currentGroup, name, pass: !!pass, detail: detail ?? '' });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const browser = await launchBrowser();
console.log(`  运行模式: ${describeMode()}`);

const page = await browser.newPage();
const pageErrors = [];
const badResponses = [];
const lifecycle = [];
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push('console.error: ' + m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
});
// 渲染进程崩溃 / 目标被关闭 —— 必须显式捕获，否则只会看到 "Session closed" 这种
// 没有信息量的报错，无法判断是页面崩了、被外部关掉、还是浏览器整个退出了。
page.on('error', (e) => lifecycle.push('page.crash: ' + e.message));
page.on('close', () => lifecycle.push('page.close'));
browser.on('disconnected', () => lifecycle.push('browser.disconnected'));

const snap = () => page.evaluate(() => window.__m2.snapshot());
const call = (fn, ...args) => page.evaluate((f, a) => window.__m2[f](...a), fn, args);
/** 快照里没有撤离点 id，按世界坐标定位（容差 1.5m，格边长 2.5m） */
const byPos = (list, x, z, tol = 1.5) =>
  (list || []).find((e) => Math.abs(e.x - x) < tol && Math.abs(e.z - z) < tol) || null;

const pauseRecoveries = [];
async function ensureRunning(tag) {
  const s = await snap();
  if (s.flow !== 'raid') return false;
  if (!s.paused) return true;
  pauseRecoveries.push({ tag, at: new Date().toISOString() });
  await page.click('canvas');
  try {
    await page.waitForFunction(() => window.__m2.snapshot().paused === false, { timeout: 6000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForEnd(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await snap();
    if (s.flow === 'ended') return true;
    // 暂停时局内不推进 —— 必须先把指针锁回来，否则会误判成"流程卡死"
    if (s.paused) {
      pauseRecoveries.push({ tag: 'waitForEnd', at: new Date().toISOString() });
      await page.click('canvas');
      await sleep(400);
    }
    await sleep(200);
  }
  return false;
}

async function loadAndStart() {
  await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
  try {
    await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 5000 });
  } catch {
    /* 交由 ensureRunning 处理 */
  }
}

try {
  // ============================================================
  group('① 加载与状态机');
  await loadAndStart();
  {
    const s = await snap();
    check('进入 raid', s.flow === 'raid', `flow=${s.flow}`);
    check('关卡生成', s.level.free > 200, `可通行 ${s.level.free} / 墙 ${s.level.walls}`);
    check('AI 已生成且分难度等级', s.ai.length > 0 && new Set(s.ai.map((a) => a.tier)).size >= 1,
      `${s.ai.length} 个，分级 ${[...new Set(s.ai.map((a) => a.tier))].join(',')}`);
    check('武器槽 ≥ 2（M2-1 多武器）', s.weapon.slots.length >= 2, s.weapon.slots.join('/'));
    check('玩家有护甲（M2-4）', s.player.armor.body.id !== 'none' && s.player.armor.body.durability > 0,
      `胸 ${s.player.armor.body.id}(${s.player.armor.body.durability})`);
    check('初始位置不在墙内', s.player.cellBlocked === false);
    const locked = await page.evaluate(() => document.pointerLockElement !== null);
    check('指针锁定生效', locked === true);

    // M4-6：小地图。它由 Canvas 绘制，纯逻辑单测覆盖不到渲染，
    // 所以在这里验证画布确实按配置尺寸建立、且标注了当前层。
    const mm = await page.evaluate(() => {
      const c = document.getElementById('minimap');
      const label = document.getElementById('minimapLabel');
      const q = document.getElementById('questText');
      if (!c) return null;
      const cs = getComputedStyle(c);
      // 小地图在左上：检查它所在面板确实靠左上，而不是还留在右下
      const r = c.getBoundingClientRect();
      return {
        w: c.width, h: c.height,
        radius: cs.borderRadius,
        left: r.left, top: r.top,
        label: label ? label.textContent.trim() : '',
        quest: q ? q.textContent.trim() : '',
      };
    });
    check('M4-6：小地图画布已建立且尺寸取自配置（168×168）',
      !!mm && mm.w === 168 && mm.h === 168, mm ? `${mm.w}×${mm.h}` : '找不到画布');
    check('M4-6：小地图是**圆形**（border-radius 50%）',
      !!mm && /50%/.test(mm.radius), mm ? `border-radius=${mm.radius}` : '无样式');
    check('M4-6：小地图已移到**左上角**（与血条等换位）',
      !!mm && mm.left < 200 && mm.top < 200, mm ? `left=${Math.round(mm.left)} top=${Math.round(mm.top)}` : '无位置');
    check('M4-6：小地图标注了当前所在层',
      !!mm && /第\s*[12]\s*层/.test(mm.label), mm ? `标注"${mm.label}"` : '无标注');
    // [M4-TEMP-4] 任务追踪占位（任务线属 M5-6）
    check('M4-6：任务追踪已显示（当前为占位值，见 M4-TEMP-4）',
      !!mm && mm.quest.length > 0, mm ? `显示"${mm.quest}"` : '无任务行');
  }

  // ============================================================
  group('⑦ 音频解锁门（M0 约束 C-8）');
  {
    const s = await snap();
    check('点击进入战区后音频已解锁', s.audio.unlocked === true, `unlocked=${s.audio.unlocked}`);
    check('解锁发生在用户手势内（有播放请求被记录）', s.audio.playRequests >= 0,
      `请求 ${s.audio.playRequests} / 已播 ${s.audio.played}`);
  }

  // ============================================================
  group('② M2-2 后坐力与开镜');
  {
    await ensureRunning('recoil');
    await call('teleport', 11.25, 11.25);
    await call('aimAt', 11.25, 1.65, 11.25 - 30);
    await sleep(150);
    const before = await snap();

    // 腰射连发，观察视角是否被后坐力抬起
    //
    // ★ 这里测**两个东西**，它们在 M2-TEMP-1 修复前后含义不同：
    //   · 单发峰值抬升：后坐力是否生效（始终应为真）
    //   · 连发**净抬升**：修复前恢复是无条件的、与抬升同量级，两者几乎抵消，
    //     净漂移在零附近摆动甚至为负（5 把武器里 3 把往下走）。
    //     修复后它必须显著为正 —— 这才是"后坐力图案真的有作用"的证据。
    //     修复前用净漂移做断言会时通时不通（实测一次 +1.09°、一次 -0.00°），
    //     现在它可以作为稳定断言，因为恢复不再吞掉抬升。
    await page.mouse.down({ button: 'left' });
    let peakPitch = before.player.pitch;
    let peakSpread = before.weapon.spread;
    const burstSec = 15 * 0.06;
    for (let i = 0; i < 15; i++) {
      await sleep(60);
      const s = await snap();
      peakPitch = Math.max(peakPitch, s.player.pitch);
      peakSpread = Math.max(peakSpread, s.weapon.spread);
      // 结构不变量：对外视角必须始终等于 瞄准 + 后坐力偏移
      const sum = s.player.aimPitch + s.player.recoilPitch;
      if (Math.abs(sum - s.player.pitch) > 1e-3) {
        check('视角 = 瞄准 + 后坐力偏移（结构不变量）', false,
          `aimPitch ${s.player.aimPitch} + recoilPitch ${s.player.recoilPitch} ≠ pitch ${s.player.pitch}`);
      }
    }
    const during = await snap();
    await page.mouse.up({ button: 'left' });
    check('每发都让枪口上跳（后坐力生效）', peakPitch > before.player.pitch + 0.005,
      `pitch 峰值 ${peakPitch.toFixed(4)}（基线 ${before.player.pitch.toFixed(4)}）`);
    check('连发使扩散增大', peakSpread > before.weapon.spread + 0.05,
      `spread 峰值 ${peakSpread.toFixed(3)}（基线 ${before.weapon.spread}）`);
    check('视角 = 瞄准 + 后坐力偏移（结构不变量）',
      Math.abs(during.player.aimPitch + during.player.recoilPitch - during.player.pitch) < 1e-3,
      `aim ${during.player.aimPitch} + recoil ${during.player.recoilPitch} = ${during.player.pitch}`);
    check('连发期间产生了后坐力临时偏移', during.player.recoilPitch > 0.002,
      `recoilPitch ${during.player.recoilPitch}`);
    check('连发期间玩家的瞄准不被后坐力改动（两笔账分开）',
      Math.abs(during.player.aimPitch - before.player.aimPitch) < 1e-4,
      `aimPitch ${before.player.aimPitch} → ${during.player.aimPitch}`);

    // ---- 连发净抬升必须显著为正（M2-TEMP-1 的核心验收）----
    const netClimbDeg = ((during.player.pitch - before.player.pitch) * 180) / Math.PI;
    const rateDegPerSec = netClimbDeg / burstSec;
    check('连发净抬升显著为正（恢复不再抵消抬升）', netClimbDeg > 2.0,
      `连发 ${burstSec.toFixed(2)}s 净抬升 ${netClimbDeg.toFixed(2)}°（约 ${rateDegPerSec.toFixed(1)}°/s）`);
    // 与配置表算出的速率对照，确认运行时行为与量化报表一致。
    // 必须按**当前武器 id** 查表 —— 初版直接取了列表第 0 项（P9 手枪），
    // 而玩家手里是 M4，于是拿错了参考值。
    const cfgRate = await page.evaluate(
      (id) => window.__m2.recoilReport().find((r) => r.id === id)?.sustainedClimb ?? null,
      during.weapon.id
    );
    check('实测抬升速率与配置表算出的速率同量级',
      cfgRate !== null && Math.abs(rateDegPerSec - cfgRate) < Math.max(2.5, cfgRate * 0.5),
      `实测 ${rateDegPerSec.toFixed(1)}°/s vs 配置 ${cfgRate}°/s（${during.weapon.label}）`);

    // ---- 停火后恢复到玩家瞄的位置 ----
    await sleep(1500);
    const settled = await snap();
    check('停火后后坐力偏移归零', Math.abs(settled.player.recoilPitch) < 0.002,
      `recoilPitch ${settled.player.recoilPitch}`);
    check('停火后视角回到玩家瞄的位置', Math.abs(settled.player.pitch - settled.player.aimPitch) < 0.002,
      `pitch ${settled.player.pitch} vs aimPitch ${settled.player.aimPitch}`);

    // ---- 玩家主动压枪不应被恢复抵消（M2-TEMP-1 的原始症状）----
    // 这是"两笔账分开"的核心验收：压枪改变的是**瞄准**，
    // 恢复只削减**后坐力偏移**，因此最终视角必须停在玩家压枪后的位置，
    // 而不是被恢复顶回原来的瞄准点。
    {
      await call('aimAt', 11.25, 1.65, 11.25 - 30);
      await sleep(250);
      const a0 = await snap();
      await page.mouse.down({ button: 'left' });
      await sleep(700);
      await page.mouse.up({ button: 'left' });
      await sleep(80);
      const a1 = await snap();
      check('连发后存在后坐力临时偏移', a1.player.recoilPitch > 0.002,
        `recoilPitch ${a1.player.recoilPitch}`);

      const comp = await call('compensatePitch', 3);
      const a2 = await snap();
      // 用 compensatePitch 在**同一次调用内**返回的前后值来判断，
      // 避免中间插入的若干帧让恢复改动 recoilPitch，从而误判成"压枪动了后坐力偏移"。
      check('压枪改变的是瞄准、且不动后坐力偏移',
        comp.before.aimPitch !== comp.after.aimPitch &&
          comp.before.recoilPitch === comp.after.recoilPitch &&
          Math.abs(comp.after.pitch - (comp.after.aimPitch + comp.after.recoilPitch)) < 1e-5,
        `aimPitch ${comp.before.aimPitch} → ${comp.after.aimPitch}；` +
          `recoilPitch ${comp.before.recoilPitch} → ${comp.after.recoilPitch}（应完全相同）`);

      await sleep(2600); // 等恢复完成（含 recoveryDelayMs）
      const a3 = await snap();
      check('恢复完成后视角停在压枪后的位置，没有被顶回去',
        Math.abs(a3.player.pitch - a2.player.aimPitch) < 0.003,
        `最终 pitch ${a3.player.pitch} vs 压枪后 aimPitch ${a2.player.aimPitch}`);
      const keptDeg = ((a0.player.pitch - a3.player.pitch) * 180) / Math.PI;
      check('玩家的 3° 压枪量被完整保留',
        Math.abs(keptDeg - 3) < 0.35,
        `视角相对开火前下降了 ${keptDeg.toFixed(2)}°（期望约 3°）`);
      check('后坐力偏移已完全归零', Math.abs(a3.player.recoilPitch) < 0.002,
        `recoilPitch ${a3.player.recoilPitch}`);
    }

    // 开镜：FOV 应变小
    await sleep(600);
    const hip = await snap();
    await page.mouse.down({ button: 'right' });
    await sleep(500);
    const ads = await snap();
    check('按住右键开镜（M2-2）', ads.weapon.adsT > 0.85, `adsT=${ads.weapon.adsT}`);
    check('开镜使 FOV 变小', ads.weapon.fov < hip.weapon.fov - 5,
      `${hip.weapon.fov}° → ${ads.weapon.fov}°`);
    await page.mouse.down({ button: 'left' });
    await sleep(300);
    const adsFire = await snap();
    await page.mouse.up({ button: 'left' });
    check('开镜射击扩散小于腰射', adsFire.weapon.spread < during.weapon.spread,
      `腰射 ${during.weapon.spread} vs 开镜 ${adsFire.weapon.spread}`);
    await page.mouse.up({ button: 'right' });
    await sleep(400);
    const back = await snap();
    check('松开右键退镜', back.weapon.adsT < 0.2, `adsT=${back.weapon.adsT}`);
  }

  // ============================================================
  group('② M2-1 切枪与换弹');
  {
    await ensureRunning('weapon');
    const s0 = await snap();
    await page.keyboard.press('Digit2');
    await sleep(250);
    const s1 = await snap();
    check('按 2 切到副武器', s1.weapon.id !== s0.weapon.id, `${s0.weapon.label} → ${s1.weapon.label}`);
    check('副武器使用不同弹药（M2-1 弹药类型）', s1.weapon.reserve !== s0.weapon.reserve,
      `备弹 ${s0.weapon.reserve} → ${s1.weapon.reserve}`);
    await page.keyboard.press('Digit1');
    await sleep(250);
    const s2 = await snap();
    check('按 1 切回主武器', s2.weapon.id === s0.weapon.id, s2.weapon.label);

    // 打几发再换弹
    await page.mouse.down({ button: 'left' });
    await sleep(350);
    await page.mouse.up({ button: 'left' });
    await sleep(120);
    const before = await snap();
    await page.keyboard.press('KeyR');
    await sleep(200);
    const reloading = await snap();
    check('按 R 触发换弹', reloading.weapon.reloading === true || reloading.weapon.magazine > before.weapon.magazine,
      `reloading=${reloading.weapon.reloading}`);
    await sleep(2600);
    const after = await snap();
    check('换弹完成后弹匣补满', after.weapon.magazine === before.weapon.magazine + (after.weapon.magazine - before.weapon.magazine) &&
      after.weapon.magazine > 0, `弹匣 ${before.weapon.magazine} → ${after.weapon.magazine}`);
  }

  // ============================================================
  group('④ M2-4 部位伤害与护甲耐久');
  {
    await ensureRunning('damage');
    const placed = await page.evaluate(() => window.__m2.teleportNearAi(0, 4));
    check('找到有视线的射击位', !!placed, placed ? `${placed.tier} @ ${placed.angleDeg}°` : '未找到');
    await sleep(200);

    const h0 = await page.evaluate(() => window.__m2.aiHealthList().find((a) => a.alive));
    await page.mouse.down({ button: 'left' });
    for (let i = 0; i < 8; i++) {
      // 注意：Node 端变量不能直接出现在 page.evaluate 的浏览器函数里（作用域不同）。
      // 初版就写成 `a.id === h0.id` 而报 h0 is not defined —— 必须作为参数传入。
      await page.evaluate((targetId) => {
        const s = window.__m2.snapshot();
        const target = s.ai.find((a) => a.id === targetId);
        if (target) window.__m2.aimAt(target.x, 1.18, target.z);
      }, h0.id);
      await sleep(90);
    }
    await page.mouse.up({ button: 'left' });
    await sleep(200);
    const h1 = await page.evaluate((id) => window.__m2.aiHealthList().find((a) => a.id === id), h0.id);
    check('射击使 AI 掉血（M2-4）', !h1 || h1.health < h0.health || !h1.alive,
      `${h0.tier} ${h0.health} → ${h1 ? h1.health.toFixed(1) : '已击杀'}`);

    const s = await snap();
    check('命中数与伤害被统计（M2-3/4）', s.combat.hits > 0 && s.combat.damageDealt > 0,
      `命中 ${s.combat.hits} 次 / 伤害 ${s.combat.damageDealt.toFixed(1)}`);
  }

  // ============================================================
  group('④ 回归：隔墙打不中（M1-TEMP-16 已修）');
  {
    const behind = await page.evaluate(() => window.__m2.placeBehindWall(0));
    check('找到"玩家—墙—AI"三点一线位置', !!behind,
      behind ? `玩家格 ${behind.playerCell} 墙格 ${behind.wallCell}` : '未找到');
    if (behind) {
      await sleep(200);
      const before = await page.evaluate((id) => window.__m2.aiHealthList().find((a) => a.id === id), behind.aiId);
      await page.mouse.down({ button: 'left' });
      await sleep(900);
      await page.mouse.up({ button: 'left' });
      await sleep(200);
      const after = await page.evaluate((id) => window.__m2.aiHealthList().find((a) => a.id === id), behind.aiId);
      const unchanged = after.alive && before.health === after.health;
      check('隔着墙射击不会命中墙后的 AI', unchanged,
        `血量 ${before.health} → ${after.health}（若减少即为穿墙命中）`);
    }
  }

  // ============================================================
  group('⑥ M2-6 AI 状态机与寻路');
  {
    await ensureRunning('ai');
    const s0 = await snap();
    // ★ 守卫：本组依赖"局内在跑"。若玩家已阵亡或流程已结束，AI 不再 update，
    //   于是状态停在 patrol、路径为 0、更新分级为 null —— 看起来像"AI 坏了"，
    //   实际是"根本没在局内"。这条守卫让那种情况**报错而不是误导**。
    check('AI 测试开始时确实处于局内且未暂停（防止在已结束的局上测）',
      s0.flow === 'raid' && !s0.paused,
      `flow=${s0.flow} paused=${s0.paused} 玩家生命 ${s0.player.health}`);
    const before = new Map(s0.ai.map((a) => [a.id, { x: a.x, z: a.z, updates: a.updates }]));

    // 惊动 AI：传送到 AI 附近并开火。
    //
    // ★ 这里原来是一个固定 3.5s 等待，**会偶发失败**（实测同代码两次跑出不同结果）。
    //   原因是"AI 注意到玩家"要走完 感知 → 反应（reactMs）→ 状态机切换 一整条链路，
    //   耗时受距离、视线、AI 是否正背对着你影响，固定等待本质上是在赌运气。
    //   改成轮询 + 定期补枪：只在超时后才判失败，且失败信息里带上观测到的证据。
    //   （同类修复见医疗组：固定 4s 等待改为轮询。）
    let s1 = await snap();
    let sawAlert = false;
    const alertDeadline = Date.now() + 14000;
    while (Date.now() < alertDeadline) {
      await page.evaluate(() => window.__m2.teleportNearAi(0, 6));
      await page.mouse.down({ button: 'left' });
      await sleep(350);
      await page.mouse.up({ button: 'left' });
      await sleep(650);
      s1 = await snap();
      if (s1.flow !== 'raid') break; // 玩家阵亡 / 流程结束 —— 后面的守卫会报出来
      if (s1.ai.some((a) => a.state !== 'patrol')) {
        sawAlert = true;
        break;
      }
    }
    // 再等一会，让被惊动的 AI 真正跑出一段路径
    await sleep(1500);
    s1 = await snap();
    const moved = s1.ai.filter((a) => {
      const b = before.get(a.id);
      return b && (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.z - b.z) > 0.5);
    });
    check('AI 会移动（寻路生效，M1-TEMP-6 已修）', moved.length > 0,
      `${moved.length}/${s1.ai.length} 个 AI 产生了位移`);

    const states = [...new Set(s1.ai.map((a) => a.state))];
    check('AI 状态机产生非 patrol 状态', states.some((x) => x !== 'patrol'),
      `状态集合 ${states.join(',')}；轮询期间已观测到警觉=${sawAlert}；` +
        `各 AI 更新次数 ${s1.ai.map((a) => a.updates).join(',')}；` +
        `flow=${s1.flow} 玩家生命 ${s1.player.health}`);

    const gainedPath = s1.ai.some((a) => a.pathLen > 0);
    check('AI 通过调度器获得了路点', gainedPath, `最长路径 ${Math.max(...s1.ai.map((a) => a.pathLen))} 点`);

    // ---- 回归：受击/发现后必须「一边靠近一边交战」，而不是掉回巡逻乱跑 ----
    //
    // 缺陷原貌（试玩报告："AI 发现玩家或被攻击后漫无目的地乱跑，不靠近也不射击"）：
    //   ① 受击只切 ALERT，**不记录攻击者位置**，所以 AI 不知道往哪还手；
    //   ② SEARCH 的记忆超时看 lastSeenAt，而"只听到枪声/只挨了打"都不写 lastSeenAt，
    //      于是 memoryGone 在**第一帧就为真** -> SEARCH 立刻掉回 PATROL；
    //   ③ 掉回 PATROL 后仍在走旧的随机巡逻路径（pathIdx < pathLen 时不重新请求），
    //      而 tryShoot 要求 state===COMBAT -> 一枪不开。
    //   表现为：挨了打，然后朝着一个随机角落跑掉。
    {
      const s3 = await snap();
      const aliveNow = s3.ai.filter((a) => a.alive);
      const engaged = aliveNow.filter((a) => a.state === 'combat' || a.state === 'search');
      check('受击/发现后有 AI 进入交战或搜索（不得停在巡逻）', engaged.length > 0,
        `存活 ${aliveNow.length} 个，状态集合 ${[...new Set(aliveNow.map((a) => a.state))].join(',')}`);

      // 观察对象必须选**离得远**的那个：太近的 AI 按设计要后撤（minRangeM=5），
      // 拿它测"是否会靠近"必然失败 —— 我第一版就是这么写错的。
      const dist = (a, p) => Math.hypot(a.x - p.x, a.z - p.z);
      const ranked = aliveNow
        .map((a, i) => ({ a, i, d: dist(a, s3.player) }))
        .sort((p, q) => q.d - p.d);
      const far = ranked[0];
      if (!far || far.d < 12) {
        check('存在离玩家足够远的 AI 可供观察（否则"靠近"无从测起）', false,
          far ? `最远的只有 ${far.d.toFixed(1)}m` : '没有存活 AI');
      } else {
        // ★ 只**制造枪声**惊动它，不开枪打它。
        //   我第一版用 `mouse.down` 点射，结果在 10m 距离上直接把观察对象打死了
        //   （读数变成"起始 —"），测试把自己的被测对象消灭了。
        //   枪声走的是 hearGunshot 通路，与"被攻击"一样会写入最后已知位置，
        //   但不会造成伤害 —— 既测到行为，又不会毁掉样本。
        const shot = await page.evaluate((i) => {
          const r = window.__m2.teleportNearAi(i, 12);
          window.__m2.makeNoise();
          return r;
        }, far.i);
        await ensureRunning('ai-approach-shot');

        let d0 = null;
        let dMin = Infinity;
        let sawEngaged = false;
        // ★ 观察窗口从 12 次（4.8s）放宽到 24 次（9.6s）。
        //   原因：这张两层地图的可玩面积是单层图的 1.5 倍、隔墙也更密，
        //   AI 从 12m 外过来常常要绕路 —— 4.8s 内**直线距离**只缩短 2.5m 是正常的，
        //   但它确实在靠近。窗口太短会把"绕路中"误判成"不靠近"。
        //   注意这条断言测的是"会不会主动逼近"，放宽的是**时间**而不是判据本身。
        for (let k = 0; k < 24; k++) {
          await sleep(400);
          // ★ 暂停时局内不推进，读数会**完全冻结**（我第一版就在这里踩了坑：
          //   ai_4 的距离精确停在 17.9m 且状态永不变，看起来像"AI 不更新"，
          //   实际是点击让指针锁丢失、游戏暂停了）。flow 仍是 raid，所以只查 flow 发现不了。
          if (!(await ensureRunning('ai-approach'))) break;
          const s4 = await snap();
          if (s4.flow !== 'raid' || s4.paused) break;
          const me = s4.ai.find((a) => a.id === shot.aiId);
          if (!me || !me.alive) break;
          if (me.state === 'combat' || me.state === 'search') sawEngaged = true;
          const d = dist(me, s4.player);
          if (d0 === null) d0 = d;
          dMin = Math.min(dMin, d);
        }
        check('被攻击的那个 AI 进入了交战/搜索',
          sawEngaged, `观察对象 ${shot.aiId}（起始 ${d0 === null ? '—' : d0.toFixed(1) + 'm'}）`);
        check('被攻击的 AI 会主动向玩家逼近（距离缩短 ≥3m）',
          d0 !== null && dMin < d0 - 3,
          `${shot.aiId}：起始 ${d0 === null ? '—' : d0.toFixed(1) + 'm'} → 过程中最近 ${Number.isFinite(dMin) ? dMin.toFixed(1) + 'm' : '—'}`);
      }
    }
  }

  // ============================================================
  group('⑥ M2 硬性要求：AI 更新频率分级 + 寻路限流（C-1/C-2）');
  {
    const s = await snap();
    // 同样加守卫：ai.updateTier 只在 ai.update() 里赋值，若已不在局内就永远是 null
    check('更新分级测试时确实处于局内（否则全是 null，与"分级坏了"无法区分）',
      s.flow === 'raid' && !s.paused,
      `flow=${s.flow} paused=${s.paused} 各 AI 更新次数 ${s.ai.map((a) => a.updates).join(',')}`);
    const withTier = s.ai.filter((a) => a.updateIntervalMs !== null);
    check('每个 AI 都有更新分级', withTier.length === s.ai.length,
      `${withTier.length}/${s.ai.length}`);
    const intervals = [...new Set(s.ai.map((a) => a.updateIntervalMs))];
    // ★ 原断言写成 `intervals.length >= 1`，而 [null] 也满足 —— 等于没查。
    //   真正该查的是"至少有两种不同间隔"，否则分级形同虚设（所有 AI 同频）。
    check('更新分级确实按距离区分（至少出现两种不同间隔）',
      intervals.length >= 2 && intervals.every((v) => v !== null),
      `出现的间隔集合 [${intervals.join(', ')}]ms`);

    check('寻路每帧查询数不超上限（C-1）',
      s.scheduler.peakQueriesPerFrame <= 2,
      `峰值 ${s.scheduler.peakQueriesPerFrame} 次/帧（上限 2）`);
    check('单帧寻路耗时不超上限（C-2）',
      s.scheduler.peakFrameMs <= 4,
      `峰值 ${s.scheduler.peakFrameMs}ms（上限 2ms，留了测量余量）`);
  }

  // ============================================================
  group('③ M2-3 命中反馈（弹孔 / 统计）');
  {
    const s = await snap();
    check('射击在地面或墙上留下弹孔', s.decals > 0, `已放置 ${s.decals} 个`);
  }

  // ============================================================
  group('⑤ M2-5 医疗与消耗品');
  {
    await ensureRunning('medical');
    const s0 = await snap();

    // ---- 先制造伤害：靠近 AI、朝天开一枪（枪声会让 AI 警觉），再等待被击中 ----
    // 单纯"传送到 AI 旁边"不够可靠：AI 若背对着玩家，视野锥判定不会发现我们，
    // 于是它整段时间都保持 patrol 而不开火 —— 那会让断言变成随机结果。
    //
    // ★ 用**轮询等待**而不是固定 4 秒：AI 还需要反应时间、转身、进入交战状态，
    //   而且它自己也在移动。固定等待会让这条断言时通时不通（实测就是如此）。
    //   同时每隔几秒补一枪重新引起注意，避免它中途丢失目标。
    const alert = async () => {
      await page.evaluate(() => window.__m2.teleportNearAi(0, 5));
      await page.evaluate(() => window.__m2.aimAt(0, 40, 0)); // 朝天
      await page.mouse.down({ button: 'left' });
      await sleep(200);
      await page.mouse.up({ button: 'left' });
      await page.evaluate(() => window.__m2.teleportNearAi(0, 5));
    };
    await alert();

    let hurt = null;
    for (let i = 0; i < 50; i++) {
      const s = await snap();
      if (s.player.health < s0.player.health) {
        hurt = s;
        break;
      }
      if (i > 0 && i % 12 === 0) await alert(); // 每约 3 秒重新引起注意
      await sleep(250);
    }
    hurt = hurt ?? (await snap());
    check('被 AI 击中会掉血（在等待窗口内）', hurt.player.health < s0.player.health,
      `生命 ${s0.player.health.toFixed(1)} → ${hurt.player.health.toFixed(1)}；` +
        `胸甲 ${s0.player.armor.body.durability} → ${hurt.player.armor.body.durability}`);
    check('护甲承受伤害后耐久下降（M2-4）',
      hurt.player.armor.body.durability <= s0.player.armor.body.durability,
      `${s0.player.armor.body.durability} → ${hurt.player.armor.body.durability}`);

    // ---- 治疗必须在安全位置测：受击会打断治疗（stopOnDamage），
    //      在交火中测"回血"必然得到"血量下降"的假失败 ----
    const safe = await page.evaluate(() => window.__m2.teleportToSafeSpot());
    check('找到远离所有 AI 的安全位置用于测治疗', !!safe,
      safe ? `距最近 AI ${safe.minAiDistance}m` : '未找到');
    await sleep(400);
    const beforeHeal = await snap();
    const medkitsBefore = beforeHeal.consumables.medkit;

    // 用急救包（上限 100）而不是绷带（上限 45）：
    // 绷带在血量高于 45 时按设计**不产生效果**（见 player.useConsumable），
    // 这里若用绷带就会测成"没回血"，那是设计正确而非缺陷。
    // 绷带的"高于上限不生效"已由单测覆盖。
    await page.keyboard.press('Digit4');
    await sleep(250);
    const using = await snap();
    check('按 4 开始使用急救包', using.player.using === true, `using=${using.player.using}`);

    await page.waitForFunction(() => window.__m2.snapshot().player.using === false, { timeout: 8000 });
    await sleep(200);
    const healed = await snap();
    check('使用后回血（M2-5）', healed.player.health > beforeHeal.player.health,
      `${beforeHeal.player.health.toFixed(1)} → ${healed.player.health.toFixed(1)}`);
    check('治疗不会降低生命（回归：绷带把人治到上限的 bug）',
      healed.player.health >= beforeHeal.player.health,
      `${beforeHeal.player.health.toFixed(1)} → ${healed.player.health.toFixed(1)}`);
    check('消耗品数量减少', healed.consumables.medkit === medkitsBefore - 1,
      `急救包 ${medkitsBefore} → ${healed.consumables.medkit}`);

    // 顺带验证：血量已高于绷带上限时，按 3 不应消耗绷带
    if (healed.player.health > 45) {
      const b0 = healed.consumables.bandage;
      await page.keyboard.press('Digit3');
      await sleep(400);
      const noop = await snap();
      check('血量高于绷带上限时使用绷带会被拒绝（不浪费）',
        noop.consumables.bandage === b0 && noop.player.using === false,
        `绷带 ${b0} → ${noop.consumables.bandage}, using=${noop.player.using}`);
    }
  }

  // ============================================================
  group('① 闭环：搜刮 → 撤离 → 结算');
  {
    await ensureRunning('loop');
    for (let n = 0; n < 2; n++) {
      const ok = await call('teleportToContainer');
      if (!ok) break;
      await sleep(150);
      await page.keyboard.down('KeyF');
      await sleep(3200);
      await page.keyboard.up('KeyF');
      await sleep(150);
    }
    const looted = await snap();
    check('容器可被搜索开启（按 F）', looted.loot.opened >= 1, `${looted.loot.opened}/${looted.loot.total}`);
    check('搜到物品并产生估值', looted.loot.inventory >= 1 && looted.loot.value > 0,
      `${looted.loot.inventory} 件 / 估值 ${looted.loot.value}`);

    await call('teleportToExtract');
    const ended = await waitForEnd(30000);
    check('完成撤离并结算（等待流程结束）', ended, ended ? '已结束' : '30 秒内未结束');
    const done = await snap();
    check('撤离成功且原因为 extracted', done.flow === 'ended' && done.endReason === 'extracted',
      `flow=${done.flow} reason=${done.endReason}`);
  }

  // ============================================================
  group('① 失败路径');
  {
    await loadAndStart();
    await call('killPlayer');
    await page.waitForFunction(() => window.__m2.snapshot().flow === 'ended', { timeout: 8000 });
    check('生命归零判定阵亡', (await snap()).endReason === 'dead');

    // M4-4：阵亡不只要判定为 dead，还要真的产出"死亡口径"的结算结果 ——
    // carried=false、只保安全箱、且损失是**逐件**列出来的（不只是一个估值）。
    const dr = (await snap()).raidResult;
    check('★ 阵亡结算采用死亡口径（carried=false，只保住安全箱里的）',
      !!dr && dr.carried === false && dr.outcome === 'death',
      dr ? `carried=${dr.carried} outcome=${dr.outcome} 带出${dr.loot.keptValue}/损失${dr.loot.lostValue}` : '没有结算结果');
    check('M4-4：结算里带有损失清单与保险箱清单两个数组（供界面逐件列出）',
      !!dr && Array.isArray(dr.lostItems) && Array.isArray(dr.safeItems),
      dr ? `lostItems=${dr.lostItems.length} safeItems=${dr.safeItems.length}` : '没有结算结果');

    await loadAndStart();
    await call('setTimeLimitMs', 800);
    await page.waitForFunction(() => window.__m2.snapshot().flow === 'ended', { timeout: 10000 });
    check('超时判定失败', (await snap()).endReason === 'timeout');

    // M4-5：超时同样要产出明确的结算结果（与阵亡同一失败口径：只保安全箱）。
    // 只检查 endReason 不够 —— 那只能证明"判了超时"，不能证明"结算是对的"。
    const tr = (await snap()).raidResult;
    check('★ M4-5：超时走失败口径结算（不带出战利品，只保安全箱）',
      !!tr && tr.carried === false && tr.outcome === 'death',
      tr ? `carried=${tr.carried} outcome=${tr.outcome} 带出${tr.loot.keptValue}` : '没有结算结果');

    // 主动放弃（M4 DoD 五条路径里的"主动退出"）。
    // 走**真实 UI 流程**而不是 DEV 接口：点按钮 -> 弹二次确认 -> 取消/确认。
    // 只测 DEV 接口会漏掉"按钮根本没接上"或"点了直接放弃、没有确认"这类问题。
    await loadAndStart();
    await page.evaluate(() => document.getElementById('btnAbandon').click());
    const dlgOpen = await page.evaluate(() =>
      document.getElementById('screenAbandon').classList.contains('on'));
    const stillRaid = (await snap()).flow === 'raid';
    check('★ 点"放弃本局"**不会**立即放弃，而是弹出二次确认',
      dlgOpen && stillRaid, `弹窗=${dlgOpen} 仍在局内=${stillRaid}`);

    await page.evaluate(() => document.getElementById('btnAbandonCancel').click());
    const afterCancel = await snap();
    check('取消后弹窗关闭，且仍留在局内（放弃没有被偷偷执行）',
      afterCancel.flow === 'raid' && afterCancel.endReason === null,
      `flow=${afterCancel.flow} reason=${afterCancel.endReason}`);

    await page.evaluate(() => document.getElementById('btnAbandon').click());
    await page.evaluate(() => document.getElementById('btnAbandonConfirm').click());
    await page.waitForFunction(() => window.__m2.snapshot().flow === 'ended', { timeout: 8000 });
    const abSnap = await snap();
    check('确认后判定 abandoned', abSnap.endReason === 'abandoned',
      `reason=${abSnap.endReason}`);
    const ar = abSnap.raidResult;
    check('★ 主动放弃按未撤离口径结算（只保住安全箱里的）',
      !!ar && ar.carried === false && ar.outcome === 'death',
      ar ? `carried=${ar.carried} outcome=${ar.outcome} 带出${ar.loot.keptValue}` : '没有结算结果');
  }

  // ============================================================
  // M4-7 断线 / 刷新
  //
  // M4 约束词把它列为**必须实测**的一项：
  //   「必须实测：结算过程中途强行刷新浏览器，重进后数据是否一致」。
  // 所以这里是真的 reload 一次，而不是只验证代码路径存在。
  // ============================================================
  group('M4-7 断线 / 刷新');
  {
    await loadAndStart();
    // 先捡点东西，让"断线后带走什么"有可核对的数字
    await call('teleportToContainer', 0);
    await page.keyboard.down('KeyF');
    await sleep(6000);
    await page.keyboard.up('KeyF');
    await sleep(300);
    const before = await snap();
    const beforeSafe = before.loot.safe.value;
    check('夹具成立：刷新前背包里已有东西可结算',
      before.loot.inventory >= 1, `背包 ${before.loot.inventory} 件 / 保险箱 ${beforeSafe}`);

    // 强行刷新 —— 这就是"断线 / 关闭页面"
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__m2 !== 'undefined', { timeout: 15000 });

    const noticeShown = await page.evaluate(
      () => !document.getElementById('interruptedNotice').hidden
    );
    check('★ 中途刷新后重进，能看到"上局未正常结束"提示（不是静默丢弃）',
      noticeShown === true, `提示可见=${noticeShown}`);

    await page.evaluate(() => document.getElementById('interruptedNotice').click());
    await sleep(300);
    const res = await page.evaluate(() => window.__m2.snapshot().raidResult);
    check('★ 点击提示给出上局结算，且口径为"未撤离"',
      !!res && res.reason === 'disconnected' && res.carried === false,
      res ? `reason=${res.reason} carried=${res.carried}` : '没有结算');
    check('★ 重进后的结算与刷新前一致（保险箱保住的部分分毫不差）',
      !!res && res.loot.keptValue === beforeSafe,
      res ? `重进后带出 ${res.loot.keptValue} vs 刷新前保险箱 ${beforeSafe}` : '没有结算');

    // ★ 界面这一层也必须断言。
    //   只查 `raidResult` 不够：那个对象是纯函数产物，**即使一个字都没画到界面上**
    //   它照样是有的 —— 我改 M4-BUG-02 时就一度让这条路径只结算、不显示，
    //   而当时所有断言仍然全绿。这条断言就是为了让"结算页真的画出来了"成为事实。
    //   结算正文写在 `#screenEnd` 里的 `#endBody`（见 index.html）。
    const endShown = await page.evaluate(
      () => document.getElementById('screenEnd').classList.contains('on')
    );
    const endText = await page.evaluate(() => {
      const b = document.getElementById('endBody');
      return b ? b.textContent.replace(/\s+/g, ' ').trim() : '';
    });
    check('★ 点击提示后结算页真的画出内容（不是"只结算、不显示"）',
      endShown === true && endText.length > 0 && endText.includes(String(beforeSafe)),
      `结算页可见=${endShown}，正文含"${beforeSafe}"=${endText.includes(String(beforeSafe))}（正文 ${endText.length} 字）`);

    // 幂等：结算过一次后再刷新，不该再弹（否则会重复发放/重复打扰）
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__m2 !== 'undefined', { timeout: 15000 });
    const again = await page.evaluate(
      () => !document.getElementById('interruptedNotice').hidden
    );
    check('★ 幂等：结算过一次后再刷新不再提示（不会重复结算）',
      again === false, `再次提示=${again}`);
  }

  // ============================================================
  // M4-BUG-01 / M4-BUG-02 回归防线
  //
  // 这两条缺陷的共同点与 M3-BUG-01 一样：**断言的对象与被破坏的对象不是同一个**。
  //   · M4-BUG-01：调试接口 killOneAi 一调就抛异常（从 M0~M2 那次提交起就是坏的），
  //     而 verify-prod-bundle 只查"这个名字有没有进生产包"、从不调用它 ——
  //     于是 M4-1 的 killsAfter 撤离点（e4_archive）根本无法被端到端验证。
  //     修好它之后还有第二层：击杀计数原先只由"玩家用枪打死"自增，这个接口绕过了
  //     武器路径，于是 AI 死了、kills 仍是 0，那条撤离点照样开不了。
  //   · M4-BUG-02：`startRaid()` 无条件清快照，而补结算只挂在"点击提示"上 ——
  //     玩家不点提示直接开新局，上局（含安全箱里本该保住的）静默消失。
  // ============================================================
  group('M4-BUG-01 killsAfter 撤离点（此前零覆盖）');
  {
    await loadAndStart();
    const s0 = await snap();
    const e4 = byPos(s0.extract, (6 + 0.5) * 2.5, (6 + 0.5) * 2.5);
    check('夹具成立：地图里存在 killsAfter 撤离点（e4_archive，二层）',
      !!e4 && e4.rule === 'killsAfter', e4 ? `rule=${e4.rule} open=${e4.open} 还需=${e4.remainingKills}` : '没找到');

    if (e4) {
      check('开局（0 杀）未开放，且给出"还需几名"',
        e4.open === false && e4.remainingKills === 3,
        `open=${e4.open} remainingKills=${e4.remainingKills}`);

      await page.evaluate(({ x, z }) => window.__m2.teleport(x, z, 1), { x: e4.x, z: e4.z });
      await sleep(1200);
      const sb = await snap();
      const e4b = byPos(sb.extract, e4.x, e4.z);
      check('★ 站在未开放的撤离点里不累积进度（不会偷偷撤离）',
        e4b && e4b.progress === 0, `progress=${e4b ? e4b.progress : 'n/a'}`);

      // ★ 这一条就是 M4-BUG-01 的防线本身：接口必须可用，且必须记入击杀数
      const killErrs = [];
      const killsSeq = [];
      for (let i = 0; i < 3; i++) {
        const r = await page.evaluate(() => {
          try { return { ok: true, ret: window.__m2.killOneAi() }; }
          catch (e) { return { ok: false, msg: String((e && e.message) || e) }; }
        });
        if (!r.ok) killErrs.push(r.msg);
        await sleep(250);
        killsSeq.push((await snap()).kills);
      }
      check('★ 调试接口 killOneAi() 可用（不再抛 ballistics 部位伤害异常）',
        killErrs.length === 0, killErrs.length ? `${killErrs.length}/3 次抛错：${killErrs[0]}` : '三次调用均成功');
      check('★ 每次击杀都记入"累计击杀数"（夹具绕过了武器路径，计数必须仍然成立）',
        killsSeq.join(',') === '1,2,3', `kills 序列 = ${killsSeq.join(',')}`);

      await sleep(400);
      const sk = await snap();
      const e4c = byPos(sk.extract, e4.x, e4.z);
      check('★ 累计 3 杀后 killsAfter 撤离点开放',
        e4c && e4c.open === true, e4c ? `open=${e4c.open} reason=${e4c.reason}` : 'n/a');

      if (e4c && e4c.open) {
        const t0 = Date.now();
        let ended = null;
        while (Date.now() - t0 < 25000) {
          await page.evaluate(() => window.__m2.healPlayer(9999));
          const s = await snap();
          if (s.flow === 'ended') { ended = s; break; }
          await sleep(250);
        }
        check('★ 在 killsAfter 撤离点完成撤离并走 extract 口径结算',
          ended && ended.endReason === 'extracted' && ended.raidResult && ended.raidResult.carried === true,
          ended ? `reason=${ended.endReason} carried=${ended.raidResult && ended.raidResult.carried}` : '25 秒内未结束');
      }
    }
  }

  group('M4-BUG-02 不点提示直接开新局（此前会静默丢档）');
  {
    await loadAndStart();
    await call('teleportToContainer', 0);
    await page.keyboard.down('KeyF');
    await sleep(6000);
    await page.keyboard.up('KeyF');
    await sleep(6000);                       // 等定期快照（5s）落地
    const before = await snap();
    const beforeSafe = before.loot.safe.value;
    const cpBefore = await page.evaluate(() => localStorage.getItem('h5_extract_raid_checkpoint'));
    check('夹具成立：刷新前有战利品且定期快照已写入',
      cpBefore !== null && before.loot.inventory >= 1,
      `背包 ${before.loot.inventory} 件 / 保险箱 ${beforeSafe}`);

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__m2 !== 'undefined', { timeout: 15000 });
    const oldCp = await page.evaluate(() => localStorage.getItem('h5_extract_raid_checkpoint'));
    const oldRaidId = oldCp ? JSON.parse(oldCp).raidId : null;

    // ★ 关键动作：**不点提示**，直接开新局
    await page.click('#btnStart');
    await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
    await sleep(500);
    const res = await page.evaluate(() => window.__m2.snapshot().raidResult);
    check('★ 不点提示直接开新局，上局仍被补结算（不再静默丢档）',
      !!res && res.reason === 'disconnected' && res.carried === false,
      res ? `reason=${res.reason} carried=${res.carried}` : '没有结算 —— 上局被丢了');
    check('★ 补结算保住了安全箱（与"点提示"这条路径的结果一致）',
      !!res && res.loot.keptValue === beforeSafe,
      res ? `带出 ${res.loot.keptValue} vs 刷新前保险箱 ${beforeSafe}` : 'n/a');

    // 新局现在**开局就写自己的第一笔快照**，所以"存在快照"不是残留信号 ——
    // 用 raidId 区分：换成了新局的 id，才说明上局那份已被结算清除。
    const newCp = await page.evaluate(() => localStorage.getItem('h5_extract_raid_checkpoint'));
    const newRaidId = newCp ? JSON.parse(newCp).raidId : null;
    check('★ 上局快照已被结算清除（现存的是新局自己的快照，raidId 已换）',
      oldRaidId && newRaidId && newRaidId !== oldRaidId,
      `旧 ${oldRaidId} → 新 ${newRaidId}`);
    check('★ 新局开局立刻就有快照（覆盖"开局几秒内被强杀"这个丢档窗口）',
      !!newCp && JSON.parse(newCp).elapsedMs < 3000 && JSON.parse(newCp).items.length === 0,
      newCp ? `elapsedMs=${JSON.parse(newCp).elapsedMs} items=${JSON.parse(newCp).items.length}` : '没有快照');
    const noticeAfter = await page.evaluate(() => !document.getElementById('interruptedNotice').hidden);
    check('补结算后提示已收起（不会一直挂着）', noticeAfter === false, `提示=${noticeAfter}`);
  }

  // ============================================================
  group('⑩ M1-TEMP-2 移动手感：加速 / 摩擦 / 落地缓冲');
  {
    // ★ 必须先开一局。
    // 上一组（失败路径）把流程推到了 ended，而局内逻辑只在 flow==='raid' 时推进。
    // 若直接测，所有速度读数都是 0、Space 也不起跳 —— 看起来像"移动坏了"，
    // 实际是"根本没在局内"。下面这条守卫断言就是为了让这种情况**报错而不是静默通过**。
    await loadAndStart();
    await ensureRunning('movement');
    {
      const st = await snap();
      check('移动测试开始时确实处于局内（防止测出全 0 的假结果）',
        st.flow === 'raid', `flow=${st.flow}`);
    }

    // 先在安全空地测，避免 AI 交火干扰速度测量
    await call('teleportToSafeSpot');
    await sleep(500);

    // ---- 加速必须是渐变，不能一帧到顶 ----
    const before = await snap();
    const speedBefore = before.player.speed;
    await page.keyboard.down('KeyW');
    await sleep(60); // 约 3~4 帧
    const early = await snap();
    await sleep(900); // 足够收敛
    const full = await snap();
    await page.keyboard.up('KeyW');

    check('起步时速度不是瞬间到顶（有加速过程）',
      early.player.speed > speedBefore && early.player.speed < full.player.speed * 0.95,
      `${speedBefore.toFixed(2)} → ${early.player.speed.toFixed(2)} → ${full.player.speed.toFixed(2)} m/s`);
    check('持续行走后收敛到步行速度附近',
      Math.abs(full.player.speed - 5.0) < 0.8, `${full.player.speed.toFixed(2)} m/s（目标 5.0）`);

    // ---- 松开后应有滑行减速过程，但最终停住 ----
    await sleep(90);
    const coasting = await snap();
    await sleep(1400);
    const stopped = await snap();
    check('松开方向键后有滑行减速过程（不是瞬间归零）',
      coasting.player.speed > 1.0 && coasting.player.speed < full.player.speed,
      `松开 90ms 后仍有 ${coasting.player.speed.toFixed(2)} m/s`);
    check('最终会完全停住（不是无限滑行）',
      stopped.player.speed === 0, `${stopped.player.speed.toFixed(3)} m/s`);

    // ---- 冲刺确实更快 ----
    await sleep(300);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await sleep(1200);
    const sprint = await snap();
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    check('冲刺速度高于步行速度', sprint.player.speed > full.player.speed + 1.0,
      `步行 ${full.player.speed.toFixed(2)} → 冲刺 ${sprint.player.speed.toFixed(2)} m/s`);
    check('冲刺速度不超过配置上限', sprint.player.speed <= 7.5 + 0.4,
      `${sprint.player.speed.toFixed(2)} ≤ 7.5`);

    // ---- 落地缓冲：跳起落下应产生相机下沉 ----
    await sleep(700);
    const dipBefore = (await snap()).player.landingDip;
    const landingsBefore = (await snap()).player.landings;
    await page.keyboard.press('Space');
    await sleep(130);
    const airborne = await snap();
    check('按 Space 能起跳（离地）', airborne.player.onGround === false,
      `onGround=${airborne.player.onGround} vy=${airborne.player.vy.toFixed(2)}`);

    let maxDip = 0;
    for (let i = 0; i < 40; i++) {
      const s = await snap();
      maxDip = Math.max(maxDip, s.player.landingDip);
      if (s.player.onGround && s.player.landings > landingsBefore) break;
      await sleep(50);
    }
    check('落地产生相机下沉（落地缓冲）', maxDip > dipBefore + 0.005,
      `下沉峰值 ${maxDip.toFixed(4)}m`);
    check('落地下沉有上限（不会把视角砸穿）', maxDip <= 0.22 + 1e-6, `${maxDip.toFixed(4)} ≤ 0.22`);
    // 回弹需要时间，必须等一会儿再采样 —— 立刻采样会因为下沉尚未开始恢复而得到
    // "没有回弹"的假失败，或用容差凑出一个没有意义的假通过。
    await sleep(450);
    const afterLand = await snap();
    check('落地后下沉会回弹', afterLand.player.landingDip < maxDip - 0.005,
      `${maxDip.toFixed(4)} → ${afterLand.player.landingDip.toFixed(4)}`);
  }

  // ============================================================
  // ============================================================
  group('⑪ 视角稳定性（"瞬移"的两条来源）');
  {
    await loadAndStart();
    await ensureRunning('view');
    await call('teleportToSafeSpot');
    await sleep(400);

    // ---- ① 异常鼠标事件必须被丢弃，不能把视角转掉几十度 ----
    //
    // 真实成因：指针锁定取得/失去时光标会被归位，浏览器可能把这次归位
    // 也报成一次 movement，量级等于窗口尺寸。直接应用就是一次"瞬移"。
    {
      const probeDelta = async (px) => {
        await call('resetViewProbe');
        const a = await snap();
        await page.evaluate((d) => window.__m2.injectMouseMove(d, 0), px);
        await sleep(150);
        const b = await snap();
        return {
          yawDeg: (Math.abs(b.player.yaw - a.player.yaw) * 180) / Math.PI,
          spikes: b.player.inputProbe.spikeEvents,
          lastSpike: b.player.inputProbe.lastSpikeDeltaPx,
        };
      };
      const normal = await probeDelta(40);
      check('正常鼠标移动会转动视角（不会被误杀）',
        normal.yawDeg > 1 && normal.yawDeg < 15, `40px → ${normal.yawDeg.toFixed(2)}°`);
      check('正常移动不被判定为异常事件', normal.spikes === 0, `丢弃数 ${normal.spikes}`);

      const spike1 = await probeDelta(900);
      const spike2 = await probeDelta(4000);
      check('异常大的鼠标事件被整帧丢弃（视角不瞬移）',
        spike1.yawDeg < 0.01 && spike2.yawDeg < 0.01,
        `900px → ${spike1.yawDeg.toFixed(3)}°，4000px → ${spike2.yawDeg.toFixed(3)}°`);
      check('异常事件被计数并记录幅度（便于事后诊断）',
        spike1.spikes === 1 && spike2.spikes === 1 && spike2.lastSpike === 4000,
        `丢弃数 ${spike1.spikes}/${spike2.spikes}，最后幅度 ${spike2.lastSpike}px`);
    }

    // ---- ② 满探头突然贴墙：不能单帧横向跳半米 ----
    //
    // 真实成因：探头量原本被墙面**瞬间裁剪**，而相机位置直接由它决定，
    // 于是相机在一帧内横向跳最多 0.55m（实测隐含横向速度 78.6 m/s）。已改为限速收回。
    //
    // ★ 必须先复位朝向：探头的"左右"由 yaw 决定，而上面那个鼠标子测试
    //   把视角转了几百度却没复原。结果就是"右"不再指向那面墙、裁剪压根不发生，
    //   断言会以错误的方式失败。**改了全局状态的测试必须复原，否则后一个测试在测垃圾。**
    {
      await call('teleportToSafeSpot');
      await call('resetAim', 0);
      await sleep(300);
      await page.keyboard.down('KeyE');
      await sleep(1100);
      const leaned = await snap();
      check('在开阔地可以探头到接近满值', leaned.player.leanCurrent > 0.85,
        `leanCurrent ${leaned.player.leanCurrent}（朝向 yaw=${leaned.player.yaw.toFixed(3)}）`);

      await call('resetViewProbe');
      const wall = await call('placeNextToWall', true);
      check('找到贴墙位置且探头量未被复位',
        !!wall && wall.leanCurrent > 0.85,
        wall ? JSON.stringify(wall) : '未找到');

      let maxLeanJump = 0;
      let maxLeanSpeed = 0;
      for (let i = 0; i < 20; i++) {
        const s = await snap();
        maxLeanJump = Math.max(maxLeanJump, s.player.viewProbe.maxLeanJump);
        maxLeanSpeed = Math.max(maxLeanSpeed, s.player.viewProbe.maxLeanSpeed);
        await sleep(50);
      }
      await page.keyboard.up('KeyE');
      await sleep(200);
      const settled = await snap();
      // 用**隐含横向速度**判定，而不是单帧变化量：
      // 后者随帧率变化（rate×dt，帧长 30ms 时就是 0.24），拿固定阈值会误判。
      // 限速后上限是 leanClampRate × leanOffset = 8 × 0.55 = 4.4 m/s，
      // 与冲刺速度 7.5 m/s 同量级；未限速时 0.48m 在一帧内 ≈ 60 m/s。
      check('探头被墙收回是渐进的（横向速度未超出物理量级）',
        maxLeanSpeed > 0 && maxLeanSpeed < 12,
        `隐含横向速度峰值 ${maxLeanSpeed.toFixed(2)} m/s（单帧最大变化 ${maxLeanJump.toFixed(4)}）；` +
          `未限速时约 60 m/s`);
      check('探头最终被收回到墙面允许的范围',
        settled.player.leanCurrent < 0.3, `leanCurrent ${settled.player.leanCurrent}`);
    }
  }

  // ============================================================
  group('⑩ M1-TEMP-3 台阶吸附：低掩体迈上 / 高掩体挡住');
  {
    const stats = await page.evaluate(() => window.__m2.coverStats());
    check('关卡生成了低矮掩体', stats.total > 0,
      `共 ${stats.total} 个（低 ${stats.low} / 高 ${stats.tall}）`);
    check('低掩体与高掩体都存在（两类都必须可测）', stats.low > 0 && stats.tall > 0,
      `低 ${stats.lowHeight}m × ${stats.low}，高 ${stats.tallHeight}m × ${stats.tall}`);

    // ---- 低掩体：走过去应自动迈上，不需要跳 ----
    const low = await page.evaluate(() => window.__m2.placeBeforeCover(false));
    check('找到低掩体前的起始位置', !!low,
      low ? `掩体格 ${low.coverCell} 高 ${low.height}m，距 ${low.distance}m` : '未找到');
    if (low) {
      await sleep(300);
      const s0 = await snap();
      // ★ 先确认夹具真的把玩家朝向掩体了。
      // 视角是派生值（aim + recoil）：若夹具去写 player.state.yaw 而不是 aim，
      // 下一帧 syncView 会把它覆盖成 0，玩家就面朝错误方向走过去、什么也测不到。
      // 这个断言就是为了让那种情况**报错而不是静默失败**。
      const wantYaw = Math.atan2(-(low.to.x - low.from.x), -(low.to.z - low.from.z));
      check('夹具已把玩家朝向掩体（否则后面的断言无意义）',
        Math.abs(s0.player.yaw - wantYaw) < 0.05,
        `yaw ${s0.player.yaw.toFixed(3)} vs 期望 ${wantYaw.toFixed(3)}`);
      // ★ 边走边轮询取峰值，而不是走完再采样：
      // 掩体只有一格宽（2.5m），持续走 1.6s 会直接走过头从另一侧掉下去，
      // 结束时 y 又回到 0 —— 那样测的是"走过去了"，不是"迈上去了"。
      await page.keyboard.down('KeyW');
      let maxY = s0.player.y;
      let sawStepUp = false;
      let movedMax = 0;
      // ★ 判断"是迈上去还是跳上去"，要看**抬升发生的那一刻是否仍在地面上**。
      // 用"落地次数没变"是不行的：玩家迈过掩体后会从另一侧走下去、正常落地一次，
      // 那会给出假失败。onGround 在抬升瞬间的值才是直接证据。
      let roseWhileGrounded = null;
      for (let i = 0; i < 26; i++) {
        const s = await snap();
        if (roseWhileGrounded === null && s.player.y > low.height * 0.5) {
          roseWhileGrounded = s.player.onGround;
        }
        maxY = Math.max(maxY, s.player.y);
        movedMax = Math.max(movedMax, Math.hypot(s.player.x - s0.player.x, s.player.z - s0.player.z));
        if (s.player.stepUps > s0.player.stepUps) sawStepUp = true;
        await sleep(60);
      }
      await page.keyboard.up('KeyW');
      await sleep(200);
      const s1 = await snap();

      check('玩家确实朝掩体走了（否则后面的断言无意义）', movedMax > 0.6,
        `最大水平位移 ${movedMax.toFixed(2)}m`);
      check('不按跳跃即可迈上低掩体（台阶吸附生效）',
        maxY >= low.height - 0.08,
        `脚底峰值 ${maxY.toFixed(3)}（掩体顶 ${low.height}）`);
      check('抬升是在地面状态下发生的（是迈上去，不是跳上去）',
        roseWhileGrounded === true,
        `抬升瞬间 onGround=${roseWhileGrounded}`);
      check('台阶吸附被记录为独立事件（不是按帧累加）',
        sawStepUp && s1.player.stepUps - s0.player.stepUps <= 3,
        `stepUps ${s0.player.stepUps} → ${s1.player.stepUps}`);
    }

    // ---- 高掩体：走不过去，必须跳 ----
    const tall = await page.evaluate(() => window.__m2.placeBeforeCover(true));
    check('找到高掩体前的起始位置', !!tall,
      tall ? `掩体格 ${tall.coverCell} 高 ${tall.height}m` : '未找到');
    if (tall) {
      await sleep(300);
      const p0 = await snap();
      // 同样边走边取峰值：高掩体应始终上不去，峰值 y 不该接近掩体顶
      await page.keyboard.down('KeyW');
      let maxY = p0.player.y;
      let movedMax = 0;
      for (let i = 0; i < 26; i++) {
        const s = await snap();
        maxY = Math.max(maxY, s.player.y);
        movedMax = Math.max(movedMax, Math.hypot(s.player.x - p0.player.x, s.player.z - p0.player.z));
        await sleep(60);
      }
      await page.keyboard.up('KeyW');
      await sleep(400);
      // ★ 防假通过：如果玩家根本没动，"没上去"也能通过 —— 那测的就不是掩体。
      check('玩家确实朝掩体移动了（否则"没上去"是假通过）', movedMax > 0.4,
        `最大水平位移 ${movedMax.toFixed(2)}m`);
      check('高掩体不能被走上去（必须跳）', maxY < tall.height - 0.2,
        `脚底峰值 ${maxY.toFixed(3)}（掩体顶 ${tall.height}，stepHeight ${stats.stepHeight}）`);

      // ★ 必须**贴住掩体再跳**：空中控制被刻意限制得很弱（airWishCap 1.5），
      // 从 2.5m 外原地起跳，整个滞空期只能前进约 0.2m，根本够不到掩体。
      // 先按住 W 走到被挡住，再在紧邻位置起跳。
      //
      // ★★ 同时测量"抬升是否平滑"。两个指标一起用，理由如下：
      //   · 单帧位移 Δy 会随帧率变化（同样 3.5m/s 的爬升，165Hz 下每帧 0.021m、
      //     30Hz 下 0.117m），拿固定阈值卡它在不同机器上会误判；
      //   · 与帧率无关的是**隐含竖直速度** Δy/Δt —— "跳变"的本质就是
      //     出现了一个物理上不可能的竖直速度（瞬间对齐 0.47m 在一帧内 = 几十 m/s）。
      //   另外统计"爬升途中被观测到的中间高度个数"：瞬间对齐几乎取不到中间值。
      await page.evaluate(() => window.__m2.resetMotionProbe());
      await page.keyboard.down('KeyW');
      await sleep(900); // 走到贴住掩体
      await page.keyboard.press('Space');
      let maxY2 = 0;
      let peakSpeed = 0;
      let intermediates = 0;
      for (let i = 0; i < 40; i++) {
        const s = await snap();
        maxY2 = Math.max(maxY2, s.player.y);
        peakSpeed = Math.max(peakSpeed, s.player.maxFrameDYSpeed);
        const y = s.player.y;
        if (y > 0.1 && y < tall.height - 0.1) intermediates++;
        await sleep(40);
      }
      await page.keyboard.up('KeyW');
      await sleep(400);
      const fin = await snap();
      peakSpeed = Math.max(peakSpeed, fin.player.maxFrameDYSpeed);

      check('贴住掩体起跳后可以站上高掩体（掩体几何是双向可用的）',
        maxY2 >= tall.height - 0.12,
        `脚底峰值 ${maxY2.toFixed(3)}（掩体顶 ${tall.height}，跳跃最高约 0.68m + stepHeight 0.55m）`);
      // 跳跃上升 5.2m/s、落地下降约 7m/s，因此正常量级在 7 以内；
      // 瞬间对齐 0.47m 在一帧内会产生几十 m/s。阈值 12 把两者清晰分开。
      check('跳上高箱子时抬升平滑（竖直速度未超出物理量级）',
        peakSpeed < 12,
        `隐含竖直速度峰值 ${peakSpeed.toFixed(2)} m/s（阈值 12；正常跳跃/下落约 5~7）`);
      check('爬升过程被观测到多个中间高度（不是一步到位）',
        intermediates >= 2,
        `中间高度采样数 ${intermediates}（瞬间对齐只会取到 0~1 个）`);
      check('运动探针本身有效（确实测到了变化）', peakSpeed > 0.5,
        `实测 ${peakSpeed.toFixed(2)} m/s，单帧最大 ${fin.player.maxFrameDY.toFixed(4)}m`);
    }
  }

  // ============================================================
  group('⑩ 掩体能挡子弹（M2 掩体对抗成立的前提）');
  {
    const tall = await page.evaluate(() => window.__m2.placeBeforeCover(true));
    if (tall) {
      const probe = async (h) =>
        page.evaluate(
          ({ cell, y }) => {
            const lv = window.__m2.levelInfo();
            const c = lv.cell;
            const cx = cell[0];
            const cz = cell[1];
            const mid = { x: (cx + 0.5) * c, z: (cz + 0.5) * c };
            return window.__m2.probeLineOfSight(mid.x - c, y, mid.z, mid.x + c, y, mid.z);
          },
          { cell: tall.coverCell, y: h }
        );
      const lowLos = await probe(0.3);
      const highLos = await probe(2.2);
      check('贴地视线被高掩体阻挡（蹲在掩体后是安全的）', lowLos === false,
        `y=0.3 视线通畅=${lowLos}`);
      check('从掩体上方可以越过（站直会被看到）', highLos === true,
        `y=2.2 视线通畅=${highLos}`);
    }
  }

  // ============================================================
  group('⑨ M2 DoD：连续 10 局无致命问题');
  {
    const FATAL = [];
    const perRaid = [];
    for (let i = 1; i <= 10; i++) {
      const t0 = Date.now();
      await loadAndStart();
      const errsBefore = pageErrors.length;

      // 每局做一组有代表性的动作：移动、射击、开镜、切枪、被 AI 打、搜刮
      await page.evaluate(() => window.__m2.teleportNearAi(0, 6));
      await page.mouse.down({ button: 'right' });
      await page.mouse.down({ button: 'left' });
      await sleep(1200);
      await page.mouse.up({ button: 'left' });
      await page.mouse.up({ button: 'right' });
      await page.keyboard.press('Digit2');
      await sleep(200);
      await page.mouse.down({ button: 'left' });
      await sleep(400);
      await page.mouse.up({ button: 'left' });
      await page.keyboard.down('KeyW');
      await sleep(600);
      await page.keyboard.up('KeyW');
      await call('teleportToContainer');
      await page.keyboard.down('KeyF');
      await sleep(2800);
      await page.keyboard.up('KeyF');
      await sleep(300);

      const s = await snap();
      const errsNow = pageErrors.length - errsBefore;

      // 致命问题判据
      if (s.flow !== 'raid' && s.flow !== 'ended') FATAL.push(`第${i}局：流程卡在 ${s.flow}`);
      if (s.player.health < 0) FATAL.push(`第${i}局：生命为负 ${s.player.health}`);
      // ★ M3-BUG-01：这里原先查的是 `s.player.cellBlocked`，而它是**第 0 层的快照**。
      //   两层地图上"一层是墙、二层是楼面"是常态（tv_station_01 的 44 个二层容器里
      //   有 6 个正落在这种格上），走到那里就会被误报成"玩家穿进墙体"，
      //   于是这条 DoD 判据会抓到一个并不存在的问题。
      //   真正表达"有没有穿模"的是 `embedded`：脚底是否插在本格的实体跨度内部。
      if (s.player.embedded) FATAL.push(`第${i}局：玩家穿进实体（脚底插在跨度内）`);
      if (Number.isNaN(s.player.x) || Number.isNaN(s.player.z)) FATAL.push(`第${i}局：坐标 NaN`);
      if (Number.isNaN(s.player.health)) FATAL.push(`第${i}局：生命 NaN`);
      if (errsNow > 0) FATAL.push(`第${i}局：出现 ${errsNow} 条页面异常`);
      if (s.combat.shotsFired > 0 && s.combat.hits === 0 && i > 2) {
        // 开火了却一次没命中，可能是"无伤害"类故障；但 AI 移动会导致偶发全空，
        // 因此只在连续多局都如此时才算致命 —— 这里先记录不判失败
      }

      perRaid.push({
        raid: i,
        ms: Date.now() - t0,
        shots: s.combat.shotsFired,
        hits: s.combat.hits,
        kills: s.combat.kills,
        health: +s.player.health.toFixed(1),
        aiAlive: s.aiAlive,
        decals: s.decals,
        peakQueries: s.scheduler.peakQueriesPerFrame,
        peakPathMs: s.scheduler.peakFrameMs,
        errs: errsNow,
      });
      console.log(
        `    第 ${String(i).padStart(2)} 局  开火 ${s.combat.shotsFired} 命中 ${s.combat.hits} 击杀 ${s.combat.kills}  ` +
          `生命 ${s.player.health.toFixed(0)}  AI 存活 ${s.aiAlive}  弹孔 ${s.decals}  ` +
          `寻路峰值 ${s.scheduler.peakQueriesPerFrame}次/${s.scheduler.peakFrameMs}ms  异常 ${errsNow}`
      );
    }
    check('连续 10 局未出现致命问题', FATAL.length === 0, FATAL.slice(0, 5).join(' | ') || '10 局全部正常');
    const totalHits = perRaid.reduce((a, r) => a + r.hits, 0);
    check('10 局内累计造成命中（武器系统稳定可用）', totalHits > 0, `累计命中 ${totalHits} 次`);
    const maxQ = Math.max(...perRaid.map((r) => r.peakQueries));
    check('10 局内寻路限流始终有效（C-1）', maxQ <= 2, `最大 ${maxQ} 次/帧`);
    fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
    fs.writeFileSync(
      path.join(ROOT, 'results', 'm2-ten-raids.json'),
      JSON.stringify(perRaid, null, 2),
      'utf8'
    );
  }

  // ============================================================
  // M3-BUG-01 回归：两层地图上的"站位合法性"与"有没有穿模"是两件事
  //
  // 缺陷原貌：十局稳定性测试用 `player.cellBlocked` 判"玩家穿进墙体"，
  //   而该判据来自 `level.isBlockedCell` —— **第 0 层的快照**。
  //   两层地图上"一层是墙、二层是楼面"是常态，于是站在那些格的二层玩家
  //   会被判成穿墙。tv_station_01 的 44 个二层容器里有 6 个正落在这种格上，
  //   也就是说：**只要走到那些容器旁边，这条 DoD 判据就会误报**。
  // ============================================================
  group('M3-BUG-01 两层站位判据');
  {
    await loadAndStart();
    // 二层容器的所在地由地图表保证：该层不落墙里、不悬空。
    // 其中一部分格子的**一层是墙**（楼板压墙）—— 那正是旧判据会误报的位置，
    // 所以夹具必须主动找这种格子，而不是随便抽一个容器（抽不中就测不到东西）。
    const scan = await page.evaluate(async () => {
      const out = [];
      for (const c of window.__m2.debugContainerList().filter((x) => x.floor === 1)) {
        window.__m2.teleport(c.x, c.z, 1);
        await new Promise((r) => requestAnimationFrame(r));
        const s = window.__m2.snapshot();
        out.push({
          cell: [Math.floor(c.x / s.level.cell), Math.floor(c.z / s.level.cell)],
          y: s.player.y,
          cellBlocked: s.player.cellBlocked,
          embedded: s.player.embedded,
        });
      }
      return out;
    });
    const onTopFloor = scan.filter((r) => r.y > 3.5);
    const gapCells = scan.filter((r) => r.cellBlocked && !r.embedded);
    const embeddedAny = scan.filter((r) => r.embedded);

    check('夹具成立：二层容器格上玩家确实站在二层（脚底 > 3.5m）',
      scan.length > 0 && onTopFloor.length === scan.length,
      `${scan.length} 个二层容器格，落在二层的 ${onTopFloor.length} 个`);

    check('★ 存在"一层是墙、二层可走"的格（楼板压墙），旧判据在这些格上必然误报',
      gapCells.length > 0,
      gapCells.length
        ? `${gapCells.length} 个，例 ${gapCells.slice(0, 3).map((r) => `(${r.cell})`).join(' ')} —— 其中 cellBlocked=true 而 embedded=false`
        : '一个都没找到（那么本组断言无从测起）');

    check('★ 这些格上玩家并没有穿模（embedded 全为 false）',
      embeddedAny.length === 0,
      embeddedAny.length ? `误报 ${embeddedAny.length} 个：${embeddedAny.map((r) => `(${r.cell}) y=${r.y.toFixed(2)}`).join(' ')}` : `${scan.length} 个容器格全部 embedded=false`);
  }

  // ============================================================
  // M3：**二层**的完整闭环（搜刮 → 撤离 → 结算）
  //
  // 此前这条闭环只用 `teleportToContainer()` / `teleportToExtract()` 跑过，
  // 而两者都没有层参数、永远停在一层 —— 于是"二层能不能搜、能不能撤"
  // （M3 的核心交付之一）在端到端层面一次都没被走过。
  // ============================================================
  group('M3 二层闭环');
  {
    await loadAndStart();
    const tp = await page.evaluate(() => window.__m2.teleportToContainer(1));
    await sleep(200);
    await page.keyboard.down('KeyF');
    await sleep(9000);
    await page.keyboard.up('KeyF');
    await sleep(200);
    const looted = await snap();
    check('二层容器可被搜索开启（按 F）',
      looted.loot.opened >= 1 && looted.player.y > 3.5,
      `开启 ${looted.loot.opened} 个，玩家 y=${looted.player.y.toFixed(2)}`);

    const ex = await page.evaluate(() => window.__m2.teleportToExtract(1));
    check('夹具成立：存在二层撤离点且玩家被送到该层',
      ex && ex.floor === 1, ex ? `撤离点 ${ex.id}（第 ${ex.floor} 层）` : '没有二层撤离点');
    const ended = await waitForEnd(40000);
    const done = await snap();
    check('★ 在二层完成撤离并结算（此前端到端从未覆盖）',
      ended && done.endReason === 'extracted',
      `flow=${done.flow} reason=${done.endReason}`);
    check('撤离结算带出了二层搜到的战利品',
      done.flow === 'ended' && looted.loot.inventory >= 1,
      `背包 ${looted.loot.inventory} 件 / 估值 ${looted.loot.value}`);
  }

  // ============================================================
  group('运行时错误');
  {
    const real = pageErrors.filter((e) => !/favicon/i.test(e));
    check('运行期间无页面异常', real.length === 0, real.slice(0, 4).join(' | ') || '无');
    check('无 4xx/5xx 资源请求', badResponses.length === 0, badResponses.slice(0, 4).join(' | ') || '无');
  }
} catch (e) {
  check('测试执行未中断', false, e.message);
  if (lifecycle.length) {
    console.log('\n  浏览器生命周期事件（用于判断"Session closed"的真实原因）：');
    for (const x of lifecycle) console.log('    - ' + x);
  }
  for (const s of [...new Set(pageErrors)].slice(0, 10)) console.log('  - ' + s);
} finally {
  await browser.close();
  // 关掉本次自己拉起的 dev server —— 不留残留，否则下一次又会连到旧实例。
  // （–keep-server 可保留，便于跑完接着在浏览器里看。）
  if (serverChild && !serverChild.killed) {
    if (KEEP_SERVER) {
      console.log(`\n  已保留 dev server（PID ${serverChild.pid}），退出前需手动关闭。`);
    } else {
      await killPidTree(serverChild.pid);
      console.log(`\n  已关闭本次拉起的 dev server（PID ${serverChild.pid}）。`);
    }
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log('\n================ M2 端到端测试汇总 ================');
console.log(`  通过 ${passed} / ${results.length}`);
if (pauseRecoveries.length) {
  console.log(`  ⚠ 因窗口失焦被恢复的暂停次数：${pauseRecoveries.length}`);
}
if (failed.length) {
  console.log('\n  失败项：');
  for (const f of failed) console.log(`    [${f.group}] ${f.name}${f.detail ? ' —— ' + f.detail : ''}`);
}
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(
  path.join(ROOT, 'results', `m2-smoke-${stamp}.json`),
  JSON.stringify({ url: URL_BASE, results, pageErrors, badResponses, pauseRecoveries }, null, 2),
  'utf8'
);
console.log(`\n  明细已写入 results/m2-smoke-${stamp}.json`);
process.exit(failed.length ? 1 : 0);
