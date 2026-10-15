// 测试用浏览器启动器（各测试脚本共用）
//
// ---------------------------------------------------------------------------
// 为什么默认**无头**（headless）
//
// 原来的测试都跑有头浏览器，而本游戏需要指针锁定才能转视角。
// 指针锁定会**抓走鼠标并抢占窗口焦点** —— 结果就是跑一次测试期间，
// 电脑基本没法用（实测中有人因此不得不手动关掉测试窗口，
// 而那又会被上层记录成一次"页面异常关闭"的假故障）。
//
// 无头模式没有 OS 窗口，因此不存在"抢占"这回事。已实测确认无头下：
//   · WebGL 走 **硬件** GPU（ANGLE/D3D11），不是 SwiftShader 软件渲染
//   · 帧率约 120fps，与有头同量级，计时类断言不受影响
//   · **指针锁定可以成功**（没有 OS 窗口也能拿锁）
//   · CDP 派发的鼠标/键盘输入照常生效
//
// 需要人眼旁观时加 `--headed`：node tools/smoke.mjs --headed
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（tools/lib/ 往上两级） */
export const ROOT = path.resolve(HERE, '..', '..');

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome/Edge，可设置环境变量 CHROME_PATH 指定');
}

/** 是否要求有头（命令行含 --headed） */
export function wantsHeaded() {
  return process.argv.includes('--headed');
}

/** 命令行是否要求无头（含 --headless）；无头已是默认，此函数只为兼容旧调用 */
export function wantsHeadless() {
  return !wantsHeaded();
}

/**
 * 启动测试用浏览器。
 * @param {object} opts
 * @param {boolean} [opts.headed] 覆盖默认（默认跟随 --headed）
 * @param {number}  [opts.protocolTimeout]
 * @param {number}  [opts.width] / [opts.height]
 * @param {string[]}[opts.extraArgs] 追加的启动参数（例如性能测量需要的关垂直同步）
 */
export async function launchBrowser(opts = {}) {
  const headed = opts.headed ?? wantsHeaded();
  const width = opts.width ?? 1280;
  const height = opts.height ?? 860;

  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    // 保证后台标签页/被遮挡窗口不被降频 —— 无头下同样需要，
    // 否则 rAF 会被节流，按墙钟时间等待的断言会"等不够"
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  if (!headed) {
    // 让无头也走硬件 GPU：软件渲染帧率会低一个量级，计时类断言会失真
    args.push('--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist');
  }
  if (opts.extraArgs) args.push(...opts.extraArgs);

  return launch({
    executablePath: findChrome(),
    headless: headed ? false : 'new',
    defaultViewport: headed ? null : { width, height },
    args,
    protocolTimeout: opts.protocolTimeout ?? 900000,
  });
}

/** 打印当前使用的模式，便于在日志里确认 */
export function describeMode(headed = wantsHeaded()) {
  return headed
    ? '有头 headed（会抢占鼠标与焦点，仅供旁观调试）'
    : '无头 headless（默认，不影响你使用电脑）';
}

/**
 * 让被测页面**不要真的去捕获指针**，但游戏仍然按"已锁定"运行。
 *
 * 为什么需要它（真实困扰）：本游戏要转视角就得锁定指针，而指针锁定会把**用户的鼠标**
 * 从桌面抢走 —— 表现为测试一跑、鼠标就不听使唤（无头模式下看不到窗口，但锁定照样成立）。
 * 于是"跑一次冒烟测试"变成"这台电脑没法用了"，而测试本身要跑好几分钟。
 *
 * 为什么不能只把 requestPointerLock 改成空函数：
 *   main.js 的暂停规则是"局内 + 指针没锁 → 暂停"。锁不上就会被判成"玩家切出去了"，
 *   游戏立刻冻结、所有断言全废。所以必须**同时**让游戏看到"锁上了"。
 *
 * 做法（只动浏览器 API 的表面，不动游戏代码）：
 *   · requestPointerLock 不转发给浏览器（于是真正不抢鼠标），改为同步派发
 *     pointerlockchange，并在派发期间让 document.pointerLockElement 指向该元素
 *     —— input.js 的 onLockChange 正是据此把 pointerLocked 置为 true 的；
 *   · 派发完立刻把 document.pointerLockElement 恢复（delete 掉），
 *     并把随后异步到达的 pointerlockerror 吞掉
 *     （真实浏览器在上面那次请求失败后确实会发它，不吞会污染"无页面异常"类断言）。
 *
 * 这**不是**在测一个假游戏：输入层读到的仍是真实的 pointerlockchange 事件，
 * 只是这个事件由我们自己合规地产生。需要真实指针锁定的场景（例如人眼旁观
 * `--headed`）用 `DSH_REAL_POINTER_LOCK=1` 关掉本替身。
 *
 * @param {import('puppeteer-core').Page} page
 */
export async function suppressPointerLock(page) {
  if (process.env.DSH_REAL_POINTER_LOCK === '1' || process.env.DSH_REAL_POINTER_LOCK === 'true') {
    console.log('  （DSH_REAL_POINTER_LOCK 已设置：本次不替换指针锁定，鼠标可能被捕获）');
    return;
  }
  await page.evaluateOnNewDocument(() => {
    const proto = Element.prototype;
    const realRequest = proto.requestPointerLock;
    if (typeof realRequest !== 'function') return;

    // 替身要**持续**维持"已锁定"这个状态，而不是只在事件派发的那一瞬。
    // 原因：测试会直接查 `document.pointerLockElement !== null`（有 3 处断言依赖它，
    // 用于等待"指针锁定已拿到"）。只在派发瞬间假装锁定的话，那些断言会红。
    let fakeEl = null;

    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => fakeEl,
    });

    // 与真实实现一样：exitPointerLock 之后要发 pointerlockchange，
    // 否则 input.js 的 onLockChange 不会把 pointerLocked 置回 false，
    // 游戏就会以为还锁着 —— "回大厅后暂停"那条链路会失效。
    const realExit = document.exitPointerLock;
    document.exitPointerLock = function patchedExitPointerLock() {
      const was = fakeEl;
      fakeEl = null;
      if (was) {
        try {
          document.dispatchEvent(new Event('pointerlockchange'));
        } catch {
          /* 忽略 */
        }
      }
      if (typeof realExit === 'function') {
        try { realExit.call(document); } catch { /* 浏览器侧本来就没锁上 */ }
      }
    };

    proto.requestPointerLock = function patchedRequestPointerLock() {
      fakeEl = this; // 浏览器侧**不转发**：真正不抢鼠标
      try {
        document.dispatchEvent(new Event('pointerlockchange'));
      } catch {
        /* 忽略 */
      }
      return Promise.resolve();
    };

    // 真实浏览器在这次"请求"后会异步发 pointerlockerror（因为浏览器侧根本没锁上）。
    // 在捕获阶段拦掉，不让它进到游戏的监听器里。
    document.addEventListener(
      'pointerlockerror',
      (e) => e.stopImmediatePropagation(),
      true
    );
  });
}
