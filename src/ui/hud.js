// 局内 HUD、暂停菜单、设置面板、结算界面。
// M1 只做信息可读性，不做视觉打磨（M1 明确禁止美化）。
//
// ★ M5-1：开始页**搬走了** —— 它变成 src/ui/lobby.js 的主大厅。
//   本文件不再持有 screenStart / btnStart / interruptedNotice。
//   为什么不把大厅也塞在这里：大厅是**局外**系统（M5 约束"禁止把局内逻辑耦合进
//   局外系统，反之亦然"），而本文件是局内 HUD 与局内弹窗。
//
// ★ M6-UI-01：结算页改为**分段式**（对齐《三角洲行动》）：本文件负责第 1/2 段的渲染
//   与"下一步 / 上一步"的切换（纯界面状态），而"返回大厅"仍是流程动作、由 main.js 接线。
//   为什么切换放在这里：段切换不改任何局内/局外状态，只决定画哪一段 ——
//   把它交给 main.js 会让"界面状态"与"游戏流程"混在一起。
import { itemDef } from '../core/items.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {object} cfg 配置（派生视图）。这里只用到两处：
 *   · `cfg.quests.quests` —— 结算页的「任务完成情况」要把任务 id 显示成**任务名**
 *     （核心层只给 id：questsAdvanced 是 {questId, objectiveId, from, to, need}）；
 *   · `cfg.itemDefs`     —— 入库明细的 id → 名称（弹药 / 消耗品在结算明细里只有 id）。
 *   传整份 cfg 而不是两个小表：界面读的就是**同一份真值**，不另建一份 id→名称 的映射。
 */
