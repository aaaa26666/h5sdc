// M4-7 单局快照的本地存储（平台层）
//
// 职责：把快照写进 localStorage、读出来、以及结算后清除。
//
// 为什么单独一层：存储是**平台能力**，逻辑层不该直接碰 localStorage
// （《流程文档》3.3 分层约束）。而且这里要处理一堆现实问题：
//   · localStorage 可能被禁用（隐私模式 / 配额满）；
//   · 内容可能是上一次版本留下的、也可能被人手动改坏；
//   · 读出来的东西**必须先过 sanitizeCheckpoint**，不能直接交给结算。
//
// 关于"服务端/本地双写"：本项目是纯 PVE 单机，没有服务端，
// 因此这里的"本地"就是唯一的落点。接口按双写的形状设计
// （save / load / clear 三者分离、幂等清除），日后若加服务端不必改调用方。

import { sanitizeCheckpoint } from '../core/raidCheckpoint.js';

const STORAGE_KEY = 'h5_extract_raid_checkpoint';

let available = true;

function rawGet() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    available = false;
    return null;
  }
}

/** 写入快照。写失败不应影响游戏本身 —— 最坏结果是断线时丢档，但游戏得继续。 */
export function saveCheckpoint(cp) {
  if (!available) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cp));
    return true;
  } catch {
    // 配额满或被禁用。降级为"不写"，不要抛错把主循环打断。
    available = false;
    return false;
  }
}

/** 读取快照。任何异常（不存在 / 坏 JSON / 校验不过）都返回 null。 */
export function loadCheckpoint() {
  const text = rawGet();
  if (!text) return null;
  try {
    return sanitizeCheckpoint(JSON.parse(text));
  } catch {
    // 坏 JSON：直接当作没有。**不要尝试修复** —— 修出来的半坏数据更危险。
    clearCheckpoint();
    return null;
  }
}

/** 清除快照（幂等：重复调用无副作用）。结算完成后必须调用它，否则下次会重复结算。 */
export function clearCheckpoint() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 清不掉也就算了，loadCheckpoint 的校验会兜住 */
  }
}

/** 存储是否可用（供 DEV 接口与诊断） */
export function isAvailable() {
  return available;
}

export const CHECKPOINT_KEY = STORAGE_KEY;
