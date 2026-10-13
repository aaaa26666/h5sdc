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

  const [px, pz] = cfg.level.playerSpawnCell;
  const minFromPlayer = cfg.aiSpawn.minDistanceFromPlayerCells;
  const minBetween = cfg.aiSpawn.minDistanceBetweenAiCells;

  // ---- M6-2：出生格改为读**分层寻路网格**（`level.nav`，节点 = floor*W*H + cell）----
  //
  // 修 [M3-TEMP-7]（二层开局没有 AI）。旧实现用扁平的 `level.spawnable`，
  // 那是**单层**的自由格表（905 格，只代表第 0 层），因此分区匹配时只好写死 `floor === 0`，
  // 二层永远分不到 AI。M3-1b-2 ② 建好的分层网格本来就有每层的可走性，
  // 只是这里没去用它 —— 属于"下层能力已具备、上层没接上"。
  //
  // 注意网格是 2D 的（多层靠 `floor*W*H + cell` 展开节点），所以"第几层"由节点下标表达，
  // 而**出生时的 y 必须显式设为该层地面标高**：`followGround()` 用
  // `surfaceAt(x, z, feet)` 解析高度，若 y 从 0 起算，二层出生的 AI 会被解析到一层地面、
  // 直接"掉"下去。这一条是本次实现里最容易漏、且漏了会静默出错的地方。
  const CELLS = level.W * level.H;
  const navBlocked = level.nav.blocked;
  const walkableOfFloor = (floor) => {
    const out = [];
    const base = floor * CELLS;
    for (let c = 0; c < CELLS; c++) {
      if (navBlocked[base + c] === 0) out.push([c % level.W, Math.floor(c / level.W)]);
    }
    return out;
  };
  const cellsByFloor = new Map();
  const cellsOf = (floor) => {
    if (!cellsByFloor.has(floor)) cellsByFloor.set(floor, walkableOfFloor(floor));
    return cellsByFloor.get(floor);
  };
  // ★ "离玩家至少 N 格"只在**同一层**成立。
  //   出生格是 2D 的（x,z），而两层图里"玩家正上方的格子"水平距离为 0 ——
  //   旧实现（扁平单层）没有这个问题，加上分层之后它变成了一个**跨层误伤**：
  //   二层正对玩家出生点的分区会被整片排除，配额放不满、差额被全局补位吃掉，
  //   实测表现为"二层配额 6 却只放了 5 个，第 6 个跑到一层去了"。
  //   隔着楼板不算贴脸，所以这里按层判定。
  const PLAYER_FLOOR = cfg.map.playerSpawn?.floor || 0;
  const farEnoughFromPlayer = (cx, cz, floor) =>
    floor !== PLAYER_FLOOR || Math.hypot(cx - px, cz - pz) >= minFromPlayer;

  // 分区查找**按层**（旧实现写死 `floor === 0`，那是 M3-TEMP-7 的直接原因）
  const zoneOfCellAt = (cx, cz, floor) =>
    (cfg.map.zones || []).find(
      (zn) =>
        (zn.floor || 0) === floor &&
        cx >= zn.x &&
        cx < zn.x + zn.w &&
        cz >= zn.z &&
        cz < zn.z + zn.h
    ) || null;

  // ---- 兵种池：全局权重（旧行为）或**分区覆盖**（M6-2 新增）----
  //
  // 为什么需要分区覆盖：旧实现是"全局按 weight 随机抽"，兵种与所在分区无关 ——
  // 于是"交战区更危险"只能体现在容器与撤离点上，AI 侧是对称缺失的。
  // 现在交战区可以加权精英/重装，资源区保持以游荡者为主。
  //
  // ★ Boss **永不进池**：它走 `spawnRules.bossCount` 独立配额。
  //   若某张表的 tiers 里误写了 boss，这里直接跳过而不是悄悄刷出一个 Boss。
  const globalPool = (() => {
    const p = [];
    for (const t of cfg.aiTiers) {
      if (t.id === 'boss') continue;
      for (let i = 0; i < t.weight; i++) p.push(t);
    }
    if (!p.length) throw new Error('[aiManager] 兵种池为空：所有非 Boss 档的 weight 都是 0');
    return p;
  })();
  const poolCache = new Map();
  const poolFor = (weights) => {
    if (!weights) return globalPool;
    const key = JSON.stringify(weights);
    if (!poolCache.has(key)) {
      const p = [];
      for (const [id, w] of Object.entries(weights)) {
        if (id === 'boss') continue;
        const t = cfg.aiTiers.find((x) => x.id === id);
        if (!t) throw new Error(`[aiManager] 分区权重引用了不存在的兵种 ${id}`);
        for (let i = 0; i < w; i++) p.push(t);
      }
      if (!p.length) throw new Error(`[aiManager] 分区权重 ${key} 生成的兵种池为空`);
      poolCache.set(key, p);
    }
    return poolCache.get(key);
  };

  const chosen = [];
  const pickInZone = (zoneId, floor, want) => {
    const pool = cellsOf(floor).filter(
      ([cx, cz]) => (zoneOfCellAt(cx, cz, floor) || {}).id === zoneId && farEnoughFromPlayer(cx, cz, floor)
    );
    let got = 0;
    let guard = 0;
    while (got < want && pool.length && guard++ < 4000) {
      const [cx, cz] = pool[Math.floor(rnd() * pool.length)];
      let tooClose = false;
      for (const c of chosen) {
        // 距"彼此太近"这条只在**同层**成立：两层图上 (x,z) 相同但层不同是两个不同的地方
        if (c[2] === floor && Math.hypot(c[0] - cx, c[1] - cz) < minBetween) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      chosen.push([cx, cz, floor]);
      got++;
    }
    return got;
  };

  // 按配额逐分区放。若某分区条件太苛刻放不满，把差额记下来事后补足，
  // 而不是悄悄少刷 —— 少刷会让"AI 数量"这个可调试的量变成不可信的。
  let shortfall = 0;
  for (const quota of cfg.map.aiSpawns || []) {
    const floor = quota.floor || 0;
    shortfall += quota.count - pickInZone(quota.zone, floor, quota.count);
  }

  // 补足差额：从**各层**剩余空格里选（仍然遵守距离约束）
  {
    const rest = [];
    for (const floor of new Set((cfg.map.aiSpawns || []).map((q) => q.floor || 0))) {
      for (const [cx, cz] of cellsOf(floor)) {
        if (!farEnoughFromPlayer(cx, cz, floor)) continue;
        if (chosen.some((c) => c[2] === floor && Math.hypot(c[0] - cx, c[1] - cz) < minBetween)) continue;
        rest.push([cx, cz, floor]);
      }
    }
    let guard = 0;
    while (shortfall > 0 && rest.length && guard++ < 4000) {
      const i = Math.floor(rnd() * rest.length);
      chosen.push(rest.splice(i, 1)[0]);
      shortfall--;
    }
    if (shortfall > 0) {
      console.warn(`[aiManager] 仍有 ${shortfall} 个 AI 未能找到满足距离约束的出生格`);
    }
  }

  // ---- M6-2：Boss 独立配额 ----
  // 不计入 totalCount，因此"地图 aiSpawns 之和 === totalCount"这条校验原样保留，
  // 只是语义收窄为"普通 AI 总数"。Boss 单独从 bossSpawns 取格。
  const bossCells = [];
  for (const b of cfg.map.bossSpawns || []) {
    const floor = b.floor || 0;
    // ★ 必须把 Boss 的格子从 `chosen` 里**取走**：`pickInZone` 是往 chosen 里推的，
    //   若只读不取，这个格子会同时被算作"普通 AI"和"Boss" —— 实测总数会多出 1 个
    //   （15+1 变成 17，而不是 16）。用 pop 取走最后推入的那一个。
    if (pickInZone(b.zone, floor, 1) > 0) bossCells.push(chosen.pop());
    else console.warn(`[aiManager] Boss 未能在分区 ${b.zone}（第 ${floor} 层）找到出生格`);
  }

  const bossTier = cfg.aiTiers.find((t) => t.id === 'boss');
  const makeAt = (cell, tier, i) =>
    createAi({
      cfg,
      level,
      scene,
      spawnCell: [cell[0], cell[1]],
      spawnFloor: cell[2],
      index: i,
      tier,
      scheduler,
      rngSeed: cfg.level.seed + 977 * (i + 1),
    });

  for (let i = 0; i < chosen.length; i++) {
    const quota = (cfg.map.aiSpawns || []).find(
      (q) => (q.floor || 0) === chosen[i][2] && (zoneOfCellAt(chosen[i][0], chosen[i][1], chosen[i][2]) || {}).id === q.zone
    );
    const tier = poolFor(quota && quota.tiers)[Math.floor(rnd() * poolFor(quota && quota.tiers).length)];
    ais.push(makeAt(chosen[i], tier, i));
  }
  for (let b = 0; b < bossCells.length; b++) {
    ais.push(makeAt(bossCells[b], bossTier, chosen.length + b));
  }

  const stats = {
    peakRanThisFrame: 0,
    totalUpdateRuns: 0,
    byTier: {},
    framesSinceSpawn: 0,
  };

  // ★ M6-2：测试隔离开关（**不是产品功能**，只被 tools/smoke.mjs 调用）。
  //
  // 为什么需要它：AI 从 7 名扩到 16 名之后，冒烟的历史组（M2-2 后坐力/开镜、M2-1 切枪）
  // 会在**连续开火**时被循声聚拢的 AI 打死 —— 实测静止不动时 AI 巡逻 90 秒才接敌，
  // 但枪声（听觉半径 45m）会主动把它们拉过来。那几组断言的是武器机制，
  // **本来就不该依赖"自由开火还能活"** —— 这是一条从未言明的隐含假设，
  // 密度一变就碎了。把它显式化：不测 AI 的组先声明"要一个安静的世界"，
  // 测 AI 的组（M2-6 / 更新分级 / 10 局 DoD）显式打开。
  //
  // ★ 它**不影响任何断言的严格度**：standDown 时 AI 依然存活、依然可被击中掉血，
  //   只是不移动、不开火。所以"射击使 AI 掉血"这类断言照常成立。
  let standDown = false;

  return {
    ais,
    get kills() {
      return kills;
    },
    setStandDown(v) {
      standDown = !!v;
      return standDown;
    },
    get standDown() {
      return standDown;
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
      // 测试隔离：见 setStandDown 的说明。**放在最前面**，连寻路预算都不跑 ——
      // 否则 AI 仍会沿路径移动，"安静"就只是"不开火"而已。
      if (standDown) return;

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

    /**
     * M5-1：局末释放全部 AI 的渲染资源。
     * **必须在摘掉局内子树之前调用** —— AI 死亡时会把自己的 mesh 从场景摘掉，
     * 那些 mesh 已经不在子树里，光靠遍历子树会漏掉它们（泄漏随击杀数增长）。
     */
    dispose() {
      for (const a of ais) a.dispose();
    },
  };
}
