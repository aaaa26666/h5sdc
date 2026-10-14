// M5 主大厅（局外）
//
// 职责：把三样东西排版出来 ——
//   ① 玩家档案读数（等级 / 经验 / 货币 / 仓库，来自 core/profile.js 的 profileView）
//   ② 战区简报（来自 core/briefing.js，★ M6-5 起按**玩家选的那张图**算）
//   ③ 标签页的容器（具体面板在 src/ui/panels.js）
// 并把三个动作的**入口**暴露给调用方：进入战区 / 设置 / 查看上局结算。
//
// 本文件**不做任何计算**：
//   这里出现的每一个数字都来自纯函数或配置表。端到端有一条断言专门守这件事
//   （tools/smoke.mjs 会扫这个文件的源码，确认里面没有数字字面量参与计算）。
//
// 分层（《流程文档》3.3）：本文件属**表现层**，禁止反过来 import gameplay/ 或 level/ ——
//   局外系统依赖局内实现，就是 M5 约束里"禁止把局内逻辑耦合进局外系统"的反向版本。
//   这条约束由冒烟测试里的静态检查守住（不靠自觉）。
//
// ★ M5 销账：
//   · M5-TEMP-1（简报不显示养成数据）→ 现在顶部状态条显示等级 / 货币 / 仓库。
//   · M5-TEMP-3（大厅没有任务 / 仓库 / 商店入口）→ 现在有标签页。
//   两处的数据源都是档案的派生视图，**刻意不留占位数字**。

const $ = (id) => document.getElementById(id);

/**
 * 标签页顺序（同时决定 DOM id：tabGear / tabDeploy / …）。
 *
 * ★ M6-3：配装与仓库合并为「装备」（docs/18 §3.3），页签由 6 个变 4 个。
 * ★ M6-5（制作人裁定 2026-10-14）：**大厅拆成两个不同的标签页** ——
 *   · 「装备」= 左边配装 + 右边仓库（= M6-3 那一整页，交互一字不改）
 *   · 「进入战局」= 地图选择 + 该图的战区简报 + 「进入战局」按钮（简报从装备页移过来）
 *   难度选择本次不做（已裁定推迟）。因此最终是 5 个：装备 / 进入战局 / 商店 / 技能 / 任务。
 * 这三处必须同时改：TABS、`bodyIdOf` 生成的 id、以及 index.html 里的 `.tab`。
 */
export const TABS = Object.freeze(['gear', 'deploy', 'shop', 'skills', 'quests']);

const bodyIdOf = (tab) => `tab${tab[0].toUpperCase()}${tab.slice(1)}`;

