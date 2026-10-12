// M4-1 撤离点开放规则（纯函数）
//
// 职责：回答"这个撤离点**现在**开不开放"。
//
// 为什么单独成文件、且不含任何 three.js：
//   《流程文档》3.3 约束「逻辑层禁止直接依赖渲染层」。
//   撤离规则属于逻辑层，它必须能被纯逻辑单测直接驱动，
//   也要能被 M4-3 的结算、M4-6 的 HUD、以及将来的回放/联机复用。
//   若把它写进 gameplay/extract.js（那里要建 THREE 的环与光柱），
//   就只能在浏览器里测 —— 而"时间窗"这种规则恰恰是最该逐毫秒验证的。
//
// 数值全部来自地图表（extracts[].openRule），本文件不含任何魔法数字。
//
// [M4-TEMP-2] 《流程文档》§2.4 举的条件点例子是「需要特定钥匙、特定时间后开放」，
// 本版只实现了**时间类**条件（timeAfter / timeWindow）。钥匙类条件没有实现，
// 因为"带钥匙进局"这个概念要等 M5-3 配装系统与 M5-6 任务线（另见 M3-TEMP-4：
// 门禁卡目前只能靠随机掉落获得）。规则结构上再加一种类型是直接可行的。

export const OPEN_RULE = Object.freeze({
  /** 常驻：全程开放 */
  ALWAYS: 'always',
  /** 条件：局内已过时间达到门槛后开放，之后不再关闭 */
  TIME_AFTER: 'timeAfter',
  /** 时间窗：只在 [from, to) 这段局内时间内开放，窗口外一律关闭 */
  TIME_WINDOW: 'timeWindow',
  /** 条件：局内累计淘汰数达到门槛后开放，之后不再关闭 */
  KILLS_AFTER: 'killsAfter',
});

/** 规则未开放时的原因码（供 HUD 显示与断言使用） */
export const OPEN_REASON = Object.freeze({
  ALWAYS: 'always',
  GATE_PASSED: 'gatePassed',
  GATE_PENDING: 'gatePending',
  IN_WINDOW: 'inWindow',
  WINDOW_NOT_YET: 'windowNotYet',
  WINDOW_CLOSED: 'windowClosed',
  KILLS_REACHED: 'killsReached',
  KILLS_PENDING: 'killsPending',
});

/**
 * 把"绝对值 or 相对比例"解析成毫秒。
 * 两者都允许，是为了让规则既能写死（fromMs: 60000）也能跟着单局时限缩放
 * （afterFraction: 0.5 = 时间过半）。地图表校验保证二者必有其一。
 * @returns {number|null} 未配置返回 null（校验期会被拦下）
 */
export function resolveMs(ms, fraction, timeLimitMs) {
  if (typeof ms === 'number' && ms >= 0) return ms;
  if (typeof fraction === 'number' && fraction >= 0 && timeLimitMs > 0) {
    return Math.round(fraction * timeLimitMs);
  }
  return null;
}

/**
 * 判断一个撤离点在给定局内时间下的开放状态。
 *
 * @param {object|null} rule 地图表的 openRule（null / 缺省视为常驻）
 * @param {object} ctx
 * @param {number} ctx.elapsedMs   局内已过时间（毫秒）
 * @param {number} ctx.timeLimitMs 单局时限（毫秒），用于解析 fraction
 * @param {number} [ctx.kills]     局内累计淘汰数（killsAfter 规则用）
 * @returns {{open:boolean, reason:string, opensInMs:number|null, closesInMs:number|null,
 *            remainingKills:number|null}}
 *          opensInMs      = 还要多久开放（已开放为 0，与时间无关的规则为 null）
 *          closesInMs     = 还要多久关闭（不会关闭为 null）
 *          remainingKills = 还要淘汰几名（仅 killsAfter 未达标时有值）
 */
