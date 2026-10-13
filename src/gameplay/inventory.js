// M3-5 拾取、丢弃、背包格子与容量、负重
// M3-6 安全箱（阵亡时其中物品保留）
// M6   携行具容量化 + 弹药/消耗品占网格（销 [M5-TEMP-11]）
//
// 职责：二维网格背包（+ 弹挂的第二张网格）、负重上限、物品形状排放、安全箱自动装填、死亡结算。
//
// ★ M6 的三条口径（docs/18 §3.2，别当成 bug 改掉）：
//   ① **容量来自装备**：背包格数与负重上限取 `raidKit.carry.backpack`（装备的那只，
//      没装就用 carry.json 的兜底），不再读 loot.json 里的固定 6x5。loot.json 那一份
//      现在只是**校验器的参考装载**，与局内容量是两回事。
//   ② **弹药与消耗品占格**：进局时按 `raidKit.carry.placements` 摆进网格（`source:'kit'`）。
//      备弹数 / 药品数因此变成**派生量**（数网格里还剩多少），不再是另存的一份数字。
//   ③ **战利品与携行件分账**：`source:'kit'` 的东西不进安全箱自动装填、不计入"战利品负重"、
//      不算作带出的战利品（它们由 core/loadout.js 的 returnLoadout 按"没用完的还回"处理）。
//      不分账的后果是同一发子弹被还两次 —— 一次当"没用完的行头"、一次当"带出的战利品"。
//
// 装包算法只此一份：`src/core/packing.js`，与掉落表校验脚本（理论分布）共用 ——
// 这样"理论能装多少"和"运行时实际装了多少"才是可比的两件事。
import { createGrid, findSlot, markArea, packIntoGrid, byValueDensity } from '../core/packing.js';

/**
 * @param {object} cfg 配置（需含 lootTable / carry / itemDefs）
 * @param {object} [opts]
 * @param {string} [opts.safeTierId] 安全箱档位，默认新账号档（tiers[0] = 1×2）
 * @param {object} [opts.kit] raidKit（core/loadout.js 的 buildRaidKit 产物）
 */
