// M0-2 共享测量与布局模块。
// 两个引擎场景必须使用本文件提供的同一套确定性布局与同一套测量口径，
// 否则两端数据不可比。用完即弃，不属于游戏产物。

/** 确定性伪随机，保证每次运行场景布局完全一致 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 依据规格生成确定性的场景布局参数，两端各自据此建 Mesh */
export function buildLayout(spec) {
  const rnd = mulberry32(spec.seed);
  const range = (a, b) => a + rnd() * (b - a);

  const obstacles = [];
  for (let i = 0; i < spec.staticObstacles.count; i++) {
    const s = spec.staticObstacles.spread;
    obstacles.push({
      x: range(-s, s),
      z: range(-s, s),
      h: range(spec.staticObstacles.heightMin, spec.staticObstacles.heightMax),
      w: spec.staticObstacles.footprint,
      rotY: range(0, Math.PI),
    });
  }

  const dynamics = [];
  for (let i = 0; i < spec.dynamicBodies.count; i++) {
    dynamics.push({
      radius: range(spec.dynamicBodies.orbitRadiusMin, spec.dynamicBodies.orbitRadiusMax),
      angleSpeed: range(spec.dynamicBodies.angleSpeedMin, spec.dynamicBodies.angleSpeedMax),
      phase: range(0, Math.PI * 2),
      bobAmp: range(spec.dynamicBodies.bobAmplitudeMin, spec.dynamicBodies.bobAmplitudeMax),
      bobSpeed: range(spec.dynamicBodies.bobSpeedMin, spec.dynamicBodies.bobSpeedMax),
      bobPhase: range(0, Math.PI * 2),
    });
  }

  const p = spec.particles;
  const particlePositions = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    particlePositions[i * 3 + 0] = range(-p.spread, p.spread);
    particlePositions[i * 3 + 1] = range(0, p.wrapHeight);
    particlePositions[i * 3 + 2] = range(-p.spread, p.spread);
  }

  return { obstacles, dynamics, particlePositions };
}

/**
 * 每帧运动学由本函数统一计算，两端只负责把结果写进各自的 Mesh。
 * 这样运动数学完全相同，不会因为某端公式写法不同而影响可比性。
 * @returns advance(tSeconds, dtSeconds) —— 结果就地写入 layout.dynamics 与 layout.particlePositions
 */
export function createFrameState(spec, layout) {
  const dyn = layout.dynamics;
  const pp = layout.particlePositions;
  const pCount = spec.particles.count;
  const wrapH = spec.particles.wrapHeight;
  const rise = spec.particles.riseSpeed;
  const size = spec.dynamicBodies.size;

  return function advance(t, dt) {
    for (let i = 0; i < dyn.length; i++) {
      const d = dyn[i];
      const a = t * d.angleSpeed + d.phase;
      d.x = Math.cos(a) * d.radius;
      d.z = Math.sin(a) * d.radius;
      d.y = Math.sin(t * d.bobSpeed + d.bobPhase) * d.bobAmp + d.bobAmp + size;
    }
    const dy = rise * dt;
    for (let i = 0; i < pCount; i++) {
      let y = pp[i * 3 + 1] + dy;
      if (y > wrapH) y -= wrapH;
      pp[i * 3 + 1] = y;
    }
  };
}

/** 相机绕场圆周运动，两端使用同一公式 */
export function computeCamera(t, spec, out) {
  const c = spec.camera;
  out.x = Math.cos(t * c.orbitSpeed) * c.orbitRadius;
  out.z = Math.sin(t * c.orbitSpeed) * c.orbitRadius;
  out.y = c.height;
  return out;
}

/**
 * 校准本机 rAF 上限（即垂直同步/刷新率给到的帧率天花板）。
 * 必要性：若采样结果贴近该上限，说明是"被锁帧"而非"跑到性能上限"，
 * 此时 FPS 无法用来比较引擎，必须改用帧时间对比预算。
 */
export function calibrateRafCap(ms = 1000) {
  return new Promise((resolve) => {
    let n = 0;
    let t0 = 0;
    function loop(now) {
      if (!t0) {
        t0 = now;
        requestAnimationFrame(loop);
        return;
      }
      n++;
      const el = now - t0;
      if (el >= ms) {
        resolve(+(n * 1000 / el).toFixed(2));
        return;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  });
}

/** 帧预算判定：把帧时间折算为"能否达到目标帧率" */
export function judgeBudgets(frameP95Ms) {
  if (!frameP95Ms) return null;
  return {
    headroomVs60: +(16.67 / frameP95Ms).toFixed(2),
    meets60: frameP95Ms <= 16.67,
    meets45: frameP95Ms <= 22.22,
    meets30: frameP95Ms <= 33.33,
  };
}

/** 程序生成的棋盘格贴图，两端算法一致，避免引入外部资源 */
export function drawChecker(ctx, size, cells, seed) {
  const rnd = mulberry32(seed + 7);
  const c = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = Math.floor(rnd() * 90) + 70;
      ctx.fillStyle = `rgb(${v},${v + 8},${v + 16})`;
      ctx.fillRect(x * c, y * c, c, c);
    }
  }
}

