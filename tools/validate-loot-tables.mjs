// M3 前置：掉落权重表校验与统计报告
//
// 硬性要求：「掉落分布必须能被脚本统计并输出概率报告，用于验证是否符合策划权重表。」
// 本脚本是这条要求的落地：它读 docs/07-loot-tables.json，做两件事 ——
//   ① **校验**：结构、引用完整性、权重归一化、稀有度价值区间的一致性
//   ② **统计**：输出每个容器的稀有度概率、单件期望价值、单容器期望价值，
//      并用种子固定的蒙特卡洛跑出各档玩法的单局收益区间，与设计目标比对
//
// 重要区分（铁律 13）：
//   本脚本统计的是**表格的理论分布**，不是运行时实际掉落。
//   运行时掉落统计要等 M3-4 接入后再补，两者必须能对上，对不上就是实现有 bug。
//
// 用法：node tools/validate-loot-tables.mjs [--runs 20000] [--json <输出路径>] [--table <表路径>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const RUNS = Number((argv.includes('--runs') ? argv[argv.indexOf('--runs') + 1] : 0) || 20000);
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
// 允许指定表路径：这样可以用"故意做坏的表"验证校验规则本身是否有效
// （一个从不失败的检查等于没有检查 —— 与 tools/audit-keybindings.mjs 的注入自检同一思路）
const TABLE = argv.includes('--table')
  ? path.resolve(argv[argv.indexOf('--table') + 1])
  : path.join(ROOT, 'docs', '07-loot-tables.json');

const failures = [];
const warnings = [];
let checks = 0;

