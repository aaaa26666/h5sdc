// M5 大厅各面板的**数据视图**（纯函数）
//
// 存在原因：M5 约束词要求「所有 UI 数值必须来自配置表，禁止在界面代码里算价格」。
//   五个面板各有各的算法（负重档位、仓库估值、商店买价、技能下一级花费、任务进度），
//   如果让 src/ui/*.js 各自去调 core 的函数并拼装，那么"界面里也算了一点"就迟早发生。
//   因此这里把**面板要显示的每一个数字**一次算完，UI 只负责排版。
//
// 本文件是纯函数：不碰 DOM、不读 localStorage、不持有状态。
// 端到端有一条断言会确认界面的数字与这里的产物一致。

import { profileView, activeLoadout } from './profile.js';
import {
  availableForSlot,
  ammoOnHand,
  consumableOnHand,
  overweightBand,
  loadoutWeight,
  buildCarry,
} from './loadout.js';
import { stashSummary, stashValue, stashWeight } from './stash.js';
import { stockView, sellPriceOf } from './shop.js';
import { questStates } from './quests.js';
import { levelFromExp, skillModifiers, skillLevel, canLearn, respecCost, spentPoints } from './progression.js';
import { itemDef } from './items.js';
import { ACTIONS, isRebindable, resolveBindings } from './keybinds.js';
import { dataKeys } from './lootTable.js';

/**
 * ★ M6：携行具的容量与**进局投放结果**。
 *
 * 为什么必须显示出来：M6 起弹药与药品要占背包格，因此"我在面板上填了 300 发"
 * 与"进战区真的带得进去多少"是两件事。不显示的话，玩家会在局内发现子弹少了，
 * 而那时已经无法补救 —— 静默少带是最容易被当成"游戏坏了"的一类问题。
 */
function carryPanel(lo, cfg) {
  const plan = buildCarry(lo, cfg);
  const total = plan.backpack.w * plan.backpack.h + (plan.rig ? plan.rig.w * plan.rig.h : 0);
  const used = plan.placements.reduce((a, p) => a + p.w * p.h, 0);
  return {
    plan,
    backpack: plan.backpack,
    rig: plan.rig,
    kitSlots: used,
    freeSlots: total - used,
    totalSlots: total,
    overflow: plan.overflow,
  };
}

/** 配装面板：槽位可选装备（只列仓库里现成的）、弹药与消耗品的携带量、负重档位。 */
function loadoutPanel(profile, cfg) {
  const lo = activeLoadout(profile);
  const ow = overweightBand(lo, cfg);
  // ★ M6：负重上限的基数必须是**所装备的背包**，否则面板上写的加成与局内实际不符
  //   （换一只更大的背包后，面板还按参考装载 22kg 算）。
  const carry = carryPanel(lo, cfg);
  const mods = skillModifiers(profile, cfg, { weightBaseKg: carry.backpack.weightLimitKg });

  const slots = cfg.equipment.slots
    .filter((s) => !s.disabled)
    .map((s) => ({
      id: s.id,
      label: s.label,
      current: lo[s.id] || null,
      options: availableForSlot(profile, s.id, cfg),
    }));

  const ammo = cfg.ammo
    .filter((a) => cfg.equipment.ammo.carryCalibers.includes(a.id))
    .map((a) => {
      const def = itemDef(a.itemId, cfg);
      return {
        caliber: a.id,
        label: a.label,
        itemId: a.itemId,
        current: lo.ammo[a.id] || 0,
        onHand: ammoOnHand(profile, a.id, cfg),
        /** 一次点击的步长 = 一格（制作人裁定每格 60 发） */
        step: def ? def.stack : 1,
        perRoundKg: a.weightPerRoundKg,
      };
    });

  const consumables = cfg.consumables.map((c) => ({
    id: c.id,
    label: c.label,
    current: lo.consumables[c.id] || 0,
    onHand: consumableOnHand(profile, c.id, cfg),
    step: 1,
    weightKg: itemDef(c.id, cfg) ? itemDef(c.id, cfg).weightKg : 0,
  }));

  return {
    presetId: lo.id,
    presetName: lo.name,
    presets: profile.loadouts.map((l) => ({
      id: l.id,
      name: l.name,
      active: l.id === profile.activeLoadoutId,
    })),
    canAddPreset: profile.loadouts.length < cfg.equipment.maxPresets,
    maxPresets: cfg.equipment.maxPresets,
    slots,
    ammo,
    consumables,
    weightKg: loadoutWeight(lo, cfg),
    band: {
      id: ow.band.id,
      label: ow.band.label,
      speedScale: ow.band.speedScale,
      noSprint: ow.band.noSprint,
    },
    nextAtKg: ow.nextAtKg,
    toNextKg: ow.toNextKg,
    modifiers: mods,
    /** ★ M6：携行具容量与进局投放结果（含"装不下"的清单，见 carryPanel 的说明） */
    carry: {
      backpack: carry.backpack,
      rig: carry.rig,
      kitSlots: carry.kitSlots,
      freeSlots: carry.freeSlots,
      totalSlots: carry.totalSlots,
      overflow: carry.overflow,
    },
  };
}

