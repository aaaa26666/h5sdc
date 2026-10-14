// M5-1 主大厅的"战区简报"——纯函数，产出大厅要显示的全部数值。
//
// 为什么单独抽出来：
//   1. 《流程文档》10.1 要求"所有 UI 数值必须来自配置表"。把"从配置表取值"这件事
//      集中在一个**无 DOM、无 three.js** 的纯函数里，就能用单测钉住它 ——
//      界面代码里剩下的只有排版，grep 不到任何数字。
//   2. 大厅与"进入战区"之后拿到的是同一份事实。若大厅自己算一遍、
//      局内再算一遍（例如"有几个撤离点""总共几个敌人"），迟早会分叉。
//   3. M5-2/3/4/5/6 各自接入时，简报只要加一个字段，不必重排界面。
//
// 本文件**不 import 配置**（唯一的输入就是 cfg 参数），这样它在 Node 里可以直接跑，
// 也不会与 src/config/index.js 形成 core ↔ config 的循环依赖。
// 唯一允许的导入是 core 内部的纯函数 —— 规则描述只有一份，不能在这里再写一遍。
import { describeOpenRule } from './extractRules.js';
import { isLootZoneRole } from './lootTable.js';

// [M5-TEMP-1] 简报只覆盖"这一局要进的那张图"的静态事实。
//   玩家自己的养成数据（等级 / 货币 / 仓库估值）不在这里 —— 它们要等
//   M5-2（仓库）、M5-5（等级）、M5-7（存档）落地后才有数据源。
//   制作人裁定（M5-1 开工前）：**不显示占位数字**，宁可先不显示。

function weaponBrief(cfg, id) {
  const w = (cfg.weapons || []).find((x) => x.id === id);
  if (!w) return { id, label: id, caliber: null };
  return { id: w.id, label: w.label, caliber: w.ammoType };
}

function ammoLabel(cfg, id) {
  const a = (cfg.ammo || []).find((x) => x.id === id);
  return a ? a.label : id;
}

function armorBrief(cfg, id) {
  const a = (cfg.armor || []).find((x) => x.id === id);
  if (!a) return null;
  return { id: a.id, label: a.label, class: a.class, durability: a.durability };
}

/**
 * @param {object} cfg 装配后的配置（src/config/index.js 的 config，
 *        或 `configForMap(mapId).cfg` —— ★ M6-5 起后者才是"玩家选的那张图"）
 * @param {object} [kit] raidKit（core/loadout.js 的 buildRaidKit 产物）。
 *        ★ M5-3 起大厅简报显示的是**玩家当前配装**，不再固定显示起始配装 ——
 *        否则"改了配装但简报还是老样子"。缺省时退回起始配装（纯逻辑单测走这条路径）。
 * @param {object[]} [zones] 撤离点的运行时形状。缺省取 `cfg.extract.zones`。
 *        ★ M6-5：大厅要**同时**画"所有可选地图"的卡片（层数 / 容器 / 撤离点 / 敌方）
 *        与"选中那张图"的完整简报。卡片那一路是拿 `configForMap(id).cfg` 逐张调本函数的，
 *        因此 cfg 已经是对的那张图；这个参数留给"cfg 与 zones 不是一回事"的调用方
 *        （例如只想核对撤离点分级的单测），**不是**给界面绕过 cfg 用的。
 * @returns {object} 大厅展示所需的全部数值。**任何字段都不带默认值兜底** ——
 *                   配置缺失属于启动期错误，由 config 的校验拦下，不在这里静默降级。
 */