function check(name, pass, detail) {
  checks++;
  if (!pass) failures.push(`${name}${detail ? ' —— ' + detail : ''}`);
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? '  —— ' + detail : ''}`);
}
function warn(msg) {
  warnings.push(msg);
  console.log(`  [警告] ${msg}`);
}

/** 以 _ 开头的键是注释而非数据（沿用项目既有约定） */
const dataKeys = (o) => Object.keys(o).filter((k) => !k.startsWith('_'));

if (!fs.existsSync(TABLE)) {
  console.error('找不到 ' + TABLE);
  process.exit(2);
}
const T = JSON.parse(fs.readFileSync(TABLE, 'utf8'));

console.log('\n================ M3 掉落权重表校验与统计 ================');
console.log('  数据源: docs/07-loot-tables.json');
console.log('  状态  : 待审核裁定（本报告用于评审，不代表已批准）\n');

// ============================================================
// ① 结构校验
// ============================================================
console.log('—— ① 结构校验 ——');
check('稀有度恰好五档（§2.2 白/绿/蓝/紫/金）', T.rarity.length === 5, `${T.rarity.length} 档`);
check('稀有度 id 唯一', new Set(T.rarity.map((r) => r.id)).size === T.rarity.length);
check('物品 id 唯一', new Set(T.items.map((i) => i.id)).size === T.items.length);
check('容器 id 唯一', new Set(T.containers.map((c) => c.id)).size === T.containers.length);

// ============================================================
// ② 引用完整性（§8.3：表结构校验需含引用完整性）
// ============================================================
console.log('\n—— ② 引用完整性 ——');
{
  const rarities = new Set(T.rarity.map((r) => r.id));
  const itemIds = new Set(T.items.map((i) => i.id));

  const badRarity = T.items.filter((i) => !rarities.has(i.rarity));
  check('每个物品引用的稀有度都存在', badRarity.length === 0,
    badRarity.map((i) => `${i.label}->${i.rarity}`).join(', ') || '全部有效');

  const badWeight = T.containers.filter((c) =>
    dataKeys(c.rarityWeights).some((k) => !rarities.has(k))
  );
  check('每个容器的权重键都是有效稀有度', badWeight.length === 0,
    badWeight.map((c) => c.label).join(', ') || '全部有效');

  // 每个稀有度至少要有一个物品，否则该档永远掉不出来
  const emptyRarity = [...rarities].filter((r) => !T.items.some((i) => i.rarity === r));
  check('每个稀有度档位都至少有一个物品（否则该档永远掉不出）',
    emptyRarity.length === 0, emptyRarity.join(', ') || '全部非空');

  // 容器要求的钥匙必须是真实存在的物品
  const badKey = T.containers.filter((c) => c.requiresKey && !itemIds.has(c.requiresKey));
  check('容器要求的钥匙物品存在', badKey.length === 0,
    badKey.map((c) => `${c.label}->${c.requiresKey}`).join(', ') || '无钥匙容器或钥匙有效');

  // 设计目标引用的容器必须存在
  const badTarget = T.raidTargets.filter((t) =>
    dataKeys(t.containers).some((k) => !T.containers.some((c) => c.id === k))
  );
  check('收益目标引用的容器都存在', badTarget.length === 0,
    badTarget.map((t) => t.label).join(', ') || '全部有效');

  // 容器预算引用的容器必须存在
  const badBudget = dataKeys(T.containerBudget).filter(
    (k) => !T.containers.some((c) => c.id === k)
  );
  check('容器预算引用的容器都存在', badBudget.length === 0, badBudget.join(', ') || '全部有效');

  // 打断规则引用必须存在
  const rules = new Set(dataKeys(T.interruptRules));
  const badRule = T.containers.filter((c) => !rules.has(c.interruptRule));
  check('容器引用的打断规则存在（硬性要求：规则写在配置里）',
    badRule.length === 0, badRule.map((c) => `${c.label}->${c.interruptRule}`).join(', ') || '全部有效');
}

// ============================================================
// ③ 数值合法性
// ============================================================
console.log('\n—— ③ 数值合法性 ——');
{
  const badRange = T.rarity.filter((r) => !(r.valueMax > r.valueMin));
  check('稀有度价值区间上下界合法', badRange.length === 0, badRange.map((r) => r.label).join(', ') || '全部合法');

  // 每个物品的价值必须落在自己稀有度的区间内 —— 否则"稀有度"和"价值"是两套脱节的标准
  const outside = T.items.filter((i) => {
    const r = T.rarity.find((x) => x.id === i.rarity);
    return i.value < r.valueMin || i.value > r.valueMax;
  });
  check('每个物品的价值都落在其稀有度的价值区间内',
    outside.length === 0,
    outside.map((i) => `${i.label}(${i.value} 不在 ${T.rarity.find((r) => r.id === i.rarity).valueMin}~${T.rarity.find((r) => r.id === i.rarity).valueMax})`).join(', ') || '全部落在区间内');

  // 稀有度越高价值越高：相邻档位的区间不能重叠（否则档位没有意义）
  const sorted = [...T.rarity].sort((a, b) => a.valueMin - b.valueMin);
  let overlap = null;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].valueMin <= sorted[i - 1].valueMax) {
      overlap = `${sorted[i - 1].label}(${sorted[i - 1].valueMin}~${sorted[i - 1].valueMax}) 与 ${sorted[i].label}(${sorted[i].valueMin}~${sorted[i].valueMax})`;
    }
  }
  check('相邻稀有度的价值区间不重叠（档位有区分度）', overlap === null, overlap || '无重叠');

  const badCount = T.containers.filter((c) => !(c.itemsMax >= c.itemsMin && c.itemsMin >= 0));
  check('容器掉落件数区间合法', badCount.length === 0, badCount.map((c) => c.label).join(', ') || '全部合法');

  const badSearch = T.containers.filter((c) => !(c.searchMs >= 0));
  check('容器搜索耗时非负', badSearch.length === 0, badSearch.map((c) => c.label).join(', ') || '全部合法');

  // 权重必须非负，且每个容器至少有一个正权重
  const badWeights = T.containers.filter((c) => {
    const ks = dataKeys(c.rarityWeights);
    const vals = ks.map((k) => c.rarityWeights[k]);
    return vals.some((v) => v < 0) || vals.every((v) => v === 0);
  });
  check('容器权重非负且至少一项为正', badWeights.length === 0,
    badWeights.map((c) => c.label).join(', ') || '全部合法');
}

// ============================================================
// ④ 概率分布与期望价值
// ============================================================
console.log('\n—— ④ 各容器概率分布与期望价值 ——');

const itemsByRarity = {};
for (const r of T.rarity) itemsByRarity[r.id] = T.items.filter((i) => i.rarity === r.id);

/** 某稀有度的"平均物品价值"（该档所有物品的算术平均） */
function rarityMeanValue(rarityId) {
  const list = itemsByRarity[rarityId];
  return list.reduce((a, i) => a + i.value, 0) / list.length;
}

function normalizedWeights(c) {
  const ks = dataKeys(c.rarityWeights);
  const total = ks.reduce((a, k) => a + c.rarityWeights[k], 0);
  const out = {};
  for (const k of ks) out[k] = c.rarityWeights[k] / total;
  return out;
}

const containerStats = [];
for (const c of T.containers) {
  const p = normalizedWeights(c);
  const evPerItem = Object.entries(p).reduce((a, [r, prob]) => a + prob * rarityMeanValue(r), 0);
  const avgItems = (c.itemsMin + c.itemsMax) / 2;
  const evPerContainer = evPerItem * avgItems;
  containerStats.push({ c, p, evPerItem, avgItems, evPerContainer });

  const dist = Object.entries(p)
    .filter(([, v]) => v > 0)
    .map(([r, v]) => {
      const rl = T.rarity.find((x) => x.id === r).label;
      return `${rl} ${(v * 100).toFixed(1)}%`;
    })
    .join('  ');
  console.log(
    `  ${c.label.padEnd(8)} 搜索 ${String(c.searchMs).padStart(5)}ms  ${c.itemsMin}~${c.itemsMax} 件  ` +
      `单件期望 ${evPerItem.toFixed(0).padStart(6)}  单容器期望 ${evPerContainer.toFixed(0).padStart(6)}`
  );
  console.log(`           ${dist}`);
}

// 稀有度分布的形状检查。
//
// ★ 这里换过一次规则，理由必须写清楚，否则看起来像"为了让验证通过而放宽检查"。
//
// 初版规则是「同一容器内稀有度越高掉率越低」（严格单调递减）。
// 它被钥匙房合理地触发了：钥匙房的设计意图就是**偏向高档稀有度**（头奖型容器），
// 严格递减会逼它退化成"以白装为主"，档位就失去意义了 —— 是**规则对领域过严**，
// 不是设计错。把设计拧成能过检查的形状才是本末倒置。
//
// 换成**单峰**：分布先升后降，或单调递减。它同时接受
//   · 衰减型（民用箱 62/28/9/1/0）
//   · 头奖型（钥匙房 0/8/32/45/15）
// 并且仍然抓得住真正的填表错误 —— **锯齿状分布**（例如 40/5/30/5，多半是复制粘贴出错）。
{
  let bad = null;
  for (const { c, p } of containerStats) {
    const order = [...T.rarity].sort((a, b) => a.valueMin - b.valueMin).map((r) => r.id);
    const seq = order.map((r) => p[r] || 0);
    // 找到峰值位置；峰值之后必须单调不增
    let peak = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] > seq[peak]) peak = i;
    for (let i = peak + 1; i < seq.length; i++) {
      if (seq[i] > seq[i - 1] + 1e-9) {
        bad = `${c.label}: 峰值(${order[peak]})之后又回升 —— ` +
          seq.map((v, k) => `${T.rarity.find((x) => x.id === order[k]).label}${(v * 100).toFixed(0)}%`).join('/');
        break;
      }
    }
    if (bad) break;
  }
  check('稀有度分布为单峰（接受衰减型与头奖型，抓锯齿状填表错误）', bad === null,
    bad || containerStats.map(({ c }) => {
      const order = [...T.rarity].sort((a, b) => a.valueMin - b.valueMin).map((r) => r.id);
      return `${c.label} ${order.map((r) => ((normalizedWeights(c)[r] || 0) * 100).toFixed(0)).join('/')}`;
    }).join('  '));
}

// ★ 真正重要的那条：容器档位必须按**单件期望价值**严格递增。
// 它保证"更高级的容器确实更好"，而不是靠名字声称 —— 这才是防填表错误的关键检查。
// 档位顺序取自表中显式声明的 tier 字段，不从数组下标推断。
{
  const byTier = [...containerStats].sort((a, b) => (a.c.tier ?? 0) - (b.c.tier ?? 0));
  const missingTier = containerStats.filter((s) => !Number.isInteger(s.c.tier));
  check('每个容器都显式声明了 tier（档位顺序不能靠数组下标推断）',
    missingTier.length === 0, missingTier.map((s) => s.c.label).join(', ') || '全部已声明');

  let bad = null;
  for (let i = 1; i < byTier.length; i++) {
    if (byTier[i].evPerItem <= byTier[i - 1].evPerItem) {
      bad = `${byTier[i].c.label}(单件期望 ${byTier[i].evPerItem.toFixed(0)}) 不高于 ` +
        `${byTier[i - 1].c.label}(${byTier[i - 1].evPerItem.toFixed(0)})`;
    }
  }
  check('容器档位按单件期望价值严格递增（高级容器确实更好，不是靠名字声称）',
    bad === null,
    bad || byTier.map((s) => `${s.c.label} ${s.evPerItem.toFixed(0)}`).join(' < '));
}

// ============================================================
// ⑤ 蒙特卡洛：单局收益区间
// ============================================================
console.log('\n—— ⑤ 单局收益区间（蒙特卡洛 ' + RUNS + ' 次/档，种子固定可复现）——');

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRarity(c, rnd) {
  const p = normalizedWeights(c);
  let x = rnd();
  for (const [r, prob] of Object.entries(p)) {
    x -= prob;
    if (x <= 0) return r;
  }
  return dataKeys(c.rarityWeights)[0];
}

function simulateRaid(containerCounts, rnd) {
  // 第一步：把地上的东西全部收集起来
  const ground = [];
  for (const [cid, n] of Object.entries(containerCounts)) {
    const c = T.containers.find((x) => x.id === cid);
    for (let k = 0; k < n; k++) {
      const count = c.itemsMin + Math.floor(rnd() * (c.itemsMax - c.itemsMin + 1));
      for (let j = 0; j < count; j++) {
        const r = pickRarity(c, rnd);
        const pool = itemsByRarity[r];
        ground.push(pool[Math.floor(rnd() * pool.length)]);
      }
    }
  }
  const groundValue = ground.reduce((a, it) => a + it.value, 0);
  const groundWeight = ground.reduce((a, it) => a + it.weightKg, 0);
  const groundVol = ground.reduce((a, it) => a + it.vol, 0);

  // 第二步：按**价值密度**取舍，直到装满背包。
  //
  // ★ 这一步是收益模型的关键。容量装不下时玩家必须选择带什么 ——
  //   "搜"的核心乐趣就在这里。若按"地上全拿走"算收益，区间是假的：
  //   实测正常档地上占 28 格、贪档占 61 格，而背包只有 24 格。
  //   所以收益区间必须以**能带走的**为准。
  //
  //   用价值密度（价值/体积）贪心而不是最优背包解：玩家的实际行为就是
  //   "先捡单位体积最值钱的"，贪心更贴近真人，也不把模型做得比玩法更聪明。
  const { slots, weightLimitKg } = T.backpack;
  ground.sort((a, b) => b.value / b.vol - a.value / a.vol);

  let total = 0;
  let items = 0;
  let weightKg = 0;
  let vol = 0;
  for (const it of ground) {
    if (vol + it.vol > slots) continue; // 装不下就跳过，继续试更小的
    if (weightKg + it.weightKg > weightLimitKg) continue;
    vol += it.vol;
    weightKg += it.weightKg;
    total += it.value;
    items++;
  }
  return {
    total, items, weightKg, vol,
    groundValue, groundWeight, groundVol, groundItems: ground.length,
    leftValue: groundValue - total,
  };
}

function quantile(sorted, q) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

const simResults = [];
for (const t of T.raidTargets) {
  const rnd = mulberry32(20260301); // 固定种子：同表同结果，便于评审复算
  const totals = [];
  const weights = [];
  const vols = [];
  const groundValues = [];
  const leftValues = [];
  let itemSum = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = simulateRaid(t.containers, rnd);
    totals.push(r.total);
    weights.push(r.weightKg);
    vols.push(r.vol);
    groundValues.push(r.groundValue);
    leftValues.push(r.leftValue);
    itemSum += r.items;
  }
  totals.sort((a, b) => a - b);
  weights.sort((a, b) => a - b);
  vols.sort((a, b) => a - b);
  groundValues.sort((a, b) => a - b);
  leftValues.sort((a, b) => a - b);
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const p05 = quantile(totals, 0.05);
  const p50 = quantile(totals, 0.5);
  const p95 = quantile(totals, 0.95);
  const inBand = p50 >= t.valueMin && p50 <= t.valueMax;
  const wP50 = quantile(weights, 0.5);
  const vP50 = quantile(vols, 0.5);
  const gvP50 = quantile(groundValues, 0.5);
  const leftP50 = quantile(leftValues, 0.5);
  const leftRatio = gvP50 > 0 ? leftP50 / gvP50 : 0;
  simResults.push({ t, mean, p05, p50, p95, inBand, avgItems: itemSum / RUNS, wP50, vP50, gvP50, leftP50, leftRatio });

  console.log(
    `  ${t.label.padEnd(18)} 中位 ${String(p50).padStart(6)}  ` +
      `P5~P95 ${String(p05).padStart(6)} ~ ${String(p95).padStart(6)}  ` +
      `均值 ${mean.toFixed(0).padStart(6)}  平均 ${(itemSum / RUNS).toFixed(1)} 件  ` +
      `带走 ${wP50.toFixed(1)}kg / ${vP50} 格   地上 ${gvP50.toFixed(0)}  →  被迫留下 ${(leftRatio * 100).toFixed(0)}%`
  );
  console.log(
    `    ${' '.repeat(16)}设计目标区间 ${t.valueMin} ~ ${t.valueMax}  ` +
      `→ 中位数${inBand ? '落在区间内' : '**超出区间**'}  存活率(设计意图) ${(t.survivalRate * 100).toFixed(0)}%  ` +
      `期望收益(收益x存活) ${(mean * t.survivalRate).toFixed(0)}`
  );
  check(`${t.label} 的中位收益落在设计目标区间内`, inBand,
    `中位 ${p50} vs 目标 ${t.valueMin}~${t.valueMax}`);
}

// 风险回报单调性：越贪，期望收益(收益x存活率)应该越高，否则"贪"没有动机
{
  const evs = simResults.map((r) => r.mean * r.t.survivalRate);
  const monotone = evs.every((v, i) => i === 0 || v > evs[i - 1]);
  check('风险回报单调：越贪期望收益越高（否则"贪"没有动机）', monotone,
    evs.map((v, i) => `${simResults[i].t.label} ${v.toFixed(0)}`).join('  '));

  const ratio = evs[evs.length - 1] / evs[evs.length - 2];
  if (ratio < 1.05) {
    warn(
      `"贪"相对"正常"的期望收益只高 ${((ratio - 1) * 100).toFixed(1)}%，` +
        `但胜率低 ${(((simResults[simResults.length - 2].t.survivalRate - simResults[simResults.length - 1].t.survivalRate)) * 100).toFixed(0)} 个百分点 —— ` +
        `风险补偿可能不足，建议评审时确认`
    );
  }
}

// ============================================================
// ⑥ 容器预算与搜刮耗时预算
// ============================================================
console.log('\n—— ⑥ 容器预算与搜刮耗时 ——');
{
  const budget = dataKeys(T.containerBudget).filter((k) => k !== 'total');
  let totalCount = 0;
  let fullSearchSec = 0;
  let fullValue = 0;
  for (const cid of budget) {
    const c = T.containers.find((x) => x.id === cid);
    const n = T.containerBudget[cid];
    totalCount += n;
    fullSearchSec += (n * c.searchMs) / 1000;
    fullValue += n * containerStats.find((s) => s.c.id === cid).evPerContainer;
  }
  const declared = T.containerBudget._total;
  check('容器预算总数为各项之和', totalCount === declared, `${totalCount} vs 声明 ${declared}`);
  console.log(`  容器总数 ${totalCount} 个；全部搜完需 ${fullSearchSec.toFixed(1)}s（不含移动与战斗）`);
  console.log(`  全图理论总价值 ${fullValue.toFixed(0)}（掉率期望，非固定值）`);

  // 单局时限 240s（当前 M2 值）——若纯搜刮就吃掉大半时间，说明容器过多或时限过短
  const raidMs = 240000;
  const ratio = (fullSearchSec * 1000) / raidMs;
  check('全部容器搜完的耗时不超过单局时限的 40%（给移动与战斗留出空间）',
    ratio <= 0.4,
    `搜刮占时限 ${(ratio * 100).toFixed(1)}%（单局时限按当前 ${raidMs / 1000}s）`);
  if (ratio > 0.3) {
    warn(`搜刮已占时限 ${(ratio * 100).toFixed(1)}%，接近阈值；若 M4 调整时限需重算`);
  }
}

// ============================================================
// 汇总
// ============================================================
console.log('\n================ 汇总 ================');
console.log(`  校验项 ${checks} 项，失败 ${failures.length} 项，警告 ${warnings.length} 项`);
if (failures.length) {
  console.log('\n  失败项：');
  for (const f of failures) console.log('    [FAIL] ' + f);
}
if (warnings.length) {
  console.log('\n  警告项（不阻断，但需评审确认）：');
  for (const w of warnings) console.log('    [警告] ' + w);
}
console.log('');
console.log('  说明：本报告统计的是**表格的理论分布**，不是运行时实际掉落。');
console.log('        运行时统计需在 M3-4 接入后补齐，两者对不上即实现有 bug。');

if (JSON_OUT) {
  const out = {
    generatedAt: new Date().toISOString(),
    source: 'docs/07-loot-tables.json',
    status: 'pending-review',
    runs: RUNS,
    seed: 20260301,
    checks,
    failures,
    warnings,
    containers: containerStats.map((s) => ({
      id: s.c.id,
      label: s.c.label,
      searchMs: s.c.searchMs,
      itemsAvg: s.avgItems,
      evPerItem: +s.evPerItem.toFixed(2),
      evPerContainer: +s.evPerContainer.toFixed(2),
      rarityDistribution: s.p,
    })),
    raidTargets: simResults.map((r) => ({
      id: r.t.id,
      label: r.t.label,
      targetMin: r.t.valueMin,
      targetMax: r.t.valueMax,
      survivalRate: r.t.survivalRate,
      p05: r.p05,
      p50: r.p50,
      p95: r.p95,
      mean: +r.mean.toFixed(2),
      avgItems: +r.avgItems.toFixed(2),
      inBand: r.inBand,
      expectedValueWithSurvival: +(r.mean * r.t.survivalRate).toFixed(2),
    })),
  };
  fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
  fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n  明细已写入 ${path.relative(ROOT, path.resolve(JSON_OUT))}`);
}

process.exit(failures.length ? 1 : 0);
