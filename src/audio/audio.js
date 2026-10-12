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
//             没有混音总线（音乐/音效/语音分离）。
//             音效素材与分层衰减属 M7（美术与音频替换），混音总线属 M5-8 之后的调音工作。
//             （M5-1 已补上主音量档位：见下方 baseGain / setVolumeScale。）

// ★ M5-1：基础增益与音量倍率。
//   此前 `master.gain.value = 0.35` **硬编码两处**（创建时与 setEnabled），
//   属"数值散落在逻辑代码中"，且让"加一个音量设置"变成改两处数字。
//   现在：基础增益来自 config.audio.masterGain，音量档位倍率来自设置项，
//   两者的相乘**只发生在 applyGain() 一处** —— 任何调音量的路径都必须过它。
export function createAudio(cfg) {
  const baseGain = cfg.audio.masterGain;
  let ctx = null;
  let master = null;
  // ★ M5-8：两条分轨总线（制作人裁定：分轨要做；音乐轨先接上空总线 —— BGM 属 M7）。
  //   结构：音源 → sfxBus/musicBus → master → destination。
  //   分轨增益与主增益一样，**只在 applyGain() 一处相乘** —— 任何调音量的路径都必须过它。
  let sfxBus = null;
  let musicBus = null;
  let sfxScale = 1;
  let musicScale = 1;
  let unlocked = false;
  let enabled = true;
  let volumeScale = 1;
  let unlockAttempted = false;
  const pending = [];
  const stats = { playRequests: 0, played: 0, droppedBeforeUnlock: 0, queuedBeforeUnlock: 0 };

  const MAX_QUEUE = 24;

  /** 实际写入各级增益的值：静音开关 × 基础增益 × 总线倍率 × 分轨倍率 */
  function applyGain() {
    if (!master) return;
    master.gain.value = enabled ? baseGain * volumeScale : 0;
    if (sfxBus) sfxBus.gain.value = enabled ? sfxScale : 0;
    if (musicBus) musicBus.gain.value = enabled ? musicScale : 0;
  }

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
        sfxBus = ctx.createGain();
        musicBus = ctx.createGain();
        sfxBus.connect(master);
        // musicBus 现在没有音源（BGM 属 M7），但它是**真实存在**的总线：
        // 设置项"音乐音量"改的就是它的增益 —— 不是假开关，只是暂时没声音可放。
        musicBus.connect(master);
        // 用 applyGain 而不是直接写 baseGain：设置里的音量档位可能在解锁前就已加载，
        // 直接写基线会把那一档丢掉（表现为"进游戏后第一次开枪音量不对"）。
        applyGain();
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
        g.connect(sfxBus);
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
    src.connect(f).connect(g).connect(sfxBus);
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
    o.connect(g).connect(sfxBus);
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
      applyGain();
    },
    isEnabled: () => enabled,

    /**
     * 主音量档位倍率（M5-1）。设置界面调用它，值来自配置表
     * （settings.volumeLevels），本函数只负责落到总线上。
     */
    setVolumeScale(scale) {
      volumeScale = scale;
      applyGain();
    },

    /**
     * 分轨倍率（M5-8）。制作人裁定：分轨要做，音乐轨先接上空总线（BGM 属 M7）。
     * 一次同时设两条，因为设置界面永远是把整份设置交过来的。
     */
    setBusScales({ sfx, music }) {
      if (typeof sfx === 'number') sfxScale = sfx;
      if (typeof music === 'number') musicScale = music;
      applyGain();
    },

    /** 当前实际写到各级增益的数值（诊断/断言用；未解锁时的各字段为 null） */
    currentGain: () => (master ? master.gain.value : null),
    /** 分轨增益读数：断言"分轨真的接上了"要靠它（音乐轨暂时没有音源，但增益是真实的） */
    busGains: () => ({
      master: master ? master.gain.value : null,
      sfx: sfxBus ? sfxBus.gain.value : null,
      music: musicBus ? musicBus.gain.value : null,
    }),

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

    /**
     * M3-4 稀有度掉落音效。tier 来自 loot.json 的 `rarity.dropSoundTier`（0~4）。
     * 0（白装）**不发声** —— 与白装的 beamIntensity=0 同一条设计：白装不该有存在感。
     * 档位越高音越亮、尾音越长，让"出好东西"在听觉上可分辨。
     */
    dropTier(tier = 0) {
      if (tier <= 0) return;
      schedule(() => {
        const t = Math.max(0, Math.min(4, tier | 0));
        const base = [0, 520, 700, 880, 1180][t];
        tone({ freq: base, dur: 0.07, gain: 0.16, type: 'triangle' });
        tone({ freq: base * 1.5, dur: 0.09 + t * 0.02, gain: 0.12, type: 'sine', sweepTo: base * 1.68 });
        if (t >= 3) tone({ freq: base * 2, dur: 0.12, gain: 0.08, type: 'sine' });
      });
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
