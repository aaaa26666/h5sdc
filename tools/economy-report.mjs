// M5-4 经济与通胀监控输出（可执行、带退出码）
//
// 为什么需要它：M5 阶段约束词的硬性要求是「经济系统的买卖价差必须可配置，
// **且能输出通胀监控数据**」。core/shop.js 的 inflationReport 只负责算；
// "算出来的东西要能被看到、能进版本、能当门禁"是工具的事。
//
// 它做三件事：
//   ① 打印商店全表的买价 / 卖价，并**逐条校验卖价 < 买价**（杜绝买入再卖出刷钱）
//   ② 按掉落表的目标收益区间模拟 N 局，喂给 inflationReport，输出 verdict
//   ③ 把结果写进 results/economy-report.json，verdict 非 ok 时以非零码退出
//
// 用法：node tools/economy-report.mjs [--raids 200] [--seed 20260201]
//
// 注意口径：这里模拟的是**理论分布**（区间均匀抽样），不是运行时实际收益。
// 运行时收益要靠真玩（或自动化跑局）采集 —— 两者对不上才是问题，工具会把这个
// 区别写在报告里，免得有人拿它当"实测收益"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config/index.js';
import { createNewProfile } from '../src/core/profile.js';
import { inflationReport, targetBand, buyPriceOf, sellPriceOf, unitsPerItemOf } from '../src/core/shop.js';
import { itemIdOfEquipment } from '../src/core/items.js';
import { mulberry32 } from '../src/core/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const optNum = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
};
// ★ M6-5：`--raids` 的语义是**每张地图**模拟多少局（此前是全局总数）。
//   为什么改：分组判定要求每张图各自有足够样本，而"总数 / 地图数"在加地图时会
//   悄悄把每张图的样本摊薄（3 张图时每张只剩 66 局）—— 那种失败看起来像经济问题。
const RAIDS = Math.max(config.economy.inflation.windowRaids, optNum('--raids', 200));
const SEED = optNum('--seed', config.level.seed);

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  return ok;
};

// ---------------------------------------------------------------------------
// ① 价格表与套利检查（"卖价 < 买价"必须对**每一条**成立）
// ---------------------------------------------------------------------------
const priceRows = config.economy.stock.items.map((row) => {
  const itemId = itemIdOfEquipment(row.ref, config);
  const units = unitsPerItemOf(itemId, config);
  const buy = buyPriceOf(row.ref, config); // 一件的价格
  const sell = sellPriceOf(itemId, units, config);
  check(
    buy !== null && sell < buy,
    `套利风险：${row.ref} 买 ${buy} / 卖 ${sell} —— 卖出价必须低于买入价`
  );
  return { ref: row.ref, itemId, units, unlockLevel: row.unlockLevel, buy, sell, margin: buy - sell };
});

// ---------------------------------------------------------------------------
// ② 模拟若干局，喂给通胀报告
//
// 抽样口径：三档目标（速撤 / 正常 / 贪）等概率，收益在各自的 [valueMin, valueMax]
// 区间内均匀取值。**这是理论分布**，不是实测。
// 支出口径：撤离局按"打掉约一半备弹 + 一个绷带"估算；失败局按整套行装（都丢了）估算。
//
// ★ M6-5：样本按**地图**打标签并**分组判定**。
//   两张图的收益本身不可比（industrial_01：单层 22 个容器；tv_station_01：两层 89 个），
//   混在一起算中位数会得到一个**两张图都不成立**的数字。
//
//   抽样口径：每张图各用**自己的随机流**跑完整的三档分布。
//   为什么不是"一条流轮转分配"（`i % mapIds.length`）：轮转会把两张图错开成不同的
//   相位，于是每张图看到的档位组合各不相同 —— 实测下 industrial_01 恰好总是落在
//   速撤/正常两档上、中位被压到 −1380，而 tv_station_01 落在正常/贪两档上。
//   那是**抽样假象**，不是两张图的经济差异（这两张图在模拟里用的是同一套 targetBand，
//   因为分图经济尚未按地图配置）。用独立流之后，每张图看到的都是完整分布，
//   分组判定才开始表达它该表达的东西（"这张图的收益水平落在目标区间里吗"）。
const targets = config.lootTable.raidTargets;
const mapIds = Object.keys(config.maps);
if (mapIds.length === 0) {
  console.log('  [FAIL] 没有任何已注册地图 —— 无法按图分组统计');
  process.exit(1);
}
const samples = [];
const backup = config.equipment.starterLoadout;
const unitValueOf = (itemId) => (config.itemDefs[itemId] ? config.itemDefs[itemId].unitValue : 0);
// ★ M6-4 起起始携行件写在网格里（startLoadout 的 ammo/consumables 两个数字账已删除），
//   因此这两笔"出发行头的估值"必须**数网格**，不能再读那两个已不存在的字段
//   （此前那两处读的是 undefined，算出来的支出恒为 0 —— 一条悄悄失效的估算）。
const starterKit = (() => {
  const byItem = new Map();
  for (const grid of ['backpack', 'rig']) {
    for (const e of (backup.carry && backup.carry[grid]) || []) {
      byItem.set(e.itemId, (byItem.get(e.itemId) || 0) + e.count);
    }
  }
  return byItem;
})();
const spentExtract = 0.5 * unitValueOf('pistol_mag') * (starterKit.get('pistol_mag') || 0);
// 阵亡：整套行装（弹药 + 消耗品）都丢了
const spentDeath = [...starterKit].reduce((a, [itemId, n]) => a + n * unitValueOf(itemId), 0);

