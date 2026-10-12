// M5-6 任务线（纯函数）
//
// 数值与目标全部来自 src/config/quests.json；本文件只做"推进 / 判定 / 发奖"的算法，
// 且必须是纯函数：同一份 (profile, facts) 必然得到同一个结果。
// 理由与结算一致（M4 的教训）：局外进度一旦能被重复提交，就必须靠"纯函数 + 幂等键"
// 两道防线，而不是靠"调用方记得只调一次"。
//
// ★ 制作人裁定的三条口径（写在代码里，免得日后被当成 bug 改掉）：
//   ① 任务**手动接取**（玩家在任务面板点"接受"），不自动接。
//   ② 阵亡 / 超时局：击杀类与开箱类**照常推进**（那些事已经发生了），
//      但 `collect` 与 `extract` 类只在成功撤离时推进 —— collect 以实现"带出"为准，
//      否则"把任务物品塞进安全箱再送死"会变成最优解。
//   ③ 表里**没有等级门槛**（前置链仍在）：level 是可选字段，写了才判。

import { stashAdd } from './stash.js';
import { safeTierIndex } from './items.js';
import { applyExp, levelFromExp } from './progression.js';

export const OBJECTIVE_KINDS = Object.freeze(['extract', 'kill', 'open', 'collect', 'value']);

export function questById(id, cfg) {
  return cfg.quests.quests.find((q) => q.id === id) || null;
}

/** 某个任务目标的当前进度（未开始为 0）。 */
export function objectiveProgress(profile, questId, objectiveId) {
  const row = profile.quests.progress[questId];
  return (row && row[objectiveId]) || 0;
}

/** 任务是否所有目标都达标。 */
export function isQuestComplete(profile, quest) {
  const row = profile.quests.progress[quest.id] || {};
  return quest.objectives.every((o) => (row[o.id] || 0) >= o.need);
}

/**
 * 前置条件是否满足。
 *
 * ★ 口径（制作人裁定）：前置任务必须**完成并领取奖励**之后，下一段才可接取。
 *   只"完成"而未领奖**不算** —— 这样"领奖"就是任务链上的必经一步，
 *   而不是可以拖到最后一起点的收尾动作。
 *   推论（已写进界面）：完成未领奖时，下一段显示"需先完成并领取「xxx」的奖励"。
 *
 * 等级门槛是**可选**字段（制作人裁定取消），因此只在写了 level 时才判。
 */
export function prerequisiteMet(profile, quest, cfg) {
  for (const r of quest.requires || []) {
    if (!profile.quests.claimed.includes(r)) return false;
  }
  if (quest.level !== undefined) {
    if (levelFromExp(profile.progression.exp, cfg).level < quest.level) return false;
  }
  return true;
}

/** 机器串（供断言与旧断言口径使用） */
function lockedReason(profile, quest, cfg) {
  for (const r of quest.requires || []) {
    if (!profile.quests.claimed.includes(r)) return `need-quest:${r}`;
  }
  if (quest.level !== undefined && levelFromExp(profile.progression.exp, cfg).level < quest.level) {
    return `need-level:${quest.level}`;
  }
  return null;
}

/**
 * 锁定原因的**人话**（界面直接用，不再自己拼）。
 *
 * 为什么在这里生成而不是在界面里翻译：翻译要用到前置任务的**名称**，
 * 而那需要 cfg（任务表）。界面拿不到表，只拿到 id —— 显示"需要先完成 q1_first_extract"
 * 对玩家毫无意义。
 */
export function lockedReasonText(profile, quest, cfg) {
  for (const r of quest.requires || []) {
    if (!profile.quests.claimed.includes(r)) {
      const prev = questById(r, cfg);
      return `需先完成并领取「${prev ? prev.label : r}」的奖励`;
    }
  }
  if (quest.level !== undefined && levelFromExp(profile.progression.exp, cfg).level < quest.level) {
    return `需要等级 ${quest.level}`;
  }
  return null;
}

/**
 * 任务总览（界面唯一的数据来源）。
 * state: claimed（已领奖）/ ready（达标待领）/ active（进行中）/ available（可接）/ locked（前置未满足）
 */
