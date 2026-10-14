// 地图视图（纯函数）—— M6-5「地图选择」批次新增。
//
// 存在原因：本批次起玩家可以在大厅**选择进哪张图**，于是"一张图有多少层 / 多少容器 /
// 几个撤离点（含条件点）/ 多少敌人"需要有一个**唯一**的算法。
//   界面（地图卡片、战区简报）要它、`__m2` 夹具要它、纯逻辑单测要它。
//   在界面里各算一遍就会出现两套口径 —— 而那正是本仓库反复踩过的坑。
//
// 本文件**不 import 配置**（唯一输入是 cfg 参数），因此：
//   · 能在 Node 里直接跑（单测不需要浏览器）；
//   · 不会与 src/config/index.js 形成 core ↔ config 的循环依赖。
// 这与 core/briefing.js 的分层口径一致。

import { isLootZoneRole } from './lootTable.js';

/** 地图 id → 地图表。非法输入一律返回空表（调用方按"未知地图"处理）。 */
export function mapTableOf(cfg, mapId) {
  const maps = (cfg && cfg.maps) || {};
  return Object.prototype.hasOwnProperty.call(maps, mapId) ? maps[mapId] : null;
}

/** 这个 id 是不是一张已注册的地图。 */
export function isKnownMap(cfg, mapId) {
  return !!mapTableOf(cfg, mapId);
}

/**
 * 把任意输入收敛成一张**已注册**的地图 id。
 *
 * 为什么需要它（而不是简单地 `|| default`）：地图 id 会存进档案，
 * 而档案是外部输入（玩家手改 / 旧版本写过 / 地图表被删过）。
 * 未知 id 必须回落到默认地图，并且**留下痕迹** —— 静默回落的后果是
 * "我明明选了电视台、进去却是工业区"，而玩家没有任何线索可查。
 *
 * @returns {{mapId:string, repaired:boolean}} repaired=true 表示发生了回落
 */
export function resolveMapId(cfg, raw) {
  const fallback = cfg.activeMap || Object.keys(cfg.maps || {})[0] || null;
  if (typeof raw === 'string' && isKnownMap(cfg, raw)) return { mapId: raw, repaired: false };
  return { mapId: fallback, repaired: true };
}

/**
 * 某张地图的统计量（**界面与简报共用的那一份算法**）。
 *
 * 口径说明：
 *   · `floors`     —— 层数。缺 `floors` 字段就是单层（M3-1b-2 ④ 的既有约定）。
 *   · `containers` —— 容器数，取自地图表（运行时的容器就是它摆出来的那一批）。
 *   · `extracts`   —— 撤离点，`conditional` 是"需要满足开门规则"的那些。
 *   · `enemies`    —— 普通 AI 配额之和 **+ Boss**。分开给出来是因为
 *                     aiSpawns 之和被校验钉死等于 ai.spawnRules.totalCount（普通 AI），
 *                     Boss 走独立配额；只报前者会让"电视台有 Boss"这件事在界面上消失。
 */
export function mapCountsOf(map) {
  const zones = (map && map.zones) || [];
  const extracts = (map && map.extracts) || [];
  const spawns = (map && map.aiSpawns) || [];
  const boss = (map && map.bossSpawns) || [];
  return {
    id: map ? map.id : null,
    label: map ? map.label : null,
    floors: (map && map.floors ? map.floors.length : 1),
    zones: zones.length,
    lootZones: zones.filter((z) => isLootZoneRole(z.role)).length,
    containers: ((map && map.containers) || []).length,
    extracts: extracts.length,
    conditionalExtracts: extracts.filter((e) => e.conditional).length,
    enemies: spawns.reduce((a, s) => a + s.count, 0) + boss.length,
    bossCount: boss.length,
  };
}

/**
 * 全部已注册地图的选项列表。
 *
 * 注意：**界面不用它** —— 大厅的地图卡片需要"每张图的层数/容器/撤离点/敌方"，
 * 而那是 `core/briefing.js` 的产物（与下方那份完整简报同源），
 * 由 `main.js` 的 `mapOptionOf()` 逐图算出来。留这个函数是给**测试与工具**的：
 * 纯逻辑断言要能在不碰界面、不构造 briefing 的前提下核对"注册了几张、顺序是什么"。
 *
 * 排序口径：**注册表顺序**（`cfg.maps` 的键序），不做任何"按收益排序"——
 * 那是策划决定，不该由界面悄悄替玩家做。
 *
 * @param {object} cfg 装配后的配置
 */
export function listMapOptions(cfg) {
  const maps = (cfg && cfg.maps) || {};
  return Object.keys(maps).map((id) => mapCountsOf(maps[id]));
}
