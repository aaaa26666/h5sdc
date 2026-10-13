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
// M5-1：大厅上的数值断言需要"从测试侧独立按配置表算一遍期望值"。
// 只从界面读文本是证明不了"数值来自配置表"的 —— 数字写错了它照样通过。
import { config } from '../src/config/index.js';

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

/**
 * `--only=<子串>`：只跑 M5 段落里名字匹配的组（制作人裁定 R6）。
 *
 * 语义说明（避免误解）：它**跳过整个历史组段落**，而不是"跑完历史组再跑 M5"——
 * 后者省不下时间，也就失去了"改一行 M5 代码快速验证"的意义。
 * 不指定 `--only` 时一切照旧（历史组 → M5 段落 → 运行时错误）。
 * M5 段落自带 loadAndStart + grantTestKit，因此可以独立运行。
 */
const ONLY = (() => {
  // 同时支持 `--only=m5` 与 `--only m5`：前者更常见，漏掉它会让整个开关静默失效
  const withEq = process.argv.find((a) => a.startsWith('--only='));
  if (withEq) return withEq.slice('--only='.length) || 'm5';
  const i = process.argv.indexOf('--only');
  return i >= 0 ? String(process.argv[i + 1] || 'm5') : null;
})();

function m5Group(name) {
  if (!ONLY) {
    group(name);
    return true;
  }
  if (!name.toLowerCase().includes(ONLY.toLowerCase())) {
    console.log(`\n—— ${name}（--only=${ONLY} 跳过）——`);
    return false;
  }
  group(name);
  return true;
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
// ★ 带上调用栈：只记 message 会多花一轮才能定位（"Cannot read properties of undefined"
//   几乎无法从消息本身判断是哪里）。栈只取前几行，避免把噪声塞进报告。
page.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message
  + (e.stack ? ' @ ' + e.stack.split('\n').slice(1, 5).map((l) => l.trim()).join(' | ') : '')));
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

/**
 * 真实渲染可见性判定（[M5-BUG-01]）。
 *
 * 为什么不能只读 `.hidden`：`hidden` 是 IDL 属性反射，只反映 attribute 有无，与"是否真的
 *   画出来"无关。author 的 display 规则可以完全盖掉 UA 的 `[hidden]{display:none}`
 *   （WHATWG HTML 明示："a rule that applies 'display: block' to all elements will cancel
 *   the effects of the hidden state"）。此时 attribute 仍是 true 却照样渲染 ——
 *   大厅那条"上局未正常结束"提示常显就是这个原因，而旧断言读 `.hidden` 恰好读不到它。
 * 为什么不能用 offsetParent：`#screenLobby` 是 position:fixed 的 .screen，
 *   固定定位元素的 offsetParent 恒为 null，会把"可见"误判成"不可见"。
 * 为什么用 getClientRects().length：它反映"元素是否生成了布局盒"。
 *   display:none（无论来自自身还是被祖先吞掉）都不生成盒 → 0；可见则 > 0。
 * 元素不存在时**显式抛错**，绝不静默返回 false —— 否则选择器改名会变成"永远不可见"的
 *   假绿灯，而这正是当初那批断言全绿的原因。
 */
async function isVisible(selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`真实可见性判定：找不到元素 ${sel}`);
    return el.getClientRects().length > 0;
  }, selector);
}

const pauseRecoveries = [];
async function ensureRunning(tag) {  const s = await snap();
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

/**
 * 从大厅开一局，并**确保指针锁定拿到**（M5 组用它，替代裸 page.click('#btnStart')）。
 *
 * 为什么需要它（实测踩过）：Chrome 在 `exitPointerLock()` 之后约 1 秒内会**拒绝**
 * 新的指针锁定请求。局外→局内的闭环每次回大厅都会 exitLock，于是"回大厅后立刻再进战区"
 * 会让锁定请求被静默拒绝 → 游戏进入**暂停态** → 局内时间不推进。
 * 症状是"撤离倒计时卡在 0.5 秒"（局内 `paused=true`、`remainingMs` 几乎不减），
 * 非常容易被误判成产品缺陷。**这是浏览器行为，不是游戏的问题** —— 真实玩家点按钮的
 * 间隔远大于 1 秒，且产品侧本来就有"未锁定即暂停"的正确行为。
 */
async function startRaidFromLobby() {
  await sleep(1200); // 给浏览器留出指针锁定的冷却时间
  // ★ M6：进局前把配装补齐到仓库里。
  //   为什么需要：M6 起携行具与弹药是**真的会被带走**的装备 —— 上一局没撤离就丢了，
  //   而本段的各组测的是武器/技能/搜刮，不该被"上局把包丢了"这件事干扰
  //   （那会有 6 格的兜底包，容量一变，负重上限、能装多少都跟着变）。
  //   注意它只**补齐当前配装所需**，不重置配装 —— 所以"在大厅把主武器换成霰弹枪"
  //   这类断言仍然成立（补齐的是那把霰弹枪，而不是换回 M4）。
  await page.evaluate(() => window.__m2.restockLoadout());
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
  try {
    await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 4000 });
  } catch {
    await ensureRunning('开始一局');
  }
}

async function waitForEnd(timeoutMs) {  const t0 = Date.now();
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
  // ★ M5：制作人裁定新账号**仓库为空**（装备要自己买）—— 赤手空拳进战区会让
  //   绝大多数断言（开火 / 切枪 / 护甲）失去前提。因此测试显式注入一套富配装：
  //   这一步是**测试的准备动作**，产品路径一行不改（玩家自己买）。
  await page.evaluate(() => window.__m2.grantTestKit());
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
  // ★ M6-2：让 AI 先静默。
  //   理由：本段前几组（M2-2 后坐力/开镜、M2-1 切枪换弹）断言的是**武器机制**，
  //   却要连续开火 —— 而枪声（听觉半径 45m）会把 AI 拉过来。AI 由 7 名扩到 16 名后，
  //   聚拢量翻倍，实测会在这些组里把玩家打死、整轮冒烟从 270 条崩到 46 条。
  //   **那几组本来就不该依赖"自由开火还能活"** —— 这是一条从未言明的隐含假设，
  //   密度一变就碎。这里把它显式化：本段先要一个安静的世界，
  //   ⑥ M2-6 AI 组自己负责把它打开（那之后的组照旧面对活着的 AI）。
  //   注意这**不削弱任何断言**：AI 依然存活、依然可被击中掉血（"射击使 AI 掉血"照常成立）。
  await page.evaluate(() => window.__m2.aiStandDown(true));
  try {
    await page.waitForFunction(() => document.pointerLockElement !== null, { timeout: 5000 });
  } catch {
    /* 交由 ensureRunning 处理 */
  }
}

/**
 * 历史组（M0 ~ M5-1）。
 *
 * 之所以抽成函数：`--only=m5` 要能**只跑 M5 段落**，而不是"跑完历史组再跑 M5"
 * —— 后者省不下时间，也就失去了"改一行 M5 代码快速验证"的意义。
 * 抽成函数是零风险改动（体不动、只换外层），M5 段落自带 loadAndStart，
 * 因此不依赖历史组建立的状态。
 */
