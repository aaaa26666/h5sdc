// M2 主装配
//
// 流程与 M1 相同：READY →（点击进入）→ RAID →（撤离/阵亡/超时）→ ENDED
// 但战斗部分整体换成了数据驱动系统：
//   M2-1/2  武器系统（多武器 / 切枪 / 弹药类型 / 后坐力 / 扩散 / 开镜）
//   M2-3    命中反馈（弹孔 / 命中音 / 受击方向 / 击杀提示）
//   M2-4    部位伤害与护甲耐久（玩家与 AI 共用同一套解算）
//   M2-5    医疗与消耗品
//   M2-6/7  AI 状态机 + 寻路（经查询预算限流）+ 难度分级
//   M2-8    音频初版（程序化合成 + 解锁门）
//
// [M2-TEMP-4] "再进一局"仍是整页刷新（沿用 M1-TEMP-14）。
// [M2-TEMP-5] 调试接口改为 **DEV-only**：生产构建里会被完全剔除。
//             这是 M1-TEMP-15 要求的"移除调试接口"的落地方式 ——
//             直接删掉会让全部自动化测试失去驱动手段，而留在生产里又是把内部状态
//             暴露给任意页面脚本。DEV 门控两头都满足，且**可验证**：
//             tools/verify-prod-bundle.mjs 会扫描产物确认接口字符串不存在。
import * as THREE from 'three';
import { config } from './config/index.js';
import { createLevel } from './level/level.js';
import { createInput } from './platform/input.js';
import { loadSettings, saveSettings } from './platform/settings.js';
import { createPlayer } from './gameplay/player.js';
import { createWeaponSystem } from './gameplay/weapon.js';
import { createAiManager } from './gameplay/aiManager.js';
import { createLoot } from './gameplay/loot.js';
import { createExtract } from './gameplay/extract.js';
import { createFlow, FLOW, END_REASON } from './core/flow.js';
import { createHud } from './ui/hud.js';
import { createDecals } from './ui/decals.js';
import { createAudio } from './audio/audio.js';
import { createNavGrid, createAStar, createPathScheduler, makeLos } from './core/navgrid.js';
import { mulberry32 } from './core/rng.js';

const cfg = config;

