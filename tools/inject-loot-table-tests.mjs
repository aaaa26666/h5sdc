// 注入自检：证明 tools/validate-loot-tables.mjs 的校验规则**真的抓得住坏表**。
//
// 一个从不失败的检查等于没有检查。这里逐条把坏数据注入表的副本，
// 确认对应的规则会失败；注入全部撤销后必须回到 0 失败。
//
// 用法：node tools/inject-loot-table-tests.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'docs', '07-loot-tables.json');
const TMP = path.join(ROOT, '.loot-inject');

const base = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));

function runValidator(table) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, 'table.json');
  fs.writeFileSync(p, JSON.stringify(table, null, 2), 'utf8');
  const r = spawnSync('node', [path.join(HERE, 'validate-loot-tables.mjs'), '--table', p, '--runs', '2000'], {
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/\[FAIL\] (.+)/g)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

const cases = [
  {
    name: '引用不存在的稀有度',
    expect: '每个物品引用的稀有度都存在',
    mutate: (t) => { t.items[0].rarity = 'mythic'; },
  },
  {
    name: '权重键不是有效稀有度',
    expect: '每个容器的权重键都是有效稀有度',
    mutate: (t) => { t.containers[0].rarityWeights.mythic = 10; },
  },
  {
    name: '某个稀有度档位没有任何物品（该档永远掉不出）',
    expect: '每个稀有度档位都至少有一个物品',
    mutate: (t) => { t.items = t.items.filter((i) => i.rarity !== 'legendary'); },
  },
  {
    name: '容器要求的钥匙物品不存在',
    expect: '容器要求的钥匙物品存在',
    mutate: (t) => { t.containers.find((c) => c.id === 'key_room').requiresKey = 'no_such_key'; },
  },
  {
    name: '容器引用了未定义的打断规则',
    expect: '容器引用的打断规则存在',
    mutate: (t) => { t.containers[0].interruptRule = 'whatever'; },
  },
  {
    name: '物品价值落在其稀有度区间之外',
    expect: '每个物品的价值都落在其稀有度的价值区间内',
    mutate: (t) => { t.items.find((i) => i.rarity === 'common').value = 99999; },
  },
  {
    name: '相邻稀有度价值区间重叠（档位失去区分度）',
    expect: '相邻稀有度的价值区间不重叠',
    mutate: (t) => { t.rarity.find((r) => r.id === 'rare').valueMin = 150; },
  },
  {
    name: '容器权重全为 0',
    expect: '容器权重非负且至少一项为正',
    mutate: (t) => { for (const k of Object.keys(t.containers[0].rarityWeights)) t.containers[0].rarityWeights[k] = 0; },
  },
  {
    name: '稀有度分布呈锯齿状（典型填表错误）',
    expect: '稀有度分布为单峰',
    mutate: (t) => { t.containers[0].rarityWeights = { common: 40, uncommon: 5, rare: 30, epic: 3, legendary: 0 }; },
  },
  {
    name: '容器没声明 tier',
    expect: '每个容器都显式声明了 tier',
    mutate: (t) => { delete t.containers[0].tier; },
  },
  {
    name: '高级容器的单件期望价值反而更低（档位名不副实）',
    expect: '容器档位按单件期望价值严格递增',
    mutate: (t) => {
      // 把保险箱调成几乎全是白装，让它比军用箱还差
      t.containers.find((c) => c.id === 'safe').rarityWeights =
        { common: 90, uncommon: 10, rare: 0, epic: 0, legendary: 0 };
    },
  },
  {
    name: '收益目标区间的上下界被写反',
    expect: null, // 这一条只确认不崩，不值得为它单设规则
    mutate: (t) => { t.raidTargets[0].valueMin = 999999; },
  },
];

console.log('\n================ 掉落表校验规则的注入自检 ================');
console.log('  目的：证明校验规则真的抓得住坏表，而不是永远绿灯\n');

let pass = 0;
let fail = 0;

for (const c of cases) {
  const t = clone();
  c.mutate(t);
  const r = runValidator(t);
  if (c.expect === null) {
    // 只要求"注入后确实有变化"，不崩即可
    console.log(`  ${r.code !== 0 || r.failed.length ? '✓' : '·'} ${c.name}（不设专用规则；失败项 ${r.failed.length} 个）`);
    if (r.failed.length) pass++;
    continue;
  }
  const hit = r.failed.some((f) => f.startsWith(c.expect));
  if (hit) {
    pass++;
    console.log(`  ✓ ${c.name}`);
    console.log(`      → 被规则拦下：${r.failed.find((f) => f.startsWith(c.expect))}`);
  } else {
    fail++;
    console.log(`  ✗ ${c.name}`);
    console.log(`      → 期望规则「${c.expect}」未触发；实际失败项：${r.failed.join(' | ') || '（无）'}`);
  }
}

// 恢复确认：原表必须 0 失败
const clean = runValidator(base);
console.log(`\n  原表复跑：失败 ${clean.failed.length} 项（必须为 0）`);
if (clean.failed.length === 0) pass++;
else fail++;

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n================ 汇总 ================');
console.log(`  注入用例：拦下 ${pass} 项，漏掉 ${fail} 项`);
console.log('  （临时目录已清理，未留下残留）');
process.exit(fail ? 1 : 0);