/** 仓库面板：网格条目（带坐标与颜色）、排序模式、选中项的估值与卖价。 */
function stashPanel(profile, cfg, ui) {
  const selected = new Set(ui.selectedUids || []);
  const entries = profile.stash.map((e) => {
    const def = itemDef(e.itemId, cfg);
    const rarity = def.rarity ? cfg.lootTable.rarity.find((r) => r.id === def.rarity) : null;
    return {
      uid: e.uid,
      itemId: e.itemId,
      label: def.label,
      count: e.count,
      x: e.x,
      y: e.y,
      w: e.rotated ? def.h : def.w,
      h: e.rotated ? def.w : def.h,
      // 按**存储单位**估值与计重（弹药的一件是一盒 60 发）
      value: def.unitValue * e.count,
      weightKg: def.unitWeightKg * e.count,
      color: rarity ? rarity.colorHex : null,
      sellTotal: sellPriceOf(e.itemId, e.count, cfg),
      selected: selected.has(e.uid),
    };
  });
  const picked = entries.filter((e) => e.selected);
  return {
    w: cfg.economy.stash.w,
    h: cfg.economy.stash.h,
    entries,
    summary: stashSummary(profile.stash, cfg),
    sortModes: cfg.economy.stash.sortModes.slice(),
    selectedCount: picked.length,
    selectedValue: picked.reduce((a, e) => a + e.value, 0),
    selectedSell: picked.reduce((a, e) => a + e.sellTotal, 0),
    value: stashValue(profile.stash, cfg),
    weightKg: stashWeight(profile.stash, cfg),
  };
}

/** 商店面板：逐条在售价（含解锁状态与买得起与否），按类别分组。 */
function shopPanel(profile, cfg) {
  const rows = stockView(profile, cfg);
  const kinds = [
    { kind: 'weapon', label: '武器' },
    { kind: 'armor', label: '护具' },
    { kind: 'item', label: '弹药与医疗' },
  ];
  return {
    currency: profile.currency,
    rows,
    groups: kinds
      .map((g) => ({ ...g, rows: rows.filter((r) => r.kind === g.kind) }))
      .filter((g) => g.rows.length > 0),
  };
}

/** 技能面板：等级与经验、技能点、按分支分组的技能（含下一级花费与可否学习）、洗点价。 */
function skillsPanel(profile, cfg) {
  const lv = levelFromExp(profile.progression.exp, cfg);
  const branches = cfg.progression.branches.map((b) => ({
    id: b.id,
    label: b.label,
    skills: cfg.progression.skills
      .filter((s) => s.branch === b.id)
      .slice()
      .sort((a, z) => a.tier - z.tier)
      .map((s) => {
        const level = skillLevel(profile, s.id);
        const can = canLearn(profile, s.id, cfg);
        return {
          id: s.id,
          label: s.label,
          desc: s.desc,
          tier: s.tier,
          level,
          maxLevel: s.maxLevel,
          nextCost: level < s.maxLevel ? s.costPerLevel[level] : null,
          canLearn: can.ok,
          reason: can.reason || null,
        };
      }),
  }));
  const spent = spentPoints(profile, cfg);
  const cost = respecCost(profile, cfg);
  return {
    level: lv.level,
    exp: profile.progression.exp,
    expInLevel: lv.expInLevel,
    expForLevel: lv.expForLevel,
    isMax: lv.isMax,
    skillPoints: profile.progression.skillPoints,
    spentPoints: spent,
    respecCost: cost,
    canRespec: spent > 0 && profile.currency >= cost,
    branches,
    modifiers: skillModifiers(profile, cfg),
  };
}

/** 任务面板：任务总览（状态 / 目标进度 / 奖励）。 */
function questsPanel(profile, cfg) {
  const list = questStates(profile, cfg);
  return {
    list,
    activeCount: profile.quests.active.length,
    maxActive: cfg.quests.maxActive,
    completedCount: profile.quests.completed.length,
    claimedCount: profile.quests.claimed.length,
  };
}

/** 设置项的显示名（**文案**，不是数值） */
const SETTING_LABELS = Object.freeze({
  sprintMode: '冲刺',
  crouchMode: '蹲下',
  mouseSens: '鼠标灵敏度',
  masterVolume: '主音量',
  sfxVolume: '音效音量',
  musicVolume: '音乐音量',
  graphicsQuality: '画质档位',
  touchLayout: '触屏布局',
});

/**
 * 设置面板的视图（M5-8）。
 *
 * 为什么放在 core：设置项的**档位**来自配置表、键位来自 core/keybinds.js，
 *   界面只该拿到"有哪些项、当前是什么、能不能改"。把这些拼装留在 ui/ 里，
 *   "界面里也算了一点"就会从设置面板开始。
 *
 * @param {object} settings 当前设置
 * @param {boolean} opts.allowRebind 是否允许改键（制作人裁定：**仅大厅**）
 */
export function buildSettingsView(settings, cfg, opts = {}) {
  const schema = cfg.settings.schema;
  const options = dataKeys(schema)
    .filter((k) => k !== 'bindings')
    .map((key) => ({
      key,
      label: SETTING_LABELS[key] || key,
      values: schema[key].values.slice(),
      current: settings[key],
    }));

  const resolved = resolveBindings(settings);
  const bindings = ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    keys: resolved[a.id].slice(),
    /** 移动类固定（制作人裁定）：界面据此显示"固定"而不是"改键" */
    locked: !isRebindable(a.id),
  }));

  return {
    options,
    bindings,
    allowRebind: !!opts.allowRebind,
    notes: opts.notes || '',
    onClose: opts.onClose || null,
  };
}

/**
 * 一次算完所有面板的数据。
 * @param {object} ui 界面态（选中集合等）—— 它**不影响**任何玩法数值，只影响显示
 */
export function buildLobbyViews(profile, cfg, ui = {}) {
  return {
    stats: profileView(profile, cfg),
    loadout: loadoutPanel(profile, cfg),
    stash: stashPanel(profile, cfg, ui),
    shop: shopPanel(profile, cfg),
    skills: skillsPanel(profile, cfg),
    quests: questsPanel(profile, cfg),
  };
}
