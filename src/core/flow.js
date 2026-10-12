// M1-7 单局流程状态机 —— M5-1 起扩展为"局外 / 局内"两级流程
//
// 职责：LOBBY → RAID → ENDED → LOBBY 的显式状态迁移，单局计时，结束原因。
// 设计意图：一切"流程走不通"问题都必须能在这里被定位。
//           因此状态迁移全部显式声明，非法迁移直接抛错而不是静默容忍。
//
// ★ M5-1 变更（本文件自 M1 以来第一次改状态集合）：
//   · READY 更名为 **LOBBY**：它不再只是"点击即开始的准备态"，
//     而是**局外大厅**（M5 的仓库/配装/商店/任务将来都挂在它下面）。
//     留旧名会误导人 —— 本项目对死名字的处理是删掉而不是留别名。
//   · 新增 **ENDED → LOBBY**：这是 M5-1 的核心交付「重开浏览器之外，
//     也能闭环」——结算后回大厅，再从大厅进下一局，**全程不刷新页面**。
//     在此之前"再进一局"是整页刷新（M1-TEMP-14 / M2-TEMP-4），
//     那意味着大厅每局都要重建一次，局外系统也就无从谈起。
//   · ENDED → RAID 仍然非法：必须先回大厅。这一条挡住的正是"结算页上直接开新局"
//     这种会让局外状态（将来的任务/仓库）来不及刷新的路径。

export const FLOW = Object.freeze({
  /** 局外：主大厅。3D 世界此时尚未创建（M5-1）。 */
  LOBBY: 'lobby',
  RAID: 'raid',
  ENDED: 'ended',
});

export const END_REASON = Object.freeze({
  EXTRACTED: 'extracted',
  DEAD: 'dead',
  TIMEOUT: 'timeout',
  /**
   * 主动放弃（暂停菜单里的"放弃本局"）。
   * 它是 M4 DoD 五条结束路径里的"主动退出"一条 —— 此前这条路径不存在，
   * 玩家想中途退出只能刷新页面，而刷新会让整局静默消失、连结算都没有。
   * 结算口径与阵亡相同（未撤离 = 只保安全箱），见 inventory.settle。
   */
  ABANDONED: 'abandoned',
});

const LEGAL = {
  [FLOW.LOBBY]: [FLOW.RAID],
  [FLOW.RAID]: [FLOW.ENDED],
  [FLOW.ENDED]: [FLOW.LOBBY],
};

export function createFlow(cfg) {
  let state = FLOW.LOBBY;
  let endReason = null;
  let raidStartAt = 0;
  let raidEndAt = 0;
  const transitions = [];

  function transition(next, nowMs, meta) {
    if (!LEGAL[state].includes(next)) {
      throw new Error(`[flow] 非法状态迁移: ${state} -> ${next}`);
    }
    const prev = state;
    state = next;
    transitions.push({ from: prev, to: next, atMs: nowMs, ...(meta || {}) });
  }

  return {
    get state() {
      return state;
    },
    get endReason() {
      return endReason;
    },
    get transitions() {
      return transitions;
    },

    startRaid(nowMs) {
      transition(FLOW.RAID, nowMs);
      raidStartAt = nowMs;
      raidEndAt = 0;
      endReason = null;
    },

    endRaid(reason, nowMs) {
      if (!Object.values(END_REASON).includes(reason)) {
        throw new Error(`[flow] 未知结束原因: ${reason}`);
      }
      transition(FLOW.ENDED, nowMs, { reason });
      endReason = reason;
      raidEndAt = nowMs;
    },

    /**
     * 结算页 → 返回大厅（M5-1）。
     *
     * 只允许从 ENDED 迁移 —— 从 RAID 直接回大厅会跳过结算，
     * 那等于把一整局的战利品结论丢掉，必须被状态机挡住。
     * `endReason` **保留**：大厅与结算页都可能要显示"上一局是怎么结束的"。
     * 它会在下一次 startRaid 时被清空。
     */
    backToLobby(nowMs) {
      transition(FLOW.LOBBY, nowMs, { after: endReason });
    },

    /** 单局时间信息（毫秒） */
    timing(nowMs) {
      if (state === FLOW.LOBBY) {
        return { elapsedMs: 0, remainingMs: cfg.raid.timeLimitMs, expired: false };
      }
      const end = state === FLOW.ENDED ? raidEndAt : nowMs;
      const elapsedMs = end - raidStartAt;
      const remainingMs = Math.max(0, cfg.raid.timeLimitMs - elapsedMs);
      return { elapsedMs, remainingMs, expired: remainingMs <= 0 };
    },
  };
}
