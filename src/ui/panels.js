// M5 局外面板的渲染（**装备（配装＋仓库）/ 商店 / 技能 / 任务**）
//
// 定位：**只排版，不算数**。每个面板收到的 `view` 都是 core/lobbyView.js 的纯函数产物；
//   本文件里不出现任何参与玩法计算的数字（步长、价格、阈值全部随 view 传进来）。
//   这条纪律有端到端断言守着，与 M5-1 对 ui/lobby.js 的口径一致。
//
// ★ M6-3（docs/18 第 3 批）：配装与仓库**合并成一个面板**（页签 5 → 4）。
//   左半边是人形剪影 + 装备格，右半边是仓库网格；两边的交互是**拖放**。
//   旧的下拉框配装表单（`slotSelect`）已删除，理由见 §五 风险表：
//   留一个"看起来还能用"的死入口，比没有这个入口更糟 —— 玩家会以为自己配上了。
//
// 事件用**委托**绑定一次：面板每次渲染都会重建 DOM，逐个绑监听既有泄漏风险，
//   也会在"渲染后忘了绑"时静默失效（点了没反应，最难查的一类界面缺陷）。

import { createDragLayer } from './dragdrop.js';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SORT_LABEL = Object.freeze({
  category: '按类别',
  rarity: '按稀有度',
  value: '按价值',
  name: '按名称',
});

/** 装备类别的中文名（只用于"这个槽位不收武器"这类**文案**，不参与任何判定）。 */
const KIND_TEXT = Object.freeze({
  weapon: '武器',
  armor: '护具',
  backpack: '背包',
  rig: '弹挂',
});

const REASON_TEXT = Object.freeze({
  'max-level': '已满级',
  'unknown-skill': '未知技能',
  'nothing-to-respec': '没有可洗的点数',
  'max-active': '进行中的任务已满',
  'already-active': '已在进行中',
  'already-claimed': '已领取',
  'already-completed': '已完成',
  'not-completed': '尚未完成',
  'not-active': '未接取',
  'last-preset': '至少要保留一套配装',
  'stash-full': '仓库放不下',
  // ---- ★ M6-3 拖放的落点原因（core/dragDrop.js 的返回值）----
  occupied: '这一格被别的物品占着',
  'out-of-bounds': '会超出仓库边界（转一下，或换个位置）',
  'no-target': '没有落在仓库或装备格上',
  'no-source': '拖动的东西已经不在了',
  'bad-target': '落点不是一格（坐标非法）',
  'unknown-uid': '这件物品已经不在仓库里了',
  'unknown-item': '未知物品',
  'unknown-target': '未知落点',
  'unknown-reason': '落点非法',
  'not-equipment': '这件东西不能装备',
  'no-such-slot': '没有这个装备格',
  'empty-slot': '这个装备格是空的',
  'bad-count': '数量非法',
  'slot-to-slot': '装备格之间不能直接互换（先拖回仓库再拖上来）',
  'wrong-weapon-slot': '武器槽不匹配：主武器与副武器各有各的槽',
  'wrong-cover': '护甲部位不匹配：头盔槽只收头盔',
});

/** 把 core 返回的原因串翻成人话（界面不显示机器串）。 */
export function reasonText(reason) {
  if (!reason) return '';
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (reason.startsWith('slot-rejects:')) {
    const kind = reason.split(':')[1];
    return `这个装备格不收${KIND_TEXT[kind] || kind}`;
  }
  if (reason.startsWith('need-currency:')) return `货币不足（需 ${reason.split(':')[1]}）`;
  if (reason.startsWith('need-level:')) return `需要等级 ${reason.split(':')[1]}`;
  if (reason.startsWith('need-quest:')) return `需要先完成 ${reason.split(':')[1]}`;
  if (reason.startsWith('need-points:')) return `技能点不足（需 ${reason.split(':')[1]}）`;
  if (reason.startsWith('max-active:')) return `进行中的任务已达上限（${reason.split(':')[1]}）`;
  if (reason.startsWith('max-qty:')) return `单次最多买 ${reason.split(':')[1]}`;
  return reason;
}

