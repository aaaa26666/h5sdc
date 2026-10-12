// M5-7 档案的本地存储（平台层）
//
// 职责：读 / 写 / 备份 / 隔离 / 降级。**本文件不做任何数值判断** ——
// 结构、版本与逐字段校验都在 core/profile.js（纯函数，可单测）。
// 这样分层的原因与 M4-7 的 raidStore.js 完全一致：存储是平台能力，
// 逻辑层不该直接碰 localStorage，而存储层不该知道"什么是一个合法等级"。
//
// ★ 三个键，各司其职：
//   h5_extract_profile            当前档案
//   h5_extract_profile_backup     上一份**成功写入**的档案（回滚用，单份滚动）
//   h5_extract_profile_quarantine 被拒绝解释的原始文本（**只写不读**）
//
// 隔离键为什么"只写不读"：它的内容按定义是当前代码无法解释的（坏 JSON、未来版本）。
// 再把它读回来解析一次，只会重复失败一次。它的价值是**留证据**：
// 玩家报告"我的存档没了"时，那串文本还在，可以用来人工恢复。
//
// 降级策略（localStorage 被禁用 / 配额满）：全部读写退化为**本次会话内存档**，游戏照常可玩。
// 这是刻意的：隐私模式下玩不了游戏，比"这一局的进度不落盘"严重得多。

import { parseProfile, serializeProfile, createNewProfile } from '../core/profile.js';

export const PROFILE_KEY = 'h5_extract_profile';
export const BACKUP_KEY = 'h5_extract_profile_backup';
export const QUARANTINE_KEY = 'h5_extract_profile_quarantine';

let available = true;
let warned = false;
/** 存储不可用时的内存档（本次会话有效） */
let memoryProfile = null;

function store() {
  try {
    // 访问 localStorage 本身就可能抛（某些隐私模式下 getter 就抛）
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    available = false;
    return null;
  }
}

function readRaw(key) {
  const s = store();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch {
    available = false;
    return null;
  }
}

function writeRaw(key, text) {
  const s = store();
  if (!s) return false;
  try {
    s.setItem(key, text);
    return true;
  } catch {
    // 配额满或被禁用：不抛错打断主循环，降级为内存档
    available = false;
    if (!warned) {
      warned = true;
      // 只在控制台说一次：每次存档都刷屏会淹没真正有用的日志
      console.warn('[profileStore] localStorage 写入失败，本次会话进度只保存在内存中');
    }
    return false;
  }
}

function removeRaw(key) {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(key);
  } catch {
    /* 删不掉也就算了：读取路径的校验会兜住 */
  }
}

/** 存储是否可用（供 DEV 接口与诊断显示） */
export function isProfileAvailable() {
  return available;
}

/** 把无法解释的原始文本留证（覆盖式：只保留最近一次，避免无限膨胀）。 */
export function quarantine(rawText, reason, nowMs = 0) {
  const payload = JSON.stringify({ reason, atMs: nowMs, bytes: rawText ? rawText.length : 0, text: rawText || '' });
  // 隔离内容可能很大，写入失败也不能影响开局
  const s = store();
  if (!s) return false;
  try {
    s.setItem(QUARANTINE_KEY, payload);
    return true;
  } catch {
    available = false;
    return false;
  }
}

export function readQuarantine() {
  const text = readRaw(QUARANTINE_KEY);
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    // 只把**元信息**交出去，正文（text）由调用方按需取 —— 它可能很大
    return { reason: o.reason, atMs: o.atMs, bytes: o.bytes, hasText: typeof o.text === 'string' && o.text.length > 0 };
  } catch {
    return { reason: 'unreadable', atMs: 0, bytes: text.length, hasText: false };
  }
}

/**
 * 载入档案。返回的 `source` 说明这一份是从哪来的 ——
 * 断言与报告要用它区分"正常加载"与"从备份恢复"（后者意味着主档坏过一次）。
 *
 * @returns {{profile:object, source:'main'|'backup'|'new'|'memory',
 *            repairs:string[], quarantined:boolean, applied:string[]}}
 */
