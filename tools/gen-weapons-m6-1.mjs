// M6-1 武器扩充 · 数值生成器
//
// ★ 为什么保留它：weapons.json 里 25 把新武器的数值是**解出来的**，不是手写的。
//   若日后调整 designTargets（各类别的 TTK 带 / 爆头上限），必须用同一套反解重新生成，
//   否则数字与判据会脱节。它是一个**设计期工具**，不在验证链上（验证看 tools/ttk.mjs --gate）。
//   它不重复实现 TTK —— 直接 import core/ballistics.js，与运行时同源。
//
// 设计方法：每类 6 个**角色**，数值由角色**反解**（不是试数）：
//   · 躯干伤害 由"无甲致死发数 N"反算：  (N-1)d < 100 ≤ N·d
//   · 爆头伤害 由类别爆头发数上限反算
//   · 扩散恢复 由"本枪的恢复档次 recRank"反解速率（见下）
// 验证与 tools/ttk.mjs 同源：src/core/ballistics.js 的 computeTtk / spreadRecoverySeconds。
//
// 用法：node tools/_m6-1-gen.mjs [--emit]   （--emit 才写盘，否则只打印验证结果）

import fs from 'node:fs';
import { config, ammoById, armorById } from '../src/config/index.js';
import { computeTtk, spreadRecoverySeconds } from '../src/core/ballistics.js';

const T = config.designTargets;
const G = T._globalLimits;
const HP = config.playerVitals.maxHealth;
const vest3 = armorById('vest3');
const tmplOf = (cls) => config.weapons.find((w) => w.class === cls);

const SLOT = { pistol: 2, smg: 2, rifle: 1, shotgun: 1, dmr: 1 };
const AMMO = { pistol: '9mm', smg: '9mm', rifle: '5.56', shotgun: '12ga', dmr: '7.62' };
// 物品形状按**既有 5 把的约定**：手枪 2x2、冲锋枪 2x3、其余长枪 2x4。
// （第一版生成器按弹匣大小算 h，产出 2x3 的步枪 —— 与既有约定不符，已修正。）
const ITEM_H = { pistol: 2, smg: 3, rifle: 4, shotgun: 4, dmr: 4 };

// 价值：**按类别分档、以既有 5 把为锚**，不用公式。
// 第一版用了 `chest × iv × 0.55 + wt × 180`，产出 RSH 手枪 10582（比 SR-25 的 3200 还贵）——
// 射速间隔是"节奏"不是"价值"，拿它当价值因子必然离谱。
// 既有 5 把是手调的价梯：p9 900 / v9 1800 / m590 2000 / m4 2600 / sr25 3200，本表围绕它们铺开。
const VALUE = {
  pistol_g17: 800, pistol_vz: 1150, pistol_mk23: 1450, pistol_p12: 1650, pistol_rsh: 1950,
  smg_mac: 1500, smg_mp9: 1950, smg_bizon: 2400, smg_mp5sd: 2900, smg_ump: 3300,
  rifle_aks74u: 2300, rifle_ak762: 3100, rifle_famas: 3600, rifle_rpk: 4600, rifle_scarh: 5600,
  shotgun_db: 1250, shotgun_ksg: 2600, shotgun_spas: 3000, shotgun_saiga: 3800, shotgun_usas: 4500,
  dmr_sks: 2700, dmr_vss: 3600, dmr_mk14: 4200, dmr_m14: 5000, dmr_g28: 6200,
};
// 售价比：既有 5 把的 price/value 在 1.33~1.625 之间，新增统一取 1.45（中位）。
const PRICE_RATIO = 1.45;

