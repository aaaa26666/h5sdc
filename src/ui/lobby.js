// M5 主大厅（局外）
//
// 职责：把三样东西排版出来 ——
//   ① 玩家档案读数（等级 / 经验 / 货币 / 仓库，来自 core/profile.js 的 profileView）
//   ② 战区简报（来自 core/briefing.js）
//   ③ 六个标签页的容器（具体面板在 src/ui/panels.js）
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

/** 标签页顺序（同时决定 DOM id：tabBrief / tabLoadout / …） */
export const TABS = Object.freeze(['brief', 'loadout', 'stash', 'shop', 'skills', 'quests']);

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

export function createLobby() {
  const el = {
    screen: $('screenLobby'),
    body: $('lobbyBody'),
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
  let current = 'brief';

  /** 切换标签页。面板内容由 main.js 渲染（UI 不持有数据）。 */
  function showTab(name) {
    if (!el.bodies[name]) return;
    current = name;
    for (const t of tabEls) t.classList.toggle('on', t.dataset.tab === name);
    for (const [k, node] of Object.entries(el.bodies)) node.classList.toggle('on', k === name);
    onTab(name);
  }
  for (const t of tabEls) t.addEventListener('click', () => showTab(t.dataset.tab));

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
     * 把战区简报画出来。
     * @param {object} brief buildRaidBriefing 的产物（残缺/未定义时直接返回，
     *        不猜默认值 —— 简报缺失属于接线错误，宁可留空也不要显示假的数字）
     */
    render(brief) {
      if (!brief) return;
      const b = brief;

      const extractRows = b.extracts.list
        .map((z) => `<div class="muted li">· 第 ${z.floor} 层 ${z.label} —— ${z.rule}</div>`)
        .join('');

      const ammoText = b.loadout.reserve.length
        ? b.loadout.reserve.map((a) => `${a.label} ×${a.rounds}`).join(' · ')
        : '无';

      const consumableText = b.loadout.consumables.length
        ? b.loadout.consumables.map((c) => `${c.label} ×${c.count}`).join(' · ')
        : '无';

      const armor = b.loadout.armor;
      const armorText = armor ? `${armor.label}（等级 ${armor.class}，耐久 ${armor.durability}）` : '无';

      el.body.innerHTML =
        row('战区', `${b.map.label}（${b.map.floors} 层）`) +
        row('单局时限', fmtDuration(b.raid.timeLimitMs)) +
        row('资源分区', `${b.map.lootZones} 个 · 容器 ${b.map.containers} 个`) +
        row('敌方', `${b.enemies.total} 名 · ${b.enemies.tiers.join(' / ')}`) +
        row(
          '撤离点',
          `共 ${b.extracts.total} 个（常驻 ${b.extracts.always} · 条件 ${b.extracts.conditional}）`
        ) +
        extractRows +
        row('主武器', b.loadout.primary ? `${b.loadout.primary.label}（${b.loadout.primary.caliber}）` : '无') +
        row('副武器', b.loadout.secondary ? `${b.loadout.secondary.label}（${b.loadout.secondary.caliber}）` : '无') +
        row('备弹', ammoText) +
        row('护甲', armorText) +
        row('医疗', consumableText) +
        row('背包', `${b.pack.backpack.w}×${b.pack.backpack.h}（${b.pack.backpack.slots} 格 · ${b.pack.backpack.weightLimitKg} kg）`) +
        row('安全箱', `${b.pack.safe.label}（${b.pack.safe.w}×${b.pack.safe.h}，阵亡时箱内物品保留）`);
    },
  };
}
