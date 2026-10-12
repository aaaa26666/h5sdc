// M5-7 玩家档案（存档的数据本体 + 版本迁移 + 逐字段校验）
//
// 为什么单独成文件：档案是**唯一的持久化真值**。它的结构、版本与迁移规则如果散在
// platform 层与 UI 层里，就会出现"保存时写 A 结构、读取时按 B 结构解释"。
// 本文件只做三件事，且全部是纯函数（不碰 localStorage —— 那是 platform/profileStore.js）：
//   ① 造一份新档案（createNewProfile）
//   ② 把任意旧版本的原始对象迁移到当前版本（migrateProfile）
//   ③ 把迁移后的对象收敛成合法档案（sanitizeProfile）
//
// ★ 一条贯穿全文件的原则：**存档是外部输入**。
//   玩家可以手改、旧版本写过、别的脚本可能污染过、也可能被截断。
//   因此绝不直接信任它的任何字段 —— 每一项都要过校验；校验不过就取默认值并记一条
//   repair（而不是抛错）。理由：抛错会让玩家一更新版本就进不去游戏，那比少一个字段严重得多。
//
// ★ 版本回退（存档 version > 代码支持的版本）的处理是**拒绝解释**：
//   把原始文本原样隔离，另起一份新档。把未来版本的数据按旧规则解释，比丢弃它更危险 ——
//   那会写出结构错乱的内容覆盖掉玩家真正的存档。

import { stashNormalize, stashSummary } from './stash.js';
import { itemDef } from './items.js';
import { levelFromExp, spentPoints, skillModifiers } from './progression.js';
import { dataKeys } from './lootTable.js';

export const PROFILE_VERSION = 1;

const MAX_REPAIRS = 50;
const MAX_SAMPLES_DEFAULT = 60;

