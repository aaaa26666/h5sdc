// 便携版实测：验证「解压即玩」在 file:// 下真的成立
//
// 为什么必须单独测：便携版是**生产构建**，里面没有 window.__m2 调试接口，
// 所以只能靠真实输入 + 读 HUD 来验证。而且 file:// 有几个真实风险点：
//   · ES 模块被 CORS 拦截（已用 IIFE 规避，需验证）
//   · 指针锁定是否可用（无指针锁定 = 玩家无法转视角 = 不能玩）
//   · localStorage 是否被 file:// 禁用（设置能否保存）
//   · Web Audio 是否可用
//
// 关键：**不加任何特殊 Chrome 参数**（不用 --allow-file-access-from-files），
// 因为朋友的机器上也不会有这些参数。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { launchBrowser, describeMode, ROOT as REPO_ROOT } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = REPO_ROOT;
// 允许指定路径：这样可以测试"解压出来的那一份"，而不是只测构建目录里的原件
const pathArg = process.argv.slice(2).find((a) => !a.startsWith('--'));

/**
 * 缺省目标：release/ 下**任何一个**已构建的包里去找 game.html。
 *
 * 原先这里写死了包名（`搜打撤PVE-M2-免安装`），于是包名一升级（M2 → M3）
 * 这个自检就静默地指向一个不存在的路径 —— 它不会报"配置过期"，
 * 只会报"文件找不到"，看起来像打包坏了。改成自动发现，包名再变也不用动这里。
 */
function findDefaultGame() {
  const rel = path.join(ROOT, 'release');
  try {
    for (const d of fs.readdirSync(rel, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(rel, d.name, 'game.html');
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* release/ 不存在时走下面的兜底 */
  }
  return path.join(rel, 'game.html');
}

const GAME = pathArg ? path.resolve(pathArg) : findDefaultGame();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? '' });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

if (!fs.existsSync(GAME)) {
  console.error('找不到便携版：' + GAME + '\n请先运行 node tools/build-portable.mjs --no-zip');
  process.exit(2);
}

const url = pathToFileURL(GAME).href;
console.log('\n================ 便携版 file:// 实测 ================');
console.log('  文件: ' + GAME);
console.log('  URL : ' + url);
console.log(`  运行模式: ${describeMode()}`);
console.log('  （不附加任何 Chrome 特殊参数，与朋友机器一致）\n');

const browser = await launchBrowser({ protocolTimeout: 120000 });

