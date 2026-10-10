// M2-7 AI 管理器：刷新规则 + 分级更新调度 + 寻路预算执行
//
// 关键点：**每帧只调用一次 scheduler.processFrame()**。
// 如果放到每个 AI 的 update 里去调，预算就按 AI 数量被放大了 N 倍，
// 约束 C-1/C-2 会形同虚设 —— 这正是"限流写在错的层级等于没写"的典型。
import { createAi } from './ai.js';
import { mulberry32 } from '../core/rng.js';

export function createAiManager({ cfg, level, scene, scheduler, player }) {
  const rnd = mulberry32(cfg.level.seed + 131);
  const ais = [];
  let kills = 0;

  // ---- 刷新规则：按权重选分级，按距离约束选出生格 ----
  const tierPool = [];
  for (const t of cfg.aiTiers) {
    for (let i = 0; i < t.weight; i++) tierPool.push(t);
  }

  const [px, pz] = cfg.level.playerSpawnCell;
  const minFromPlayer = cfg.aiSpawn.minDistanceFromPlayerCells;
  const minBetween = cfg.aiSpawn.minDistanceBetweenAiCells;
  const candidates = level.free.filter((i) => {
    const cx = i % level.W;
    const cz = Math.floor(i / level.W);
    return Math.hypot(cx - px, cz - pz) >= minFromPlayer;
  });

  const chosen = [];
  let guard = 0;
  while (chosen.length < cfg.aiSpawn.totalCount && guard++ < 8000) {
    const i = candidates[Math.floor(rnd() * candidates.length)];
    const cx = i % level.W;
    const cz = Math.floor(i / level.W);
    let tooClose = false;
    for (const c of chosen) {
      if (Math.hypot(c[0] - cx, c[1] - cz) < minBetween) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    chosen.push([cx, cz]);
  }

  for (let i = 0; i < chosen.length; i++) {
    const tier = tierPool[Math.floor(rnd() * tierPool.length)];
    ais.push(
      createAi({
        cfg,
        level,
        scene,
        spawnCell: chosen[i],
        index: i,
        tier,
        scheduler,
        rngSeed: cfg.level.seed + 977 * (i + 1),
      })
    );
  }

  const stats = {
    peakRanThisFrame: 0,
    totalUpdateRuns: 0,
    byTier: {},
    framesSinceSpawn: 0,
  };

  return {
    ais,
    get kills() {
      return kills;
    },
    aliveCount: () => ais.filter((a) => !a.isDead).length,
    totalCount: ais.length,
    stats,

    /** 玩家开枪后通知附近 AI（听觉）。这是 M1-TEMP-7 重写的一部分 */
    broadcastGunshot(nowMs, x, z) {
      for (const a of ais) a.hearGunshot(nowMs, x, z);
    },

    /**
     * @param ctx { onPlayerHit, reactScale, accuracyScale }
     */
    update(dt, nowMs, ctx) {
      // 开局宽限期：降低反应速度与精度。这是"难度可分级"的一部分，
      // 而不是简单地把命中率一调了事。
      const elapsed = nowMs - ctx.raidStartAt;
      const grace = cfg.aiSpawn.difficultyRamp;
      const inGrace = elapsed < grace.graceMs;
      const effectiveCtx = {
        ...ctx,
        reactScale: inGrace ? grace.reactScaleDuringGrace : 1,
        accuracyScale: inGrace ? grace.accuracyScaleDuringGrace : 1,
      };

      // 先执行一次寻路预算：本帧最多算 maxQueriesPerFrame 条路径、最多 maxMsPerFrame 毫秒
      scheduler.processFrame();

      let ran = 0;
      for (const a of ais) {
        if (a.isDead) continue;
        const r = a.update(dt, nowMs, player, effectiveCtx);
        if (r.ran) {
          ran++;
          stats.totalUpdateRuns++;
          const id = r.tier ? String(r.tier.intervalMs) : 'unknown';
          stats.byTier[id] = (stats.byTier[id] || 0) + 1;
        }
      }
      if (ran > stats.peakRanThisFrame) stats.peakRanThisFrame = ran;
      stats.framesSinceSpawn++;
    },

    /** 供武器命中事件调用：把击杀计入统计 */
    noteKill() {
      kills++;
    },

    /** 最近的可交战 AI（供调试与测试用） */
    nearestAlive(fromX, fromZ) {
      let best = null;
      let bd = Infinity;
      for (const a of ais) {
        if (a.isDead) continue;
        const d = Math.hypot(a.position.x - fromX, a.position.z - fromZ);
        if (d < bd) {
          bd = d;
          best = a;
        }
      }
      return best ? { ai: best, distance: bd } : null;
    },
  };
}
