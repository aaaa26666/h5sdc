// M0-7 音频自动播放限制探针。
// 目的：查明浏览器在"无用户手势"下到底会怎样，以及解锁流程是否可靠。
// 关键点：AudioContext.resume() 在无手势时通常【永不 settle】（既不 resolve 也不 reject），
// 所以探针不能 await 它，必须用超时判定是否 settle。
// 用完即弃，不属于游戏产物。

const FORMATS = {
  'MP3 (audio/mpeg)': 'audio/mpeg',
  'AAC (audio/mp4; mp4a.40.2)': 'audio/mp4; codecs="mp4a.40.2"',
  'OGG Vorbis': 'audio/ogg; codecs="vorbis"',
  'OGG Opus': 'audio/ogg; codecs="opus"',
  'WebM Opus': 'audio/webm; codecs="opus"',
  'FLAC': 'audio/flac',
  'WAV (PCM)': 'audio/wav; codecs="1"',
};

/** 生成一段 PCM WAV，用于真实解码测试（不依赖任何外部音频资源） */
function makeWav(seconds, sampleRate, freq, channels = 1) {
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * 2, true);
  dv.setUint16(32, channels * 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((i / sampleRate) * freq * Math.PI * 2) * 12000);
    for (let c = 0; c < channels; c++) {
      dv.setInt16(o, v, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const probe = {
  ua: navigator.userAgent,
  formatSupport: {},
  beforeGesture: null,
  afterGesture: null,
  decode: null,
  errors: [],
};
window.__audioProbe = probe;

try {
  // ---------- 1. 格式支持 ----------
  const a = document.createElement('audio');
  for (const [label, mime] of Object.entries(FORMATS)) {
    // canPlayType 返回 '' | 'maybe' | 'probably'
    probe.formatSupport[label] = a.canPlayType(mime) || '(不支持)';
  }

  // ---------- 2. 手势前 ----------
  const tCtx = performance.now();
  const ac = new AudioContext();
  const ctxCreateMs = performance.now() - tCtx;

  const el = new Audio(URL.createObjectURL(makeWav(1, 44100, 440)));

  probe.beforeGesture = {
    contextState: ac.state,
    contextCreateMs: +ctxCreateMs.toFixed(2),
    sampleRate: ac.sampleRate,
    baseLatency: ac.baseLatency ?? null,
    outputLatency: ac.outputLatency ?? null,
    maxChannelCount: ac.destination.maxChannelCount,
    userActivation: navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
      : '(不支持 userActivation API)',
    // resume() 是否 settle：null 表示"一直挂起"
    resumeSettled: null,
    audioElPlay: null,
  };

  ac.resume().then(
    () => (probe.beforeGesture.resumeSettled = 'resolved'),
    (e) => (probe.beforeGesture.resumeSettled = 'rejected: ' + (e && e.message))
  );

  el.play().then(
    () => (probe.beforeGesture.audioElPlay = 'played'),
    (e) => (probe.beforeGesture.audioElPlay = 'rejected: ' + (e && e.name))
  );

  // 800ms 后仍为 null 即判定为"永不 settle"
  setTimeout(() => {
    if (probe.beforeGesture.resumeSettled === null) {
      probe.beforeGesture.resumeSettled = 'PENDING（无手势时永不 settle）';
    }
    if (probe.beforeGesture.audioElPlay === null) {
      probe.beforeGesture.audioElPlay = 'PENDING';
    }
  }, 800);

  // ---------- 3. 手势后 ----------
  let unlocked = false;
  async function onGesture(ev) {
    if (unlocked) return;
    unlocked = true;
    const t0 = performance.now();
    const out = {
      gestureType: ev.type,
      contextStateAtGesture: ac.state,
      userActivationAtGesture: navigator.userActivation
        ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
        : null,
      resumeMs: null,
      contextStateAfterResume: null,
      audioElPlayAfterResume: null,
      // 解锁开销：从手势到能出声的时间，直接影响首次进入游戏的音画同步
      totalUnlockMs: null,
    };
    try {
      await ac.resume();
      out.resumeMs = +(performance.now() - t0).toFixed(2);
      out.contextStateAfterResume = ac.state;
    } catch (e) {
      out.resumeError = String(e && e.message);
    }
    try {
      await el.play();
      out.audioElPlayAfterResume = 'played';
    } catch (e) {
      out.audioElPlayAfterResume = 'rejected: ' + (e && e.name);
    }
    out.totalUnlockMs = +(performance.now() - t0).toFixed(2);

    // ---------- 4. 解码成本 ----------
    try {
      const longBlob = makeWav(30, 44100, 220, 2); // 30 秒立体声
      const ab = await longBlob.arrayBuffer();
      const td = performance.now();
      const decoded = await ac.decodeAudioData(ab.slice(0));
      out.decode = {
        sourceBytes: ab.byteLength,
        sourceKB: +(ab.byteLength / 1024).toFixed(1),
        decodeMs: +(performance.now() - td).toFixed(2),
        decodedSeconds: +decoded.duration.toFixed(2),
        decodedChannels: decoded.numberOfChannels,
        decodedSampleRate: decoded.sampleRate,
      };
      probe.decode = out.decode;
    } catch (e) {
      probe.errors.push('decode: ' + String(e && e.message));
    }

    probe.afterGesture = out;
    window.__audioProbeDone = true;
  }
  document.addEventListener('pointerdown', onGesture, { once: false });
  document.addEventListener('keydown', onGesture, { once: false });

  probe.ready = true;
} catch (e) {
  probe.errors.push('fatal: ' + String(e && e.message));
  probe.ready = true;
}
