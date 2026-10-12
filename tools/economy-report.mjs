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
const RAIDS = Math.max(config.economy.inflation.windowRaids, optNum('--raids', 200));
const SEED = optNum('--seed', config.level.seed);

const rnd = mulberry32(SEED);
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
// ---------------------------------------------------------------------------
const targets = config.lootTable.raidTargets;
const samples = [];
const backup = config.equipment.starterLoadout;
const unitValueOf = (itemId) => (config.itemDefs[itemId] ? config.itemDefs[itemId].unitValue : 0);
const spentExtract = 0.5 * ((backup.ammo['9mm'] || 0) * unitValueOf('pistol_mag'));
// 阵亡：整套行装（弹药 + 消耗品）都丢了
const spentDeath =
  Object.entries(backup.ammo).reduce((a, [cal, n]) => {
    const a0 = config.ammo.find((x) => x.id === cal);
    return a + (a0 ? n * unitValueOf(a0.itemId) : 0);
  }, 0) +
  Object.entries(backup.consumables).reduce((a, [id, n]) => a + n * unitValueOf(id), 0);

for (let i = 0; i < RAIDS; i++) {
  const t = targets[Math.floor(rnd() * targets.length)];
  const income = Math.round(t.valueMin + rnd() * (t.valueMax - t.valueMin));
  // 用该档的设计存活率决定这一局成功还是失败（失败局收益按 0 计，且有行装损失）
  const survived = rnd() < t.survivalRate;
  samples.push({
    raidId: `sim-${i}`,
    atMs: i,
    outcome: survived ? 'extract' : 'death',
    income: survived ? income : 0,
    spent: survived ? Math.round(spentExtract) : Math.round(spentDeath),
  });
}

const probe = { ...createNewProfile(config, 0, { profileId: 'sim' }), economy: { samples } };
const report = inflationReport(probe, config);
const [bandMin, bandMax] = targetBand(config);

// 全样本中位数（报告里额外给一份，避免"只看最近 20 局"的噪声误导）
const nets = samples.map((s) => s.income - s.spent).sort((a, b) => a - b);
const allMedian = nets.length ? nets[Math.floor((nets.length - 1) / 2)] : 0;

check(report.verdict === 'ok', `通胀判定非 ok：${report.verdict}（${report.verdictReason}）`);

const out = {
  generatedAt: new Date().toISOString(),
  seed: SEED,
  simulatedRaids: RAIDS,
  _method: '理论分布模拟（掉落表目标区间均匀抽样 + 设计存活率），不是运行时实测收益',
  targetBand: [bandMin, bandMax],
  allSampleMedian: allMedian,
  window: report,
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
