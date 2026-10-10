// M2 TTK 报表与设计目标判定
//
// 存在原因（对应 M2 风险条目"手感主观"）：
//   "手感通过内部评审"是主观判定，无法自动化。但 TTK / 开镜时间 / 扩散恢复
//   这些是**客观可算**的。本工具把主观讨论锚定在数字上：
//   评审时看的不是"我觉得这枪太快了"，而是"这把枪胸口 TTK 0.46s，落在 0.32~0.62 目标区间内"。
//
// 硬性要求来源：M2 "每次涉及 AI 或武器的改动，必须提供 TTK 变化数据"。
//   因此本工具会输出结果 JSON，可逐次比对；并可直接作为提交说明里的数据附件。
//
// 用法：node tools/ttk.mjs [--json 输出路径]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, weaponById, ammoById, armorById } from '../src/config/index.js';
import {
  computeTtk,
  shotsToKill,
  timeToKillMs,
  spreadRecoverySeconds,
  recoilCumulative,
  baseSpread,
} from '../src/core/ballistics.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const T = config.designTargets;
const G = T._globalLimits;
const ZONES = ['head', 'chest', 'stomach', 'limb'];
// 距离采样：贴身 / 常规交火 / 中距 / 远距。
// 必须并入各类别的 benchmarkRangeM —— 否则霰弹枪的 6m、精确射手的 30m 不在采样集里，
// 判定阶段会取到 undefined 而崩溃（首版就是这样，工具自己把自己绊倒了）。
const RANGES = [
  ...new Set([5, 15, 30, 60, 100, ...Object.values(T.byClass).map((c) => c.benchmarkRangeM)]),
].sort((a, b) => a - b);
const TABLE_RANGE = 15; // 明细表只打印基准距离，避免刷屏
// 目标护甲档位：无甲 / 二级 / 三级
const TARGET_ARMORS = [
  { id: 'none', label: '无甲', body: null, head: null },
  { id: 'vest2', label: '二级甲', body: 'vest2', head: 'helmet2' },
  { id: 'vest3', label: '三级甲', body: 'vest3', head: 'helmet3' },
];

function targetFor(armorSet, zone) {
  if (zone === 'head' && armorSet.head) {
    const d = armorById(armorSet.head);
    return { def: d, dur: d.durability };
  }
  if ((zone === 'chest' || zone === 'stomach') && armorSet.body) {
    const d = armorById(armorSet.body);
    return { def: d, dur: d.durability };
  }
  return { def: null, dur: 0 };
}

const rows = [];
for (const w of config.weapons) {
  const ammo = ammoById(w.ammoType);
  for (const armorSet of TARGET_ARMORS) {
    for (const zone of ZONES) {
      for (const dist of RANGES) {
        const t = targetFor(armorSet, zone);
        const r = computeTtk({
          weapon: w,
          ammo,
          zone,
          distanceM: dist,
          armorDef: t.def,
          armorDurability: t.dur,
          armorRules: config.armorRules,
          maxHealth: config.playerVitals.maxHealth,
          pelletHitRatio: w.pellets > 1 ? 0.7 : 1.0,
        });
        rows.push({
          weapon: w.id,
          weaponLabel: w.label,
          ammo: w.ammoType,
          armor: armorSet.id,
          armorLabel: armorSet.label,
          zone,
          distanceM: dist,
          pulls: r.pulls,
          ttkMs: r.ttkMs,
          damagePerHit: r.perHit.damage,
          absorb: r.perHit.absorb,
        });
      }
    }
  }
}

const KB = (v) => (v === null || v === undefined ? '-' : String(v));

console.log('\n================ M2 TTK 报表（基础数据）================');
console.log('目标生命 = ' + config.playerVitals.maxHealth + '；TTK 判定以「无甲 15m」为基准档');
console.log('');
console.log(
  `${'武器'.padEnd(20)} ${'弹药'.padEnd(7)} ${'部位'.padEnd(7)} ${'距离'.padStart(5)} ` +
    `${'甲'.padEnd(6)} ${'弹数'.padStart(5)} ${'TTK ms'.padStart(8)} ${'单发'.padStart(7)} ${'减伤'.padStart(7)}`
);
console.log('-'.repeat(88));
for (const r of rows) {
  if (r.distanceM !== TABLE_RANGE) continue;
  console.log(
    `${r.weaponLabel.padEnd(20)} ${r.ammo.padEnd(7)} ${r.zone.padEnd(7)} ${String(r.distanceM).padStart(5)} ` +
      `${r.armorLabel.padEnd(6)} ${KB(r.pulls).padStart(5)} ${KB(r.ttkMs).padStart(8)} ` +
      `${KB(r.damagePerHit).padStart(7)} ${(r.absorb * 100).toFixed(0).padStart(6)}%`
  );
}

// ---------------- 设计目标判定（按武器类别）----------------
console.log('\n================ 设计目标判定（按武器类别，M2 手感量化）================');
console.log('说明：不同类别的 TTK 目标本来就不同，因此判定按 class 取值，而不是一个全局区间。');
console.log(`全局硬上限：三级甲 TTK ≤ ${G.ttkArmoredSecMax}s；距区间边缘 ${(G.nearEdgeRatio * 100).toFixed(0)}% 以内标为「临界」提醒评审关注。`);
console.log('');

const failures = [];
const warnings = [];
const summary = [];