export function createHud(cfg) {
  /** 任务 id → 任务定义（结算页要把 id 显示成任务名与目标文案） */
  const questById = new Map(
    (((cfg || {}).quests || {}).quests || []).map((q) => [q.id, q])
  );
  /** 暂停菜单上一帧是否显示着（用于只在"刚关闭"时清理子弹窗，见 showPause） */
  let pauseShown = false;

  const el = {
    hud: $('hud'),
    hpText: $('hpText'),
    hpBar: $('hpBar'),
    armorText: $('armorText'),
    armorBar: $('armorBar'),
    weaponText: $('weaponText'),
    ammoText: $('ammoText'),
    reloadText: $('reloadText'),
    consumableText: $('consumableText'),
    killfeed: $('killfeed'),
    dmgDir: $('dmgDir'),
    useBar: $('useBar'),
    useBarFill: $('useBarFill'),
    timeText: $('timeText'),
    aiText: $('aiText'),
    lootText: $('lootText'),
    valueText: $('valueText'),
    bagText: $('bagText'),
    safeText: $('safeText'),
    extractText: $('extractText'),
    prompt: $('prompt'),
    toast: $('toast'),
    hitmark: $('hitmark'),
    damageFlash: $('damageFlash'),
    screenEnd: $('screenEnd'),
    endCard: document.querySelector('#screenEnd .card.end'),
    endTitle: $('endTitle'),
    endSubtitle: $('endSubtitle'),
    endSteps: $('endSteps'),
    endPages: $('endPages'),
    endPage1: $('endPage1'),
    endPage2: $('endPage2'),
    endBasic: $('endBasic'),
    endGain: $('endGain'),
    endQuest: $('endQuest'),
    endItemsTitle: $('endItemsTitle'),
    endItems: $('endItems'),
    endLostTitle: $('endLostTitle'),
    endLost: $('endLost'),
    endStash: $('endStash'),
    endStepHint: $('endStepHint'),
    btnEndNext: $('btnEndNext'),
    btnEndBack: $('btnEndBack'),
    btnRestart: $('btnRestart'),
    screenPause: $('screenPause'),
    btnResume: $('btnResume'),
    btnSettingsFromPause: $('btnSettingsFromPause'),
    btnAbandon: $('btnAbandon'),
    screenAbandon: $('screenAbandon'),
    btnAbandonConfirm: $('btnAbandonConfirm'),
    btnAbandonCancel: $('btnAbandonCancel'),
    minimap: $('minimap'),
    minimapLabel: $('minimapLabel'),
    questText: $('questText'),
    // 注意：设置面板的 DOM（#screenSettings / #settingsBody / #btnSettingsClose）
    // 已归 src/ui/settings.js 管（M5-8 销 M5-TEMP-4）。hud 不再持有它们 ——
    // 一个模块同时管"局内 HUD"与"本机偏好"正是那次拆分要解决的问题。
  };

  let toastTimer = null;
  let hitTimer = null;
  let flashTimer = null;

  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * 切换结算页的分段（M6-UI-01）：1 = 本局结算，2 = 携带物品。返回**实际生效**的段号。
   *
   * 它是**纯界面状态**：不读、也不改任何局内/局外数据，因此可以在这里做，
   * 而"返回大厅"那种会推进流程的动作仍然由 main.js 接线（见 hud.el.btnRestart 的调用方）。
   *
   * 显隐规则写在 CSS（`.card.end[data-step="…"]`），这里只把状态写进 `data-step`
   * 与各段 / 步骤指示的 `.on` —— 界面状态只有一个来源，不逐元素改 style。
   */
  function showResultStep(step) {
    const n = step === 2 ? 2 : 1;
    el.endCard.dataset.step = String(n);
    el.endPage1.classList.toggle('on', n === 1);
    el.endPage2.classList.toggle('on', n === 2);
    for (const node of el.endSteps.querySelectorAll('.end-step')) {
      node.classList.toggle('on', Number(node.dataset.step) === n);
    }
    el.endStepHint.textContent = n === 1 ? '第 1 / 2 步 · 本局结算' : '第 2 / 2 步 · 携带物品';
    // 换段必须回到顶部：两段共用同一个滚动容器 —— 若第 1 段滚到底再切过去，
    // 第 2 段会"从中间开始"，玩家会以为物品清单是残缺的。
    el.endPages.scrollTop = 0;
    return n;
  }

  // 「下一步 / 上一步」是段内导航，属界面自身；「返回大厅」由 main.js 接到流程上。
  el.btnEndNext.addEventListener('click', () => showResultStep(2));
  el.btnEndBack.addEventListener('click', () => showResultStep(1));

  return {
    el,

    showHud(on) {
      el.hud.classList.toggle('on', on);
    },
    showEnd(on) {
      el.screenEnd.classList.toggle('on', on);
    },
    /**
     * 显示/隐藏暂停菜单。
     * 只在"暂停菜单**刚刚被关掉**"这一刻收起放弃确认弹窗 ——
     * 不能每帧都清：主循环在非暂停时每帧都会调 showPause(false)，
     * 那样弹窗刚被打开就会被下一帧关掉（端到端测出过这个现象）。
     */
    showPause(on) {
      el.screenPause.classList.toggle('on', on);
      if (pauseShown && !on && el.screenAbandon) el.screenAbandon.classList.remove('on');
      pauseShown = on;
    },

    /**
     * 放弃本局的**二次确认弹窗**。
     * 这里只管显示；真正的结束由调用方在 btnAbandonConfirm 上接线 ——
     * UI 层不做"结束一局"这种决定。
     */
    showAbandonConfirm(on) {
      if (el.screenAbandon) el.screenAbandon.classList.toggle('on', on);
    },
    /**
     * 设置面板的显示/隐藏已迁到 src/ui/settings.js（M5-8，销 M5-TEMP-4）。
     * hud 不再持有设置面板的 DOM 与交互 —— 它只管局内 HUD 与结算页。
     */

    update(view) {
      el.hpText.textContent = `${Math.ceil(view.health)} / ${view.maxHealth}`;
      el.hpBar.style.width = `${Math.max(0, (view.health / view.maxHealth) * 100)}%`;

      // 护甲：按剩余耐久比例显示，并标出槽位与等级
      const bodyA = view.armor && view.armor.body;
      const headA = view.armor && view.armor.head;
      const fmtArmor = (a) =>
        a && a.maxDurability > 0 ? `${a.id} ${Math.ceil(a.durability)}/${a.maxDurability}` : '无';
      el.armorText.textContent = `胸 ${fmtArmor(bodyA)} · 头 ${fmtArmor(headA)}`;
      const bodyRatio = bodyA && bodyA.maxDurability > 0 ? bodyA.durability / bodyA.maxDurability : 0;
      el.armorBar.style.width = `${Math.max(0, bodyRatio * 100)}%`;

      el.weaponText.textContent = view.weaponLabel || '--';
      el.ammoText.textContent = `${view.magazine} / ${view.reserve}`;
      el.reloadText.innerHTML = view.weaponStatus ? view.weaponStatus : '&nbsp;';
      el.consumableText.textContent = view.consumableText || '3 绷带 · 4 急救包';
      el.timeText.textContent = fmtTime(view.remainingMs);
      // M4-5：阈值不再写死在这里（原为 30000 这个魔法数字），
      // 由 main.js 按配置表算好 timeWarning 传进来，本函数只渲染。
      el.timeText.className = view.timeWarning ? 'v bad' : 'v';
      el.aiText.textContent = String(view.aiAlive);
      el.lootText.textContent = `${view.lootCount} 件`;
      el.valueText.textContent = String(view.lootValue);
      // M3-5/M3-6：背包容量与保险箱保额。这两项是"继续贪还是马上撤"的判断依据，
      // 不显示的话玩家只能凭感觉决策。
      if (el.bagText) el.bagText.textContent = view.bagText || '—';
      if (el.safeText) el.safeText.textContent = view.safeText || '—';
      // M4-6 任务追踪：[M4-TEMP-4] 当前是占位值（任务线属 M5-6，尚无真实数据）
      if (el.questText) {
      // ★ M5-6 销账 [M4-TEMP-4]：任务追踪改为**多行**（制作人裁定：全部列出，
      //   最多 maxActive 条）。内容来自 raidKit.quests —— 即 core/quests.js 的
      //   questTrackerView 产物；HUD 只负责换行排版。
      const lines = view.questLines || [];
      el.questText.innerHTML = lines.length
        ? lines.map((l) => `· ${l.text}`).join('<br />')
        : '任务 —';
    }

      // 读条显隐看"是否正在使用"，而不是"进度 > 0"：
      // 起始帧进度恰为 0，用进度判显隐会让进度条晚一帧出现（[M6-BUG-02] 的伴生现象）。
      const usingNow = view.useActive !== undefined ? view.useActive : view.useProgress > 0;
      if (usingNow) {
        el.useBar.classList.add('on');
        el.useBarFill.style.width = `${Math.round(Math.min(1, Math.max(0, view.useProgress)) * 100)}%`;
      } else {
        el.useBar.classList.remove('on');
      }

      if (view.extractInZone) {
        const pct = Math.round(view.extractProgress * 100);
        el.extractText.className = 'ok';
        el.extractText.textContent = `撤离中… ${pct}%`;
      } else {
        el.extractText.className = 'muted';
        el.extractText.textContent = '未在撤离区内';
      }

      if (view.prompt) {
        el.prompt.classList.add('on');
        el.prompt.innerHTML = view.prompt;
      } else {
        el.prompt.classList.remove('on');
      }
    },

    /**
     * 击杀提示（M2-3）
     * @param label 目标名称
     * @param headshot 是否爆头
     */
    killNotice(label, headshot) {
      const d = document.createElement('div');
      d.textContent = headshot ? `爆头击杀 ${label}` : `击杀 ${label}`;
      el.killfeed.appendChild(d);
      setTimeout(() => d.remove(), 2600);
      while (el.killfeed.childElementCount > 5) el.killfeed.firstElementChild.remove();
    },

    /**
     * 受击方向指示（M2-3）
     * @param angleRad 相对玩家朝向的来向角（0=正前，顺时针为正）
     */
    damageFrom(angleRad) {
      el.dmgDir.classList.add('on');
      el.dmgDir.style.transform = `rotate(${(angleRad * 180) / Math.PI}deg)`;
      clearTimeout(this._dmgTimer);
      this._dmgTimer = setTimeout(() => el.dmgDir.classList.remove('on'), 700);
    },

    hitmark() {
      el.hitmark.classList.add('on');
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => el.hitmark.classList.remove('on'), 90);
    },

    damage() {
      el.damageFlash.classList.add('on');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => el.damageFlash.classList.remove('on'), 140);
    },

    toast(msg, bad) {
      el.toast.textContent = msg;
      el.toast.className = bad ? 'on bad' : 'on';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.toast.className = ''), 1600);
    },

    /**
     * 结算页。
     * @param {object} result core/raidResult.js 的产物（"这一局发生了什么"）
     * @param {object} [summary] core/settlement.js 的落库摘要（"它给玩家带来什么"）。
     *        没有它时经验一栏退回旧的占位口径 —— 但那只是防御：正常路径一定有。
     *
     * ★ M6-UI-01：本函数一次把**两段都画好**，然后回到第 1 段。
     *   为什么不"点下一步时再渲染第 2 段"：结算数据是纯函数产物、本局不会再变，
     *   一次画完就不存在"两段看到不同数据"的可能；切换只决定显示哪一段。
     */
    showResult(result, summary) {
      const titles = {
        extracted: '撤离成功',
        dead: '阵亡',
        timeout: '超时未撤离',
        abandoned: '已放弃本局',
        disconnected: '上局中断',
      };
      const subs = {
        extracted: '战利品已带回仓库',
        dead: '本次携带物资全部损失',
        timeout: '未在时限内撤离，视为失败',
        abandoned: '主动放弃，按未撤离处理（仅保险箱内的物品保留）',
        disconnected: '上局因刷新或关闭页面中断，按未撤离处理（仅保险箱内的物品保留）',
      };
      el.endTitle.textContent = titles[result.reason] || '结算';
      el.endTitle.className =
        result.reason === 'extracted' ? 'ok' : result.reason === 'dead' ? 'bad' : 'warn';
      el.endSubtitle.textContent = subs[result.reason] || '';

      // M4-3：结算数据由 src/core/raidResult.js 产出（纯函数），
      // 本函数只负责把它画出来 —— 不得在这里做任何"算收益"的事。
      const carried = result.carried;
      const loot = result.loot || {};
      const c = result.combat || {};
      const prog = result.progression || {};
      const s = summary || null;
      const row = (k, v, cls) =>
        `<div class="row"><span class="k">${k}</span><span class="${cls || ''}">${v}</span></div>`;

      // ============================ 第 1 段：本局结算 ============================

      // ---- 撤离详情 ----
      // 两列网格：这一段的每行都是"标签 → 短数字"，单列排会白占一倍高度，
      // 把「任务完成情况」挤到需要滚动才看得到的位置（见 index.html 的 .grid2 注释）。
      el.endBasic.innerHTML =
        '<div class="grid2">' +
        row('状态', carried ? '物资已回收' : '物资已丢失', carried ? 'ok' : 'bad') +
        row('单局用时', fmtTime(result.elapsedMs)) +
        row('击杀敌人', `${c.kills} / ${c.aiTotal}`) +
        row('开启容器', `${c.containersOpened} / ${c.containersTotal}`) +
        row('开火次数', String(c.shotsFired)) +
        row('剩余生命', `${Math.ceil(c.health)}`) +
        '</div>';

      // ---- 本局收益：明确回答"带回什么、失去什么、保险箱保住了什么" ----
      const pct = Math.round((loot.survivedRatio || 0) * 100);
      let gainHtml =
        '<div class="grid2">' +
        row('带出物品', `${loot.keptCount ?? 0} 件`) +
        row('带出估值', String(loot.keptValue ?? 0)) +
        row('损失物品', `${loot.lostCount ?? 0} 件`) +
        row('损失估值', String(loot.lostValue ?? 0)) +
        row('保险箱保住', String(loot.safeValue ?? 0)) +
        row('物资保住比例', `${pct}%`) +
        // ★ M5 销账 [M4-TEMP-3]：经验与等级不再是占位值 0 ——
        //   它们来自 core/settlement.js 的落库摘要，即"这一局真正记到档案上的量"。
        row('经验', s ? `+${s.exp}` : `+${prog.exp ?? 0}`) +
        row(
          '等级',
          s ? (s.leveledTo ? `升到 ${s.level} 级（+${s.skillPoints} 技能点）` : `${s.level} 级`) : '—'
        ) +
        '</div>' +
        // 「消耗 / 损失」的值比其他行长得多（"189 件（估值 7330）"），放网格里会挤成一团，
        // 因此它独占一整行 —— 顺带把"收益"与"支出"在视觉上分开。
        (s && s.consumed.length
          ? row(
              '消耗 / 损失',
              `${s.consumed.reduce((a, x) => a + x.count, 0)} 件（估值 ${s.spentValue}）`
            )
          : '');
      // 仓库放不下的东西必须**第一眼就看到**（core/settlement.js 刻意不静默丢弃）。
      // 第 1 段给"有这回事 + 多少件 + 去哪看"，第 2 段的入库明细给逐件清单。
      if (s && s.overflow.length) {
        const n = s.overflow.reduce((a, x) => a + x.count, 0);
        gainHtml +=
          `<p class="muted bad" style="margin-top:8px">⚠ ${n} 件因仓库已满未能存入` +
          '<span class="muted">（逐件见第二段「携带物品 · 入库明细」）</span></p>';
      }
      el.endGain.innerHTML = gainHtml;

      // ---- 任务完成情况 ----
      // 核心层只给 id（questsCompleted 是 id 数组、questsAdvanced 是
      // {questId, objectiveId, from, to, need}），所以这里按 cfg.quests 换成人话：
      // 玩家要看的是"活着回来 ✓""物资回收 · 开 8 个民用箱 3/8"，不是 q2_scavenge。
      el.endQuest.innerHTML = (() => {
        if (!s) return `<p class="muted">完成 ${prog.questsCompleted ?? 0} / ${prog.questsTotal ?? 0}</p>`;
        const parts = [];
        if (s.questsCompleted.length) {
          const names = s.questsCompleted.map((id) => {
            const q = questById.get(id);
            return q ? q.label : id;
          });
          parts.push(
            `<p class="ok" style="margin:2px 0">完成 ${s.questsCompleted.length} 个：` +
              `${names.join('、')}<span class="muted">（回大厅领奖）</span></p>`
          );
        }
        // 已完成的任务从"推进"里剔除：它的目标必然也被记为"推进了一项"，
        // 两条都列出来就是同一件事说两遍（"完成 活着回来" + "推进 活着回来 1/1"）。
        const advanced = s.questsAdvanced.filter((a) => !s.questsCompleted.includes(a.questId));
        if (advanced.length) {
          const lines = advanced
            .map((a) => {
              const q = questById.get(a.questId);
              const obj = q && (q.objectives || []).find((o) => o.id === a.objectiveId);
              return (
                `<div class="li">· ${q ? q.label : a.questId} —— ` +
                `${obj ? obj.text : a.objectiveId} ${a.to}/${a.need}</div>`
              );
            })
            .join('');
          parts.push(`<p class="muted" style="margin:2px 0">推进 ${advanced.length} 项：</p>${lines}`);
        }
        if (!parts.length) parts.push('<p class="muted">本局没有任务进度</p>');
        return parts.join('');
      })();

      // ============================ 第 2 段：携带物品详情 ============================

      // 逐件明细用 .row（左名称右估值），与其余段落同一套排版 —— 不再用 <ul>：
      // 一屏里"名称在左、数字在右"最好扫，而清单长度本就不设上限（第二段可滚动）。
      const itemRow = (it) =>
        `<div class="row"><span class="k">` +
        `<span style="color:${it.colorHex || 'inherit'}">${it.rarityLabel || ''}</span> ` +
        `${it.label}</span><span>${it.value}</span></div>`;
      const listHtml = (list, emptyText) =>
        list.length ? list.map(itemRow).join('') : `<p class="muted">${emptyText}</p>`;

      // 稀有度分组：只显示有物品的档位（口径 = 带出来的那些）
      const rarityHtml = (result.rarityBreakdown || [])
        .filter((r) => r.count > 0)
        .map(
          (r) =>
            // 用内联颜色而不是新增 .chip 样式：颜色本身就是稀有度的语义，
            // 且它来自掉落表（M3-4），不需要再引入一套 CSS。
            `<span style="color:${r.colorHex}">${r.label} ${r.count} 件 / ${r.value}</span>`
        )
        .join('　');

      // 撤离成功时列的是带出的；阵亡/超时时 result.items 就是"保险箱保住的那些"。
      // 只在标题与提示上区分口径，不另算一份数据（避免两处口径分叉）。
      const keptList = result.items || [];
      el.endItemsTitle.textContent = carried
        ? `带出的物品（${keptList.length} 件）`
        : `保险箱保住的物品（${keptList.length} 件）`;
      el.endItems.innerHTML =
        (rarityHtml ? `<div class="muted" style="margin-bottom:6px">${rarityHtml}</div>` : '') +
        (carried ? '' : '<p class="muted">未撤离：只有保险箱里的这些被带回。</p>') +
        listHtml(keptList, '本局未带出任何物品');

      // M4-4：损失明细。只给一个"损失估值"是不够的 ——
      // 玩家要有具体清单，才能判断下一次该不该贪、该先往保险箱里塞什么。
      const lostList = result.lostItems || [];
      el.endLostTitle.textContent = `损失的物品（${lostList.length} 件）`;
      el.endLost.innerHTML = listHtml(lostList, '本局没有损失');

      // ★ M5：局外落库明细。玩家必须知道"这些东西真的进了仓库"，
      //   以及"仓库已满，以下没能存入"（静默丢弃是最不可接受的一类缺陷）。
      //   名称按 cfg.itemDefs 查（弹药 / 消耗品在结算明细里只有 id）。
      const labelOf = (id) => {
        const d = itemDef(id, cfg);
        return d ? d.label : id;
      };
      el.endStash.innerHTML = (() => {
        if (!s) return '<p class="muted">结算数据缺失，无法显示入库明细</p>';
        const parts = [];
        if (s.deposited.length) {
          parts.push('<p class="muted" style="margin:2px 0">存入仓库：</p>');
          parts.push(
            s.deposited
              .map(
                (d) =>
                  `<div class="row"><span class="k">${labelOf(d.itemId)} ×${d.count}</span>` +
                  `<span>${d.leftover ? `<span class="bad">${d.leftover} 件未存入</span>` : '已入库'}</span></div>`
              )
              .join('')
          );
        }
        if (s.overflow.length) {
          parts.push(
            '<p class="muted bad" style="margin:10px 0 2px">仓库已满，以下物品<b>未能存入</b>：</p>'
          );
          parts.push(
            s.overflow
              .map((d) => `<div class="row"><span class="k">${labelOf(d.itemId)}</span><span class="bad">×${d.count}</span></div>`)
              .join('')
          );
        }
        if (!parts.length) parts.push('<p class="muted">本局没有物品入库</p>');
        return parts.join('');
      })();

      // 每次结算都从第 1 段开始：上一局若停在第 2 段，这一局一进来就是物品清单，
      // 玩家会以为"结算页只剩清单了"（撤离结果与收益正是他第一眼要看的）。
      showResultStep(1);
    },

    /**
     * 切换结算页的分段：1 = 本局结算（撤离详情 / 本局收益 / 任务完成情况），
     * 2 = 撤离携带物品的详情。返回**实际生效**的段号。
     *
     * 显隐规则在 CSS（`.card.end[data-step="…"]`）里，这里只负责把状态写进
     * `data-step` 与各段/步骤指示的 `.on` —— 界面状态只有一个来源，不逐元素改 style。
     */
    showResultStep,
    /** 当前结算段（1 / 2）。断言与调试用。 */
    resultStep: () => Number(el.endCard.dataset.step),
  };
}
