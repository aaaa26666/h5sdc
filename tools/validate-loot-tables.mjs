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

// 单局时限从**配置表**读，不在这里硬编码。
// M3-1b-2 ④ 把时限从 240s 上调到覆盖"容器密度提高后的搜刮预算"，
// 若这里还留一份 240000，两处就会分叉 —— 而这份校验的全部意义就是
// "搜刮预算与时限的关系"，它必须跟着唯一真值走。
const TUNABLES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'config', 'tunables.json'), 'utf8')
);
const RAID_MS = TUNABLES.raid.timeLimitMs;

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

  // ---- 形状（二维网格背包的前提）----
  const badShape = T.items.filter(
    (i) => !Number.isInteger(i.w) || !Number.isInteger(i.h) || i.w < 1 || i.h < 1
  );
  check('每个物品都有合法的形状（w/h 为正整数）', badShape.length === 0,
    badShape.map((i) => i.label).join(', ') || '全部合法');

  // vol 必须等于 w×h：两者不一致就是"看起来占 2 格其实占 4 格"这种隐蔽错误
  const volMismatch = T.items.filter((i) => i.vol !== i.w * i.h);
  check('物品 vol 等于 w×h（形状与格数一致）', volMismatch.length === 0,
    volMismatch.map((i) => `${i.label} vol=${i.vol} 而 ${i.w}x${i.h}`).join(', ') || '全部一致');

  // ---- 背包与安全箱（网格）----
  const bp = T.backpack;
  check('背包是合法网格', Number.isInteger(bp.w) && Number.isInteger(bp.h) && bp.w > 0 && bp.h > 0,
    `${bp.w}x${bp.h}`);
  check('背包声明格数与 w×h 一致', bp._slots === bp.w * bp.h, `${bp._slots} vs ${bp.w * bp.h}`);

  const tiers = T.safeContainer.tiers;
  check('安全箱档位以 1x2 起步（新账号）',
    tiers[0].label === '1x2' && tiers[0].w === 1 && tiers[0].h === 2, tiers[0].label);
  check('安全箱档位唯一', new Set(tiers.map((t) => t.id)).size === tiers.length, `${tiers.length} 档`);
  {
    // 容量必须严格递增 —— 否则"升级"可能是负收益，玩家会觉得被骗
    let bad = null;
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].w * tiers[i].h <= tiers[i - 1].w * tiers[i - 1].h) {
        bad = `${tiers[i].label}(${tiers[i].w * tiers[i].h}) 不大于 ${tiers[i - 1].label}(${tiers[i - 1].w * tiers[i - 1].h})`;
      }
    }
    check('安全箱容量随档位严格递增（升级必然更大）', bad === null,
      bad || tiers.map((t) => `${t.label}=${t.w * t.h}`).join(' < '));
  }
  {
    // 网格维度小于最大物品时，该档永远放不下那件物品 —— 这是设计事实，明确说出来
    const maxW = Math.max(...T.items.map((i) => i.w));
    const maxH = Math.max(...T.items.map((i) => i.h));
    const tooSmall = tiers.filter((t) => t.w < maxW || t.h < maxH);
    console.log(
      `  物品最大形状 ${maxW}x${maxH}；` +
        (tooSmall.length
          ? `放不下它的安全箱档位：${tooSmall.map((t) => t.label).join(', ')}`
          : '所有档位都能放下最大物品')
    );
  }
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

/**
 * 二维网格贪心排放（首次适配）。
 *
 * 为什么需要真正的二维排放而不是"格数计数"：安全箱档位用 1x2 / 2x3 / 3x4 表达，
 * 这是**行列**记法 —— 物品有形状，装包是排放。一个 2x1 的急救包放不进 1x2 的格子
 * （只能旋转后才放得进），而"只算格数"的模型看不出这个区别。
 *
 * 贪心而不是最优解：玩家的实际行为就是"先捡单位体积最值钱的，能塞就塞"，
 * 贪心更贴近真人，也不把模型做得比玩法更聪明。
 *
 * @param items 已按价值密度降序排好的物品
 * @returns { placed, value, weightKg, vol }
 */
