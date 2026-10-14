// M5 大厅各面板的**数据视图**（纯函数）
//
// 存在原因：M5 约束词要求「所有 UI 数值必须来自配置表，禁止在界面代码里算价格」。
//   五个面板各有各的算法（负重档位、仓库估值、商店买价、技能下一级花费、任务进度），
//   如果让 src/ui/*.js 各自去调 core 的函数并拼装，那么"界面里也算了一点"就迟早发生。
//   因此这里把**面板要显示的每一个数字**一次算完，UI 只负责排版。
//
// 本文件是纯函数：不碰 DOM、不读 localStorage、不持有状态。
// 端到端有一条断言会确认界面的数字与这里的产物一致。

import { profileView, activeLoadout, safeSpecOf } from './profile.js';
import {
  availableForSlot,
  overweightBand,
  loadoutWeight,
  buildCarry,
  carryOf,
  carrySpecsFor,
  kitAmmo,
  kitConsumables,
} from './loadout.js';
import { stashSummary, stashValue, stashWeight } from './stash.js';
import { stockView, sellPriceOf } from './shop.js';
import { questStates } from './quests.js';
import { levelFromExp, skillModifiers, skillLevel, canLearn, respecCost, spentPoints } from './progression.js';
import { itemDef, equipmentDef, valueReadout } from './items.js';
import { ACTIONS, isRebindable, resolveBindings } from './keybinds.js';
import { dataKeys } from './lootTable.js';

/**
 * 网格里一条物品怎么显示（**渲染与拖放共用同一份形状**）。
 *
 * ★ `w/h` 是已经摆好朝向的尺寸（渲染用），`baseW/baseH` 是未旋转的基准尺寸
 *   （拖放幽灵用它 + `rotated` 自己算朝向 —— 见 ui/dragdrop.js 的 shapeFor）。
 */
function carryEntryView(e, cfg) {
  const def = itemDef(e.itemId, cfg);
  if (!def) return null;
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
    baseW: def.w,
    baseH: def.h,
    rotated: !!e.rotated,
    category: def.category,
    value: valueReadout(def, e.count),
    weightKg: (def.unitWeightKg !== undefined ? def.unitWeightKg : def.weightKg) * e.count,
    color: rarity ? rarity.colorHex : null,
  };
}

/**
 * ★ M6-4：三张携行网格（背包 / 弹挂 / 保险箱）的**内容与容量**。
 *
 * 为什么必须画出来：带什么由玩家一格一格拖进去决定，看不见网格就无从决定。
 * 保险箱那一张尤其重要 —— 阵亡时只保住箱里的东西，"箱里有什么"必须是玩家自己选的
 * （旧的自动装填 [M3-TEMP-2] 已被这条需求取代）。
 */
function carryPanel(lo, profile, cfg) {
  const plan = buildCarry(lo, cfg, { profile });
  const specs = carrySpecsFor(lo, profile, cfg);
  const carry = carryOf(lo);
  const gridOf = (name) => {
    const spec = specs[name];
    return {
      name,
      exists: !!spec,
      id: spec ? spec.id || null : null,
      label: spec ? spec.label : null,
      w: spec ? spec.w : 0,
      h: spec ? spec.h : 0,
      /** 这张网格收哪些类别（界面据此提示"这个格子不收武器"） */
      accepts: spec && spec.accepts ? spec.accepts.slice() : null,
      entries: (carry[name] || []).map((e) => carryEntryView(e, cfg)).filter(Boolean),
      used: (carry[name] || []).reduce((a, e) => {
        const def = cfg.itemDefs[e.itemId];
        if (!def) return a;
        return a + (e.rotated ? def.h : def.w) * (e.rotated ? def.w : def.h);
      }, 0),
    };
  };
  // ★ M6-4：`overflow` 现在是**进局检查查出来的违规件**，不再是投放算法的副产品。
  //   带什么由玩家一格一格拖进去决定，拖不进去的当场就被拦下 —— 于是"装不下"这个
  //   状态只可能来自**网格变小 / 旧存档**这类事后变化，而那正是进局检查在查的东西。
  //   （buildCarry 的 overflow 恒为空：留着它等于留一个永远为真的假信号。）
  return {
    plan,
    backpack: gridOf('backpack'),
    rig: gridOf('rig'),
    safe: gridOf('safe'),
    kitSlots: plan.kitSlots,
    freeSlots: plan.freeSlots,
    totalSlots: plan.totalSlots,
    // ★ 违规件的唯一真值是 buildCarry 里的那一次 carryAudit（简报读的就是同一份），
    //   这里**不**再算一遍 —— 两处各判一次迟早分叉。
    audit: plan.audit,
    overflow: plan.overflow,
  };
}

