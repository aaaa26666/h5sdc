// 局内 HUD、暂停菜单、设置面板、结算界面。
// M1 只做信息可读性，不做视觉打磨（M1 明确禁止美化）。
//
// ★ M5-1：开始页**搬走了** —— 它变成 src/ui/lobby.js 的主大厅。
//   本文件不再持有 screenStart / btnStart / interruptedNotice。
//   为什么不把大厅也塞在这里：大厅是**局外**系统（M5 约束"禁止把局内逻辑耦合进
//   局外系统，反之亦然"），而本文件是局内 HUD 与局内弹窗。

const $ = (id) => document.getElementById(id);

export function createHud() {
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
    endTitle: $('endTitle'),
    endSubtitle: $('endSubtitle'),
    endBody: $('endBody'),
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

      if (view.useProgress > 0) {
        el.useBar.classList.add('on');
        el.useBarFill.style.width = `${Math.round(view.useProgress * 100)}%`;
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

      // ★ M5 销账 [M4-TEMP-3]：经验与任务进度不再是占位值 0 ——
      //   它们来自 core/settlement.js 的落库摘要，即"这一局真正记到档案上的量"。
      const rows = [
        ['单局用时', fmtTime(result.elapsedMs)],
        ['击杀敌人', `${c.kills} / ${c.aiTotal}`],
        ['开启容器', `${c.containersOpened} / ${c.containersTotal}`],
        ['开火次数', String(c.shotsFired)],
        ['剩余生命', `${Math.ceil(c.health)}`],
        ['经验', s ? `+${s.exp}` : `+${prog.exp ?? 0}`],
        [
          '等级',
          s ? (s.leveledTo ? `升到 ${s.level} 级（+${s.skillPoints} 技能点）` : `${s.level} 级`) : '—',
        ],
        [
          '任务',
          s
            ? `完成 ${s.questsCompleted.length} 个 · 推进 ${s.questsAdvanced.length} 项`
            : `${prog.questsCompleted ?? 0} / ${prog.questsTotal ?? 0}`,
        ],
      ];

      // 收益明细：明确回答"带回什么、失去什么、保险箱保住了什么"
      const pct = Math.round((loot.survivedRatio || 0) * 100);
      const lootRows = [
        ['带出物品', `${loot.keptCount ?? 0} 件`],
        ['带出估值', String(loot.keptValue ?? 0)],
        ['损失物品', `${loot.lostCount ?? 0} 件`],
        ['损失估值', String(loot.lostValue ?? 0)],
        ['保险箱保住', String(loot.safeValue ?? 0)],
        ['物资保住比例', `${pct}%`],
      ];

      // 稀有度分组：只显示有物品的档位
      const rarityHtml = (result.rarityBreakdown || [])
        .filter((r) => r.count > 0)
        .map(
          (r) =>
            // 用内联颜色而不是新增 .chip 样式：颜色本身就是稀有度的语义，
            // 且它来自掉落表（M3-4），不需要再引入一套 CSS。
            `<span style="color:${r.colorHex}">${r.label} ${r.count} 件 / ${r.value}</span>`
        )
        .join(' ');

      const itemLi = (it) =>
        `<li><span style="color:${it.colorHex || 'inherit'}">${it.rarityLabel || ''}</span> ` +
        `${it.label} —— ${it.value}</li>`;

      // 撤离成功时列出带出的；阵亡/超时时列的是保险箱保住的（那些就是全部所得）。
      // 两种情况下 result.items 都是"带出来的"，这里只换标题，避免语义误导。
      const keptList = result.items || [];
      const keptTitle = carried ? '带出的物品：' : '保险箱保住（仅这些被带回）：';
      const keptHtml = keptList.length
        ? `<p class="muted" style="margin-top:14px">${keptTitle}</p><ul class="items">${keptList.map(itemLi).join('')}</ul>`
        : '<p class="muted" style="margin-top:14px">本局未带出任何物品</p>';

      // M4-4：损失明细。只给一个"损失估值"是不够的 ——
      // 玩家要有具体清单，才能判断下一次该不该贪、该先往保险箱里塞什么。
      const lostList = result.lostItems || [];
      const lostHtml = lostList.length
        ? '<p class="muted" style="margin-top:10px">损失的物品：</p><ul class="items">' +
          lostList.map(itemLi).join('') +
          '</ul>'
        : '';

      const itemsHtml = keptHtml + lostHtml;

      // ★ M5：局外落库明细。玩家必须知道"这些东西真的进了仓库"，
      //   以及"仓库已满，以下没能存入"（静默丢弃是最不可接受的一类缺陷）。
      //   label 从本局的结算明细里取；取不到的（弹药/消耗品）回落到 id。
      const labelMap = new Map();
      for (const it of result.items || []) labelMap.set(it.id, it.label);
      for (const it of result.lostItems || []) labelMap.set(it.id, it.label);
      const labelOf = (id) => labelMap.get(id) || id;
      let stashHtml = '';
      if (s) {
        if (s.deposited.length) {
          stashHtml +=
            '<p class="muted" style="margin-top:14px">存入仓库：</p><ul class="items">' +
            s.deposited
              .map(
                (d) =>
                  `<li>${labelOf(d.itemId)} ×${d.count}` +
                  (d.leftover ? ` <span class="bad">（${d.leftover} 未存入）</span>` : '') +
                  '</li>'
              )
              .join('') +
            '</ul>';
        }
        if (s.overflow.length) {
          stashHtml +=
            '<p class="muted bad" style="margin-top:10px">仓库已满，以下物品<b>未能存入</b>：</p><ul class="items">' +
            s.overflow.map((d) => `<li>${labelOf(d.itemId)} ×${d.count}</li>`).join('') +
            '</ul>';
        }
        if (s.questsCompleted.length) {
          stashHtml += `<p class="muted" style="margin-top:10px">任务完成：${s.questsCompleted.join('、')}（回大厅领奖）</p>`;
        }
        if (s.consumed.length) {
          const used = s.consumed.reduce((a, x) => a + x.count, 0);
          stashHtml += `<p class="muted" style="margin-top:10px">消耗 / 损失：${used} 件（估值 ${s.spentValue}）</p>`;
        }
      }

      el.endBody.innerHTML =
        '<div class="row"><span class="k">状态</span><span class="' +
        (carried ? 'ok' : 'bad') +
        '">' +
        (carried ? '物资已回收' : '物资已丢失') +
        '</span></div>' +
        lootRows
          .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`)
          .join('') +
        (rarityHtml ? `<div class="row"><span class="k">稀有度</span><span>${rarityHtml}</span></div>` : '') +
        rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('') +
        itemsHtml +
        stashHtml;
    },
  };
}