export function buildRaidBriefing(cfg, kit, zones) {
  const map = cfg.map;
  const zoneList = zones || cfg.extract.zones;
  const start = cfg.startLoadout;
  const bp = cfg.lootTable.backpack;
  /** ★ M6：携行具的规格来自 raidKit（装备的那只背包 / 弹挂 + 进局投放结果） */
  const carry = kit && kit.carry ? kit.carry : null;
  // 当前配装：有 raidKit 用它，否则用配置表的起始配装（两条路径的字段形状相同）
  const lo = kit
    ? kit.loadout
    : {
        primary: start.primary,
        secondary: start.secondary,
        ammo: start.reserveByAmmo,
        armor: start.armor,
        consumables: start.consumables,
        safeTierId: cfg.lootTable.safeContainer.tiers[0].id,
      };
  const safeTier =
    cfg.lootTable.safeContainer.tiers.find((t) => t.id === lo.safeTierId) ||
    cfg.lootTable.safeContainer.tiers[0];

  const spawns = map.aiSpawns || [];

  return {
    map: {
      id: map.id,
      label: map.label,
      floors: (map.floors || [{ id: 0 }]).length,
      // 分区只统计"资源区"，出生区/交战区的角色名不下发到界面 —— 那是关卡设计口径，
      // 摆在大厅里对玩家没有意义（玩家关心的是"这局能搜多少"）。
      //
      // ★ M6-5：判据改成 core/lootTable.js 的 isLootZoneRole ——
      //   原来只认 'loot'，而 industrial_01 用的角色名是 'resource'，于是它读成 0 个。
      //   地图不给玩家选的时候这条错误不可见（activeMap 恰好是 tv_station_01）；
      //   一旦能选工业区，简报就会写"资源分区 0 个"而那张图上明明有 5 个。
      lootZones: (map.zones || []).filter((z) => isLootZoneRole(z.role)).length,
      containers: (cfg.loot.containers || []).length,
    },
    raid: {
      timeLimitMs: cfg.raid.timeLimitMs,
      warnThresholdMs: cfg.raid.warningThresholdMs,
    },
    extracts: {
      total: zoneList.length,
      always: zoneList.filter((z) => !z.conditional).length,
      conditional: zoneList.filter((z) => z.conditional).length,
      list: zoneList.map((z) => ({
        id: z.id,
        label: z.label,
        // 层号给人看，从 1 数起（局内 HUD 的"第 N 层"同口径）
        floor: (z.floor || 0) + 1,
        conditional: !!z.conditional,
        rule: describeOpenRule(z.openRule),
      })),
    },
    enemies: {
      total: spawns.reduce((a, s) => a + s.count, 0),
      tiers: (cfg.aiTiers || []).map((t) => t.label || t.id),
    },
    // 起始装备 = 本局**带入战区的全部家当**（M3-6 死亡规则：阵亡即失去）。
    // ★ M5-3：它现在是**玩家当前预设**（含空槽 —— 新账号按制作人裁定不给长枪）。
    loadout: {
      primary: lo.primary ? weaponBrief(cfg, lo.primary) : null,
      secondary: lo.secondary ? weaponBrief(cfg, lo.secondary) : null,
      // ★ M6-4：备弹与药品是**数网格**数出来的派生量（真值在 raidKit 的携行网格里）。
      //   简报显示的就是"进局会带多少"，与网格必须一致 —— 不一致就是两套账。
      reserve: Object.entries(lo.ammo || {}).map(([id, rounds]) => ({
        id,
        label: ammoLabel(cfg, id),
        rounds,
      })),
      armor: lo.armor && lo.armor.body ? armorBrief(cfg, lo.armor.body) : null,
      consumables: (cfg.consumables || []).map((c) => ({
        id: c.id,
        label: c.label,
        count: (lo.consumables && lo.consumables[c.id]) || 0,
      })),
    },
    // 背包与安全箱：这两项是"继续贪还是马上撤"的判断依据，开局就要让玩家看见。
    // ★ M6：容量来自**所装备的**背包/弹挂，不再是掉落表里的固定 6x5。
    //   没有 raidKit 时（纯逻辑单测）退回掉落表的参考装载，与 createInventory 的兜底一致。
    pack: {
      backpack: carry
        ? {
            id: carry.backpack.id,
            label: carry.backpack.label,
            source: carry.backpack.source,
            w: carry.backpack.w,
            h: carry.backpack.h,
            slots: carry.backpack.w * carry.backpack.h,
            weightLimitKg: carry.backpack.weightLimitKg,
            /** 含技能加成的实际上限（inventory 用的就是它） */
            totalWeightLimitKg: carry.backpack.weightLimitTotalKg,
          }
        : { id: null, label: bp.referenceId, source: 'reference', w: bp.w, h: bp.h, slots: bp.w * bp.h, weightLimitKg: bp.weightLimitKg, totalWeightLimitKg: bp.weightLimitKg },
      rig: carry && carry.rig
        ? { id: carry.rig.id, label: carry.rig.label, w: carry.rig.w, h: carry.rig.h, slots: carry.rig.w * carry.rig.h, accepts: carry.rig.accepts }
        : null,
      /** 自己带的弹药/药品占掉的格数（"还能装几件战利品"要减掉它） */
      kitSlots: carry ? carry.placements.reduce((a, p) => a + p.w * p.h, 0) : 0,
      /**
       * ★ M6-4：可以装东西的格数**总数**（背包 + 弹挂）。
       *   "自带占了几格"必须有个分母才读得懂 —— 只给分子的话，
       *   玩家还得自己在脑子里把两只容器的容量加起来。
       */
      totalSlots: carry
        ? carry.totalSlots
        : bp.w * bp.h,
      /**
       * ★ 装不下而**没带进战区**的东西。它必须显示出来：
       * 静默少带的表现是"进局发现只有 60 发子弹"，而玩家会以为游戏算错了。
       */
      overflow: carry ? carry.overflow.map((o) => ({ ...o })) : [],
      safe: { id: safeTier.id, label: safeTier.label, w: safeTier.w, h: safeTier.h },
    },
  };
}
