// 便携版构建：产出「解压即玩」的免安装包
//
// 要解决的核心问题：
//   Vite 默认产物用 `<script type="module">`，而浏览器**不允许 file:// 加载 ES 模块**
//   （模块请求受 CORS 限制，file:// 下必然失败）。所以直接把 dist/ 打包发给朋友，
//   双击只会看到空白页 + 控制台报 CORS 错。
//
// 解法：
//   1) 以 **IIFE** 格式重新打包（经典脚本，不受模块 CORS 限制）
//   2) 把 JS / CSS / 图标**全部内联**进单个 HTML
//      → 得到的 game.html 自包含、可直接双击、也不需要任何服务器
//   3) 本项目无外部素材（音频是程序化合成、贴图是 canvas 生成、无模型），
//      因此真正能做到"一个文件就是整个游戏"
//
// 用法：node tools/build-portable.mjs [--no-zip]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TMP = path.join(ROOT, '.portable-build');
const PKG_NAME = '搜打撤PVE-M3-免安装';
const RELEASE_DIR = path.join(ROOT, 'release');
const PKG_DIR = path.join(RELEASE_DIR, PKG_NAME);

const NO_ZIP = process.argv.includes('--no-zip');

function step(m) {
  console.log('  · ' + m);
}
function ok(m) {
  console.log('  ✓ ' + m);
}

// ---------------- 1) IIFE 打包 ----------------
console.log('\n================ 构建便携版（解压即玩）================\n');
step('以 IIFE 格式重新打包（绕开 file:// 的模块 CORS 限制）…');

fs.rmSync(TMP, { recursive: true, force: true });

await build({
  root: ROOT,
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.relative(ROOT, TMP),
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'game.js',
        assetFileNames: 'game.[ext]',
      },
    },
  },
});
ok('打包完成');

// ---------------- 2) 内联成单文件 ----------------
step('把 JS / CSS / 图标内联进单个 HTML…');

const distIndex = path.join(TMP, 'index.html');
if (!fs.existsSync(distIndex)) {
  console.error('  ✗ 找不到构建产物 index.html');
  process.exit(1);
}
let html = fs.readFileSync(distIndex, 'utf8');
const assetsDir = path.join(TMP, 'assets');
const assetDir = fs.existsSync(assetsDir) ? assetsDir : TMP;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}
const built = listFiles(TMP).filter((f) => f !== distIndex);

// 内联脚本。
//
// 关键点（这里踩过一次真实故障）：
//   原本的 `<script type="module">` **默认延迟执行**（defer 语义），所以脚本运行时
//   DOM 已经解析完，`document.getElementById('app')` 能拿到元素。
//   换成内联**经典**脚本后，它会**在解析到该位置时立即执行** ——
//   若仍留在 <head> 里，body 与 #app 都还不存在，
//   表现为 `Cannot read properties of null (reading 'appendChild')`，
//   整页白屏。
//   因此：**必须把脚本移到 </body> 之前**，让它拿到完整 DOM。
let inlinedJs = 0;
const collectedScripts = [];
html = html.replace(
  /<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>\s*<\/script>/gi,
  (m, src) => {
    const file = built.find((f) => f.endsWith(path.basename(src)));
    if (!file) return m;
    let code = fs.readFileSync(file, 'utf8');
    // 防止代码里出现 </script 提前闭合标签（标准做法）
    code = code.replace(/<\/script/gi, '<\\/script');
    collectedScripts.push(code);
    inlinedJs++;
    return ''; // 先从原位移除，稍后统一插到 body 末尾
  }
);

if (collectedScripts.length) {
  const scriptTags = collectedScripts.map((c) => `<script>${c}</script>`).join('\n');
  // ★ 必须用**函数**作为替换值，不能用字符串。
  //
  // 这里踩过一个非常隐蔽的坑：String.replace 的**字符串**替换值里，
  // 下面这些序列有特殊含义：
  //     $$   → 一个字面 $
  //     $&   → 匹配到的子串
  //     $`   → **匹配位置之前的全部内容**
  //     $'   → 匹配位置之后的全部内容
  //     $n   → 第 n 个捕获组
  // 而压缩后的 three.js 里恰好有一句 `$`（模板字符串内容就是一个美元符），
  // 于是替换时 `$\`` 把整个 HTML 前缀（含 `<!doctype html>`）注入了脚本内部，
  // 造成 `SyntaxError: missing ) after argument list`，页面白屏。
  // 用函数返回替换值就不会做任何 $ 解释。
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, () => `${scriptTags}\n</body>`);
  } else {
    html += '\n' + scriptTags;
  }
}

