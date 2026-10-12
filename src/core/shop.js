// M5-4 商店与经济（纯函数）
//
// ★ 本文件是**价格的唯一算法**。M5 约束词明确禁止"两处各算一次价格"，
//   因此界面里不允许出现任何乘除 —— 它们只显示这里算出来的数字。
//   表里给的只有"价差比例"（buySpread / sellRatio），没有成品价格。
//
// 基价规则（见 economy.json 的 _basePriceRule）：
//   · 命中装备表（weapons.json / combat.json 的条目）→ 用它的 price（市价）
//   · 否则用物品表（loot.json）的 value（估值）
//   因此"搜索收益"（估值）与"商店价格"（市价）是两个口径，这是设计意图：
//   现实里的估价也不等于收购价。
//
// 买入与卖出都返回**新档案**（不改入参）：与 profile.js / progression.js 同一风格，
// 于是"重放一次"永远得到同一个结果，不需要额外的回滚逻辑。

import { itemDef, itemIdOfEquipment } from './items.js';
import { stashAdd, stashBulkSell } from './stash.js';
import { levelFromExp, skillModifiers } from './progression.js';

/** 物品所属类别（用于查价差表）。未知道具返回 null。 */
export function categoryOf(id, cfg) {
  const eq = cfg.equipmentDefs[id];
  if (eq) return eq.kind;
  const it = cfg.itemDefs[id];
  return it ? it.category : null;
}

/** 基价：**每件**的市价（装备用 price，其余物品用 value）。 */
export function basePriceOf(id, cfg) {
  const eq = cfg.equipmentDefs[id];
  if (eq) return eq.price;
  const it = cfg.itemDefs[id];
  if (!it) return 0;
  return it.price !== null && it.price !== undefined ? it.price : it.value;
}

/** 一件等于几个存储单位（弹药 = stack 发，其余 = 1）。 */
export function unitsPerItemOf(id, cfg) {
  const def = itemDef(id, cfg);
  return def ? def.unitsPerItem : 1;
}

/**
 * 把"存储单位数"换算成"件数"（可能是小数，例如 30 发 = 半盒）。
 * 价格一律**按件计价**再分摊 —— 否则单发价格会被 minSellPrice 的下限放大
 * （1.83 元/发 × 0.28 = 0.51 → 取整 0 → 被抬到 1，等于把卖价率从 28% 抬到 55%）。
 */
function piecesOf(id, units, cfg) {
  const per = unitsPerItemOf(id, cfg);
  return units / per;
}

/**
 * 买价（`units` 是**存储单位数**：弹药按发、其余按个）。
 * null 表示"这个类别不出售"。
 */
export function buyPriceOf(id, cfg, units) {
  const cat = categoryOf(id, cfg);
  const spread = cat ? cfg.economy.priceRules.buySpread[cat] : undefined;
  if (spread === undefined) return null;
  const n = units === undefined ? unitsPerItemOf(id, cfg) : units;
  return Math.max(1, Math.ceil(basePriceOf(id, cfg) * piecesOf(id, n, cfg) * spread));
}

/**
 * 卖价（`units` 是存储单位数）。
 * entry 里的 durability 参与计算的理由见 [M5-TEMP-10]（M5 的仓库条目不存耐久，
 * 这条分支是给 M6 的耐久持久化预留的：表与接口已就位，只差数据）。
 */
export function sellPriceOf(id, units, cfg, opts = {}) {
  const cat = categoryOf(id, cfg);
  const ratio = cat ? cfg.economy.priceRules.sellRatio[cat] : undefined;
  if (ratio === undefined || ratio === 0) return 0; // quest 类别固定 0：任务物品不可出售
  const entry = opts.entry || null;
  if (entry && entry.durability === 0) {
    return Math.floor(cfg.equipment.durabilityRules.brokenSellRatio * basePriceOf(id, cfg)) * units;
  }
  const bonus = 1 + (opts.sellBonusRatio || 0);
  const n = units === undefined ? unitsPerItemOf(id, cfg) : units;
  const gross = basePriceOf(id, cfg) * piecesOf(id, n, cfg) * ratio * bonus;
  return Math.max(cfg.economy.priceRules.minSellPrice, Math.floor(gross));
}

/**
 * 造一个"档案相关"的卖价函数（含技能加成），供 stashBulkSell 注入。
 * 之所以做成工厂：卖价里含**技能加成**，而 skillModifiers 需要档案。
 * 让 stash.js 去读档案会把它变成"有状态"的模块，也会让价格算法出现第二处。
 */
export function makeSellPricer(cfg, profile) {
  const bonus = skillModifiers(profile, cfg).sellBonusRatio;
  return (itemId, count, entry) => sellPriceOf(itemId, count, cfg, { sellBonusRatio: bonus, entry });
}

/** 商店在售清单（带算好的价格与解锁状态）——界面只显示，不计算。 */
export function stockView(profile, cfg) {
  const level = levelFromExp(profile.progression.exp, cfg).level;
  return cfg.economy.stock.items.map((row) => {
    const itemId = itemIdOfEquipment(row.ref, cfg);
    const def = itemDef(itemId, cfg);
    // 一件 = 几个存储单位：弹药是"一盒"（60 发），其余是 1 个。
    // 界面上的"买"按钮一次买一件，因此 step 就是它。
    const units = def ? def.unitsPerItem : 1;
    const unit = buyPriceOf(row.ref, cfg);
    return {
      id: row.id,
      ref: row.ref,
      itemId,
      kind: row.kind,
      label: def ? def.label : row.ref,
      category: def ? def.category : null,
      /** 买**一件**的价格（弹药 = 一盒 60 发的价） */
      unitPrice: unit,
      /** 一件 = 几个存储单位 */
      units,
      step: units,
      qty: row.qty,
      unlockLevel: row.unlockLevel,
      locked: level < row.unlockLevel,
      affordable: profile.currency >= (unit || 0),
    };
  });
}

