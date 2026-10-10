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

  // ---- 刷新规则：按权重选分级，按**地图表的分区配额**选出生格 ----
  const tierPool = [];
  for (const t of cfg.aiTiers) {
    for (let i = 0; i < t.weight; i++) tierPool.push(t);
  }

  const [px, pz] = cfg.level.playerSpawnCell;
  const minFromPlayer = cfg.aiSpawn.minDistanceFromPlayerCells;
  const minBetween = cfg.aiSpawn.minDistanceBetweenAiCells;

  // M3-1：出生点从"全图随机撒"改为**按地图表的分区配额**选。
  //
  // 为什么必须改：M3-2 的设计是"只有交战区有保险箱与钥匙房"，风险侧要对称，
  // 就必须让 AI 也集中在交战区。全图随机撒会让"最危险的地方"变成空话 ——
  // 玩家进厂房发现没人，价值梯度就只剩收益、没有代价。
  //
  // 距离约束仍然生效（离玩家最近 minFromPlayer 格、彼此至少 minBetween 格），
  // 否则会出现"贴在出生点旁刷一堆"或"几个 AI 叠在同一格"。
  // 分区查找。M3-1b-2 ④ 加了层判据：两层地图里不同层可能覆盖同样的 (x,z)，
  // 而 AI 出生格是**单层**的格坐标（没有层号）—— 它们一律落在第 0 层，
  // 所以这里只匹配第 0 层的分区。不加这一条会把二层的分区也匹配进来。
  const zoneOfCell = (cx, cz) =>
    (cfg.map.zones || []).find(
      (zn) =>
        (zn.floor || 0) === 0 &&
        cx >= zn.x &&
        cx < zn.x + zn.w &&
        cz >= zn.z &&
        cz < zn.z + zn.h
    ) || null;
  const freeCellXY = level.spawnable.map((i) => [i % level.W, Math.floor(i / level.W)]);
  const farEnoughFromPlayer = ([cx, cz]) => Math.hypot(cx - px, cz - pz) >= minFromPlayer;

  const chosen = [];
  const pickInZone = (zoneId, want) => {
    // 该分区内、离玩家足够远的空格
    const pool = freeCellXY.filter(
      ([cx, cz]) => (zoneOfCell(cx, cz) || {}).id === zoneId && farEnoughFromPlayer([cx, cz])
    );
    let got = 0;
    let guard = 0;
    while (got < want && guard++ < 4000) {
      const [cx, cz] = pool[Math.floor(rnd() * pool.length)];
      let tooClose = false;
      for (const c of chosen) {
        if (Math.hypot(c[0] - cx, c[1] - cz) < minBetween) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      chosen.push([cx, cz]);
      got++;
    }
    return got;
  };

  // 按配额逐分区放。若某分区条件太苛刻放不满，把差额记下来事后补足，
  // 而不是悄悄少刷 —— 少刷会让"AI 数量"这个可调试的量变成不可信的。
  let shortfall = 0;
  for (const quota of cfg.map.aiSpawns || []) {
    shortfall += quota.count - pickInZone(quota.zone, quota.count);
  }

  // 补足差额：从全图剩余空格里选（仍然遵守距离约束）
  {
    const rest = freeCellXY.filter(
      ([cx, cz]) => farEnoughFromPlayer([cx, cz]) &&
        !chosen.some((c) => Math.hypot(c[0] - cx, c[1] - cz) < minBetween)
    );
    let guard = 0;
    while (shortfall > 0 && rest.length && guard++ < 4000) {
      const i = Math.floor(rnd() * rest.length);
      const [cx, cz] = rest.splice(i, 1)[0];
      chosen.push([cx, cz]);
      shortfall--;
    }
    if (shortfall > 0) {
      console.warn(`[aiManager] 仍有 ${shortfall} 个 AI 未能找到满足距离约束的出生格`);
    }
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

    /**
     * 玩家开枪后通知附近 AI（听觉）。这是 M1-TEMP-7 重写的一部分。
     * `y` 是开枪者脚底高度（M3-1b-2 ③ 追加，可选）：AI 据此知道声音是从楼上还是楼下传来的。
     */
    broadcastGunshot(nowMs, x, z, y) {
      for (const a of ais) a.hearGunshot(nowMs, x, z, y);
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