// recRank：本枪在**本类别恢复速度光谱**上的位置，0 = 最快、1 = 最慢。
// 为什么需要它：若把每把都解到"刚好达标"，同类别 6 把的恢复值会完全一样 ——
// 数学达标但设计扁平（0.75kg 轻手枪与 1.35kg 战术手枪恢复速度相同，不合直觉）。
// 因此按角色的重量/定位分配档次，再反解速率去命中该档次。
const ROLES = {
  pistol: [
    { id: 'pistol_p9', label: 'P9 手枪', role: '基准·均衡', keep: true },
    { id: 'pistol_p12', label: 'P12 重手枪', role: '三枪高伤', N: 3, ttk: 0.42, ads: 180, wt: 1.2, mag: 12, recRank: 0.72 },
    { id: 'pistol_g17', label: 'G17 轻手枪', role: '五枪快射', N: 5, ttk: 0.36, ads: 135, wt: 0.75, mag: 17, recRank: 0.15 },
    { id: 'pistol_rsh', label: 'RSH 转轮手枪', role: '两枪威慑', N: 2, ttk: 0.32, ads: 200, wt: 1.1, mag: 6, recRank: 0.95 },
    { id: 'pistol_mk23', label: 'MK23 战术手枪', role: '三枪精准', N: 3, ttk: 0.33, ads: 165, wt: 1.35, mag: 12, recRank: 0.38 },
    { id: 'pistol_vz', label: 'VZ 全自动手枪', role: '五枪连发', N: 5, ttk: 0.34, ads: 190, wt: 1.05, mag: 20, recRank: 0.58 },
  ],
  smg: [
    { id: 'smg_v9', label: 'V9 冲锋枪', role: '基准·均衡', keep: true },
    { id: 'smg_mp9', label: 'MP9 冲锋枪', role: '六枪压制', N: 6, ttk: 0.31, ads: 170, wt: 2.2, mag: 40, recRank: 0.42 },
    { id: 'smg_ump', label: 'UMP 冲锋枪', role: '四枪高伤', N: 4, ttk: 0.36, ads: 200, wt: 2.9, mag: 25, recRank: 0.78 },
    { id: 'smg_mac', label: 'MAC 袖珍冲锋枪', role: '六枪极速', N: 6, ttk: 0.28, ads: 155, wt: 1.8, mag: 32, recRank: 0.12 },
    { id: 'smg_mp5sd', label: 'MP5SD 消音冲锋枪', role: '四枪稳定', N: 4, ttk: 0.34, ads: 195, wt: 3.1, mag: 30, recRank: 0.30 },
    { id: 'smg_bizon', label: 'Bizon 大弹匣', role: '五枪弹匣', N: 5, ttk: 0.34, ads: 215, wt: 3.0, mag: 64, recRank: 0.62 },
  ],
  rifle: [
    { id: 'rifle_m4', label: 'M4 突击步枪', role: '基准·均衡', keep: true },
    { id: 'rifle_ak762', label: 'AK-762 突击步枪', role: '三枪高伤', N: 3, ttk: 0.36, ads: 240, wt: 3.7, mag: 30, ammo: '7.62', recRank: 0.82 },
    { id: 'rifle_aks74u', label: 'AKS-74U 短管', role: '四枪机动', N: 4, ttk: 0.34, ads: 195, wt: 2.8, mag: 30, recRank: 0.32 },
    { id: 'rifle_scarh', label: 'SCAR-H 重枪管', role: '三枪远距', N: 3, ttk: 0.47, ads: 275, wt: 4.3, mag: 20, ammo: '7.62', recRank: 0.90 },
    { id: 'rifle_rpk', label: 'RPK 支援步枪', role: '四枪持续', N: 4, ttk: 0.43, ads: 280, wt: 5.6, mag: 60, ammo: '7.62', recRank: 0.68 },
    { id: 'rifle_famas', label: 'FAMAS 突击步枪', role: '五枪高射速', N: 5, ttk: 0.32, ads: 205, wt: 3.2, mag: 25, recRank: 0.50 },
  ],
  shotgun: [
    { id: 'shotgun_m590', label: 'M590 霰弹枪', role: '基准·泵动', keep: true },
    { id: 'shotgun_saiga', label: 'SAIGA 半自动', role: '两枪半自动', N: 2, ttk: 0.30, ads: 280, wt: 4.2, mag: 8, recRank: 0.80 },
    { id: 'shotgun_db', label: 'DB 双管霰弹枪', role: '两连爆发', N: 1, ttk: 0, ads: 200, wt: 3.0, mag: 2, iv: 240, recRank: 0.92 },
    { id: 'shotgun_spas', label: 'SPAS 战术霰弹枪', role: '快泵动', N: 1, ttk: 0, ads: 250, wt: 4.0, mag: 8, iv: 560, recRank: 0.45 },
    { id: 'shotgun_usas', label: 'USAS 重型霰弹枪', role: '两枪压制', N: 2, ttk: 0.28, ads: 300, wt: 5.2, mag: 10, recRank: 0.85 },
    { id: 'shotgun_ksg', label: 'KSG 无托霰弹枪', role: '大弹匣泵动', N: 1, ttk: 0, ads: 235, wt: 3.3, mag: 14, iv: 640, recRank: 0.25 },
  ],
  dmr: [
    { id: 'dmr_sr25', label: 'SR-25 精确射手步枪', role: '基准·均衡', keep: true },
    { id: 'dmr_m14', label: 'M14 战斗步枪', role: '两枪重击', N: 2, ttk: 0.33, ads: 320, wt: 5.0, mag: 20, recRank: 0.85 },
    { id: 'dmr_sks', label: 'SKS 半自动', role: '三枪连发', N: 3, ttk: 0.30, ads: 265, wt: 3.9, mag: 10, recRank: 0.30 },
    { id: 'dmr_g28', label: 'G28 精准步枪', role: '两枪远距', N: 2, ttk: 0.38, ads: 340, wt: 5.4, mag: 20, recRank: 0.95 },
    { id: 'dmr_vss', label: 'VSS 微声狙击', role: '两枪潜行', N: 2, ttk: 0.28, ads: 250, wt: 3.5, mag: 20, recRank: 0.20 },
    { id: 'dmr_mk14', label: 'MK14 增强步枪', role: '三枪连发', N: 3, ttk: 0.30, ads: 290, wt: 4.4, mag: 20, recRank: 0.55 },
  ],
};