/** 造一份新档案。opts 只用于测试注入（profileId / nowMs），正常运行不传。 */
export function createNewProfile(cfg, nowMs = 0, opts = {}) {
  const starter = cfg.equipment.starterLoadout;
  const loadout = sanitizeLoadoutShape(
    {
      id: starter.id,
      name: starter.name,
      primary: starter.primary,
      secondary: starter.secondary,
      body: starter.body,
      head: starter.head,
      ammo: starter.ammo,
      consumables: starter.consumables,
    },
    cfg
  ).loadout;
  return {
    version: PROFILE_VERSION,
    profileId: opts.profileId || `p-${Math.floor(nowMs).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: nowMs,
    updatedAt: nowMs,
    currency: cfg.economy.starterCurrency,
    progression: { exp: 0, skillPoints: 0, skills: {} },
    stash: [],
    loadouts: [loadout],
    activeLoadoutId: loadout.id,
    // 安全箱档位：新账号从规格表的第一档开始，任务奖励往上解锁（销 M3-TEMP-4 的一半）
    safeTierUnlocked: cfg.lootTable.safeContainer.tiers[0].id,
    quests: { active: [], progress: {}, completed: [], claimed: [] },
    stats: { raids: 0, extracts: 0, deaths: 0, kills: 0, earned: 0, lost: 0, bestValue: 0 },
    economy: { samples: [] },
    lastRaidId: null,
    _repairs: [],
  };
}

// ---------------------------------------------------------------------------
// 版本迁移
//
// 每个迁移函数把 vN 的对象就地升级为 vN+1（返回新对象，不改入参）。
// ★ 迁移函数只补结构，**不做数值判断** —— 数值收敛是 sanitizeProfile 的职责。
//   把两者混在一起，会导致"迁移过的档案"与"新档案"走两条不同的校验路径。
// ---------------------------------------------------------------------------

/**
 * v0 → v1：M5 之前的"史前存档"。
 *
 * 真实的 v0 长什么样（这一条有实测依据，不是想象）：
 *   M4 及以前**没有档案**，玩家的进度只存在于两处：本机偏好设置
 *   （h5extract.settings.v1）与局内快照。因此 v0 → v1 的实际工作是
 *   "把缺失的局外字段补成新账号的值，把已有字段原样带过去"。
 *   它能被实测：端到端往 localStorage 写一个 v0 结构，重进后档案里
 *   应该既有 v0 里的货币/仓库，又有 v1 才有的任务与预设。
 */
export const MIGRATIONS = {
  0: (raw, cfg, nowMs) => {
    const base = createNewProfile(cfg, nowMs);
    const old = raw && typeof raw === 'object' ? raw : {};
    return {
      ...base,
      // v0 里可能存在、且必须原样带过去的字段
      currency: typeof old.currency === 'number' ? old.currency : base.currency,
      stash: Array.isArray(old.stash) ? old.stash : [],
      progression: old.progression && typeof old.progression === 'object' ? old.progression : base.progression,
      stats: old.stats && typeof old.stats === 'object' ? old.stats : base.stats,
      profileId: typeof old.profileId === 'string' ? old.profileId : base.profileId,
      createdAt: Number.isFinite(old.createdAt) ? old.createdAt : base.createdAt,
      _migratedFrom: 0,
    };
  },
};

/**
 * 把任意原始值迁移到当前版本。
 * @returns {{profile:object, fromVersion:number|null, applied:string[],
 *            quarantined:boolean, reason?:string}}
 *          quarantined=true 表示"这份数据不能被当前代码解释"，
 *          调用方（platform/profileStore.js）必须把它**原样**存进隔离键。
 */
export function migrateProfile(raw, cfg, nowMs = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { profile: createNewProfile(cfg, nowMs), fromVersion: null, applied: [], quarantined: false, reason: 'not-an-object' };
  }
  const fromVersion = Number.isInteger(raw.version) ? raw.version : 0;
  const applied = [];

  if (fromVersion > PROFILE_VERSION) {
    // 版本回退：玩家装回了旧版本，或有人手改了 version
    return {
      profile: createNewProfile(cfg, nowMs),
      fromVersion,
      applied,
      quarantined: true,
      reason: `version-ahead:v${fromVersion}>v${PROFILE_VERSION}`,
    };
  }

  let cur = { ...raw };
  let v = fromVersion;
  while (v < PROFILE_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) {
      return {
        profile: createNewProfile(cfg, nowMs),
        fromVersion,
        applied,
        quarantined: true,
        reason: `no-migration-from-v${v}`,
      };
    }
    cur = fn(cur, cfg, nowMs);
    v++;
    cur.version = v;
    applied.push(`v${v - 1}->v${v}`);
  }
  return { profile: cur, fromVersion, applied, quarantined: false };
}

// ---------------------------------------------------------------------------
// 逐字段收敛（sanitize）
// ---------------------------------------------------------------------------

/** 把任意值收敛成有限非负数（取整）。非法时返回 fallback 并置 dirty。 */
function num(v, fallback = 0, { integer = true } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return { value: fallback, dirty: true };
  return { value: integer ? Math.floor(v) : v, dirty: false };
}

/** 配装的**结构**收敛（不查仓库）。createNewProfile 与 sanitizeProfile 共用它。 */
export function sanitizeLoadoutShape(raw, cfg) {
  const repairs = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  const eq = cfg.equipment;
  const wDef = (id) => (id ? cfg.equipmentDefs[id] || null : null);

  const pickWeapon = (id, wantSlot, field) => {
    if (id === null || id === undefined) return null;
    const d = wDef(id);
    if (!d || d.kind !== 'weapon') {
      repairs.push(`loadout.${field}:unknown-weapon`);
      return null;
    }
    if (d.def.slot !== wantSlot) {
      repairs.push(`loadout.${field}:wrong-slot`);
      return null;
    }
    return id;
  };
  const pickArmor = (id, covers, field) => {
    if (id === null || id === undefined) return null;
    const d = wDef(id);
    if (!d || d.kind !== 'armor') {
      repairs.push(`loadout.${field}:unknown-armor`);
      return null;
    }
    if (!d.def.covers.includes(covers)) {
      repairs.push(`loadout.${field}:wrong-cover`);
      return null;
    }
    return id;
  };

  // 弹药与消耗品：★ 制作人裁定（M5-3）**不设数量上限** —— 只校验口径/道具合法与非负整数。
  // 真正约束携带量的是负重三档（core/loadout.js 的 overweightBand）与仓库库存。
  const ammo = {};
  for (const [cal, n] of Object.entries(src.ammo && typeof src.ammo === 'object' ? src.ammo : {})) {
    if (!eq.ammo.carryCalibers.includes(cal)) {
      repairs.push(`loadout.ammo:unknown-caliber:${cal}`);
      continue;
    }
    const { value, dirty } = num(n, 0);
    if (dirty) repairs.push(`loadout.ammo:bad:${cal}`);
    ammo[cal] = value;
  }

  const consumables = {};
  for (const [id, n] of Object.entries(src.consumables && typeof src.consumables === 'object' ? src.consumables : {})) {
    if (!cfg.consumables.some((c) => c.id === id)) {
      repairs.push(`loadout.consumables:unknown:${id}`);
      continue;
    }
    const { value, dirty } = num(n, 0);
    if (dirty) repairs.push(`loadout.consumables:bad:${id}`);
    consumables[id] = value;
  }

  const id = typeof src.id === 'string' && src.id ? src.id : 'default';
  const name = typeof src.name === 'string' && src.name ? src.name.slice(0, 24) : '配装';
  return {
    loadout: {
      id,
      name,
      primary: pickWeapon(src.primary, 1, 'primary'),
      secondary: pickWeapon(src.secondary, 2, 'secondary'),
      body: pickArmor(src.body, 'chest', 'body'),
      head: pickArmor(src.head, 'head', 'head'),
      ammo,
      consumables,
    },
    repairs,
  };
}

/**
 * 收敛成合法档案。
 * @returns {{profile:object, repairs:string[]}} repairs 非空表示"加载时修过东西"，
 *          它会被写进档案的 _repairs 并在 DEV 接口里暴露 —— 修复必须是**可观测**的，
 *          否则"存档坏了但看起来正常"会一直不被发现。
 */
export function sanitizeProfile(raw, cfg, nowMs = 0) {
  const repairs = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw))) repairs.push('not-an-object');

  const base = createNewProfile(cfg, nowMs);
  const out = {
    version: PROFILE_VERSION,
    profileId: typeof src.profileId === 'string' && src.profileId ? src.profileId : base.profileId,
    createdAt: Number.isFinite(src.createdAt) ? src.createdAt : nowMs,
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : nowMs,
    currency: 0,
    progression: { exp: 0, skillPoints: 0, skills: {} },
    stash: [],
    loadouts: [],
    activeLoadoutId: '',
    safeTierUnlocked: cfg.lootTable.safeContainer.tiers[0].id,
    quests: { active: [], progress: {}, completed: [], claimed: [] },
    stats: { ...base.stats },
    economy: { samples: [] },
    lastRaidId: typeof src.lastRaidId === 'string' ? src.lastRaidId : null,
    _repairs: [],
  };

  // ---- 货币 ----
  {
    const { value, dirty } = num(src.currency, cfg.economy.starterCurrency);
    out.currency = value;
    if (dirty && src.currency !== undefined) repairs.push('currency');
  }

  // ---- 成长 ----
  {
    const p = src.progression && typeof src.progression === 'object' ? src.progression : {};
    const expR = num(p.exp, 0);
    if (expR.dirty && p.exp !== undefined) repairs.push('exp');
    // 等级**不存**在档案里：它是 exp 的函数（levelFromExp）。存一份就等于两份真值。
    if (p.level !== undefined) repairs.push('dropped-level-field');
    const skills = {};
    const known = new Map(cfg.progression.skills.map((s) => [s.id, s]));
    for (const [id, lv] of Object.entries(p.skills && typeof p.skills === 'object' ? p.skills : {})) {
      const sk = known.get(id);
      if (!sk) {
        repairs.push(`unknown-skill:${id}`);
        continue;
      }
      const r = num(lv, 0);
      if (r.dirty || r.value === 0) {
        if (r.dirty) repairs.push(`bad-skill-level:${id}`);
        continue;
      }
      skills[id] = Math.min(r.value, sk.maxLevel);
      if (r.value > sk.maxLevel) repairs.push(`skill-over-max:${id}`);
    }
    const spent = spentPoints({ progression: { skills } }, cfg);
    const earned = (levelFromExp(expR.value, cfg).level - 1) * cfg.progression.skillPointsPerLevel;
    const pr = num(p.skillPoints, 0);
    let points = pr.value;
    if (points > earned - spent) {
      points = Math.max(0, earned - spent);
      repairs.push('skill-points-clamped');
    }
    out.progression = { exp: expR.value, skillPoints: points, skills };
  }

  // ---- 仓库 ----
  {
    const norm = stashNormalize(src.stash, cfg);
    out.stash = norm.stash;
    if (norm.dropped.length) repairs.push(`stash-dropped:${norm.dropped.length}`);
    if (norm.overflow.length) repairs.push(`stash-overflow:${norm.overflow.length}`);
  }

  // ---- 配装预设 ----
  {
    const list = Array.isArray(src.loadouts) ? src.loadouts : [];
    const seen = new Set();
    for (const rawLo of list) {
      if (out.loadouts.length >= cfg.equipment.maxPresets) {
        repairs.push('presets-truncated');
        break;
      }
      const r = sanitizeLoadoutShape(rawLo, cfg);
      repairs.push(...r.repairs);
      const lo = r.loadout;
      if (seen.has(lo.id)) {
        repairs.push(`duplicate-preset-id:${lo.id}`);
        continue;
      }
      seen.add(lo.id);
      out.loadouts.push(lo);
    }
    if (out.loadouts.length === 0) {
      out.loadouts = base.loadouts;
      repairs.push('loadouts-missing');
    }
    out.activeLoadoutId = out.loadouts.some((l) => l.id === src.activeLoadoutId)
      ? src.activeLoadoutId
      : out.loadouts[0].id;
    if (src.activeLoadoutId !== undefined && out.activeLoadoutId !== src.activeLoadoutId) {
      repairs.push('active-loadout-reset');
    }
  }

  // ---- 安全箱解锁档位 ----
  {
    const tiers = cfg.lootTable.safeContainer.tiers;
    const id = src.safeTierUnlocked;
    if (typeof id === 'string' && tiers.some((t) => t.id === id)) out.safeTierUnlocked = id;
    else if (id !== undefined) repairs.push('safe-tier');
  }

  // ---- 任务 ----
  {
    const q = src.quests && typeof src.quests === 'object' ? src.quests : {};
    const known = new Map(cfg.quests.quests.map((x) => [x.id, x]));
    const uniq = (arr) => {
      const out2 = [];
      for (const id of Array.isArray(arr) ? arr : []) {
        if (!known.has(id)) {
          repairs.push(`unknown-quest:${id}`);
          continue;
        }
        if (!out2.includes(id)) out2.push(id);
      }
      return out2;
    };
    const active = uniq(q.active).slice(0, cfg.quests.maxActive);
    if (Array.isArray(q.active) && q.active.length > cfg.quests.maxActive) repairs.push('active-quests-truncated');
    const progress = {};
    for (const [qid, objs] of Object.entries(q.progress && typeof q.progress === 'object' ? q.progress : {})) {
      const quest = known.get(qid);
      if (!quest) {
        repairs.push(`unknown-quest-progress:${qid}`);
        continue;
      }
      const row = {};
      for (const [oid, n] of Object.entries(objs && typeof objs === 'object' ? objs : {})) {
        const obj = quest.objectives.find((o) => o.id === oid);
        if (!obj) {
          repairs.push(`unknown-objective:${qid}.${oid}`);
          continue;
        }
        const r = num(n, 0);
        if (r.dirty || r.value === 0) continue;
        row[oid] = Math.min(r.value, obj.need);
        if (r.value > obj.need) repairs.push(`objective-clamped:${qid}.${oid}`);
      }
      if (Object.keys(row).length) progress[qid] = row;
    }
    out.quests = {
      active,
      progress,
      completed: uniq(q.completed),
      claimed: uniq(q.claimed),
    };
  }

  // ---- 统计 ----
  {
    const s = src.stats && typeof src.stats === 'object' ? src.stats : {};
    for (const k of dataKeys(base.stats)) {
      const r = num(s[k], 0);
      if (r.dirty && s[k] !== undefined) repairs.push(`stats.${k}`);
      out.stats[k] = r.value;
    }
  }

  // ---- 经济样本 ----
  {
    const maxSamples = cfg.economy.inflation.maxSamples || MAX_SAMPLES_DEFAULT;
    const rows = Array.isArray(src.economy && src.economy.samples) ? src.economy.samples : [];
    const clean = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        repairs.push('economy-sample-bad');
        continue;
      }
      if (typeof row.raidId !== 'string') {
        repairs.push('economy-sample-bad');
        continue;
      }
      clean.push({
        raidId: row.raidId,
        atMs: Number.isFinite(row.atMs) ? row.atMs : 0,
        outcome: row.outcome === 'extract' ? 'extract' : 'death',
        income: num(row.income, 0).value,
        spent: num(row.spent, 0).value,
      });
    }
    // 环形保留最近 maxSamples 条
    out.economy = { samples: clean.slice(-maxSamples) };
    if (clean.length > maxSamples) repairs.push('economy-samples-truncated');
  }

  out._repairs = repairs.slice(0, MAX_REPAIRS);
  return { profile: out, repairs };
}

/**
 * 文本 → 档案。这是**唯一**的加载入口（platform/profileStore.js 调它）。
 * 迁移在前、收敛在后：先让它变成当前版本的结构，再逐字段校验。
 */
export function parseProfile(text, cfg, nowMs = 0) {
  if (text === null || text === undefined || text === '') {
    // 空档案也要把 repairs 挂到档案上 —— 否则"这一次加载做了什么修复"在界面上
    // 与 __m2.profile() 里都读不到（修复不可观测 = 坏档曾经发生过却没人知道）。
    const fresh = createNewProfile(cfg, nowMs);
    fresh._repairs = ['empty'];
    return {
      profile: fresh,
      repairs: ['empty'],
      mig: { fromVersion: null, applied: [], quarantined: false },
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // 坏 JSON：**不要尝试修复** —— 修出来的半坏数据更危险（与 raidStore 的口径一致）
    return {
      profile: createNewProfile(cfg, nowMs),
      repairs: ['bad-json'],
      mig: { fromVersion: null, applied: [], quarantined: true, reason: 'bad-json' },
    };
  }
  const mig = migrateProfile(raw, cfg, nowMs);
  if (mig.quarantined) {
    return { profile: mig.profile, repairs: [`quarantined:${mig.reason}`], mig };
  }
  const { profile, repairs } = sanitizeProfile(mig.profile, cfg, nowMs);
  if (mig.applied.length) repairs.unshift(...mig.applied.map((a) => `migrated:${a}`));
  profile._repairs = repairs.slice(0, MAX_REPAIRS);
  return { profile, repairs, mig };
}

/**
 * 序列化并做体积控制。
 *
 * 体积超限时的牺牲顺序（保游戏进度，牺牲诊断与统计）：
 *   ① 丢掉 _repairs（诊断信息）
 *   ② 减半 economy.samples（统计信息）
 *   ③ 仍超限 → 返回 null，调用方**保留旧档不动**（宁可少存一次，也不要写半份）
 */
export function serializeProfile(profile, cfg) {
  const maxBytes = cfg.economy.stash.limits.maxBytes;
  const attempt = (p) => JSON.stringify(p);
  let text = attempt(profile);
  if (text.length <= maxBytes) return text;

  const lean = { ...profile, _repairs: [] };
  text = attempt(lean);
  if (text.length <= maxBytes) return text;

  let samples = lean.economy.samples;
  while (samples.length > 0) {
    samples = samples.slice(Math.ceil(samples.length / 2));
    text = attempt({ ...lean, economy: { ...lean.economy, samples } });
    if (text.length <= maxBytes) return text;
  }
  // 连样本都清空了还超限：说明是仓库本身太大。此时不再裁剪内容，交回调用方。
  return text.length <= maxBytes ? text : null;
}

/** 只读概览：界面与简报共用同一份口径（等级 / 货币 / 仓库 / 任务 / 统计）。 */
export function profileView(profile, cfg) {
  const lv = levelFromExp(profile.progression.exp, cfg);
  const stash = stashSummary(profile.stash, cfg);
  const active = profile.quests.active.map((id) => cfg.quests.quests.find((q) => q.id === id)).filter(Boolean);
  return {
    profileId: profile.profileId,
    currency: profile.currency,
    level: lv.level,
    exp: profile.progression.exp,
    expInLevel: lv.expInLevel,
    expForLevel: lv.expForLevel,
    isMaxLevel: lv.isMax,
    skillPoints: profile.progression.skillPoints,
    skills: { ...profile.progression.skills },
    stash,
    presets: profile.loadouts.map((l) => ({ id: l.id, name: l.name })),
    activeLoadoutId: profile.activeLoadoutId,
    safeTierUnlocked: profile.safeTierUnlocked,
    quests: {
      active: active.map((q) => ({ id: q.id, label: q.label, brief: q.brief })),
      completed: profile.quests.completed.slice(),
      claimed: profile.quests.claimed.slice(),
    },
    stats: { ...profile.stats },
    modifiers: skillModifiers(profile, cfg),
    repairs: (profile._repairs || []).slice(),
    version: profile.version,
  };
}

/** 当前生效的配装对象（预设 + 档案里的 activeLoadoutId）。 */
export function activeLoadout(profile) {
  return profile.loadouts.find((l) => l.id === profile.activeLoadoutId) || profile.loadouts[0] || null;
}

/**
 * 幂等键：某一局是否已经写进档案。
 *
 * 为什么需要：结算可能被触发两次（玩家点"查看结算"又点"进入战区"、
 * 或者刷新后补结算与正常结算撞在一起）。档案里记下最后一局的 raidId，
 * 同一个 raidId 再来一次就直接返回原档案 —— 不累加货币、不重复推进任务。
 */
export function alreadyApplied(profile, raidId) {
  if (!raidId) return false;
  if (profile.lastRaidId === raidId) return true;
  return (profile.economy.samples || []).some((s) => s.raidId === raidId);
}

/** 物品定义缺失时的安全检查（存档里可能引用已被删除的物品）。 */
export function knownItem(profile, itemId, cfg) {
  if (!itemDef(itemId, cfg)) return false;
  return true;
}
