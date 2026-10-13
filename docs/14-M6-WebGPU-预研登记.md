# M6-WebGPU 平行预研登记

> 本文是**登记条目**，不是变更申请，也不是结论。
> 目的是让后续会话知道"有这么一份预研、它在哪里、它改变了什么、还需要走什么流程"。

## 登记内容

| 项 | 内容 |
|---|---|
| 名称 | M6-WebGPU 平行预研（换渲染后端） |
| 位置 | `G:/H5/m6-webgpu/`（整仓副本，已排除 `m0-bench/`、`m0-bundle/`） |
| 报告 | `G:/H5/m6-webgpu/docs/14-M6-WebGPU-预研报告.md` |
| 技术口径 | 由 `WebGLRenderer` 换为 `three/webgpu` 的 `WebGPURenderer`（**同一套 three 0.186.1**，非原生 WebGPU 重写） |
| 起点 | 主项目 M6 缺陷修复完成之后、内容扩充之前 |

## 治理口径（重要）

- **本文不主张更换已选引擎。** `docs/01-技术选型结论.txt` §7.3 的冻结项
  「渲染引擎（Three.js 0.186.1）」**未被改动**，也未被主张改动。
- 本次预研对主项目的**唯一写入就是本文件**（新增）。主项目 `src/`、`tools/`、
  其余 `docs/`、配置文件**一行未动**。
- 决策依据（原文）：`docs/01 §7.2`「提出 → 影响评估（工作量/返工范围/排期影响）
  → 制作人与主程签字 → 更新本文档版本」；《流程文档》第 14 章 `R01`
  「M0 一次性验证并签字锁定，禁止中途更换」；`docs/DSH全流程分步约束词手册.txt:89`
  「技术栈：已锁定于《流程文档》第 3 章，禁止擅自更换引擎、框架、构建工具」。
- 因此：预研成果若要回到主项目，**必须先走 §7.2 并取得签字**。
  在此之前，`m6-webgpu/` 的结论对主项目**不生效**。

## 预研已经改变的事（供后续引用时知情）

预研报告给出了四条会影响后续决策的**实测**数字：

1. **首包 brotli 由 186.6 KB 增至 248.4 KB（+61.8 KB，+33.1%），超 200 KB 门禁 48.4 KB。**
   该 200 KB 来自 `docs/01` 约束 C-13 与 `tools/measure-bundle.mjs:17`。
2. **无头 Chromium 零 flag 即可跑 WebGPU**（硬件后端 `ampere`），`http://` 与 `file://` 均通
   —— 即"换后端会让自动化验证失效"这一顾虑**不成立**；但 `--use-angle=vulkan` 会让
   `requestAdapter()` 返回 null，**不要给无头加这个 flag**。
3. **画面实质一致**：大厅截图逐像素完全相同（0/1,100,800 差异像素），
   进战区 454 像素不同（0.0412%）。纯逻辑单测 **492/492** 全绿。
   **帧率在本场景下测不出差异**（两条后端都撞在 ≈165fps 的 rAF 上限），
   报告已明确声明"不得据此声称 WebGPU 性能更好"。
4. **全量端到端冒烟已跑，最终 254 / 254 全绿**（`results/smoke-webgpu-fixed.log`）。
   首轮 243/254，11 条失败**全部定位并修掉**，且两类成因都值得主项目知道：
   - **10 条是被破坏的时序契约**：把 `showLobby()` 挪进 `renderer.init().then()`
     会造出"调试夹具已可用、大厅还是空的"窗口。契约是
     **`window.__m2` 可用 ⇒ 大厅已渲染**；需要等 GPU 的只有渲染，不是 DOM 渲染。
   - **1 条是原代码里 WebGL 专属的手法**：`src/render/quality.js` 为强制重建阴影贴图而
     `sun.shadow.map.dispose()`。WebGL 下必需（只在 map 为 null 时才重建），
     但 WebGPU 下贴图由 `ShadowNode` 每帧 `setSize`（`ShadowNode.js:648`），
     手动 dispose 会销毁**在途**贴图并抛 `GPUValidationError: Destroyed texture`。
     修法是收进能力判据 `'needsUpdate' in renderer.shadowMap`。

## 后续动作（按 §7.2）

若决定推进，剩余适配为：首包预算重定或代码分割、`verify-prod-bundle` 后端标记更新、
`m1-perf` 后端探测改造（现读 `WEBGL_debug_renderer_info`，WebGPU 下无效）、
兼容性矩阵（流程文档 §9.4）重述。
**端到端回归已完成（254/254），不再是未知项**；`smoke` 的 M5-8 画质组实测无需改动，
但它守不住"阴影贴图真的换了尺寸"，该断言由预研探针 `tools/probe-webgpu-shadow.mjs` 补上。

## 复核方式

```bash
cd G:/H5/m6-webgpu
node tools/probe-webgpu-capability.mjs     # 无头 WebGPU 能力（flag 对照）
node tools/unit-tests.mjs                   # 纯逻辑 492/492
node tools/smoke.mjs                        # 端到端 254/254（自管端口，约 4 分钟）
node tools/probe-webgpu-shadow.mjs          # 阴影档位真生效 + 无 GPU 校验错误
node tools/probe-webgpu-render.mjs --serve dist --port 5189 --label webgpu-build --seconds 8
```