// ---------------- 渲染器 ----------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1115);
const camera = new THREE.PerspectiveCamera(cfg.player.hipFovDeg || 75, window.innerWidth / window.innerHeight, 0.1, 400);
const HIP_FOV = cfg.player.hipFovDeg || 75;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(30, 60, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 1; sc.far = 200;
sc.updateProjectionMatrix();
scene.add(sun);
scene.add(sun.target);

// ---------------- 世界与系统 ----------------
const hud = createHud();
const settings = loadSettings();
const input = createInput(renderer.domElement, cfg, settings);
const flow = createFlow(cfg);
const audio = createAudio();

const level = createLevel(cfg, scene);
const player = createPlayer(cfg, level);
const decals = createDecals(scene);
const loot = createLoot(cfg, level, scene);
const extract = createExtract(cfg, level, scene);

// 导航：网格来自关卡，查询一律经预算调度器（M0 约束 C-1/C-2）
// 用 pathBlocked 而不是 blocked：高掩体要算作阻挡（否则 AI 会穿过掩体），
// 低掩体（可迈上）不算 —— AI 与玩家都能直接走上去，不该绕路。
const navGrid = createNavGrid(level.W, level.H, level.cell, level.pathBlocked);
const aStar = createAStar(navGrid);
const scheduler = createPathScheduler(aStar, cfg.aiPathBudget);
// 该视线函数供后续 AI 侧扩展使用；当前 AI 用的是 level.hasLineOfSight（含高度判定）
void makeLos;

const aiManager = createAiManager({ cfg, level, scene, scheduler, player });

// 消耗品库存
const consumables = { ...cfg.playerVitals.startConsumables };
const consumableDefs = cfg.consumables;
function consumableDef(id) {
  return consumableDefs.find((c) => c.id === id) || null;
}

// ---------------- 武器 ----------------
const combatStats = {
  shotsFired: 0,
  hits: 0,
  headshots: 0,
  kills: 0,
  damageDealt: 0,
  damageTaken: 0,
  hitsTaken: 0,
  deaths: 0,
  emptyClicks: 0,
};
const weaponRng = mulberry32(cfg.level.seed + 7717);

let footstepsAccum = 0;

const weaponSys = createWeaponSystem({
  cfg,
  level,
  player,
  rng: weaponRng,
  emit(ev) {
    switch (ev.type) {
      case 'fire':
        combatStats.shotsFired++;
        audio.gunshot(ev.weapon.class, 0);
        aiManager.broadcastGunshot(lastNowMs, player.state.pos.x, player.state.pos.z);
        player.cancelUse(); // 开火打断治疗
        break;
      case 'hit':
        combatStats.hits++;
        combatStats.damageDealt += ev.damage;
        if (ev.zone === 'head') {
          combatStats.headshots++;
          audio.headshotHitmark();
        } else {
          audio.hitmark();
        }
        hud.hitmark();
        if (ev.killed) {
          combatStats.kills++;
          aiManager.noteKill();
          audio.kill();
          hud.killNotice(ev.target ? ev.target.tier.label : '敌人', ev.zone === 'head');
        }
        break;
      case 'impact':
        decals.add(level, ev.point, ev.kind);
        audio.impact();
        break;
      case 'empty':
        combatStats.emptyClicks++;
        audio.emptyClick();
        break;
      case 'reloadStart':
        audio.reloadStart();
        break;
      case 'reloadEnd':
        audio.reloadEnd();
        break;
      case 'swap':
        audio.swap();
        break;
      default:
        break;
    }
  },
});

// ---------------- 局内状态 ----------------
let kills = 0;
let lastNowMs = 0;

// 暂停
let pausedTotalMs = 0;
let pauseStartedAt = 0;
let isPaused = false;
let settingsOpen = false;
let lockGraceUntilMs = 0;

function updatePause(nowMs, inRaid) {
  const shouldPause = inRaid && nowMs > lockGraceUntilMs && !input.state.pointerLocked;
  if (shouldPause && !isPaused) {
    isPaused = true;
    pauseStartedAt = nowMs;
  } else if (!shouldPause && isPaused) {
    isPaused = false;
    if (inRaid) pausedTotalMs += nowMs - pauseStartedAt;
  }
  return isPaused;
}

function raidClock(nowMs) {
  const ongoing = isPaused ? nowMs - pauseStartedAt : 0;
  return nowMs - pausedTotalMs - ongoing;
}

function raidView(nowMs) {
  const t = flow.timing(raidClock(nowMs));
  const w = weaponSys.active();
  return {
    health: player.vitals.health,
    maxHealth: player.vitals.maxHealth,
    armor: player.vitals.armor,
    weaponLabel: w.def.label,
    magazine: w.magazine,
    reserve: w.reserve,
    weaponStatus: weaponSys.state_text ? weaponSys.state_text() : weaponStatusText(w),
    remainingMs: t.remainingMs,
    aiAlive: aiManager.aliveCount(),
    lootCount: loot.inventory.length,
    lootValue: loot.totalValue(),
    extractInZone: false,
    extractProgress: 0,
    prompt: '',
    useProgress: player.useProgress(nowMs),
    consumableText: `3 绷带(${consumables.bandage}) · 4 急救包(${consumables.medkit})`,
  };
}

function weaponStatusText(w) {
  if (w.reloading) return w.reloadWasTactical ? '战术换弹中…' : '换弹中…';
  if (w.magazine <= 0) return w.reserve > 0 ? '弹匣已空，按 R 换弹' : '弹药耗尽';
  const spreadPct = Math.round((w.spread / Math.max(0.001, w.def.maxSpreadDeg)) * 100);
  return `扩散 ${spreadPct}%`;
}

// ---------------- 主循环 ----------------
let lastFrameAt = 0;

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = lastFrameAt ? Math.min((nowMs - lastFrameAt) / 1000, 0.05) : 0;
  lastFrameAt = nowMs;
  lastNowMs = nowMs;

  input.beginFrame();

  const inRaid = flow.state === FLOW.RAID;
  const paused = updatePause(nowMs, inRaid);
  const t = raidClock(nowMs);

  if (inRaid && !paused) {
    player.update(dt, input, t);

    // ---- 消耗品使用（3 绷带 / 4 急救包）----
    // 用边沿触发：轻点一次就该生效，电平式会在快速点按时漏掉
    if (input.pressedAction('useConsumable1') && consumables.bandage > 0) {
      if (player.useConsumable(consumableDef('bandage'), t)) {
        consumables.bandage--;
        audio.consume();
      }
    }
    if (input.pressedAction('useConsumable2') && consumables.medkit > 0) {
      if (player.useConsumable(consumableDef('medkit'), t)) {
        consumables.medkit--;
        audio.consume();
      }
    }
    const done = player.tickConsumable(t);
    if (done) hud.toast(`使用 ${done.item.label}，恢复 ${done.healed} 点生命`);

    // ---- 武器 ----
    weaponSys.update(dt, t, input, aiManager.ais);

    // ---- 步伐音 ----
    const spd = Math.hypot(player.state.vel.x, player.state.vel.z);
    if (player.state.onGround && spd > 0.5) {
      footstepsAccum += spd * dt;
      const stride = player.state.sprinting ? 2.6 : player.state.crouching ? 5.0 : 3.4;
      if (footstepsAccum >= stride) {
        footstepsAccum = 0;
        audio.footstep(player.state.sprinting);
      }
    } else {
      footstepsAccum = Math.min(footstepsAccum, 1.0);
    }

    // ---- AI ----
    aiManager.update(dt, t, {
      raidStartAt: raidStartAtMs,
      onPlayerHit(info) {
        const r = player.applyIncomingHit(info);
        combatStats.hitsTaken++;
        combatStats.damageTaken += r.damage;
        hud.damage();
        audio.hurt();
        // 受击方向指示：由来向与玩家朝向算出相对角
        const ang = Math.atan2(info.point.x - player.state.pos.x, info.point.z - player.state.pos.z);
        hud.damageFrom(ang - player.state.yaw - Math.PI);
        if (r.dead) combatStats.deaths++;
      },
    });
    kills = combatStats.kills;

    // ---- 搜刮 ----
    const lootRes = loot.update(dt, player.state.pos, input.interact());
    if (lootRes.justOpened) {
      const names = lootRes.justOpened.items.map((i) => i.label).join('、') || '空容器';
      hud.toast(`搜到：${names}`);
    }

    // ---- 撤离 ----
    const ex = extract.update(dt, player.state.pos);

    // ---- 结束条件 ----
    if (!player.state.alive) endRaid(END_REASON.DEAD, t);
    else if (ex.completed) endRaid(END_REASON.EXTRACTED, t);
    else if (flow.timing(t).expired) endRaid(END_REASON.TIMEOUT, t);

    // ---- HUD ----
    const view = raidView(nowMs);
    view.extractInZone = ex.inZone;
    view.extractProgress = ex.progress;
    if (ex.inZone) {
      view.prompt = `保持在撤离区内 ${Math.ceil((extract.countdownMs * (1 - ex.progress)) / 1000)} 秒`;
    } else if (lootRes.activeContainer) {
      const c = lootRes.activeContainer;
      const pct = Math.round((c.progress / cfg.loot.searchMs) * 100);
      view.prompt = `搜索中… ${pct}%（松开 F 会中断）`;
    } else if (lootRes.nearest) {
      view.prompt = '按住 <b>F</b> 搜索容器';
    }
    hud.update(view);
  } else {
    hud.update(raidView(nowMs));
  }

  hud.showPause(paused && !settingsOpen);

  // 相机：位置含探头偏移，FOV 含开镜过渡，roll 含探头侧倾
  const eye = player.eyePosition();
  camera.position.set(eye.x, eye.y, eye.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = player.state.yaw;
  camera.rotation.x = player.state.pitch;
  camera.rotation.z = player.leanRollRad();

  const targetFov = weaponSys.fovDeg(HIP_FOV);
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }

  renderer.render(scene, camera);
}

