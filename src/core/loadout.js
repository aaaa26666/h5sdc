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

import { stashAdd, stashRemove, stashRemoveItem, stashTotalOf, stashAddAt } from './stash.js';
import { itemDef, itemIdOfEquipment, equipmentDef, equipmentIdOfItem, safeTierDef, itemShape } from './items.js';
import { skillModifiers } from './progression.js';
import { sanitizeLoadoutShape, activeLoadout, safeSpecOf } from './profile.js';
import { questTrackerView } from './quests.js';
import {
  CARRY_GRIDS,
  SPENDABLE_GRIDS,
  cloneCarry,
  carrySpecs,
  carryAddAt,
  carryMoveTo,
  carryRemove,
  carryDeduct,
  carryTotalOf,
  carryTotals,
  carryWeightKg,
  carryUsedSlots,
  carryAudit,
  findCarrySlot,
  splitIntoBoxes,
} from './carry.js';

// ★ M6：背包与弹挂进槽位表。它们既是装备（占仓库格、按件取放、阵亡会丢），
//   也是**局内容量的来源** —— 因此必须和其它装备走同一条"进局扣件 / 撤离还件"的路，
//   否则"死了背包还在"只需一行代码就会发生。
const EQUIP_SLOTS = Object.freeze(['primary', 'secondary', 'body', 'head', 'backpack', 'rig']);

/** 单发重量（发/件 → kg）。唯一来源：掉落表的物品重量 ÷ 每格发数。 */
export function roundWeightKg(caliber, cfg) {
  const a = cfg.ammo.find((x) => x.id === caliber);
  return a ? a.weightPerRoundKg : 0;
}

/** 配装的携行网格（存档是外部输入：缺了就补空的，不让下游到处判空）。 */
export function carryOf(lo) {
  const c = (lo && lo.carry) || null;
  return {
    backpack: Array.isArray(c && c.backpack) ? c.backpack : [],
    rig: Array.isArray(c && c.rig) ? c.rig : [],
    safe: Array.isArray(c && c.safe) ? c.safe : [],
  };
}

/** 三张网格的规格（保险箱档位来自档案，不在配装里）。 */
export function carrySpecsFor(lo, profile, cfg) {
  return carrySpecs(lo, cfg.carry, safeSpecOf(cfg, profile && profile.safeTierUnlocked));
}

/**
 * 配装负重 = 身上装备 + 携行网格里的全部东西（含保险箱里的 —— 它们也在身上）。
 * 注意它与局内背包的负重上限（loot.json 的 backpack.weightLimitKg）**不是同一个数**：
 * 后者只管搜到的战利品，前者管出发时的行头。两者混用会让"超重"变成说不清的状态。
 *
 * ★ M6-4：携行网格是真值，因此这里数网格而不是读一份数字（数字账已删除）。
 */
export function loadoutWeight(lo, cfg) {
  let kg = 0;
  for (const slot of EQUIP_SLOTS) {
    const eq = lo[slot] ? equipmentDef(lo[slot], cfg) : null;
    if (eq) kg += eq.weightKg;
  }
  kg += carryWeightKg(carryOf(lo), cfg.itemDefs);
  return kg;
}

/**
 * 网格里每种弹药有多少发（**派生量**，不是另存的一份）。
 * @returns {{[caliber:string]: number}}
 */
export function kitAmmo(lo, cfg) {
  const out = {};
  for (const a of cfg.ammo || []) {
    if (!a.itemId) continue;
    const n = carryTotalOf(carryOf(lo), a.itemId, SPENDABLE_GRIDS);
    if (n > 0) out[a.id] = n;
  }
  return out;
}

/** 网格里每种消耗品有几个（同上，派生量）。 */
export function kitConsumables(lo, cfg) {
  const out = {};
  for (const c of cfg.consumables || []) {
    const n = carryTotalOf(carryOf(lo), c.id, SPENDABLE_GRIDS);
    if (n > 0) out[c.id] = n;
  }
  return out;
}

