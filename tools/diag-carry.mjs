// M6 携行具投放的诊断打印（设计期工具，只读不写盘）
//
// 为什么需要它：容量由装备决定之后，"这套配装到底带进去什么、占几格、装不下什么"
// 是一个**跨四张表**的结果（carry / loot / equipment / progression）。
// 靠读代码回答这个问题既慢又容易看错，因此给一个能直接打印的入口。
//
// 用法：node tools/diag-carry.mjs [预设名]
import { config } from '../src/config/index.js';
import { buildCarry, loadoutWeight, overweightBand } from '../src/core/loadout.js';
import { planCarry, resolveCarrySpecs } from '../src/core/carry.js';

/** 预设：默认取起始配装，再给两个"买了包"的对照 */
const PRESETS = {
  起始: { ...config.equipment.starterLoadout },
  小背包: { ...config.equipment.starterLoadout, backpack: 'bp_small' },
  中背包: { ...config.equipment.starterLoadout, backpack: 'bp_medium' },
  中背包加弹挂: { ...config.equipment.starterLoadout, backpack: 'bp_medium', rig: 'rig_heavy' },
  满配: {
    ...config.equipment.starterLoadout,
    primary: 'rifle_m4',
    secondary: 'dmr_sr25',
    backpack: 'bp_large',
    rig: 'rig_heavy',
    ammo: { '5.56': 300, '7.62': 120, '9mm': 60, '12ga': 80 },
    consumables: { bandage: 12, medkit: 6 },
  },
};

const only = process.argv[2];
for (const [name, lo] of Object.entries(PRESETS)) {
  if (only && !name.includes(only)) continue;
  const carry = buildCarry(lo, config);
  const ow = overweightBand(lo, config);
  const total = carry.backpack.w * carry.backpack.h + (carry.rig ? carry.rig.w * carry.rig.h : 0);
  const used = carry.placements.reduce((a, p) => a + p.w * p.h, 0);
  console.log(`\n=== ${name} ===`);
  console.log(`  背包 ${carry.backpack.label} ${carry.backpack.w}×${carry.backpack.h}（${carry.backpack.source}）`
    + ` 负重上限 ${carry.backpack.weightLimitKg}kg`);
  console.log(`  弹挂 ${carry.rig ? `${carry.rig.label} ${carry.rig.w}×${carry.rig.h}` : '无'}`);
  console.log(`  携行件占 ${used} / 总 ${total} 格（剩 ${total - used} 格给战利品）`);
  console.log(`  出发行头重量 ${ow.weightKg.toFixed(2)}kg → 档位 ${ow.band.label}`);
  const byGrid = { rig: [], backpack: [] };
  for (const p of carry.placements) byGrid[p.grid].push(`${p.itemId}×${p.count}@${p.x},${p.y}${p.rotated ? 'R' : ''}`);
  console.log(`  弹挂内容：${byGrid.rig.join(' ') || '（无）'}`);
  console.log(`  背包内容：${byGrid.backpack.join(' ') || '（无）'}`);
  console.log(`  装不下：${carry.overflow.map((o) => `${o.itemId}×${o.count}`).join(' ') || '（无）'}`);
}

// 合成反例：故意给一只装不下的小包，验证 overflow 真的会被报出来（不是永远为空）
const tiny = {
  backpacks: [{ id: 'bp_tiny', capacityW: 1, capacityH: 1, weightLimitKg: 1, slots: 1 }],
  rigs: [],
  defaults: { backpack: { w: 1, h: 1, weightLimitKg: 1 } },
};
const tinyPlan = planCarry({
  loadout: { ammo: { '9mm': 60 }, consumables: { bandage: 3, medkit: 2 } },
  carry: tiny,
  ammo: config.ammo,
  consumables: config.consumables,
  itemDefs: config.itemDefs,
});
console.log('\n=== 注入自检：1×1 的包塞 9mm 60 + 绷带 3 + 急救包 2 ===');
console.log(`  摆进去 ${tinyPlan.placements.length} 件，装不下 ${tinyPlan.overflow.length} 件`
  + `（${tinyPlan.overflow.map((o) => `${o.itemId}×${o.count}`).join(' ')}）`);
if (tinyPlan.overflow.length === 0) {
  console.error('  ✗ 自检失败：这么小的包不可能装得下，overflow 却是空的 —— 检查等于没检查');
  process.exitCode = 1;
} else {
  console.log('  ✓ 溢出被报出来了（不是静默丢弃）');
}

// 规格解析的边界：没有 defaults 时必须给可读的错，而不是 undefined 崩在后面
try {
  resolveCarrySpecs({}, { backpacks: [], rigs: [] });
  console.log('\n  · 缺 defaults 时未被拦下（会在别处崩）');
} catch (e) {
  console.log(`\n  · 缺 defaults 时报错：${e.message}`);
}