function solve(cls, r) {
  const t = tmplOf(cls);
  const tc = T.byClass[cls];
  const isSg = cls === 'shotgun';
  const pellets = isSg ? 9 : 1;
  const hitRatio = pellets > 1 ? 0.7 : 1.0;
  const iv = r.iv ?? (r.N > 1 ? Math.round((r.ttk * 1000) / (r.N - 1)) : t.fireIntervalMs);

  const dLo = 100 / r.N, dHi = r.N > 1 ? 100 / (r.N - 1) : Infinity;
  const chest = Math.round(((dLo + Math.min(dHi, dLo * 1.35)) / 2) / (pellets * hitRatio));
  const headMin = Math.ceil(100 / tc.ttkHeadshotsMax / (pellets * hitRatio));
  const head = Math.max(Math.ceil(chest * (t.damage.head / t.damage.chest)), headMin + 2);
  const kick = Math.sqrt(chest / t.damage.chest);

  const entry = {
    id: r.id, label: r.label, class: cls, slot: SLOT[cls],
    ammoType: r.ammo || AMMO[cls],
    fireMode: cls === 'smg' || cls === 'rifle' ? 'auto' : 'semi',
    fireIntervalMs: iv, magazineSize: r.mag,
    reloadMs: Math.round(iv * 12 + r.mag * 45 + 600),
    reloadTacticalMs: Math.round(iv * 8 + r.mag * 32 + 400),
    adsMs: r.ads, adsFovDeg: t.adsFovDeg,
    hipSpreadDeg: t.hipSpreadDeg, adsSpreadDeg: t.adsSpreadDeg,
    spreadPerShotDeg: t.spreadPerShotDeg,
    maxSpreadDeg: t.maxSpreadDeg,
    spreadRecoveryPerSec: t.spreadRecoveryPerSec,
    moveSpreadScale: t.moveSpreadScale,
    recoil: {
      pattern: t.recoil.pattern.map(([y, p]) => [+(y * kick).toFixed(3), +(p * kick).toFixed(3)]),
      recoveryPerSec: +(t.recoil.recoveryPerSec / kick).toFixed(2),
      adsScale: t.recoil.adsScale, randomYawDeg: t.recoil.randomYawDeg,
      recoveryDelayMs: t.recoil.recoveryDelayMs,
      recoveryWhileFiringScale: t.recoil.recoveryWhileFiringScale,
    },
    damage: {
      head, chest,
      stomach: Math.round(chest * (t.damage.stomach / t.damage.chest)),
      limb: Math.round(chest * (t.damage.limb / t.damage.chest)),
    },
    falloff: { ...t.falloff }, range: t.range, pellets,
    adsMoveSpeedScale: t.adsMoveSpeedScale, weightKg: r.wt,
    value: VALUE[r.id],
    price: Math.round(VALUE[r.id] * PRICE_RATIO),
    item: { w: 2, h: ITEM_H[cls] },
    lootItemId: null,
  };

  // 扩散恢复：反解速率以命中本枪的恢复档次（cap × [0.50, 0.95]）
  const cap = tc.spreadRecoverySecMax;
  const target = cap * (0.5 + 0.45 * r.recRank);
  let rec = spreadRecoverySeconds(entry, true);
  entry.spreadRecoveryPerSec = +(entry.spreadRecoveryPerSec * (rec / target)).toFixed(2);
  rec = +spreadRecoverySeconds(entry, true).toFixed(3);

  return { entry, solved: { iv, chest, head, rec, recTarget: +target.toFixed(3) } };
}