/** 人形剪影（纯装饰：它不参与任何判定，删掉它装备格照样能拖）。 */
const FIGURE_SVG = `
  <svg class="silhouette" viewBox="0 0 300 340" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="150" cy="34" r="24"></circle>
      <rect x="132" y="60" width="36" height="18" rx="8"></rect>
      <rect x="112" y="74" width="76" height="112" rx="20"></rect>
      <rect x="92" y="80" width="18" height="112" rx="9"></rect>
      <rect x="190" y="80" width="18" height="112" rx="9"></rect>
      <rect x="118" y="180" width="64" height="34" rx="12"></rect>
      <rect x="124" y="216" width="22" height="118" rx="11"></rect>
      <rect x="154" y="216" width="22" height="118" rx="11"></rect>
    </g>
  </svg>`;

export function createPanels(handlers = {}) {
  const el = {
    // ★ M6-3：装备页的**可重绘部分**是 #gearBody（`#tabGear` 里还有简报条，
    //   而简报由 ui/lobby.js 写 #lobbyBody）。分开的理由很具体：
    //   renderGear 用的是 innerHTML 整块替换，如果直接写 #tabGear，
    //   每次 refreshLobby 都会把简报**整块抹掉**（实测过一次：拖放之后简报消失）。
    gear: document.getElementById('gearBody'),
    shop: document.getElementById('tabShop'),
    skills: document.getElementById('tabSkills'),
    quests: document.getElementById('tabQuests'),
  };

  // 事件委托（click 一次）。
  // ★ M6-3：`change` 委托**删掉了** —— 它唯一的用户是下拉框配装表单（slotSelect），
  //   而那个表单已按 docs/18 §五 移除。留着一个没有任何 data-act-change 元素的监听，
  //   就是"看起来还能用"的死入口的同义词。
  for (const root of Object.values(el)) {
    if (!root) continue;
    root.addEventListener('click', (ev) => {
      const node = ev.target.closest('[data-act]');
      if (!node || !root.contains(node)) return;
      const fn = handlers[node.dataset.act];
      if (fn) fn(node.dataset, node);
    });
  }

  // -------------------------------------------------------------------------
  // 装备（配装 ＋ 仓库，M6-3 合并）
  // -------------------------------------------------------------------------
  /** 一个装备格。`data-*` 是拖放层的**唯一**接口（见 sourceOf）。 */
  function slotBox(s) {
    const cap = s.capacity;
    const capText = cap
      ? cap.weightLimitKg !== undefined
        ? `容量 ${cap.w}×${cap.h} · 上限 ${cap.weightLimitKg}kg${cap.source === 'default' ? '（兜底）' : ''}`
        : `容量 ${cap.w}×${cap.h}`
      : '';
    const optText = s.options.length ? `仓库里现成可选：${s.options.map((o) => o.label).join('、')}` : '仓库里没有可选的东西';
    return `
      <div class="equip-slot slot-${esc(s.id)} ${s.current ? 'on' : ''}"
           data-src="slot" data-drop-slot data-slot="${esc(s.id)}"
           data-item="${s.current ? esc(s.current) : ''}" data-label="${esc(s.currentLabel || '')}"
           data-w="${s.currentW || 0}" data-h="${s.currentH || 0}" data-rotated="0" data-count="1"
           title="${esc(`${s.label}：${s.currentLabel || '空'}｜拖一件到这一格来装备｜${optText}`)}">
        <span class="slot-k">${esc(s.label)}</span>
        <span class="slot-v">${s.currentLabel ? esc(s.currentLabel) : '空'}</span>
        <span class="slot-w">${s.currentLabel ? `${s.currentWeightKg.toFixed(1)}kg` : ''}</span>
        ${capText ? `<span class="slot-cap">${esc(capText)}</span>` : ''}
      </div>`;
  }

  function gearLeft(v) {
    const owCls = v.weightBar.overweight ? 'warn' : 'ok';
    const owNote = v.band.speedScale < 1
      ? ` · 移速 ×${v.band.speedScale}${v.band.noSprint ? ' · 禁止冲刺' : ''}`
      : '';
    const nextNote = v.nextAtKg !== null ? ` · 距下一档 ${v.toNextKg.toFixed(2)}kg` : '';

    const presetLine = `
      <div class="preset-line">
        <span class="k">预设（${v.presets.length}/${v.maxPresets}）</span>
        <span>
          ${v.presets
            .map((p) => `<span class="mini ${p.active ? 'on' : ''}" data-act="presetSelect" data-id="${esc(p.id)}">${esc(p.name)}</span>`)
            .join(' ')}
          <span class="mini ${v.canAddPreset ? '' : 'dis'}" data-act="presetAdd">＋</span>
          <span class="mini ${v.presets.length > 1 ? '' : 'dis'}" data-act="presetRemove">删除</span>
        </span>
      </div>`;

    // 弹药与消耗品是**预设计数**（不是旧的槽位下拉），所以保留；
    // 改成紧凑按钮组：两行对齐、每行一个"− 数字 ＋"的闭块，读数与仓库存量并排。
    const stepper = (label, cur, onHand, act, idKey, idVal, step, unit) => `
      <div class="stepper">
        <span class="k">${esc(label)}</span>
        <span class="grp">
          <span class="mini ${cur > 0 ? '' : 'dis'}" data-act="${act}Dec" data-${idKey}="${esc(idVal)}" data-step="${step}">−</span>
          <span class="v num">${cur}${unit}</span>
          <span class="mini ${cur + step <= onHand ? '' : 'dis'}" data-act="${act}Inc" data-${idKey}="${esc(idVal)}" data-step="${step}">＋</span>
        </span>
        <span class="muted">仓库 ${onHand}</span>
      </div>`;

    const ammoSteps = v.ammo
      .map((a) => stepper(a.label, a.current, a.onHand, 'ammo', 'cal', a.caliber, a.step, ' 发'))
      .join('');
    const consSteps = v.consumables
      .map((c) => stepper(c.label, c.current, c.onHand, 'cons', 'id', c.id, c.step, ' 个'))
      .join('');

    const c = v.carry;
    const carryLine = `
      <div class="carry-line">
        <span class="k">携行</span>
        <span class="v">${esc(c.backpack.label)} ${c.backpack.w}×${c.backpack.h}` +
        `${c.rig ? ` ＋ ${esc(c.rig.label)} ${c.rig.w}×${c.rig.h}` : ''}` +
        ` · 自带 ${c.kitSlots} 格 · 剩 ${c.freeSlots} 格装战利品</span>
      </div>`;
    // "装不下"必须在**进战区之前**说清楚：局内再发现少带，退出重配是不可能的。
    const overflowNote = c.overflow.length
      ? `<p class="warn" style="margin-top:6px">
          装不下（**不会**带进战区）：${c.overflow.map((o) => `${esc(o.itemId)} ×${o.count}`).join('、')}
          —— 请换更大的背包/弹挂，或减少携带量
        </p>`
      : '';

    return `
      <div class="gear-figure">
        ${FIGURE_SVG}
        ${v.slots.map((s) => slotBox(s)).join('')}
      </div>
      <div class="weight-line">
        <span class="k">负重</span>
        <span class="${owCls}">${v.weightKg.toFixed(2)} kg · ${esc(v.band.label)}${owNote}${nextNote}</span>
      </div>
      <div class="weightbar" data-band="${esc(v.band.id)}" data-overweight="${v.weightBar.overweight ? 1 : 0}">
        <i style="width:${(v.weightBar.ratio * 100).toFixed(1)}%"></i>
      </div>
      ${carryLine}
      ${overflowNote}
      ${presetLine}
      <div class="steppers">${ammoSteps}${consSteps}</div>
      <p class="muted" style="margin-top:8px">
        左键拖动仓库里的东西：拖到左边装备格＝穿上，拖回右边网格＝放下，拖动中按 R 旋转 90°。
      </p>`;
  }

  function gearRight(v) {
    const items = v.entries
      .map(
        (e) => `
      <div class="grid-item ${e.selected ? 'on' : ''}"
           data-src="stash" data-uid="${e.uid}" data-item="${esc(e.itemId)}" data-label="${esc(e.label)}"
           data-count="${e.count}" data-x="${e.x}" data-y="${e.y}" data-w="${e.w}" data-h="${e.h}"
           data-rotated="${e.rotated ? 1 : 0}"
           title="${esc(e.label)} ×${e.count} · 估值 ${e.value} · ${e.weightKg.toFixed(2)}kg${e.rotated ? ' · 已旋转' : ''}"
           style="left: calc(var(--cell) * ${e.x}); top: calc(var(--cell) * ${e.y});
                  width: calc(var(--cell) * ${e.w}); height: calc(var(--cell) * ${e.h});
                  ${e.color ? `border-color:${e.color};` : ''}">
        ${esc(e.label)}${e.count > 1 ? ` <span class="qty">×${e.count}</span>` : ''}
      </div>`
      )
      .join('');

    return `
      <div class="slot-line">
        <span class="k">整理</span>
        <span>
          ${v.sortModes.map((m) => `<span class="mini" data-act="stashSort" data-mode="${esc(m)}">${SORT_LABEL[m] || m}</span>`).join(' ')}
        </span>
      </div>
      <div class="grid-wrap" data-drop-grid style="--cols:${v.w}; --rows:${v.h}">${items}</div>
      <div class="slot-line">
        <span class="k">${v.summary.items} 件 · ${v.summary.used}/${v.summary.total} 格 · 估值 ${v.summary.value} · ${v.weightKg.toFixed(1)}kg</span>
        <span>
          已选 ${v.selectedCount} 项（估值 ${v.selectedValue}）
          <span class="mini ${v.selectedCount ? '' : 'dis'}" data-act="stashSell">批量出售 +${v.selectedSell}</span>
          <span class="mini ${v.entries.length ? '' : 'dis'}" data-act="stashSelectAll">全选</span>
          <span class="mini ${v.selectedCount ? '' : 'dis'}" data-act="stashClear">清空选择</span>
        </span>
      </div>`;
  }

  function renderGear(views) {
    if (!el.gear) return;
    const lo = views && views.loadout;
    const st = views && views.stash;
    if (!lo || !st) {
      el.gear.innerHTML = '';
      return;
    }
    el.gear.innerHTML = `
      <div class="gear">
        <div class="gear-left">${gearLeft(lo)}</div>
        <div class="gear-right">${gearRight(st)}</div>
      </div>`;
  }

  /**
   * DOM → 拖动源。
   *
   * 为什么走 `data-*` 而不是读文本/反推形状：形状（w/h）与朝向（rotated）都是
   * core 视图给的**真值**，界面只搬运不推导。用 `w !== itemDef.w` 反推朝向
   * 就是把 itemShape 又实现了一遍，而对 1×1 的物品根本推不出朝向。
   */
  function sourceOf(node) {
    if (!node || !node.dataset) return null;
    const d = node.dataset;
    if (d.src === 'stash') {
      return {
        kind: 'stash',
        uid: Number(d.uid),
        itemId: d.item,
        label: d.label,
        count: Number(d.count) || 1,
        // 起拖时要用"抓在物品的哪一格"算落点偏移，所以源自己的格坐标必须带出来。
        // 少了它，落点会算成 NaN，而 core 的 isAreaFree 见到非整数会回答 "occupied" ——
        // 表现为"怎么拖都放不下"，看起来像判定坏了。
        x: Number(d.x),
        y: Number(d.y),
        w: Number(d.w),
        h: Number(d.h),
        rotated: d.rotated === '1',
      };
    }
    if (d.src === 'slot') {
      if (!d.item) return null; // 空格没有东西可拖（但仍是**落点**）
      return {
        kind: 'slot',
        slotId: d.slot,
        itemId: d.item,
        label: d.label,
        count: 1,
        w: Number(d.w),
        h: Number(d.h),
        rotated: false,
      };
    }
    return null;
  }

  const drag = el.gear
    ? createDragLayer({
        root: el.gear,
        // 幽灵元素挂在 #dragLayer（fixed 全屏层）：那里 left/top 就是视口坐标。
        ghostHost: document.getElementById('dragLayer') || document.body,
        sourceOf,
        // 判定与落库都由 main.js 转给 core/dragDrop.js 的**同一个**函数（dryRun 之分）。
        decide: (src, target, rotated) => handlers.dropPreview(src, target, rotated),
        commit: (src, target, rotated) => handlers.dropCommit(src, target, rotated),
        // 没位移的松手 = 点击：仓库的点选（批量出售要用）仍走原路径。
        click: (src) => {
          if (src.kind === 'stash' && handlers.stashToggle) handlers.stashToggle({ uid: String(src.uid) });
        },
        reject: (reason) => {
          if (handlers.dropReject) handlers.dropReject(reason);
        },
      })
    : null;

  // -------------------------------------------------------------------------
  // 商店
  // -------------------------------------------------------------------------
  function renderShop(v) {
    if (!v) {
      el.shop.innerHTML = '';
      return;
    }
    const groups = v.groups
      .map(
        (g) => `
      <div class="row"><span class="k">${esc(g.label)}</span><span class="muted">单价 / 解锁</span></div>
      ${g.rows
        .map(
          (r) => `
        <div class="li-row">
          <span>${esc(r.label)}${r.locked ? ` <span class="muted">（需 ${r.unlockLevel} 级）</span>` : ''}</span>
          <span>
            <span class="v">${r.unitPrice}</span>
            <span class="mini ${!r.locked && r.affordable ? '' : 'dis'}"
                  data-act="shopBuy" data-ref="${esc(r.ref)}" data-step="${r.step}">买 ${r.step}</span>
          </span>
        </div>`
        )
        .join('')}`
      )
      .join('');
    el.shop.innerHTML = `
      <div class="slot-line"><span class="k">货币</span><span class="v">${v.currency}</span></div>
      ${groups}`;
  }

  // -------------------------------------------------------------------------
  // 技能
  // -------------------------------------------------------------------------
  function renderSkills(v) {
    if (!v) {
      el.skills.innerHTML = '';
      return;
    }
    const head = `
      <div class="slot-line">
        <span class="k">等级</span>
        <span class="v">Lv.${v.level}${v.isMax ? '（满级）' : ` · ${v.expInLevel}/${v.expForLevel}`}</span>
      </div>
      <div class="slot-line">
        <span class="k">技能点</span>
        <span class="v">可用 ${v.skillPoints} · 已投 ${v.spentPoints}</span>
      </div>
      <div class="slot-line">
        <span class="k">洗点</span>
        <span>
          <span class="v">${v.respecCost}</span>
          <span class="mini ${v.canRespec ? '' : 'dis'}" data-act="skillsRespec">洗点（全额退还）</span>
        </span>
      </div>`;

    const branches = v.branches
      .map(
        (b) => `
      <div class="row"><span class="k">${esc(b.label)}</span><span class="muted">${b.skills.length} 项</span></div>
      ${b.skills
        .map(
          (s) => `
        <div class="li-row">
          <span>
            ${esc(s.label)} <span class="muted">${s.level}/${s.maxLevel}</span>
            <div class="muted">${esc(s.desc)}</div>
          </span>
          <span>
            ${
              s.nextCost === null
                ? '<span class="muted">已满级</span>'
                : `<span class="mini ${s.canLearn ? '' : 'dis'}" data-act="skillLearn" data-id="${esc(s.id)}">学习（${s.nextCost} 点）</span>`
            }
            ${s.canLearn || s.nextCost === null ? '' : `<span class="muted">${esc(reasonText(s.reason))}</span>`}
          </span>
        </div>`
        )
        .join('')}`
      )
      .join('');

    const m = v.modifiers;
    el.skills.innerHTML = `
      ${head}
      ${branches}
      <p class="muted" style="margin-top:10px">
        当前总加成：负重上限 ${m.weightLimitKg} kg · 移速 ×${m.moveSpeedScale} · 后坐力 ×${m.recoilScale} ·
        扩散 ×${m.spreadScale} · 搜刮 ×${m.searchSpeedScale} · 医疗 ×${m.healSpeedScale} ·
        卖价 +${Math.round(m.sellBonusRatio * 100)}%
      </p>`;
  }

  // -------------------------------------------------------------------------
  // 任务
  // -------------------------------------------------------------------------
  function renderQuests(v) {
    if (!v) {
      el.quests.innerHTML = '';
      return;
    }
    const STATE_LABEL = {
      available: '可接取',
      active: '进行中',
      ready: '可领奖',
      claimed: '已完成',
      locked: '未解锁',
    };
    const rows = v.list
      .map((q) => {
        const objs = q.objectives
          .map(
            (o) =>
              `<div class="muted">· ${esc(o.text)} —— ${o.have}/${o.need}${o.done ? ' ✓' : ''}</div>`
          )
          .join('');
        const rw = [];
        if (q.rewards.currency) rw.push(`${q.rewards.currency} 货币`);
        if (q.rewards.exp) rw.push(`${q.rewards.exp} 经验`);
        for (const it of q.rewards.items) rw.push(`${it.itemId} ×${it.count}`);
        if (q.rewards.unlockSafeTier) rw.push(`解锁安全箱 ${q.rewards.unlockSafeTier}`);
        let action = '';
        if (q.state === 'available') {
          action = `<span class="mini" data-act="questAccept" data-id="${esc(q.id)}">接受</span>`;
        } else if (q.state === 'ready') {
          action = `<span class="mini" data-act="questClaim" data-id="${esc(q.id)}">领奖</span>`;
        } else if (q.state === 'active') {
          action = `<span class="mini" data-act="questAbandon" data-id="${esc(q.id)}">放弃</span>`;
        } else if (q.state === 'locked') {
          // 用 core 给的人话（它带上了前置任务的名字）；reasonText 只作为兜底
          action = `<span class="muted">${esc(q.lockedByLabel || reasonText(q.lockedBy))}</span>`;
        }
        return `
        <div class="li-row">
          <span>
            <b class="v">${esc(q.label)}</b> <span class="muted">${STATE_LABEL[q.state] || q.state}</span>
            <div class="muted">${esc(q.brief)}</div>
            ${objs}
            <div class="muted">奖励：${rw.length ? esc(rw.join(' · ')) : '无'}</div>
          </span>
          <span>${action}</span>
        </div>`;
      })
      .join('');
    el.quests.innerHTML = `
      <div class="slot-line">
        <span class="k">进行中 ${v.activeCount}/${v.maxActive}</span>
        <span class="muted">已完成 ${v.completedCount} · 已领奖 ${v.claimedCount}</span>
      </div>
      ${rows}`;
  }

  return {
    el,
    drag,
    renderGear,
    renderShop,
    renderSkills,
    renderQuests,
    /** 一次渲染全部面板 */
    renderAll(views) {
      renderGear(views);
      renderShop(views.shop);
      renderSkills(views.skills);
      renderQuests(views.quests);
    },
  };
}