for (const w of config.weapons) {
  const tc = T.byClass[w.class];
  if (!tc) {
    failures.push(`${w.label} 的类别 ${w.class} 没有对应的设计目标`);
    continue;
  }
  const R = tc.benchmarkRangeM;
  const base = rows.find((r) => r.weapon === w.id && r.armor === 'none' && r.zone === 'chest' && r.distanceM === R);
  const head = rows.find((r) => r.weapon === w.id && r.armor === 'none' && r.zone === 'head' && r.distanceM === R);
  const armored = rows.find((r) => r.weapon === w.id && r.armor === 'vest3' && r.zone === 'chest' && r.distanceM === R);
  const ttkSec = base.ttkMs / 1000;
  const armoredSec = armored.ttkMs / 1000;
  const recSec = +spreadRecoverySeconds(w, true).toFixed(3);

  const ttkOk = ttkSec >= tc.ttkBodySecMin && ttkSec <= tc.ttkBodySecMax;
  const headOk = head.pulls <= tc.ttkHeadshotsMax;
  const adsOk = w.adsMs <= tc.adsMsMax;
  const recOk = recSec <= tc.spreadRecoverySecMax;
  const armoredOk = armoredSec <= G.ttkArmoredSecMax;

  // 临界检测：落在区间边缘 10% 以内时提醒 —— 这类值最容易在后续调参中越界
  const span = tc.ttkBodySecMax - tc.ttkBodySecMin;
  const nearEdge =
    ttkOk &&
    (ttkSec - tc.ttkBodySecMin < span * G.nearEdgeRatio ||
      tc.ttkBodySecMax - ttkSec < span * G.nearEdgeRatio);

  summary.push({
    id: w.id,
    label: w.label,
    class: w.class,
    benchmarkRangeM: R,
    bodyTtkSec: +ttkSec.toFixed(3),
    bodyPulls: base.pulls,
    armoredTtkSec: +armoredSec.toFixed(3),
    armoredPulls: armored.pulls,
    headPulls: head.pulls,
    adsMs: w.adsMs,
    hipSpreadDeg: baseSpread(w, false),
    adsSpreadDeg: baseSpread(w, true),
    spreadRecoverySec: recSec,
    recoilAfter5: recoilCumulative(w, 5, false),
    recoilAfter10: recoilCumulative(w, 10, false),
    targets: tc,
    verdict: { ttkOk, headOk, adsOk, recOk, armoredOk, nearEdge },
  });

  if (!ttkOk) failures.push(`${w.label}[${w.class}] 躯干 TTK ${ttkSec.toFixed(3)}s 超出 ${tc.ttkBodySecMin}~${tc.ttkBodySecMax}s`);
  if (!headOk) failures.push(`${w.label}[${w.class}] 爆头击杀需 ${head.pulls} 发，超过 ${tc.ttkHeadshotsMax} 发`);
  if (!adsOk) failures.push(`${w.label}[${w.class}] 开镜 ${w.adsMs}ms 超过 ${tc.adsMsMax}ms`);
  if (!recOk) failures.push(`${w.label}[${w.class}] 扩散恢复 ${recSec}s 超过 ${tc.spreadRecoverySecMax}s`);
  if (!armoredOk) failures.push(`${w.label}[${w.class}] 三级甲 TTK ${armoredSec.toFixed(3)}s 超过全局上限 ${G.ttkArmoredSecMax}s`);
  if (nearEdge) warnings.push(`${w.label}[${w.class}] 躯干 TTK ${ttkSec.toFixed(3)}s 贴近目标区间边缘，调参时须复查`);

  const marks = [
    ttkOk ? (nearEdge ? '临界' : 'OK') : `OUT(${ttkSec.toFixed(2)}s)`,
    headOk ? 'OK' : `OUT(${head.pulls}发)`,
    adsOk ? 'OK' : `OUT(${w.adsMs}ms)`,
    recOk ? 'OK' : `OUT(${recSec}s)`,
  ];
  console.log(
    `${w.label.padEnd(20)} [${w.class.padEnd(7)} @${String(R).padStart(3)}m] ` +
      `躯干 ${ttkSec.toFixed(3)}s/${base.pulls}发 ${marks[0].padEnd(10)} ` +
      `三级甲 ${armoredSec.toFixed(3)}s/${armored.pulls}发${armoredOk ? '' : ' OUT'}  ` +
      `爆头 ${head.pulls}发 ${marks[1].padEnd(8)} 开镜 ${String(w.adsMs).padStart(3)}ms ${marks[2].padEnd(8)} ` +
      `扩散恢复 ${recSec}s ${marks[3]}`
  );
}

console.log('\n后坐力累计（腰射，供压枪难度评审）：');
for (const s of summary) {
  console.log(
    `  ${s.label.padEnd(20)} 5发 偏航${String(s.recoilAfter5.yawDeg).padStart(7)}° 抬升${String(s.recoilAfter5.pitchDeg).padStart(7)}°   ` +
      `10发 偏航${String(s.recoilAfter10.yawDeg).padStart(7)}° 抬升${String(s.recoilAfter10.pitchDeg).padStart(7)}°`
  );
}

const outPath = process.argv.includes('--json')
  ? process.argv[process.argv.indexOf('--json') + 1]
  : path.join(ROOT, 'results', 'ttk-report.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), designTargets: T, summary, rows, failures },
    null,
    2
  ),
  'utf8'
);

console.log('');
if (failures.length) {
  console.log(`设计目标未满足（${failures.length} 项）：`);
  for (const f of failures) console.log('  [OUT] ' + f);
}
if (warnings.length) {
  console.log(`\n临界提醒（${warnings.length} 项，尚未越界但已贴近边界）：`);
  for (const w of warnings) console.log('  [临界] ' + w);
}
if (!failures.length && !warnings.length) {
  console.log('全部武器满足其类别的设计目标，且无临界项。');
}
console.log('\n注：未达标不等于错误，而是需要在手感评审会上拍板的偏差。');
console.log('    本工具的作用是把"感觉不对"变成"哪一项偏了多少"。');
console.log(`\n明细已写入 ${outPath}`);