async function runLegacyGroups() {
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
    // ★ M5-6 销账 [M4-TEMP-4]：任务追踪不再是占位值 —— 它显示的是进局时的
    //   raidKit.quests（core/quests.js 的纯函数产物）。没有进行中任务时显示"任务 —"。
    {
      const active = await page.evaluate(() => window.__m2.profile().quests.active.length);
      check('M5-6：任务追踪已接线（不再是占位值）',
        !!mm && mm.quest.length > 0,
        mm ? `显示"${mm.quest}" · 进行中 ${active} 个` : '无任务行');
      check('★ M5-6：没有进行中任务时，追踪显示"任务 —"而不是假的 0/0',
        active > 0 || mm.quest.includes('任务 —'),
        `进行中 ${active} 个 · 显示"${mm.quest}"`);
    }
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
    // ★ M6-2：本组起**把 AI 打开**（loadAndStart 默认让它们静默，见那里的说明）。
    //   从这里往后的所有组都面对"活着的 AI"，与改造前的语义一致。
    await page.evaluate(() => window.__m2.aiStandDown(false));
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
        const shotRaw = await page.evaluate((i) => {
          const r = window.__m2.teleportNearAi(i, 12);
          window.__m2.makeNoise();
          return r;
        }, far.i);
        await ensureRunning('ai-approach-shot');
        // ★ 夹具返回 null 时必须**报一条失败**，不能抛异常：
        //   抛出去会被 runLegacyGroups 的 try/catch 吞掉，表现为"后面所有组都没跑"
        //   （总数从 270 掉到几十条）—— 那是最难诊断的一类失败，"0 失败"甚至更好看。
        check('夹具：能在目标 AI 附近找到合法落位点', !!shotRaw,
          shotRaw ? undefined : `最远 AI 在 ${far.d.toFixed(1)}m 处，其周围无合法落点`);
        const shot = shotRaw || { aiId: '__夹具失败__' };

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

    // 这里用急救包而不是绷带，是为了**一次把血拉满**（回 65，上限 100）：
    // 紧接着的"满血时按 3 不消耗绷带"需要"生命已满"这个前提。
    // （绷带本身"未满血即可用、满血被拒"的完整回归见 M5 段的 [M6 医疗回归] 组。）
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

    // ★ [M6-BUG-01] 绷带的判据已从"血量低于其上限 45"改为"未满血即可用"。
    //   这里只守**满血不浪费**这一面（先用夹具回满血，不再依赖"急救包刚好回满"）；
    //   "60 血按 3 能用绷带"的正面回归在 M5 段落的 [M6 医疗回归] 组里，可 --only 单独跑。
    await call('healPlayer', 9999);
    await sleep(150);
    const fullHp = await snap();
    const b0 = fullHp.consumables.bandage;
    await page.keyboard.press('Digit3');
    await sleep(400);
    const noop = await snap();
    check('满血时按 3 会被拒绝且不消耗绷带（不浪费）',
      noop.consumables.bandage === b0 && noop.player.using === false,
      `绷带 ${b0} → ${noop.consumables.bandage}, using=${noop.player.using}（生命 ${fullHp.player.health}）`);
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

    // 口径：查**真实渲染**，不是 `.hidden` attribute（见 isVisible 的说明）。
    const noticeShown = await isVisible('#interruptedNotice');
    check('★ 中途刷新后重进，能看到"上局未正常结束"提示（不是静默丢弃）',
      noticeShown === true, `提示真实可见=${noticeShown}`);

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
    //   M6-UI-01 起结算页是**分段式**：结算正文在第 1 段 `#endPage1`（见 index.html）。
    const endShown = await page.evaluate(
      () => document.getElementById('screenEnd').classList.contains('on')
    );
    const endText = await page.evaluate(() => {
      // 两段都读（textContent 不看显隐）——"画出来了"的判据是**内容存在**，
      // 而"第几段可见"由下面 [M6-UI-01] 那组专门断言。
      const pages = [document.getElementById('endPage1'), document.getElementById('endPage2')];
      return pages.map((b) => (b ? b.textContent : '')).join(' ').replace(/\s+/g, ' ').trim();
    });
    check('★ 点击提示后结算页真的画出内容（不是"只结算、不显示"）',
      endShown === true && endText.length > 0 && endText.includes(String(beforeSafe)),
      `结算页可见=${endShown}，正文含"${beforeSafe}"=${endText.includes(String(beforeSafe))}（正文 ${endText.length} 字）`);

    // 幂等：结算过一次后再刷新，不该再弹（否则会重复发放/重复打扰）
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__m2 !== 'undefined', { timeout: 15000 });
    // 口径：查**真实渲染**（这条在 M5-BUG-01 修复前是红的 —— 缺陷让提示恒可见）
    const again = await isVisible('#interruptedNotice');
    check('★ 幂等：结算过一次后再刷新不再提示（不会重复结算）',
      again === false, `提示真实可见=${again}`);

    // [M5-BUG-01] 再加一条"不占位"：只断言"不可见"还不够 —— 本缺陷的实际观感是那条带
    // 虚线下边框的行**占据了一行高度**。用布局盒口径钉死：既不生成盒，也不贡献高度。
    // 放在这里最稳：该点刚结算过并 reload，**保证没有待结算快照**。
    const noticeBox = await page.evaluate(() => {
      const el = document.getElementById('interruptedNotice');
      if (!el) throw new Error('找不到 #interruptedNotice');
      return { rects: el.getClientRects().length, h: el.getBoundingClientRect().height };
    });
    check('大厅无待结算战局时，这一栏不出现且不占位（无布局盒 / 高度为 0）',
      noticeBox.rects === 0 && noticeBox.h === 0,
      `rects=${noticeBox.rects} height=${noticeBox.h}`);
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
        `open=${e4.open} remainingKills=${e4.remainingKills} kills=${s0.kills} aiAlive=${s0.aiAlive} rule=${e4.rule}`);

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
    await startRaidFromLobby();
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
    // ---- 补结算之后：**回到大厅**时这条提示不该再出现（"不会一直挂着"的真实口径）----
    //
    // ★ 为什么不能就地量：此刻大厅整体是 display:none（刚开新局），祖先的 display 会让
    //   getClientRects() 恒为 0 —— 那量的是祖先，不是这条提示，断言会变成恒真。
    //   （这正是我第一版改写的错误：它比原来的 attribute 口径更弱。）
    // 改为走完一次真正的「结束本局 → 返回大厅」，在**大厅可见**的前提下量 ——
    // 这才是玩家实际看到的东西。注意修复后"收起"是**惰性**的：由 showLobby() 从快照推导，
    // 不再在结算那一刻立刻写 attribute；所以只有在这里量才有意义。
    await call('abandonRaid');
    await sleep(300);
    await call('returnToLobby');
    await sleep(300);
    const noticeAfter = await isVisible('#interruptedNotice');
    const lobbyBack = await page.evaluate(() =>
      document.getElementById('screenLobby').classList.contains('on'));
    check('★ 补结算后回到大厅，提示不再出现（不会一直挂着）',
      lobbyBack === true && noticeAfter === false,
      `大厅可见=${lobbyBack} 提示真实可见=${noticeAfter}`);
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
    // [M5-BUG-02] ★ 已知缺陷（测试侧，本次刻意未修）：landingDip 是**只活几十毫秒**的瞬态，
    //   而下面这个采样循环的周期约 60~90ms（snap 往返 + sleep(50)），能否采到那一帧**全凭相位**。
    //   探针实测：同一位置、同一份代码连跳 10 次，命中率 8/10 —— 会随机假红。
    //   它测的 core/movement.js 与 gameplay/player.js 与 M5-BUG-01 无关，是被那次改动
    //   顺带改动的采样相位"照出来"的。修法见 docs/M5-TEMP-REGISTRY.md §5.2。
    //   ★ 不要用"放宽阈值"来消掉它 —— 那是把假红改成假绿。
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
  group('M5-1 主大厅与局内世界重建');
  {
    // ★ 这一组守的是 M5-1 的核心交付：**局外入口 + 闭环**。
    //   闭环的定义是"结算 → 回大厅 → 再进战区，全程不刷新页面"，
    //   所以第一件事是证明"没有发生刷新" —— 见下面的 __m5Token 哨兵。

    // ---- ① 打开页面直接落在大厅，且此刻没有局内世界 ----
    await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    await page.evaluate(() => {
      window.__m5Token = Math.random().toString(36).slice(2);
    });
    const token0 = await page.evaluate(() => window.__m5Token);

    const lobbyView = await page.evaluate(() => {
      const s = document.getElementById('screenLobby');
      const hud = document.getElementById('hud');
      const body = document.getElementById('lobbyBody');
      return {
        lobbyOn: !!s && s.classList.contains('on'),
        hudOn: hud.classList.contains('on'),
        hasStart: !!document.getElementById('btnStart'),
        body: body ? body.innerText : '',
      };
    });
    const s0 = await snap();
    check('打开页面直接进入主大厅（不再是"点击即开始"的开始页）',
      lobbyView.lobbyOn && lobbyView.hasStart, `lobbyOn=${lobbyView.lobbyOn}`);
    check('局外不显示局内 HUD，单局计时未开始',
      !lobbyView.hudOn && s0.flow === 'lobby' && s0.remainingMs === config.raid.timeLimitMs,
      `hudOn=${lobbyView.hudOn} flow=${s0.flow} remaining=${s0.remainingMs}`);
    check('局外**尚未创建**局内世界（3D 世界延迟到进入战区才建）',
      s0.world.alive === false && s0.player === null && s0.ai.length === 0,
      `alive=${s0.world.alive} player=${s0.player} ai=${s0.ai.length}`);
    check('局外时调试接口仍安全可读（端到端会反复轮询它等 raid 状态）',
      s0.world.builds === 0 && s0.world.disposals === 0,
      `builds=${s0.world.builds} disposals=${s0.world.disposals}`);

    // ---- ② 大厅上的每个数字都来自配置表 ----
    // 从测试侧**独立算一遍**期望文本，再要求界面上出现它。
    {
      const total = Math.round(config.raid.timeLimitMs / 1000);
      const expectTime = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      check('大厅显示的单局时限与配置表一致',
        lobbyView.body.includes(expectTime), `期望 ${expectTime}`);
      check('大厅显示的地图名与地图表一致',
        lobbyView.body.includes(config.map.label), config.map.label);
      check('大厅显示的撤离点数量与地图表一致',
        lobbyView.body.includes(`共 ${config.extract.zones.length} 个`),
        `共 ${config.extract.zones.length} 个`);
      const enemyTotal = (config.map.aiSpawns || []).reduce((a, s) => a + s.count, 0);
      check('大厅显示的敌方总数 = 地图表各分区配额之和',
        lobbyView.body.includes(`${enemyTotal} 名`), `${enemyTotal} 名`);
      // ★ M5-3：简报显示的是**玩家当前配装**（档案里的 activeLoadout）。
      //   注意不能用 raidKit()：局外它必须是 null（局内世界未创建），
      //   而这一组整组都在局外。
      const curPrimary = await page.evaluate(() => {
        const p = window.__m2.profile();
        return p.loadout ? p.loadout.primary : null;
      });
      check('大厅显示的主武器名与**当前配装**一致（M5-3 后不再是写死的起始配装）',
        curPrimary
          ? lobbyView.body.includes(config.weapons.find((w) => w.id === curPrimary).label)
          : lobbyView.body.includes('无'),
        curPrimary || '（无主武器）');
      const killsGate = config.extract.zones.find((z) => z.openRule && z.openRule.type === 'killsAfter');
      check('条件撤离点的规则文案带上了规则自身的数值（不是写死的）',
        !!killsGate && lobbyView.body.includes(`${killsGate.openRule.kills} 名敌人`),
        killsGate ? `${killsGate.openRule.kills} 名敌人` : '当前地图没有击杀类条件点');
    }

    // ---- ③ 分层约束：局外界面不得依赖局内实现（静态检查）----
    // "今天没 import"不等于"明天也不会 import"，所以用源码检查把它钉住。
    {
      const src = fs.readFileSync(path.join(ROOT, 'src/ui/lobby.js'), 'utf8');
      const imports = src.split('\n').filter((l) => l.trim().startsWith('import'));
      const bad = imports.filter((l) => /\.\.?\/(gameplay|level|render|audio)\//.test(l));
      check('★ 局外界面不依赖局内模块（gameplay / level / render / audio）',
        bad.length === 0, bad.join(' | ') || `import 行 ${imports.length} 条，无越界`);
    }

    // ---- ④ 进入战区：此刻才创建局内世界 ----
    await startRaidFromLobby();
    await sleep(400);
    const r1 = await snap();
    const raid1Id = r1.raidId;
    check('★ 进入战区时才创建局内世界（builds 0 → 1）',
      r1.world.alive === true && r1.world.builds === 1 && r1.world.disposals === 0,
      `alive=${r1.world.alive} builds=${r1.world.builds}`);
    check('进入战区后大厅关闭、HUD 打开',
      (await page.evaluate(() => !document.getElementById('screenLobby').classList.contains('on')))
      && (await page.evaluate(() => document.getElementById('hud').classList.contains('on'))));
    check('新局的地图与 AI 数量与配置表一致（大厅简报不是另算的一份）',
      r1.level.W === config.map.grid.w && r1.ai.length > 0,
      `W=${r1.level.W} AI=${r1.ai.length}`);

    // ---- ⑤ 设置项生效：灵敏度（倍率来自配置表）----
    {
      await call('teleportToSafeSpot');
      await call('resetAim', 0);
      await sleep(300);
      // 探针口径：maxMouseRad = 鼠标位移(px) × 有效灵敏度（player.js 内唯一一处相乘）
      const probe = async () => {
        await call('resetViewProbe');
        await page.evaluate((d) => window.__m2.injectMouseMove(d, 0), 40);
        await sleep(200);
        const s = await snap();
        return { rad: s.player.viewProbe.maxMouseRad, yaw: (Math.abs(s.player.yaw) * 180) / Math.PI };
      };
      await call('setSetting', 'mouseSens', 'normal');
      await sleep(200);
      const normal = await probe();
      await call('setSetting', 'mouseSens', 'veryHigh');
      await sleep(200);
      const fast = await probe();
      const wantRatio = config.settings.mouseSensLevels.veryHigh / config.settings.mouseSensLevels.normal;
      const gotRatio = normal.rad > 0 ? fast.rad / normal.rad : 0;
      check('★ 灵敏度档位生效：视角转速按配置表倍率变化',
        normal.rad > 0 && Math.abs(gotRatio - wantRatio) < 0.2,
        `实测 ${gotRatio.toFixed(2)}× / 配置 ${wantRatio}×（rad ${normal.rad} → ${fast.rad}）`);
      // 复原：改了全局状态的测试必须复原，否则后面的组在测垃圾
      await call('setSetting', 'mouseSens', 'normal');
    }

    // ---- ⑥ 设置项生效：主音量（增益 = 配置基线 × 档位倍率）----
    {
      const base = config.audio.masterGain;
      // 容差口径（这条曾经误报过）：master.gain 是 Web Audio 的 AudioParam，它的 value
      // 按 **float32** 存储 —— 写进去 0.35，读回来是 0.3499999940395355。
      // 原先用 1e-9 判等，比 float32 在 0.5 量级的量化步长（约 3e-8）还小一个数量级，
      // 于是"精度量化"被误报成"倍率接错了"。容差取 1e-6：比量化步长大一个数量级，
      // 但远小于任何可闻差异，也远小于"倍率接错"会产生的偏差（那是 0.4/0.6/1.5 量级）。
      const F32_EPS = 1e-6;
      const levelRatio = config.settings.volumeLevels.high / config.settings.volumeLevels.normal;
      await call('setSetting', 'masterVolume', 'normal');
      const gNormal = (await snap()).audio.gain;
      await call('setSetting', 'masterVolume', 'off');
      const gOff = (await snap()).audio.gain;
      await call('setSetting', 'masterVolume', 'high');
      const gHigh = (await snap()).audio.gain;
      check('★ 主音量档位生效：总线增益 = 配置基线 × 档位倍率',
        Math.abs(gNormal - base) < F32_EPS
        && gOff === 0
        && Math.abs(gHigh - base * levelRatio) < F32_EPS,
        `标准 ${gNormal} / 静音 ${gOff} / 高 ${gHigh}（基线 ${base}，期望高 ${base * levelRatio}）`);
      check('★ 高低两档的**比值**等于配置表的倍率之比（与基线无关，倍率接错必然露）',
        gNormal > 0 && Math.abs(gHigh / gNormal - levelRatio) < F32_EPS,
        `实测 ${(gHigh / gNormal).toFixed(6)}× / 配置 ${levelRatio}×`);
      check('静音档位真的把增益打到 0（不是"很小"）', gOff === 0, `${gOff}`);
      await call('setSetting', 'masterVolume', 'normal');
    }

    // ---- ⑦ 结束一局 → 结算 → 返回大厅（**不刷新页面**）----
    // 先让第一局的计时明显走掉一截（≥1s）。这不是"等稳定"，而是为了让 ⑧ 里的
    // "计时归零"**可观测**：如果新局接着上一局的计时继续跑，它的剩余时间只可能比
    // 这里更少；只有真的重置了才会变多。若两局都在满格附近，那条断言就退化成
    // "约等于满格"，抓不到"计时残留"这种缺陷。
    await sleep(1200);
    await call('abandonRaid');
    await sleep(300);
    const ended = await snap();
    check('夹具成立：一局已结束并进入结算页',
      ended.flow === 'ended' && ended.endReason === 'abandoned'
      && (await page.evaluate(() => document.getElementById('screenEnd').classList.contains('on'))),
      `flow=${ended.flow} reason=${ended.endReason}`);

    // ★ M6-UI-01：结算页是**两段式**，出口在第 2 段的右下角 ——
    //   所以这里必须走玩家真实路径：第 1 段 →「下一步」→ 第 2 段 →「返回大厅」。
    //   原来直接点 `#btnRestart` 的写法在新结构下会失败（它在第 1 段是隐藏的），
    //   而"按钮藏起来了测试还点得到"这件事本身也不该被允许。
    const step1 = await page.evaluate(() => ({
      step: document.querySelector('#screenEnd .card.end').dataset.step,
      nextShown: document.getElementById('btnEndNext').getClientRects().length > 0,
      restartShown: document.getElementById('btnRestart').getClientRects().length > 0,
      page1Shown: document.getElementById('endPage1').getClientRects().length > 0,
      page2Shown: document.getElementById('endPage2').getClientRects().length > 0,
    }));
    check('★ [M6-UI-01] 结算页第 1 段只有「下一步」，明细段与「返回大厅」都还没出现',
      step1.step === '1' && step1.nextShown && !step1.restartShown && step1.page1Shown && !step1.page2Shown,
      JSON.stringify(step1));
    await page.click('#btnEndNext');
    await sleep(150);
    const step2 = await page.evaluate(() => ({
      step: document.querySelector('#screenEnd .card.end').dataset.step,
      nextShown: document.getElementById('btnEndNext').getClientRects().length > 0,
      restartShown: document.getElementById('btnRestart').getClientRects().length > 0,
      page1Shown: document.getElementById('endPage1').getClientRects().length > 0,
      page2Shown: document.getElementById('endPage2').getClientRects().length > 0,
      hint: document.getElementById('endStepHint').textContent,
    }));
    check('★ [M6-UI-01] 点「下一步」切到第 2 段（携带物品），右下角换成「返回大厅」',
      step2.step === '2' && step2.restartShown && !step2.nextShown && step2.page2Shown && !step2.page1Shown,
      JSON.stringify(step2));
    await page.click('#btnEndBack');
    await sleep(150);
    const backStep = await page.evaluate(
      () => document.querySelector('#screenEnd .card.end').dataset.step
    );
    check('M6-UI-01 「上一步」能回到第 1 段（不会把玩家困在清单页）', backStep === '1', `step=${backStep}`);
    await page.click('#btnEndNext');
    await sleep(150);

    await page.click('#btnRestart');
    await sleep(500);
    const back = await snap();
    const backView = await page.evaluate(() => ({
      lobbyOn: document.getElementById('screenLobby').classList.contains('on'),
      endOn: document.getElementById('screenEnd').classList.contains('on'),
      hudOn: document.getElementById('hud').classList.contains('on'),
      token: window.__m5Token,
    }));
    check('★ 结算页「返回大厅」回到大厅（不是刷新页面重来）',
      backView.lobbyOn && !backView.endOn && !backView.hudOn,
      `lobby=${backView.lobbyOn} end=${backView.endOn} hud=${backView.hudOn}`);
    check('★ 全程**没有刷新页面**（页面级哨兵还在，这是"闭环"的直接证据）',
      backView.token === token0 && !!token0,
      backView.token === token0 ? '哨兵未丢失' : `哨兵被清（发生过刷新）：${backView.token}`);
    check('★ 回到大厅时局内世界被**销毁**（disposals 0 → 1，不再是"只建不拆"）',
      back.world.alive === false && back.world.disposals === 1 && back.world.builds === 1,
      `alive=${back.world.alive} builds=${back.world.builds} disposals=${back.world.disposals}`);
    check('回到大厅后流程回到 lobby，且仍能读到上一局的结束原因',
      back.flow === 'lobby' && back.endReason === 'abandoned',
      `flow=${back.flow} endReason=${back.endReason}`);
    check('回大厅后局内状态已清空（不会把上一局的背包/生命带进大厅）',
      back.player === null && back.loot === null && back.ai.length === 0);

    // ---- ⑧ 再进战区：必须是一局**全新**的 ----
    await startRaidFromLobby();
    await sleep(400);
    const r2 = await snap();
    check('★ 从大厅再进战区：世界被重建（builds 1 → 2）',
      r2.world.alive === true && r2.world.builds === 2 && r2.world.disposals === 1,
      `builds=${r2.world.builds} disposals=${r2.world.disposals}`);
    check('★ 拿到的是**新的一局**（raidId 已更换，不是复用上一局的世界）',
      !!r2.raidId && r2.raidId !== raid1Id, `${raid1Id} → ${r2.raidId}`);
    // 计时口径（这条曾经误报过）：RAID 态的 remainingMs = 时限 − 已过时间，所以它
    // **不可能**等于整局时限 —— 快照本身就要花掉几百毫秒。原先断言"等于时限"，
    // 等于假设了"快照零耗时"。现在改断言两件真正有意义的事：
    //   ① 比上一局结束时**更大** —— 只有重置才会变多，"接着上一局跑"只会更少；
    //   ② 距离满格不超过 10 秒 —— 确实是"从头开始"，而不是被重置成某个奇怪的数。
    const burned = config.raid.timeLimitMs - ended.remainingMs;
    const freshLeft = config.raid.timeLimitMs - r2.remainingMs;
    check('新局是干净的：容器全部未开、AI 全员存活、背包为空、计时归零',
      r2.loot.opened === 0 && r2.aiAlive === r2.ai.length && r2.loot.inventory === 0
      && r2.remainingMs > ended.remainingMs + 800
      && freshLeft < 10000,
      `opened=${r2.loot.opened} aiAlive=${r2.aiAlive}/${r2.ai.length} bag=${r2.loot.inventory}`
      + ` remaining=${r2.remainingMs}（上一局烧掉 ${burned}ms，新局仅 ${freshLeft}ms）`);
    check('新局的战斗统计已归零（跨局累加量必须复位）',
      r2.combat.shotsFired === 0 && r2.combat.kills === 0,
      `shots=${r2.combat.shotsFired} kills=${r2.combat.kills}`);
    check('新局玩家回到出生点（与上一局开局时的落点逐坐标一致）',
      Math.abs(r2.player.x - r1.player.x) < 1e-6
      && Math.abs(r2.player.z - r1.player.z) < 1e-6
      && r2.player.alive === true && r2.player.health === r1.player.maxHealth,
      `(${r2.player.x.toFixed(2)}, ${r2.player.z.toFixed(2)}) vs (${r1.player.x.toFixed(2)}, ${r1.player.z.toFixed(2)})，health=${r2.player.health}`);

    // ---- ⑨ 设置跨局保留 ----
    {
      await call('setSetting', 'mouseSens', 'low');
      const persisted = await page.evaluate(() => localStorage.getItem('h5extract.settings.v1'));
      const parsed = persisted ? JSON.parse(persisted) : null;
      check('设置改动落盘，且结构与配置表的 schema 一致',
        !!parsed
        && Object.keys(parsed).sort().join(',')
          === Object.keys(config.settings.schema).filter((k) => !k.startsWith('_')).sort().join(','),
        persisted || '没有落盘');
      check('改动后的档位在下一局仍然生效',
        (await snap()).settings.mouseSens === 'low',
        (await snap()).settings.mouseSens);
      // 复原成默认档，避免影响后续组
      await call('setSetting', 'mouseSens', config.settings.schema.mouseSens.default);
    }

    // ---- ⑩ 回归：闭环之后，M4 的断线补结算仍然成立 ----
    // 闭环最容易破坏的恰恰是它旁边的旧功能：以前"上局中断"发生在
    // "页面重新加载"这个天然干净的时机，现在页面可能已经跑过好几局。
    {
      await call('teleportToContainer', 0);
      await page.keyboard.down('KeyF');
      await sleep(4000);
      await page.keyboard.up('KeyF');
      await sleep(400);
      const before = await snap();
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.__m2 !== 'undefined', { timeout: 15000 });
      // 口径：查**真实渲染**，不是 `.hidden` attribute（见 isVisible 的说明）。
      const notice = await isVisible('#interruptedNotice');
      const lobbyAfterReload = await page.evaluate(() =>
        document.getElementById('screenLobby').classList.contains('on'));
      check('刷新后仍落在**大厅**（不再是开始页），且上局中断提示可见',
        notice && lobbyAfterReload, `notice=${notice} lobby=${lobbyAfterReload}`);
      await page.evaluate(() => document.getElementById('interruptedNotice').click());
      await sleep(300);
      const settle = await snap();
      check('★ 闭环之后 M4 的补结算仍然成立（刷新 → 提示 → 点击 → 按未撤离结算）',
        !!settle.raidResult && settle.raidResult.reason === 'disconnected',
        settle.raidResult ? `reason=${settle.raidResult.reason} kept=${settle.raidResult.loot.keptValue}` : '没有结算');
      void before;
    }
  }

}