export function questStates(profile, cfg) {
  const { active, completed, claimed } = profile.quests;
  return cfg.quests.quests.map((q) => {
    const row = profile.quests.progress[q.id] || {};
    const state = claimed.includes(q.id)
      ? 'claimed'
      : completed.includes(q.id)
        ? 'ready'
        : active.includes(q.id)
          ? 'active'
          : prerequisiteMet(profile, q, cfg)
            ? 'available'
            : 'locked';
    return {
      id: q.id,
      label: q.label,
      brief: q.brief,
      state,
      lockedBy: state === 'locked' ? lockedReason(profile, q, cfg) : null,
      /** 锁定原因的人话版（含前置任务名称）—— 界面直接显示它 */
      lockedByLabel: state === 'locked' ? lockedReasonText(profile, q, cfg) : null,
      rewards: {
        currency: q.rewards.currency || 0,
        exp: q.rewards.exp || 0,
        items: (q.rewards.items || []).map((it) => ({ ...it })),
        unlockSafeTier: q.rewards.unlockSafeTier || null,
      },
      objectives: q.objectives.map((o) => ({
        id: o.id,
        kind: o.kind,
        text: o.text,
        need: o.need,
        have: Math.min(row[o.id] || 0, o.need),
        done: (row[o.id] || 0) >= o.need,
      })),
    };
  });
}

/** 接取任务（手动）。 */
export function acceptQuest(profile, questId, cfg) {
  const quest = questById(questId, cfg);
  if (!quest) return { ok: false, reason: 'unknown-quest' };
  const { active, completed, claimed } = profile.quests;
  if (claimed.includes(questId)) return { ok: false, reason: 'already-claimed' };
  if (completed.includes(questId)) return { ok: false, reason: 'already-completed' };
  if (active.includes(questId)) return { ok: false, reason: 'already-active' };
  if (active.length >= cfg.quests.maxActive) {
    return { ok: false, reason: `max-active:${cfg.quests.maxActive}` };
  }
  if (!prerequisiteMet(profile, quest, cfg)) {
    return { ok: false, reason: lockedReason(profile, quest, cfg) || 'locked' };
  }
  return {
    ok: true,
    profile: { ...profile, quests: { ...profile.quests, active: [...active, questId] } },
  };
}

/**
 * 放弃任务：**连进度一起清掉**。
 * 不清的话可以"接了刷一部分进度 → 放弃 → 再接回来"，进度变成可囤积的东西。
 */
export function abandonQuest(profile, questId, cfg) {
  if (!questById(questId, cfg)) return { ok: false, reason: 'unknown-quest' };
  if (!profile.quests.active.includes(questId)) return { ok: false, reason: 'not-active' };
  const progress = { ...profile.quests.progress };
  delete progress[questId];
  return {
    ok: true,
    profile: {
      ...profile,
      quests: {
        ...profile.quests,
        active: profile.quests.active.filter((id) => id !== questId),
        progress,
      },
    },
  };
}

/**
 * 用**一局的结算事实**推进所有进行中的任务。
 *
 * @param {object} facts {
 *   outcome: 'extract'|'death', kills, killsByTier, containersOpened, containersByType,
 *   keptItems: [{itemId, count}], keptValue, extractId, mapId
 * }
 * @returns {{profile:object, advanced:Array, completedNow:string[]}}
 */
export function advanceQuests(profile, facts, cfg) {
  const active = profile.quests.active.slice();
  if (active.length === 0) return { profile, advanced: [], completedNow: [] };
  const isExtract = facts.outcome === 'extract';

  const progress = { ...profile.quests.progress };
  const advanced = [];
  const keptByItem = new Map();
  for (const it of facts.keptItems || []) {
    keptByItem.set(it.itemId, (keptByItem.get(it.itemId) || 0) + it.count);
  }

  for (const qid of active) {
    const quest = questById(qid, cfg);
    if (!quest) continue;
    const row = { ...(progress[qid] || {}) };
    let touched = false;

    for (const o of quest.objectives) {
      const cur = row[o.id] || 0;
      if (cur >= o.need) continue;

      if (o.kind === 'extract') {
        if (!isExtract) continue;
        if (o.extractId && facts.extractId !== o.extractId) continue;
        if (o.mapId && facts.mapId !== o.mapId) continue;
        const nextVal = Math.min(o.need, cur + 1);
        row[o.id] = nextVal;
        touched = true;
        advanced.push({ questId: qid, objectiveId: o.id, from: cur, to: nextVal, need: o.need });
      } else if (o.kind === 'kill') {
        // ★ 阵亡局照常推进（人已经杀了）
        const delta = o.tier ? (facts.killsByTier || {})[o.tier] || 0 : facts.kills || 0;
        if (delta > 0) {
          const nextVal = Math.min(o.need, cur + delta);
          row[o.id] = nextVal;
          touched = true;
          advanced.push({ questId: qid, objectiveId: o.id, from: cur, to: nextVal, need: o.need });
        }
      } else if (o.kind === 'open') {
        // ★ 阵亡局照常推进（箱子已经开了）
        const delta = (facts.containersByType || {})[o.containerType] || 0;
        if (delta > 0) {
          const nextVal = Math.min(o.need, cur + delta);
          row[o.id] = nextVal;
          touched = true;
          advanced.push({ questId: qid, objectiveId: o.id, from: cur, to: nextVal, need: o.need });
        }
      } else if (o.kind === 'collect') {
        // ★ 只在成功撤离时推进：以"带出"为准
        if (!isExtract) continue;
        const delta = keptByItem.get(o.itemId) || 0;
        if (delta > 0) {
          const nextVal = Math.min(o.need, cur + delta);
          row[o.id] = nextVal;
          touched = true;
          advanced.push({ questId: qid, objectiveId: o.id, from: cur, to: nextVal, need: o.need });
        }
      } else if (o.kind === 'value') {
        // 单局带出估值：记录**最好成绩**（不清零，也不超过阈值）。
        // 用"最好成绩"而不是累加：目标语义是"某一局达到 N"，累加会把它变成"多局累计"。
        if (!isExtract) continue;
        const best = Math.min(o.need, facts.keptValue || 0);
        if (best > cur) {
          row[o.id] = best;
          touched = true;
          advanced.push({ questId: qid, objectiveId: o.id, from: cur, to: best, need: o.need });
        }
      }
    }

    if (touched) progress[qid] = row;
  }

  // 达标 → 移入 completed（从 active 取出）
  const nextActive = [];
  const completedNow = [];
  for (const qid of active) {
    const quest = questById(qid, cfg);
    if (!quest) continue;
    const row = progress[qid] || {};
    const done = quest.objectives.every((o) => (row[o.id] || 0) >= o.need);
    if (done) completedNow.push(qid);
    else nextActive.push(qid);
  }
  const completed = completedNow.length
    ? [...profile.quests.completed, ...completedNow.filter((id) => !profile.quests.completed.includes(id))]
    : profile.quests.completed;

  return {
    profile: { ...profile, quests: { ...profile.quests, active: nextActive, progress, completed } },
    advanced,
    completedNow,
  };
}