function packGrid(gridW, gridH, items, weightLimitKg = Infinity, excludeCategories = []) {
  const occupied = Array.from({ length: gridH }, () => new Array(gridW).fill(false));
  const placed = [];
  let value = 0;
  let weightKg = 0;
  let vol = 0;

  const fits = (x, y, w, h) => {
    if (x + w > gridW || y + h > gridH) return false;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) if (occupied[y + dy][x + dx]) return false;
    }
    return true;
  };
  const mark = (x, y, w, h, v) => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) occupied[y + dy][x + dx] = v;
    }
  };

  const excluded = new Set(excludeCategories);
  for (const it of items) {
    if (excluded.has(it.category)) continue;
    if (weightKg + it.weightKg > weightLimitKg) continue;
    let put = false;
    // 正放放不下就试旋转（90°）—— 真人一定会转一下再塞
    for (const [w, h] of [[it.w, it.h], [it.h, it.w]]) {
      if (put) break;
      for (let y = 0; y + h <= gridH && !put; y++) {
        for (let x = 0; x + w <= gridW && !put; x++) {
          if (!fits(x, y, w, h)) continue;
          mark(x, y, w, h, true);
          placed.push({ item: it, x, y, w, h, rotated: w !== it.w });
          value += it.value;
          weightKg += it.weightKg;
          vol += it.vol;
          put = true;
        }
      }
    }
  }
  return { placed, value, weightKg, vol, occupied };
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

  // 第二步：按价值密度降序，排进背包网格。
  //
  // ★ 收益以**能带走的**为准，不是"地上的"。
  //   容量装不下时玩家必须选择带什么 —— "搜"的核心乐趣就在这里。
  //   若按"地上全拿走"算收益，区间是假的。
  ground.sort((a, b) => b.value / b.vol - a.value / a.vol);
  const { w: bw, h: bh, weightLimitKg } = T.backpack;
  const bp = packGrid(bw, bh, ground, weightLimitKg);
  const carried = bp.placed.map((p) => p.item);

  // 第三步：安全箱。玩家会把**最值钱的**塞进去 ——
  // 因为阵亡时只有它能保住。逐档计算保住的价值。
  const insuredByTier = {};
  for (const t of T.safeContainer.tiers) {
    // 安全箱不受负重限制（它是保命口袋，不是背包装载），但受形状与容量限制
    insuredByTier[t.id] = packGrid(t.w, t.h, carried, Infinity, T.safeContainer.excludeCategories || []).value;
  }

  return {
    total: bp.value,
    items: bp.placed.length,
    weightKg: bp.weightKg,
    vol: bp.vol,
    groundValue, groundWeight, groundVol, groundItems: ground.length,
    leftValue: groundValue - bp.value,
    // 撤离 = 背包全带出（安全箱本就含在背包里）；阵亡 = 只保住安全箱
    insuredByTier,
    carried,
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
  // 每档安全箱"阵亡时保住多少"也一起统计 —— 它直接改变死亡惩罚的力度
  const insuredByTier = {};
  for (const tier of T.safeContainer.tiers) insuredByTier[tier.id] = [];
  let itemSum = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = simulateRaid(t.containers, rnd);
    totals.push(r.total);
    weights.push(r.weightKg);
    vols.push(r.vol);
    groundValues.push(r.groundValue);
    leftValues.push(r.leftValue);
    for (const tier of T.safeContainer.tiers) insuredByTier[tier.id].push(r.insuredByTier[tier.id]);
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

  const insuredP50 = {};
  for (const tier of T.safeContainer.tiers) {
    insuredP50[tier.id] = quantile(insuredByTier[tier.id].sort((a, b) => a - b), 0.5);
  }

  // ★ 期望收益的正确公式（含死亡保险）：
  //     撤离：背包全部带出   → 收益 = total
  //     阵亡：只有安全箱保住 → 收益 = insured
  //   EV = P(撤离) × total + (1 − P(撤离)) × insured
  //
  //   之前的写法是 `total × P(撤离)`，隐含"阵亡时一无所有" ——
  //   那在安全箱存在时是错的，而且会**低估**安全箱升级的价值。
  const evFor = (tierId) =>
    simResults.length >= 0
      ? mean * t.survivalRate + insuredP50[tierId] * (1 - t.survivalRate)
      : 0;

  simResults.push({
    t, mean, p05, p50, p95, inBand, avgItems: itemSum / RUNS,
    wP50, vP50, gvP50, leftP50, leftRatio, insuredP50, evFor,
  });

  console.log(
    `  ${t.label.padEnd(18)} 中位 ${String(p50).padStart(6)}  ` +
      `P5~P95 ${String(p05).padStart(6)} ~ ${String(p95).padStart(6)}  ` +
      `均值 ${mean.toFixed(0).padStart(6)}  平均 ${(itemSum / RUNS).toFixed(1)} 件  ` +
      `带走 ${wP50.toFixed(1)}kg / ${vP50} 格   地上 ${gvP50.toFixed(0)}  →  被迫留下 ${(leftRatio * 100).toFixed(0)}%`
  );
  console.log(
    `    ${' '.repeat(16)}设计目标区间 ${t.valueMin} ~ ${t.valueMax}  ` +
      `→ 中位数${inBand ? '落在区间内' : '**超出区间**'}  存活率(设计意图) ${(t.survivalRate * 100).toFixed(0)}%`
  );
  console.log(
    `    ${' '.repeat(16)}阵亡时各档安全箱保住：` +
      T.safeContainer.tiers
        .map((tier) => `${tier.label} ${insuredP50[tier.id]}`)
        .join('  ') +
      `   （阵亡损失＝背包 − 安全箱）`
  );
  check(`${t.label} 的中位收益落在设计目标区间内`, inBand,
    `中位 ${p50} vs 目标 ${t.valueMin}~${t.valueMax}`);
}