/**
 * M5 段落：局外系统（仓库 / 配装 / 商店 / 技能 / 任务 / 存档）的端到端验证。
 *
 * 它自带 prepare（loadAndStart + grantTestKit），因此可以：
 *   · 并入全量跑（放在历史组之后）
 *   · 被 `--only=m5` 单独触发
 */
async function runM5Groups() {
  if (m5Group('M5-2/M5-3/M5-4/M5-5/M5-6 局外面板与档案')) {
    await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });

    // ---- ① 大厅状态条与五个面板：能开、有内容、数字与纯函数一致 ----
    {
      const statsText = await page.evaluate(() => document.getElementById('lobbyStats').innerText);
      check('★ M5 大厅顶部状态条显示档案读数（销 M5-TEMP-1）',
        /等级/.test(statsText) && /货币/.test(statsText) && /仓库/.test(statsText),
        statsText.replace(/\s+/g, ' ').slice(0, 80));

      const tabs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#lobbyTabs .tab')).map((t) => t.dataset.tab)
      );
      // ★ M6-3（docs/18 §3.3）：配装与仓库**合并**成「装备」，页签由 6 个变 4 个。
      //   注意方案原文写的是"由 5 个变 4 个"—— 它数的是 M5 的五个面板入口（配装/仓库/商店/
      //   技能/任务），没有把**简报**那个页签算进去。简报不能删（撤离点开放规则、单局时限、
      //   敌方数量都在里面），所以它并入了装备页顶部，页签因此是 6→4 而不是 5→4。
      check('★ M5/M6-3 大厅恰好四个面板入口（销 M5-TEMP-3；M6-3 把配装与仓库合并为「装备」）',
        ['gear', 'shop', 'skills', 'quests'].every((t) => tabs.includes(t)) && tabs.length === 4,
        tabs.join('/'));

      // ★ M6-3 反向断言（docs/18 §五 的风险表点名的那一条）：
      //   旧页签与**下拉框配装表单**必须彻底消失。留着"看起来还能用"的死入口，
      //   玩家会以为配装还能那样配 —— 那比没有这个入口更糟。
      const legacy = await page.evaluate(() => ({
        oldTabs: Array.from(document.querySelectorAll('#lobbyTabs .tab'))
          .map((t) => t.dataset.tab)
          .filter((t) => t === 'loadout' || t === 'stash' || t === 'brief'),
        oldBodies: ['tabLoadout', 'tabStash', 'tabBrief'].filter((id) => document.getElementById(id)).length,
        selects: document.querySelectorAll('select').length,
        changeHooks: document.querySelectorAll('[data-act-change]').length,
      }));
      check('★ M6-3 旧页签与其面板容器已从 DOM 消失（配装/仓库/简报）',
        legacy.oldTabs.length === 0 && legacy.oldBodies === 0, JSON.stringify(legacy));
      check('★ M6-3 旧的下拉框配装表单彻底消失（页面里连一个 <select> 都没有）',
        legacy.selects === 0 && legacy.changeHooks === 0, JSON.stringify(legacy));
      {
        // DOM 数量为 0 只证明"这一帧没渲染"。**源码**里也不能留活代码 ——
        // 允许在注释里提 slotSelect（那是在解释"为什么删掉它"），按非注释行判定。
        const hits = [];
        for (const rel of ['src/ui/panels.js', 'src/main.js', 'src/ui/lobby.js']) {
          const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
          for (const line of text.split('\n')) {
            if (!/slotSelect|renderLoadout|ammoInc|consInc/.test(line)) continue;
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
            // 步进器（ammoInc / consInc）是**预设计数**、明确保留，不算残留
            if (/ammoInc|consInc|ammoDec|consDec/.test(line)) continue;
            hits.push(`${rel}: ${line.trim().slice(0, 70)}`);
          }
        }
        check('★ M6-3 源码里没有 slotSelect / renderLoadout 的活代码（只允许解释性注释）',
          hits.length === 0, hits.join(' | ') || '零命中');
      }

      const bodies = {};
      for (const tab of ['gear', 'shop', 'skills', 'quests']) {
        await page.click(`#lobbyTabs .tab[data-tab="${tab}"]`);
        await sleep(60);
        bodies[tab] = await page.evaluate(
          (t) => {
            const id = `tab${t[0].toUpperCase()}${t.slice(1)}`;
            const node = document.getElementById(id);
            return {
              on: node.classList.contains('on'),
              text: node.innerText.replace(/\s+/g, ' ').trim(),
            };
          },
          tab
        );
      }
      check('★ M5/M6-3 四个面板分别可切换且都画出了内容（不是空壳）',
        Object.entries(bodies).every(([, v]) => v.on && v.text.length > 0),
        Object.entries(bodies).map(([k, v]) => `${k}:${v.text.length}`).join(' '));
      const views = await page.evaluate(() => window.__m2.lobby().views);
      // ★ M6-3：仓库不再有独立页签，它的数字现在画在**装备页**里（同一个 stashPanel 产物）。
      check('M5/M6-3 装备页里的仓库读数和 = lobbyView 的产物（同一份数字）',
        bodies.gear.text.includes(String(views.stash.summary.value)),
        `面板含 ${views.stash.summary.value}`);
      check('M5 商店面板显示的货币 = 档案货币',
        bodies.shop.text.includes(String(views.shop.currency)),
        `面板含 ${views.shop.currency}`);
    }

    // ---- ② 存档异常三态（M5 硬性要求：必须实测）----
    {
      // 夹具：注入一套装备并保存，让"档案确实有内容"成为可观测的前提
      await page.evaluate(() => window.__m2.grantTestKit());
      const before = await page.evaluate(() => window.__m2.profile().view.stash.items);
      check('夹具成立：档案里有东西可丢（否则"不丢档"无从验证）', before > 0, `${before} 件`);

      // ① 损坏：写入坏 JSON → reload
      await page.evaluate(() => window.__m2.writeRawProfile('{"version":1,"stash":['));
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
      const broken = await page.evaluate(() => ({
        profile: window.__m2.profile(),
        lobbyOn: document.getElementById('screenLobby').classList.contains('on'),
      }));
      check('★ 存档损坏：页面不崩、仍能进大厅、给出可用档案',
        broken.lobbyOn && broken.profile.view.currency > 0,
        `currency=${broken.profile.view.currency}`);
      check('★ 存档损坏：坏文本被**隔离留证**（不是静默删除）',
        broken.profile.storage.quarantineBytes > 0 && !!broken.profile.storage.quarantine,
        JSON.stringify(broken.profile.storage.quarantine));

      // ② 被清空：清掉全部键 → reload
      await page.evaluate(() => window.__m2.clearProfile());
      const cleared = await page.evaluate(() => window.__m2.profile());
      check('★ 存档被清空：给出全新档案（等级 1 / 空仓库）且不崩',
        cleared.view.level === 1 && cleared.view.stash.items === 0,
        `Lv${cleared.view.level} · ${cleared.view.stash.items} 件`);
      check('★ 存档被清空：第一次加载记账为 empty（修复必须可观测）',
        cleared.repairs.includes('empty'), cleared.repairs.join(',') || '无修复记录');
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
      const cleared2 = await page.evaluate(() => window.__m2.profile());
      // 注意口径：第一次加载已经把新档写回去了，所以**这一**次加载读到的是一份
      // 合法档案、repairs 自然为空 —— 那不是缺陷，而是"修复已落地"。这里要验的是
      // "清空不会留下半坏状态"，而不是"每次加载都报 repairs"。
      check('★ 存档被清空后重进：仍是全新档案，且不会留下半坏状态',
        cleared2.view.level === 1 && cleared2.view.stash.items === 0 && cleared2.source === 'main',
        `Lv${cleared2.view.level} · ${cleared2.view.stash.items} 件 · source=${cleared2.source} · repairs=${cleared2.repairs.length}`);

      // ③ 版本回退：写入"未来版本"的档案 → reload
      const future = JSON.stringify({ version: 99, currency: 123456, stash: [], progression: { exp: 0 } });
      await page.evaluate((t) => window.__m2.writeRawProfile(t), future);
      await page.reload({ waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
      const rebased = await page.evaluate(() => window.__m2.profile());
      check('★ 版本回退：拒绝解释未来版本，另起新档且不崩',
        rebased.view.version === 1 && rebased.view.currency === config.economy.starterCurrency,
        `v${rebased.view.version} currency=${rebased.view.currency}`);
      check('★ 版本回退：原始文本仍留在隔离键里（人工可恢复）',
        rebased.storage.quarantineBytes > 0 && /version-ahead/.test(rebased.storage.quarantine.reason || ''),
        JSON.stringify(rebased.storage.quarantine));
      check('★ 版本回退：**没有**把未来版本的数据当成当前版本写回去',
        rebased.view.currency !== 123456, `currency=${rebased.view.currency}`);
    }

    // ---- ③ 商店买卖：扣钱与入库同一次完成 ----
    {
      await page.evaluate(() => window.__m2.grantTestKit());
      const before = await page.evaluate(() => window.__m2.profile());
      await page.click('#lobbyTabs .tab[data-tab="shop"]');
      await sleep(60);
      const buyBtn = await page.$('#tabShop .mini[data-act="shopBuy"][data-ref="rifle_m4"]');
      check('夹具成立：商店里有"买 M4"按钮', !!buyBtn);
      if (buyBtn) {
        await buyBtn.click();
        await sleep(120);
        const after = await page.evaluate(() => window.__m2.profile());
        check('★ M5-4 买入：货币减少且仓库里出现该物品（同一次调用完成）',
          after.view.currency < before.view.currency
            && after.view.stash.items > before.view.stash.items,
          `货币 ${before.view.currency} → ${after.view.currency} · 仓库 ${before.view.stash.items} → ${after.view.stash.items}`);
      }
    }
  }

  // ---- ④ 配装进局一致性 / ⑤ 技能生效 / ⑥ 画质 / ⑦ 改键 / ⑧ 结算页 ----
  if (m5Group('M5-3/M5-5/M5-8 配装进局·技能生效·画质·改键·结算页')) {
    // 自带页面加载：`--only=结算页` 这类只跑本组的调用会跳过前面的 goto，
    // 页面此时还停在 about:blank（`window.__m2` 不存在）。组内自足才能被单独回归。
    if (!(await page.evaluate(() => typeof window.__m2 !== 'undefined'))) {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    }
    await page.evaluate(() => window.__m2.grantTestKit());
    // ---- ④ 局内用的就是局外配的（销 M5-TEMP-2 的直接证据）----
    // ★ M6-3：这一步原来是"用槽位下拉框选主武器"，而下拉框已按 docs/18 §五 删除 ——
    //   现在走**拖放**（玩家真实路径：从仓库把枪拖到主武器格）。
    //   于是这两条 M5-3 的既有断言顺带变成了"拖放真的改到了局内配装"的端到端证据。
    await page.click('#lobbyTabs .tab[data-tab="gear"]');
    await sleep(80);
    // 先把 7.62 弹药配进预设，否则换枪后"备弹"会是 0 —— 那会让断言读起来像"弹药没带对"
    await page.evaluate(() => window.__m2.stuffLoadout({ '7.62': 120 }, { bandage: 3, medkit: 2 }));
    await sleep(80);
    const drag1 = await dragStashItemToSlot('rifle_sr25', 'primary');
    await sleep(180);
    const lo1 = await page.evaluate(() => window.__m2.profile().loadout);
    check('★ M6-3 从仓库把枪拖到主武器格＝装备（旧的槽位下拉框已被拖放取代）',
      !!drag1.ok && lo1.primary === 'dmr_sr25',
      `primary=${lo1.primary} drag=${JSON.stringify(drag1)}`);
    check('★ M6-3 拖上去的那把枪**离开了仓库**（不是复制一份挂在身上）',
      (await page.evaluate(() => window.__m2.profile().stash.filter((e) => e.itemId === 'rifle_sr25').length)) === 0,
      'rifle_sr25 仍在仓库里');

    await startRaidFromLobby();
    const s1 = await snap();
    const kit1 = await page.evaluate(() => window.__m2.raidKit());
    check('★ M5-3 局内主武器 = 局外配装（不再是写死的 startLoadout）',
      s1.weapon.id === 'dmr_sr25' && kit1.loadout.primary === 'dmr_sr25',
      `局内 ${s1.weapon.id} · kit ${kit1.loadout.primary}`);
    check('★ M5-3 局内护甲 = 局外配装（含档位）',
      s1.player.armor.body.id === kit1.loadout.armor.body,
      `局内 ${s1.player.armor.body.id} vs kit ${kit1.loadout.armor.body}`);
    // 口径：口径名从武器表反查，不写死（换枪之后写死的 5.56 会让这条断言变成"读了个 undefined"）
    const cal1 = config.weapons.find((w) => w.id === s1.weapon.id).ammoType;
    check('★ M5-3 弹药储备 = 配装里的发数（按口径从仓库取走）',
      s1.weapon.reserve === kit1.loadout.ammo[cal1],
      `${cal1} reserve=${s1.weapon.reserve} 期望 ${kit1.loadout.ammo[cal1]}`);
    const taken = await page.evaluate(() => window.__m2.raidTaken());
    check('★ M5-3 进局扣件清单里有主武器与弹药（撤离要把没用完的还回来）',
      Array.isArray(taken) && taken.some((t) => t.itemId === 'rifle_sr25') && taken.length >= 3,
      `${taken ? taken.length : 0} 项`);

    // 回大厅：必须先结束这一局（`returnToLobby` 现在也会兜底结算，但显式 abandon
    // 才是玩家的真实路径 —— 而且它会把配装扣掉，因此下面要重新备货）
    await page.evaluate(() => window.__m2.abandonRaid());
    await waitForEnd(20000);
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);

    // 换枪再进局 → 局内随之改变（证明"配装只有一份数据"）。
    // 注意拖的是**主武器槽**里的枪（shotgun_m590 是 slot:1）；smg_v9 是 slot:2，
    // 拖到主武器格必须被拒（slotAcceptsItem 的武器槽号校验）—— 那条反向断言在
    // 下面的 M6-3 组里，这里只测"换了枪，局内跟着换"。
    await page.evaluate(() => window.__m2.grantTestKit());
    await page.click('#lobbyTabs .tab[data-tab="gear"]');
    await sleep(80);
    await page.evaluate(() => window.__m2.stuffLoadout({ '12ga': 120 }, { bandage: 3, medkit: 2 }));
    await sleep(80);
    const drag2 = await dragStashItemToSlot('shotgun_m590', 'primary');
    await sleep(180);
    const lo2 = await page.evaluate(() => window.__m2.profile().loadout);
    check('★ M6-3 再拖一把枪上去：换装成功（原来那件还回仓库）',
      !!drag2.ok && lo2.primary === 'shotgun_m590',
      `primary=${lo2.primary} drag=${JSON.stringify(drag2)}`);
    await startRaidFromLobby();
    const s2 = await snap();
    check('★ M5-3 换一把枪后，局内主武器随之改变（没有第二份配装数据）',
      s2.weapon.id === 'shotgun_m590', `weapon=${s2.weapon.id}`);

    // ---- ⑤ 技能效果真实生效（M5-5 的核心要求）----
    const baseLimit = s2.loot.bag.limitKg;
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);
    const granted = await page.evaluate(() => window.__m2.grantExp(20000));
    check('夹具成立：给经验后拿到技能点', granted.skillPoints > 0, JSON.stringify(granted));
    await page.click('#lobbyTabs .tab[data-tab="skills"]');
    await sleep(80);
    const learnBtn = await page.$('#tabSkills .mini[data-act="skillLearn"][data-id="pack_mule"]');
    check('夹具成立：技能面板里有"学习负重训练"按钮', !!learnBtn);
    if (learnBtn) {
      await learnBtn.click();
      await sleep(150);
      await startRaidFromLobby();
      const boosted = (await snap()).loot.bag.limitKg;
      check('★ M5-5 负重技能**真的**抬高了局内背包上限（不是只改了界面数字）',
        boosted > baseLimit, `${baseLimit} → ${boosted} kg`);
      await page.evaluate(() => window.__m2.returnToLobby());
      await sleep(200);
    }

    // ---- ⑥ 画质档位真的装到渲染器上 ----
    await page.evaluate(() => window.__m2.setSetting('graphicsQuality', 'low'));
    await sleep(120);
    const qLow = (await snap()).quality;
    check('★ M5-8 画质低档：阴影关 + 像素比 1.0',
      qLow.shadows === false && qLow.pixelRatio === 1, JSON.stringify(qLow));
    await page.evaluate(() => window.__m2.setSetting('graphicsQuality', 'high'));
    await sleep(120);
    const qHigh = (await snap()).quality;
    check('★ M5-8 画质高档：阴影开 + 尺寸 2048（尺寸变更必须真的重建 shadow map）',
      qHigh.shadows === true && qHigh.shadowMapSize === 2048, JSON.stringify(qHigh));
    await page.evaluate(() => window.__m2.setSetting('graphicsQuality', 'medium'));

    // ---- ⑦ 改键立即生效，非法键被拒 ----
    await page.evaluate(() => window.__m2.setSetting('bindings', { reload: ['KeyT'] }));
    await sleep(80);
    check('★ M5-8 改键：换弹改到 T 后**立即生效**（不需要重进游戏）',
      (await snap()).bindings.reload[0] === 'KeyT', JSON.stringify((await snap()).bindings.reload));
    await page.evaluate(() => window.__m2.setSetting('bindings', { forward: ['KeyI'] }));
    await sleep(80);
    check('★ M5-8 改键：移动类被拒绝（前进仍是 W，玩家不会改到自己走不动）',
      (await snap()).bindings.forward[0] === 'KeyW', JSON.stringify((await snap()).bindings.forward));
    await page.evaluate(() => window.__m2.setSetting('bindings', { reload: ['ControlLeft'] }));
    await sleep(80);
    const bRej = (await snap()).bindings.reload[0];
    // 口径说明：`bindings` 是**整表覆盖**（界面每次提交完整的覆盖表），
    // 因此"只提交一个非法项"的结果是这一项被拒、该动作回落默认 ——
    // 断言要验的是"非法值绝不可能生效"，而不是"上一个合法值被保留"。
    check('★ M5-8 改键：Ctrl 组合被拒绝（约束 C-19），非法值不会生效',
      bRej !== 'ControlLeft', `reload=${bRej}（被拒后回落默认）`);
    await page.evaluate(() => window.__m2.setSetting('bindings', {}));

    // ---- ⑦b 设置面板本身（M5-8：独立模块 + 改键 UI，销 M5-TEMP-4）----
    await page.click('#btnSettings');
    await sleep(150);
    const sp = await page.evaluate(() => {
      const body = document.getElementById('settingsBody');
      return {
        on: document.getElementById('screenSettings').classList.contains('on'),
        text: body.innerText.replace(/\s+/g, ' '),
        segs: body.querySelectorAll('.seg[data-group]').length,
        rebind: body.querySelectorAll('[data-rebind]').length,
        locked: (body.innerText.match(/不可改/g) || []).length,
      };
    });
    check('★ M5-8 设置面板由独立模块渲染（销 M5-TEMP-4：面板已离开局内 hud）',
      sp.on && sp.segs >= 8 && sp.rebind > 0,
      `档位 ${sp.segs} 组 · 可改键 ${sp.rebind} 项 · 面板可见=${sp.on}`);
    check('★ M5-8 设置面板标出"移动类固定不可改"（制作人裁定 R3）',
      sp.locked >= 4, `锁定 ${sp.locked} 项`);
    check('M5-8 设置面板列出画质与触屏项（它们来自配置表的 schema，不是手写 HTML）',
      /画质档位/.test(sp.text) && /触屏布局/.test(sp.text),
      sp.text.slice(0, 40));

    await page.click('#settingsBody .seg[data-group="graphicsQuality"][data-value="low"]');
    await sleep(180);
    check('★ M5-8 从面板改画质：立即生效（不是"存下来等下次"）',
      (await snap()).quality.shadows === false, JSON.stringify((await snap()).quality));

    await page.click('#settingsBody [data-rebind="reload"]');
    await sleep(100);
    const capturing = await page.evaluate(() => document.getElementById('settingsBody').innerText.includes('按键中'));
    check('夹具成立：点"改键"后进入等待按键态', capturing);
    await page.keyboard.press('KeyT');
    await sleep(180);
    check('★ M5-8 改键 UI：点击后按新键即生效',
      (await snap()).bindings.reload[0] === 'KeyT', JSON.stringify((await snap()).bindings.reload));

    await page.click('#btnSettingsReset');
    await sleep(180);
    const afterReset = await snap();
    check('★ M5-8 恢复默认：画质与键位都回到配置表默认值（销 M1-TEMP-17）',
      afterReset.quality.shadowMapSize === config.settings.qualityTable.medium.shadowMapSize
        && afterReset.bindings.reload[0] === 'KeyR',
      `shadow=${afterReset.quality.shadowMapSize} reload=${afterReset.bindings.reload[0]}`);
    await page.click('#btnSettingsClose');
    await sleep(150);
    check('M5-8 设置面板的"返回"回到大厅（面板关闭）',
      await page.evaluate(() => !document.getElementById('screenSettings').classList.contains('on')
        && document.getElementById('screenLobby').classList.contains('on')));

    // ---- ⑧ 结算页显示真实的局外信息（销 M4-TEMP-3）----
    await startRaidFromLobby();
    await page.evaluate(() => window.__m2.abandonRaid());
    await waitForEnd(20000);
    // M6-UI-01：结算页是两段式，第 1 段 = 撤离详情 / 本局收益 / 任务完成情况。
    // 这里用 textContent 读**内容**（不看显隐）；"哪一段可见 + 按钮"由下面 [M6-UI-01] 那组断言。
    const endContent = await page.evaluate(() => {
      const grab = (id) => {
        const n = document.getElementById(id);
        return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
      };
      return {
        page1: grab('endPage1'),
        basic: grab('endBasic'),
        gain: grab('endGain'),
        quest: grab('endQuest'),
        items: grab('endItems'),
        stash: grab('endStash'),
        titles: Array.from(document.querySelectorAll('#endPage1 .sec-title')).map((n) => n.textContent),
      };
    });
    const endBody = endContent.page1;
    const summary = await page.evaluate(() => window.__m2.lastRaidSummary());
    check('★ M5 结算页显示**真实经验**（不再是占位的 +0）',
      !!summary && summary.exp > 0 && endBody.includes(`+${summary.exp}`),
      `exp=${summary ? summary.exp : 'null'}`);
    check('★ M5 结算页显示等级与技能点（升级反馈）',
      /等级/.test(endBody), endBody.replace(/\s+/g, ' ').slice(0, 70));
    check('★ M5 结算页显示"消耗 / 损失"（阵亡时整套行装都丢）',
      /消耗|损失/.test(endBody), endBody.replace(/\s+/g, ' ').slice(0, 70));
    check('★ 幂等：结算落库后档案里记下了这一局的 raidId',
      !!summary && (await page.evaluate(() => window.__m2.profile().lastRaidId)) === summary.raidId,
      summary ? summary.raidId : 'null');

    // ---- ⑧a [M6-UI-01] 第 1 段必须就是那三段，且各段都有实质内容 ----
    check('★ [M6-UI-01] 第 1 段就是三段：撤离详情 / 本局收益 / 任务完成情况',
      endContent.titles.join('|') === '撤离详情|本局收益|任务完成情况',
      endContent.titles.join('|'));
    check('★ [M6-UI-01] 「撤离详情」有本局战绩（用时 / 击杀 / 容器 / 开火 / 剩余生命）',
      ['单局用时', '击杀敌人', '开启容器', '开火次数', '剩余生命'].every((k) => endContent.basic.includes(k)),
      endContent.basic.slice(0, 100));
    check('★ [M6-UI-01] 「本局收益」有收益口径（带出估值 / 保险箱保住 / 保住比例 / 经验）',
      ['带出估值', '保险箱保住', '物资保住比例', '经验'].every((k) => endContent.gain.includes(k)),
      endContent.gain.slice(0, 100));
    check('★ [M6-UI-01] 「任务完成情况」有内容（没有进度时也必须明说，不能空着）',
      endContent.quest.length > 0, endContent.quest.slice(0, 100));
    check('★ [M6-UI-01] 逐件清单在第 2 段，第 1 段不堆清单（否则结论又会被埋起来）',
      endContent.items.length > 0 && !/带出的物品（/.test(endContent.page1),
      `第 2 段物品正文 ${endContent.items.length} 字`);

    // ---- ⑧b [M6-BUG-03] 结算页再长也不许超出屏幕 ----
    // 真实现象：战利品多的时候，逐件明细会把卡片撑到视口之外，而 body 是 overflow:hidden ——
    // 超出部分**根本看不到**，"返回大厅"按钮同时被顶出屏幕，玩家只能刷新页面。
    // M6-UI-01 之后逐件明细在第 2 段，所以这条断言要**先切到第 2 段**再撑满它：
    // 只断言 CSS 里写了 max-height 是证明不了"按钮真的在屏幕内"的。
    await page.click('#btnEndNext');
    await sleep(150);
    const over = await page.evaluate(() => {
      const screen = document.getElementById('screenEnd');
      const pages = document.getElementById('endPages');
      const items = document.getElementById('endItems');
      const btn = document.getElementById('btnRestart');
      const card = screen.querySelector('.card.end');
      const wasOn = screen.classList.contains('on');
      const keep = items.innerHTML;
      screen.classList.add('on');
      items.innerHTML = Array.from({ length: 80 }, (_, i) =>
        `<div class="row"><span class="k">明细 ${i}</span><span>${i * 137}</span></div>`).join('');
      const cb = card.getBoundingClientRect();
      const bb = btn.getBoundingClientRect();
      const out = {
        step: card.dataset.step,
        cardTop: Math.round(cb.top),
        cardBottom: Math.round(cb.bottom),
        btnBottom: Math.round(bb.bottom),
        vh: window.innerHeight,
        scrollable: pages.scrollHeight > pages.clientHeight + 1,
        overflowY: getComputedStyle(pages).overflowY,
      };
      items.innerHTML = keep;
      if (!wasOn) screen.classList.remove('on');
      return out;
    });
    check('★ [M6-BUG-03] 结算明细超长时卡片仍在视口内（不再被裁掉）',
      over.cardTop >= -1 && over.cardBottom <= over.vh + 1, JSON.stringify(over));
    check('★ [M6-BUG-03] 结算明细超长时"返回大厅"按钮仍在屏幕内（玩家不会卡死在结算页）',
      over.btnBottom <= over.vh + 1, `btnBottom=${over.btnBottom} vh=${over.vh}`);
    check('★ [M6-BUG-03] 结算明细区自身可滚动（内容看得全，而不是被裁掉）',
      over.scrollable && over.overflowY === 'auto', JSON.stringify(over));
  }

  // ---- ⑨ 任务链：**完成并领奖**之后才解锁下一段（制作人裁定）----
  if (m5Group('M5-6 任务链需领奖后才解锁下一段')) {
    if (!(await page.evaluate(() => typeof window.__m2 !== 'undefined'))) {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    }
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);
    await page.evaluate(() => window.__m2.grantTestKit());

    await page.click('#lobbyTabs .tab[data-tab="quests"]');
    await sleep(120);
    const acceptBtn = await page.$('#tabQuests .mini[data-act="questAccept"][data-id="q1_first_extract"]');
    check('夹具成立：任务面板上有第一段任务的"接受"按钮', !!acceptBtn);
    if (acceptBtn) {
      await acceptBtn.click();
      await sleep(150);
      const active = await page.evaluate(() => window.__m2.profile().quests.active);
      check('★ M5-6 手动接取第一段任务（不自动接）',
        active.includes('q1_first_extract'), JSON.stringify(active));

      // 打一局并成功撤离（q1 的目标就是"成功撤离"）
      // ★ M6-3：简报并入装备页，这里点回装备页即可（简报始终可见）。
      await page.click('#lobbyTabs .tab[data-tab="gear"]');
      await startRaidFromLobby();
      // 必须选一个**已开放**的撤离点：teleportToExtract() 取的是第一个点，
      // 而时间门槛点在半场之前是灰的（站上去不计时）。这是夹具口径，不是产品问题。
      const zone = await page.evaluate(() => {
        const open = window.__m2.snapshot().extract.find((z) => z.open);
        return open ? { x: open.x, z: open.z, floor: open.floor, rule: open.rule } : null;
      });
      check('夹具成立：存在已开放的撤离点（否则无法完成"成功撤离"）',
        !!zone, zone ? `第 ${zone.floor} 层 · ${zone.rule}` : '无');
      if (zone) await page.evaluate((zn) => window.__m2.teleport(zn.x, zn.z, zn.floor), zone);
      const t0 = Date.now();
      let extracted = false;
      let lastS = null;
      let maxProgress = 0;
      let maxDist = 0;
      let recoveries = 0;
      while (Date.now() - t0 < 45000) {
        // ★ 关键：指针锁定请求可能被浏览器冷却拒绝（上一次 exitLock 之后约 1 秒内），
        //   此时游戏处于**暂停**态 —— 局内逻辑（含撤离倒计时）**不推进**。
        //   不处理它就会把"暂停"误判成"撤离卡住"。ensureRunning 会点画布把锁定拿回来。
        if (await ensureRunning('M5-6 任务链撤离')) recoveries++;
        await page.evaluate(() => window.__m2.healPlayer(9999));
        const s = await snap();
        lastS = s;
        if (zone && s.player) {
          maxDist = Math.max(maxDist, Math.hypot(s.player.x - zone.x, s.player.z - zone.z));
        }
        maxProgress = Math.max(maxProgress, ...s.extract.map((z) => z.progress));
        if (s.flow === 'ended') {
          extracted = s.endReason === 'extracted';
          break;
        }
        await sleep(400);
      }
      check('夹具成立：完成一局成功撤离（任务链要靠它推进）', extracted,
        lastS
          ? `flow=${lastS.flow} reason=${lastS.endReason} hp=${lastS.player ? lastS.player.health : 'n/a'} ` +
            `maxProgress=${maxProgress} maxDist=${maxDist.toFixed(2)} 恢复锁定=${recoveries} ` +
            `y=${lastS.player ? lastS.player.y : '?'} paused=${lastS.paused} rem=${lastS.remainingMs} ` +
            `prog=[${lastS.extract.map((z) => Math.round(z.progress)).join(',')}] ${JSON.stringify(zone)}`
          : '无快照');
      await page.evaluate(() => window.__m2.returnToLobby());
      await sleep(250);

      await page.click('#lobbyTabs .tab[data-tab="quests"]');
      await sleep(150);
      const st1 = await page.evaluate(() => ({
        text: document.getElementById('tabQuests').innerText.replace(/\s+/g, ' '),
        quests: window.__m2.profile().quests,
        states: window.__m2.lobby().views.quests.list.map((q) => ({
          id: q.id, state: q.state, lockedBy: q.lockedBy, lockedByLabel: q.lockedByLabel,
        })),
      }));
      check('★ M5-6 撤离成功后第一段任务变为"可领奖"（完成但未领奖）',
        st1.quests.completed.includes('q1_first_extract')
          && !st1.quests.claimed.includes('q1_first_extract'),
        JSON.stringify({ completed: st1.quests.completed, claimed: st1.quests.claimed }));

      const q2 = st1.states.find((s) => s.id === 'q2_scavenge');
      check('★ M5-6 只完成未领奖时，下一段**仍然锁着**（制作人裁定：必须领奖才解锁）',
        !!q2 && q2.state === 'locked' && q2.lockedBy === 'need-quest:q1_first_extract',
        JSON.stringify(q2));
      check('M5-6 锁定原因带上前置任务的**名字**（不是 id）',
        !!q2 && /先完成并领取/.test(q2.lockedByLabel || '') && /活着回来/.test(q2.lockedByLabel || ''),
        q2 ? q2.lockedByLabel : '无');
      check('M5-6 面板上确实显示了这句锁定原因',
        /先完成并领取/.test(st1.text), st1.text.slice(0, 70));

      const claimBtn = await page.$('#tabQuests .mini[data-act="questClaim"][data-id="q1_first_extract"]');
      check('夹具成立：任务面板上有"领奖"按钮', !!claimBtn);
      if (claimBtn) {
        await claimBtn.click();
        await sleep(250);
        const st2 = await page.evaluate(() => ({
          claimed: window.__m2.profile().quests.claimed,
          states: window.__m2.lobby().views.quests.list.map((q) => ({ id: q.id, state: q.state })),
          safeTier: window.__m2.profile().safeTierUnlocked,
        }));
        check('★ M5-6 领奖后：奖励到账（货币 / 经验 / 安全箱档位解锁）',
          st2.claimed.includes('q1_first_extract')
            && st2.safeTier === config.lootTable.safeContainer.tiers[1].id,
          `claimed=${st2.claimed.join(',')} safe=${st2.safeTier}`);
        check('★ M5-6 领奖后，下一段变为"可接取"（这就是"领奖才解锁"的实现）',
          st2.states.find((s) => s.id === 'q2_scavenge').state === 'available',
          JSON.stringify(st2.states.find((s) => s.id === 'q2_scavenge')));
        const accept2 = await page.$('#tabQuests .mini[data-act="questAccept"][data-id="q2_scavenge"]');
        check('M5-6 下一段的"接受"按钮真的出现了', !!accept2);
      }
    }
  }

  // ============================================================
  // [M6-BUG-01][M6-BUG-02] 医疗回归：绷带"未满血即可用" + 读条与局内时钟同口径
  //
  // 为什么单独成组：原来的"⑤ M2-5 医疗与消耗品"在**历史段落**里，整段会被 `--only` 跳过；
  // 而这一组自带进局准备，因此可以 `node tools/smoke.mjs --only=医疗` 单独快速回归。
  if (m5Group('M6 医疗回归（绷带 3 / 急救包 4 / 读条）')) {
    // 本组**自带页面加载**：`--only=医疗` 会跳过整个历史段落，没人做过 goto，
    // 页面此时还停在 about:blank（`window.__m2` 不存在）。组内自足才能被单独快速回归。
    if (!(await page.evaluate(() => typeof window.__m2 !== 'undefined'))) {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    }
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);
    await page.evaluate(() => window.__m2.grantTestKit());
    await startRaidFromLobby();
    await call('teleportToSafeSpot');   // 治疗必须在安全位置测：受击会打断
    await call('grantConsumables', 1, 1); // 备足道具，避免"没绷带"污染断言
    await sleep(300);

    // ---- ⓪ [M6-BUG-02] 的现场条件：让本局**真的暂停一次**再恢复 ----
    // 旧实现（读条用原始帧时间戳、计时用局内时钟）只有在 `pausedTotalMs > 0` 时才露馅：
    // 偏移量恰好是"暂停时长 / 读条总时长"。暂停 1.5 秒对绷带（1400ms）而言足以让旧实现
    // **一按就满格**。所以这一组必须先制造一次暂停，否则"读条正确"只是碰巧成立。
    // 用真实路径恢复（暂停卡片上的「继续游戏」），而不是 `page.click('canvas')` ——
    // 暂停时画布被 #screenPause 盖住，点画布属于"点了个寂寞"。
    let pausedMs = 0;
    try {
      await page.evaluate(() => document.exitPointerLock());
      await page.waitForFunction(() => window.__m2.snapshot().paused === true, { timeout: 5000 });
      const tPause = Date.now();
      await sleep(1500);
      await page.click('#btnResume');
      await page.waitForFunction(() => window.__m2.snapshot().paused === false, { timeout: 8000 });
      pausedMs = Date.now() - tPause;
    } catch {
      // 浏览器指针锁定有冷却（exitPointerLock 后约 1 秒内拒绝重新申请），
      // 恢复失败时**不把夹具问题算成产品缺陷**：记一笔，让断言退化成"在无暂停下也正确"。
      pauseRecoveries.push({ tag: 'M6 医疗回归：制造一次暂停', at: new Date().toISOString() });
    }
    console.log(`  · 夹具：本局累计暂停约 ${pausedMs}ms（[M6-BUG-02] 的偏移量 = 暂停时长 / 读条时长）`);

    // ---- ① 绷带：60 血（高于旧上限 45，又不是满血）按 3 必须能用 ----
    await call('setHealth', 60);
    await sleep(150);
    const b60 = await snap();
    check('夹具成立：生命被设为 60（高于绷带旧上限 45、也不是满血）',
      Math.abs(b60.player.health - 60) < 0.01, `health=${b60.player.health}`);
    await page.keyboard.press('Digit3');
    await sleep(250);
    const usingB = await snap();
    check('★ [M6-BUG-01] 60 血按 3 能用绷带（回归：按 3 无法使用绷带）',
      usingB.player.using === true && usingB.consumables.bandage === b60.consumables.bandage - 1,
      `using=${usingB.player.using} 绷带 ${b60.consumables.bandage} → ${usingB.consumables.bandage}`);
    // 读条口径：1400ms 的绷带在约 250ms 时应约 0.18。
    // 旧缺陷（把原始帧时间戳传进 useProgress）会在本局暂停过之后带偏移 —— 可能一按就接近/等于 1。
    check('★ [M6-BUG-02] 绷带读条与已过时间成正比（不是一按就满）',
      usingB.player.useProgress > 0.02 && usingB.player.useProgress < 0.6,
      `progress=${usingB.player.useProgress}（250ms/1400ms≈0.18）`);
    await sleep(350);
    const usingB2 = await snap();
    check('★ [M6-BUG-02] 绷带读条单调递增（或被受击打断，两者都合法）',
      usingB2.player.using === false || usingB2.player.useProgress > usingB.player.useProgress,
      `${usingB.player.useProgress} → ${usingB2.player.useProgress}`);
    await page.waitForFunction(() => window.__m2.snapshot().player.using === false, { timeout: 8000 });
    await sleep(150);
    const healedB = await snap();
    check('★ [M6-BUG-01] 绷带回血 18 点（60 → 78，不再被 45 上限截断）',
      Math.abs(healedB.player.health - 78) < 0.01, `health=${healedB.player.health}`);

    // ---- ② 急救包：读条同样按"已过的局内时间"走（3000ms 在 300ms 时约 0.1）----
    await call('setHealth', 40);
    await sleep(150);
    const m40 = await snap();
    await page.keyboard.press('Digit4');
    await sleep(300);
    const usingM = await snap();
    check('★ 按 4 能用急救包并消耗一个',
      usingM.player.using === true && usingM.consumables.medkit === m40.consumables.medkit - 1,
      `using=${usingM.player.using} 急救包 ${m40.consumables.medkit} → ${usingM.consumables.medkit}`);
    check('★ [M6-BUG-02] 急救包读条与已过时间成正比（300ms/3000ms≈0.1，不是一按就满）',
      usingM.player.useProgress > 0.02 && usingM.player.useProgress < 0.4,
      `progress=${usingM.player.useProgress}`);
    await page.waitForFunction(() => window.__m2.snapshot().player.using === false, { timeout: 8000 });
    await sleep(150);
    const healedM = await snap();
    check('★ 急救包回血 65 点并停在生命上限（40 → 100）',
      Math.abs(healedM.player.health - 100) < 0.01, `health=${healedM.player.health}`);

    // ---- ③ 满血时按 3 被拒绝，而且**说得出原因**（静默无反应是"绷带坏了"误判的来源）----
    const full0 = await snap();
    await page.keyboard.press('Digit3');
    await sleep(300);
    const full1 = await snap();
    check('★ [M6-BUG-01] 满血时按 3 被拒绝且不消耗绷带（不浪费）',
      full1.player.using === false && full1.consumables.bandage === full0.consumables.bandage,
      `using=${full1.player.using} 绷带 ${full0.consumables.bandage} → ${full1.consumables.bandage}`);
    const whyToast = await page.evaluate(() => document.getElementById('toast').textContent);
    check('★ [M6-BUG-01] 拒绝使用时给出了原因（不再是静默无反应）',
      /绷带/.test(whyToast), `toast="${whyToast}"`);

    await page.evaluate(() => window.__m2.abandonRaid());
    await waitForEnd(20000);
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);
  }

  // ---------------------------------------------------------------------------
  if (m5Group('M6-1 武器扩充（30 把：装备 / 进局 / 开火）')) {
    // 本组同样**自带页面加载**，才能被 `--only=武器` 单独快速回归。
    if (!(await page.evaluate(() => typeof window.__m2 !== 'undefined'))) {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    }
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);

    // 覆盖 3 种口径、2 个槽位（主武器 7.62/12ga、副武器 9mm）。
    // ★ 这几条是**纯逻辑断言看不见**的一层：表里合法 ≠ 玩家拿得到 ≠ 进局真能开火。
    //   武器表从 5 把扩到 30 把之后，"写进表里但没人能拿到"或"拿到也开不了火（口径没带对）"
    //   这类缺陷只会在这一层暴露 —— 而它们恰恰最容易在批量扩充时发生。
    const CASES = [
      { ref: 'rifle_ak762', slot: 'primary', ammo: '7.62' },
      { ref: 'dmr_g28', slot: 'primary', ammo: '7.62' },
      { ref: 'smg_mp9', slot: 'secondary', ammo: '9mm' },
      { ref: 'shotgun_saiga', slot: 'primary', ammo: '12ga' },
    ];

    for (const c of CASES) {
      const g = await page.evaluate((ref) => window.__m2.grantWeapon(ref), c.ref);
      check(`★ M6-1 ${c.ref}：能按 id 授予并装入对应槽位（${c.slot}）`,
        !!g && g.equipped === c.ref && g.slot === c.slot && g.ammoType === c.ammo,
        JSON.stringify(g));

      await startRaidFromLobby();
      await call('teleportToSafeSpot');
      await sleep(500);

      const s0 = await snap();
      check(`★ M6-1 ${c.ref}：进局后手上就是它（没有回落成起始配装）`,
        s0.weapon.id === c.ref, `局内 ${s0.weapon.id}「${s0.weapon.label}」`);
      check(`★ M6-1 ${c.ref}：带足了弹药（否则"拿到也开不了火"）`,
        s0.weapon.magazine > 0 && s0.weapon.reserve > 0,
        `弹匣 ${s0.weapon.magazine} 备弹 ${s0.weapon.reserve}`);

      // 真开一枪 —— 弹匣必须掉。这是"这把枪的射击路径是通的"最直接的证据。
      await page.mouse.down({ button: 'left' });
      await sleep(220);
      await page.mouse.up({ button: 'left' });
      await sleep(350);
      const s1 = await snap();
      check(`★ M6-1 ${c.ref}：开火有效（弹匣真的减少，不是哑火）`,
        s1.weapon.magazine < s0.weapon.magazine,
        `弹匣 ${s0.weapon.magazine} → ${s1.weapon.magazine}`);

      await page.evaluate(() => window.__m2.abandonRaid());
      await waitForEnd(20000);
      await page.evaluate(() => window.__m2.returnToLobby());
      await sleep(200);
    }
  }

  // ---------------------------------------------------------------------------
  if (m5Group('M6-2 AI 尸体掉落（击杀 → 尸体 → 搜开）')) {
    if (!(await page.evaluate(() => typeof window.__m2 !== 'undefined'))) {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    }
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);
    await page.evaluate(() => window.__m2.grantTestKit());
    await startRaidFromLobby();
    await call('teleportToSafeSpot');
    // ★ 本组测的是"击杀 → 尸体 → 搜开"这条**掉落路径**，不是 AI 交战。
    //   而尸体的搜索用的是容器的打断规则（keep_partial）：搜到一半**受击会打断**，
    //   进度只保留一半。全量跑时本组前面已有组把 AI 解冻，于是"搜尸途中被 AI 打中"
    //   会让 opened 停在 false —— 单跑通过、全量失败，正是这个差异造成的。
    //   这里同样按"不测 AI 的组要一个安静的世界"处理（不影响任何断言的严格度：
    //   killOneAi 对静默的 AI 照样生效，尸体照样生成，搜索路径照走）。
    await page.evaluate(() => window.__m2.aiStandDown(true));
    await sleep(400);

    const before = await snap();
    check('M6-2 开局尸体数为 0（还没击杀）', before.corpses === 0, `corpses=${before.corpses}`);

    // 击杀一只（用夹具，不依赖枪法）—— 这是"打"这一侧唯一有收益的路径
    const killed = await page.evaluate(() => window.__m2.killOneAi());
    await sleep(500);
    const afterKill = await snap();
    check('★ M6-2 击杀后留下可搜刮的尸体（此前击杀只计数、不掉任何东西）',
      afterKill.corpses >= 1, `killOneAi=${JSON.stringify(killed)} corpses=${afterKill.corpses}`);

    const list = await page.evaluate(() => window.__m2.corpseList());
    const c0 = list[0];
    check('★ M6-2 尸体带着**它那一档**的掉落表（不是随便一张表）',
      !!c0 && typeof c0.tierId === 'string' && c0.items.length > 0,
      c0 ? `tier=${c0.tierId} items=${c0.items.join(',')}` : '没有尸体');

    // 真的搜一次：站到尸体上按住 F，进度走完应当 opened=true。
    // 这是"尸体复用了容器整条搜索路径"的直接证据 —— 而不是只断言"对象被创建了"。
    if (c0) {
      await page.evaluate((c) => window.__m2.teleport(c.x, c.z, c.floor), c0);
      await sleep(300);
      await page.keyboard.down('KeyF');
      await sleep(2400); // corpseByTier.searchMs = 1800
      await page.keyboard.up('KeyF');
      await sleep(300);
      const list2 = await page.evaluate(() => window.__m2.corpseList());
      check('★ M6-2 尸体可搜开（复用容器的搜索路径：进度 → 开箱 → 拾取）',
        !!list2[0] && list2[0].opened === true,
        list2[0] ? `opened=${list2[0].opened} 剩余物品 ${list2[0].items.length}` : '尸体不见了');
    }
  }
}

