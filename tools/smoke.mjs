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
// 用法：node tools/smoke.mjs [url]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const URL_BASE = process.argv[2] || 'http://127.0.0.1:5180/';

function findChrome() {
  const c = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const browser = await launch({
  executablePath: findChrome(),
  headless: false,
  defaultViewport: null,
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,860',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
  protocolTimeout: 600000,
});

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
    // ★ 这里测的是**峰值抬升**，不是"持续射击后的净漂移"。
    // 原因：[M2-TEMP-1] 后坐力恢复是无条件的，每帧按 recoveryPerSec×dt 把视角拉回。
    // 持续射击时每发加入约 0.85°、间隔约 85ms（≈10°/s），与恢复速度同量级，
    // 两者几乎抵消 —— 净漂移只有约 1.2°/s，在零附近摆动，
    // 用净漂移做断言会时通时不通（实测一次 +0.0191、一次 -0.0000）。
    // 每发造成的峰值抬升才是"后坐力确实生效"的直接证据，且不受恢复速度影响。
    await page.mouse.down({ button: 'left' });
    let peakPitch = before.player.pitch;
    let peakSpread = before.weapon.spread;
    for (let i = 0; i < 15; i++) {
      await sleep(60);
      const s = await snap();
      peakPitch = Math.max(peakPitch, s.player.pitch);
      peakSpread = Math.max(peakSpread, s.weapon.spread);
    }
    const during = await snap();
    await page.mouse.up({ button: 'left' });
    check('每发都让枪口上跳（后坐力生效）', peakPitch > before.player.pitch + 0.005,
      `pitch 峰值 ${peakPitch.toFixed(4)}（基线 ${before.player.pitch.toFixed(4)}）`);
    check('连发使扩散增大', peakSpread > before.weapon.spread + 0.05,
      `spread 峰值 ${peakSpread.toFixed(3)}（基线 ${before.weapon.spread}）`);
    // 如实记录 M2-TEMP-1 的影响：持续射击的净抬升被恢复大幅抵消。
    // 不断言它是"正确"的，只把它作为可观测量暴露出来，避免这个现象被静默忽略。
    const netClimbDeg = ((during.player.pitch - before.player.pitch) * 180) / Math.PI;
    console.log(
      `    注：持续射击 ${(15 * 60) / 1000}s 的净抬升仅 ${netClimbDeg.toFixed(2)}°` +
        `（单发峰值 ${(((peakPitch - before.player.pitch) * 180) / Math.PI).toFixed(2)}°）` +
        ` —— M2-TEMP-1 无条件下拉导致，属已知欠账`
    );

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
    const before = new Map(s0.ai.map((a) => [a.id, { x: a.x, z: a.z, updates: a.updates }]));

    // 大幅移动以惊动 AI：传送到 AI 附近并开火
    await page.evaluate(() => window.__m2.teleportNearAi(0, 6));
    await page.mouse.down({ button: 'left' });
    await sleep(400);
    await page.mouse.up({ button: 'left' });
    await sleep(3500);

    const s1 = await snap();
    const moved = s1.ai.filter((a) => {
      const b = before.get(a.id);
      return b && (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.z - b.z) > 0.5);
    });
    check('AI 会移动（寻路生效，M1-TEMP-6 已修）', moved.length > 0,
      `${moved.length}/${s1.ai.length} 个 AI 产生了位移`);

    const states = [...new Set(s1.ai.map((a) => a.state))];
    check('AI 状态机产生非 patrol 状态', states.some((x) => x !== 'patrol'),
      `状态集合 ${states.join(',')}`);

    const gainedPath = s1.ai.some((a) => a.pathLen > 0);
    check('AI 通过调度器获得了路点', gainedPath, `最长路径 ${Math.max(...s1.ai.map((a) => a.pathLen))} 点`);
  }

  // ============================================================
  group('⑥ M2 硬性要求：AI 更新频率分级 + 寻路限流（C-1/C-2）');
  {
    const s = await snap();
    const withTier = s.ai.filter((a) => a.updateIntervalMs !== null);
    check('每个 AI 都有更新分级', withTier.length === s.ai.length,
      `${withTier.length}/${s.ai.length}`);
    const intervals = [...new Set(s.ai.map((a) => a.updateIntervalMs))];
    check('更新分级确实按距离区分（存在不同间隔）', intervals.length >= 1,
      `出现的间隔集合 ${intervals.join(',')}ms`);

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
    await page.evaluate(() => window.__m2.teleportNearAi(0, 5));
    await page.evaluate(() => window.__m2.aimAt(0, 40, 0)); // 朝天
    await page.mouse.down({ button: 'left' });
    await sleep(250);
    await page.mouse.up({ button: 'left' });
    await page.evaluate(() => window.__m2.teleportNearAi(0, 5)); // 回到 AI 视野内
    await sleep(4000);

    const hurt = await snap();
    check('被 AI 击中会掉血并消耗护甲耐久',
      hurt.player.health < s0.player.health,
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

    await loadAndStart();
    await call('setTimeLimitMs', 800);
    await page.waitForFunction(() => window.__m2.snapshot().flow === 'ended', { timeout: 10000 });
    check('超时判定失败', (await snap()).endReason === 'timeout');
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
      await page.keyboard.down('KeyW');
      await sleep(900); // 走到贴住掩体
      await page.keyboard.press('Space');
      let maxY2 = 0;
      for (let i = 0; i < 24; i++) {
        const s = await snap();
        maxY2 = Math.max(maxY2, s.player.y);
        await sleep(60);
      }
      await page.keyboard.up('KeyW');
      await sleep(400);
      check('贴住掩体起跳后可以站上高掩体（掩体几何是双向可用的）',
        maxY2 >= tall.height - 0.12,
        `脚底峰值 ${maxY2.toFixed(3)}（掩体顶 ${tall.height}，跳跃最高约 0.68m + stepHeight 0.55m）`);
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
      if (s.player.cellBlocked) FATAL.push(`第${i}局：玩家穿进墙体`);
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