// ---------------- 流程控制 ----------------
let raidStartAtMs = 0;

function startRaid(nowMs) {
  flow.startRaid(nowMs);
  raidStartAtMs = nowMs;
  lockGraceUntilMs = nowMs + 600;

  // ---- 音频解锁门（M0-TECH-01 约束 C-8）----
  // 必须在**用户手势回调内**调用，因此放在"进入战区"的点击处理里。
  // 注意这里没有 await 它 —— 见 audio.js 的说明，无手势时 resume() 会永久挂起。
  audio.unlock();

  hud.showStart(false);
  hud.showEnd(false);
  hud.showHud(true);
  hud.toast('进入战区：搜刮物资并撤离');
}

function endRaid(reason, nowMs) {
  if (flow.state !== FLOW.RAID) return;
  flow.endRaid(reason, nowMs);
  const t = flow.timing(nowMs);
  const carried = reason === END_REASON.EXTRACTED;
  hud.showHud(false);
  hud.showEnd(true);
  hud.showResult({
    reason,
    elapsedMs: t.elapsedMs,
    kills: combatStats.kills,
    aiTotal: aiManager.totalCount,
    containersOpened: loot.openedCount(),
    containersTotal: loot.containers.length,
    shotsFired: combatStats.shotsFired,
    health: player.vitals.health,
    items: carried ? loot.inventory : [],
    value: carried ? loot.totalValue() : 0,
    combat: combatStats,
  });
  input.exitLock();
}