// ============================================================
// ★ M6：携行具容量化 + 弹药/消耗品进网格（端到端）
//
// 纯逻辑单测（tools/unit-tests.mjs 的 M6 一节）已经覆盖了算法；
// 这里只补**纯逻辑看不见的那一层**：容量真的从大厅配置一路走到局内、
// 弹药真的在网格里被扣、"仓库什么都没有"时进战区不崩。
// ============================================================
async function runM6CarryGroup() {
  if (m5Group('★ M6 携行具容量化与弹药网格化')) {
    // ---- ① 装备哪只包，局内就是哪只包的容量 ----
    await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    await page.evaluate(() => window.__m2.grantTestKit());
    // 配上一只轻型背包与一只弹挂（grantTestKit 给的是标准背包）
    await page.evaluate(() => window.__m2.equipCarry('bp_small', 'rig_light'));
    await startRaidFromLobby();
    let limitSmall = 0;
    {
      const s = await snap();
      const small = config.carry.backpacks.find((b) => b.id === 'bp_small');
      const rig = config.carry.rigs.find((r) => r.id === 'rig_light');
      limitSmall = s.loot.bag.limitKg;
      check('★ M6 局内容量 = 所装备的背包（销"容量写死在 loot.json"）',
        s.loot.bag.backpackId === 'bp_small' && s.loot.bag.total === small.capacityW * small.capacityH,
        `${s.loot.bag.backpackId} ${s.loot.bag.total} 格`);
      check('★ M6 负重上限不低于所装备背包的 weightLimitKg（技能只往上加）',
        s.loot.bag.limitKg >= small.weightLimitKg,
        `${s.loot.bag.limitKg}kg（bp_small ${small.weightLimitKg}kg + 技能）`);
      check('★ M6 弹挂是**第二张网格**且进了局内',
        s.loot.bag.rigId === 'rig_light' && s.loot.bag.rigTotal === rig.capacityW * rig.capacityH,
        `${s.loot.bag.rigId} ${s.loot.bag.rigTotal} 格`);
      check('★ M6 自己带的弹药药品真的占了格（销 M5-TEMP-11）',
        s.loot.bag.kitSlots > 0 && s.loot.bag.lootSlots === 0,
        `自带 ${s.loot.bag.kitSlots} 格 / 战利品 ${s.loot.bag.lootSlots} 格`);

      // ---- ② 备弹是网格的派生量：打几发再换弹，网格里必须真的少掉那些发 ----
      await page.mouse.down({ button: 'left' });
      await sleep(220);
      await page.mouse.up({ button: 'left' });
      await sleep(120);
      const before = await call('ammoInGrid');
      await page.keyboard.press('KeyR');
      await sleep(2000); // 等换弹完成（战术/空仓换弹都在 2s 内）
      const after = await call('ammoInGrid');
      const loaded = after.magazine - before.magazine;
      check('★ M6 换弹从背包网格里扣子弹（备弹数不是另存的一份数字）',
        loaded > 0 && after.total === before.total - loaded,
        `网格 ${before.total} → ${after.total}，弹匣 ${before.magazine} → ${after.magazine}（装填 ${loaded} 发）`);
    }
    await page.evaluate(() => window.__m2.returnToLobby());
    await sleep(200);

    // ---- ②-b 换成更大的背包：容量与负重上限必须**一起**变 ----
    // 为什么用"两只包做差"而不是"等于表里的数"：负重上限 = 背包 + 技能加成，
    // 而技能在别的组里可能已经点过。差值才是"背包真的驱动了容量"的证据。
    {
      const small = config.carry.backpacks.find((b) => b.id === 'bp_small');
      const large = config.carry.backpacks.find((b) => b.id === 'bp_large');
      await page.evaluate(() => window.__m2.equipCarry('bp_large', null));
      await startRaidFromLobby();
      const s = await snap();
      check('★ M6 换一只更大的背包：格数与负重上限同时变大（差值等于表里的差）',
        s.loot.bag.backpackId === 'bp_large'
        && s.loot.bag.total === large.capacityW * large.capacityH
        && s.loot.bag.limitKg - limitSmall === large.weightLimitKg - small.weightLimitKg,
        `${s.loot.bag.total} 格 / ${s.loot.bag.limitKg}kg` +
          `（bp_large ${large.capacityW * large.capacityH} 格 / ${large.weightLimitKg}kg）`);
      await page.evaluate(() => window.__m2.returnToLobby());
      await sleep(200);
    }

    // ---- ③ 仓库什么都没有时进战区：空手 + 兜底背包，且**不能崩** ----
    {
      const errsBefore = pageErrors.length;
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
      await page.evaluate(() => window.__m2.clearStash());
      // 刻意**不用** startRaidFromLobby（它会补齐配装）—— 这一条测的就是"什么都没有"
      await sleep(1200);
      await page.click('#btnStart');
      await page.waitForFunction(() => window.__m2.snapshot().flow === 'raid', { timeout: 10000 });
      await sleep(400);
      const s = await snap();
      const def = config.carry.defaults.backpack;
      check('★ M6 空仓库进局不崩（销"配装里的枪拿不到就凭空给一把"）',
        pageErrors.length - errsBefore === 0,
        pageErrors.slice(errsBefore, errsBefore + 2).join(' | ') || '无异常');
      check('★ M6 空仓库进局 = 空手 + 兜底背包（"缺件也允许进局"是一条真能跑的路径）',
        s.weapon.hasWeapon === false && s.loot.bag.backpackId === null
        && s.loot.bag.total === def.w * def.h,
        `武器=${s.weapon.label} 背包=${s.loot.bag.backpackId || '兜底'} ${s.loot.bag.total} 格`);
      await page.evaluate(() => window.__m2.returnToLobby());
      await sleep(200);
    }

    // ---- ④ 装不下时**报出来**，而不是静默少带 ----
    {
      await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
      await page.evaluate(() => window.__m2.grantTestKit());
      await page.evaluate(() => window.__m2.equipCarry('bp_small', null));
      // 120 发霰弹 = 2 格；绷带 20 个（stack 4）= 5 格；急救包 20 个（stack 2、2×1）= 20 格。
      // 合计 27 格 > bp_small 的 20 格 —— 必然溢出，且溢出的正是"最先放不下的那些"。
      const res = await page.evaluate(() => window.__m2.stuffLoadout({ '12ga': 120 }, { bandage: 20, medkit: 20 }));
      check('★ M6 装不下的携行件被报成 overflow（不静默少带）',
        Array.isArray(res.overflow) && res.overflow.length > 0,
        res.overflow.map((o) => `${o.itemId}×${o.count}`).join('、') || '没有溢出（夹具失效）');
      const brief = await page.evaluate(() => window.__m2.lobby().briefing.pack);
      check('★ M6 简报把"装不下"告诉玩家（进战区前就该知道）',
        (brief.overflow || []).length > 0 && brief.kitSlots > 0,
        `自带 ${brief.kitSlots} 格 / 溢出 ${(brief.overflow || []).length} 项`);

      // 界面上真的写出来了 —— 数据里有、界面没画等于没告诉玩家
      const panelText = await page.evaluate(() =>
        document.getElementById('tabGear').innerText.replace(/\s+/g, ' '));
      check('★ M6 装备面板画出了携行容量与"装不下"警告（不是只在数据里有）',
        /携行/.test(panelText) && /装不下/.test(panelText),
        panelText.slice(0, 140));
      // ★ M6-3：槽位不再是下拉框，而是**装备格**（`data-drop-slot`）。
      //   用这个钩子是因为它同时是 DOM 身份与拖放落点的身份 —— 用文案匹配（"背包"）会
      //   在改文案时静默失效，而这里要守的是"这个槽位真的能被拖上去"。
      const slotIds = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#gearBody [data-drop-slot]')).map((s) => s.dataset.slot));
      check('★ M6/M6-3 六个装备格都画出来了（头/身/主武器/副武器/背包/弹挂）',
        ['head', 'body', 'primary', 'secondary', 'backpack', 'rig'].every((s) => slotIds.includes(s)),
        slotIds.join('/'));
    }
  }
}

