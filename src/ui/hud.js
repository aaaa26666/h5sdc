// 局内 HUD 与结算界面。
// M1 只做信息可读性，不做视觉打磨（M1 明确禁止美化）。

const $ = (id) => document.getElementById(id);

export function createHud() {
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
    extractText: $('extractText'),
    prompt: $('prompt'),
    toast: $('toast'),
    hitmark: $('hitmark'),
    damageFlash: $('damageFlash'),
    screenStart: $('screenStart'),
    screenEnd: $('screenEnd'),
    endTitle: $('endTitle'),
    endSubtitle: $('endSubtitle'),
    endBody: $('endBody'),
    btnStart: $('btnStart'),
    btnRestart: $('btnRestart'),
    screenPause: $('screenPause'),
    screenSettings: $('screenSettings'),
    btnResume: $('btnResume'),
    btnSettingsFromStart: $('btnSettingsFromStart'),
    btnSettingsFromPause: $('btnSettingsFromPause'),
    btnSettingsClose: $('btnSettingsClose'),
    segs: Array.from(document.querySelectorAll('.seg[data-group]')),
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
    showStart(on) {
      el.screenStart.classList.toggle('on', on);
    },
    showEnd(on) {
      el.screenEnd.classList.toggle('on', on);
    },
    showPause(on) {
      el.screenPause.classList.toggle('on', on);
    },
    showSettings(on) {
      el.screenSettings.classList.toggle('on', on);
    },

    /**
     * 绑定设置页的分段选择器。
     * @param settings 当前设置对象（会被就地修改）
     * @param onChange 任一设置项变更后的回调，用于同步到输入层并落盘
     */
    bindSettings(settings, onChange) {
      for (const seg of el.segs) {
        seg.addEventListener('click', () => {
          const group = seg.dataset.group;
          const value = seg.dataset.value;
          if (settings[group] === value) return;
          settings[group] = value;
          this.syncSettings(settings);
          onChange(settings);
        });
      }
      this.syncSettings(settings);
    },

    /** 把设置对象的状态反映到 UI 高亮上 */
    syncSettings(settings) {
      for (const seg of el.segs) {
        seg.classList.toggle('on', settings[seg.dataset.group] === seg.dataset.value);
      }
    },

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
      el.timeText.className = view.remainingMs < 30000 ? 'v bad' : 'v';
      el.aiText.textContent = String(view.aiAlive);
      el.lootText.textContent = `${view.lootCount} 件`;
      el.valueText.textContent = String(view.lootValue);

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

    showResult(result) {
      const titles = {
        extracted: '撤离成功',
        dead: '阵亡',
        timeout: '超时未撤离',
      };
      const subs = {
        extracted: '战利品已带回仓库',
        dead: '本次携带物资全部损失',
        timeout: '未在时限内撤离，视为失败',
      };
      el.endTitle.textContent = titles[result.reason] || '结算';
      el.endTitle.className =
        result.reason === 'extracted' ? 'ok' : result.reason === 'dead' ? 'bad' : 'warn';
      el.endSubtitle.textContent = subs[result.reason] || '';

      const carried = result.reason === 'extracted';
      const rows = [
        ['单局用时', fmtTime(result.elapsedMs)],
        ['击杀敌人', `${result.kills} / ${result.aiTotal}`],
        ['开启容器', `${result.containersOpened} / ${result.containersTotal}`],
        ['开火次数', String(result.shotsFired)],
        ['剩余生命', `${Math.ceil(result.health)}`],
      ];

      let itemsHtml = '';
      if (result.items.length) {
        itemsHtml =
          '<p class="muted" style="margin-top:14px">本局搜到物品：</p><ul class="items">' +
          result.items.map((it) => `<li>${it.label} —— ${it.value}</li>`).join('') +
          '</ul>';
      } else {
        itemsHtml = '<p class="muted" style="margin-top:14px">本局未搜到任何物品</p>';
      }

      el.endBody.innerHTML =
        '<div class="row"><span class="k">状态</span><span class="' +
        (carried ? 'ok' : 'bad') +
        '">' +
        (carried ? '物资已回收' : '物资已丢失') +
        '</span></div>' +
        '<div class="row"><span class="k">战利品估值</span><span class="' +
        (carried ? 'ok' : 'bad') +
        '">' +
        result.value +
        '</span></div>' +
        rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`).join('') +
        itemsHtml;
    },
  };
}
