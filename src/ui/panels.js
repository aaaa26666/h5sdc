// M5 局外五个面板的渲染（仓库 / 配装 / 商店 / 技能 / 任务）
//
// 定位：**只排版，不算数**。每个面板收到的 `view` 都是 core/lobbyView.js 的纯函数产物；
//   本文件里不出现任何参与玩法计算的数字（步长、价格、阈值全部随 view 传进来）。
//   这条纪律有端到端断言守着，与 M5-1 对 ui/lobby.js 的口径一致。
//
// 事件用**委托**绑定一次：面板每次渲染都会重建 DOM，逐个绑监听既有泄漏风险，
//   也会在"渲染后忘了绑"时静默失效（点了没反应，最难查的一类界面缺陷）。

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SORT_LABEL = Object.freeze({
  category: '按类别',
  rarity: '按稀有度',
  value: '按价值',
  name: '按名称',
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
});

/** 把 core 返回的原因串翻成人话（界面不显示机器串）。 */
export function reasonText(reason) {
  if (!reason) return '';
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (reason.startsWith('need-currency:')) return `货币不足（需 ${reason.split(':')[1]}）`;
  if (reason.startsWith('need-level:')) return `需要等级 ${reason.split(':')[1]}`;
  if (reason.startsWith('need-quest:')) return `需要先完成 ${reason.split(':')[1]}`;
  if (reason.startsWith('need-points:')) return `技能点不足（需 ${reason.split(':')[1]}）`;
  if (reason.startsWith('max-active:')) return `进行中的任务已达上限（${reason.split(':')[1]}）`;
  if (reason.startsWith('max-qty:')) return `单次最多买 ${reason.split(':')[1]}`;
  return reason;
}