/** 配装面板：槽位可选装备（只列仓库里现成的）、弹药与消耗品的携带量、负重档位。 */
function loadoutPanel(profile, cfg) {
  const lo = activeLoadout(profile);
  const ow = overweightBand(lo, cfg);
  // ★ M6：负重上限的基数必须是**所装备的背包**，否则面板上写的加成与局内实际不符
  //   （换一只更大的背包后，面板还按参考装载 22kg 算）。
  const carry = carryPanel(lo, profile, cfg);
  const mods = skillModifiers(profile, cfg, { weightBaseKg: carry.plan.backpack.weightLimitKg });

  const slots = cfg.equipment.slots
    .filter((s) => !s.disabled)
    .map((s) => {
      const eq = lo[s.id] ? equipmentDef(lo[s.id], cfg) : null;
      // 装备的**物品形状**（拖到仓库时幽灵元素要按它画）。它来自 dropping 表的物品视图，
      // 界面不自己换算 —— 装备 id 与物品 id 不总相同（武器 dmr_sr25 ↔ rifle_sr25）。
      const itemShape = eq ? itemDef(eq.itemId, cfg) : null;
      return {
        id: s.id,
        label: s.label,
        current: lo[s.id] || null,
        // ★ M6-3：装备格上要写"格内装备名与重量"。名字与重量都在这里取好 ——
        //   界面去 itemDef/equipmentDef 里自己查，就是第二处"装备表怎么读"的实现。
        currentLabel: eq ? eq.label : null,
        currentWeightKg: eq ? eq.weightKg : 0,
        currentW: itemShape ? itemShape.w : 0,
        currentH: itemShape ? itemShape.h : 0,
        // 拖放的说明与提示要能说出"仓库里现成有哪些可选"。这**替代了旧的下拉框**：
        // 下拉框被删掉之后，玩家仍需要知道"这个东西我手上有"，否则只能盲拖。
        options: availableForSlot(profile, s.id, cfg),
        // 背包 / 弹挂这两格的容量来自**所装备的那一只**（与局内是同一条口径）
        capacity:
          s.id === 'backpack'
            ? { w: carry.backpack.w, h: carry.backpack.h, weightLimitKg: carry.plan.backpack.weightLimitKg, source: carry.plan.backpack.source }
            : s.id === 'rig' && carry.rig.exists
              ? { w: carry.rig.w, h: carry.rig.h, accepts: carry.rig.accepts.slice() }
              : null,
      };
    });

  // ★ M6-4：弹药与消耗品的携带量是**数网格**数出来的只读读数。
  //   ± 步进器已按制作人裁定取消 —— 带什么由玩家从仓库拖进网格决定。
  const ammo = cfg.ammo
    .filter((a) => cfg.equipment.ammo.carryCalibers.includes(a.id))
    .map((a) => ({
      caliber: a.id,
      label: a.label,
      itemId: a.itemId,
      current: (kitAmmo(lo, cfg)[a.id] || 0),
      stack: itemDef(a.itemId, cfg) ? itemDef(a.itemId, cfg).stack : 1,
    }));

  const consumables = cfg.consumables.map((c) => ({
    id: c.id,
    label: c.label,
    current: kitConsumables(lo, cfg)[c.id] || 0,
    stack: itemDef(c.id, cfg) ? itemDef(c.id, cfg).stack : 1,
  }));

  // ★ M6-3：负重条的刻度必须来自配置表（最后一个"有上限"的档位），
  //   且**比例只在这里算一次** —— 界面里再除一次，就是第二处负重口径。
  const bands = cfg.equipment.overweight.bands;
  const scaleMaxKg = bands.reduce((m, b) => (b.maxKg != null && b.maxKg > m ? b.maxKg : m), 0);

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
    weightBar: {
      bandIndex: ow.index,
      bandCount: bands.length,
      scaleMaxKg,
      ratio: scaleMaxKg > 0 ? Math.min(1, ow.weightKg / scaleMaxKg) : 0,
      overweight: ow.index > 0,
    },
    nextAtKg: ow.nextAtKg,
    toNextKg: ow.toNextKg,
    modifiers: mods,
    /** ★ M6-4：三张携行网格（背包 / 弹挂 / 保险箱）的内容与容量，见 carryPanel 的说明 */
    carry: {
      backpack: carry.backpack,
      rig: carry.rig,
      safe: carry.safe,
      kitSlots: carry.kitSlots,
      freeSlots: carry.freeSlots,
      totalSlots: carry.totalSlots,
      overflow: carry.overflow,
      weightLimitKg: carry.plan.backpack.weightLimitKg,
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
      // ★ 旋转 bug 的修法：`w/h` 是**已经摆好朝向**的尺寸（渲染与落点框用），
      //   而拖放要的是**未旋转的基准尺寸**加上朝向那个布尔值，自己算一次旋转。
      //   只给朝向后的 w/h，拖放层就会"再转一次"—— 表现是"旋转过的物品拖起来显示未旋转的形状"。
      //   两个都给出来，就不存在"谁该转、谁不该转"的猜法。
      baseW: def.w,
      baseH: def.h,
      // ★ M6-3：朝向是**数据的真值**，界面不该反推。用 `w !== def.w` 反推朝向等于把
      //   itemShape 又实现了一遍，而且对正方形物品（1×1 的弹药盒）根本推不出来。
      rotated: !!e.rotated,
      // 按**存储单位**估值与计重（弹药的一件是一盒 60 发）；读数取整（M6-4）
      value: valueReadout(def, e.count),
      weightKg: def.unitWeightKg * e.count,
      color: rarity ? rarity.colorHex : null,
      sellTotal: sellPriceOf(e.itemId, e.count, cfg),
      selected: selected.has(e.uid),
      /** ★ M6-4：能不能拆（数量 > 1 才能拆出一部分） */
      splittable: e.count > 1,
    };
  });
  const picked = entries.filter((e) => e.selected);
  /** 恰好选中一条堆叠时可以"拆分"（弹药因此能只带一部分）。 */
  const splitTarget =
    picked.length === 1 && picked[0].count > 1
      ? { uid: picked[0].uid, itemId: picked[0].itemId, label: picked[0].label, count: picked[0].count }
      : null;
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
    splitTarget,
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