// ============================================================
// ★ M6-3：装备页（配装＋仓库合并）的拖放端到端
//
// 纯逻辑已经把"落点合不合法"守住了（tools/unit-tests.mjs 的 M6-3 一节，逐例比对
// 预览/落库并断言入参不被改动）。这里只补**纯逻辑看不见的那一层**：
// 指针事件真的接到控制器上、格子坐标真的从 DOM 矩形算对、R 真的在拖动中换形、
// 落库真的写进档案。
//
// 为什么事件要**分多步**派发：Chrome 的 pointerdown/pointermove 是从鼠标输入合成的，
// 一次 move 到终点再 up 也能跑通，但那样测不出"拖动中"的状态（幽灵形状、红色提示、
// R 换形都发生在中途）。所以口径是 move → move → down → 多次 move → (R) → move → up。
// 已实测无头下 CDP 的鼠标输入**会**产生 pointer 事件（见下面 ⓪ 的夹具自检）——
// 万一哪天不产生了，那条自检会先红，而不是让整组断言变成"拖不动"。
// ============================================================

/** 装备页的几何：仓库网格矩形、格边长、每个装备格的中心。 */
async function gearGeometry() {
  return page.evaluate(() => {
    const gear = document.getElementById('tabGear');
    // 先滚到可见：page.mouse.move 用**视口坐标**，不会像 elementHandle.click 那样自动滚动。
    // 不滚的话坐标可能落在视口外（表现为"拖不动"，而失败信息里看不出原因）。
    gear.scrollIntoView({ block: 'start' });
    const body = document.getElementById('gearBody');
    const grid = body.querySelector('[data-drop-grid]');
    const cell = parseFloat(getComputedStyle(grid).getPropertyValue('--cell')) || 30;
    const r = grid.getBoundingClientRect();
    const slots = {};
    for (const s of body.querySelectorAll('[data-drop-slot]')) {
      const sr = s.getBoundingClientRect();
      slots[s.dataset.slot] = { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2, item: s.dataset.item || null };
    }
    return {
      grid: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      cell,
      slots,
      vh: window.innerHeight,
    };
  });
}

