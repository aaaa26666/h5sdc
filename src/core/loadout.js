// M5-3 配装（纯函数）
//
// 职责：槽位编辑、负重与超重档位、库存缺口提示、进局扣件 / 撤离还件、
// 以及 ★ **局外 → 局内的唯一数据结构 raidKit**。
//
// ★ 本文件是"负重"与"配装需求"的唯一算法。界面里不允许出现任何加法 ——
//   它只显示这里算出来的数字（M5 约束词：禁止两处各算一次重量/价格）。
//
// 制作人裁定的三条口径（照抄在这里，免得日后被当成 bug 改掉）：
//   ① 弹药与消耗品**由仓库供给**，与装备同一套规则：
//      进局扣 → 撤离把"没用完的"还回（只扣消耗量）→ 阵亡 / 超时 / 放弃 / 断线则全丢。
//   ② **允许缺件进局**：仓库里不够也让你进，缺什么就在大厅提示什么
//      （不禁止、也不自动削减排装 —— 玩家自己负责）。
//   ③ 弹药的重量**只有一个来源**：掉落表的物品重量 ÷ 每格发数（见 config 的 AMMO_VIEW）。
//
// 关于弹药的单位：仓库条目的 `count` 就是**发数**（每格最多 60 发，由物品的 stack 决定），
// 因此"扣 120 发"与"条目的 count 减 120"是同一件事，不需要换算。

import { stashAdd, stashRemoveItem, stashTotalOf } from './stash.js';
import { itemDef, itemIdOfEquipment, equipmentDef, equipmentIdOfItem, safeTierDef } from './items.js';
import { skillModifiers } from './progression.js';
import { sanitizeLoadoutShape, activeLoadout } from './profile.js';
import { questTrackerView } from './quests.js';

const EQUIP_SLOTS = Object.freeze(['primary', 'secondary', 'body', 'head']);

/** 单发重量（发/件 → kg）。唯一来源：掉落表的物品重量 ÷ 每格发数。 */
export function roundWeightKg(caliber, cfg) {
  const a = cfg.ammo.find((x) => x.id === caliber);
  return a ? a.weightPerRoundKg : 0;
}

/**
 * 配装负重 = 身上装备 + 弹药 + 消耗品。
 * 注意它与局内背包的负重上限（loot.json 的 backpack.weightLimitKg）**不是同一个数**：
 * 后者只管搜到的战利品，前者管出发时的行头。两者混用会让"超重"变成说不清的状态。
 */
export function loadoutWeight(lo, cfg) {
  let kg = 0;
  for (const slot of EQUIP_SLOTS) {
    const eq = lo[slot] ? equipmentDef(lo[slot], cfg) : null;
    if (eq) kg += eq.weightKg;
  }
  for (const [cal, rounds] of Object.entries(lo.ammo || {})) {
    kg += roundWeightKg(cal, cfg) * rounds;
  }
  for (const [id, n] of Object.entries(lo.consumables || {})) {
    const def = itemDef(id, cfg);
    if (def) kg += def.weightKg * n;
  }
  return kg;
}

/**
 * 超重档位（制作人裁定的三档：<20 正常 / <30 略超（×0.8、可冲刺）/
 * <40 超重（×0.6、禁冲刺）/ ≥40 严重（×0.4、禁冲刺））。
 */
export function overweightBand(lo, cfg) {
  const weightKg = loadoutWeight(lo, cfg);
  const bands = cfg.equipment.overweight.bands;
  let idx = bands.length - 1;
  for (let i = 0; i < bands.length; i++) {
    const maxKg = bands[i].maxKg;
    if (maxKg === null || maxKg === undefined || weightKg < maxKg) {
      idx = i;
      break;
    }
  }
  const band = bands[idx];
  const next = bands[idx + 1];
  return {
    band,
    index: idx,
    weightKg,
    /** 下一档的阈值（null = 已是最重档） */
    nextAtKg: next && next.maxKg !== null && next.maxKg !== undefined ? next.maxKg : null,
    /** 距下一档还差多少 kg（已是最重档时为 null） */
    toNextKg: next && next.maxKg ? Math.max(0, next.maxKg - weightKg) : null,
  };
}

