# m0-bench —— M0 一次性技术验证台

> 本目录是 M0 阶段的**一次性验证代码**，不属于游戏产物。
> 按《H5_3D搜打撤射击游戏_工作流程文档》M0 阶段约定：验证代码用完即弃，禁止在此目录发展"未来会用到"的框架。
> M0 结束后可整体删除。

---

## 1. 目录结构

```
m0-bench/
├── package.json          依赖清单（puppeteer-core / three / babylonjs）
├── server.mjs            一次性静态服务（映射 /vendor/ 到 node_modules）
├── scenes/
│   ├── spec.json         等价场景规格 —— 两端引擎读取同一份，保证可比性
│   ├── bench.js          共享测量口径 + 确定性布局 + 帧预算判定
│   ├── three/            引擎对比场景 · Three.js 端
│   ├── babylon/          引擎对比场景 · Babylon.js 端（引擎已选定 Three.js，此端已冻结不再维护）
│   └── ai/               M0-5 AI 寻路与同屏数量压测场景
│       ├── nav.js        网格 / A* / 流场 / 视线检测（纯逻辑，无 DOM 依赖）
│       ├── scene.js      压测场景装配
│       └── index.html
├── harness/
│   └── run.mjs           测试驱动：起服务 → 起 Chrome → 按矩阵跑 → 汇总落盘
└── results/              实测输出（raw-*.json / summary-*.csv / raw-*.csv）
```

---

## 2. 怎么跑

```bash
# 引擎对比场景（M0-3，已终止，仅存档）
node harness/run.mjs --engines three,babylon --mat pbr --sync off,on --vsync on

# AI 压测（M0-5）
node harness/run.mjs --engines ai --agents 50,100,200,300,400 \
  --throttle 1,4,6 --vsync off --sync off --warmup 2 --duration 6 --repeats 2
```

### 命令行参数

| 参数 | 含义 |
|---|---|
| `--engines three,babylon,ai` | 被测场景（目录名），ai 为 AI 压测场景 |
| `--agents 50,100,200` | **仅 ai 场景**：同屏 Agent 数量扫描 |
| `--mat pbr,cheap` | 材质对照：pbr=标准 PBR；cheap=两端同时降级为非 PBR |
| `--sync off,on` | on=每帧 `gl.finish()` 等 GPU（测真实 GPU 耗时）；off=仅测 CPU 提交 |
| `--vsync on,off` | on=保留垂直同步；off=解除锁帧测吞吐 |
| `--gpu default,swiftshader` | default=独显；swiftshader=软件渲染模拟低端 |
| `--throttle 1,4,6` | CDP CPU 节流倍数（模拟低端 CPU） |
| `--warmup 3` / `--duration 20` | 预热秒数 / 采样秒数 |
| `--repeats 3` | 每组合重复次数（汇总取中位数） |
| `--headless` | 无头模式（默认有头；有头数据更接近真实体验） |

---

## 3. 目标机实测环境（M0-1 采集结果）

| 项 | 实测值 |
|---|---|
| OS | Windows 11 专业版 10.0.26200 (64-bit) |
| CPU | Intel Core i5-13600KF，14 物理核 / 20 逻辑核 |
| 内存 | 31.8 GB |
| GPU | NVIDIA GeForce RTX 3060（WMI 报 4095MB 为 32 位字段溢出，实际 12GB） |
| 显示器 | AOC 27"，**刷新率 165 Hz** |
| 分辨率 | 1920 x 1080，单屏 |
| Chrome | 153.0.8010.53 |
| Edge | 136.0.3240.92 |
| Node / npm | v24.15.0 / 11.12.1 |
| 实测 WebGL 渲染器 | `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, Direct3D11 vs_5_0 ps_5_0, D3D11)` |

> **存在的第二 GPU**：`MuMu Virtual Display Adapter`（模拟器虚拟显示适配器）。
> 测试台已用 `--force_high_performance_gpu` 并回读 WebGL renderer 字符串确认每次实测都落在 RTX 3060 上，未误测到虚拟适配器。

---

## 4. 测量口径定义

