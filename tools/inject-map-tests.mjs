// 注入自检：证明 tools/render-map.mjs 的校验规则**真的抓得住坏地图**。
//
// 一个从不失败的检查等于没有检查。这里逐条把坏数据注入地图表的副本，
// 确认对应规则会失败；全部撤销后必须回到 0 失败。
//
// 用法：node tools/inject-map-tests.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'docs', '08-M3-地图表-废弃工业区.json');
const TMP = path.join(ROOT, '.map-inject');

const base = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));

function run(table) {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, 'map.json');
  fs.writeFileSync(p, JSON.stringify(table, null, 2), 'utf8');
  const r = spawnSync('node', [path.join(HERE, 'render-map.mjs'), '--table', p], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/\[FAIL\] (.+)/g)].map((m) => m[1].trim());
  return { code: r.status, failed };
}

const cases = [
  {
    name: '容器落在墙里',
    expect: '地图表无结构性错误',
    mutate: (t) => { t.containers[0].x = 5; t.containers[0].z = 5; }, // 办公楼A 内部
  },
  {
    name: '容器数量与 07 表预算不符',
    expect: '容器数量与 07 表预算完全一致',
    mutate: (t) => { t.containers.pop(); },
  },
  {
    name: '容器在分区之外（没人管的角落）',
    expect: '所有容器都落在某个分区内',
    mutate: (t) => { t.containers[0].x = 1; t.containers[0].z = 20; }, // x=1 在分区平铺之外
  },
  {
    name: '动线穿过墙体',
    expect: '动线不穿墙',
    mutate: (t) => { t.routes[0].waypoints = [[5, 5], [9, 7]]; }, // 横穿办公楼A
  },
  {
    name: '某条动线被另一条全面支配（更短更安全还搜更多）',
    expect: '没有任何动线被另一条全面支配',
    mutate: (t) => {
      // 把东线改成中线的复制品但更长 —— 于是它被中线支配
      t.routes[2].waypoints = [[13, 36], [14, 34], [16, 30], [18, 27], [19, 25], [19, 22]];
    },
  },
  {
    name: '撤离点少于 2 个（§2.4 违规）',
    expect: '撤离点数量在 2~4 个之间',
    mutate: (t) => { t.extracts = [t.extracts[0]]; },
  },
  {
    name: '没有条件撤离点（§2.4 要求分常驻与条件）',
    expect: '存在条件撤离点',
    mutate: (t) => { for (const e of t.extracts) e.conditional = false; },
  },
  {
    name: '撤离点被墙封死（从出生区不可达）',
    expect: '全部撤离点从出生区可达',
    mutate: (t) => { t.extracts[1].x = 5; t.extracts[1].z = 5; }, // 塞进办公楼A 内部
  },
  {
    name: '最近撤离点离出生区太远（「速撤」玩法不成立）',
    expect: '最近撤离点离出生区足够近',
    mutate: (t) => { t.extracts[0].x = 36; t.extracts[0].z = 3; },
  },
];

console.log('\n================ 地图校验规则的注入自检 ================');
console.log('  目的：证明校验规则真的抓得住坏地图，而不是永远绿灯\n');

let pass = 0;
let fail = 0;
for (const c of cases) {
  const t = clone();
  c.mutate(t);
  const r = run(t);
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

const clean = run(base);
console.log(`\n  原表复跑：失败 ${clean.failed.length} 项（必须为 0）`);
if (clean.failed.length === 0) pass++;
else fail++;

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n================ 汇总 ================');
console.log(`  注入用例：拦下 ${pass} 项，漏掉 ${fail} 项`);
console.log('  （临时目录已清理，未留下残留）');
process.exit(fail ? 1 : 0);