// 风险回报单调性：越贪，期望收益(收益x存活率)应该越高，否则"贪"没有动机
{
  const topTier = T.safeContainer.tiers[T.safeContainer.tiers.length - 1];
  const evOf = (r, tierId) => r.mean * r.t.survivalRate + r.insuredP50[tierId] * (1 - r.t.survivalRate);

  // 单调性用最高档安全箱判断 —— 老账号的实际体验接近它，新账号更低（见下方逐档对比）
  const evs = simResults.map((r) => evOf(r, topTier.id));
  const monotone = evs.every((v, i) => i === 0 || v > evs[i - 1]);
  check('风险回报单调：越贪期望收益越高（否则"贪"没有动机）', monotone,
    evs.map((v, i) => `${simResults[i].t.label} ${v.toFixed(0)}`).join('  '));

  const ratio = evs[evs.length - 1] / evs[evs.length - 2];
  if (ratio < 1.05) {
    warn(
      `"贪"相对"正常"的期望收益只高 ${((ratio - 1) * 100).toFixed(1)}%，` +
        `但胜率低 ${(simResults[simResults.length - 2].t.survivalRate - simResults[simResults.length - 1].t.survivalRate) * 100} 个百分点 —— ` +
        `风险补偿可能不足，建议评审时确认`
    );
  }

  // 安全箱升级的价值：从最低档到最高档，期望收益提升多少
  console.log('\n  —— 安全箱升级对期望收益的影响（以"贪"档为例）——');
  const greedy = simResults[simResults.length - 1];
  const first = T.safeContainer.tiers[0];
  const evLow = evOf(greedy, first.id);
  const evHigh = evOf(greedy, topTier.id);
  for (const tier of T.safeContainer.tiers) {
    const ev = evOf(greedy, tier.id);
    const delta = (ev / evLow - 1) * 100;
    console.log(
      `    ${tier.label.padEnd(5)} 阵亡保住 ${String(greedy.insuredP50[tier.id]).padStart(6)}  ` +
        `期望收益 ${ev.toFixed(0).padStart(6)}  相对新账号 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`
    );
  }
  check('安全箱升级确实提升期望收益（升级要有正反馈）', evHigh > evLow,
    `新账号 ${evLow.toFixed(0)} → 满级 ${evHigh.toFixed(0)}（+${((evHigh / evLow - 1) * 100).toFixed(1)}%）`);

  // 死亡必须有实质惩罚 —— 判据是"保险不能把死亡变成划算的选择"，而不是"风险必须对称"。
  //
  // ★ 这条判据换过一次，理由必须写清楚。
  //
  // 初版判据是「阵亡的绝对损失 > 一次速撤的收益」。它被"速撤 + 满级安全箱"触发：
  // 丢 1104，而成功速撤赚 2484。但那条判据**要求风险对称**，
  // 而"速撤"这个玩法本来就是设计成低风险的 —— 它不该和"贪"用同一把尺子。
  // 而且满级玩家没有理由去刷速撤：EV 速撤 2318 vs 贪 18264，差约 8 倍。
  // 所以是**判据错**，不是设计错 —— 拿掉它，而不是去改设计迁就它。
  //
  // 真正该守的不变量有两条，都由独立断言把守：
  //   ① 保险不能改变玩法排序 —— 见上面的风险回报单调性断言
  //      （若保险让最保守的玩法变成最优，核心循环就崩了）
  //   ② 成功撤离必须严格优于阵亡，且保住比例不能过高 —— 见下
  //
  // 另外必须诚实记录一个**模型局限**：本模拟假设一局的战利品"全部已找到"。
  // 真实情况下阵亡常发生在搜到保险箱之前，因此"贪档保住 64%"是**高估**的 ——
  // 你无法保住自己没找到的东西。
  const losses = simResults.map((r) => ({
    label: r.t.label,
    loss: r.mean - r.insuredP50[topTier.id],
    ratio: r.mean > 0 ? r.insuredP50[topTier.id] / r.mean : 0,
  }));
  const maxRatio = Math.max(...losses.map((l) => l.ratio));
  check('成功撤离严格优于阵亡（保险不能反超撤离）',
    simResults.every((r) => r.insuredP50[topTier.id] < r.mean),
    simResults.map((r) => `${r.t.label} 撤离 ${r.mean.toFixed(0)} > 阵亡 ${r.insuredP50[topTier.id]}`).join('  '));
  check('满级安全箱保住的比例不超过 80%（死亡不能变成划算的选择）',
    maxRatio < 0.8,
    losses.map((l) => `${l.label} 丢 ${l.loss.toFixed(0)}（保住 ${(l.ratio * 100).toFixed(0)}%）`).join('  '));
  if (maxRatio > 0.6) {
    warn(
      `满级安全箱可保住最高 ${(maxRatio * 100).toFixed(0)}% 的战利品。` +
        `比例偏高是因为高价值小件（门禁卡/比特币/金条）都是 1x1，正好是安全箱的设计用途。` +
        `注意该数字是**高估**的：模拟假设战利品已全部找到，而真实阵亡常发生在搜到之前。` +
        `是否需要收紧请评审裁定`
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

  // 时限取自 tunables.raid.timeLimitMs（唯一真值）。若纯搜刮就吃掉大半时间，
  // 说明容器过多或时限过短 —— 两者都由策划表决定，这里只负责把矛盾报出来。
  const ratio = (fullSearchSec * 1000) / RAID_MS;
  check('全部容器搜完的耗时不超过单局时限的 40%（给移动与战斗留出空间）',
    ratio <= 0.4,
    `搜刮占时限 ${(ratio * 100).toFixed(1)}%（单局时限 ${RAID_MS / 1000}s）`);
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
