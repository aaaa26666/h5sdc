// ★ M6-4：进局前的「有东西带不进去」警告页
//
// 为什么需要它（制作人裁定：类别不合法与超出容量**两类都查**）：
//   M6-4 起弹药与消耗品是**网格里的实物**，而战利品撤离后也留在网格里。
//   于是"上一局的战利品还没拖回仓库"会变成一种真实状态 —— 带着它进战区，
//   等于凭空多出一包物资，而玩家在局内既拖不回仓库也看不出问题在哪。
//   这一页把问题**在进入之前**摆出来，并给出两个出口：
//     · 全部放回仓库（一键，改的是档案）
//     · 返回大厅（玩家自己一格一格拖，保留他对布局的安排）
//
// 本文件**不做任何判定**：谁违规、为什么违规，全部由 core/carry.js 的 `carryAudit`
// 算好传进来。这里只做三件事：排版、显示/隐藏、把两个按钮的点击交给调用方。
// 理由串翻成人话复用 ui/panels.js 的 `reasonText` —— 两处同一句话，不要各写一份。

import { reasonText } from './panels.js';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 网格名的中文（文案用；判定不读它）。 */
const GRID_TEXT = Object.freeze({
  backpack: '背包',
  rig: '弹挂',
  safe: '保险箱',
});

const GRID_ORDER = Object.freeze(['backpack', 'rig', 'safe']);

export function createRaidCheck(cfg) {
  const el = {
    screen: document.getElementById('screenRaidCheck'),
    why: document.getElementById('raidCheckWhy'),
    list: document.getElementById('raidCheckList'),
    btnReturn: document.getElementById('btnRaidCheckReturn'),
    btnBack: document.getElementById('btnRaidCheckBack'),
    toast: document.getElementById('raidCheckToast'),
  };

  const handlers = { onReturn: () => {}, onBack: () => {} };
  if (el.btnReturn) el.btnReturn.addEventListener('click', () => handlers.onReturn());
  if (el.btnBack) el.btnBack.addEventListener('click', () => handlers.onBack());

  /**
   * 把违规清单画出来。
   *
   * ★ 刻意**按网格分组**并按 GRID_ORDER 排序：玩家要回去的是"背包里那格"，
   *   混在一起他得自己判断是哪张网格。顺序固定也让端到端能按位置断言。
   *
   * @param {{offenders: Array<{grid:string, itemId:string, count:number, reason:string}>}} audit
   * @returns {number} 列出的条数（0 表示没有违规 —— 调用方不该在这一页上停留）
   */
  function render(audit) {
    const list = (audit && audit.offenders) || [];
    if (!list.length) {
      el.list.innerHTML = '';
      return 0;
    }
    const byGrid = new Map();
    for (const off of list) {
      if (!byGrid.has(off.grid)) byGrid.set(off.grid, []);
      byGrid.get(off.grid).push(off);
    }
    const names = GRID_ORDER.filter((g) => byGrid.has(g)).concat(
      [...byGrid.keys()].filter((g) => !GRID_ORDER.includes(g))
    );
    el.list.innerHTML = names
      .map((g) => {
        const rows = byGrid
          .get(g)
          .map((off) => {
            const def = cfg.itemDefs[off.itemId];
            const label = def ? def.label : off.itemId;
            return `<div class="muted li">· ${esc(label)} ×${esc(off.count)} —— ${esc(reasonText(off.reason))}</div>`;
          })
          .join('');
        return `<div class="li"><b>${esc(GRID_TEXT[g] || g)}</b></div>${rows}`;
      })
      .join('');
    return list.length;
  }

  return {
    el,
    /** 显示 / 隐藏这一页。它与大厅互斥（调用方负责关掉大厅）。 */
    show(on) {
      if (el.screen) el.screen.classList.toggle('on', !!on);
      if (!on) this.toast('');
    },
    /** 这一页自己的提示条（"已放回仓库 N 件" / "仓库放不下"）。 */
    toast(msg, warn) {
      if (!el.toast) return;
      el.toast.className = warn ? 'bad' : 'muted';
      el.toast.textContent = msg || '';
    },
    render,
    /** 注册两个按钮的回调（main.js 才知道"放回仓库"要改哪个档案）。 */
    on(h) {
      if (h.onReturn) handlers.onReturn = h.onReturn;
      if (h.onBack) handlers.onBack = h.onBack;
    },
  };
}