export function createInventory(cfg, opts = {}) {
  const table = cfg.lootTable;
  const safeDef = table.safeContainer;
  const excluded = safeDef.excludeCategories || [];
  const kit = opts.kit || null;
  const carry = (kit && kit.carry) || null;

  // ★ M6：背包规格取**装备的那只**；没有 raidKit（纯逻辑单测）时退回 loot 表的参考装载。
  const bpDef = carry ? carry.backpack : table.backpack;
  const grid = createGrid(bpDef.w, bpDef.h);
  // ★ M6：弹挂是**第二张网格**。它只收 accepts 里的类别，与背包并存。
  const rigDef = carry ? carry.rig : null;
  const rigGrid = rigDef ? createGrid(rigDef.w, rigDef.h) : null;

  // ★ M6：负重上限 = 所装背包的 weightLimitKg + 技能加成（合计已在 raidKit 里算好）。
  //   注意它管的是**战利品净重**（不含出发行头）—— 与 M3 的口径一致，
  //   而出发行头的重量由 core/loadout.js 的 overweightBand 单独管。两者混用会让"超重"说不清。
  const weightLimitKg = carry ? carry.backpack.weightLimitTotalKg : bpDef.weightLimitKg;

  const tierId = (kit && kit.loadout.safeTierId) || opts.safeTierId || safeDef.tiers[0].id;
  const tier = safeDef.tiers.find((t) => t.id === tierId) || safeDef.tiers[0];
  const safeGrid = createGrid(tier.w, tier.h);

  /** 背包/弹挂内物品：{ uid, item, count, x, y, w, h, rotated, inSafe, source, where } */
  let items = [];
  let uidSeq = 1;

  // ★ M6：把进局时规划好的携行件（core/carry.js 的产物）按格摆进来。
  //   坐标**直接用规划里的** —— 规划与运行时共用同一张网格尺寸与同一个 findSlot，
  //   因此不需要也不应该重算：重算就会出现"规划说在 (0,0)、实际摆到 (2,1)"这种
  //   只在背包快满时才暴露的分叉。
  if (carry) {
    for (const p of carry.placements) {
      const def = cfg.itemDefs[p.itemId];
      if (!def) continue;
      const onRig = p.grid === 'rig' && !!rigGrid;
      markArea(onRig ? rigGrid : grid, p.x, p.y, p.w, p.h, true);
      items.push({
        uid: uidSeq++,
        item: def,
        count: p.count,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        rotated: !!p.rotated,
        inSafe: false,
        source: 'kit',
        kind: p.kind,
        caliber: p.caliber || null,
        where: onRig ? 'rig' : 'backpack',
      });
    }
  }

  // ★ M6：一格可以放多件（上限 = 物品的 stack，与仓库的堆叠口径同源）。
  //   重量与价值因此必须按 count 折算，否则"半盒子弹"会按整盒算账。
  const weightOfEntry = (e) => (e.item.unitWeightKg !== undefined ? e.item.unitWeightKg : e.item.weightKg) * (e.count || 1);
  const valueOfEntry = (e) => (e.item.unitValue !== undefined ? e.item.unitValue : e.item.value) * (e.count || 1);
  const weightOf = (list) => list.reduce((a, e) => a + weightOfEntry(e), 0);
  const valueOf = (list) => list.reduce((a, e) => a + valueOfEntry(e), 0);

  /** 战利品（携行件不算：它们由 returnLoadout 按"没用完的还回"处理）。 */
  const lootItems = () => items.filter((e) => e.source !== 'kit');

  /**
   * 安全箱里已经装了什么（按价值密度降序自动装填，与理论模拟的口径一致）。
   *
   * [M3-TEMP-2] 装填是**自动**的：玩家不能指定"这个进保险箱"。
   * 自动策略取"价值密度最高且类别允许"，与掉落表校验脚本的模拟口径一致；
   * 但真人有更细的偏好（例如优先保任务物品）。显式指定要等 M5 的背包 UI。
   *
   * ★ M6：`source:'kit'` 的**自己带进来的**弹药药品不进安全箱。
   *   否则"带 60 发进局 → 自动塞进保险箱 → 死了还留着"等于无限白嫖弹药，
   *   而安全箱的设计用途是"保小件贵重品"（见 safeContainer._excludeNote）。
   */
  function refillSafe() {
    for (let y = 0; y < safeGrid.h; y++) safeGrid.occupied[y].fill(false);
    for (const e of items) e.inSafe = false;

    const candidates = lootItems()
      .filter((e) => !excluded.includes(e.item.category))
      .sort((a, b) => valueOfEntry(b) / b.item.vol - valueOfEntry(a) / a.item.vol);

    for (const e of candidates) {
      const slot = findSlot(safeGrid, e.item);
      if (!slot) continue;
      markArea(safeGrid, slot.x, slot.y, slot.w, slot.h, true);
      e.inSafe = true;
      e.safeSlot = slot;
    }
  }

  /** 弹挂是否收这个类别（没有弹挂就一律 false）。 */
  const rigAccepts = (item) => !!(rigDef && rigDef.accepts.includes(item.category));

  /**
   * 找落点：**弹挂优先**（它只收弹药与药品），装不下再溢出到背包 ——
   * 与进局时的投放规则（core/carry.js）同一条，否则"进局时子弹在弹挂、捡到的在背包"
   * 会让玩家看到两套规律。
   * @returns {{grid:object, rig:boolean, slot:object}|null}
   */
  function locate(item) {
    if (rigGrid && rigAccepts(item)) {
      const slot = findSlot(rigGrid, item);
      if (slot) return { grid: rigGrid, rig: true, slot };
    }
    const slot = findSlot(grid, item);
    if (slot) return { grid, rig: false, slot };
    return null;
  }

  /**
   * 尝试把一件物品放进背包（或弹挂）。
   * @returns {{ok:boolean, reason?:string, entry?:object}}
   */
  function tryAdd(item) {
    if (weightKg() + item.weightKg > weightLimitKg) {
      return { ok: false, reason: 'weight' };
    }
    const at = locate(item);
    if (!at) return { ok: false, reason: 'space' };
    markArea(at.grid, at.slot.x, at.slot.y, at.slot.w, at.slot.h, true);
    const entry = {
      uid: uidSeq++,
      item,
      // ★ M6：一格装多少由物品自己的 stack 决定（弹药一盒 60 发），
      //   与仓库的堆叠口径同源。这样 unitValue × count 恒等于"这一格值多少"。
      count: item.unitsPerItem || 1,
      ...at.slot,
      inSafe: false,
      source: 'loot',
      where: at.rig ? 'rig' : 'backpack',
    };
    items.push(entry);
    refillSafe();
    return { ok: true, entry };
  }

  /** 不实际放入，只判断能不能放（用于"背包满了"的提前提示）。 */
  function canAdd(item) {
    if (weightKg() + item.weightKg > weightLimitKg) return false;
    return !!locate(item);
  }

  /** 丢弃（或从背包移除）一件。返回被移除的条目。 */
  function remove(uid) {
    const i = items.findIndex((e) => e.uid === uid);
    if (i < 0) return null;
    const [e] = items.splice(i, 1);
    // 重建整张占用图：增量腾空容易与其他物品的旋转状态不一致
    rebuildOccupancy();
    refillSafe();
    return e;
  }

  function rebuildOccupancy() {
    for (let y = 0; y < grid.h; y++) grid.occupied[y].fill(false);
    if (rigGrid) for (let y = 0; y < rigGrid.h; y++) rigGrid.occupied[y].fill(false);
    for (const e of items) {
      markArea(e.where === 'rig' && rigGrid ? rigGrid : grid, e.x, e.y, e.w, e.h, true);
    }
  }

  /**
   * 整理背包：把**战利品**按价值密度降序重排，携行件留在原处。
   *
   * 运行时是"捡到什么塞什么"，整理后会向理论模拟的容量靠拢（见 packing.js 的说明）。
   * 携行件不动的理由：玩家会以为"整理把我的子弹弄丢了"，
   * 而"我带进来的东西在哪一格"是他自己决定的（进局时的投放顺序也是确定的）。
   */
  function tidy() {
    const kitEntries = items.filter((e) => e.source === 'kit');
    const loot = lootItems();
    for (let y = 0; y < grid.h; y++) grid.occupied[y].fill(false);
    if (rigGrid) for (let y = 0; y < rigGrid.h; y++) rigGrid.occupied[y].fill(false);
    for (const e of kitEntries) markArea(e.where === 'rig' && rigGrid ? rigGrid : grid, e.x, e.y, e.w, e.h, true);

    // 每件战利品折算成"这一格实际值多少 / 多重"的视图后再交给 packing ——
    // 半盒子弹不能按整盒算重量，也不能按整盒排位。
    const views = new Map();
    const toView = (e) => {
      const v = { ...e.item, count: e.count, weightKg: weightOfEntry(e), value: valueOfEntry(e) };
      views.set(v, e);
      return v;
    };
    const packOne = (target, list, remainingKg) => {
      const sorted = list.map(toView).sort(byValueDensity);
      const res = packIntoGrid(target, sorted, remainingKg, []);
      return {
        kept: res.placed.map((p) => ({ ...views.get(p.item), x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated })),
        dropped: res.leftovers.map((v) => views.get(v)),
        weightKg: res.weightKg,
      };
    };
    // 弹挂只收它接受的类别，其余直接进背包；弹挂装不下的也溢出到背包（与 tryAdd 同规则）
    const rigList = rigGrid ? loot.filter((e) => rigAccepts(e.item)) : [];
    const bagList = loot.filter((e) => !rigList.includes(e));
    const rigRes = rigGrid ? packOne(rigGrid, rigList, weightLimitKg) : { kept: [], dropped: [], weightKg: 0 };
    const bagRes = packOne(grid, [...bagList, ...rigRes.dropped], Math.max(0, weightLimitKg - rigRes.weightKg));

    items = [
      ...kitEntries,
      ...rigRes.kept.map((e) => ({ ...e, where: 'rig' })),
      ...bagRes.kept.map((e) => ({ ...e, where: 'backpack' })),
    ];
    refillSafe();
    return { placed: items.length, leftovers: bagRes.dropped.length };
  }

  const weightKg = () => weightOf(lootItems());
  const value = () => valueOf(lootItems());
  const safeValue = () => valueOf(items.filter((e) => e.inSafe));

  // -------------------------------------------------------------------------
  // ★ M6：携行件（弹药 / 消耗品）的运行时账
  //
  // 备弹数与药品数**不再另存一份**，而是数网格里还剩多少。
  // 为什么必须这样：只要还有一份独立的计数器，就迟早出现
  // "网格里显示有子弹、计数器说没有"这类两处各说一套的状态。
  // -------------------------------------------------------------------------

  /** 网格里（背包 + 弹挂）某个物品的**存储单位**总数（弹药按发、其余按个）。 */
  function totalOf(itemId, filter) {
    let n = 0;
    for (const e of items) {
      if (e.item.id !== itemId) continue;
      if (filter && !filter(e)) continue;
      n += e.count || 1;
    }
    return n;
  }

  /** 某个口径还剩多少发（含捡到的同口径弹药）。 */
  const ammoTotalOf = (caliber) => {
    const a = (cfg.ammo || []).find((x) => x.id === caliber);
    return a && a.itemId ? totalOf(a.itemId) : 0;
  };

  /** ★ 结算口径：只数**自己带进来的**（source:'kit'）还剩多少，捡到的那部分走战利品结算。 */
  const kitAmmoOf = (caliber) => {
    const a = (cfg.ammo || []).find((x) => x.id === caliber);
    return a && a.itemId ? totalOf(a.itemId, (e) => e.source === 'kit') : 0;
  };
  const kitCountOf = (itemId) => totalOf(itemId, (e) => e.source === 'kit');
  const lootCountOf = (itemId) => totalOf(itemId, (e) => e.source !== 'kit');

  /**
   * 从网格里扣掉 n 个单位的某物品。
   * 顺序：**先自己带的，再捡到的**；同为自带时**先扣小的那盒**。
   *
   * 为什么先扣自带的：结算要区分"没用完的行头"（还回仓库）与"带出的战利品"（入库），
   * 先扣自带的才能让两笔账各自闭合；顺序反过来会把战利品算成"没用完的行头"，
   * 于是同一批子弹被还两次。
   * 为什么先扣小的那盒：小盒先清空才能腾出格子。这是玩家的直觉，也让"格子压力"早点缓解。
   */
  function takeOf(itemId, n) {
    let need = Math.max(0, Math.floor(n) || 0);
    if (need <= 0) return 0;
    const pool = items
      .filter((e) => e.item.id === itemId && (e.count || 1) > 0)
      .sort((a, b) => (a.source === 'kit' ? 0 : 1) - (b.source === 'kit' ? 0 : 1) || (a.count || 1) - (b.count || 1));
    let taken = 0;
    for (const e of pool) {
      if (need <= 0) break;
      const have = e.count || 1;
      const use = Math.min(have, need);
      e.count = have - use;
      taken += use;
      need -= use;
      if (e.count <= 0) {
        const i = items.indexOf(e);
        if (i >= 0) items.splice(i, 1);
      }
    }
    if (taken > 0) {
      rebuildOccupancy();
      refillSafe();
    }
    return taken;
  }

  const takeAmmo = (caliber, rounds) => {
    const a = (cfg.ammo || []).find((x) => x.id === caliber);
    return a && a.itemId ? takeOf(a.itemId, rounds) : 0;
  };
  const countOf = (itemId) => totalOf(itemId);
  const takeItem = (itemId, n = 1) => takeOf(itemId, n);

  /**
   * M3-6 死亡掉落结算。
   *   撤离成功 → **战利品**全部带出；阵亡 / 超时 / 断线 → 只保住安全箱里的。
   *
   * ★ M6：携行件不在这里结算（它们由 core/loadout.js 的 returnLoadout 按
   *   "没用完的还回"处理）。混进来的表现是同一发子弹被还两次。
   * @param {'extract'|'death'} outcome
   */
  function settle(outcome) {
    const loot = lootItems();
    const kept = outcome === 'extract' ? loot.slice() : loot.filter((e) => e.inSafe);
    const lost = outcome === 'extract' ? [] : loot.filter((e) => !e.inSafe);
    return {
      outcome,
      kept,
      lost,
      keptValue: valueOf(kept),
      lostValue: valueOf(lost),
      keptWeightKg: weightOf(kept),
    };
  }

  return {
    grid,
    rigGrid,
    rig: rigDef,
    backpack: bpDef,
    safeGrid,
    safeTier: tier,
    weightLimitKg,
    get items() { return items; },
    /** ★ M6：只要**战利品**（结算、快照、HUD 的"捡了几件"都用它，不含自己带的弹药药品） */
    get lootItems() { return lootItems(); },
    get lootCount() { return lootItems().length; },
    get count() { return items.length; },
    weightKg,
    value,
    safeValue,
    totalOf,
    ammoTotalOf,
    kitAmmoOf,
    kitCountOf,
    lootCountOf,
    countOf,
    takeAmmo,
    takeItem,
    /** 已用格数（按形状计，不是条目数） */
    usedSlots: () => items.reduce((a, e) => a + e.w * e.h, 0),
    /** 携行件占掉的格数（"我真正能拿来装战利品的格子还剩几格"） */
    kitSlots: () => items.filter((e) => e.source === 'kit').reduce((a, e) => a + e.w * e.h, 0),
    /** 战利品占掉的格数 */
    lootSlots: () => lootItems().reduce((a, e) => a + e.w * e.h, 0),
    totalSlots: () => bpDef.w * bpDef.h,
    rigTotalSlots: () => (rigDef ? rigDef.w * rigDef.h : 0),
    rigAccepts: (item) => rigAccepts(item),
    tryAdd,
    canAdd,
    remove,
    tidy,
    settle,
    /** 安全箱能否装下某物品（类别限制 + 形状） */
    safeAccepts: (item) => !excluded.includes(item.category),
  };
}