export function loadProfile(cfg, nowMs = 0) {
  if (!available) {
    if (!memoryProfile) memoryProfile = createNewProfile(cfg, nowMs);
    return { profile: memoryProfile, source: 'memory', repairs: ['storage-unavailable'], quarantined: false, applied: [] };
  }

  const mainRaw = readRaw(PROFILE_KEY);
  const main = parseProfile(mainRaw, cfg, nowMs);

  if (!main.mig.quarantined) {
    if (main.repairs.length) {
      // 加载时修过东西：立刻写回，让修复落地（否则每次加载都要重修一遍）
      saveProfile(main.profile, cfg);
    }
    return {
      profile: main.profile,
      source: 'main',
      repairs: main.repairs,
      quarantined: false,
      applied: main.mig.applied,
    };
  }

  // 主档无法解释 → 留证 → 试备份
  quarantine(mainRaw, main.mig.reason, nowMs);
  const backupRaw = readRaw(BACKUP_KEY);
  if (backupRaw) {
    const bak = parseProfile(backupRaw, cfg, nowMs);
    if (!bak.mig.quarantined) {
      return {
        profile: bak.profile,
        source: 'backup',
        repairs: [...bak.repairs, `main-quarantined:${main.mig.reason}`],
        quarantined: true,
        applied: bak.mig.applied,
      };
    }
    quarantine(backupRaw, `backup:${bak.mig.reason}`, nowMs);
  }

  return {
    profile: main.profile,
    source: 'new',
    repairs: [`quarantined:${main.mig.reason}`],
    quarantined: true,
    applied: [],
  };
}

/**
 * 保存档案。
 *
 * 顺序是**先备份旧的、再写新的**：
 *   如果反过来（先写新档再备份），那么"写新档写到一半失败"会连备份也一起丢。
 *   现在的顺序最坏情况是"多留一份旧档"，那是无害的。
 *
 * @returns {boolean} 是否真的落盘（false 表示降级为内存档或体积超限）
 */
export function saveProfile(profile, cfg) {
  const text = serializeProfile(profile, cfg);
  if (text === null) {
    // 体积无法压到上限内：**保留旧档不动**。写一份被截断的存档比不写更糟。
    if (!warned) {
      warned = true;
      console.warn('[profileStore] 档案超过体积上限且无法精简，本次不落盘（保留上一份）');
    }
    return false;
  }
  if (!available) {
    memoryProfile = profile;
    return false;
  }
  const prev = readRaw(PROFILE_KEY);
  if (prev) writeRaw(BACKUP_KEY, prev);
  const ok = writeRaw(PROFILE_KEY, text);
  if (ok) {
    memoryProfile = profile;
  } else {
    memoryProfile = profile;
  }
  return ok;
}

/** 清空档案（含备份）。只用于 DEV 接口与测试注入异常，游戏里没有这个入口。 */
export function clearProfile() {
  removeRaw(PROFILE_KEY);
  removeRaw(BACKUP_KEY);
  removeRaw(QUARANTINE_KEY);
  memoryProfile = null;
}

/** 存储诊断读数。端到端用它断言"坏档确实被隔离了"、"备份确实还在"。 */
export function storageInfo() {
  const bytes = (k) => {
    const t = readRaw(k);
    return t ? t.length : 0;
  };
  return {
    available,
    mainBytes: bytes(PROFILE_KEY),
    backupBytes: bytes(BACKUP_KEY),
    quarantineBytes: bytes(QUARANTINE_KEY),
    quarantine: readQuarantine(),
    hasMemory: !!memoryProfile,
  };
}

/** 仅供测试：把内存档清掉（模拟"重开浏览器"） */
export function _resetMemory() {
  memoryProfile = null;
}
