// M2-8 音频初版接入（Web Audio 程序化合成）
//
// 为什么是程序化合成而不是音频文件：
//   项目当前没有任何音频素材，而 M2 明确"不做新美术资源"。
//   程序化合成零素材依赖，能真实跑通音频管线，也足以验证 M0 记录的那条硬约束。
//
// 必须遵守 M0-TECH-01 约束（这是 M0 实测过、且会让加载流程永久挂死的坑）：
//   C-7 **禁止**在任何模块顶层或加载流程中 await audioContext.resume()。
//       无用户手势时该 Promise 既不 resolve 也不 reject，会永久挂起、无异常、无日志。
//   C-8 必须实现"音频解锁门"：在首个可交互界面的一次用户手势内，
//       一次性完成 创建 AudioContext → await resume() → 播放静音占位。
//   C-9 未解锁前，所有播放请求走"静默丢弃 + 排队"分支，不得抛异常中断游戏逻辑。
//
// [M2-TEMP-2] 音效全部为合成音，没有做距离衰减的分层素材、没有遮挡滤波、
//             没有混音总线（音乐/音效/语音分离）、没有音量设置。
//             M3/M5 重写清单：接入真实音频资源与混音总线。

export function createAudio() {
  let ctx = null;
  let master = null;
  let unlocked = false;
  let enabled = true;
  let unlockAttempted = false;
  const pending = [];
  const stats = { playRequests: 0, played: 0, droppedBeforeUnlock: 0, queuedBeforeUnlock: 0 };

  const MAX_QUEUE = 24;

  /**
   * 解锁门。**必须在用户手势回调内调用**（见 C-8）。
   * 注意这里没有在模块顶层调用它，也没有在任何 await 链里。
   */
  async function unlock() {
    if (unlocked) return true;
    if (unlockAttempted) return unlocked;
    unlockAttempted = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);
      }
      if (ctx.state !== 'running') {
        // 只有在手势里 await 才是安全的；无手势时这里会挂起 —— 因此用超时兜底，
        // 绝不让加载流程被它卡住。
        await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 800))]);
      }
      unlocked = ctx.state === 'running';
      if (unlocked) {
        // 播放一次静音占位，确认管线真的通了
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(master);
        const o = ctx.createOscillator();
        o.connect(g);
        o.start();
        o.stop(ctx.currentTime + 0.01);
        // 冲掉排队中的请求
        for (const fn of pending) fn();
        pending.length = 0;
      }
      return unlocked;
    } catch {
      return false;
    }
  }

  /** 未解锁时静默丢弃或排队，绝不抛错中断游戏逻辑（C-9） */
  function schedule(fn) {
    stats.playRequests++;
    if (!enabled) return;
    if (!unlocked || !ctx || ctx.state !== 'running') {
      stats.droppedBeforeUnlock++;
      if (pending.length < MAX_QUEUE) {
        pending.push(fn);
        stats.queuedBeforeUnlock++;
      }
      return;
    }
    try {
      fn();
      stats.played++;
    } catch {
      /* 音频失败不得影响玩法 */
    }
  }

  // ---------------- 合成基元 ----------------

  /** 噪声缓冲：枪声与脚步声的基础 */
  let noiseBuf = null;
  function getNoise() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.6);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function noiseBurst({ dur = 0.12, freq = 1600, q = 1.2, gain = 0.9, decay = 0.05, type = 'lowpass' }) {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay + dur * 0.5);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur);
  }

  function tone({ freq = 800, dur = 0.08, gain = 0.2, type = 'square', sweepTo = null }) {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur);
  }

  // ---------------- 具体音效 ----------------
  const gunProfile = {
    pistol: { freq: 1900, dur: 0.10, gain: 0.55, decay: 0.045 },
    smg: { freq: 2200, dur: 0.08, gain: 0.5, decay: 0.035 },
    rifle: { freq: 1500, dur: 0.14, gain: 0.7, decay: 0.055 },
    shotgun: { freq: 900, dur: 0.22, gain: 0.85, decay: 0.09 },
    dmr: { freq: 1200, dur: 0.18, gain: 0.75, decay: 0.07 },
    ai: { freq: 1700, dur: 0.10, gain: 0.4, decay: 0.05 },
  };

  return {
    unlock,
    isUnlocked: () => unlocked,
    stats,
    setEnabled(v) {
      enabled = !!v;
      if (master) master.gain.value = enabled ? 0.35 : 0;
    },
    isEnabled: () => enabled,

    /** 枪声。distanceM 用于粗略衰减（真实的距离衰减需 3D 音频节点，属 M3） */
    gunshot(weaponClass = 'rifle', distanceM = 0) {
      schedule(() => {
        const p = gunProfile[weaponClass] || gunProfile.rifle;
        const atten = Math.max(0.15, 1 - distanceM / 90);
        noiseBurst({ ...p, gain: p.gain * atten });
        // 低频"砰"的成分，让枪声有体积感
        tone({ freq: 180, sweepTo: 60, dur: 0.09, gain: 0.25 * atten, type: 'sine' });
      });
    },

    impact() {
      schedule(() => noiseBurst({ freq: 3200, dur: 0.05, gain: 0.22, decay: 0.02, type: 'highpass' }));
    },

    hitmark() {
      schedule(() => tone({ freq: 1400, sweepTo: 1900, dur: 0.05, gain: 0.18, type: 'triangle' }));
    },

    headshotHitmark() {
      schedule(() => {
        tone({ freq: 1800, sweepTo: 2600, dur: 0.07, gain: 0.22, type: 'triangle' });
      });
    },

    kill() {
      schedule(() => {
        tone({ freq: 700, sweepTo: 1200, dur: 0.13, gain: 0.2, type: 'triangle' });
      });
    },

    hurt() {
      schedule(() => noiseBurst({ freq: 500, dur: 0.14, gain: 0.4, decay: 0.06 }));
    },

    footstep(sprinting = false) {
      schedule(() =>
        noiseBurst({
          freq: sprinting ? 1100 : 750,
          dur: 0.06,
          gain: sprinting ? 0.16 : 0.1,
          decay: 0.03,
          q: 0.8,
        })
      );
    },

    reloadStart() {
      schedule(() => tone({ freq: 420, sweepTo: 240, dur: 0.07, gain: 0.16, type: 'square' }));
    },
    reloadEnd() {
      schedule(() => tone({ freq: 520, sweepTo: 700, dur: 0.07, gain: 0.18, type: 'square' }));
    },
    emptyClick() {
      schedule(() => tone({ freq: 260, dur: 0.04, gain: 0.14, type: 'square' }));
    },
    swap() {
      schedule(() => tone({ freq: 600, sweepTo: 900, dur: 0.06, gain: 0.12, type: 'sawtooth' }));
    },
    consume() {
      schedule(() => tone({ freq: 380, sweepTo: 620, dur: 0.18, gain: 0.14, type: 'sine' }));
    },
    extractTick() {
      schedule(() => tone({ freq: 880, dur: 0.05, gain: 0.12, type: 'sine' }));
    },
  };
}