function judge(w) {
  const tc = T.byClass[w.class];
  const R = tc.benchmarkRangeM;
  const ammo = ammoById(w.ammoType);
  const t = (zone, armorDef) => computeTtk({
    weapon: w, ammo, zone, distanceM: R,
    armorDef, armorDurability: armorDef ? armorDef.durability : 0,
    armorRules: config.armorRules, maxHealth: HP,
    pelletHitRatio: w.pellets > 1 ? 0.7 : 1.0,
  });
  const b = t('chest', null), h = t('head', null), a = t('chest', vest3);
  const ttkSec = b.ttkMs / 1000, armoredSec = a.ttkMs / 1000;
  const recSec = +spreadRecoverySeconds(w, true).toFixed(3);
  const span = tc.ttkBodySecMax - tc.ttkBodySecMin;
  const ok = {
    ttk: ttkSec >= tc.ttkBodySecMin && ttkSec <= tc.ttkBodySecMax,
    head: h.pulls <= tc.ttkHeadshotsMax,
    ads: w.adsMs <= tc.adsMsMax,
    rec: recSec <= tc.spreadRecoverySecMax,
    armored: armoredSec <= G.ttkArmoredSecMax,
  };
  const nearEdge = ok.ttk && (ttkSec - tc.ttkBodySecMin < span * G.nearEdgeRatio || tc.ttkBodySecMax - ttkSec < span * G.nearEdgeRatio);
  return { R, ttkSec, pulls: b.pulls, headPulls: h.pulls, armoredSec, armoredPulls: a.pulls, recSec, ok, nearEdge, tc };
}

const BUILT = [];
let bad = 0;
for (const [cls, list] of Object.entries(ROLES)) {
  console.log(`\n================ ${cls.toUpperCase()} ================`);
  for (const r of list) {
    let w, solved = null;
    if (r.keep) w = tmplOf(cls);
    else { const s = solve(cls, r); w = s.entry; solved = s.solved; }
    const m = judge(w);
    const pass = Object.values(m.ok).every(Boolean);
    if (!pass) bad++;
    BUILT.push({ cls, keep: !!r.keep, w, m });
    const flags = [];
    if (!m.ok.ttk) flags.push(`躯干${m.ttkSec}✘`);
    if (!m.ok.head) flags.push(`爆头${m.headPulls}发✘`);
    if (!m.ok.ads) flags.push('开镜✘');
    if (!m.ok.rec) flags.push(`恢复${m.recSec}✘`);
    if (!m.ok.armored) flags.push(`三级甲${m.armoredSec}✘`);
    console.log(
      `  ${w.label.padEnd(22)} ${String(r.role).padEnd(12)} 躯干 ${m.ttkSec.toFixed(3)}s/${String(m.pulls).padStart(2)}发 ` +
        `爆头${m.headPulls} 甲${m.armoredSec.toFixed(3)}s 开镜${String(w.adsMs).padStart(3)} 恢复${String(m.recSec).padStart(5)}` +
        `${m.nearEdge ? ' [临界]' : '      '} ${pass ? '✔' : '✘ ' + flags.join(',')}`
    );
  }
}
console.log(`\n合计 ${BUILT.length} 把，未达标 ${bad} 把。`);

// 恢复速率是否真的拉开了（不得再是同类别一致）
console.log('\n恢复速率分布（检验"扁平化"是否已消除）：');
for (const cls of Object.keys(ROLES)) {
  const vals = BUILT.filter((b) => b.cls === cls).map((b) => b.m.recSec);
  console.log(`  ${cls.padEnd(9)} ${vals.map((v) => v.toFixed(3)).join(' / ')}   极差 ${(Math.max(...vals) - Math.min(...vals)).toFixed(3)}s`);
}

if (process.argv.includes('--emit') && bad === 0) {
  const P = 'src/config/weapons.json';
  const doc = JSON.parse(fs.readFileSync(P, 'utf8'));
  const byId = new Map(BUILT.map((b) => [b.w.id, b.w]));
  const out = [];
  for (const cls of Object.keys(ROLES)) {
    for (const r of ROLES[cls]) {
      out.push(r.keep ? doc.weapons.find((x) => x.id === r.id) : byId.get(r.id));
    }
  }
  doc.weapons = out;
  doc._m6_1Note = 'M6-1：每类别扩充至 6 把（原每类 1 把）。数值由角色反解并经 tools/ttk.mjs 同源算法验证；'
    + '原有 5 把基准武器**数值一字未改**。';
  fs.writeFileSync(P, JSON.stringify(doc, null, 2), 'utf8');
  console.log(`\n已写入 ${out.length} 把到 weapons.json`);
}
