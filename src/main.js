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
import { createLayeredNavGrid, createAStar, createPathScheduler, makeLos } from './core/navgrid.js';
import { mulberry32 } from './core/rng.js';
import { sustainedClimbRate } from './core/ballistics.js';

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
//
// 用关卡的分层网格（M3-1b-2 ②）而不是旧的单层 pathBlocked：
// 节点 = floor*W*H + cell，可行走性由"该层有没有落脚面 + 有没有迈不过去的实体"决定。
// 当前地图只有一层，floorCount=1、节点索引恒等于 cell，因此对现有 AI 完全等价
// （高掩体仍然算阻挡，低掩体仍然可走 —— 这一条由 level 的构建期判据保证，见其注释）。
const navGrid = createLayeredNavGrid(level.nav);
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
        aiManager.broadcastGunshot(lastNowMs, player.state.pos.x, player.state.pos.z, player.state.pos.y);
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
          // 视角的两笔账（M2-TEMP-1 修复后可分别观测）：
          //   aim*    = 玩家瞄的（永久）
          //   recoil* = 后坐力临时偏移（会恢复到 0）
          //   pitch   = 两者之和，且应始终满足 pitch ≈ aimPitch + recoilPitch
          aimYaw: +player.state.aimYaw.toFixed(5),
          aimPitch: +player.state.aimPitch.toFixed(5),
          recoilYaw: +player.state.recoilYaw.toFixed(5),
          recoilPitch: +player.state.recoilPitch.toFixed(5),
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
          groundY: +level.surfaceAt(player.state.pos.x, player.state.pos.z, player.state.pos.y, cfg.player.stepHeight).toFixed(4),
          // 运动探针：单帧脚底高度最大变化量。用于断言"画面没有跳变"。
          // maxFrameDYSpeed 是与帧率无关的指标（Δy/Δt），"跳变"的本质就是
          // 出现了一个物理上不可能的竖直速度。
          lastFrameDY: +player.state.lastFrameDY.toFixed(4),
          maxFrameDY: +player.state.maxFrameDY.toFixed(4),
          maxFrameDYSpeed: +player.state.maxFrameDYSpeed.toFixed(3),
          // 视角跳变探针：分别记录鼠标/后坐力/探头各自造成的单帧最大变化。
          // 报告"视角瞬移"时可直接看出是哪一路引起的。
          viewProbe: {
            maxMouseDeltaPx: +player.state.maxMouseDelta.toFixed(1),
            maxMouseRad: +player.state.maxMouseRad.toFixed(5),
            maxYawJumpRad: +player.state.maxYawJump.toFixed(5),
            maxPitchJumpRad: +player.state.maxPitchJump.toFixed(5),
            maxLeanJump: +player.state.maxLeanJump.toFixed(5),
            maxLeanSpeed: +player.state.maxLeanSpeed.toFixed(3),
            maxNonMouseJumpRad: +player.state.maxNonMouseJump.toFixed(5),
          },
          inputProbe: {
            maxEventDeltaPx: input.state.maxEventDelta,
            spikeEvents: input.state.spikeEvents,
            lastSpikeDeltaPx: input.state.lastSpikeDelta,
          },
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
          pathIdx: a.state.pathIdx,
          pendingGoal: a.state.pendingGoalCell,
          goal: a.state.path.length ? a.state.path[a.state.path.length - 1] : null,
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
      level.resolveCircle(player.state.pos, cfg.player.radius, 0, cfg.player.bodyHeight, cfg.player.stepHeight);
      // 若落点正好在掩体顶上，直接站上去（否则会先"陷进去"再由台阶吸附弹出）
      player.state.pos.y = level.surfaceAt(player.state.pos.x, player.state.pos.z, 0, cfg.player.stepHeight);
      player.state.onGround = true;
    },
    aimAt(x, y, z) {
      const p = player.state;
      const ex = p.pos.x;
      const ey = p.pos.y + p.eyeHeightCurrent;
      const ez = p.pos.z;
      const wantYaw = Math.atan2(-(x - ex), -(z - ez));
      const wantPitch = Math.atan2(y - ey, Math.hypot(x - ex, z - ez));
      // 设置的是**瞄准**而不是合成后的视角：
      // 后坐力偏移是另一笔账，直接写 yaw/pitch 会被下一帧的 syncView 覆盖掉。
      // 同时清零后坐力偏移，让测试从"干净"的瞄准状态开始。
      p.aimYaw = wantYaw;
      p.aimPitch = wantPitch;
      p.recoilYaw = 0;
      p.recoilPitch = 0;
      player.syncView();
    },
    /**
     * 手动压枪（模拟玩家往下拉鼠标）。
     *
     * 返回值里同时给出调用前后的 aim/recoil —— 必须在**同一次调用内**取到，
     * 否则中间会插入若干帧，后坐力恢复会改动 recoilPitch，
     * 于是"压枪没有改动后坐力偏移"这条断言会因正常的恢复而误判。
     */
    compensatePitch(deg) {
      const p = player.state;
      const snapAngles = () => ({
        aimPitch: +p.aimPitch.toFixed(6),
        recoilPitch: +p.recoilPitch.toFixed(6),
        pitch: +p.pitch.toFixed(6),
      });
      const beforeAngles = snapAngles();
      p.aimPitch -= deg * (Math.PI / 180);
      player.syncView();
      return { before: beforeAngles, after: snapAngles() };
    },
    /**
     * 复位视角朝向（只动瞄准与后坐力，**不动探头量**）。
     *
     * 存在的理由：探头的左右方向由 yaw 决定（见 core/direction.js 的右向量），
     * 所以"贴着某面墙探头"这类测试必须先保证朝向正确。
     * 如果前面的测试把视角转了几百度却没复原，后面的探头测试就会在错误方向上测量 ——
     * 表现为"裁剪根本没发生"，而看起来像功能坏了。
     */
    resetAim(yawDeg = 0, pitchDeg = 0) {
      const p = player.state;
      p.aimYaw = (yawDeg * Math.PI) / 180;
      p.aimPitch = (pitchDeg * Math.PI) / 180;
      p.recoilYaw = 0;
      p.recoilPitch = 0;
      player.syncView();
      return { yawDeg, pitchDeg, leanCurrent: +p.leanCurrent.toFixed(4) };
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
    /**
     * 传送到贴墙位置（右向量朝墙），用于验证探头限制与掩体。
     * @param keepAim true = 保留当前视角与探头量（用于复现"满探头突然贴墙"这类突变）；
     *                false = 复位视角与探头（默认，用于从干净状态开始）
     */
    placeNextToWall(keepAim = false) {
      const eyeY0 = 0 + cfg.player.eyeHeight;
      const reach0 = cfg.player.leanOffset + cfg.player.leanWallMargin;
      for (const i of level.free) {
        const cx = i % level.W;
        const cz = Math.floor(i / level.W);
        const w = level.cellToWorld(cx, cz);
        // 站位与"贴墙后的落点"都必须是**脚下的空地**，否则玩家一落地就被掩体推开，
        // 探头方向不再对着墙 —— 表现是"探头没有被收回"（横向速度 0），
        // 看起来像功能坏了，其实是夹具选了个站不住的点。
        // 用 surfaceAt 以脚底 0 为基准问，不能用 tallestSolidTopAt：
        // 两层地图上后者会把 3.6m 的二层楼板算进来，于是每个格子都被判成非空。
        if (level.surfaceAt(w.x, w.z, 0, level.stepHeight) > 0.01) continue;
        const x = (cx + 1) * level.cell - cfg.player.radius - 0.02;
        if (level.surfaceAt(x, w.z, 0, level.stepHeight) > 0.01) continue;
        // ★ 直接**射一次**，而不是用 isBlockedCell 判断右边是不是墙。
        //   isBlockedCell 是单层语义的快照（"这格有没有墙跨度"），在两层地图上
        //   它会把**二层**的墙也算进来：实测格 (8,1) 的跨度是 [楼板 3.3~3.6] + [墙 3.6~7.1]，
        //   一层根本没有墙，射线从眼高打过去什么也打不到 —— 于是探头永远不会被裁剪。
        //   这里要的判据本来就是"从眼高朝右、在探头可及范围内能不能打到东西"，
        //   那就直接问射线本身。顺带自动排除了高掩体（1.05m 低于眼高 1.65m）。
        const d = level.raycastWall(x, eyeY0, w.z, 1, 0, 0, reach0);
        if (!(d > 0 && d < reach0)) continue;
        this.teleport(x, w.z);
        // 视角是**派生值**（aim + recoil），必须写 aim 并同步，直接写 yaw/pitch 会被覆盖
        if (!keepAim) {
          player.state.aimYaw = 0;
          player.state.aimPitch = 0;
          player.state.recoilYaw = 0;
          player.state.recoilPitch = 0;
          player.syncView();
          player.state.leanCurrent = 0;
          player.state.leanTarget = 0;
        }
        return {
          cell: [cx, cz],
          wallFaceX: (cx + 1) * level.cell,
          playerX: x,
          // ★ 传送目标位置 vs **实际**位置（resolveCircle 之后）。
          //   两者不一致就说明这个点站不住、玩家被推开了 —— 那样探头方向不再对着墙，
          //   夹具测的就不是"探头被墙收回"了。这个字段就是用来暴露那种情况的。
          actualX: +player.state.pos.x.toFixed(3),
          actualY: +player.state.pos.y.toFixed(3),
          actualZ: +player.state.pos.z.toFixed(3),
          goalGap: +((cx + 1) * level.cell - x).toFixed(3),
          gapToWall: +((cx + 1) * level.cell - player.state.pos.x).toFixed(3),
          leanCurrent: +player.state.leanCurrent.toFixed(4),
          yaw: +player.state.yaw.toFixed(3),
        };
      }
      return null;
    },
    /** 把玩家放到掩体后：中间隔一格墙，用于验证"隔墙打不中"（M1-TEMP-16 的回归） */
    placeBehindWall(targetIndex = 0) {
      const alive = aiManager.ais.filter((a) => !a.isDead);
      if (!alive.length) return null;
      // 搜索范围要比"够用"更宽：这是**测试夹具**，它找不到合适位置时
      // 不该被当作产品失败。原实现只看第 0 号 AI、半径 2~4、四个正方向，
      // 在某些 AI 落点下会找不到，导致"隔墙打不中"这条回归断言时通时不通。
      // 现在遍历多个 AI、半径 2~6、八个方向。
      const dirs = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
      ];
      for (let ai = 0; ai < alive.length; ai++) {
        const a = alive[(Math.min(targetIndex, alive.length - 1) + ai) % alive.length];
        const acx = Math.floor(a.position.x / level.cell);
        const acz = Math.floor(a.position.z / level.cell);
        for (let r = 2; r <= 6; r++) {
          for (const [dx, dz] of dirs) {
            const wx = acx + dx * r;
            const wz = acz + dz * r;
            if (level.isBlockedCell(wx, wz)) continue;
            // 中间那格必须是墙
            const mx = acx + dx * (r - 1);
            const mz = acz + dz * (r - 1);
            if (!level.isBlockedCell(mx, mz)) continue;
            // 该墙必须真的挡住视线（用几何判定确认，而不是靠"中间是墙"推断）
            const w = level.cellToWorld(wx, wz);
            const aiY = a.position.y + cfg.hitZones.chest.centerY;
            if (level.hasLineOfSight(w.x, cfg.player.eyeHeight, w.z, a.position.x, aiY, a.position.z)) {
              continue;
            }
            this.teleport(w.x, w.z);
            this.aimAt(a.position.x, aiY, a.position.z);
            return {
              playerCell: [wx, wz],
              wallCell: [mx, mz],
              aiId: a.id,
              aiHealth: a.vitals.health,
              losBlocked: true,
            };
          }
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
          // ★ 起点必须是"**脚下**没有实体"的空地。
          //   不能用 tallestSolidTopAt：它回答的是"该格最高的东西多高"，
          //   两层地图上会把 3.6m 的二层楼板也算进来，于是每个格子都被判为非空，
          //   夹具一个起点都找不到（实测：低/高掩体两条断言都报"未找到"）。
          //   这里要问的是"脚底这一层有没有东西" —— 用 surfaceAt 以脚底 0 为基准问。
          const w = level.cellToWorld(sx, sz);
          if (level.surfaceAt(w.x, w.z, 0, level.stepHeight) > 0.01) continue;
          const from = level.cellToWorld(sx, sz);
          const coverWorld = level.cellToWorld(c.cell, c.z);
          this.teleport(from.x, from.z);
          // 朝向掩体中心（yaw 约定见 core/direction.js：viewForward 的 -Z 前向）。
          // ★ 必须写 aim 并 syncView：视角是派生值（aim + recoil），
          //   直接写 player.state.yaw 会在下一帧被 syncView 覆盖成 0，
          //   表现为"玩家面朝错误方向走过去、迈不上掩体"。
          player.state.aimYaw = Math.atan2(-(coverWorld.x - from.x), -(coverWorld.z - from.z));
          player.state.aimPitch = 0;
          player.state.recoilYaw = 0;
          player.state.recoilPitch = 0;
          player.syncView();
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
    /** 重置运动探针并返回重置前的峰值（单帧脚底高度最大变化量） */
    resetMotionProbe() {
      return player.resetMotionProbe();
    },
    /** 重置视角跳变探针，返回重置前的峰值 */
    resetViewProbe() {
      const p = player.state;
      const prev = {
        maxMouseDeltaPx: +p.maxMouseDelta.toFixed(1),
        maxMouseRad: +p.maxMouseRad.toFixed(5),
        maxYawJumpRad: +p.maxYawJump.toFixed(5),
        maxPitchJumpRad: +p.maxPitchJump.toFixed(5),
        maxLeanJump: +p.maxLeanJump.toFixed(5),
        maxLeanSpeed: +p.maxLeanSpeed.toFixed(3),
        maxNonMouseJumpRad: +p.maxNonMouseJump.toFixed(5),
        maxEventDeltaPx: input.state.maxEventDelta,
        spikeEvents: input.state.spikeEvents,
        lastSpikeDeltaPx: input.state.lastSpikeDelta,
      };
      p.maxMouseDelta = 0;
      p.maxMouseRad = 0;
      p.maxYawJump = 0;
      p.maxPitchJump = 0;
      p.maxLeanJump = 0;
      p.maxLeanSpeed = 0;
      p.maxNonMouseJump = 0;
      input.state.maxEventDelta = 0;
      input.state.spikeEvents = 0;
      return prev;
    },
    /** 直接注入一次鼠标移动（诊断用）：模拟异常大的 movementX/Y */
    injectMouseMove(dx, dy) {
      window.dispatchEvent(
        new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true })
      );
      return { dx, dy };
    },
    /**
     * 配置表算出的后坐力量化指标（供端到端测试与配置交叉核对）。
     * sustainedClimb 必须为正 —— 这是 M2-TEMP-1 的回归不变量。
     */
    recoilReport() {
      return cfg.weapons.map((w) => ({
        id: w.id,
        label: w.label,
        sustainedClimb: sustainedClimbRate(w, false),
        sustainedClimbAds: sustainedClimbRate(w, true),
        recoveryWhileFiring: +(w.recoil.recoveryPerSec * w.recoil.recoveryWhileFiringScale).toFixed(3),
        recoveryDelayMs: w.recoil.recoveryDelayMs,
      }));
    },
    /** 查询某点的地面高度（0 = 地面，>0 = 掩体顶面）。feetY 缺省取 0（站在地面上的实体） */
    groundAt(x, z, feetY = 0) {
      return level.surfaceAt(x, z, feetY, cfg.player.stepHeight);
    },
    /** 制造一次枪声（不造成伤害）。供测试用：验证"被惊动后是否靠近"，而不必把观察对象打死。 */
    makeNoise() {
      aiManager.broadcastGunshot(
        performance.now(),
        player.state.pos.x,
        player.state.pos.z,
        player.state.pos.y
      );
      return true;
    },
    killOneAi() {
      const a = aiManager.ais.find((x) => !x.isDead);
      if (!a) return false;
      a.applyHitFrom(
        { id: 'debug', class: 'rifle', damage: a.vitals.maxHealth * 10, falloff: { startM: 1, endM: 2, minScale: 1 }, pellets: 1, fireIntervalMs: 100 },
        { id: 'debug', damageScale: 1, armorPenetration: 9 },
        'chest',
        1,
        player.state.pos.x,
        player.state.pos.z,
        player.state.pos.y
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