export function createPanels(handlers = {}) {
  const el = {
    loadout: document.getElementById('tabLoadout'),
    stash: document.getElementById('tabStash'),
    shop: document.getElementById('tabShop'),
    skills: document.getElementById('tabSkills'),
    quests: document.getElementById('tabQuests'),
  };

  // 事件委托（click 与 change 各一次）
  for (const root of Object.values(el)) {
    root.addEventListener('click', (ev) => {
      const node = ev.target.closest('[data-act]');
      if (!node || !root.contains(node)) return;
      const fn = handlers[node.dataset.act];
      if (fn) fn(node.dataset, node);
    });
    root.addEventListener('change', (ev) => {
      const node = ev.target.closest('[data-act-change]');
      if (!node || !root.contains(node)) return;
      const fn = handlers[node.dataset.actChange];
      if (fn) fn(node.dataset, node);
    });
  }

  // -------------------------------------------------------------------------
  // 配装
  // -------------------------------------------------------------------------
  function renderLoadout(v) {
    if (!v) {
      el.loadout.innerHTML = '';
      return;
    }
    const presetLine = `
      <div class="slot-line">
        <span class="k">预设方案（${v.presets.length}/${v.maxPresets}）</span>
        <span>
          ${v.presets
            .map(
              (p) =>
                `<span class="mini ${p.active ? 'on' : ''}" data-act="presetSelect" data-id="${esc(p.id)}">${esc(p.name)}</span>`
            )
            .join(' ')}
          <span class="mini ${v.canAddPreset ? '' : 'dis'}" data-act="presetAdd">＋ 新增</span>
          <span class="mini ${v.presets.length > 1 ? '' : 'dis'}" data-act="presetRemove">删除当前</span>
        </span>
      </div>`;

    const slotLines = v.slots
      .map(
        (s) => `
      <div class="slot-line">
        <span class="k">${esc(s.label)}</span>
        <span>
          <select data-act-change="slotSelect" data-slot="${esc(s.id)}">
            <option value="">（不带）</option>
            ${s.options
              .map(
                (o) =>
                  `<option value="${esc(o.id)}" ${o.id === s.current ? 'selected' : ''}>${esc(o.label)} · ${o.weightKg}kg</option>`
              )
              .join('')}
          </select>
        </span>
      </div>`
      )
      .join('');

    const ammoLines = v.ammo
      .map(
        (a) => `
      <div class="slot-line">
        <span class="k">${esc(a.label)}</span>
        <span>
          <span class="mini ${a.current > 0 ? '' : 'dis'}" data-act="ammoDec" data-cal="${esc(a.caliber)}" data-step="${a.step}">−</span>
          <span class="v">${a.current} 发</span>
          <span class="mini ${a.current + a.step <= a.onHand ? '' : 'dis'}" data-act="ammoInc" data-cal="${esc(a.caliber)}" data-step="${a.step}">＋</span>
          <span class="muted">仓库 ${a.onHand} 发</span>
        </span>
      </div>`
      )
      .join('');

    const consumableLines = v.consumables
      .map(
        (c) => `
      <div class="slot-line">
        <span class="k">${esc(c.label)}</span>
        <span>
          <span class="mini ${c.current > 0 ? '' : 'dis'}" data-act="consDec" data-id="${esc(c.id)}" data-step="${c.step}">−</span>
          <span class="v">${c.current} 个</span>
          <span class="mini ${c.current + c.step <= c.onHand ? '' : 'dis'}" data-act="consInc" data-id="${esc(c.id)}" data-step="${c.step}">＋</span>
          <span class="muted">仓库 ${c.onHand} 个</span>
        </span>
      </div>`
      )
      .join('');

    const m = v.modifiers;
    const owCls = v.band.id === 'normal' ? 'v' : 'warn';
    const owNote = v.band.speedScale < 1
      ? ` · 移速 ×${v.band.speedScale}${v.band.noSprint ? ' · 禁止冲刺' : ''}`
      : '';
    const nextNote = v.nextAtKg !== null ? ` · 距下一档 ${v.toNextKg.toFixed(2)}kg` : '';

    el.loadout.innerHTML = `
      ${presetLine}
      ${slotLines}
      ${v.ammo.length ? `<div class="row"><span class="k">弹药</span><span class="muted">一格 ＝ 一次「＋」</span></div>${ammoLines}` : ''}
      ${consumableLines}
      <div class="slot-line">
        <span class="k">负重</span>
        <span class="${owCls}">${v.weightKg.toFixed(2)} kg · ${esc(v.band.label)}${owNote}${nextNote}</span>
      </div>
      <p class="muted" style="margin-top:10px">
        技能加成（真实作用于局内）：负重上限 ${m.weightLimitKg} kg · 移速 ×${m.moveSpeedScale} ·
        后坐力 ×${m.recoilScale} · 扩散 ×${m.spreadScale} · 搜刮 ×${m.searchSpeedScale} · 医疗 ×${m.healSpeedScale}
      </p>`;
  }

  // -------------------------------------------------------------------------
  // 仓库
  // -------------------------------------------------------------------------
  function renderStash(v) {
    if (!v) {
      el.stash.innerHTML = '';
      return;
    }
    const items = v.entries
      .map(
        (e) => `
      <div class="grid-item ${e.selected ? 'on' : ''}" data-act="stashToggle" data-uid="${e.uid}"
           title="${esc(e.label)} ×${e.count} · 估值 ${e.value} · ${e.weightKg.toFixed(2)}kg"
           style="left: calc(var(--cell) * ${e.x}); top: calc(var(--cell) * ${e.y});
                  width: calc(var(--cell) * ${e.w}); height: calc(var(--cell) * ${e.h});
                  ${e.color ? `border-color:${e.color};` : ''}">
        ${esc(e.label)}${e.count > 1 ? ` <span class="qty">×${e.count}</span>` : ''}
      </div>`
      )
      .join('');

    el.stash.innerHTML = `
      <div class="slot-line">
        <span class="k">整理</span>
        <span>
          ${v.sortModes.map((m) => `<span class="mini" data-act="stashSort" data-mode="${esc(m)}">${SORT_LABEL[m] || m}</span>`).join(' ')}
        </span>
      </div>
      <div class="grid-wrap" style="--cols:${v.w}; --rows:${v.h}">${items}</div>
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
    renderLoadout,
    renderStash,
    renderShop,
    renderSkills,
    renderQuests,
    /** 一次渲染全部面板 */
    renderAll(views) {
      renderLoadout(views.loadout);
      renderStash(views.stash);
      renderShop(views.shop);
      renderSkills(views.skills);
      renderQuests(views.quests);
    },
  };
}