| 指标 | 定义 |
|---|---|
| `avgFps` | 采样窗口内帧数 / 窗口时长 |
| `frameP50/P95/P99` | 逐帧间隔的分位数 |
| `low1Fps` | 最慢 1% 帧的平均帧时间折算出的帧率 |
| `cpuP50/P95` | `step()` 回调自身的 CPU 耗时（不含 GPU 异步完成时间） |
| `frameP95` → 帧预算 | 16.67ms=60fps，22.22ms=45fps，33.33ms=30fps |
| `capped` | 该组结果是否只是被刷新率锁住（此时 FPS 不能用于比较吞吐） |

**判定以帧时间为准，不以 FPS 为准。** FPS 会被刷新率、锁帧、异步流水掩盖真实性能。

---

## 5. 已发现的测量陷阱（重要，读数据前必看）

### 陷阱 1：本机显示器是 165Hz，`vsync=on` 锁的是 165 不是 60
两端 FPS 都精确停在 165.01 —— 这个数字**不能**用来说明谁更快，只能说明谁都没跑满。
`capped=YES` 的行必须改用 `frameP95` 与帧预算对比来判定。

### 陷阱 2：`vsync=off` 且不开 `--sync on` 时，测的是 CPU 提交吞吐，不是 GPU 能力
实测 `frameP95 ≈ cpuP95`（three 0.9≈0.8ms，babylon 4.4≈4.1ms），说明 GPU 工作被完全流水化、未阻塞提交。
此时得到的 FPS（three 1253 / babylon 500）**不得**表述为"可达到的帧率"。
需要真实 GPU 耗时请加 `--sync on`（每帧 `gl.finish()`）。

### 陷阱 3：Chrome 默认把 `performance.now()` 精度限制到 100µs
实测表现：AI 压测里 `pf` 与 `los` 的每帧耗时全部量成 `0` —— 因为真实开销低于计时器分辨率。
**修复**：静态服务已加 `Cross-Origin-Opener-Policy: same-origin` 与
`Cross-Origin-Embedder-Policy: require-corp` 开启跨源隔离，实测分辨率恢复到 **0.005ms（5µs）**。
每次实测都会回读 `timerResMs`，若该值回到 0.1 说明隔离失效，数据不可信。

### 陷阱 4：低于计时器分辨率的操作必须用批量微基准测
即使精度提升到 5µs，单次 93ns 的视线射线仍然测不准。
`window.__benchMicro()` 采用"批量执行 N 次再相除"的方式，得到与计时器分辨率无关的单次成本。
**这是 M0-5 结论的权威数据来源**，per-frame 累加计时只作为交叉验证。

### 陷阱 5：AI 成本是尖峰型，P95 会把尖峰平均掉
100 个 Agent 错峰重规划时，每帧寻路 P95 量成 0；但**最坏帧（max）是 1.85ms** ——
正好等于 100 × 单次 A* 成本，即"全体同时重规划"的场景。
因此必须同时报告 `pfMax` / `losMax`。

### 陷阱 6：等价场景存在无法消除的不可比项
- 阴影算法：Three 用 PCFSoft，Babylon 用 PCF
- 材质模型：Three `MeshStandardMaterial` vs Babylon `PBRMaterial`（后者实现更重）
- 粒子点尺寸单位：Three 为世界单位，Babylon 为像素
- Three r167+ 把核心拆到 `three.core.js`，服务端需一并映射

---

## 6. 依赖说明

| 包 | 版本 | 用途 | 是否进入游戏产物 |
|---|---|---|---|
| `puppeteer-core` | 25.13.0 | 浏览器自动化与 CDP 节流 | 否 |
| `three` | 0.186.1 | 被测引擎（已选定） | 是 |
| `babylonjs` | 9.30.0 | 被测引擎（已放弃） | 否 |

`puppeteer-core` 而非 `puppeteer`：前者不下载自带浏览器，直接复用本机 Chrome 153，避免额外占用磁盘。
安装源使用 `https://registry.npmmirror.com`（`registry.npmjs.org` 在本机不可达）。
