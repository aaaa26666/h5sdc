// M5-5 等级、经验与技能（纯函数，无 DOM / 无 three.js / 不读 localStorage）
//
// 为什么单独成文件且必须是纯函数：
//   M5 约束词要求「所有 UI 数值必须来自配置表，禁止在界面代码里算价格」——
//   等级与技能倍率是同一类东西：算它的地方只能有一处，否则「界面显示 12 级、
//   局内按 11 级算」这类分叉迟早出现。
//   本文件不持有状态：同样的 (profile, cfg) 必然得到同样的 mods。
//
// 数值来源：src/config/progression.json（等级曲线 / 经验规则 / 技能树）。
// 本文件里**没有任何数字字面量参与规则计算**（幂运算的 1 与乘法的 1 除外）。

import { dataKeys } from './lootTable.js';

/**
 * 技能效果里被**局内真实消费**的倍率键 → 消费点。
 *
 * ★ 这张表的存在意义：M5 硬性要求「禁止留下假实现」。一个技能如果只是写进配置、
 *   算出一个没人读的数字，它在界面上看起来完全正常（等级涨了、点花了），
 *   但游戏行为一点没变 —— 这类缺陷肉眼永远抓不到。
 *   因此 `src/config/index.js` 在**启动期**要求 progression.json 的每个 effectKind
 *   都出现在这里，而这里的每一项都对应一处真实的读取代码（冒烟测试会逐项验证行为变化）。
 */
export const CONSUMED_MODIFIERS = Object.freeze({
  weightLimitKg: 'gameplay/inventory.js（背包负重上限）',
  moveSpeedScale: 'gameplay/player.js（移动与冲刺速度）',
  recoilScale: 'gameplay/weapon.js（后坐力）',
  spreadScale: 'gameplay/weapon.js（扩散）',
  searchSpeedScale: 'gameplay/loot.js（搜刮耗时）',
  healSpeedScale: 'gameplay/player.js（医疗动作耗时）',
  sellBonusRatio: 'core/shop.js（卖价加成）',
});

/** 等级 n（从 1 起）升到 n+1 所需经验。表驱动：base × growth^(n-1)。 */
export function expForLevel(level, cfg) {
  const c = cfg.progression.levelCurve;
  return Math.round(c.base * Math.pow(c.growth, level - 1));
}

/** 满级所需总经验（各级之和）。测试与报告用它，避免手写一个会过期的常量。 */
export function totalExpToMax(cfg) {
  const c = cfg.progression.levelCurve;
  let sum = 0;
  for (let l = 1; l < c.maxLevel; l++) sum += expForLevel(l, cfg);
  return sum;
}

/**
 * 总经验 → 等级。
 *
 * 边界口径（单测逐条守）：恰好等于阈值时**升级**（`rest >= need`）。
 * 满级后经验继续累加但不再升级，`isMax = true`。
 */
export function levelFromExp(exp, cfg) {
  const c = cfg.progression.levelCurve;
  const total = Math.max(0, Math.floor(exp || 0));
  let level = 1;
  let rest = total;
  while (level < c.maxLevel) {
    const need = expForLevel(level, cfg);
    if (rest < need) break;
    rest -= need;
    level++;
  }
  const isMax = level >= c.maxLevel;
  return {
    level,
    expInLevel: rest,
    expForLevel: isMax ? 0 : expForLevel(level, cfg),
    isMax,
  };
}

/** 当前等级下的累计已用经验（= 总经验 − 本级剩余），供 UI 画进度条。 */
export function expSpentBeforeLevel(exp, cfg) {
  const info = levelFromExp(exp, cfg);
  return Math.max(0, Math.floor(exp || 0)) - info.expInLevel;
}

/**
 * 一局的经验。
 * @param {object} facts { outcome, kills, containersOpened, keptValue }
 *        outcome: 'extract' | 'death'（与 buildRaidResult 的 outcome 同口径）
 */
export function raidExp(facts, cfg) {
  const r = cfg.progression.expRules;
  const ok = facts.outcome === 'extract';
  const mul = ok ? 1 : r.failedMultiplier;
  const value = Math.max(0, facts.keptValue || 0);
  const valueSteps = Math.floor(value / r.valueStep);
  const variable = mul * ((r.perContainer || 0) * (facts.containersOpened || 0) + (r.perKill || 0) * (facts.kills || 0) + (r.perValuePer1000 || 0) * valueSteps);
  const fixed = (ok ? r.extractBase : 0) + (ok ? 0 : r.failedBase);
  return Math.round(fixed + variable);
}

/** 某技能的当前等级（未学为 0）。 */
export function skillLevel(profile, skillId) {
  const skills = (profile && profile.progression && profile.progression.skills) || {};
  return skills[skillId] || 0;
}

/** 已花费的技能点总数。 */
export function spentPoints(profile, cfg) {
  let sum = 0;
  for (const sk of cfg.progression.skills) {
    const lv = skillLevel(profile, sk.id);
    for (let i = 0; i < lv && i < sk.costPerLevel.length; i++) sum += sk.costPerLevel[i];
  }
  return sum;
}

