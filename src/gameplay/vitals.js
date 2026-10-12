// 生命 / 护甲 / 命中部位
//
// 为什么玩家与 AI 共用这一个模块：
//   M2-4 要求"部位伤害 + 护甲耐久"。如果玩家受伤走一套、AI 受伤走另一套，
//   两边迟早会出现"同一把枪打我 30 滴、打 AI 26 滴"这类对不上的问题 ——
//   而这类不一致极难被发现，只会表现为"感觉伤害不对"。
//   共用同一个 resolveHit（core/ballistics.js）是唯一的防分叉手段。
import { resolveHit } from '../core/ballistics.js';

/** 命中部位 → 护甲槽。四肢不受护甲保护，这是搜打撤类游戏的通用规则 */
export function armorSlotForZone(zone) {
  if (zone === 'head') return 'head';
  if (zone === 'chest' || zone === 'stomach') return 'body';
  return null;
}

function makeArmorSlot(cfg, armorId) {
  const def = armorId ? cfg.armor.find((a) => a.id === armorId) : null;
  const usable = def && def.class > 0 ? def : null;
  return {
    id: usable ? usable.id : 'none',
    def: usable,
    durability: usable ? usable.durability : 0,
    maxDurability: usable ? usable.durability : 0,
  };
}

export function createVitals({ maxHealth, armorBySlot, cfg }) {
  return {
    health: maxHealth,
    maxHealth,
    armor: {
      head: makeArmorSlot(cfg, armorBySlot ? armorBySlot.head : null),
      body: makeArmorSlot(cfg, armorBySlot ? armorBySlot.body : null),
    },
  };
}

/**
 * 施加一次命中。
 * @returns {{zone, slot, damage, raw, absorb, durabilityLoss, armorBroken, health, dead}}
 */
export function applyHit(vitals, { weapon, ammo, zone, distanceM, cfg }) {
  const slot = armorSlotForZone(zone);
  const a = slot ? vitals.armor[slot] : null;
  const hadDurability = a ? a.durability : 0;
  const r = resolveHit({
    weapon,
    ammo,
    zone,
    distanceM,
    armorDef: a ? a.def : null,
    armorDurability: hadDurability,
    armorRules: cfg.armorRules,
  });
  if (a && r.durabilityLoss > 0) {
    a.durability = Math.max(0, a.durability - r.durabilityLoss);
  }
  vitals.health = Math.max(0, vitals.health - r.damage);
  return {
    ...r,
    slot,
    health: vitals.health,
    dead: vitals.health <= 0,
    armorBrokenNow: hadDurability > 0 && a && a.durability <= 0,
  };
}

/**
 * 治疗。
 *
 * **语义要点：治疗绝不能降低生命值。**
 * 初版写成 `health = min(cap, health + amount)` —— 当玩家血量已高于该消耗品的上限时
 * （例如 83 血用上限 45 的绷带），它会把血量**钳到 45**，也就是"用绷带反而掉 38 点血"。
 * 这是很严重的玩法缺陷，但它藏在一个看起来无害的 min() 里，且只在
 * "血量高于该消耗品上限"时才触发 —— 靠试玩很难稳定复现。
 * 正确语义：已经到达该消耗品能治到的上限时不产生任何效果。
 *
 * @returns 实际恢复量（0 表示没有效果，例如已高于上限）
 */
export function heal(vitals, amount, cap) {
  const ceiling = Math.min(vitals.maxHealth, cap);
  if (vitals.health >= ceiling) return 0;
  const before = vitals.health;
  vitals.health = Math.min(ceiling, vitals.health + amount);
  return +(vitals.health - before).toFixed(2);
}

/**
 * 该消耗品此刻能否**真的回血**（用于"别让玩家浪费一个绷带"）。
 *
 * 判据是"这次使用能恢复的血量 > 0"，而不是"血量低于该药上限"。
 * 两者的差别在 [M6-BUG-01] 里是**致命**的：绷带曾把 `maxHealthCap: 45` 当成准入门槛，
 * 于是血量 ≥45 时按 3 完全无反应 —— 满血 100 用不了、受伤到 60 也用不了，
 * 玩家只会得出"绷带坏了"的结论（只有掉到 45 以下才生效，而这在正常对局里很少发生）。
 * 现在口径统一为：**未满血就能用；满血（或该药已到自身能治到的上限）才拒绝**。
 * 这样它与 `heal()` 的 ceiling 是同一个判据，配置改动不会让两者分叉。
 */
export function canHealWith(vitals, itemDef) {
  if (!itemDef) return false;
  const ceiling = Math.min(vitals.maxHealth, itemDef.maxHealthCap ?? vitals.maxHealth);
  const amount = Number.isFinite(itemDef.healAmount) ? itemDef.healAmount : 0;
  // heal() 的落点：min(ceiling, health + amount)。只有落点高于当前血量才值得消耗一个道具。
  return Math.min(ceiling, vitals.health + amount) > vitals.health;
}

/**
 * 医疗动作读条进度（纯函数，0~1，可单测）。
 *
 * ★ [M6-BUG-02] 为什么必须把它抽出来：`startedAt` 与 `nowMs` **必须来自同一只时钟**。
 *   原实现里 `useEndAt` 是按**局内时钟**（raidClock：扣掉暂停时长）算的，
 *   而 HUD 却把**原始帧时间戳**传进 `useProgress()` —— 于是只要本局暂停过一次，
 *   读条就会带着"已暂停时长 / 总时长"的偏移量开场：急救包（3000ms）在暂停 2 秒后
 *   一按下去就显示 67%，暂停更久则直接满格。抽成纯函数后这条口径可以被断言守住。
 */
export function useProgressRatio(startedAt, totalMs, nowMs) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(nowMs)) return 0;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return 0;
  const r = (nowMs - startedAt) / totalMs;
  if (!(r > 0)) return 0;
  return r > 1 ? 1 : r;
}

/** 护甲修复/更换（M2 暂只用于调试与后续扩展，不做维修系统） */
export function setArmor(vitals, cfg, slot, armorId) {
  vitals.armor[slot] = makeArmorSlot(cfg, armorId);
}

export function armorSummary(vitals) {
  const parts = [];
  for (const slot of ['head', 'body']) {
    const a = vitals.armor[slot];
    parts.push(`${slot}:${a.id}${a.maxDurability > 0 ? `(${Math.ceil(a.durability)}/${a.maxDurability})` : ''}`);
  }
  return parts.join(' ');
}