/**
 * 这套配装需要从仓库拿走什么。
 * 装备按"件"、弹药按"发"、消耗品按"个" —— 全部与仓库条目的计数单位一致。
 */
export function loadoutRequirements(lo, cfg) {
  const out = [];
  for (const slot of EQUIP_SLOTS) {
    const id = lo[slot];
    if (id) out.push({ itemId: itemIdOfEquipment(id, cfg), count: 1, kind: 'equipment', slot });
  }
  for (const [cal, rounds] of Object.entries(lo.ammo || {})) {
    if (!(rounds > 0)) continue;
    const a = cfg.ammo.find((x) => x.id === cal);
    if (!a || !a.itemId) continue;
    out.push({ itemId: a.itemId, count: rounds, kind: 'ammo', caliber: cal });
  }
  for (const [id, n] of Object.entries(lo.consumables || {})) {
    if (n > 0) out.push({ itemId: id, count: n, kind: 'consumable' });
  }
  return out;
}

/**
 * 某个槽位**仓库里现成可选**的装备（配装界面的下拉项就来自它）。
 *
 * 为什么列"仓库里有的"而不是"配置表里全部的"：制作人裁定**不提醒缺什么** ——
 * 玩家想穿什么进就穿什么进。那么配装界面的正确做法就是把**手上有的**摆出来让他选，
 * 而不是列一堆他买不起/没搜到的东西再标注"缺失"。
 */
export function availableForSlot(profile, slot, cfg) {
  const spec = cfg.equipment.slots.find((s) => s.id === slot);
  if (!spec || spec.disabled) return [];
  const out = [];
  for (const e of profile.stash) {
    const eqId = equipmentIdOfItem(e.itemId, cfg);
    const eq = eqId ? cfg.equipmentDefs[eqId] : null;
    if (!eq) continue;
    if (!spec.accepts.includes(eq.kind)) continue;
    if (eq.kind === 'weapon') {
      if (spec.weaponSlot !== undefined && eq.def.slot !== spec.weaponSlot) continue;
    } else if (eq.kind === 'armor') {
      if (spec.armorCovers !== undefined && !eq.def.covers.includes(spec.armorCovers)) continue;
    }
    if (out.some((o) => o.id === eq.id)) continue;
    out.push({ id: eq.id, itemId: e.itemId, label: eq.label, weightKg: eq.weightKg });
  }
  return out;
}

/** 仓库里某个口径的弹药有多少发（可携带量的上限就是它）。 */
export function ammoOnHand(profile, caliber, cfg) {
  const a = cfg.ammo.find((x) => x.id === caliber);
  if (!a || !a.itemId) return 0;
  return stashTotalOf(profile.stash, a.itemId, cfg);
}

/** 仓库里某个消耗品有多少个。 */
export function consumableOnHand(profile, itemId, cfg) {
  return stashTotalOf(profile.stash, itemId, cfg);
}

/**
 * 进局：把配装从仓库拿走。
 * @returns {{profile:object, taken:Array, missing:Array}}
 *          taken 是"这一局身上带着的东西"，结算时要靠它把没用完的还回去。
 */
export function takeLoadout(profile, cfg) {
  const reqs = loadoutRequirements(activeLoadout(profile), cfg);
  let stash = profile.stash;
  const taken = [];
  const missing = [];
  for (const r of reqs) {
    const res = stashRemoveItem(stash, r.itemId, r.count, cfg);
    stash = res.stash;
    if (res.removed > 0) {
      taken.push({ itemId: r.itemId, count: res.removed, kind: r.kind, caliber: r.caliber || null, slot: r.slot || null });
    }
    if (res.leftover > 0) {
      missing.push({ ...r, missing: res.leftover });
    }
  }
  return { profile: { ...profile, stash }, taken, missing };
}