hud.el.btnStart.addEventListener('click', () => {
  input.requestLock();
  startRaid(performance.now());
});
hud.el.btnRestart.addEventListener('click', () => location.reload());

hud.bindSettings(settings, (s) => saveSettings(s));
hud.el.btnSettingsFromStart.addEventListener('click', () => {
  settingsOpen = true;
  hud.showStart(false);
  hud.showSettings(true);
});
hud.el.btnSettingsFromPause.addEventListener('click', () => {
  settingsOpen = true;
  hud.showPause(false);
  hud.showSettings(true);
});
hud.el.btnSettingsClose.addEventListener('click', () => {
  settingsOpen = false;
  hud.showSettings(false);
  if (flow.state === FLOW.RAID) hud.showPause(!input.state.pointerLocked);
  else hud.showStart(true);
});
hud.el.btnResume.addEventListener('click', () => {
  hud.showPause(false);
  input.requestLock();
});

renderer.domElement.addEventListener('click', () => {
  if (flow.state === FLOW.RAID && !input.state.pointerLocked && !settingsOpen) input.requestLock();
});

input.onLockedChange((locked) => {
  if (!locked && flow.state === FLOW.RAID && !settingsOpen) {
    hud.toast('指针已解锁 —— 点击画面继续', true);
  }
});

requestAnimationFrame(frame);