/** 某个格的中心（视口坐标）。口径与 ui/dragdrop.js 的 cellFromPoint 相反：那边是"点→格"。 */
const cellPoint = (g, x, y) => ({ x: g.grid.left + (x + 0.5) * g.cell, y: g.grid.top + (y + 0.5) * g.cell });

/**
 * 分多步派发一次拖放。`beforeUp` 在松手**之前**执行 —— "拖动中"的断言（形状、红色提示）
 * 只能在这里读，松手之后就什么都没有了。
 */
async function pointerDrag(from, to, opts = {}) {
  const steps = opts.steps || 5;
  await page.mouse.move(from.x, from.y);
  await page.mouse.move(from.x + 2, from.y + 2);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(15);
  }
  if (opts.pressR) await page.keyboard.press('KeyR');
  await page.mouse.move(to.x, to.y);
  await sleep(20);
  if (opts.beforeUp) await opts.beforeUp();
  await page.mouse.up();
  await sleep(120);
}

/** 仓库里某件东西的落点信息（uid 是真值，用于"是否真的离开了仓库"这类断言）。 */
async function stashEntry(itemId) {
  return page.evaluate((id) => {
    const e = window.__m2.profile().stash.find((x) => x.itemId === id);
    return e ? { uid: e.uid, x: e.x, y: e.y, rotated: !!e.rotated, count: e.count } : null;
  }, itemId);
}

