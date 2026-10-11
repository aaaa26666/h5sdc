// M4-3 单局结算（纯函数，不含任何 DOM / three.js）
//
// 为什么单独成文件、且必须是纯函数：
//   M4 阶段约束词硬性要求「结算必须独立于表现层，便于幂等与重放」，
//   《流程文档》3.3 也要求逻辑层不得依赖渲染层。
//   此前结算数据是 main.js 在 endRaid 里现拼好直接交给 hud.showResult 的 ——
//   那样它既无法单独测试，也无法重放，更谈不上"幂等"。
//
// 幂等怎么保证：
//   本文件**没有内部状态、不修改入参**，同样的输入必然得到同样的输出。
//   至于"同一局重复提交不会重复发放奖励"，由两道防线共同保证：
//     ① 结算结果是纯函数 —— 重放一次得到的还是同一个结果（不会累加）；
//     ② 状态机只能迁移一次 —— flow RAID → ENDED 后再调 endRaid 会被挡住（见 main.js）。
//   本文件负责 ①，② 不在它的职责里，但两者缺一不可。
//
// 数值来源：全部由调用方（main.js）从各系统取好后传入；本文件不读配置、不产生数值。

/**
 * @param {object} facts 局内事实
 * @param {string} facts.reason      结束原因（extracted / dead / timeout）
 * @param {string} facts.outcome     结算口径（'extract' = 全部带出；'death' = 只保住安全箱）
 * @param {number} facts.elapsedMs   单局耗时
 * @param {number} facts.kills       击杀数
 * @param {number} facts.aiTotal     AI 总数
 * @param {number} facts.containersOpened 已开容器
 * @param {number} facts.containersTotal  容器总数
 * @param {number} facts.shotsFired  开火次数
 * @param {number} facts.health      剩余生命
 * @param {Array}  facts.kept        inventory.settle().kept
 * @param {Array}  facts.lost        inventory.settle().lost
 * @param {number} facts.keptValue   带出估值
 * @param {number} facts.lostValue   损失估值
 * @param {number} facts.safeValue   安全箱保住估值
 * @param {Array}  [facts.rarityTable] 稀有度表（用于分组与着色）
 * @returns {object} 结算结果（可序列化，供 UI 渲染与断言比对）
 */
export function buildRaidResult(facts) {
  const kept = facts.kept || [];
  const lost = facts.lost || [];
  const rarityTable = facts.rarityTable || [];
  const rarityOf = (id) => rarityTable.find((r) => r.id === id) || null;

  // 逐物品明细，按价值降序 —— 玩家最关心"我带回了什么值钱的"。
  // 这里生成的是**值拷贝**，不把 inventory 的条目对象直接交出去，
  // 免得 UI 层哪天改了它、反过来把局内数据改脏。
  const toItemView = (e) => {
    const r = rarityOf(e.item.rarity);
    return {
      id: e.item.id,
      label: e.item.label,
      value: e.item.value,
      rarity: e.item.rarity || null,
      rarityLabel: r ? r.label : '',
      colorHex: r ? r.colorHex : null,
    };
  };
  const byValueDesc = (a, b) => b.value - a.value;
  const items = kept.map(toItemView).sort(byValueDesc);

  // M4-4：损失明细。只有"损失了多少估值"是不够的 ——
  // 玩家要知道**具体丢了哪几件**，否则他无法判断下一次该不该贪、该先塞什么进保险箱。
  const lostItems = lost.map(toItemView).sort(byValueDesc);

  // M4-4：保险箱保住的东西。阵亡时 kept 就是这些，撤离时它们是 kept 的子集。
  const safeItems = kept.filter((e) => e.inSafe).map(toItemView).sort(byValueDesc);

  // 按稀有度分组汇总。保留 count=0 的档位，由 UI 决定是否渲染。
  const rarityBreakdown = rarityTable.map((r) => {
    const list = kept.filter((e) => e.item.rarity === r.id);
    return {
      id: r.id,
      label: r.label,
      colorHex: r.colorHex,
      count: list.length,
      value: list.reduce((a, e) => a + e.item.value, 0),
    };
  });

  return {
    reason: facts.reason,
    outcome: facts.outcome,
    /** 是否成功把战利品带出来（撤离成功才为 true） */
    carried: facts.outcome === 'extract',
    elapsedMs: facts.elapsedMs,
    combat: {
      kills: facts.kills,
      aiTotal: facts.aiTotal,
      shotsFired: facts.shotsFired,
      health: facts.health,
      containersOpened: facts.containersOpened,
      containersTotal: facts.containersTotal,
    },
    /** 收益明细：带回什么、失去什么、保险箱保住了什么 */
    loot: {
      keptCount: kept.length,
      lostCount: lost.length,
      keptValue: facts.keptValue,
      lostValue: facts.lostValue,
      safeValue: facts.safeValue,
      // 阵亡时"保住比例"：带出 0 的情况下，安全箱就是全部所得
      survivedRatio:
        facts.keptValue + facts.lostValue > 0
          ? facts.keptValue / (facts.keptValue + facts.lostValue)
          : 0,
    },
    items,
    /** M4-4：阵亡 / 超时时丢下的物品（逐件，按价值降序） */
    lostItems,
    /** M4-4：保险箱保住的东西（阵亡时这些就是全部所得） */
    safeItems,
    rarityBreakdown,
    // [M4-TEMP-3] 经验与任务进度：系统分别属 M5-5（等级/技能）与 M5-6（任务线），
    // M4 阶段不存在，这里的 0 是**占位数值**而不是计算结果。
    // 制作人裁定界面上先显示出来，故按 0 输出；M5 接入后应改为真实计算值。
    progression: {
      exp: 0,
      questsCompleted: 0,
      questsTotal: 0,
      _placeholder: true,
    },
  };
}

/** 结算结果里"玩家实际到手"的估值（撤离 = 全部；阵亡 = 安全箱） */
export function netValue(result) {
  return result && result.loot ? result.loot.keptValue : 0;
}
