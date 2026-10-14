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
 * 一组样本的通胀读数。
 *
 * ★ M6-5：**分组统计的载体**。以前这些数字是在 inflationReport 里就地算的，
 *   而分组之后"算一组的指标"要被调用 N 次 —— 就地算就等于把同一段逻辑复制 N 份。
 *
 * @param {Array} samples 要统计的那批样本（调用方已经切好窗口）
 * @param {number} windowRaids 判定所需的最小局数
 * @param {object} inf economy.inflation
 * @param {[number,number]} band targetBand 的产物
 */
function inflationGroup(samples, windowRaids, inf, band) {
  const [bandMin, bandMax] = band;
  const nets = samples.map((s) => s.income - s.spent).sort((a, b) => a - b);
  const income = samples.reduce((a, s) => a + s.income, 0);
  const spent = samples.reduce((a, s) => a + s.spent, 0);
  const netMedian = Math.round(quantile(nets, 0.5));
  return {
    raids: samples.length,
    windowRaids,
    netMedian,
    netP90: Math.round(quantile(nets, 0.9)),
    incomePerRaid: samples.length ? Math.round(income / samples.length) : 0,
    spentPerRaid: samples.length ? Math.round(spent / samples.length) : 0,
    bandMin,
    bandMax,
    /** 判定所需的阈值（写成绝对值，让报告不必再乘一次 —— 两处各乘一次迟早分叉） */
    inflationCeil: Math.round(bandMax * inf.inflationRatio),
    deflationFloor: Math.round(bandMin * inf.deflationRatio),
  };
}

/** 一组样本的判定（口径与 M5 原实现逐条一致，只是样本范围从"全部"变成"同一张图"）。 */
function inflationVerdict(g, inf) {
  if (g.raids < g.windowRaids) {
    return { verdict: 'insufficient', verdictReason: `样本 ${g.raids}/${g.windowRaids} 局` };
  }
  if (g.netMedian > g.inflationCeil) {
    return {
      verdict: 'inflation',
      verdictReason: `中位净收入 ${g.netMedian} > 上限 ${g.bandMax} × ${inf.inflationRatio}`,
    };
  }
  if (g.netMedian < g.deflationFloor) {
    return {
      verdict: 'deflation',
      verdictReason: `中位净收入 ${g.netMedian} < 下限 ${g.bandMin} × ${inf.deflationRatio}`,
    };
  }
  return { verdict: 'ok', verdictReason: `中位净收入 ${g.netMedian} 落在目标区间内` };
}

/**
 * 通胀监控（M5 硬性要求：经济系统的买卖价差必须可配置，**且能输出通胀监控数据**）。
 *
 * ★ M6-5：**按地图分组判定**。两张图的收益本身不可比 ——
 *   `industrial_01` 有 22 个容器、单层；`tv_station_01` 有 89 个容器、两层。
 *   把两者混在一起算中位数，会得到一个**两张图都不成立**的数字：
 *   玩得多的一张图会把它自己的收益水平当成"全局水平"，另一张图的通胀/通缩被完全掩盖。
 *
 * 两个窗口各司其职（口径写在 economy.json 的 _windowNote / _windowPerMapNote）：
 *   · `windowRaids`        —— **全局**窗口：只看最近 N 局，且 N 局的样本不足就不判。
 *   · `windowRaidsPerMap`  —— **每张图**判定所需的最少局数；够这个数就用这张图的
 *     **全部留存样本**（档案上限 maxSamples）判，而不是再切一刀"最近 N 局"。
 *
 *     为什么每张图用全量而不是切窗口 —— 这是实测逼出来的：全局窗口 20 局按图切分后
 *     每张图只剩约 10~20 局，而净收入是"成功局的收益 / 失败局的负支出"的双峰混合，
 *     20 局的中位数方差极大（实测同一份模拟数据：同一张图的最近 20 局中位是 −1380，
 *     而它 100 局的中位是 +2500 —— 用前者会把随机波动判成"通缩"）。
 *     档案里每张图本来最多只留 maxSamples 局，全量就是这张图能拿到的**全部**证据。
 *
 * 兼容口径（刻意保留）：顶层字段仍是**全部样本**的聚合，因为既有工具与报告读的就是它们。
 * 新增的 `maps[]` 才是分组结论，`verdict` 则是**两者都要过**的综合判定。
 *
 * 判定口径全部来自 economy.inflation：
 *   · 样本不足该组的窗口 → 'insufficient'（而不是硬判 —— 3 局就报通胀是误导）
 *   · 中位净收入 > 目标上限 × inflationRatio → 'inflation'
 *   · 中位净收入 < 目标下限 × deflationRatio → 'deflation'
 *
 * @returns {object} 可直接序列化进 results/economy-report.json
 */