/**
 * 撤离：把**没用完的**还回仓库。
 *
 * @param {Array} taken takeLoadout 的产物
 * @param {object} remaining 局内剩余 { ammo: {caliber: rounds}, consumables: {itemId: n} }
 *        装备不参与扣减（M5 没有耐久持久化，见 [M5-TEMP-10]），全部原样还回。
 * @returns {{profile:object, returned:Array, consumed:Array, overflow:Array}}
 */
export function returnLoadout(profile, taken, remaining, cfg) {
  let stash = profile.stash;
  const returned = [];
  const consumed = [];
  const overflow = [];

  for (const t of taken) {
    let back = t.count;
    if (t.kind === 'ammo') {
      const left = (remaining && remaining.ammo && remaining.ammo[t.caliber]) || 0;
      back = Math.min(t.count, Math.max(0, left));
    } else if (t.kind === 'consumable') {
      const left = (remaining && remaining.consumables && remaining.consumables[t.itemId]) || 0;
      back = Math.min(t.count, Math.max(0, left));
    }
    if (back < t.count) consumed.push({ itemId: t.itemId, count: t.count - back, kind: t.kind });
    if (back <= 0) continue;
    const add = stashAdd(stash, t.itemId, back, cfg);
    if (add.leftover > 0) overflow.push({ itemId: t.itemId, count: add.leftover });
    stash = add.stash;
    returned.push({ itemId: t.itemId, count: add.added, kind: t.kind });
  }
  return { profile: { ...profile, stash }, returned, consumed, overflow };
}

/**
 * ★ 局外 → 局内的唯一数据结构。
 *
 * 局内系统只**读**它，不再自行查配置表（那正是 M5-TEMP-2 的问题：
 * 局内读的是写死的 startLoadout，与玩家配装无关）。
 */
export function buildRaidKit(profile, cfg) {
  const lo = activeLoadout(profile);
  const ow = overweightBand(lo, cfg);
  const safe = safeTierDef(profile.safeTierUnlocked, cfg);
  return {
    presetId: lo.id,
    presetName: lo.name,
    loadout: {
      primary: lo.primary,
      secondary: lo.secondary,
      armor: { body: lo.body, head: lo.head },
      ammo: { ...lo.ammo },
      consumables: { ...lo.consumables },
      safeTierId: profile.safeTierUnlocked,
      safeTierLabel: safe ? safe.label : null,
    },
    modifiers: skillModifiers(profile, cfg),
    overweight: {
      bandId: ow.band.id,
      label: ow.band.label,
      weightKg: ow.weightKg,
      speedScale: ow.band.speedScale,
      noSprint: ow.band.noSprint,
      nextAtKg: ow.nextAtKg,
    },
    /** 局内 HUD 的任务追踪（制作人裁定：全部列出，最多 maxActive 行） */
    quests: questTrackerView(profile, cfg),
  };
}

// ---------------------------------------------------------------------------
// 配装编辑（返回新档案，与 progression/shop 同一风格）
// ---------------------------------------------------------------------------

/** 更新某套预设的槽位。patch 里的键会被 sanitizeLoadoutShape 逐项校验。 */
export function updatePreset(profile, presetId, patch, cfg) {
  const idx = profile.loadouts.findIndex((l) => l.id === presetId);
  if (idx < 0) return { ok: false, reason: 'unknown-preset' };
  const merged = { ...profile.loadouts[idx], ...patch };
  const { loadout, repairs } = sanitizeLoadoutShape(merged, cfg);
  const loadouts = profile.loadouts.slice();
  loadouts[idx] = loadout;
  return { ok: true, profile: { ...profile, loadouts }, repairs };
}

/** 给某套预设设弹药携带量（按口径，单位：发）。 */
export function setAmmo(profile, presetId, caliber, rounds, cfg) {
  if (!cfg.ammo.some((a) => a.id === caliber)) return { ok: false, reason: 'unknown-caliber' };
  if (!Number.isInteger(rounds) || rounds < 0) return { ok: false, reason: 'bad-count' };
  const lo = profile.loadouts.find((l) => l.id === presetId);
  if (!lo) return { ok: false, reason: 'unknown-preset' };
  const ammo = { ...lo.ammo };
  if (rounds === 0) delete ammo[caliber];
  else ammo[caliber] = rounds;
  return updatePreset(profile, presetId, { ammo }, cfg);
}