let seq = 0;
for (const mapId of mapIds) {
  // 每张图一个独立的、**由种子派生**的随机流：同一个种子下结果完全可复现，
  // 但两张图之间不再有相位耦合。
  const rndMap = mulberry32(SEED + mapId.length * 7919 + seq * 104729);
  seq++;
  for (let i = 0; i < RAIDS; i++) {
    const t = targets[Math.floor(rndMap() * targets.length)];
    const income = Math.round(t.valueMin + rndMap() * (t.valueMax - t.valueMin));
    // 用该档的设计存活率决定这一局成功还是失败（失败局收益按 0 计，且有行装损失）
    const survived = rndMap() < t.survivalRate;
    samples.push({
      raidId: `sim-${mapId}-${i}`,
      atMs: samples.length,
      outcome: survived ? 'extract' : 'death',
      income: survived ? income : 0,
      spent: survived ? Math.round(spentExtract) : Math.round(spentDeath),
      mapId,
    });
  }
}

const probe = { ...createNewProfile(config, 0, { profileId: 'sim' }), economy: { samples } };
const report = inflationReport(probe, config);
const [bandMin, bandMax] = targetBand(config);

// 全样本中位数（报告里额外给一份，避免"只看最近 20 局"的噪声误导）
const nets = samples.map((s) => s.income - s.spent).sort((a, b) => a - b);
const allMedian = nets.length ? nets[Math.floor((nets.length - 1) / 2)] : 0;

check(report.verdict === 'ok', `通胀判定非 ok：${report.verdict}（${report.verdictReason}）`);
// ★ M6-5：**每张图都必须单独过**。综合判定已经要求"任何一张图异常就整体异常"，
//   但这里再逐图点一次名：综合判定的失败信息只报第一张异常图，
//   而修复时需要知道是哪几张（以及各自的数字）坏了。
for (const m of report.maps) {
  check(
    m.verdict === 'ok' || m.verdict === 'insufficient',
    `地图 ${m.mapId} 判定 ${m.verdict}：${m.verdictReason}`
  );
}
check(report.maps.length === mapIds.length,
  `按图分组数 ${report.maps.length} ≠ 已注册地图数 ${mapIds.length}（有图的样本没被分组）`);

const out = {
  generatedAt: new Date().toISOString(),
  seed: SEED,
  simulatedRaids: RAIDS,
  _method: '理论分布模拟（掉落表目标区间均匀抽样 + 设计存活率），不是运行时实测收益；★ M6-5 起按地图分组判定',
  targetBand: [bandMin, bandMax],
  allSampleMedian: allMedian,
  window: report,
  /** ★ M6-5：按地图分组的结论（每张图各自的窗口中位数与判定） */
  byMap: report.maps,
  prices: priceRows,
  verdict: report.verdict,
  failures,
};

const outPath = path.join(ROOT, 'results', 'economy-report.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

// ---------------------------------------------------------------------------
// ③ 输出
// ---------------------------------------------------------------------------
console.log('================ M5 经济与通胀监控 ================');
console.log(`  模拟局数 ${RAIDS}（种子 ${SEED}）· 目标区间 ${bandMin} ~ ${bandMax}`);
console.log(`  全样本净收入中位 ${allMedian}`);
console.log(`  最近 ${report.windowRaids} 局中位 ${report.netMedian} · P90 ${report.netP90}`);
console.log(`  每局收入 ${report.incomePerRaid} · 支出 ${report.spentPerRaid}`);
console.log(`  判定 ${report.verdict} —— ${report.verdictReason}`);
console.log('');
console.log('  —— ★ M6-5 按地图分组（两张图的收益不可比，必须分开看）——');
for (const m of report.maps) {
  console.log(
    `    ${String(m.mapId).padEnd(16)} 样本 ${String(m.totalRaids).padStart(4)} 局` +
      `   判定所需 ${String(m.windowRaids).padStart(3)} 局   中位 ${String(m.netMedian).padStart(7)}` +
      `   P90 ${String(m.netP90).padStart(7)}   ${m.verdict}`
  );
  console.log(`      ${m.verdictReason}`);
}
console.log('');
console.log('  —— 商店价格表（买价 / 卖价，均以"一件"为单位）——');
for (const r of priceRows) {
  console.log(
    `    ${r.ref.padEnd(14)} 解锁 ${String(r.unlockLevel).padStart(2)} 级   买 ${String(r.buy).padStart(6)}   卖 ${String(r.sell).padStart(6)}   价差 ${String(r.margin).padStart(6)}`
  );
}
console.log('');
console.log(`  报告已写入 ${path.relative(ROOT, outPath)}`);
if (failures.length) {
  console.log('\n  [FAIL]');
  for (const f of failures) console.log(`    · ${f}`);
  process.exit(1);
}
console.log('  [PASS] 卖价全部低于买价，且通胀判定为 ok');