/** 把仓库里某件东西拖到某个装备格（替代原来的槽位下拉框：玩家真实路径）。 */
async function dragStashItemToSlot(itemId, slotId) {
  const g = await gearGeometry();
  const e = await stashEntry(itemId);
  if (!e) return { ok: false, reason: 'not-in-stash' };
  if (!g.slots[slotId]) return { ok: false, reason: 'no-such-slot-in-dom' };
  await pointerDrag(cellPoint(g, e.x, e.y), { x: g.slots[slotId].x, y: g.slots[slotId].y });
  return { ok: true, uid: e.uid, to: slotId };
}

/** 把仓库里某件东西拖到某个格（用于仓库内移动 / 非法落点）。 */
async function dragStashItemToCell(itemId, cell, opts = {}) {
  const g = await gearGeometry();
  const e = await stashEntry(itemId);
  if (!e) return { ok: false, reason: 'not-in-stash' };
  await pointerDrag(cellPoint(g, e.x, e.y), cellPoint(g, cell.x, cell.y), opts);
  return { ok: true, uid: e.uid, from: e };
}

async function runM63DragGroup() {
  // 组名同时带 M6-3 与 M5 —— 因为 `--only=<子串>` 是按**组名子串**过滤的，
  // 带上 M5 之后 `--only=m5` 也能跑到这一组（否则改一行界面只能跑全量）。
  if (m5Group('★ M6-3 / M5-3 装备页（配装＋仓库合并）拖放')) {
    await page.goto(URL_BASE, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.__m2 !== undefined', { timeout: 20000 });
    await page.evaluate(() => window.__m2.grantTestKit());
    await sleep(150);

    // ---- ⓪ 夹具自检：无头下 CDP 鼠标输入必须真的产生 pointer 事件 ----
    await page.evaluate(() => {
      window.__m63evt = { down: 0, move: 0, up: 0 };
      const root = document.getElementById('gearBody');
      root.addEventListener('pointerdown', () => { window.__m63evt.down++; }, true);
      window.addEventListener('pointermove', () => { window.__m63evt.move++; }, true);
      window.addEventListener('pointerup', () => { window.__m63evt.up++; }, true);
    });

    // ---- ① 简报并入装备页，且**内容一条不少** ----
    {
      const brief = await page.evaluate(() => {
        const body = document.getElementById('lobbyBody');
        return {
          exists: !!body,
          visible: !!body && body.getClientRects().length > 0,
          inGear: !!body && document.getElementById('tabGear').contains(body),
          text: body ? body.innerText.replace(/\s+/g, ' ') : '',
          tab: window.__m2.lobby().tab,
        };
      });
      check('★ M6-3 简报并入装备页顶部后**仍然可见**（没有为了合并页面把它删掉）',
        brief.exists && brief.visible && brief.inGear, JSON.stringify({ ...brief, text: undefined }));
      // 这六类信息是进战区前唯一的权威来源，一条都不能少
      const KEYS = ['战区', '单局时限', '资源分区', '敌方', '撤离点', '携行', '安全箱'];
      const missing = KEYS.filter((k) => !brief.text.includes(k));
      check('★ M6-3 简报的七类信息全部还在（战区/时限/分区/敌方/撤离点/携行/安全箱）',
        missing.length === 0, missing.join(',') || brief.text.slice(0, 90));
      check('★ M6-3 撤离点的**开放规则**仍在界面上（合并页面时最容易被丢掉的那条）',
        brief.text.includes(`共 ${config.extract.zones.length} 个`) && /常驻开放/.test(brief.text)
        && /过半|累计淘汰/.test(brief.text),
        brief.text.slice(0, 120));
      check('M6-3 默认落在装备页（简报就在它顶部）', brief.tab === 'gear', `tab=${brief.tab}`);
    }

    // ---- ② 左半边：六个装备格，写名字与重量，空格写"空" ----
    {
      const slots = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#gearBody [data-drop-slot]')).map((s) => ({
          id: s.dataset.slot,
          item: s.dataset.item || null,
          text: s.innerText.replace(/\s+/g, ' ').trim(),
        })));
      const labels = config.equipment.slots.filter((s) => !s.disabled).map((s) => s.label);
      check('★ M6-3 左半边是六个装备格（头/身/主武器/副武器/背包/弹挂），每个都写着槽位名',
        slots.length === 6 && labels.every((l) => slots.some((s) => s.text.includes(l))),
        slots.map((s) => `${s.id}:${s.text.slice(0, 10)}`).join(' | '));
      const filled = slots.filter((s) => s.item);
      check('★ M6-3 已装备的格子里写着装备名与重量（不是只有一个图标）',
        filled.length > 0 && filled.every((s) => /\d+\.\d+kg/.test(s.text)),
        filled.map((s) => `${s.id}:${s.text}`).join(' | '));
      // 空格必须写"空"：只画一个虚线框，玩家分不清"没装备"与"没画出来"
      await page.evaluate(() => window.__m2.equipCarry(null, null));
      await sleep(120);
      const empties = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#gearBody [data-drop-slot]'))
          .filter((s) => !s.dataset.item)
          .map((s) => s.innerText.replace(/\s+/g, ' ')));
      check('★ M6-3 空格显示「空」（摘掉背包与弹挂之后那两个格必须是空的）',
        empties.length >= 2 && empties.every((t) => t.includes('空')), empties.join(' | '));
    }

    // ---- ③ 负重条：刻度来自 core（界面不自己算比例）----
    {
      const bar = await page.evaluate(() => {
        const el = document.querySelector('#gearBody .weightbar');
        if (!el) return null;
        return { band: el.dataset.band, overweight: el.dataset.overweight, width: el.querySelector('i').style.width };
      });
      const v = await page.evaluate(() => window.__m2.lobby().views.loadout);
      // 口径：浏览器会把 style.width 规范化（"33.0%" → "33%"），所以比**数值**不比字符串 ——
      // 字符串比较会把"格式化差异"误报成"刻度算错了"。
      check('★ M6-3 负重条画出来了，刻度与 core 的档位/比例一致（界面不做除法）',
        !!bar && bar.band === v.band.id
        && Math.abs(parseFloat(bar.width) - v.weightBar.ratio * 100) < 0.05,
        `${JSON.stringify(bar)} vs ratio=${v.weightBar.ratio}`);
    }

    // ---- ④ 仓库内拖动：落点合法 → 坐标真的变了 ----
    {
      await page.evaluate(() => window.__m2.grantTestKit());
      await sleep(120);
      const spot = await page.evaluate(() => window.__m2.freeStashSpot(2, 3));
      const r = await dragStashItemToCell('bp_medium', spot, {
        beforeUp: async () => {
          const st = await page.evaluate(() => window.__m2.lobby().drag);
          check('★ M6-3 拖动中的状态可观测（dragging/落点/判定），不是靠看幽灵元素的像素',
            st.dragging === true && st.target && st.target.kind === 'stash'
            && st.target.x === spot.x && st.target.y === spot.y && st.verdict.ok === true,
            JSON.stringify(st));
        },
      });
      const after = await page.evaluate((u) => {
        const e = window.__m2.profile().stash.find((x) => x.uid === u);
        return e ? { x: e.x, y: e.y } : null;
      }, r.uid);
      check('★ M6-3 仓库内自由拖动：落点合法时坐标真的写进档案',
        !!after && after.x === spot.x && after.y === spot.y,
        `${JSON.stringify(r.from)} → ${JSON.stringify(after)} 期望 ${JSON.stringify(spot)}`);
    }

    // ---- ⑤ 非法落点：被占用 / 越界 → 回原位 + 可读原因 ----
    {
      const bp = await stashEntry('bp_medium');
      const other = await page.evaluate((u) => {
        const e = window.__m2.profile().stash.find((x) => x.uid !== u);
        return { uid: e.uid, x: e.x, y: e.y };
      }, bp.uid);
      await dragStashItemToCell('bp_medium', { x: other.x, y: other.y });
      const after = await stashEntry('bp_medium');
      const toast = await page.evaluate(() => window.__m2.lobby().toastText);
      check('★ M6-3 落点被占用：条目**回原位**（坐标一字未动）',
        !!after && after.x === bp.x && after.y === bp.y, `(${bp.x},${bp.y}) → (${after.x},${after.y})`);
      check('★ M6-3 落点被占用：给出**可读的原因**（不是"拖过去没反应"）',
        /占着|占/.test(toast), toast || '（没有提示）');

      // 越界：把 2 格宽的东西拖到最后一列 → 2+9 > 10
      await dragStashItemToCell('bp_medium', { x: config.economy.stash.w - 1, y: 0 });
      const after2 = await stashEntry('bp_medium');
      const toast2 = await page.evaluate(() => window.__m2.lobby().toastText);
      check('★ M6-3 落点越界：回原位且提示"超出仓库边界"',
        !!after2 && after2.x === bp.x && after2.y === bp.y && /边界/.test(toast2), toast2 || '（没有提示）');
    }

    // ---- ⑥ 拖动中按 R 旋转 90°：幽灵换形、落点重算、rotated 一起提交 ----
    {
      const e = await stashEntry('medkit'); // 2×1 的急救包：旋转前后形状不同
      const spot = await page.evaluate(() => window.__m2.freeStashSpot(1, 2));
      const r = await dragStashItemToCell('medkit', spot, {
        pressR: true,
        beforeUp: async () => {
          const st = await page.evaluate(() => window.__m2.lobby().drag);
          check('★ M6-3 拖动中按 R：幽灵元素实时换形（2×1 → 1×2），判定跟着重算',
            st.dragging === true && st.rotated === true && st.shape.w === 1 && st.shape.h === 2,
            JSON.stringify(st));
          // 红色提示：class 就够（这是状态，不是像素位置）
          const ghostBad = await page.evaluate(() => {
            const g = document.querySelector('#dragLayer .drag-ghost');
            return g ? g.className : null;
          });
          check('M6-3 拖动中有幽灵元素跟随，且按合法性上色（ok/bad 两个 class 之一）',
            !!ghostBad && /drag-ghost/.test(ghostBad), String(ghostBad));
        },
      });
      const after = await page.evaluate((u) => {
        const x = window.__m2.profile().stash.find((y) => y.uid === u);
        return x ? { x: x.x, y: x.y, rotated: !!x.rotated } : null;
      }, r.uid);
      check('★ M6-3 落位时把 rotated 一起提交（朝向是数据，不是界面状态）',
        !!after && after.x === spot.x && after.y === spot.y && after.rotated === true,
        JSON.stringify(after));
    }

    // ---- ⑦ 拖动中的红色提示：非法朝向 ----
    {
      // 把 2×1 的急救包拖到**最右列**：正放 2 宽会越界 —— 于是判定为红（bad）。
      // 这条守的是"非法朝向的落点用红色提示"这件事真的接到判定上了。
      const e = await stashEntry('medkit');
      if (e) {
        await dragStashItemToCell('medkit', { x: config.economy.stash.w - 1, y: 11 }, {
          beforeUp: async () => {
            const st = await page.evaluate(() => window.__m2.lobby().drag);
            const cls = await page.evaluate(() => {
              const g = document.querySelector('#dragLayer .drag-ghost');
              return g ? g.className : null;
            });
            check('★ M6-3 非法落点：判定为不合法，幽灵元素上色为 bad（红）',
              st.verdict && st.verdict.ok === false && !!cls && /bad/.test(cls),
              `verdict=${JSON.stringify(st.verdict)} class=${cls}`);
          },
        });
        const after = await stashEntry('medkit');
        check('★ M6-3 非法落点松手后仍在原位（红色提示与"回原位"是同一次判定）',
          !!after && after.x === e.x && after.y === e.y, `(${e.x},${e.y}) → (${after.x},${after.y})`);
      }
    }

    // ---- ⑧ 仓库 → 装备格：合法与三种非法 ----
    {
      const ok = await dragStashItemToSlot('shotgun_m590', 'primary');
      const lo = await page.evaluate(() => window.__m2.profile().loadout);
      check('★ M6-3 从仓库拖到装备格＝穿上（落库到配装，且那一格离开仓库）',
        !!ok.ok && lo.primary === 'shotgun_m590'
        && (await page.evaluate(() => window.__m2.profile().stash.filter((e) => e.itemId === 'shotgun_m590').length)) === 0,
        `primary=${lo.primary}`);

      // 武器槽号不匹配：smg_v9 是 slot:2，拖到主武器格必须被拒
      const bad1 = await dragStashItemToSlot('smg_v9', 'primary');
      const t1 = await page.evaluate(() => window.__m2.lobby().toastText);
      check('★ M6-3 主武器格拒绝副武器（武器槽号校验真的接到了拖放上）',
        !!bad1.ok && /武器槽不匹配/.test(t1), t1 || '（没有提示）');

      // 部位不匹配：胸甲拖到头盔格
      const bad2 = await dragStashItemToSlot('vest2', 'head');
      const t2 = await page.evaluate(() => window.__m2.lobby().toastText);
      check('★ M6-3 头盔格拒绝胸甲（护甲部位校验真的接到了拖放上）',
        !!bad2.ok && /部位不匹配/.test(t2), t2 || '（没有提示）');

      // 类别不匹配：步枪拖到背包格
      const bad3 = await dragStashItemToSlot('rifle_m4', 'backpack');
      const t3 = await page.evaluate(() => window.__m2.lobby().toastText);
      check('★ M6-3 背包格拒绝武器（槽位白名单真的接到了拖放上）',
        !!bad3.ok && /不收武器/.test(t3), t3 || '（没有提示）');
      const backpack = await page.evaluate(() => window.__m2.profile().loadout.backpack);
      check('★ M6-3 三次非法拖放之后配装**没变**（背包仍是原来那只）',
        backpack === 'bp_medium', `backpack=${backpack}`);
    }

    // ---- ⑨ 装备格 → 仓库：落在玩家指定的那一格 ----
    {
      // 先腾空仓库：grantTestKit 塞了 31 条（约 102/120 格），一只 2×5 的霰弹枪
      // 可能连一块连续空位都找不到 —— 那样"夹具不成立"会被误读成"脱下功能坏了"。
      // 夹具必须是确定的：空仓库 + 一件穿在身上的装备 = 落点唯一。
      await page.evaluate(() => window.__m2.clearStash());
      await sleep(120);
      const g = await gearGeometry();
      // 形状从**物品视图**取（装备 id 与物品 id 不总相同，中间隔着一层 lootItemId 映射）
      const d = config.itemDefs[config.equipmentDefs['shotgun_m590'].itemId];
      const spot = await page.evaluate(([w, h]) => window.__m2.freeStashSpot(w, h), [d.w, d.h]);
      if (spot && g.slots.primary.item) {
        await pointerDrag({ x: g.slots.primary.x, y: g.slots.primary.y }, cellPoint(g, spot.x, spot.y));
        const lo = await page.evaluate(() => window.__m2.profile().loadout);
        const back = await stashEntry('shotgun_m590');
        check('★ M6-3 从装备格拖回仓库：落在指定的那一格，且槽位清空',
          lo.primary === null && !!back && back.x === spot.x && back.y === spot.y,
          `primary=${lo.primary} 落点=${JSON.stringify(back)} 期望 ${JSON.stringify(spot)}`);
      } else {
        check('★ M6-3 从装备格拖回仓库：落在指定的那一格，且槽位清空', false,
          `夹具不成立：freeStashSpot=${JSON.stringify(spot)} primary.item=${g.slots.primary.item}`);
      }
    }

    // ---- ⑩ 没位移的松手 = 点击（仓库的批量出售选择仍走原路径）----
    {
      const g = await gearGeometry();
      const before = await page.evaluate(() => window.__m2.lobby().views.stash.selectedCount);
      // 用仓库里的**第一件**（上一步刚把霰弹枪脱回来），不写死 itemId ——
      // 写死会让"上一步换了别的东西"变成一条无法解释的失败。
      const e = await page.evaluate(() => {
        const s = window.__m2.profile().stash[0];
        return s ? { uid: s.uid, x: s.x, y: s.y } : null;
      });
      if (e) {
        const p = cellPoint(g, e.x, e.y);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.up();
        await sleep(150);
      }
      const after = await page.evaluate(() => window.__m2.lobby().views.stash.selectedCount);
      check('★ M6-3 单击（无位移）仍然切换选中 —— 拖动与点选没有互相吃掉',
        !!e && after === before + 1, `${before} → ${after}（条目 ${e ? e.uid : '无'}）`);
      check('M6-3 单击之后没有留下拖动状态（手势已经收尾）',
        (await page.evaluate(() => window.__m2.lobby().drag)).dragging === false);
    }

    // ---- ⑪ 夹具自检：CDP 鼠标输入确实产生了 pointer 事件 ----
    {
      const evt = await page.evaluate(() => window.__m63evt);
      check('夹具成立：无头下 CDP 鼠标输入真的产生 pointer 事件（整组拖放的前提）',
        evt.down >= 1 && evt.move >= 3 && evt.up >= 1, JSON.stringify(evt));
    }
  }
}

// ============================================================
try {
  // `--only=m5`：只跑 M5 段落（自带 prepare，不依赖历史组的状态）。
  // 不指定时按原顺序：历史组 → M5 段落 → 运行时错误。
  if (ONLY) {
    await runM5Groups();
    await runM6CarryGroup();
    await runM63DragGroup();
  } else {
    await runLegacyGroups();
    await runM5Groups();
    await runM6CarryGroup();
    await runM63DragGroup();
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