const page = await browser.newPage();
const errors = [];
const consoleMsgs = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  consoleMsgs.push(`[${m.type()}] ${m.text()}`);
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await sleep(1500);

  // ---- 1) 是否被 CORS / 模块问题挡住 ----
  const corsIssues = errors.filter((e) => /cors|module|origin|access to script/i.test(e));
  check('file:// 下没有 CORS / 模块加载错误', corsIssues.length === 0,
    corsIssues.slice(0, 2).join(' | ') || '无');

  const title = await page.title();
  check('页面加载成功且标题正确', /搜打撤/.test(title), title);

  const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'));
  check('渲染画布已创建（游戏脚本已执行）', hasCanvas);

  const secure = await page.evaluate(() => window.isSecureContext);
  check('file:// 被视为安全上下文（指针锁定的前提）', secure === true, `isSecureContext=${secure}`);

  // ---- 2) localStorage 行为（设置能否保存）----
  const lsOk = await page.evaluate(() => {
    try {
      localStorage.setItem('__probe', '1');
      const v = localStorage.getItem('__probe');
      localStorage.removeItem('__probe');
      return { ok: v === '1' };
    } catch (e) {
      return { ok: false, err: e.name + ': ' + e.message };
    }
  });
  check('localStorage 可用（设置可保存）', lsOk.ok,
    lsOk.ok ? '可用' : `不可用 —— ${lsOk.err}（设置将不会保存，但游戏仍可玩）`);

  // ---- 3) Web Audio 可用性（需用户手势后才会 running）----
  const audioApi = await page.evaluate(() => typeof (window.AudioContext || window.webkitAudioContext) === 'function');
  check('Web Audio API 可用', audioApi);

  // ---- 4) ★ 新账号先按**玩家真实路径**买出第一套装备 ----
  //
  // 为什么必须有这一步（不是为了"让测试变绿"而加的补丁）：
  //   M6 起局内只装"仓库真的拿得出来的东西"（core/loadout.js 的 effectiveLoadout，见 docs/19 §4.2），
  //   而制作人裁定**新账号仓库为空**（装备要自己买）。两者相乘的结果是：不买装备直接进战区
  //   就是**空手**，于是"真实鼠标射击使弹匣减少"和"HUD 武器信息正常显示"两条断言必然失败
  //   —— 而它们的失败信息是 `0 / 0` / `空手`，看起来像"射击坏了"，实际是"没枪"。
  //
  // [M6-BUG-05] 这条断言此前**从未真正跑过 M6 的行为**：便携版产物（release/…/game.html）
  //   是 M5 时构建的、之后一直没重建，而本脚本只测那份**已存在的产物**。
  //   M5 的 raidKit 不看仓库，所以"空手进局"这个 M6 的新事实被一份陈旧产物掩盖了 ——
  //   测试是绿的，被测的东西却不是当前代码。重建产物后它立刻红了（实测 12/14）。
  //
  // 生产构建里没有 __m2 夹具可用，所以这里走**商店 UI**（玩家唯一的路径）。
  // 起始预设里本来就写着 secondary=pistol_p9 + 9mm 60 发，因此买这两件就够 ——
  // 这同时验证了 README 那句"新账号先去商店买一套基础装备再进战区"真的成立。
  await page.click('#lobbyTabs .tab[data-tab="shop"]');
  await sleep(150);
  const curBefore = await page.$eval('#tabShop', (e) => {
    const m = e.innerText.match(/货币\s*(\d+)/);
    return m ? Number(m[1]) : null;
  });
  const buy = await page.evaluate(() => {
    const out = {};
    for (const ref of ['pistol_p9', 'pistol_mag']) {
      const btn = document.querySelector(`#tabShop .mini[data-act="shopBuy"][data-ref="${ref}"]`);
      out[ref] = !!btn;
      if (btn) btn.click();
    }
    return out;
  });
  await sleep(250);
  const curAfter = await page.$eval('#tabShop', (e) => {
    const m = e.innerText.match(/货币\s*(\d+)/);
    return m ? Number(m[1]) : null;
  });
  check('★ 新账号能在商店买到第一把枪与一盒弹（"仓库为空"这条裁定唯一的出路）',
    buy.pistol_p9 && buy.pistol_mag, JSON.stringify(buy));
  check('★ 买入真的扣了钱（面板读数下降，不是"按钮在但没生效"）',
    Number.isFinite(curBefore) && Number.isFinite(curAfter) && curAfter < curBefore,
    `货币 ${curBefore} → ${curAfter}`);

  // ---- 5) 点击进入战区 ----
  await page.click('#btnStart');
  await sleep(1200);
  const hudOn = await page.evaluate(() => document.getElementById('hud').classList.contains('on'));
  const startGone = await page.evaluate(() => !document.getElementById('screenLobby').classList.contains('on'));
  check('点击「进入战区」后 HUD 出现、大厅关闭', hudOn && startGone, `hud=${hudOn} lobbyGone=${startGone}`);

  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  check('指针锁定生效（能转视角）', locked === true, locked ? '已锁定' : '未锁定 —— 将无法转视角');

  // ---- 5) 游戏循环是否真的在跑（读 HUD 倒计时）----
  const t1 = await page.$eval('#timeText', (e) => e.textContent);
  await sleep(2500);
  const t2 = await page.$eval('#timeText', (e) => e.textContent);
  check('局内倒计时在推进（主循环运行中）', t1 !== t2, `${t1} → ${t2}`);

  // ---- 6) 真实射击：弹匣应减少 ----
  const a1 = await page.$eval('#ammoText', (e) => e.textContent);
  await page.mouse.down({ button: 'left' });
  await sleep(900);
  await page.mouse.up({ button: 'left' });
  await sleep(300);
  const a2 = await page.$eval('#ammoText', (e) => e.textContent);
  const n1 = parseInt(a1, 10);
  const n2 = parseInt(a2, 10);
  check('真实鼠标射击使弹匣减少', Number.isFinite(n1) && Number.isFinite(n2) && n2 < n1, `${a1} → ${a2}`);

  // ---- 7) 移动 + 探头 + 开镜 不应报错 ----
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await sleep(700);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyQ');
  await sleep(300);
  await page.keyboard.up('KeyQ');
  await page.mouse.down({ button: 'right' });
  await sleep(500);
  const fovText = await page.$eval('#weaponText', (e) => e.textContent);
  await page.mouse.up({ button: 'right' });
  await sleep(300);
  check('移动/冲刺/探头/开镜 组合操作未报错', errors.length === 0,
    errors.slice(0, 2).join(' | ') || '无错误');
  check('HUD 武器信息正常显示', /M4|P9|手枪|步枪/.test(fovText), fovText);

  // ---- 8) 生产构建不含调试接口（便携版同样成立）----
  const hasDebug = await page.evaluate(() => typeof window.__m2 !== 'undefined' || typeof window.__m1 !== 'undefined');
  check('便携版不含调试接口', hasDebug === false);

  // ---- 9) 汇总页面错误 ----
  const real = errors.filter((e) => !/favicon/i.test(e));
  check('整体运行无页面异常', real.length === 0, real.slice(0, 3).join(' | ') || '无');
} catch (e) {
  check('测试执行未中断', false, e.message);
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n================ 结果：${passed} / ${results.length} 通过 ================`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  [FAIL] ${f.name}${f.detail ? ' —— ' + f.detail : ''}`);
  console.log('\n完整控制台消息（末尾 15 条）：');
  for (const m of consoleMsgs.slice(-15)) console.log('  ' + m);
}
process.exit(failed.length ? 1 : 0);