/** 毫秒 → mm:ss。纯格式化：不参与任何"这一局有多长"的判定。 */
function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const row = (k, v, cls = '') => `<div class="row"><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;
const stat = (k, v) => `<span class="k">${k}</span> <span class="v">${v}</span>`;
/**
 * 属性位转义（地图 id / 标签）。
 *
 * 这些值目前都来自我们自己维护的地图表，但"现在安全"不是理由：
 * 把未经转义的值拼进 HTML 属性，一旦将来有人给地图起一个带引号的名字
 * 就会变成一个坏掉的页面，而那时没人会想到是这里。转义的代价是一个函数。
 */
const escAttr = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createLobby() {
  const el = {
    screen: $('screenLobby'),
    body: $('lobbyBody'),
    deployBody: $('deployBody'),
    mapList: $('mapList'),
    stats: $('lobbyStats'),
    tabs: $('lobbyTabs'),
    btnStart: $('btnStart'),
    btnSettings: $('btnSettings'),
    toast: $('lobbyToast'),
    interruptedNotice: $('interruptedNotice'),
    bodies: Object.fromEntries(TABS.map((t) => [t, $(bodyIdOf(t))])),
  };

  const tabEls = el.tabs ? Array.from(el.tabs.querySelectorAll('.tab')) : [];
  let onTab = () => {};
  /** ★ M6-5：玩家点地图卡片（或点「自动选图」）时的回调。判定与落库都在 core，这里不校验。 */
  let onMapPick = () => {};
  // 默认页签 = index.html 里带 `.on` 的那一个（M6-3 起是「装备」）。
  //
  // ★ M6-5 裁定：默认**仍停在「装备」**。理由：「进入战局」页上的按钮是**进战区**这个
  //   不可逆动作（进去就要打完一局），不该在玩家刚回大厅、还没看配装时正对着他。
  //   代价是"进战区"多一步点击 —— 这是刻意的，不是漏了。
  let current = TABS[0];

  /** 切换标签页。面板内容由 main.js 渲染（UI 不持有数据）。 */
  function showTab(name) {
    if (!el.bodies[name]) return;
    current = name;
    for (const t of tabEls) t.classList.toggle('on', t.dataset.tab === name);
    for (const [k, node] of Object.entries(el.bodies)) node.classList.toggle('on', k === name);
    onTab(name);
  }
  for (const t of tabEls) t.addEventListener('click', () => showTab(t.dataset.tab));

  // ★ M6-5：地图卡片用**事件委托**（卡片每次重绘都会重建 DOM，逐个绑监听既会泄漏、
  //   也会在"渲染后忘了绑"时静默失效 —— 那正是本文件一直用委托的理由）。
  if (el.mapList) {
    el.mapList.addEventListener('click', (ev) => {
      const node = ev.target.closest('[data-map]');
      if (!node || !el.mapList.contains(node)) return;
      onMapPick(node.dataset.map);
    });
  }

  return {
    el,
    /** 当前标签页名（供断言与"回到大厅时保持原标签"用） */
    get tab() {
      return current;
    },
    showTab,
    /** 注册标签切换回调：main.js 用它按需重绘面板 */
    onTabChange(fn) {
      onTab = fn;
    },
    /** ★ M6-5：注册"玩家选了地图"回调（地图 id 的合法性由 core/mapView.js 判定） */
    onMapSelect(fn) {
      onMapPick = fn;
    },

    /** 显示/隐藏大厅。入口的"谁该显示"由 main.js 决定，UI 层不做流程判断。 */
    show(on) {
      el.screen.classList.toggle('on', on);
    },

    /**
     * M4-7：大厅上的"上局未正常结束"提示。
     * 只在**大厅**上显示一条，点击后才去看结算 —— 不主动打断进入流程。
     */
    showInterruptedNotice(on) {
      if (el.interruptedNotice) el.interruptedNotice.hidden = !on;
    },

    /**
     * 玩家档案读数（M5-TEMP-1 的销账：简报不再回避养成数据）。
     * @param {object} v core/profile.js 的 profileView 产物
     */
    renderStats(v) {
      if (!v) {
        el.stats.innerHTML = '';
        return;
      }
      const lv = v.isMaxLevel
        ? `Lv.${v.level}（满级）`
        : `Lv.${v.level} · ${v.expInLevel}/${v.expForLevel}`;
      el.stats.innerHTML =
        stat('等级', lv) +
        stat('技能点', v.skillPoints) +
        stat('货币', v.currency) +
        stat('仓库', `${v.stash.items} 件 · ${v.stash.used}/${v.stash.total} 格 · 估值 ${v.stash.value}`) +
        stat('撤离率', v.stats.raids ? `${v.stats.extracts}/${v.stats.raids}` : '—') +
        stat('安全箱', v.safeTierUnlocked);
    },

    /**
     * 大厅自己的提示条（局内 HUD 的 toast 在 #hud 内，局外看不到）。
     * @param {string} msg 已经翻成人话的文本（翻译在 core 之外做，见 ui/panels.js 的 reasonText）
     * @param {boolean} [warn] 是否用告警色
     */
    toast(msg, warn) {
      if (!el.toast) return;
      el.toast.className = warn ? 'bad' : 'muted';
      el.toast.textContent = msg || '';
    },

    /**
     * ★ M6-5：「装备」页顶部的读数。
     *
     * 这里**只**放"这一局的配装"相关的读数（带什么枪 / 护甲 / 备弹 / 医疗 / 携行 / 安全箱）。
     * 地图那一类读数（战区、时限、资源分区、敌方、撤离点）**已经搬到「进入战局」页**
     * （见 renderDeploy）—— 制作人裁定：简报条跟着地图选择走，
     * 因为它回答的是"我这一局要面对什么"，而不是"我带了什么"。
     *
     * @param {object} brief buildRaidBriefing 的产物（残缺/未定义时直接返回，
     *        不猜默认值 —— 简报缺失属于接线错误，宁可留空也不要显示假的数字）
     */
    render(brief) {
      if (!brief) return;
      const b = brief;

      const ammoText = b.loadout.reserve.length
        ? b.loadout.reserve.map((a) => `${a.label} ×${a.rounds}`).join(' · ')
        : '无';

      const consumableText = b.loadout.consumables.length
        ? b.loadout.consumables.map((c) => `${c.label} ×${c.count}`).join(' · ')
        : '无';

      const armor = b.loadout.armor;
      const armorText = armor ? `${armor.label}（等级 ${armor.class}，耐久 ${armor.durability}）` : '无';

      // ★ M6：背包与弹挂现在**决定局内容量**，因此报的是"所装备的那一只"，
      //   并说明自带弹药药品占掉多少格 —— 否则"12 格"会让玩家以为全都能装战利品。
      const pk = b.pack;
      const carryText = `${pk.backpack.label || '兜底'} ${pk.backpack.w}×${pk.backpack.h}（${pk.backpack.slots} 格 · ${pk.backpack.totalWeightLimitKg} kg）`
        + (pk.rig ? ` ；弹挂 ${pk.rig.label} ${pk.rig.w}×${pk.rig.h}` : '')
        + (pk.kitSlots ? ` ；自带占 ${pk.kitSlots} 格` : '');
      // ★ M6-4：带不进去的东西**在进战区时会被拦下**（弹出警告页），
      //   因此这句话要说清后果，而不是只说"装不下"——后者听起来像"少带一点"，
      //   而实际上不处理掉就进不去。
      const overflowText = pk.overflow && pk.overflow.length
        ? `<div class="muted li warn">· 带不进去（进战区前会被拦下）：${pk.overflow.map((o) => `${o.itemId} ×${o.count}`).join('、')}</div>`
        : '';

      el.body.innerHTML =
        row('主武器', b.loadout.primary ? `${b.loadout.primary.label}（${b.loadout.primary.caliber}）` : '无') +
        row('副武器', b.loadout.secondary ? `${b.loadout.secondary.label}（${b.loadout.secondary.caliber}）` : '无') +
        row('备弹', ammoText) +
        row('护甲', armorText) +
        row('医疗', consumableText) +
        row('携行', carryText) +
        overflowText +
        row('安全箱', `${b.pack.safe.label}（${b.pack.safe.w}×${b.pack.safe.h}，阵亡时箱内物品保留）`);
    },

    /**
     * ★ M6-5：「进入战局」页 —— 地图选择 + **所选地图**的战区简报。
     *
     * 为什么简报必须跟着所选地图走（而不是固定显示 activeMap）：玩家点哪张图，
     * 这张卡上的撤离点规则、时限、容器数、敌方数量就应该是**那张图**的。
     * 显示另一张图的数字比不显示更糟 —— 玩家会照着错的撤离点规则做决定。
     *
     * 界面里**一个数字都不算**：全部取自 core/briefing.js 的 `brief` 与
     * core/mapView.js 的 `options`（它们的产物在 main.js 里算好后传进来）。
     *
     * @param {object} p { options: 地图选项[], selectedId: 当前选中的地图 id, brief: 该图的简报 }
     */
    renderDeploy(p) {
      if (!el.deployBody) return;
      if (!p || !p.brief) {
        el.deployBody.innerHTML = '';
        return;
      }
      const b = p.brief;

      const extractRows = b.extracts.list
        .map((z) => `<div class="muted li">· 第 ${z.floor} 层 ${z.label} —— ${z.rule}</div>`)
        .join('');

      el.deployBody.innerHTML =
        row('战区', `${b.map.label}（${b.map.floors} 层）`) +
        row('单局时限', fmtDuration(b.raid.timeLimitMs)) +
        row('资源分区', `${b.map.lootZones} 个 · 容器 ${b.map.containers} 个`) +
        row('敌方', `${b.enemies.total} 名 · ${b.enemies.tiers.join(' / ')}`) +
        row(
          '撤离点',
          `共 ${b.extracts.total} 个（常驻 ${b.extracts.always} · 条件 ${b.extracts.conditional}）`
        ) +
        extractRows;

      if (!el.mapList) return;
      // 卡片上的四类差异（层数 / 容器 / 撤离点含条件 / 敌方）**全部来自 core**：
      //   options 由 main.js 用 core/briefing.js 逐图算出来（与下方那份简报**同源**）。
      //
      //   注意字段来源：每个 option 直接用 `o.map` / `o.extracts` / `o.enemies`
      //   —— 那是 `mapOptionOf()` 的产物形状。**不要**在这里读 `o.brief`：
      //   调用方（main.js）传的是"已经摊平的那三段"，读 `o.brief` 会静默拿到 undefined，
      //   表现是"卡片上只有图名、差异全没了"—— 而这条我实测踩过一次
      //   （断言报的是"卡片没写出差异"，看起来像排版问题，真因是字段名对不上）。
      const mapCard = (o) => {
        const on = o.id === p.selectedId;
        const detail =
          `${o.map.floors} 层 · 容器 ${o.map.containers} · 撤离点 ${o.extracts.total}` +
          `（条件 ${o.extracts.conditional}）· 敌方 ${o.enemies.total}`;
        // 注意：本文件**只有一个**转义函数 escAttr（项目里 ui/lobby.js 的纪律是
        // "界面里不出现第二个实现"）。地图名与 id 都来自我们自己的地图表，
        // 但拼进 HTML 的东西一律过它 —— 转义的代价是一个函数调用。
        const safeId = escAttr(o.id);
        return `
          <div class="map-card ${on ? 'on' : ''}" data-map="${safeId}">
            <div class="map-name">${escAttr(o.label || o.id)}</div>
            <div class="muted">${escAttr(detail)}</div>
            <div class="muted">${on ? '当前选中 —— 右侧简报就是这张图' : '点击选择这张图'}</div>
            <span class="mini" data-map="${safeId}">${on ? '已选' : '选它'}</span>
          </div>`;
      };
      el.mapList.innerHTML = p.options.map(mapCard).join('');
    },
  };
}