export function inflationReport(profile, cfg) {
  const inf = cfg.economy.inflation;
  const perMapWindow = inf.windowRaidsPerMap || inf.windowRaids;
  const band = targetBand(cfg);
  const [bandMin, bandMax] = band;
  const all = profile.economy.samples || [];

  const overall = inflationGroup(all.slice(-inf.windowRaids), inf.windowRaids, inf, band);
  const base = {
    raids: overall.raids,
    totalRaids: all.length,
    windowRaids: inf.windowRaids,
    windowRaidsPerMap: perMapWindow,
    netMedian: overall.netMedian,
    netP90: overall.netP90,
    incomePerRaid: overall.incomePerRaid,
    spentPerRaid: overall.spentPerRaid,
    currency: profile.currency,
    targetBand: [bandMin, bandMax],
  };

  // ---- 按地图分组 ----
  //
  // 分组顺序 = 在**全量样本**里首次出现的顺序（不按 id 排序）：
  // 报告是人读的，顺序稳定且能看出"最近在打哪张图"比字母序有用。
  //
  // 未知标签（打标之前的旧样本 / 手改档）不静默归并，而是单列成 '(unknown)'，
  // 理由是归并会把"标签坏了"这件事藏起来；而 profile.js 的收敛已经会把它们
  // 回落成默认地图，因此正常路径下这个分组不该长期存在。
  const labelOf = (s) => (s && typeof s.mapId === 'string' && s.mapId ? s.mapId : '(unknown)');
  const order = [];
  for (const s of all) {
    const id = labelOf(s);
    if (!order.includes(id)) order.push(id);
  }
  const maps = order.map((id) => {
    const rows = all.filter((s) => labelOf(s) === id);
    // 用这张图的**全部留存样本**（不切窗口）。理由见函数头：净收入是双峰混合，
    // 20 局的中位数会把随机波动判成通缩；而档案每张图最多就留 maxSamples 局，
    // 全量 = 这张图能拿到的全部证据。
    // 最后一层 slice 是防御：样本数组理论上已经被 profile.js 截到 maxSamples，
    // 但"理论上"不该是正确性依赖（工具会直接构造样本对象喂进来）。
    const g = inflationGroup(rows.slice(-(inf.maxSamples || rows.length)), perMapWindow, inf, band);
    return {
      mapId: id,
      label: (cfg.maps && cfg.maps[id] && cfg.maps[id].label) || null,
      totalRaids: rows.length,
      ...g,
      ...inflationVerdict(g, inf),
    };
  });

  // 综合判定：有任何一张**样本足够**的图不是 ok，综合就不是 ok。
  // 为什么不是"多数图 ok 就算 ok"：通胀是"钱变多"这件事，
  // 一张图在印钱就够破坏经济了，投票制会让它永远通过。
  const judged = maps.filter((m) => m.verdict !== 'insufficient');
  const bad = judged.filter((m) => m.verdict !== 'ok');
  if (bad.length) {
    return {
      ...base,
      maps,
      verdict: bad[0].verdict,
      verdictReason:
        `${bad.length}/${judged.length} 张图判定异常：` +
        bad.map((m) => `${m.mapId}=${m.verdict}（${m.verdictReason}）`).join('；'),
    };
  }
  if (!judged.length) {
    return {
      ...base,
      maps,
      verdict: 'insufficient',
      verdictReason:
        `没有任何一张图样本够 ${perMapWindow} 局（全局窗口 ${overall.raids}/${inf.windowRaids}）`,
    };
  }  return {
    ...base,
    maps,
    verdict: 'ok',
    verdictReason: `${judged.length} 张图的净收入中位数都落在目标区间内` +
      (maps.length > judged.length ? `（另有 ${maps.length - judged.length} 张图样本不足）` : ''),
  };
}