/**
 * 领奖（幂等：`claimed` 是幂等键，重复调用第二次直接拒绝）。
 *
 * 奖励物品若超出仓库容量，走 `overflow` 通道**交给调用方显示** ——
 * 静默丢弃玩家的任务奖励是最不可接受的一类缺陷。
 */
export function claimQuest(profile, questId, cfg) {
  const quest = questById(questId, cfg);
  if (!quest) return { ok: false, reason: 'unknown-quest' };
  if (profile.quests.claimed.includes(questId)) return { ok: false, reason: 'already-claimed' };
  if (!profile.quests.completed.includes(questId)) return { ok: false, reason: 'not-completed' };

  const rw = quest.rewards || {};
  let next = { ...profile, currency: profile.currency + (rw.currency || 0) };

  const granted = [];
  const overflow = [];
  for (const it of rw.items || []) {
    const add = stashAdd(next.stash, it.itemId, it.count, cfg);
    if (add.leftover > 0) overflow.push({ itemId: it.itemId, count: add.leftover });
    granted.push({ itemId: it.itemId, count: it.count, added: add.added });
    next = { ...next, stash: add.stash };
  }

  let gainedExp = 0;
  let leveledTo = null;
  if (rw.exp > 0) {
    const r = applyExp(next, rw.exp, cfg);
    next = r.profile;
    gainedExp = rw.exp;
    leveledTo = r.leveledTo;
  }

  let unlockedSafeTier = null;
  if (rw.unlockSafeTier) {
    const want = safeTierIndex(rw.unlockSafeTier, cfg);
    const have = safeTierIndex(next.safeTierUnlocked, cfg);
    if (want > have) {
      unlockedSafeTier = rw.unlockSafeTier;
      next = { ...next, safeTierUnlocked: rw.unlockSafeTier };
    }
  }

  next = { ...next, quests: { ...next.quests, claimed: [...next.quests.claimed, questId] } };

  return {
    ok: true,
    profile: next,
    currency: rw.currency || 0,
    exp: gainedExp,
    leveledTo,
    items: granted,
    overflow,
    unlockedSafeTier,
  };
}

/** HUD 的任务追踪视图（制作人裁定：**全部列出**，最多 maxActive 行）。 */
export function questTrackerView(profile, cfg) {
  return profile.quests.active
    .map((id) => {
      const quest = questById(id, cfg);
      if (!quest) return null;
      const row = profile.quests.progress[id] || {};
      return {
        id,
        label: quest.label,
        lines: quest.objectives.map((o) => ({
          text: o.text,
          have: Math.min(row[o.id] || 0, o.need),
          need: o.need,
          done: (row[o.id] || 0) >= o.need,
        })),
      };
    })
    .filter(Boolean)
    .slice(0, cfg.quests.maxActive);
}
