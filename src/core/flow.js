// M1-7 单局流程状态机
//
// 职责：READY → RAID → ENDED 的显式状态迁移，单局计时，结束原因。
// 设计意图：M1 的一切"流程走不通"问题都必须能在这里被定位。
//           因此状态迁移全部显式声明，非法迁移直接抛错而不是静默容忍。

export const FLOW = Object.freeze({
  READY: 'ready',
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

// M1 中 ENDED 是终态：M1 的"再进一局"走整页刷新（见 main.js [M1-TEMP-14]），
// 状态机实例随页面重建，因此不需要 ENDED → READY 的迁移。
const LEGAL = {
  [FLOW.READY]: [FLOW.RAID],
  [FLOW.RAID]: [FLOW.ENDED],
  [FLOW.ENDED]: [],
};

export function createFlow(cfg) {
  let state = FLOW.READY;
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

    /** 单局时间信息（毫秒） */
    timing(nowMs) {
      if (state === FLOW.READY) {
        return { elapsedMs: 0, remainingMs: cfg.raid.timeLimitMs, expired: false };
      }
      const end = state === FLOW.ENDED ? raidEndAt : nowMs;
      const elapsedMs = end - raidStartAt;
      const remainingMs = Math.max(0, cfg.raid.timeLimitMs - elapsedMs);
      return { elapsedMs, remainingMs, expired: remainingMs <= 0 };
    },
  };
}
