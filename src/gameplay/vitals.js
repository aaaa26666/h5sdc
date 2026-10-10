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

/** 该消耗品此刻能否产生效果（用于"别让玩家浪费一个绷带"） */
export function canHealWith(vitals, itemDef) {
  const ceiling = Math.min(vitals.maxHealth, itemDef.maxHealthCap);
  return vitals.health < ceiling;
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
