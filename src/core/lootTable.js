// 掉落表访问器（纯函数，不持状态）
//
// 存在原因：掉落表既被运行时（loot.js 开箱）使用，也被工具（validate-loot-tables.mjs
// 统计理论分布）使用。抽稀有度、抽物品这两步若各写一份，
// "理论分布"与"运行时实际掉落"就会各说各话 —— 而 M3 DoD ① 要求两者必须对得上。
// 因此算法只有这一份，两边共用。
//
// 表数据的唯一真值是 src/config/loot.json（由 config/index.js 加载后传入）。

/** 以 _ 开头的键是注释而非数据（沿用项目既有约定）。 */
export const dataKeys = (o) => Object.keys(o).filter((k) => !k.startsWith('_'));

/** 权重归一化。总和为 0 时返回全 0（表结构错误由校验脚本拦下，这里不抛错）。 */
export function normalizedWeights(containerDef) {
  const keys = dataKeys(containerDef.rarityWeights);
  const total = keys.reduce((s, k) => s + (containerDef.rarityWeights[k] || 0), 0);
  if (!(total > 0)) return Object.fromEntries(keys.map((k) => [k, 0]));
  return Object.fromEntries(keys.map((k) => [k, (containerDef.rarityWeights[k] || 0) / total]));
}

export function containerById(table, id) {
  const c = table.containers.find((x) => x.id === id);
  if (!c) throw new Error(`[lootTable] 未知容器类型 ${id}`);
  return c;
}

export function rarityById(table, id) {
  const r = table.rarity.find((x) => x.id === id);
  if (!r) throw new Error(`[lootTable] 未知稀有度 ${id}`);
  return r;
}

/** 物品按稀有度分组。只收 dataKeys 意义上的物品（items 是数组，无需过滤键）。 */
export function indexByRarity(items) {
  const out = {};
  for (const it of items) (out[it.rarity] ||= []).push(it);
  return out;
}

/** 按容器的 rarityWeights 抽一个稀有度。 */
export function pickRarity(containerDef, rnd) {
  const p = normalizedWeights(containerDef);
  let x = rnd();
  for (const [r, prob] of Object.entries(p)) {
    x -= prob;
    if (x <= 0) return r;
  }
  return dataKeys(containerDef.rarityWeights)[0];
}

/**
 * 开一个容器：抽件数 → 逐件抽稀有度 → 在该稀有度的物品池里等概率取一件。
 *
 * 与 validate-loot-tables.mjs 的 simulateRaid 用的是同一段逻辑
 * （件数公式、稀有度抽取、池内等概率），因此理论分布与运行时必然同源。
 *
 * @param table 掉落表
 * @param containerId 容器类型（crate_civil / crate_military / safe / key_room）
 * @param rnd 随机源
 * @returns {Array} 掉落的物品（含 rarity / value / weightKg / w / h / vol / category）
 */
export function rollItems(table, containerId, rnd) {
  const c = containerById(table, containerId);
  const pool = indexByRarity(table.items);
  const n = c.itemsMin + Math.floor(rnd() * (c.itemsMax - c.itemsMin + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = pickRarity(c, rnd);
    const p = pool[r];
    // 该档位没有物品却给了权重是表错误 —— 校验脚本会拦下，运行时跳过而不是崩
    if (!p || p.length === 0) continue;
    out.push(p[Math.floor(rnd() * p.length)]);
  }
  return out;
}

/** 打断规则本体（规则写在表里，不写在逻辑里 —— M3-3 硬性要求）。 */
export function interruptRule(table, ruleId) {
  const r = table.interruptRules?.[ruleId];
  if (!r) throw new Error(`[lootTable] 未知打断规则 ${ruleId}`);
  return r;
}