/**
 * ★ 技能 + 配装 → 局内倍率。**这是 mods 的唯一算法**。
 *
 * 聚合口径：每个效果键从 base 起步，所有技能的 `perLevel × 等级` 累加到它上面。
 *   · base 为 `fromLoot` 的键（weightLimitKg）从掉落表的背包规格起步 ——
 *     这样「技能没点时 mods.weightLimitKg === loot.backpack.weightLimitKg」，
 *     与 M5 之前的行为逐字节一致（有断言守）。
 *   · 其余键 base = 1（倍率）或 0（加成比例）。
 *
 * @returns {object} 至少包含 CONSUMED_MODIFIERS 的每一个键
 */
export function skillModifiers(profile, cfg) {
  const acc = {};
  for (const sk of cfg.progression.skills) {
    const lv = skillLevel(profile, sk.id);
    if (!lv) continue;
    for (const e of sk.effects) {
      acc[e.kind] = (acc[e.kind] || 0) + e.perLevel * lv;
    }
  }
  const out = {};
  for (const kind of dataKeys(cfg.progression.effectKinds)) {
    const kd = cfg.progression.effectKinds[kind];
    const base = kd.base === 'fromLoot' ? cfg.lootTable.backpack.weightLimitKg : kd.base;
    out[kind] = base + (acc[kind] || 0);
  }
  return out;
}

/**
 * 能否学下一级。
 * @returns {{ok:boolean, reason?:string, cost?:number, level?:number}}
 */
export function canLearn(profile, skillId, cfg) {
  const sk = cfg.progression.skills.find((s) => s.id === skillId);
  if (!sk) return { ok: false, reason: 'unknown-skill' };
  const cur = skillLevel(profile, skillId);
  if (cur >= sk.maxLevel) return { ok: false, reason: 'max-level' };
  // ★ requires / minLevel 是**可选**字段：制作人裁定取消技能间的全部门槛，因此当前表里
  //   一个都没写（全表写 "requires": [] 就是死配置）。这两段逻辑保留，是因为 M6 恢复
  //   树形结构时会立刻需要它，而且单测直接构造带这两个字段的技能覆盖了这两条分支 ——
  //   分支有覆盖，就不是"写了没人走"的假实现。
  if (sk.minLevel !== undefined) {
    const lv = levelFromExp(profile.progression.exp, cfg).level;
    if (lv < sk.minLevel) return { ok: false, reason: `need-level:${sk.minLevel}` };
  }
  for (const req of sk.requires || []) {
    if (skillLevel(profile, req) <= 0) return { ok: false, reason: `need-skill:${req}` };
  }
  const cost = sk.costPerLevel[cur];
  if (profile.progression.skillPoints < cost) return { ok: false, reason: `need-points:${cost}` };
  return { ok: true, cost, level: cur + 1 };
}

/** 洗点价格 = 已花点数 × 配置单价（制作人裁定：洗点要花货币）。 */
export function respecCost(profile, cfg) {
  return spentPoints(profile, cfg) * cfg.progression.respec.costPerPoint;
}

/**
 * 洗点：已花点数**全额退还**，技能全部回到未学状态。
 *
 * 为什么退款只有"全额"这一种口径：按比例退还（例如只退 80%）会让"点了几级"
 * 变成小数，接着必须定义取整规则、再接着要定义"取整后的点从哪来"——
 * 一条小的规则改动会生出三条新的边界。
 *
 * @returns {{ok:boolean, profile?:object, reason?:string, cost?:number, refunded?:number}}
 */
export function respec(profile, cfg) {
  const spent = spentPoints(profile, cfg);
  if (spent === 0) return { ok: false, reason: 'nothing-to-respec', cost: 0 };
  const cost = respecCost(profile, cfg);
  if (profile.currency < cost) return { ok: false, reason: `need-currency:${cost}`, cost };
  const next = {
    ...profile,
    currency: profile.currency - cost,
    progression: {
      ...profile.progression,
      skillPoints: profile.progression.skillPoints + spent,
      skills: {},
    },
  };
  return { ok: true, profile: next, cost, refunded: spent };
}

/**
 * 学一级技能。**返回新档案**（不改入参）—— 这样"同一次点击重放两次"不会扣两次点，
 * 与结算的幂等思路一致（见 core/profile.js 顶部说明）。
 * @returns {{ok:boolean, profile?:object, reason?:string, cost?:number}}
 */
export function learnSkill(profile, skillId, cfg) {
  const v = canLearn(profile, skillId, cfg);
  if (!v.ok) return { ok: false, reason: v.reason };
  const next = {
    ...profile,
    progression: {
      ...profile.progression,
      skillPoints: profile.progression.skillPoints - v.cost,
      skills: { ...profile.progression.skills, [skillId]: v.level },
    },
  };
  return { ok: true, profile: next, cost: v.cost };
}

/**
 * 把一局的经验并入档案（升级时发技能点）。
 * @returns {{profile:object, gained:number, before:object, after:object, leveledTo:number|null}}
 */
export function applyExp(profile, gained, cfg) {
  const before = levelFromExp(profile.progression.exp, cfg);
  const exp = Math.max(0, Math.floor(profile.progression.exp + gained));
  const after = levelFromExp(exp, cfg);
  const levels = after.level - before.level;
  const points = Math.max(0, levels) * cfg.progression.skillPointsPerLevel;
  const next = {
    ...profile,
    progression: {
      ...profile.progression,
      exp,
      skillPoints: profile.progression.skillPoints + points,
    },
  };
  return { profile: next, gained, before, after, leveledTo: levels > 0 ? after.level : null };
}