export function evaluateOpenRule(rule, ctx) {
  const elapsedMs = ctx && ctx.elapsedMs ? ctx.elapsedMs : 0;
  const timeLimitMs = ctx && ctx.timeLimitMs ? ctx.timeLimitMs : 0;
  const kills = ctx && typeof ctx.kills === 'number' ? ctx.kills : 0;

  // 缺省 / 无规则 / 显式常驻 —— 全部按常驻处理。
  // 旧地图表没有 openRule 字段，这样它们的行为与改造前完全一致。
  if (!rule || rule.type === OPEN_RULE.ALWAYS || !rule.type) {
    return { open: true, reason: OPEN_REASON.ALWAYS, opensInMs: 0, closesInMs: null, remainingKills: null };
  }

  if (rule.type === OPEN_RULE.TIME_AFTER) {
    const gate = resolveMs(rule.afterMs, rule.afterFraction, timeLimitMs);
    if (gate === null) {
      throw new Error('[extractRules] timeAfter 规则缺少 afterMs / afterFraction');
    }
    if (elapsedMs >= gate) {
      return { open: true, reason: OPEN_REASON.GATE_PASSED, opensInMs: 0, closesInMs: null, remainingKills: null };
    }
    return { open: false, reason: OPEN_REASON.GATE_PENDING, opensInMs: gate - elapsedMs, closesInMs: null, remainingKills: null };
  }

  if (rule.type === OPEN_RULE.TIME_WINDOW) {
    const from = resolveMs(rule.fromMs, rule.fromFraction, timeLimitMs);
    const to = resolveMs(rule.toMs, rule.toFraction, timeLimitMs);
    if (from === null || to === null) {
      throw new Error('[extractRules] timeWindow 规则缺少 from/to');
    }
    if (elapsedMs < from) {
      return { open: false, reason: OPEN_REASON.WINDOW_NOT_YET, opensInMs: from - elapsedMs, closesInMs: to - elapsedMs, remainingKills: null };
    }
    if (elapsedMs >= to) {
      return { open: false, reason: OPEN_REASON.WINDOW_CLOSED, opensInMs: null, closesInMs: 0, remainingKills: null };
    }
    return { open: true, reason: OPEN_REASON.IN_WINDOW, opensInMs: 0, closesInMs: to - elapsedMs, remainingKills: null };
  }

  // 击杀门槛：达标后不再关闭（与 timeAfter 同性质，是一次性门槛）。
  // 阈值来自规则表，本文件不预设"3" —— 那是这一局这张图的设计数值。
  if (rule.type === OPEN_RULE.KILLS_AFTER) {
    const need = rule.kills;
    if (typeof need !== 'number' || !(need > 0)) {
      throw new Error('[extractRules] killsAfter 规则缺少 kills（必须为正数）');
    }
    if (kills >= need) {
      return { open: true, reason: OPEN_REASON.KILLS_REACHED, opensInMs: 0, closesInMs: null, remainingKills: 0 };
    }
    return { open: false, reason: OPEN_REASON.KILLS_PENDING, opensInMs: null, closesInMs: null, remainingKills: need - kills };
  }

  throw new Error(`[extractRules] 未知撤离点规则类型: ${rule.type}`);
}

/**
 * 规则的人类可读说明（大厅简报与 HUD 提示用，**不含任何数值判断**）。
 *
 * M5-1 之前这个函数是**死代码**（全项目零调用），M5-1 的大厅简报要用它。
 * 当时它只说"条件点（时间门槛后开放）"，不说是多久之后 —— 大厅里那样写等于没说。
 * 因此把它改成带数字的版本，并**由简报直接复用**，而不是在简报里另写一份
 * （"两处各描述一遍同一条规则"正是本项目反复踩过的坑）。
 * 规则类型本身用 OPEN_RULE 常量比对，避免字符串字面量散落。
 */
export function describeOpenRule(rule) {
  if (!rule || !rule.type || rule.type === OPEN_RULE.ALWAYS) return '常驻开放';
  if (rule.type === OPEN_RULE.TIME_AFTER) {
    if (typeof rule.afterFraction === 'number') return `局内时间过 ${pct(rule.afterFraction)} 后开放`;
    if (typeof rule.afterMs === 'number') return `局内第 ${sec(rule.afterMs)} 秒起开放`;
    return '条件点（时间门槛未配置）';
  }
  if (rule.type === OPEN_RULE.TIME_WINDOW) {
    const a = fracOrSec(rule.fromFraction, rule.fromMs);
    const b = fracOrSec(rule.toFraction, rule.toMs);
    return `仅在局内 ${a} ~ ${b} 期间开放`;
  }
  if (rule.type === OPEN_RULE.KILLS_AFTER) return `累计淘汰 ${rule.kills} 名敌人后开放`;
  return `未知规则（${rule.type}）`;
}

/** 比例 → 百分数文案 */
function pct(f) {
  return `${Math.round(f * 100)}%`;
}
/** 毫秒 → 秒文案 */
function sec(ms) {
  return `${Math.round(ms / 1000)}`;
}
/** 时间点：优先用比例（跟单局时限缩放），否则用绝对值 */
function fracOrSec(fraction, ms) {
  if (typeof fraction === 'number') return pct(fraction);
  if (typeof ms === 'number') return `第 ${sec(ms)} 秒`;
  return '未配置';
}