/**
 * ★ M6-4：进局投放 = **玩家自己拖出来的那份网格**（销 [M5-TEMP-11]，也销掉了
 *   "配装上写个数字、进局再自动摆一遍"这条老路径）。
 *
 * 为什么要摆在大厅而不是等进局：容量是**出发前**就定下来的东西。
 * 若等进局再摆，"我以为带了 180 发、实际只有 120 发"只能在局内被发现 —— 那时已经晚了。
 * 现在更彻底：带什么由玩家拖，摆不下就根本拖不进去（拖放即校验）。
 *
 * @param {object} [opts.profile] 需要它读保险箱档位（第三张网格的尺寸在档案层）
 * @returns {{backpack, rig, safe, placements, safePlacements, overflow, totalSlots, kitSlots, freeSlots}}
 */
export function buildCarry(lo, cfg, opts = {}) {
  const safeSpec = opts.safeSpec !== undefined ? opts.safeSpec : safeSpecOf(cfg, opts.profile && opts.profile.safeTierUnlocked);
  const specs = carrySpecs(lo, cfg.carry, safeSpec);
  const carry = carryOf(lo);
  const placements = [];
  const safePlacements = [];
  for (const name of CARRY_GRIDS) {
    if (!specs[name]) continue;
    for (const e of carry[name]) {
      const def = cfg.itemDefs[e.itemId];
      if (!def) continue;
      const sh = itemShape(def, e.rotated);
      const a = (cfg.ammo || []).find((x) => x.itemId === e.itemId);
      const row = {
        itemId: e.itemId,
        count: e.count,
        kind: a ? 'ammo' : 'consumable',
        caliber: a ? a.id : null,
        grid: name,
        x: e.x,
        y: e.y,
        w: sh.w,
        h: sh.h,
        rotated: !!e.rotated,
        uid: e.uid,
      };
      if (name === 'safe') safePlacements.push(row);
      else placements.push(row);
    }
  }
  const totalSlots = specs.backpack.w * specs.backpack.h + (specs.rig ? specs.rig.w * specs.rig.h : 0);
  const kitSlots = carryUsedSlots(carry, cfg.itemDefs, SPENDABLE_GRIDS);
  //
  // ★ M6-4：`overflow` 改成**进局检查查出来的违规件**。
  //
  //   为什么不能再是"投放算法的副产品"：带什么现在是玩家**拖**出来的，
  //   拖不进去当场就被拦下 —— 于是"装不下"只可能来自**事后变化**
  //   （换了更小的包、旧存档迁移、外部改档），而那正是 carryAudit 在查的东西。
  //   留一个恒为空的 overflow 等于留一个**永远为真的假信号**：简报会一直说"没有装不下"。
  const audit = carryAudit(carry, specs, cfg.itemDefs);
  return {
    backpack: specs.backpack,
    rig: specs.rig,
    safe: specs.safe,
    placements,
    safePlacements,
    /** 带不进去的那几件（进局前会被拦下）。空 = 确实没有。 */
    overflow: audit.offenders,
    audit,
    totalSlots,
    kitSlots,
    freeSlots: Math.max(0, totalSlots - kitSlots),
  };
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
 * 这套配装需要从仓库拿走什么 —— **只有装备**。
 *
 * ★ M6-4：弹药与消耗品不再属于这里。它们已经在携行网格里（= 已经在身上），
 *   拖进去那一步就已经从仓库移走了；再把它列成"需要取走"就会扣第二次。
 */
export function loadoutRequirements(lo, cfg) {
  const out = [];
  for (const slot of EQUIP_SLOTS) {
    const id = lo[slot];
    if (id) out.push({ itemId: itemIdOfEquipment(id, cfg), count: 1, kind: 'equipment', slot });
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
 *
 * ★ M6：拿走什么**由实际摆进网格的东西决定**，而不是由"配装上写了多少"决定。
 *   否则"要 180 发但只摆得下 120 发"会把这 60 发从仓库扣掉却带不进战区 ——
 *   一次静默的物资蒸发。扣不掉的那部分进 missing，摆不下的进 overflow，两者都要报给玩家。
 *
 * @returns {{profile:object, taken:Array, missing:Array, overflow:Array, carry:object, effectiveLoadout:object}}
 *          taken 是"这一局身上带着的东西"，结算时要靠它把没用完的还回去。
 *          effectiveLoadout 是**仓库真的拿得出**的那份配装 —— 局内必须按它建包，理由见下。
 */
export function takeLoadout(profile, cfg) {
  const lo = activeLoadout(profile);
  const plan0 = buildCarry(lo, cfg, { profile });
  let stash = profile.stash;
  const taken = [];
  const safeTaken = [];
  const missing = [];

  // ---- ① 装备（含背包与弹挂）：按件，从仓库取 ----
  const equipTaken = new Set();
  for (const slot of EQUIP_SLOTS) {
    const id = lo[slot];
    if (!id) continue;
    const itemId = itemIdOfEquipment(id, cfg);
    const res = stashRemoveItem(stash, itemId, 1, cfg);
    stash = res.stash;
    if (res.removed > 0) {
      taken.push({ itemId, count: res.removed, kind: 'equipment', caliber: null, slot, grid: null });
      equipTaken.add(slot);
    }
    if (res.leftover > 0) missing.push({ itemId, count: 1, kind: 'equipment', slot, missing: res.leftover });
  }

  // ---- ② 携行件（弹药 / 消耗品）：**不从仓库取** ----
  //
  // ★ M6-4 的口径：它们早就在身上了（拖进网格那一步就已经离开仓库）。
  //   这里只是记一笔"这一局带进去了什么" —— 结算要靠它算消耗与损失。
  //   保险箱里的东西单独记一笔：它们**不会被消耗**，阵亡也丢不了，
  //   混进 taken 会让"打掉的子弹"把箱里的存货也算成消耗。
  for (const p of plan0.placements) {
    taken.push({ itemId: p.itemId, count: p.count, kind: p.kind, caliber: p.caliber, slot: null, grid: p.grid });
  }
  for (const p of plan0.safePlacements) {
    safeTaken.push({ itemId: p.itemId, count: p.count, kind: p.kind, caliber: p.caliber, slot: null, grid: 'safe' });
  }

  // ---- ③ 生效配装：装备按"仓库真的拿得出"的，携行网格原样带上（它本身就是真值）----
  const effLo = {
    ...lo,
    primary: equipTaken.has('primary') ? lo.primary : null,
    secondary: equipTaken.has('secondary') ? lo.secondary : null,
    body: equipTaken.has('body') ? lo.body : null,
    head: equipTaken.has('head') ? lo.head : null,
    backpack: equipTaken.has('backpack') ? lo.backpack : null,
    rig: equipTaken.has('rig') ? lo.rig : null,
    carry: carryOf(lo),
  };
  const carry = buildCarry(effLo, cfg, { profile });

  return {
    profile: { ...profile, stash },
    taken,
    safeTaken,
    missing,
    overflow: [],
    carry,
    effectiveLoadout: effLo,
  };
}

/**
 * ★ M6-4：一局结束后的**携行网格账**。
 *
 * 三条口径（制作人裁定，别当成 bug 改掉）：
 *   ① 撤离：只从网格里扣掉**真实消耗**（打掉的子弹、用掉的绷带），剩下的仍留在身上，
 *      由玩家自己决定拖不拖回仓库 —— 不再自动还回（那会把"身上"和"家里"搞混）。
 *   ② 战利品：先塞回携行网格（弹挂优先），网格塞不下才进仓库，**绝不静默丢弃**。
 *   ③ 未撤离（阵亡 / 超时 / 放弃 / 断线）：背包与弹挂清空；**保险箱保留** ——
 *      那就是保险箱存在的理由。
 *
 * ★ ④ 装备（武器 / 护甲 / 背包 / 弹挂）：撤离才还回仓库，阵亡则整份丢失。
 *   它与网格里的东西**不是**同一条账 —— 那些留在身上让玩家自己决定，
 *   而装备在进局那一刻就已经离开仓库了，不主动还回去就是"凭空少了一把枪"。
 *
 * @param {object} input {survived, consumed:[{itemId,count}], loot:[{id,count}],
 *                        equipment:[{itemId,count}]}
 * @returns {{profile, stowed:Array, deposited:Array, overflow:Array, returned:Array}}
 *          stowed = 留在网格里的战利品；deposited = 网格塞不下、进了仓库的；
 *          returned = 撤离时还回仓库的装备
 */
export function settleCarryAfterRaid(profile, input, cfg) {
  const { survived, consumed, loot, equipment } = input || {};
  const lo = activeLoadout(profile);
  const specs = carrySpecsFor(lo, profile, cfg);
  let carry = cloneCarry(carryOf(lo));
  let stash = profile.stash;
  const stowed = [];
  const deposited = [];
  const returned = [];
  const overflow = [];

  if (!survived) {
    // 阵亡：身上的东西全丢（保险箱不动）；装备同样不还 —— 死一次就丢装备。
    carry.backpack = [];
    carry.rig = [];
  } else {
    // ① 扣消耗：网格是唯一真值，因此"打掉 37 发"就是把网格里的 37 发抹掉
    for (const c of consumed || []) {
      if (!(c && c.count > 0)) continue;
      const r = carryDeduct(carry, c.itemId, c.count, SPENDABLE_GRIDS);
      carry = r.carry;
    }
    // ② 装备还回仓库（它们在进局那一刻就从仓库取走了，不还就是凭空消失）
    for (const e of equipment || []) {
      if (!(e && e.count > 0)) continue;
      const add = stashAdd(stash, e.itemId, e.count, cfg);
      stash = add.stash;
      if (add.added > 0) returned.push({ itemId: e.itemId, count: add.added });
      if (add.leftover > 0) overflow.push({ itemId: e.itemId, count: add.leftover });
    }
  }

  // ③ 战利品：撤离时**先身上、后家里**；阵亡时只有安全箱保住的那一批，直接回家。
  //
  //   阵亡那条分支必须存在：`kept` 里的东西是**已经带出来**的（安全箱里的），
  //   而网格刚刚被清空 —— 不在这里落库，它们就凭空消失了。
  for (const it of loot || []) {
    const def = cfg.itemDefs[it && it.id];
    if (!def) continue;
    // 局内按"件"、身上按"存储单位"：弹药的一件是一盒（unitsPerItem 发）
    const units = Number.isFinite(it.count) ? it.count : def.unitsPerItem;
    for (const count of splitIntoBoxes(units, def.stack)) {
      const slot = survived ? findCarrySlot(carry, def, specs, cfg.itemDefs, SPENDABLE_GRIDS) : null;
      if (slot) {
        const r = carryAddAt(carry, slot.name, def.id, count, slot.x, slot.y, slot.rotated, specs, cfg.itemDefs);
        if (r.ok) {
          carry = r.carry;
          stowed.push({ itemId: def.id, count, grid: slot.name });
          continue;
        }
      }
      const add = stashAdd(stash, def.id, count, cfg);
      stash = add.stash;
      if (add.added > 0) deposited.push({ itemId: def.id, count: add.added, grid: 'stash' });
      if (add.leftover > 0) overflow.push({ itemId: def.id, count: add.leftover });
    }
  }

  const loadouts = profile.loadouts.map((l) => (l.id === lo.id ? { ...l, carry } : l));
  return { profile: { ...profile, stash, loadouts }, carry, stowed, deposited, returned, overflow };
}

/**
 * 换上更小（或没有）的携行具时，把放不下的东西**退回仓库**。
 *
 * 为什么不能静默丢弃：那些东西是玩家自己一格一格拖进去的，
 * 凭空消失是最难解释、也最不可原谅的一类缺陷。
 * 仓库也放不下 → 整次操作**拒绝**（调用方据此回滚），让玩家先腾地方。
 * @returns {{ok:boolean, reason?:string, carry?:object, stash?:Array}}
 */
export function evictCarryOverflow(profile, lo, nextCarry, cfg) {
  const specs = carrySpecsFor(lo, profile, cfg);
  let carry = cloneCarry(nextCarry);
  let stash = profile.stash;
  // 反复收敛：取走一件之后，后面那些"重叠"的判定可能就成立了
  for (let guard = 0; guard < 200; guard++) {
    const audit = carryAudit(carry, specs, cfg.itemDefs);
    if (audit.ok) return { ok: true, carry, stash };
    const off = audit.offenders[0];
    const rm = carryRemove(carry, off.uid);
    if (!rm.ok) return { ok: false, reason: rm.reason };
    carry = rm.carry;
    const add = stashAdd(stash, rm.removed.itemId, rm.removed.count, cfg);
    if (add.leftover > 0) return { ok: false, reason: 'stash-full' };
    stash = add.stash;
  }
  return { ok: false, reason: 'carry-not-converged' };
}

/**
 * ★ 局外 → 局内的唯一数据结构。
 *
 * 局内系统只**读**它，不再自行查配置表（那正是 M5-TEMP-2 的问题：
 * 局内读的是写死的 startLoadout，与玩家配装无关）。
 */
export function buildRaidKit(profile, cfg, opts = {}) {
  // ★ M6：`opts.loadout` 由 takeLoadout 给（= 仓库**真的拿得出**的那份）。
  //   不传时退回档案里的配装 —— 纯逻辑单测与"还没进局"的简报走这条路径。
  const lo = opts.loadout || activeLoadout(profile);
  const ow = overweightBand(lo, cfg);
  const safe = safeTierDef(profile.safeTierUnlocked, cfg);
  // ★ M6：携行具决定局内容量，因此**先**解析携行具，再按它的负重上限算技能加成。
  //   顺序反了的话，换一只更大的背包不会改变负重上限（加成永远按参考背包算）。
  const carry = opts.carry || buildCarry(lo, cfg, { profile });
  const mods = skillModifiers(profile, cfg, { weightBaseKg: carry.backpack.weightLimitKg });
  carry.backpack.weightLimitTotalKg = mods.weightLimitKg;
  return {
    presetId: lo.id,
    presetName: lo.name,
    loadout: {
      primary: lo.primary,
      secondary: lo.secondary,
      armor: { body: lo.body, head: lo.head },
      backpack: lo.backpack || null,
      rig: lo.rig || null,
      /**
       * ★ M6-4：这两个是**数网格数出来的派生量**（备弹多少发、药品几个）。
       * 局内**禁止**读它们当真值 —— 真值是网格；它们只用于显示与结算对账。
       */
      ammo: kitAmmo(lo, cfg),
      consumables: kitConsumables(lo, cfg),
      safeTierId: profile.safeTierUnlocked,
      safeTierLabel: safe ? safe.label : null,
    },
    /** ★ M6-4：身上真的摆着什么（含格坐标，含保险箱）。局内据此建网格，不再自己猜。 */
    carry,
    modifiers: mods,
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

// ---------------------------------------------------------------------------
// ★ M6-4 携行网格的拖放（纯函数）
//
// 与"仓库 ↔ 装备格"那一组并列：判定与落库都在 core（界面一个格子碰撞都不算），
// 且**先判后放**用的是同一个 carryCanPlace —— 不会出现"看着能放、松手弹回去"。
// ---------------------------------------------------------------------------

const presetOf = (profile, presetId) =>
  (profile.loadouts || []).find((l) => l.id === presetId) || activeLoadout(profile);

/**
 * 仓库 → 携行网格。**整叠搬走**（拖进背包＝从仓库移走，这就是"算移走"那条裁定）。
 * 拆分数量另有专门入口（core/stash.js 的 stashSplit），拖放本身不切分堆叠。
 */
export function carryPlaceFromStash(profile, presetId, uid, gridName, x, y, rotated, cfg) {
  const entry = (profile.stash || []).find((e) => e.uid === uid);
  if (!entry) return { ok: false, reason: 'unknown-uid' };
  const lo = presetOf(profile, presetId);
  const specs = carrySpecsFor(lo, profile, cfg);
  const add = carryAddAt(carryOf(lo), gridName, entry.itemId, entry.count, x, y, rotated, specs, cfg.itemDefs);
  if (!add.ok) return { ok: false, reason: add.reason };
  // 落库成功才动仓库：顺序反了会出现"网格里有、仓库里也在"的两份
  const rem = stashRemove(profile.stash, uid, entry.count, cfg);
  if (!(rem.removed > 0)) return { ok: false, reason: 'unknown-uid' };
  const loadouts = profile.loadouts.map((l) => (l.id === lo.id ? { ...l, carry: add.carry } : l));
  return { ok: true, profile: { ...profile, stash: rem.stash, loadouts }, uid: add.uid, grid: gridName };
}

/** 携行网格 → 仓库（整叠拖回）。`cell` 给 null 时由仓库自己找位置。 */
export function carryTakeToStash(profile, presetId, uid, cell, cfg) {
  const lo = presetOf(profile, presetId);
  const rm = carryRemove(carryOf(lo), uid);
  if (!rm.ok) return rm;
  const e = rm.removed;
  let stash;
  if (cell) {
    const r = stashAddAt(profile.stash, e.itemId, e.count, cell.x, cell.y, !!cell.rotated, cfg);
    if (!r.ok) return r;
    stash = r.stash;
  } else {
    const add = stashAdd(profile.stash, e.itemId, e.count, cfg);
    if (add.leftover > 0) return { ok: false, reason: 'stash-full' };
    stash = add.stash;
  }
  const loadouts = profile.loadouts.map((l) => (l.id === lo.id ? { ...l, carry: rm.carry } : l));
  return { ok: true, profile: { ...profile, stash, loadouts }, itemId: e.itemId, count: e.count };
}

/** 网格内移动 / 跨网格搬运（背包 ↔ 弹挂 ↔ 保险箱）。 */
export function carryMove(profile, presetId, uid, gridName, x, y, rotated, cfg) {
  const lo = presetOf(profile, presetId);
  const specs = carrySpecsFor(lo, profile, cfg);
  const res = carryMoveTo(carryOf(lo), uid, gridName, x, y, rotated, specs, cfg.itemDefs);
  if (!res.ok) return { ok: false, reason: res.reason };
  const loadouts = profile.loadouts.map((l) => (l.id === lo.id ? { ...l, carry: res.carry } : l));
  return { ok: true, profile: { ...profile, loadouts } };
}

/**
 * 进局前的**可携带性检查**（core/carry.js 的 carryAudit + 这里的规格）。
 * 制作人裁定：类别不合法与超出容量**两类都查**，用一个警告页把 offending 的条目点出来。
 */
export function auditCarryBeforeRaid(profile, cfg) {
  const lo = activeLoadout(profile);
  const carry = carryOf(lo);
  const specs = carrySpecsFor(lo, profile, cfg);
  const audit = carryAudit(carry, specs, cfg.itemDefs);
  return { ...audit, presetId: lo.id };
}

/** 把 offending 的那几件**（且只这几件）**退回仓库。仓库放不下就整次拒绝。 */
export function returnOffendersToStash(profile, offenders, cfg) {
  const lo = activeLoadout(profile);
  let carry = cloneCarry(carryOf(lo));
  let stash = profile.stash;
  const returned = [];
  for (const off of offenders || []) {
    const rm = carryRemove(carry, off.uid);
    if (!rm.ok) continue;
    carry = rm.carry;
    const add = stashAdd(stash, rm.removed.itemId, rm.removed.count, cfg);
    if (add.leftover > 0) return { ok: false, reason: 'stash-full' };
    stash = add.stash;
    returned.push({ itemId: rm.removed.itemId, count: rm.removed.count });
  }
  const loadouts = profile.loadouts.map((l) => (l.id === lo.id ? { ...l, carry } : l));
  return { ok: true, profile: { ...profile, stash, loadouts }, returned };
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

// ---------------------------------------------------------------------------
// ★ M6 拖放：从仓库穿上 / 脱下放回仓库（纯函数）
//
// 为什么这两件事要收在这里：装备格的**接受规则**（槽位白名单、武器槽号、护甲部位）
// 与 core/profile.js 的 sanitizeLoadoutShape 是同一套。若在界面的事件处理里另判一次，
// 就会出现"拖过去看起来成功了、进局却是空的"——因为收敛时被丢掉了。
// 这里返回的原因串（slot-rejects:backpack / wrong-cover …）就是给界面直接显示的。
// ---------------------------------------------------------------------------

/**
 * 某个槽位是否接受某件物品。
 * @returns {{ok:boolean, reason?:string, equipmentId?:string}}
 */
export function slotAcceptsItem(slotId, itemId, cfg) {
  const spec = (cfg.equipment.slots || []).find((s) => s.id === slotId);
  if (!spec || spec.disabled) return { ok: false, reason: 'no-such-slot' };
  const eqId = equipmentIdOfItem(itemId, cfg);
  const eq = eqId ? equipmentDef(eqId, cfg) : null;
  if (!eq) return { ok: false, reason: 'not-equipment' };
  if (!spec.accepts.includes(eq.kind)) return { ok: false, reason: `slot-rejects:${eq.kind}` };
  if (eq.kind === 'weapon' && spec.weaponSlot !== undefined && eq.def.slot !== spec.weaponSlot) {
    return { ok: false, reason: 'wrong-weapon-slot' };
  }
  if (eq.kind === 'armor' && spec.armorCovers !== undefined && !eq.def.covers.includes(spec.armorCovers)) {
    return { ok: false, reason: 'wrong-cover' };
  }
  return { ok: true, equipmentId: eqId };
}

/**
 * 从仓库把某一条（按 uid）穿到槽位上。**该槽原来那件还回仓库**（不是丢掉）。
 *
 * 仓库放不下还回的那件时，整次操作**回滚**并返回 `stash-full` ——
 * 宁可让玩家先腾地方，也不能悄悄吞掉一件装备。
 */
export function equipFromStash(profile, presetId, uid, slotId, cfg) {
  const entry = profile.stash.find((e) => e.uid === uid);
  if (!entry) return { ok: false, reason: 'unknown-uid' };
  const acc = slotAcceptsItem(slotId, entry.itemId, cfg);
  if (!acc.ok) return acc;

  const lo = profile.loadouts.find((l) => l.id === presetId) || activeLoadout(profile);
  // 按 uid 取走**一件**（不是按 itemId 取"任意一件"）：玩家拖的是屏幕上那一格
  const rem = stashRemove(profile.stash, uid, 1, cfg);
  if (!(rem.removed > 0)) return { ok: false, reason: 'unknown-uid' };
  let stash = rem.stash;

  const prev = lo[slotId] || null;
  if (prev) {
    const add = stashAdd(stash, itemIdOfEquipment(prev, cfg), 1, cfg);
    if (add.leftover > 0) return { ok: false, reason: 'stash-full' };
    stash = add.stash;
  }

  const merged = { ...lo, [slotId]: acc.equipmentId };
  const { loadout, repairs } = sanitizeLoadoutShape(merged, cfg, {
    safeSpec: safeSpecOf(cfg, profile.safeTierUnlocked),
  });
  // ★ M6-4：换上更小（或没有）的背包 / 弹挂时，网格里放不下的东西必须**退回仓库**。
  //   不这么做的后果是静默丢东西 —— 玩家会看到"我的子弹没了"，而没有任何提示。
  const withPrev = { ...profile, stash };
  const evicted = evictCarryOverflow(withPrev, loadout, loadout.carry, cfg);
  if (!evicted.ok) return { ok: false, reason: evicted.reason };
  const loadouts = profile.loadouts.map((l) =>
    l.id === lo.id ? { ...loadout, carry: evicted.carry } : l
  );
  return { ok: true, profile: { ...profile, stash: evicted.stash, loadouts }, repairs };
}

/**
 * 把槽位上的装备脱到仓库。
 * @param {object|null} cell 指定落点 `{x,y,rotated}`；给 null 时由仓库自己找位置。
 */
export function unequipToStash(profile, presetId, slotId, cell, cfg) {
  const lo = profile.loadouts.find((l) => l.id === presetId) || activeLoadout(profile);
  const cur = lo[slotId];
  if (!cur) return { ok: false, reason: 'empty-slot' };
  const itemId = itemIdOfEquipment(cur, cfg);

  let stash;
  if (cell) {
    const r = stashAddAt(profile.stash, itemId, 1, cell.x, cell.y, !!cell.rotated, cfg);
    if (!r.ok) return r;
    stash = r.stash;
  } else {
    const add = stashAdd(profile.stash, itemId, 1, cfg);
    if (add.leftover > 0) return { ok: false, reason: 'stash-full' };
    stash = add.stash;
  }

  const merged = { ...lo, [slotId]: null };
  const { loadout, repairs } = sanitizeLoadoutShape(merged, cfg, {
    safeSpec: safeSpecOf(cfg, profile.safeTierUnlocked),
  });
  // ★ M6-4：摘掉背包 / 弹挂会让网格变小（弹挂直接消失），放不下的东西退回仓库。
  const withPrev = { ...profile, stash };
  const evicted = evictCarryOverflow(withPrev, loadout, loadout.carry, cfg);
  if (!evicted.ok) return { ok: false, reason: evicted.reason };
  const loadouts = profile.loadouts.map((l) =>
    l.id === lo.id ? { ...loadout, carry: evicted.carry } : l
  );
  return { ok: true, profile: { ...profile, stash: evicted.stash, loadouts }, repairs };
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

// ★ 删掉了 `loadoutView` 这个函数（此前注释自称"界面唯一的数据来源"，实际**无人调用**，
//   而且它引用的 `loadoutShortfall` 根本不存在 —— 一调用就抛 ReferenceError）。
//   界面的唯一数据来源是 core/lobbyView.js 的 buildLobbyViews，留着第二份概览
//   就是一条"看起来还能用"的死路（而且是一条会崩的死路）。