/** 给某套预设设消耗品携带量（按物品 id，单位：个）。 */
export function setConsumable(profile, presetId, itemId, count, cfg) {
  if (!cfg.consumables.some((c) => c.id === itemId)) return { ok: false, reason: 'unknown-consumable' };
  if (!Number.isInteger(count) || count < 0) return { ok: false, reason: 'bad-count' };
  const lo = profile.loadouts.find((l) => l.id === presetId);
  if (!lo) return { ok: false, reason: 'unknown-preset' };
  const consumables = { ...lo.consumables };
  if (count === 0) delete consumables[itemId];
  else consumables[itemId] = count;
  return updatePreset(profile, presetId, { consumables }, cfg);
}

/** 新增一套预设（复制当前生效的那套作为起点）。 */
export function addPreset(profile, cfg, nameHint) {
  if (profile.loadouts.length >= cfg.equipment.maxPresets) {
    return { ok: false, reason: `max-presets:${cfg.equipment.maxPresets}` };
  }
  const base = activeLoadout(profile);
  let n = 1;
  while (profile.loadouts.some((l) => l.id === `preset_${n}`)) n++;
  const lo = {
    ...base,
    id: `preset_${n}`,
    name: nameHint || `配装 ${n}`,
  };
  return { ok: true, profile: { ...profile, loadouts: [...profile.loadouts, lo] }, presetId: lo.id };
}

/** 删除预设（必须至少保留一套 —— 否则新账号没有可进局的配装）。cfg 保留在签名里是为了与其它编辑函数同形，当前不使用。 */
export function removePreset(profile, presetId, cfg) {
  if (profile.loadouts.length <= 1) return { ok: false, reason: 'last-preset' };
  if (!profile.loadouts.some((l) => l.id === presetId)) return { ok: false, reason: 'unknown-preset' };
  const loadouts = profile.loadouts.filter((l) => l.id !== presetId);
  const activeLoadoutId = profile.activeLoadoutId === presetId ? loadouts[0].id : profile.activeLoadoutId;
  return { ok: true, profile: { ...profile, loadouts, activeLoadoutId } };
}

/** 切换当前生效的预设。 */
export function setActivePreset(profile, presetId) {
  if (!profile.loadouts.some((l) => l.id === presetId)) return { ok: false, reason: 'unknown-preset' };
  return { ok: true, profile: { ...profile, activeLoadoutId: presetId } };
}

/** 重命名预设。 */
export function renamePreset(profile, presetId, name) {
  const idx = profile.loadouts.findIndex((l) => l.id === presetId);
  if (idx < 0) return { ok: false, reason: 'unknown-preset' };
  const clean = String(name || '').slice(0, 24);
  if (!clean) return { ok: false, reason: 'empty-name' };
  const loadouts = profile.loadouts.slice();
  loadouts[idx] = { ...loadouts[idx], name: clean };
  return { ok: true, profile: { ...profile, loadouts } };
}

/** 配装概览（界面唯一的数据来源）：负重、超重档、缺口、逐槽明细。 */
export function loadoutView(profile, cfg) {
  const lo = activeLoadout(profile);
  const ow = overweightBand(lo, cfg);
  return {
    presetId: lo.id,
    presetName: lo.name,
    primary: lo.primary,
    secondary: lo.secondary,
    body: lo.body,
    head: lo.head,
    ammo: { ...lo.ammo },
    consumables: { ...lo.consumables },
    weightKg: ow.weightKg,
    band: { id: ow.band.id, label: ow.band.label, speedScale: ow.band.speedScale, noSprint: ow.band.noSprint },
    nextAtKg: ow.nextAtKg,
    toNextKg: ow.toNextKg,
    shortfall: loadoutShortfall(lo, profile, cfg),
  };
}
