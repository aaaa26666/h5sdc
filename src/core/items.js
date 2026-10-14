// M5-3 物品与装备的统一查询（纯函数）
//
// 存在原因：M5 起"物品"有两个来源 —— 掉落表的战利品池，以及装备（武器/护甲）的
// 物品形态。仓库、商店、配装、结算都要按 id 查它的重量/估值/形状/堆叠上限，
// 若每处各写一段 `lootTable.items.find(...) || weapons.find(...)`，
// 迟早会出现"某个入口查不到某类东西"。因此查询只在这里，参数是 config 的派生视图
// （config.itemDefs / config.equipmentDefs，由 src/config/index.js 在启动期交叉校验）。
//
// 本文件不 import 任何配置：调用方把 cfg 传进来，因此它能在 Node 单测里独立使用。

/** 物品定义（战利品 ∪ 装备的物品形态）。未知名返回 null —— 调用方决定是丢弃还是报错。 */
export function itemDef(id, cfg) {
  return cfg.itemDefs[id] || null;
}

/** 取物品定义，缺失即抛错。用于"这里必须有"的场景（启动期已保证的表内引用）。 */
export function requireItem(id, cfg) {
  const d = cfg.itemDefs[id];
  if (!d) throw new Error(`[items] 未知物品 ${id}`);
  return d;
}

/** 装备定义（武器 / 护甲）。未知名返回 null。 */
export function equipmentDef(id, cfg) {
  return cfg.equipmentDefs[id] || null;
}

/**
 * 装备 id → 它在仓库里的物品 id。
 * 两者不总相同（武器 dmr_sr25 的战利品条目叫 rifle_sr25），映射由装备表的
 * lootItemId 显式声明。未知装备返回原 id（它可能是纯物品）。
 */
export function itemIdOfEquipment(equipmentId, cfg) {
  const eq = cfg.equipmentDefs[equipmentId];
  return eq ? eq.itemId : equipmentId;
}

/**
 * 物品 id → 它对应的装备 id（若这件物品可以装备）。
 * 返回 null 表示"它只是件物资"（弹药、贵重品……）。
 */
export function equipmentIdOfItem(itemId, cfg) {
  const it = cfg.itemDefs[itemId];
  return it ? it.equipmentId : null;
}

/** 该 id 是否是一件装备（而不是纯物资）。 */
export function isEquipment(id, cfg) {
  return !!cfg.equipmentDefs[id];
}

/** 物品的形状（考虑旋转）。仓库与背包的占用计算都走它，避免两处各算一次。 */
export function itemShape(item, rotated) {
  return rotated ? { w: item.h, h: item.w } : { w: item.w, h: item.h };
}

/** 单件重量；count 省略时按 1 件算。 */
export function itemWeight(item, count = 1) {
  return item.weightKg * count;
}

/**
 * ★ M6-4（制作人裁定）：玩家看得见的**估值读数一律取整**。
 *
 * 为什么取整必须发生在 core：弹药的单价是"一盒的价值 ÷ 每盒发数"，
 *   除不尽（1100 ÷ 60 = 18.33…），于是界面上会出现
 *   "估值 18.333333333333332"这种读数。而"界面不做计算"是本项目的硬纪律 ——
 *   界面只拿到单价与数量，让它自己 round 就等于第二处口径（且迟早漏掉某个页面）。
 * 为什么向上取整用 Math.round 而不是 floor：估值是"这堆东西大概值多少"，
 *   四舍五入比一律抹零更贴近字面意思（卖价另有一条 Math.floor 的口径，两者不共用）。
 *
 * @param {object} def 物品视图（含 unitValue / value）
 * @param {number} units 存储单位数（发 / 个）
 */
export function valueReadout(def, units = 1) {
  if (!def) return 0;
  const per = def.unitValue !== undefined ? def.unitValue : def.value;
  const n = Number.isFinite(units) ? units : 1;
  return Math.round((Number.isFinite(per) ? per : 0) * n);
}

/** 一批物品的总估值（逐项取整后求和 —— 与"逐项显示的数字相加"必须一致）。 */
export function valueReadoutOf(list, defOf) {
  let sum = 0;
  for (const e of list || []) {
    const def = defOf ? defOf(e) : e && e.item;
    sum += valueReadout(def, e && e.count !== undefined ? e.count : 1);
  }
  return sum;
}

/**
 * 覆盖某物品的完整定义（含 kind）。
 * kind: 'weapon' | 'armor' | 'item'（后者再细分 category：ammo / medical / valuable / quest ...）
 */
export function itemKind(id, cfg) {
  const eq = cfg.equipmentDefs[id];
  if (eq) return eq.kind;
  const it = cfg.itemDefs[id];
  if (!it) return null;
  return 'item';
}

/**
 * 同一件东西的"等价 id 集合"。
 *
 * 为什么需要：仓库里存的是物品 id（rifle_sr25），而配装槽里存的是装备 id（dmr_sr25）。
 * "从仓库里取出一把 SR-25 装到主武器槽"这一步要能同时匹配两者 ——
 * 否则玩家会看到"仓库里明明有这把枪，却装备不上"。
 */
export function equivalentIds(id, cfg) {
  const out = new Set([id]);
  const eq = cfg.equipmentDefs[id];
  if (eq) out.add(eq.itemId);
  const it = cfg.itemDefs[id];
  if (it && it.equipmentId) out.add(it.equipmentId);
  return out;
}

/**
 * 安全箱档位在规格表里的序号（未知档位返回 -1）。
 *
 * 为什么用"序号"比较而不是"档位 id"：档位是**有序**的（1×2 → 2×2 → … → 3×4），
 * 任务奖励只会往上解锁。放一个集合会允许"跳过中间档"这种自相矛盾的状态。
 */
export function safeTierIndex(tierId, cfg) {
  return cfg.lootTable.safeContainer.tiers.findIndex((t) => t.id === tierId);
}

/** 安全箱档位的定义（尺寸 / 名称）。 */
export function safeTierDef(tierId, cfg) {
  return cfg.lootTable.safeContainer.tiers.find((t) => t.id === tierId) || null;
}