// ============================================================================
// [M2-TEMP-5] 自动化测试接口 —— **仅开发构建存在**。
//
// import.meta.env.DEV 由 Vite 在构建时替换为字面量 false，整个 if 块会被 tree-shake
// 掉，因此生产产物里不会有这些字符串。这一点由 tools/verify-prod-bundle.mjs 扫描验证，
// 不靠"我记得它会被摇掉"。
//
// 这样处理是 M1-TEMP-15 要求的落地方式：既把接口从生产里彻底移除，
// 又保留自动化测试的驱动手段（直接删掉会让 60+ 条断言全部失效）。
// ============================================================================
if (import.meta.env.DEV) {
  window.__m2 = {
    snapshot() {
      return {
        flow: flow.state,
        endReason: flow.endReason,
        transitions: flow.transitions.slice(),
        paused: isPaused,
        remainingMs: Math.round(flow.timing(raidClock(performance.now())).remainingMs),
        settings: { ...settings },
        player: {
          x: player.state.pos.x,
          z: player.state.pos.z,
          yaw: player.state.yaw,
          pitch: player.state.pitch,
          health: player.vitals.health,
          maxHealth: player.vitals.maxHealth,
          alive: player.state.alive,
          crouching: player.state.crouching,
          sprinting: player.state.sprinting,
          eyeHeight: +player.state.eyeHeightCurrent.toFixed(3),
          leanRollDeg: +((player.leanRollRad() * 180) / Math.PI).toFixed(2),
          leanTarget: player.state.leanTarget,
          leanCurrent: +player.state.leanCurrent.toFixed(3),
          leanLateral: +player.leanLateralOffset().toFixed(3),
          cellBlocked: level.isBlockedCell(
            Math.floor(player.state.pos.x / level.cell),
            Math.floor(player.state.pos.z / level.cell)
          ),
          armor: {
            head: { id: player.vitals.armor.head.id, durability: +player.vitals.armor.head.durability.toFixed(1) },
            body: { id: player.vitals.armor.body.id, durability: +player.vitals.armor.body.durability.toFixed(1) },
          },
          using: player.isUsing(),
          // ---- 移动手感（M1-TEMP-2/3 的可观测面）----
          // 这些字段存在的意义：手感参数错了肉眼很难发现，但"速度是不是瞬间到顶"
          // "台阶有没有抬上去"都是可断言的事实。
          y: +player.state.pos.y.toFixed(4),
          vy: +player.state.vel.y.toFixed(4),
          speed: +player.horizontalSpeed().toFixed(4),
          onGround: player.state.onGround,
          landingDip: +player.landingDip().toFixed(4),
          landings: player.landingState.landings,
          lastImpactSpeed: +player.landingState.lastImpactSpeed.toFixed(3),
          stepUps: player.state.stepUps,
          groundY: +level.groundHeightAt(player.state.pos.x, player.state.pos.z).toFixed(4),
        },
        weapon: (() => {
          const w = weaponSys.active();
          return {
            id: w.def.id,
            label: w.def.label,
            magazine: w.magazine,
            reserve: w.reserve,
            reloading: w.reloading,
            spread: +w.spread.toFixed(3),
            adsT: +weaponSys.adsT().toFixed(3),
            fov: +camera.fov.toFixed(2),
            slots: weaponSys.states.map((s) => s.id),
          };
        })(),
        ai: aiManager.ais.map((a) => ({
          id: a.id,
          tier: a.tier.id,
          alive: !a.isDead,
          health: a.vitals.health,
          state: a.state.state,
          x: a.position.x,
          z: a.position.z,
          pathLen: a.state.path.length,
          updates: a.state.updates,
          updateIntervalMs: a.updateTier ? a.updateTier.intervalMs : null,
        })),
        aiAlive: aiManager.aliveCount(),
        kills: combatStats.kills,
        combat: { ...combatStats },
        loot: {
          opened: loot.openedCount(),
          total: loot.containers.length,
          inventory: loot.inventory.length,
          value: loot.totalValue(),
        },
        consumables: { ...consumables },
        extract: extract.zones.map((z) => ({ x: z.x, z: z.z, r: z.radius, progress: z.progress })),
        scheduler: {
          processedLastFrame: scheduler.stats.processedThisFrame,
          peakQueriesPerFrame: scheduler.stats.peakQueriesPerFrame,
          peakFrameMs: +scheduler.stats.peakFrameMs.toFixed(3),
          totalProcessed: scheduler.stats.totalProcessed,
          pending: scheduler.pendingCount(),
        },
        audio: { unlocked: audio.isUnlocked(), ...audio.stats },
        decals: decals.placedTotal,
        level: { W: level.W, cell: level.cell, free: level.free.length, walls: level.wallCount,
                 cover: level.coverList.length, stepHeight: level.stepHeight },
      };
    },

    teleport(x, z) {
      player.state.pos.x = x;
      player.state.pos.z = z;
      player.state.pos.y = 0;
      player.state.vel.x = 0;
      player.state.vel.z = 0;
      player.state.vel.y = 0;
      // 传 stepHeight：低掩体不该把人挡在外面，传 0 会把玩家推离掩体格
      level.resolveCircle(player.state.pos, cfg.player.radius, 0, cfg.player.stepHeight);
      // 若落点正好在掩体顶上，直接站上去（否则会先"陷进去"再由台阶吸附弹出）
      player.state.pos.y = level.groundHeightAt(player.state.pos.x, player.state.pos.z);
      player.state.onGround = true;
    },
    aimAt(x, y, z) {
      const p = player.state;
      const ex = p.pos.x;
      const ey = p.pos.y + p.eyeHeightCurrent;
      const ez = p.pos.z;
      p.yaw = Math.atan2(-(x - ex), -(z - ez));
      p.pitch = Math.atan2(y - ey, Math.hypot(x - ex, z - ez));
    },
    /** 传送到对某个存活 AI 确实有视线的位置（避免墙挡下全部子弹造成的假失败） */
    teleportNearAi(aiIndex = 0, dist = 4) {
      const alive = aiManager.ais.filter((a) => !a.isDead);
      if (!alive.length) return null;
      const a = alive[Math.min(aiIndex, alive.length - 1)];
      const targetY = a.position.y + cfg.hitZones.chest.centerY;
      for (let k = 0; k < 32; k++) {
        const ang = (k / 32) * Math.PI * 2;
        const x = a.position.x + Math.cos(ang) * dist;
        const z = a.position.z + Math.sin(ang) * dist;
        if (level.isBlockedCell(Math.floor(x / level.cell), Math.floor(z / level.cell))) continue;
        if (!level.hasLineOfSight(x, cfg.player.eyeHeight, z, a.position.x, targetY, a.position.z)) continue;
        this.teleport(x, z);
        this.aimAt(a.position.x, targetY, a.position.z);
        return { x, z, dist, angleDeg: Math.round((ang * 180) / Math.PI), aiId: a.id, tier: a.tier.id };
      }
      return null;
    },
    /** 传送到贴墙位置（右向量朝墙），用于验证探头限制与掩体 */
    placeNextToWall() {
      for (const i of level.free) {
        const cx = i % level.W;
        const cz = Math.floor(i / level.W);
        if (!level.isBlockedCell(cx + 1, cz)) continue;
        const w = level.cellToWorld(cx, cz);
        const x = (cx + 1) * level.cell - cfg.player.radius - 0.02;
        this.teleport(x, w.z);
        player.state.yaw = 0;
        player.state.pitch = 0;
        player.state.leanCurrent = 0;
        player.state.leanTarget = 0;
        return { cell: [cx, cz], wallFaceX: (cx + 1) * level.cell, playerX: x };
      }
      return null;
    },
    /** 把玩家放到掩体后：中间隔一格墙，用于验证"隔墙打不中"（M1-TEMP-16 的回归） */
    placeBehindWall(targetIndex = 0) {
      const alive = aiManager.ais.filter((a) => !a.isDead);
      if (!alive.length) return null;
      const a = alive[Math.min(targetIndex, alive.length - 1)];
      const acx = Math.floor(a.position.x / level.cell);
      const acz = Math.floor(a.position.z / level.cell);
      for (let r = 2; r <= 4; r++) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const wx = acx + dx * r;
          const wz = acz + dz * r;
          if (level.isBlockedCell(wx, wz)) continue;
          // 中间那格必须是墙
          const mx = acx + dx * (r - 1);
          const mz = acz + dz * (r - 1);
          if (!level.isBlockedCell(mx, mz)) continue;
          const w = level.cellToWorld(wx, wz);
          this.teleport(w.x, w.z);
          this.aimAt(a.position.x, a.position.y + cfg.hitZones.chest.centerY, a.position.z);
          return { playerCell: [wx, wz], wallCell: [mx, mz], aiId: a.id, aiHealth: a.vitals.health };
        }
      }
      return null;
    },
    aiHealthList() {
      return aiManager.ais.map((a) => ({ id: a.id, alive: !a.isDead, health: a.vitals.health, tier: a.tier.id }));
    },

    /**
     * 把玩家放到某个掩体正前方并朝向它，用于验证台阶吸附（M1-TEMP-3）。
     * @param tall true 取高掩体（应挡住），false 取低掩体（应自动迈上）
     * @returns null 或 { coverCell, height, from, yaw, distance }
     */
    placeBeforeCover(tall = false) {
      const limit = level.stepHeight;
      const want = level.coverList.filter((c) => (tall ? c.height > limit : c.height <= limit));
      for (const c of want) {
        // 找一格相邻的、没有掩体的空地作为起点
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const sx = c.cell + dx;
          const sz = c.z + dz;
          if (level.isBlockedCell(sx, sz)) continue;
          if (level.groundHeightAt((sx + 0.5) * level.cell, (sz + 0.5) * level.cell) > 0.01) continue;
          const from = level.cellToWorld(sx, sz);
          const coverWorld = level.cellToWorld(c.cell, c.z);
          this.teleport(from.x, from.z);
          // 朝向掩体中心（yaw 约定见 core/direction.js：viewForward 的 -Z 前向）
          player.state.yaw = Math.atan2(-(coverWorld.x - from.x), -(coverWorld.z - from.z));
          player.state.pitch = 0;
          player.state.stepUps = 0;
          return {
            coverCell: [c.cell, c.z],
            height: c.height,
            tall: c.height > limit,
            from: { x: +from.x.toFixed(3), z: +from.z.toFixed(3) },
            to: { x: +coverWorld.x.toFixed(3), z: +coverWorld.z.toFixed(3) },
            distance: +Math.hypot(coverWorld.x - from.x, coverWorld.z - from.z).toFixed(3),
          };
        }
      }
      return null;
    },

    /** 掩体统计，用于断言"低/高掩体都真的生成了" */
    coverStats() {
      const low = level.coverList.filter((c) => c.height <= level.stepHeight).length;
      return {
        total: level.coverList.length,
        low,
        tall: level.coverList.length - low,
        stepHeight: level.stepHeight,
        lowHeight: level.coverList.find((c) => c.height <= level.stepHeight)?.height ?? null,
        tallHeight: level.coverList.find((c) => c.height > level.stepHeight)?.height ?? null,
      };
    },

    /** 直接查询关卡的视线判定，用于验证掩体是否真的挡子弹 */
    probeLineOfSight(ax, ay, az, bx, by, bz) {
      return level.hasLineOfSight(ax, ay, az, bx, by, bz);
    },
    /** 查询某点的地面高度（0 = 地面，>0 = 掩体顶面） */
    groundAt(x, z) {
      return level.groundHeightAt(x, z);
    },
    killOneAi() {
      const a = aiManager.ais.find((x) => !x.isDead);
      if (!a) return false;
      a.applyHitFrom(
        { id: 'debug', class: 'rifle', damage: a.vitals.maxHealth * 10, falloff: { startM: 1, endM: 2, minScale: 1 }, pellets: 1, fireIntervalMs: 100 },
        { id: 'debug', damageScale: 1, armorPenetration: 9 },
        'chest',
        1
      );
      return true;
    },
    setSetting(key, value) {
      settings[key] = value;
      saveSettings(settings);
      hud.syncSettings(settings);
      return { ...settings };
    },
    getSettings() {
      return { ...settings };
    },
    isPaused: () => isPaused,
    startRaid() {
      startRaid(performance.now());
    },
    killPlayer() {
      player.takeDamage(9999);
    },
    /** 复活式回血，用于让长时稳定性测试能继续跑 */
    healPlayer(amount = 9999) {
      player.vitals.health = Math.min(player.vitals.maxHealth, player.vitals.health + amount);
      player.state.alive = true;
    },
    grantConsumables(bandage, medkit) {
      consumables.bandage += bandage;
      consumables.medkit += medkit;
    },
    /** 传送到离所有存活 AI 最远的可站位置，用于在"安全"前提下测治疗/结算 */
    teleportToSafeSpot() {
      const alive = aiManager.ais.filter((a) => !a.isDead);
      let best = null;
      let bestScore = -1;
      for (let i = 0; i < level.free.length; i += 7) {
        const cell = level.free[i];
        const cx = cell % level.W;
        const cz = Math.floor(cell / level.W);
        const w = level.cellToWorld(cx, cz);
        let minD = Infinity;
        for (const a of alive) {
          minD = Math.min(minD, Math.hypot(a.position.x - w.x, a.position.z - w.z));
        }
        if (minD > bestScore) {
          bestScore = minD;
          best = w;
        }
      }
      if (!best) return null;
      this.teleport(best.x, best.z);
      return { x: best.x, z: best.z, minAiDistance: +bestScore.toFixed(1) };
    },
    teleportToContainer() {
      const c = loot.containers.find((x) => !x.opened);
      if (!c) return false;
      const ang = Math.random() * Math.PI * 2;
      this.teleport(c.x + Math.cos(ang) * 1.2, c.z + Math.sin(ang) * 1.2);
      return true;
    },
    teleportToExtract() {
      const z = extract.zones[0];
      this.teleport(z.x, z.z);
      return true;
    },
    setTimeLimitMs(ms) {
      cfg.raid.timeLimitMs = ms;
    },
    levelInfo() {
      return { W: level.W, cell: level.cell, free: level.free, walls: level.wallCount };
    },
  };
}
