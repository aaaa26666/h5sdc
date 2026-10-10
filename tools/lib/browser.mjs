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