/** 采集 WebGL 实际使用的渲染器字符串，用于确认是否落在独显上（排除虚拟显示适配器） */
export function readGlInfo() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return { ok: false, reason: 'no webgl context' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/**
 * 统一测量口径。
 * @param step 回调 (timeMs) => void，内部完成动画推进与一帧渲染
 * @param onWindowStart 采样窗口开始时回调，用于重置分阶段计时累加器
 * @param onWindowEnd   采样窗口结束时回调，返回值会并入测量结果（用于分阶段成本分解）
 */
export function runBenchmark({ warmupMs, durationMs, step, onWindowStart, onWindowEnd }) {
  return new Promise((resolve) => {
    const stamps = [];        // 记录窗口内每帧起始时间戳
    const cpuSamples = [];    // 记录窗口内每帧 step() 的 CPU 耗时
    let t0 = 0;
    let started = false;
    let windowStarted = false;
    let heapStart = 0;
    let heapPeak = 0;
    const heapSupported = !!(performance && performance.memory);

    function loop(now) {
      if (!started) {
        started = true;
        t0 = now;
        if (heapSupported) heapStart = performance.memory.usedJSHeapSize;
        requestAnimationFrame(loop);
        return;
      }

      const cpu0 = performance.now();
      step(now);
      const cpu1 = performance.now();

      if (heapSupported) {
        const h = performance.memory.usedJSHeapSize;
        if (h > heapPeak) heapPeak = h;
      }

      const elapsed = now - t0;
      if (elapsed >= warmupMs) {
        if (!windowStarted) {
          windowStarted = true;
          if (onWindowStart) onWindowStart();
        }
        stamps.push(now);
        cpuSamples.push(cpu1 - cpu0);
      }

      if (elapsed >= warmupMs + durationMs) {
        finish();
        return;
      }
      requestAnimationFrame(loop);
    }

    function finish() {
      const frameMs = [];
      for (let i = 1; i < stamps.length; i++) frameMs.push(stamps[i] - stamps[i - 1]);

      const sorted = [...frameMs].sort((a, b) => a - b);
      const sortedCpu = [...cpuSamples].sort((a, b) => a - b);

      // 1% Low：取最慢的 1% 帧，求其平均帧时间，再折算为帧率
      const slowCount = Math.max(1, Math.round(sorted.length * 0.01));
      const slowest = sorted.slice(sorted.length - slowCount);
      const slowMean = mean(slowest);

      const spanMs = stamps.length > 1 ? stamps[stamps.length - 1] - stamps[0] : 0;
      const avgFps = spanMs > 0 ? (frameMs.length * 1000) / spanMs : 0;

      const heapEnd = heapSupported ? performance.memory.usedJSHeapSize : 0;
      const extra = onWindowEnd ? onWindowEnd() : null;

      resolve({
        frames: frameMs.length,
        windowMs: Math.round(spanMs),
        avgFps: +avgFps.toFixed(2),
        low1Fps: slowMean > 0 ? +(1000 / slowMean).toFixed(2) : 0,
        frameMs: {
          min: +sorted[0]?.toFixed(3),
          p50: +percentile(sorted, 0.5).toFixed(3),
          p95: +percentile(sorted, 0.95).toFixed(3),
          p99: +percentile(sorted, 0.99).toFixed(3),
          max: +sorted[sorted.length - 1]?.toFixed(3),
          mean: +mean(frameMs).toFixed(3),
        },
        // step() 的 CPU 侧耗时（不含 GPU 异步完成时间），用于判断 CPU 瓶颈还是 GPU 瓶颈
        cpuMs: {
          p50: +percentile(sortedCpu, 0.5).toFixed(3),
          p95: +percentile(sortedCpu, 0.95).toFixed(3),
          mean: +mean(cpuSamples).toFixed(3),
        },
        heap: heapSupported
          ? {
              startMB: +(heapStart / 1048576).toFixed(2),
              endMB: +(heapEnd / 1048576).toFixed(2),
              peakMB: +(heapPeak / 1048576).toFixed(2),
            }
          : { unsupported: true },
        phases: extra,
      });
    }

    requestAnimationFrame(loop);
  });
}