// 内联样式
let inlinedCss = 0;
html = html.replace(
  /<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+\.css)["'][^>]*>/gi,
  (m, href) => {
    const file = built.find((f) => f.endsWith(path.basename(href)));
    if (!file) return m;
    inlinedCss++;
    return `<style>${fs.readFileSync(file, 'utf8')}</style>`;
  }
);

// 图标转 data URI（同样用函数替换值，避免 $ 被当作特殊模式）
const faviconSrc = path.join(ROOT, 'public', 'favicon.svg');
if (fs.existsSync(faviconSrc)) {
  const svg = fs.readFileSync(faviconSrc, 'utf8');
  const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  const before = html;
  html = html.replace(
    /(<link\b[^>]*\brel=["']icon["'][^>]*?\bhref=["'])[^"']*(["'][^>]*>)/i,
    (m, p1, p2) => p1 + dataUri + p2
  );
  if (html === before) {
    console.log('  ! 未能内联 favicon（link 标签格式与预期不同），将保留外部引用');
    const tag = (before.match(/<link[^>]*rel=["']icon["'][^>]*>/i) || ['(未找到)'])[0];
    console.log('    实际标签: ' + tag);
  }
}

// 兜底：若仍有指向外部文件的引用，说明内联不完整 —— 必须报出来而不是默默发布
const leftovers = [...html.matchAll(/(?:src|href)=["'](?!data:|#|https?:)([^"']+)["']/gi)]
  .map((m) => m[1])
  .filter((v) => !v.startsWith('data:'));

ok(`内联脚本 ${inlinedJs} 个，样式 ${inlinedCss} 个`);
if (leftovers.length) {
  console.log('  ! 仍存在外部引用（file:// 下可能失败）：' + leftovers.join(', '));
} else {
  ok('无任何外部引用 —— 单文件自包含');
}

// 结构自检：脚本必须出现在 <body> 之后（否则页面会白屏，见上方那段说明）
{
  const bodyIdx = html.search(/<body[^>]*>/i);
  const scriptIdx = html.indexOf('<script>');
  if (scriptIdx < 0) {
    console.error('  ✗ 未找到内联脚本 —— 构建结果不可用');
    process.exit(1);
  }
  if (bodyIdx >= 0 && scriptIdx < bodyIdx) {
    console.error('  ✗ 内联脚本位于 <body> 之前，运行时会因 DOM 尚未解析而白屏');
    process.exit(1);
  }
  ok('结构自检通过：内联脚本位于 <body> 之后，DOM 已就绪');
}
// 不允许残留 type="module"（file:// 下会被 CORS 拦截）
if (/<script[^>]*type=["']module["']/i.test(html)) {
  console.error('  ✗ 仍存在 type="module" 脚本，file:// 下会加载失败');
  process.exit(1);
}
ok('结构自检通过：无残留 ES 模块脚本');

// 标题里标注版本，便于朋友确认拿到的是哪一版
html = html.replace(/<title>([^<]*)<\/title>/i, (m, t) => `<title>${t} · 便携版</title>`);

// ---------------- 3) 组装发布目录 ----------------
step('组装发布目录…');
fs.rmSync(PKG_DIR, { recursive: true, force: true });
fs.mkdirSync(PKG_DIR, { recursive: true });
fs.writeFileSync(path.join(PKG_DIR, 'game.html'), html, 'utf8');
ok(`game.html  ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB`);

// 备用启动器（内容必须是纯 ASCII：cmd 按 OEM 代码页读 .bat）
fs.writeFileSync(
  path.join(PKG_DIR, '启动游戏.bat'),
  [
    '@echo off',
    'REM Fallback launcher: opens game.html with the default browser.',
    'REM Keep this file ASCII-only (cmd reads .bat in the OEM code page).',
    'start "" "%~dp0game.html"',
    '',
  ].join('\r\n'),
  'utf8'
);
ok('启动游戏.bat');

const readme = `================================================================================
  H5 搜打撤 PVE —— 免安装便携版（M3 灰盒关卡）
================================================================================

【怎么玩】
  双击  game.html  即可。不需要安装任何东西，不需要联网，不需要 Node.js。
  若双击没反应，双击 启动游戏.bat（效果相同）。

  推荐使用 Chrome 或 Edge（本项目只针对桌面浏览器开发，未做移动端）。

--------------------------------------------------------------------------------
【操作】
  移动 / 视角      W A S D · 鼠标
  射击 / 开镜      鼠标左键 · 鼠标右键（按住开镜）
  切枪 / 换弹      1 主武器 · 2 副武器 · 滚轮 · R
  奔跑 / 蹲下      Shift / C（可在设置里改成「按住」或「切换」）
  跳跃             Space
  上下楼           走进楼梯（坡道）即可，不需要按键
  左右探头         Q / E（按住；射击会从探头位置出膛）
  搜索容器         靠近后按住 F
  医疗             3 绷带 · 4 急救包（使用中受击会被打断）
  暂停 / 设置      Esc 解锁鼠标后可打开设置
  撤离             走进绿色撤离区并停留

【玩法目标】
  进入战区 → 搜刮容器 → 与 AI 交战 → 带着战利品走到撤离点撤离。
  本版本是一张**上下两层**的室内图（电视台）：一层有安检大厅、货运通道、
  服务器机房与车库入口，二层有演播厅、控制室与天台出口，两层由两条楼梯相连，
  中庭是挑空的 —— 站在二层可以俯视一层，也可以从上往下打。
  撤离成功战利品才归你；阵亡或超时则本局所得全部损失。

--------------------------------------------------------------------------------
【已知问题（想知道可以看，不影响玩）】

1. 灰盒美术
   所有物体都是纯色方块（墙、楼板、掩体、AI），没有模型、贴图与动画。
   这一阶段验证的是关卡结构与玩法，美术在后续里程碑接入。

2. Shift + D 可能触发浏览器的「多选下载」
   原因：某些下载类浏览器扩展（实测为「迅雷下载支持」）把 Shift+D 绑定成了
   下载嗅探快捷键，而本游戏的「冲刺 + 右平移」正好是这个组合。
   网页无法拦截（扩展在页面脚本之前就注册了监听）。
   处理办法（任选其一）：
     · 在浏览器扩展管理里停用/移除「迅雷下载支持」这类下载扩展
     · 或把设置里的冲刺改掉（当前版本设置页还没做改键）
   如果你没装这类扩展，就不会遇到这个问题。

3. 请勿使用 Ctrl 组合键
   Ctrl+W 等是浏览器保留快捷键，页面无法拦截，会把标签页关掉。
   游戏本身没有把任何 Ctrl 组合绑定为操作键。

4. 无音效资源
   音频是程序化合成的（振荡器+噪声），能听出枪声/脚步/命中，
   但不是正式音效素材。

5. 关卡仍在迭代
   本版地图的"动线设计"（三条取舍不同的进攻路线）还没做；
   AI 开局都在一层，会自己沿楼梯上二层找人。

6. 还没有改键
   设置页能改灵敏度、奔跑/蹲下的按键方式等，但**不能自定义按键**。

--------------------------------------------------------------------------------
【数据与隐私】
  · 本游戏完全在本地浏览器里运行，不联网、不上传任何数据。
  · 只有「设置」会保存在浏览器本地存储里（每台机器独立）。
  · 没有账号、没有统计上报。

--------------------------------------------------------------------------------
【版本】
  版本号：v0.0.2
  阶段：M3（灰盒关卡改为地图表驱动；电视台式两层地图落地）
  构建时间：${new Date().toLocaleString('zh-CN')}
  单人 PVE，无联机、无内购。
================================================================================
`;
fs.writeFileSync(path.join(PKG_DIR, '说明.txt'), '\ufeff' + readme, 'utf8');
ok('说明.txt');

// ---------------- 4) 打包 zip ----------------
let zipPath = null;
if (!NO_ZIP) {
  step('压缩为 zip…');
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  zipPath = path.join(RELEASE_DIR, `${PKG_NAME}.zip`);
  fs.rmSync(zipPath, { force: true });
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${PKG_DIR}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0 || !fs.existsSync(zipPath)) {
    console.error('  ✗ 压缩失败（目录已生成，可手动压缩）');
    process.exit(1);
  }
  ok(`zip  ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB`);
}

// ---------------- 5) 汇总 ----------------
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n================ 发布内容 ================');
for (const f of fs.readdirSync(PKG_DIR)) {
  const st = fs.statSync(path.join(PKG_DIR, f));
  console.log(`  ${f.padEnd(20)} ${(st.size / 1024).toFixed(1)} KB`);
}
console.log('');
console.log(`  目录：${PKG_DIR}`);
if (zipPath) console.log(`  压缩包：${zipPath}`);
console.log('');
console.log('  朋友拿到 zip 后：解压 → 双击 game.html 即可开始，无需安装任何东西。');