/**
 * 买入：**扣钱与入库在同一次调用里完成**（不允许出现"扣了钱没给货"的中间态）。
 *
 * @param {number} units 买多少**存储单位**（弹药按发、其余按个）。
 *        界面一次买一件（= unitsPerItem 个存储单位）。
 * @returns {{ok:boolean, reason?:string, profile?:object, spent?:number, itemId?:string, unit?:number}}
 */
export function buy(profile, refId, units, cfg) {
  if (!Number.isInteger(units) || units <= 0) return { ok: false, reason: 'bad-count' };
  const row = cfg.economy.stock.items.find((r) => r.id === refId || r.ref === refId);
  if (!row) return { ok: false, reason: 'not-in-stock' };
  const level = levelFromExp(profile.progression.exp, cfg).level;
  if (level < row.unlockLevel) return { ok: false, reason: `need-level:${row.unlockLevel}` };
  if (row.qty !== -1 && units > row.qty) return { ok: false, reason: `max-qty:${row.qty}` };

  const total = buyPriceOf(row.ref, cfg, units);
  if (total === null) return { ok: false, reason: 'not-for-sale' };
  if (profile.currency < total) return { ok: false, reason: `need-currency:${total}` };

  const itemId = itemIdOfEquipment(row.ref, cfg);
  // 先试着放入仓库：放不下就整体拒绝（此时钱还没扣）
  const add = stashAdd(profile.stash, itemId, units, cfg);
  if (add.added < units) return { ok: false, reason: 'stash-full', added: add.added };

  return {
    ok: true,
    profile: { ...profile, currency: profile.currency - total, stash: add.stash },
    spent: total,
    unit: total,
    itemId,
    count: units,
  };
}

/**
 * 卖出（可整叠）。
 * @param {number[]} uids 仓库条目的 uid
 * @returns {{ok:boolean, reason?:string, profile?:object, gained?:number, lines?:Array}}
 */
export function sell(profile, uids, cfg) {
  const list = Array.isArray(uids) ? uids : [];
  if (list.length === 0) return { ok: false, reason: 'nothing-selected' };
  const pricer = makeSellPricer(cfg, profile);
  const r = stashBulkSell(profile.stash, list, cfg, pricer);
  if (r.lines.length === 0) return { ok: false, reason: 'nothing-to-sell' };
  return {
    ok: true,
    profile: { ...profile, currency: profile.currency + r.currency, stash: r.stash },
    gained: r.currency,
    lines: r.lines,
  };
}

/** 通胀目标区间：**从掉落表的目标收益派生**，不在经济表里再写一份。 */
export function targetBand(cfg) {
  const mins = cfg.lootTable.raidTargets.map((t) => t.valueMin);
  const maxs = cfg.lootTable.raidTargets.map((t) => t.valueMax);
  return [Math.min(...mins), Math.max(...maxs)];
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

/**
 * 通胀监控（M5 硬性要求：经济系统的买卖价差必须可配置，**且能输出通胀监控数据**）。
 *
 * 判定口径全部来自 economy.inflation：
 *   · 样本不足 windowRaids 局 → 'insufficient'（而不是硬判 —— 3 局就报通胀是误导）
 *   · 中位净收入 > 目标上限 × inflationRatio → 'inflation'
 *   · 中位净收入 < 目标下限 × deflationRatio → 'deflation'
 *
 * @returns {object} 可直接序列化进 results/economy-report.json
 */
export function inflationReport(profile, cfg) {
  const inf = cfg.economy.inflation;
  const [bandMin, bandMax] = targetBand(cfg);
  const all = profile.economy.samples || [];
  const window = all.slice(-inf.windowRaids);
  const nets = window.map((s) => s.income - s.spent).sort((a, b) => a - b);
  const income = window.reduce((a, s) => a + s.income, 0);
  const spent = window.reduce((a, s) => a + s.spent, 0);
  const netMedian = Math.round(quantile(nets, 0.5));
  const base = {
    raids: window.length,
    totalRaids: all.length,
    windowRaids: inf.windowRaids,
    netMedian,
    netP90: Math.round(quantile(nets, 0.9)),
    incomePerRaid: window.length ? Math.round(income / window.length) : 0,
    spentPerRaid: window.length ? Math.round(spent / window.length) : 0,
    currency: profile.currency,
    targetBand: [bandMin, bandMax],
  };
  if (window.length < inf.windowRaids) {
    return { ...base, verdict: 'insufficient', verdictReason: `样本 ${window.length}/${inf.windowRaids} 局` };
  }
  if (netMedian > bandMax * inf.inflationRatio) {
    return {
      ...base,
      verdict: 'inflation',
      verdictReason: `中位净收入 ${netMedian} > 上限 ${bandMax} × ${inf.inflationRatio}`,
    };
  }
  if (netMedian < bandMin * inf.deflationRatio) {
    return {
      ...base,
      verdict: 'deflation',
      verdictReason: `中位净收入 ${netMedian} < 下限 ${bandMin} × ${inf.deflationRatio}`,
    };
  }
  return { ...base, verdict: 'ok', verdictReason: `中位净收入 ${netMedian} 落在目标区间内` };
}
