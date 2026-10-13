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
import { loadSettings, saveSettings, resetSettings, mouseSensScale, volumeScale, qualityParams, sfxVolumeScale, musicVolumeScale } from './platform/settings.js';
import { createPlayer } from './gameplay/player.js';
import { createWeaponSystem } from './gameplay/weapon.js';
import { createAiManager } from './gameplay/aiManager.js';
import { createLoot } from './gameplay/loot.js';
import { createExtract } from './gameplay/extract.js';
import { createInventory } from './gameplay/inventory.js';
// M4-3：结算改由独立的纯函数产出（src/core/raidResult.js），
// 不再在 endRaid 里现拼数据 —— 那样无法单测、无法重放，也谈不上幂等。
import { buildRaidResult } from './core/raidResult.js';
// M5-1：主大厅的展示数值由纯函数产出（core/briefing.js），界面只排版不算数。
import { buildRaidBriefing } from './core/briefing.js';
import { createMinimap } from './ui/minimap.js';
// M5-1：局内世界现在是"可创建 / 可销毁"的一整块（挂在 raidRoot 下）。
import { createRaidRoot, disposeSubtree } from './render/sceneCleanup.js';
// M5-8：画质档位的应用（档位参数来自配置表，本文件只负责装上去）
import { applyQuality } from './render/quality.js';
// M4-7：断线/刷新策略。快照的纯逻辑在 core，存储在 platform，本文件只做接线。
import { buildCheckpoint, checkpointToFacts } from './core/raidCheckpoint.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint, isAvailable } from './platform/raidStore.js';
import { createFlow, FLOW, END_REASON } from './core/flow.js';
import { createHud } from './ui/hud.js';
// M5-1：局外入口（主大厅）。它只负责排版与显示，数值全部来自 core/briefing.js。
import { createLobby } from './ui/lobby.js';
// M5：局外五个面板的渲染（仓库 / 配装 / 商店 / 技能 / 任务）。只排版，数值来自 core/lobbyView.js。
import { createPanels, reasonText } from './ui/panels.js';
// M5-7：玩家档案（存档）。存储是平台层，纯逻辑在 core/profile.js。
import { loadProfile, saveProfile, clearProfile, storageInfo, isProfileAvailable } from './platform/profileStore.js';
import { profileView, activeLoadout } from './core/profile.js';
import { buildLobbyViews, buildSettingsView } from './core/lobbyView.js';
// M5-8：设置面板（独立模块，销 M5-TEMP-4）与改键校验
import { createSettings } from './ui/settings.js';
import { sanitizeBindings, formatKey, actionLabel } from './core/keybinds.js';
import {
  buildRaidKit,
  buildCarry,
  takeLoadout,
  loadoutRequirements,
  setAmmo,
  setConsumable,
  updatePreset,
  addPreset,
  removePreset,
  setActivePreset,
  ammoOnHand,
} from './core/loadout.js';
import { stashSort, stashSummary, stashAdd, stashTotalOf } from './core/stash.js';
import { buy as shopBuy, sell as shopSell } from './core/shop.js';
import { acceptQuest, claimQuest, abandonQuest } from './core/quests.js';
import { learnSkill, respec, applyExp } from './core/progression.js';
import { applyRaidToProfile } from './core/settlement.js';
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

// ---------------- 局外外壳 ----------------
//
// 下面这些对象**跨局存活**：渲染器、场景、相机、灯光、HUD、小地图、输入、
// 音频、设置、流程状态机。它们不随"进入/离开战区"生灭。
// ★ M6-UI-01：hud 现在要读配置 —— 结算页的「任务完成情况」与「入库明细」需要把
//   核心层给的 id 显示成**任务名 / 物品名**（核心层只给 id，见 ui/hud.js 的注释）。
const hud = createHud(cfg);
// M5-1：主大厅。启动后玩家先看到它，而不是"点击即开始"的开始页。
const lobby = createLobby();
// M5：局外进度（档案）。它是**唯一**的持久化真值：货币、仓库、等级、技能、任务、统计。
// 加载失败时 profileStore 会回落备份或新档，并留下可观测的 repairs（见它的注释）。
let profileState = loadProfile(cfg, Date.now());
let profile = profileState.profile;
/** 局外界面态：只影响显示（选中哪些仓库条目、用哪个排序），不参与任何玩法数值。 */
const lobbyUi = { selectedUids: [], sortMode: 'category' };
/** 本局从仓库取走的配装（撤离要把没用完的还回来，阵亡则整份丢失）。 */
let raidTaken = null;
/** 上一局的结算落库摘要（结算界面要显示经验 / 任务 / 入库明细）。 */
let lastRaidSummary = null;
/** 进局时的配装快照（DEV 接口与结算读数用它，避免"局内再算一遍"）。 */
let raidKit = null;
/** 已开容器按类型计数（任务 open 类目标要用；它必须按"这一局"统计）。 */
let openedByType = {};
/** 本局是从哪个撤离点走的（任务的 extract 类目标可以限定撤离点；未撤离为 null）。 */
let lastExtractZoneId = null;
/** 最近一次的大厅面板视图（DEV 接口与断言读它，避免"界面与纯函数各说各话"）。 */
let lobbyViews = null;
/** 当前生效的画质参数（DEV 接口读它，断言"档位真的装上了"）。 */
let qualityState = null;
/** 本局 HUD 的任务追踪行（进局时由 raidKit.quests 生成，局内不再回查档案）。 */
let raidQuestLines = [];

/**
 * M5：局外面板的动作接线。
 *
 * 所有动作都走 `mutate()`：成功 → 落库并重绘大厅；失败 → 把**原因**显示出来。
 * 为什么不允许静默失败：玩家点了"买"没反应，与"点了但钱不够"在界面上完全一样，
 * 而后者是可解释的（core 已经算好了 reason），不显示出来等于把可解释的错误扔掉。
 */
const panels = createPanels({
  // ---- 配装 ----
  presetSelect: (d) => mutate((p) => setActivePreset(p, d.id)),
  presetAdd: () => mutate((p) => addPreset(p, cfg)),
  presetRemove: () => mutate((p) => removePreset(p, p.activeLoadoutId, cfg)),
  slotSelect: (d, node) =>
    mutate((p) => updatePreset(p, p.activeLoadoutId, { [d.slot]: node.value || null }, cfg)),
  ammoInc: (d) =>
    mutate((p) => {
      const lo = activeLoadout(p);
      const step = Number(d.step);
      const want = (lo.ammo[d.cal] || 0) + step;
      // 上限是**仓库里实际有的发数** —— 制作人裁定"不设数量上限"，但仓库供给是硬约束
      return setAmmo(p, lo.id, d.cal, Math.min(want, ammoOnHand(p, d.cal, cfg)), cfg);
    }),
  ammoDec: (d) =>
    mutate((p) => {
      const lo = activeLoadout(p);
      const step = Number(d.step);
      return setAmmo(p, lo.id, d.cal, Math.max(0, (lo.ammo[d.cal] || 0) - step), cfg);
    }),
  consInc: (d) =>
    mutate((p) => {
      const lo = activeLoadout(p);
      const step = Number(d.step);
      const want = (lo.consumables[d.id] || 0) + step;
      const have = p.stash.reduce((a, e) => (e.itemId === d.id ? a + e.count : a), 0);
      return setConsumable(p, lo.id, d.id, Math.min(want, have), cfg);
    }),
  consDec: (d) =>
    mutate((p) => {
      const lo = activeLoadout(p);
      const step = Number(d.step);
      return setConsumable(p, lo.id, d.id, Math.max(0, (lo.consumables[d.id] || 0) - step), cfg);
    }),

  // ---- 仓库 ----
  stashSort: (d) => {
    lobbyUi.sortMode = d.mode;
    mutate((p) => ({ ok: true, profile: { ...p, stash: stashSort(p.stash, d.mode, cfg).stash } }));
  },
  stashToggle: (d) => {
    const uid = Number(d.uid);
    const i = lobbyUi.selectedUids.indexOf(uid);
    if (i >= 0) lobbyUi.selectedUids.splice(i, 1);
    else lobbyUi.selectedUids.push(uid);
    refreshLobby();
  },
  stashSelectAll: () => {
    lobbyUi.selectedUids = profile.stash.map((e) => e.uid);
    refreshLobby();
  },
  stashClear: () => {
    lobbyUi.selectedUids = [];
    refreshLobby();
  },
  stashSell: () => {
    const res = mutate((p) => shopSell(p, lobbyUi.selectedUids, cfg));
    if (res && res.ok) {
      lobbyUi.selectedUids = [];
      lobby.toast(`出售完成：+${res.gained} 货币`);
      refreshLobby();
    }
  },

  // ---- 商店 ----
  shopBuy: (d) => {
    const res = mutate((p) => shopBuy(p, d.ref, Number(d.step), cfg));
    if (res && res.ok) lobby.toast(`已买入（-${res.spent} 货币）`);
  },

  // ---- 技能 ----
  skillLearn: (d) => mutate((p) => learnSkill(p, d.id, cfg)),
  skillsRespec: () => mutate((p) => respec(p, cfg)),

  // ---- 任务 ----
  questAccept: (d) => mutate((p) => acceptQuest(p, d.id, cfg)),
  questClaim: (d) => mutate((p) => claimQuest(p, d.id, cfg)),
  questAbandon: (d) => mutate((p) => abandonQuest(p, d.id, cfg)),
});

/**
 * 执行一次"档案变换"。
 * @param {(profile:object) => {ok:boolean, profile?:object, reason?:string}} fn
 *        必须是 core/ 的纯函数（buy / sell / learnSkill / updatePreset …）
 */
function mutate(fn) {
  const res = fn(profile);
  if (!res || !res.ok) {
    const why = res && res.reason ? reasonText(res.reason) : '未知原因';
    lobby.toast(`操作失败：${why}`, true);
    return res;
  }
  profile = res.profile;
  saveProfileNow();
  lobby.toast('');
  refreshLobby();
  return res;
}
// M4-6：小地图。数据每帧由主循环组装后喂给它，它只画不判。
const minimap = createMinimap(hud.el.minimap, cfg);
let minimapLastDraw = 0;
const settings = loadSettings();
const input = createInput(renderer.domElement, cfg, settings);
const flow = createFlow(cfg);
// [M5-1] 音频基础增益来自配置表（此前 0.35 硬编码在 audio.js 里两处）。
const audio = createAudio(cfg);

// ---------------- 局内世界：一局一套，可创建 / 可销毁 ----------------
//
// M5-1 起局内世界不再是"加载页面时就建好、直到刷新页面才消失"。
// 闭环（结算 → 大厅 → 再进战区）**不允许刷新页面**，于是同一张页面里会
// 反复创建/销毁局内世界 —— 不释放就是随局数增长的泄漏。
//
// 这些句柄是**模块级变量**而不是每局的局部 const：下面的主循环与 DEV 接口
// （600 余行）引用的是同一批名字。改成"每局新建局部变量"意味着把那 800 行
// 全部改成带前缀的访问 —— 纯风险、零收益。因此只把 `const` 改成 `let`，
// 赋值点收敛进 enterRaidWorld 一个函数里。
let raidRoot = null;
let level = null;
let player = null;
let decals = null;
let inventory = null;
let extract = null;
let loot = null;
let navGrid = null;
let aStar = null;
let scheduler = null;
let aiManager = null;
let weaponSys = null;
let weaponRng = null;
let footstepsAccum = 0;
/** 本页面内局内世界被创建 / 销毁的次数（DEV 断言用：证明"重建"真的发生了） */
let worldBuilds = 0;
let worldDisposals = 0;

// 消耗品定义表来自配置，与局无关。
const consumableDefs = cfg.consumables;
function consumableDef(id) {
  return consumableDefs.find((c) => c.id === id) || null;
}

/**
 * ★ M6：消耗品存量**数背包网格**，不再另存一份计数。
 *
 * 为什么把 `consumables = {bandage:3}` 这个对象删掉：M6 起弹药与药品是摆在网格里的物体，
 * 只要还留一个计数器，就迟早出现"背包里明明有绷带、HUD 说没有"这种两套账。
 * 网格是唯一真值，这里是它唯一的读取口。
 */
function consumableCount(id) {
  return inventory ? inventory.countOf(id) : 0;
}

/** 全部消耗品的存量（给快照/界面用）。同样是**数网格**，不是读一份副本。 */
function consumablesSnapshot() {
  const out = {};
  for (const d of consumableDefs) out[d.id] = consumableCount(d.id);
  return out;
}

// ---------------- 武器与战斗统计 ----------------
//
// 为什么 combatStats 是**常驻对象、每局就地清零**（而不是每局 new 一个）：
// weaponSys 的 emit 闭包直接对它自增。若每局换成新对象，上一局残留的闭包
// （例如某个 setTimeout 里的延时回调）会往旧对象上写，读数就分裂成两份。
// 就地清零让"谁的闭包写都不丢"，代价只是 9 个字段的循环。
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

/**
 * 跨局残留状态的复位。
 *
 * ★ 这里每一个字段都是"M5-1 之前不需要重置、现在必须重置"的：
 *   以前一整局的生命周期 = 一次页面加载，模块级变量天然是干净的；
 *   现在同一张页面会跑很多局，任何没被重置的累加量都会**带进下一局**。
 *   最容易漏也最致命的是暂停计时：`pausedTotalMs` 不清零，第二局的
 *   剩余时间会从第一局的暂停总时长开始扣（表现为"第二局时间莫名其妙少了一截"）。
 */
function resetRaidState() {
  for (const k of Object.keys(combatStats)) combatStats[k] = 0;
  kills = 0;
  lastExtract = null;
  footstepsAccum = 0;
  isPaused = false;
  pauseStartedAt = 0;
  pausedTotalMs = 0;
  lockGraceUntilMs = 0;
  // M5-6：已开容器按类型计数是**每局**的量，任务推进要用它
  openedByType = {};
  lastExtractZoneId = null;
  // ★ 注意：**不要**在这里清 raidTaken —— 它在 `startRaid` 里由 takeLoadout 赋值，
  //   而 resetRaidState 是 enterRaidWorld 的第一步。清掉它就等于"这一局从仓库扣走的
  //   配装没有记录"，撤离时不会还回、阵亡时也不计入损失（静默丢装备）。
  lastRaidSummary = null;
  raidQuestLines = [];
}

/**
 * 建一局：装配局内世界与全部局内系统。
 *
 * 所有对象都挂在 `raidRoot` 下（把它当作 scene 传给各模块），
 * 这是"能整体释放"的前提 —— 理由见 src/render/sceneCleanup.js。
 */
function enterRaidWorld(kit) {
  resetRaidState();
  // ★ M5-3：进局的配装与技能倍率由 raidKit 一次传入，局内系统**只读**它。
  //   此前局内读的是 weapons.json 里写死的 startLoadout（M5-TEMP-2），
  //   于是"玩家换了枪但局内还是旧枪"，而且技能倍率根本没有传递通道。
  raidKit = kit;
  // M5-6：HUD 的任务追踪行。**在进局时快照一次**而不是每帧回查档案 ——
  //   局内不该读档案（那是局外状态），而任务进度在本局结束前不会变。
  raidQuestLines = (kit.quests || []).map((q) => ({
    id: q.id,
    label: q.label,
    text: `${q.label}：${q.lines.map((l) => `${l.text} ${l.have}/${l.need}${l.done ? ' ✓' : ''}`).join('；')}`,
  }));

  raidRoot = createRaidRoot(scene);
  level = createLevel(cfg, raidRoot);
  // 灵敏度倍率以**函数**注入，而不是传当前数值快照：
  // 设置面板可以在局内被打开并改动，传快照会让"改了但本局不生效"变成一个
  // 说不清的行为，而玩家会认为设置坏了。
  player = createPlayer(cfg, level, { sensitivityScale: () => mouseSensScale(settings), kit });
  decals = createDecals(raidRoot);
  // M3-5 背包（二维网格 + 负重）与 M3-6 安全箱。
  // 先于 loot 创建：开箱回调要把物品塞进背包，而钥匙房要先查背包里有没有门禁卡。
  // M5-5：负重上限与安全箱档位来自 raidKit（技能与任务解锁都会改它们）。
  inventory = createInventory(cfg, { kit });
  extract = createExtract(cfg, level, raidRoot);
  // ★ M6-2：新一局开始前清空"已留尸体"的记录。
  //   不清的话，上一局死掉的 AI id（ai_0…ai_15 会复用同样的编号）会被当成"已处理"，
  //   本局对应编号的 AI 死掉时**不会留尸体** —— 一个只在第二局才出现的静默缺陷。
  corpseSpawned.clear();
  loot = createLoot(cfg, level, raidRoot, {
    // M5-5：搜刮速度倍率（搜刮熟练技能）由 raidKit 传入；缺省时等价于配置基线
    kit,
    // ★ M6-2：为尸体预留实例槽位。上限 = 本局 AI 总数（含 Boss）。
    //   刻意**不写死常量** —— AI 配额一改，写死的值就会静默不够用，
    //   而"尸体生不出来"不会报错，只会让人以为"击杀本来就不掉东西"。
    corpseSlots: (cfg.aiSpawn.totalCount || 0) + (cfg.aiSpawn.bossCount || 0),
    /**
     * 开箱（或拾取遗留）：逐件尝试入包，装不下的**留在容器里**而不是凭空消失。
     * 容量与负重因此成为真约束 —— 这正是"搜"这个字的核心取舍。
     */
    onOpened(container, items) {
      // M5-6：任务 open 类目标要按**容器类型**计数（"开 8 个民用箱"），
      // 而 loot 只提供"一共开了几个"。在这里记一份是最省改动、也最难写错的位置。
      openedByType[container.type] = (openedByType[container.type] || 0) + 1;
      const taken = [];
      const left = [];
      for (const it of items) {
        const r = inventory.tryAdd(it);
        if (r.ok) taken.push(it);
        else left.push(it);
      }
      container.items = left;

      if (taken.length) {
        audio.dropTier(container.dropSoundTier);
        const rarityLabel = container.rarity ? `（${container.colorHex ? '' : ''}${container.rarity}）` : '';
        hud.toast(`搜到 ${taken.length} 件${rarityLabel}：${taken.map((i) => i.label).join('、')}`);
      }
      if (left.length) {
        const why = inventory.weightKg() + left[0].weightKg > inventory.weightLimitKg ? '超重' : '没地方放';
        hud.toast(`背包${why}，留下 ${left.length} 件（可腾出空间后再来拿）`);
      } else if (!taken.length) {
        hud.toast('空容器');
      }
    },
    hasKey: (itemId) => inventory.items.some((e) => e.item.id === itemId),
  });

  // 导航：网格来自关卡，查询一律经预算调度器（M0 约束 C-1/C-2）
  //
  // 用关卡的分层网格（M3-1b-2 ②）而不是旧的单层 pathBlocked：
  // 节点 = floor*W*H + cell，可行走性由"该层有没有落脚面 + 有没有迈不过去的实体"决定。
  // 层数由 level.nav 自己给出，因此换地图不需要改这里。
  // 必须每局重建：它绑定的是**这一局**的 level 实例，复用上一局的网格会指到
  // 已释放的几何上（并且地图表若改了尺寸就是两个世界的网格混用）。
  navGrid = createLayeredNavGrid(level.nav);
  aStar = createAStar(navGrid);
  scheduler = createPathScheduler(aStar, cfg.aiPathBudget);
  // 该视线函数供后续 AI 侧扩展使用；当前 AI 用的是 level.hasLineOfSight（含高度判定）
  void makeLos;

  aiManager = createAiManager({ cfg, level, scene: raidRoot, scheduler, player });

  // ★ M6：消耗品与弹药不再另存计数 —— 它们就在 inventory 的网格里（见 consumableCount）。
  //   此前这里是 `consumables = { ...kit.loadout.consumables }`，那一份是真值的副本。

  // 武器随机流每局重取。它是**确定性**的（同一个全局种子），因此重开一局的
  // 后坐力抖动序列与上一局完全一致 —— 这是可复现性（测试依赖它），
  // 不是"忘了重置"。
  weaponRng = mulberry32(cfg.level.seed + 7717);
  weaponSys = createWeaponSystem({
    cfg,
    level,
    player,
    rng: weaponRng,
    kit,
    // ★ M6：备弹来自背包网格（销 [M5-TEMP-11] 的后半）。武器系统不再自己存一份 reserve。
    ammoStore: {
      total: (caliber) => inventory.ammoTotalOf(caliber),
      take: (caliber, rounds) => inventory.takeAmmo(caliber, rounds),
    },
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
            // ★ M6-2：尸体不在这里生成 —— 统一由 syncCorpses() 按"死亡"这个事实处理。
            //   挂在武器事件上会漏掉不走武器路径的死亡（调试夹具就是如此，见 syncCorpses 的说明），
            //   于是变成"两处各自决定要不要掉东西"，迟早分叉。
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

  worldBuilds++;
}

/**
 * 击杀计数的**唯一权威**是 `aiManager.kills`（它由"谁死"决定），
 * `combatStats.kills` 是给它做的缓存 —— 这里负责把缓存同步过来。
 *
 * 为什么需要它：`combatStats.kills` 原先只在武器的 `hit` 事件里自增
 * （`if (ev.killed) ...`），也就是**只有"玩家用枪打死"这条路**会记数。
 * 于是一旦有别的来源淘汰 AI，计数就与事实脱节 —— 而 M4-1 的 `killsAfter`
 * 撤离点（e4_archive 要求累计 3 杀）正是读这个数。
 * 实测：调试接口 killOneAi 确实把 AI 打死了（存活 6→5→4），但 kills 一直是 0，
 * 那条撤离点因此永远开不了（[M4-BUG-01] 的第二层）。
 *
 * 用 max 而不是覆盖：`aiManager.noteKill()` 在武器事件里**先于**死亡清扫执行，
 * 取 max 才能保证任何一帧的读数都不会倒退（计数是单调量）。
 */
function syncKills() {
  if (aiManager.kills > combatStats.kills) combatStats.kills = aiManager.kills;
}

/**
 * M6-2：为"刚死掉"的 AI 留下可搜刮的尸体。
 *
 * ★ 为什么在这里、而不是挂在武器的 hit 事件上：
 *   调试接口 `killOneAi` 走的是 AI 自己的 `applyHitFrom`，**绕过武器事件** ——
 *   项目里 [M4-BUG-01] 已经因为这个踩过一次（AI 确实死了，但累计击杀数是 0）。
 *   尸体属于"死亡"这件事的后果，所以挂在**死亡这个事实**上：
 *   无论怎么死的（武器、夹具、将来的其它来源），都只在这一处产生尸体，
 *   不存在"某条路径忘了掉东西"的可能。
 *
 * 幂等：用 Set 记住已经处理过的 id，每帧调用是安全的。
 */
const corpseSpawned = new Set();
function syncCorpses() {
  if (!loot) return;
  for (const a of aiManager.ais) {
    if (!a.isDead || corpseSpawned.has(a.id)) continue;
    corpseSpawned.add(a.id);
    loot.spawnCorpse(a.position.x, a.position.z, level.floorOfY(a.position.y), a.tier.id);
  }
}

/**
 * 拆一局：释放局内世界的全部资源，并把句柄清空。
 *
 * 顺序是有讲究的，三步不能换：
 *   ① 先让 AI 与贴花各自 dispose —— 它们会在生命周期中途把自己的 mesh
 *      从场景摘走（AI 死亡时、贴花环形覆盖时），那些 mesh **不在**子树里，
 *      遍历子树永远碰不到它们。
 *   ② 再遍历 `raidRoot` 释放剩下的静态几何与材质。
 *   ③ 最后清句柄，让任何残留调用立刻变成"读 null"而不是"读到上一局的对象"。
 *
 * 幂等：局外调用它是空操作（raidRoot 已经是 null）。这一点很重要 ——
 * "回大厅"与"开局前先清上一局"两条路径都会调它。
 *
 * @returns {{objects:number, geometries:number, materials:number}|null} 释放数量
 */
function leaveRaidWorld() {
  if (!raidRoot) return null;
  aiManager.dispose();
  decals.dispose();
  const freed = disposeSubtree(raidRoot);
  // M5：配装快照属于**局内**状态。局外读它必须是 null —— 否则
  // "回大厅后再读 raidKit"会拿到上一局的配装，而这个值看起来完全合理。
  raidKit = null;

  raidRoot = null;
  level = null;
  player = null;
  decals = null;
  inventory = null;
  extract = null;
  loot = null;
  navGrid = null;
  aStar = null;
  scheduler = null;
  aiManager = null;
  weaponSys = null;
  weaponRng = null;
  resetRaidState();

  worldDisposals++;
  return freed;
}

// ---------------- 局内状态 ----------------
let kills = 0;
let lastNowMs = 0;
// M4-2：最近一帧的撤离结果。`ex` 是帧内局部变量，DEV 接口（模块级）拿不到，
// 所以按 kills 同样的做法在帧内记一份。
let lastExtract = null;
// M4-7：本局唯一标识（快照与幂等结算都靠它）。开局时生成。
let raidId = null;
let checkpointLastWrite = 0;
// M4-3：最近一局的结算结果。结算是纯函数产物，保存它只是为了重放与 DEV 断言，
// 不参与任何计算 —— 重算一次仍然得到同一个对象。
let lastRaidResult = null;

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
  // ★ [M6-BUG-02] 局内一切都必须用**同一只时钟**：raidClock 扣掉了暂停时长。
  //   读条进度曾经把原始帧时间戳传进 player.useProgress()，与 useConsumable 写入的
  //   局内时钟不是同一只 —— 只要本局暂停过一次，读条就会带着"暂停时长/总时长"的
  //   偏移开场（急救包最明显：暂停 2 秒后一按下去就 67%，暂停更久直接满格）。
  const clock = raidClock(nowMs);
  const t = flow.timing(clock);
  const w = weaponSys.active();
  return {
    health: player.vitals.health,
    maxHealth: player.vitals.maxHealth,
    armor: player.vitals.armor,
    // ★ M6：两个武器槽都可能是空的（缺件进局的合法状态，见 weapon.js 的 NO_WEAPON）。
    weaponLabel: w.def.id ? w.def.label : '空手',
    magazine: w.magazine,
    reserve: w.reserve,
    weaponStatus: w.def.id ? weaponStatusText(w) : '没有武器',
    remainingMs: t.remainingMs,
    // M4-5：超时告警由这里判定，阈值来自配置表（tunables.raid.warningThresholdMs）。
    // hud 只负责把这个布尔值画出来 —— 它不该知道"多少秒算危险"这种策划数值。
    timeWarning: t.remainingMs <= cfg.raid.warningThresholdMs,
    aiAlive: aiManager.aliveCount(),
    // M3-5：背包是二维网格 + 负重，HUD 要显示的是"还能装多少"而不是"捡了几件"
    lootCount: inventory.count,
    lootValue: inventory.value(),
    // ★ M6：这三个数字必须分开报 —— 它们回答的是三个不同的问题：
    //   ① 一共占了几格 / 有多少格（含弹挂的第二张网格）；
    //   ② 其中几格是**自己带进来的**（弹药药品），玩家据此知道"我真正能装战利品的还剩几格"；
    //   ③ 战利品净重 / 上限（负重上限来自所装的背包，不再是一个固定值）。
    //   只报"背包 6/12 格"会让玩家以为还有 6 格能装，而其中 4 格是自己的子弹与绷带。
    bagText:
      `背包 ${inventory.usedSlots()}/${inventory.totalSlots() + inventory.rigTotalSlots()} 格` +
      ` · 自带 ${inventory.kitSlots()}` +
      ` · 战利品 ${inventory.weightKg().toFixed(1)}/${inventory.weightLimitKg}kg`,
    // ★ M5-6 销账 [M4-TEMP-4]：任务追踪不再占位 —— 数据来自进局时的 raidKit.quests，
    //   而 raidKit 是 core/quests.js 的 questTrackerView 产物（纯函数，可单测）。
    //   制作人裁定：**全部列出**（最多 maxActive 条），每条形如"开 8 个民用箱 3/8"。
    questLines: raidQuestLines,
    // 兼容既有断言/旧字段：把进度压成一行文本（HUD 的主显示用 questLines）
    questText: raidQuestLines.length
      ? raidQuestLines.map((l) => l.text).join(' · ')
      : '无进行中的任务',
    safeText: `保险 ${inventory.safeValue()}（${inventory.safeTier.label}）`,
    extractInZone: false,
    extractProgress: 0,
    prompt: '',
    useProgress: player.useProgress(clock),
    // 读条的显隐由"是否正在使用"决定，而不是"进度是否 > 0"：
    // 起始那一帧进度恰好是 0，用进度判显隐会让进度条晚一帧才出现（[M6-BUG-02] 的伴生现象）。
    useActive: player.isUsing(),
    consumableText:
      `3 绷带(${consumableCount('bandage')}) · 4 急救包(${consumableCount('medkit')})` +
      // ★ [M6-BUG-01] 满血时把"两件医疗品此刻都用不了"**常驻**写在 HUD 上：
      //   满血拒绝是设计（不浪费道具），但玩家必须看得出这是设计而不是坏了 ——
      //   只靠按键时弹一次提示，他很容易错过（尤其顺序按 3、4 都没反应时）。
      (player.vitals.health >= player.vitals.maxHealth ? ' · 生命已满' : ''),
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

// M3-3：搜索的"受击打断"需要一个本帧事实，不能让 loot 自己去查战斗系统。
// 它是帧级信号，每帧开头清零，只有真的挨了打才置位。
let damagedThisFrame = false;

/**
 * 使用消耗品（3 绷带 / 4 急救包）。
 *
 * ★ [M6-BUG-01] 存在的理由：这套判定原先散在两段 `if` 里，**失败时完全静默** ——
 *   "按 3 没反应"既可能是没绷带了、满血了、也可能正用着急救包，玩家无从区分，
 *   于是最自然的结论就是"绷带坏了"（真凶其实是当时把绷带上限 45 当成了使用门槛）。
 *   现在把判定收成一处，并且**每一个拒绝分支都说出原因**，让"没生效"永远可解释。
 *
 * @param actionKey 动作 id（键位来自 core/keybinds.js，不在本文件硬写按键码）
 * @param id        消耗品 id
 * @param label     中文名（提示用）
 * @param nowMs     **局内时钟**（raidClock）—— 与读条、与 tickConsumable 同一只时钟
 * @returns 是否真的开始了使用
 */
function tryUseConsumable(actionKey, id, label, nowMs) {
  if (!input.pressedAction(actionKey)) return false;
  const owned = consumableCount(id);
  if (owned <= 0) {
    hud.toast(`没有${label}了`, true);
    return false;
  }
  if (player.isUsing()) {
    const cur = player.state.usingItem;
    hud.toast(`正在使用${cur ? cur.label : '其它医疗品'}，无法同时使用${label}`);
    return false;
  }
  if (!player.useConsumable(consumableDef(id), nowMs)) {
    // 走到这里只剩一种可能：这次使用无法真的回血（满血 / 已到该药能治到的上限）。
    // 不消耗道具 —— 但也必须让玩家知道，否则又变成"按了没反应"。
    hud.toast(`${label}此刻无法生效（生命已满或已到可治上限）`);
    return false;
  }
  // ★ M6：从网格里**真的拿走一个**（销 [M5-TEMP-11]）。takeItem 返回实际拿到的数量，
  //   在这里它必然为 1 —— 但用它而不是假设为 1，理由与弹药一致：
  //   网格是另一份状态，账必须以实际扣减为准。
  const used = inventory.takeItem(id, 1);
  if (used <= 0) {
    hud.toast(`${label}没有取到（背包状态不一致）`, true);
    return false;
  }
  audio.consume();
  return true;
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = lastFrameAt ? Math.min((nowMs - lastFrameAt) / 1000, 0.05) : 0;
  damagedThisFrame = false;
  lastFrameAt = nowMs;
  lastNowMs = nowMs;

  input.beginFrame();

  const inRaid = flow.state === FLOW.RAID;
  const paused = updatePause(nowMs, inRaid);
  const t = raidClock(nowMs);

  // ★ M5-1：局外（大厅）没有局内世界。
  //   这里必须**早退**，而不是"带着 null 往下跑"：
  //   局外跑局内逻辑既是 M5 分层约束（禁止把局内逻辑耦合进局外系统）的违反，
  //   也会在 raidView() 里读 player.state 直接崩。
  //   仍然渲染一帧是为了两件事：窗口 resize 后画面不残留、以及进战区后第一帧即正确。
  if (!raidRoot) {
    renderer.render(scene, camera);
    return;
  }

  if (inRaid && !paused) {
    player.update(dt, input, t);

    // ---- 消耗品使用（3 绷带 / 4 急救包）----
    // 用边沿触发：轻点一次就该生效，电平式会在快速点按时漏掉。
    // 规则本体收在 tryUseConsumable 里：**失败也要给出原因**。
    tryUseConsumable('useConsumable1', 'bandage', '绷带', t);
    tryUseConsumable('useConsumable2', 'medkit', '急救包', t);
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
    // M6-2：先结算上一帧的死亡（留尸体），再让 AI 跑本帧。
    // 放在 update 之前是为了拿到"上一帧结束时已经死掉"的准确快照 ——
    // 放在之后也不会错，只是那一帧里尸体与死亡不同步。
    syncCorpses();
    aiManager.update(dt, t, {
      raidStartAt: raidStartAtMs,
      onPlayerHit(info) {
        const r = player.applyIncomingHit(info);
        combatStats.hitsTaken++;
        combatStats.damageTaken += r.damage;
        damagedThisFrame = true;
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
    // 打断信号来自三个独立来源：受击（本帧是否挨了打）、开火、走开（loot 内部按位移判）。
    // 规则本体在 loot.json 的 interruptRules —— 这里只负责把事实传进去。
    const lootRes = loot.update(dt, player.state.pos, {
      interact: input.interact(),
      firing: input.firing(),
      damaged: damagedThisFrame,
    });
    if (lootRes.interrupted) {
      const ir = lootRes.interrupted;
      const kept = ir.rule === 'keep_partial' ? `，保留 ${Math.round((ir.keptProgress / ir.container.def.searchMs) * 100)}% 进度` : '，进度清零';
      const why = ir.cause === 'damage' ? '受击' : ir.cause === 'fire' ? '开火' : '移动';
      hud.toast(`搜索被${why}打断${kept}`);
    }
    if (lootRes.blockedByKey) {
      hud.toast(`需要「${lootRes.blockedByKey.key}」才能开启`);
    }

    // ---- 撤离 ----
    // M4-1：把局内时间传给撤离点，开放规则（时间门槛 / 时间窗）要靠它求值。
    // 时间来自 flow 的单一计时源，而不是另算一份 elapsed —— 否则规则与结束判定会用两个时钟。
    const tm = flow.timing(t);
    const ex = extract.update(dt, player.state.pos, {
      elapsedMs: tm.elapsedMs,
      timeLimitMs: cfg.raid.timeLimitMs,
      // M4-1：击杀类撤离点规则（killsAfter）用同一个 kills 计数，
      // 与 HUD、结算共用 combatStats 这一份，不另设计数器。
      kills,
    });

    lastExtract = ex;

    // M4-2：中断是一次性事件，用 toast 报出来；否则玩家只会看到进度条莫名归零。
    // 必须放在 ex 求值之后 —— 曾因放在搜刮段之前而命中 TDZ（Cannot access 'ex' before
    // initialization），单测抓不到（它不加载 main.js），是端到端跑出来的。
    if (ex.interrupted) {
      const why = ex.interrupted.cause === 'left' ? '离开了撤离区'
        : ex.interrupted.cause === 'switched' ? '换到了另一个撤离区'
        : '撤离点已关闭';
      hud.toast(`${why}，撤离倒计时已重置`);
    }

    // ---- 结束条件 ----
    // M4-5「强制结束」的语义（制作人裁定）：**不宽限** ——
    // 时间归零即判超时失败，不会因为玩家正在撤离倒计时中途而多给时间。
    // 唯一例外是同一帧里撤离倒计时**已经走完**的情况：那是既成事实，
    // 所以 completed 排在 expired 之前。这不是宽限，是"完成了就算完成"。
    if (!player.state.alive) endRaid(END_REASON.DEAD, t);
    else if (ex.completed) {
      // M5-6：记下是从哪个撤离点走的（任务的 extract 类目标可以限定撤离点）。
      // 必须在 endRaid **之前**记录 —— endRaid 会立刻落库。
      lastExtractZoneId = ex.zone ? ex.zone.id : null;
      endRaid(END_REASON.EXTRACTED, t);
    } else if (tm.expired) endRaid(END_REASON.TIMEOUT, t);

    // ---- HUD ----
    const view = raidView(nowMs);
    view.extractInZone = ex.inZone;
    view.extractProgress = ex.progress;
    if (ex.inZone) {
      view.prompt = `保持在撤离区内 ${Math.ceil((extract.countdownMs * (1 - ex.progress)) / 1000)} 秒`;
    } else if (ex.blocked) {
      // M4-1：站在未开放的撤离点上时必须说清楚为什么不能用、还要等多久。
      // 不说的话，玩家会把"规则未满足"当成"撤离功能坏了"。
      const b = ex.blocked;
      if (b.reason === 'windowClosed') view.prompt = '这个撤离点的时间窗已关闭';
      else if (b.remainingKills != null) view.prompt = `撤离点未开放：还需淘汰 ${b.remainingKills} 名敌人`;
      else if (b.opensInMs != null) view.prompt = `撤离点未开放，还需 ${Math.ceil(b.opensInMs / 1000)} 秒`;
      else view.prompt = '这个撤离点当前不可使用';
    } else if (ex.leaveMs > 0) {
      // M4-2：宽限期内明确告诉玩家"还能救回来"，否则他会以为已经重置了而干脆走掉。
      const back = Math.max(0, cfg.extract.interrupt.leaveGraceMs - ex.leaveMs);
      view.prompt = `已离开撤离区，${(back / 1000).toFixed(1)} 秒内回去可继续`;
    } else if (lootRes.activeContainer) {
      const c = lootRes.activeContainer;
      const pct = Math.round((c.progress / c.def.searchMs) * 100);
      view.prompt = `搜索中… ${pct}%（松开 F、走开或挨打都会中断）`;
    } else if (lootRes.nearest && lootRes.nearest.opened) {
      view.prompt = '按 <b>F</b> 取走剩下的战利品（背包放不下才会剩下）';
    } else if (lootRes.nearest) {
      view.prompt = `按住 <b>F</b> 搜索${lootRes.nearest.def.label || '容器'}`;
    }
    // ---- 小地图（M4-6）----
    // 按配置间隔重绘：位置信息 100ms 刷新一次对人眼足够（玩家不会靠地图做厘米级走位），
    // 却能省掉绝大部分绘制开销。地形本身是缓存的，这里只是叠加动态点。
    if (nowMs - minimapLastDraw >= cfg.minimap.updateIntervalMs) {
      minimapLastDraw = nowMs;
      const MM = cfg.minimap;
      const pf = level.floorOfY(player.state.pos.y);
      // 用**浮点**格坐标而不是取整：取整会让角色和敌人在地图上"一跳一格"，
      // 连续移动看起来像卡顿。格中心是 (i+0.5)，与地形的绘制口径一致。
      const g = (w) => w / level.cell;
      minimap.draw({
        level: {
          W: level.W, H: level.H, cell: level.cell,
          blocked: level.nav.blocked, floorCount: level.nav.floorCount,
        },
        floor: pf,
        // 三个叠加层默认关闭（只画地形），关闭时**连数组都不组装** ——
        // 每帧给 89 个容器 + N 个 AI 建临时对象，本身就是一笔不必要的开销。
        containers: MM.showContainers
          ? loot.containers.map((c) => ({ x: g(c.x), z: g(c.z), floor: c.floor, opened: c.opened }))
          : [],
        extracts: MM.showExtracts
          ? extract.zones.map((z) => ({ x: g(z.x), z: g(z.z), floor: z.floor, open: z.open.open }))
          : [],
        ais: MM.showAis
          ? aiManager.ais.map((a) => ({
              x: g(a.position.x), z: g(a.position.z),
              floor: level.floorOfY(a.position.y), alive: !a.isDead,
            }))
          : [],
        player: { x: g(player.state.pos.x), z: g(player.state.pos.z), floor: pf, yaw: player.state.yaw },
      });
      if (hud.el.minimapLabel) hud.el.minimapLabel.textContent = `第 ${pf + 1} 层`;
    }

    // ---- M4-7：定期快照（兑底）----
    // 关闭瞬间还会再写一份最新的（见 pagehide），两者构成"本地双写"：
    // 正常关闭用最新的，进程被强杀时退回到这一份（最多落后一个间隔）。
    if (nowMs - checkpointLastWrite >= cfg.raid.checkpointIntervalMs) {
      checkpointLastWrite = nowMs;
      writeCheckpoint(tm.elapsedMs);
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

/**
 * M4-7：把当前局的状态写成快照。
 * 只在**局内**调用；结束后的清理由 endRaid 负责。
 */
function writeCheckpoint(elapsedMs) {
  if (!raidId) return;
  saveCheckpoint(
    buildCheckpoint({
      raidId,
      elapsedMs,
      // ★ M6：快照只装**战利品**。自己带的弹药药品由 `taken` 那条账管（阵亡即丢、撤离按剩余还回），
      //   塞进快照的后果是：断线补结算时它们被算进"损失估值"（看起来丢了一堆自己的子弹），
      //   而且"开局快照必须是空的"这条断言会被 5 件自带品顶掉 —— 一条检查变成了永远为假。
      inventory: inventory.lootItems,
      combat: {
        kills: combatStats.kills,
        aiTotal: aiManager.totalCount,
        containersOpened: loot.openedCount(),
        containersTotal: loot.containers.length,
        shotsFired: combatStats.shotsFired,
        health: player.vitals.health,
      },
    })
  );
}

function startRaid(nowMs) {
  // ★ [M4-BUG-02] 开新局之前，先把"上局没走完"补成正式结算。
  //
  // 这是**写在这个函数里**而不是只写在 btnStart 里 —— 否则任何绕过按钮的入口
  // （DEV 的 startRaid 接口、结算页的"返回大厅"）都会静默丢掉上局。
  // `showIt=false`：新局立刻开始，结算页闪一下反而像 bug；数据仍记在 lastRaidResult。
  // 正常玩家路径（btnStart）会先自己调一次并显示，因此这里是幂等的空操作。
  settleInterruptedRaid(false);

  // ★ M5-3：进局前把配装从仓库取走。
  //   这一份 `taken` 是结算的依据：撤离时把**没用完的**还回仓库，阵亡则整份丢失。
  //   制作人裁定的"缺件也允许进局"在这里自然成立 —— takeLoadout 拿多少算多少，
  //   没有的就当没带（界面刻意**不提示**缺什么）。
  const takenRes = takeLoadout(profile, cfg);
  profile = takenRes.profile;
  raidTaken = takenRes.taken;
  saveProfileNow();

  // ★ M5-1：局内世界**在这里**才创建（此前是页面加载时就建好）。
  //   必须在 flow.startRaid **之前**：状态一旦进入 RAID，主循环的下一帧就会
  //   开始推进局内逻辑，而那一刻 world 还没装好。
  //   同时它会复位跨局残留状态（见 resetRaidState）。
  //
  // ★ M6：用 takeLoadout 给的 `effectiveLoadout` 与 `carry` 建包 ——
  //   局内手上/包里的东西必须是**仓库真的拿得出**的那一份。
  //   直接用档案里的配装会让"配装里留了已卖掉的枪/子弹"变成凭空的物资。
  enterRaidWorld(buildRaidKit(profile, cfg, { loadout: takenRes.effectiveLoadout, carry: takenRes.carry }));

  // 新的一局开始，上局的残留快照到此为止（正常情况下上面那一步已经清掉了）。
  raidId = `r${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  clearCheckpoint();
  // [M5-BUG-01] 这里也**不再**手写收起大厅提示：进战区时大厅随即被 show(false) 关掉，
  //   而下次它重新可见一定经过 showLobby()，那时会按快照重新推导一次。
  //   （"局外界面状态由局外入口负责" —— 这个函数是局内流程，不该管大厅上的东西。）

  flow.startRaid(nowMs);
  raidStartAtMs = nowMs;
  lockGraceUntilMs = nowMs + 600;

  // ★ M4-BUG-02（同一条缺陷的第二面）：开局的**第一份快照必须立刻写**。
  //
  // 此前只有"每 5 秒一次"与"关闭瞬间一次"这两笔，于是开局后 5 秒内崩溃/被强杀
  // （进程被 kill 时 pagehide 不保证触发）**没有任何快照** —— 那一局等于从未存在过，
  // 连"只保住安全箱"都做不到。
  //
  // `checkpointLastWrite` 必须一并重置：它是**跨局残留**的模块级变量，
  // 第二局从 DEV 接口开始时若还留着上一局的时间戳，这份"立刻写"就会被跳过。
  checkpointLastWrite = nowMs;
  writeCheckpoint(0);

  // ---- 音频解锁门（M0-TECH-01 约束 C-8）----
  // 必须在**用户手势回调内**调用，因此放在"进入战区"的点击处理里。
  // 注意这里没有 await 它 —— 见 audio.js 的说明，无手势时 resume() 会永久挂起。
  audio.unlock();

  lobby.show(false);
  // 同 returnToLobby：进入战区时把局外与局内的界面层都归位，
  // 免得出现"已经在打但屏幕上还盖着设置页"这种界面（不刷新之后才会发生的问题）。
  hud.showEnd(false);
  settingsPanel.show(false);
  hud.showPause(false);
  settingsOpen = false;
  hud.showHud(true);
  hud.toast('进入战区：搜刮物资并撤离');
}

function endRaid(reason, nowMs) {
  if (flow.state !== FLOW.RAID) return;
  flow.endRaid(reason, nowMs);
  const t = flow.timing(nowMs);
  // M3-6 死亡掉落规则：撤离成功 = 全部带出；阵亡 / 超时 / 未撤离 = 只保住安全箱里的。
  // （规则与《核心循环数值框架案》§6 一致，口径见 inventory.settle）
  const settle = inventory.settle(reason === END_REASON.EXTRACTED ? 'extract' : 'death');
  // M4-3：结算数据由纯函数产出。同样的局内事实重算一次，得到的还是同一个结果，
  // 这是"重复提交不会重复发放"的第一道防线；第二道是 flow 只允许迁移一次。
  const result = buildRaidResult({
    reason,
    outcome: reason === END_REASON.EXTRACTED ? 'extract' : 'death',
    elapsedMs: t.elapsedMs,
    kills: combatStats.kills,
    aiTotal: aiManager.totalCount,
    containersOpened: loot.openedCount(),
    containersTotal: loot.containers.length,
    shotsFired: combatStats.shotsFired,
    health: player.vitals.health,
    kept: settle.kept,
    lost: settle.lost,
    keptValue: settle.keptValue,
    lostValue: settle.lostValue,
    safeValue: inventory.safeValue(),
    rarityTable: cfg.lootTable.rarity,
  });
  lastRaidResult = result;
  // M4-7：本局**已经**有了正式结算，快照到此为止。
  // 这一句是幂等结算的关键：不清的话，下次启动会拿旧快照再结算一遍。
  clearCheckpoint();
  // ★ M5：把这一局写进档案（货币不变、仓库收战利品、经验升级、任务推进、统计与样本）。
  //   纯函数 + raidId 幂等键两道防线，见 core/settlement.js 顶部说明。
  applyRaidToProfileNow(result);
  hud.showHud(false);
  hud.showEnd(true);
  hud.showResult(result, lastRaidSummary);
  input.exitLock();
}

/**
 * 本局剩余的弹药（按口径）与消耗品 —— 撤离时要把"没用完的"还回仓库。
 *
 * ★ M6：只报**自己带进来的**还剩多少（kitAmmoOf / kitCountOf）。
 *   捡到的同口径弹药/药品走战利品结算（inventory.settle），
 *   若在这里一并报出去，同一批子弹会被还两次（一次当行头、一次当战利品）。
 */
function currentRemaining() {
  const ammo = {};
  for (const cal of cfg.equipment.ammo.carryCalibers) {
    // 局外（补结算路径）没有 inventory：剩余一律按 0 算。
    // 这是**正确**的口径而不是兜底 —— 刷新意味着这一局已经中断（按未撤离处理），
    // 而"未撤离"本来就不把配装还回仓库。
    ammo[cal] = inventory ? inventory.kitAmmoOf(cal) : 0;
  }
  const cons = {};
  for (const d of consumableDefs) cons[d.id] = inventory ? inventory.kitCountOf(d.id) : 0;
  return { ammo, consumables: cons };
}

/** 把这一局的事实整理成 core/settlement.js 需要的形状（任务推进与统计都用它）。 */
function raidFacts(result) {
  const counts = new Map();
  for (const it of result.items || []) counts.set(it.id, (counts.get(it.id) || 0) + 1);
  const keptItems = [];
  for (const [itemId, count] of counts) keptItems.push({ itemId, count });
  const killsByTier = {};
  // ★ 局外没有 aiManager（刷新后的补结算就走这条路）。它以前会在这里崩，
  //   表现是"点了提示什么都没发生" —— 一条把整个结算流程吞掉的缺陷。
  if (aiManager && aiManager.ais) {
    for (const a of aiManager.ais) {
      if (a.isDead) killsByTier[a.tier.id] = (killsByTier[a.tier.id] || 0) + 1;
    }
  }
  return {
    kills: combatStats.kills,
    killsByTier,
    containersOpened: loot ? loot.openedCount() : 0,
    containersByType: { ...openedByType },
    keptItems,
    keptValue: result.loot.keptValue,
    extractId: lastExtractZoneId,
    mapId: cfg.map.id,
  };
}

/**
 * 落库（唯一入口）：把一局的结算写进档案并保存。
 *
 * @param {string} [raidIdOverride] 补结算路径必须传**快照里的** raidId ——
 *   刷新之后模块级的 `raidId` 是空的（新页面还没开局），用它会让幂等键失效。
 * @returns {object|null} 结算摘要（结算界面要显示经验 / 任务 / 入库明细）
 */
function applyRaidToProfileNow(result, raidIdOverride) {
  const id = raidIdOverride || raidId;
  const applied = applyRaidToProfile(
    profile,
    {
      raidId: id,
      atMs: Date.now(),
      result,
      facts: raidFacts(result),
      taken: raidTaken,
      remaining: currentRemaining(),
    },
    cfg
  );
  if (!applied.ok) {
    // 理论上不可达：result 一定有，raidId 一定在开局时生成。真发生也必须留下痕迹。
    console.warn('[main] 结算未落库：', applied.reason);
    lastRaidSummary = null;
    return null;
  }
  profile = applied.profile;
  lastRaidSummary = applied.summary;
  saveProfileNow();
  return applied.summary;
}

/** 保存档案。写失败（配额满 / 存储被禁用）不影响本局游玩，profileStore 会降级为内存档。 */
function saveProfileNow() {
  const ok = saveProfile(profile, cfg);
  if (!ok && isProfileAvailable() === false) {
    // 只提示一次：每次存档都刷屏会淹没真正有用的日志
    console.warn('[main] 档案未能落盘（存储不可用或体积超限），本次会话的进度只在内存中');
  }
  return ok;
}

/**
 * M4-7：把"上局没走完"补成一次正式结算（口径：未撤离 = 只保住安全箱）。
 *
 * [M4-BUG-02] 为什么必须有这个函数、且必须被 `startRaid` 调用：
 *   在此之前，**清快照**这件事发生在 `startRaid()` 里（无条件），而补结算发生在
 *   "点击开始页那条提示"的处理里。于是玩家只要**不点提示、直接开新局**，
 *   上局的快照就会被 `startRaid` 抹掉，而提示处理器随后 `loadCheckpoint()` 读到 null，
 *   什么都结算不出来 —— 上局（**含安全箱里本该保住的那些**）静默消失。
 *   这直接违反 M4 DoD「所有结束路径均有明确结算且不丢档」与风险对策
 *   「禁止在断线/刷新场景下静默丢弃玩家进度」。
 *
 * 现在的顺序是：**先结算、再清快照、最后才开新局**。
 * 注意"清快照"必须发生在结算之后（而不是之前）—— 否则幂等的两道防线都会失效。
 *
 * @returns {object|null} 补出的结算结果；没有待结算的快照时返回 null
 */
function settleInterruptedRaid(showIt) {
  const cp = loadCheckpoint();
  if (!cp) return null;
  const result = buildRaidResult(checkpointToFacts(cp, cfg.lootTable.rarity));
  // 记一份是为了让端到端能核对"重进后看到的结算"与"刷新前的背包"是否一致，
  // 否则"不丢档"这件事只能靠肉眼确认。
  lastRaidResult = result;
  clearCheckpoint();
  // ★ M5：补结算同样要落库 —— 否则刷新那一局的战利品与经验会静默消失。
  //   用快照里的 raidId：刷新后模块级 raidId 是空的，用它会让幂等键失效。
  applyRaidToProfileNow(result, cp.raidId);
  // [M5-BUG-01] 这里**不再**手写收起大厅提示：可见性已收口到 showLobby()，由快照推导
  //   （此刻快照已清 → 下次回大厅时推出来就是"收起"）。原先"清快照必须在收起提示之前"
  //   这条顺序依赖因此不需要再显式维护，不变式变强也变简单：**showLobby() 必须在结算之后被调用**
  //   （四个调用点都满足）。
  //   ★ 调用方那一段（结算 → 隐藏大厅 → 显示结算页）必须**保持同步**，中间不得插入 await：
  //     否则两者之间会插进一次绘制，短暂露出"大厅已可见但提示还挂着"的一帧。
  // [M4-BUG-02] 是否把结算**显示出来**由调用方决定：
  //   · 点提示 → 显示（玩家就是要看它）
  //   · 直接开新局 → 不显示（新局立刻开始，闪一下反而像 bug）
  // 但"结算 + 清快照"这两件事**无条件**发生。
  if (showIt) hud.showResult(result, lastRaidSummary);
  return result;
}

// ---------------- 局外（大厅）与结算的界面切换 ----------------

/**
 * 显示主大厅。
 * 每次显示都重绘简报：简报是纯函数产物，重算是"同一份配置得到同一个结果"，
 * 不存在状态；而"进入战区"前的数值必须是最新的（例如设置刚被改过）。
 */
function showLobby() {
  // ★ M5-3：简报显示的是**玩家当前配装**（同一个 buildRaidKit，局内用的也是它 ——
  //   因此不存在"大厅说带这把枪、进局却是另一把"的可能）。
  lobby.render(buildRaidBriefing(cfg, buildRaidKit(profile, cfg)));
  // M5：局外读数与五个面板每次显示都重绘 —— 它们都是纯函数产物（同一份档案
  // 必然得到同一份视图），因此重绘不存在状态漂移，而"进战区前的数值必须是最新的"。
  refreshLobby();
  // [M5-BUG-01] "上局未正常结束"提示的可见性**只在这里推导**：由"是否还有待结算快照"决定。
  //   收口前它由 settleInterruptedRaid() / startRaid() / 初始化段各自手写（共 4 处），
  //   那是把同一个事实算好几遍 —— 漏写一处就会出现"大厅可见但提示状态是旧的"。
  //   现在唯一数据源是快照，而"大厅何时可见"的唯一入口是本函数：
  //   有快照就显示、没有就不显示，结构上不可能再漏。
  //   注意推导是**惰性**的：结算那一刻不再立刻收起，而是等下一次回大厅时重新算。
  lobby.showInterruptedNotice(!!loadCheckpoint());
  lobby.show(true);
}

/** 重绘大厅的局外读数与五个面板（档案变过就调它）。 */
function refreshLobby() {
  lobbyViews = buildLobbyViews(profile, cfg, { selectedUids: lobbyUi.selectedUids });
  lobby.renderStats(lobbyViews.stats);
  panels.renderAll(lobbyViews);
}

/**
 * 结算页 → 返回大厅（M5-1 的闭环动作）。
 *
 * 结算页有**两条来源**，这里必须都处理对：
 *   ① 一局真的打完了（flow=ENDED）—— 需要一次状态迁移；
 *   ② 启动时对"上局未正常结束"补了结算（flow 一直在 LOBBY）—— 本来就在局外，
 *      不能也不该再迁移（状态机会拒绝）。这不是"容忍非法状态"，而是两条正当路径。
 */
function returnToLobby() {
  // ★ 健壮性（M5-3 引入"进局扣件"之后必须补的一道守卫）：
  //   若这一局还在进行中，先按「放弃本局」走完结算。
  //   不这么做的话，进局时从仓库扣走的配装会**既不还回、也没有结算记录** ——
  //   那是最难发现的一类丢档：玩家只看到"装备不见了"，日志里什么都没有。
  if (flow.state === FLOW.RAID) endRaid(END_REASON.ABANDONED, raidClock(performance.now()));
  if (flow.state === FLOW.ENDED) flow.backToLobby(performance.now());
  // 幂等：没有局内世界时是空操作。
  leaveRaidWorld();
  // ★ 必须把局内的每一层界面都收干净。
  //   「放弃本局」是从暂停菜单发起的，所以回大厅那一刻 **暂停菜单还开着**；
  //   在 M5-1 之前这不要紧（"再进一局"是整页刷新，界面状态跟着页面一起没了），
  //   现在不刷新了，留着就会变成"大厅上面盖着暂停菜单"这种说不清的界面。
  hud.showEnd(false);
  hud.showPause(false);
  settingsPanel.show(false);
  hud.showHud(false);
  settingsOpen = false;
  showLobby();
  input.exitLock();
}

/**
 * 设置生效。**运行时有副作用的东西都在这里下发**，只有一处：
 *   · 音量 → 音频总线（音频总线的实际增益 = 配置基线 × 档位倍率，只在 audio.js 算）
 *   · 灵敏度 → 不需要下发：player 每帧读当前倍率（见 enterRaidWorld 里注入的函数），
 *     因此局内打开设置改动它能立刻生效。
 * @param {boolean} persist 是否落盘（启动时的首次应用不该写盘）
 */
function applySettings(s, persist) {
  if (persist) saveSettings(s);
  audio.setVolumeScale(volumeScale(s));
  // ★ M5-8：分轨（制作人裁定：音乐轨先接上空总线，BGM 属 M7）
  audio.setBusScales({ sfx: sfxVolumeScale(s), music: musicVolumeScale(s) });
  // ★ M5-8：画质档位**立即生效**（制作人裁定：大厅与局内都能改，改完就看到效果）。
  //   阴影尺寸变更必须释放旧 shadow map，否则分辨率不会变 —— 那是"看不见的假生效"，
  //   细节见 render/quality.js 的注释。
  qualityState = applyQuality(renderer, sun, qualityParams(s), window.devicePixelRatio);
  // ★ M5-8：改键也立即生效（要求重进游戏才生效会被当成"改键失败"）
  input.syncSettings(s);
}

lobby.el.btnStart.addEventListener('click', () => {
  // ★ 补结算上局（若有），再开新局。这一步不能省 —— 省了就是 M4-BUG-02。
  //   这里显示出来是给玩家看的；结算本身在 startRaid 里还会再兜一次，
  //   因此**任何**入口（含 DEV 接口）都不会绕过它。
  settleInterruptedRaid(true);
  input.requestLock();
  startRaid(performance.now());
});
// M5-1：结算页的出口改成"返回大厅"，不再是整页刷新。
// 刷新能"回到大厅"却会重建整个页面 —— 那正是 M5 之前局内世界必须重建的原因。
hud.el.btnRestart.addEventListener('click', returnToLobby);

// 启动时应用一次设置（不落盘：读出来的东西没必要原样写回去）
applySettings(settings, false);

/**
 * 关闭设置面板：回到它是从哪儿打开的（局内 → 暂停菜单；局外 → 大厅）。
 * 抽成函数是因为它现在有两个入口（面板自己的"返回"按钮、以及外部流程）。
 */
function closeSettings() {
  settingsOpen = false;
  settingsPanel.show(false);
  if (flow.state === FLOW.RAID) hud.showPause(!input.state.pointerLocked);
  else showLobby();
}

/** 重绘设置面板（打开时、以及任一设置项变更后） */
function renderSettingsNow() {
  settingsPanel.render(
    buildSettingsView(settings, cfg, {
      // 制作人裁定 S1：**仅大厅可改键** —— 局内捕获按键会与游戏输入打架
      allowRebind: flow.state !== FLOW.RAID,
      onClose: closeSettings,
      notes: isProfileAvailable() ? '' : '⚠ 本机存储不可用：本次会话的进度只保存在内存中',
    })
  );
}

/** 把 core/keybinds.js 的拒绝原因翻成人话（界面不显示机器串） */
function bindRejectText(rej) {
  const map = {
    'locked-action': '移动类动作固定不可改（防止改完走不动）',
    'browser-reserved-modifier': '该组合被浏览器保留（关标签页 / 刷新等），不能用作动作键',
    'reserved-key': '这个键被游戏保留（Esc / F5 / F11 / Tab 等）',
    'unbindable-key': '这个键不在可绑定范围内',
    'not-a-string': '按键无法识别',
    'not-an-array': '绑定格式非法',
  };
  if (map[rej.reason]) return map[rej.reason];
  if (rej.reason && rej.reason.startsWith('conflict-with:')) {
    return `与「${actionLabel(rej.reason.split(':')[1])}」冲突（一个键不能绑定两个动作）`;
  }
  return rej.reason || '改键被拒绝';
}

// M5-8：设置面板现在是独立模块（销 M5-TEMP-4）。它只把"改哪一项、改成什么"交过来，
// 合法性一律由 core 判定 —— 界面不参与任何校验决定。
const settingsPanel = createSettings({
  onChange: (key, value) => {
    if (key === 'bindings') {
      // 改键：把这一次改动合并进现有覆盖表，再交给校验器。
      // 注意 bindings 是**整表覆盖**，因此必须合并而不是替换 ——
      // 替换会让玩家改一个动作时把其它动作的覆盖项全部丢掉。
      const merged = { ...(settings.bindings || {}), [value.action]: [value.code] };
      const res = sanitizeBindings(merged);
      const rej = res.rejected.find((r) => r.action === value.action);
      if (rej) {
        settingsPanel.toast(bindRejectText(rej), true);
        return;
      }
      settings.bindings = res.bindings;
      settingsPanel.toast(`已把「${actionLabel(value.action)}」改为 ${formatKey(value.code)}`);
    } else {
      settings[key] = value;
    }
    applySettings(settings, true);
    renderSettingsNow();
  },
  onReset: () => {
    const d = resetSettings();
    Object.assign(settings, d);
    // 不落盘：resetSettings 内部已经写过一次盘了
    applySettings(settings, false);
    renderSettingsNow();
    settingsPanel.toast('已恢复默认设置');
  },
});

lobby.el.btnSettings.addEventListener('click', () => {
  settingsOpen = true;
  lobby.show(false);
  settingsPanel.toast('');
  renderSettingsNow();
  settingsPanel.show(true);
});
hud.el.btnSettingsFromPause.addEventListener('click', () => {
  settingsOpen = true;
  hud.showPause(false);
  settingsPanel.toast('');
  renderSettingsNow();
  settingsPanel.show(true);
});
hud.el.btnResume.addEventListener('click', () => {
  hud.showPause(false);
  input.requestLock();
});

// ---- M4-7：关闭 / 刷新瞬间再写一份最新快照（双写的第二笔）----
// 用 pagehide 而不是只用 beforeunload：前者在移动端与"页面进入后台被丢弃"时更可靠。
// 只写一次快照，不做别的事 —— 这里不该有重活，否则会拖慢关闭。
const flushCheckpoint = () => {
  if (flow.state !== FLOW.RAID) return;
  writeCheckpoint(flow.timing(raidClock(performance.now())).elapsedMs);
};
window.addEventListener('pagehide', flushCheckpoint);
window.addEventListener('beforeunload', flushCheckpoint);

// ---- M4-7：上局中断后的补结算 ----
// 进来时若发现快照还在，说明上局没走到正式结算（刷新 / 关闭 / 崩溃）。
// 按 §2.6 的口径（视为未撤离）补一次结算，并立刻清除快照 —— 只结算一次。
//
// ★ 提示只是"让玩家知道"的入口，**不是**结算的唯一触发点：
//   `startRaid()` 自身在开新局前也会兜一次 settleInterruptedRaid(false)。
//   否则"不点提示直接开新局"就成了静默丢档的路径（M4-BUG-02）。
//
// [M5-BUG-01] 这里**不再**判断"该不该显示提示" —— 那是 showLobby() 的职责（由快照推导），
//   而本文件末尾的 showLobby() 会读同一个 loadCheckpoint() 得出同一个结论。
//   原先两处各写一遍同一个判定，等于把同一个事实算两次。
lobby.el.interruptedNotice.addEventListener('click', () => {
  // showIt=true：玩家点提示就是来看结算的，必须显示出来。
  const result = settleInterruptedRaid(true);
  if (!result) {
    // 守卫分支：提示本应只在有待结算快照时可见，走到这里说明快照已经没了
    // （例如另一个标签页先结算过）。用 showLobby() 复用同一个推导，
    // 而不是再手写一遍"收起" —— 全局因此只剩 showLobby() 一个写入点。
    showLobby();
    return;
  }
  // 下面两句与 settleInterruptedRaid() 之间**必须保持同步**（不得插入 await），
  // 否则中间会插进一次绘制，短暂露出"大厅可见但提示还挂着"的一帧。见 [M5-BUG-01]。
  lobby.show(false);
  hud.showEnd(true);
});
// M4 DoD 五条结束路径里的"主动退出"一条：暂停菜单 → 放弃本局。
//
// 二次确认用**弹窗**而不是"按钮上膛"：上膛状态只是把按钮文字改一下，
// 很容易被忽略 —— 玩家可能随手点了第一次，过一会儿再点一次就真的丢了整局。
// 弹窗会强制他把后果读完再做选择。
hud.el.btnAbandon.addEventListener('click', () => {
  hud.showAbandonConfirm(true);
});
hud.el.btnAbandonCancel.addEventListener('click', () => {
  hud.showAbandonConfirm(false);
});
hud.el.btnAbandonConfirm.addEventListener('click', () => {
  hud.showAbandonConfirm(false);
  endRaid(END_REASON.ABANDONED, raidClock(performance.now()));
});

renderer.domElement.addEventListener('click', () => {
  if (flow.state === FLOW.RAID && !input.state.pointerLocked && !settingsOpen) input.requestLock();
});

input.onLockedChange((locked) => {
  if (!locked && flow.state === FLOW.RAID && !settingsOpen) {
    hud.toast('指针已解锁 —— 点击画面继续', true);
  }
});

// ---- M5-1：开局落在大厅 ----
// 首帧之前就把简报渲染好，否则会先看到一个空大厅再补上数值（闪一下）。
// 注意此时**没有**创建局内世界 —— 那是"进入战区"才做的事。
showLobby();

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
  /**
   * 测试用的"富配装"：把一套装备塞进仓库并设成当前配装。
   *
   * 为什么必须有它：制作人裁定新账号**仓库为空**（装备要自己买），于是端到端
   * 一进战区就是赤手空拳 —— 而绝大多数断言（开火 / 后坐力 / 切枪 / 护甲）都要求
   * 玩家手里有枪。这个接口把"新账号状态"与"测试需要的最小装备"解耦：
   * 测试显式调用它，而产品路径一行不改。
   */
  function grantTestKit() {
    const ITEMS = [
      ['pistol_p9', 1], ['rifle_m4', 1], ['smg_v9', 1], ['shotgun_m590', 1], ['dmr_sr25', 1],
      ['vest2', 2], ['vest3', 2], ['helmet2', 2], ['helmet3', 2],
      // ★ M6：携行具也进"富配装"。**必须给**：M6 起弹药与药品要占背包格，
      //   而不给背包时的兜底只有 3×2=6 格 —— 这套行头（弹药 3 格 + 绷带 1 + 急救包 2）
      //   正好把它占满，于是"捡到战利品并产生估值"这条断言会因为**没地方放**而失败，
      //   而失败原因看起来像"掉落坏了"。给一只标准背包才是"装备齐全的玩家"的真实状态。
      ['bp_medium', 1], ['rig_light', 1],
      ['ammo_556', 300], ['pistol_mag', 180], ['ammo_762', 120], ['ammo_12ga', 80],
      ['bandage', 6], ['medkit', 4],
    ];
    let p = profile;
    // ★ M6：**从空仓库重建**，而不是往上叠。
    //   叠的后果实测过：仓库（10×12）会被一局局returnToLobby/阵亡留下的东西填满，
    //   于是 stashAdd 悄悄丢掉新加的背包与弹挂（leftover 被忽略），下一局进战区
    //   就变成"没有背包、兜底 6 格"，一连串断言跟着失败 —— 而失败信息看起来像
    //   "弹药没带对 / 掉落坏了"。夹具必须是**确定的**，不能依赖前一组留下了什么。
    let stash = [];
    let dropped = 0;
    for (const [ref, n] of ITEMS) {
      const itemId = cfg.equipmentDefs[ref] ? cfg.equipmentDefs[ref].itemId : ref;
      const add = stashAdd(stash, itemId, n, cfg);
      stash = add.stash;
      dropped += add.leftover;
    }
    p = { ...p, stash };
    const preset = p.loadouts[0];
    const lo = {
      ...preset,
      primary: 'rifle_m4',
      secondary: 'pistol_p9',
      body: 'vest3',
      head: 'helmet3',
      // ★ M6：连背包与弹挂一起装上。"富配装"必须是一只真能装东西的包，
      //   否则容量瓶颈会把后面所有"搜刮 → 估值"的断言压成"背包满了"。
      backpack: 'bp_medium',
      rig: 'rig_light',
      ammo: { '5.56': 120, '9mm': 60 },
      consumables: { bandage: 3, medkit: 2 },
    };
    p = { ...p, loadouts: [lo], activeLoadoutId: lo.id };
    profile = p;
    saveProfileNow();
    refreshLobby();
    return { stash: profile.stash.length, dropped };
  }

  /**
   * ★ M6-1：按 id 授予**指定**武器 + 对应口径弹药，并装到它自己的槽位上。
   *
   * 为什么不能只靠 grantTestKit：那套"富配装"固定给 rifle_m4 / pistol_p9 / smg_v9 /
   * shotgun_m590 / dmr_sr25 这 5 把老枪。武器表从 5 把扩到 30 把之后，
   * "表里有、玩家拿不到、或拿到也开不了火（口径没带对）"这类缺陷会**完全漏掉**——
   * 它们恰恰是纯逻辑断言看不见的那一类（纯逻辑只验表，不验进局路径）。
   *
   * @param {string} ref 武器 id（weapons.json 的 id）
   * @param {number} [rounds] 授予的弹药发数（默认 120）
   */
  function grantWeapon(ref, rounds = 120) {
    const def = cfg.equipmentDefs[ref];
    if (!def) throw new Error(`[__m2] 未知武器 ${ref}`);
    const w = cfg.weapons.find((x) => x.id === ref);
    if (!w) throw new Error(`[__m2] ${ref} 不在武器表里`);
    const ammoRow = cfg.ammo.find((a) => a.id === w.ammoType);
    if (!ammoRow) throw new Error(`[__m2] ${ref} 的口径 ${w.ammoType} 不在口径表里`);

    let p = profile;
    let dropped = 0;
    const give = (itemId, n) => {
      const add = stashAdd(p.stash, itemId, n, cfg);
      p = { ...p, stash: add.stash };
      dropped += add.leftover;
    };
    give(def.itemId, 1);
    // 弹药按**口径对应的物品**给（弹匣/盒），与商店和配装走同一条路径
    give(ammoRow.lootItemId, rounds);
    // ★ M6：连背包一起给并装上。没有背包时兜底只有 3×2=6 格，而 120 发弹药本身就是 2 格，
    //   再叠上医疗品就满了 —— 于是"备弹"会读成 0，看起来像"弹药没带对"，
    //   实际原因是**装不下**。装备齐全的玩家必须有一只包。
    give('bp_medium', 1);

    const preset = p.loadouts[0];
    const slotKey = w.slot === 1 ? 'primary' : 'secondary';
    // ★ M6：弹药**只装这一把的口径**（与上面"清空另一槽"同一个语义），且装上一只背包。
    //   累加会在连测 4 把时把 4 个口径的弹药堆在一起，把 6 格的兜底背包撑爆 ——
    //   那时失败信息看起来像"弹药没带"，实际是容量问题。
    const carry = { [w.ammoType]: rounds };
    // ★ 另一槽**清空**：本夹具的语义是"只装这一把"，不是"在现有配装上替换一格"。
    //   不清空的后果实测过：连测 4 把时，测副武器那轮手上仍是上一轮的主武器，
    //   断言读出"局内 dmr_g28"——夹具残留被当成产品缺陷。清空后断言才无歧义。
    //   （primary=null + secondary 有枪是合法配装：起始配装本来就是 primary 为空。）
    const lo = { ...preset, primary: null, secondary: null, backpack: 'bp_medium', [slotKey]: ref, ammo: carry };
    p = { ...p, loadouts: [lo], activeLoadoutId: lo.id };
    profile = p;
    saveProfileNow();
    refreshLobby();
    return { equipped: ref, slot: slotKey, ammoType: w.ammoType, rounds, dropped };
  }

  /**
   * ★ M6：把**当前配装所需**的东西补齐到仓库里（只补不删，不改配装本身）。
   *
   * 为什么需要它：M6 起背包、弹挂与弹药是**真的从仓库取走**的装备 ——
   * 上一局没撤离就丢了。而端到端里大多数组测的是武器/技能/搜刮，
   * 不该被"上局把包丢了"干扰（丢了之后会退回 6 格的兜底包，容量一变，
   * 负重上限与"能装几件"都跟着变，失败信息还看不出原因）。
   *
   * 刻意**不重置配装**：这样"在大厅把主武器换成霰弹枪"之类的断言仍然成立 ——
   * 补齐的是那把霰弹枪，而不是把它换回 M4。
   * @returns {{added:number}}
   */
  function restockLoadout() {
    const reqs = loadoutRequirements(activeLoadout(profile), cfg);
    let stash = profile.stash;
    let added = 0;
    for (const r of reqs) {
      if (!(r.count > 0)) continue;
      const have = stashTotalOf(stash, r.itemId, cfg);
      if (have >= r.count) continue;
      const add = stashAdd(stash, r.itemId, r.count - have, cfg);
      stash = add.stash;
      added += add.added;
    }
    profile = { ...profile, stash };
    saveProfileNow();
    refreshLobby();
    return { added };
  }

  /**
   * 清空仓库（只留配装引用）。用来验证"缺件也允许进局"这条裁定**真的能跑**：
   * 仓库空了之后进战区必须是"空手 + 兜底背包"，而不是崩溃或凭空给一把枪。
   */
  function clearStash() {
    profile = { ...profile, stash: [] };
    saveProfileNow();
    refreshLobby();
    return { stash: 0 };
  }

  /**
   * ★ M6：装上指定的背包与弹挂（并把它们补进仓库）。
   * 端到端要验证"换一只包 → 局内容量跟着变"，而这一步玩家本身是在大厅做的；
   * 夹具直接改配装，是为了让断言落点只在**局内读数**上。
   */
  function equipCarry(backpackId, rigId) {
    const p = profile;
    const lo = p.loadouts[0];
    const next = { ...lo, backpack: backpackId || null, rig: rigId || null };
    let stash = p.stash;
    for (const id of [backpackId, rigId]) {
      if (!id) continue;
      const def = cfg.equipmentDefs[id];
      if (!def) throw new Error(`[__m2] 未知携行具 ${id}`);
      if (stashTotalOf(stash, def.itemId, cfg) <= 0) stash = stashAdd(stash, def.itemId, 1, cfg).stash;
    }
    profile = { ...p, stash, loadouts: [next], activeLoadoutId: next.id };
    saveProfileNow();
    refreshLobby();
    return { backpack: next.backpack, rig: next.rig };
  }

  /**
   * ★ M6：把配装的弹药/消耗品设成指定的量（并补进仓库），返回**这一份配装**的投放结果。
   * 用来验证"装不下会被报出来"：它返回的 overflow 就是玩家在大厅该看到的那个列表。
   */
  function stuffLoadout(ammo, consumables) {
    const p = profile;
    const lo = { ...p.loadouts[0], ammo: { ...(ammo || {}) }, consumables: { ...(consumables || {}) } };
    let stash = p.stash;
    // 仓库先按需求补齐，这样 overflow 只反映"装不下"，而不是"仓库里没有"
    for (const r of loadoutRequirements(lo, cfg)) {
      const have = stashTotalOf(stash, r.itemId, cfg);
      if (have < r.count) stash = stashAdd(stash, r.itemId, r.count - have, cfg).stash;
    }
    profile = { ...p, stash, loadouts: [lo], activeLoadoutId: lo.id };
    saveProfileNow();
    refreshLobby();
    const plan = buildCarry(lo, cfg);
    return { overflow: plan.overflow, placements: plan.placements };
  }

  /**
   * ★ M6：当前武器口径在**网格里**还剩多少发（备弹的唯一真值）。
   * 断言"换弹真的从网格扣了子弹"必须读它，而不是读 HUD 上的数字 ——
   * HUD 的数字是派生量，读它等于用结论证明结论。
   */
  function ammoInGrid() {
    const w = weaponSys.active();
    if (!w.def.id) return { caliber: null, total: 0, magazine: 0 };
    return {
      caliber: w.def.ammoType,
      total: inventory.ammoTotalOf(w.def.ammoType),
      magazine: w.magazine,
    };
  }

  /**
   * ★ M5-1：局外（大厅）没有局内世界，但仍要给出**同形状**的快照。
   *
   * 为什么不能直接抛错或返回 null：端到端在开局前会反复轮询
   * `snapshot().flow`（`page.waitForFunction(() => ... === 'raid')`），
   * 那是正常路径而不是误用。键全部保留、局内专属字段为 null，
   * 断言侧因此不必为两种状态写两套读法。
   */
  const lobbySnapshot = () => ({
    flow: flow.state,
    endReason: flow.endReason,
    raidId: null,
    transitions: flow.transitions.slice(),
    paused: isPaused,
    remainingMs: Math.round(flow.timing(raidClock(performance.now())).remainingMs),
    settings: { ...settings },
    // M5-8：局外也要能读到生效键位与画质参数（断言在进局前就要能验证它们）
    bindings: input.bindingsOf(),
    quality: qualityState,
    world: { alive: false, builds: worldBuilds, disposals: worldDisposals },
    player: null,
    weapon: null,
    ai: [],
    aiAlive: 0,
    kills: combatStats.kills,
    combat: { ...combatStats },
    raidResult: lastRaidResult,
    loot: null,
    consumables: null,
    extract: [],
    extractInterrupt: { leaveMs: 0, cause: null },
    scheduler: null,
    audio: {
      unlocked: audio.isUnlocked(),
      gain: audio.currentGain(),
      buses: audio.busGains(),
      ...audio.stats,
    },
    decals: 0,
    level: null,
  });

  window.__m2 = {
    // ---- M5：局外（档案）读数 ----
    // 端到端的断言尽量读这些，而不是读 DOM 文本 —— DOM 文本会随排版变，
    // 而这些读数是纯函数产物（与界面显示的同一份）。
    profile() {
      return {
        view: profileView(profile, cfg),
        stash: profile.stash.map((e) => ({
          uid: e.uid, itemId: e.itemId, count: e.count, x: e.x, y: e.y, rotated: e.rotated,
        })),
        loadout: activeLoadout(profile),
        quests: JSON.parse(JSON.stringify(profile.quests)),
        safeTierUnlocked: profile.safeTierUnlocked,
        repairs: (profile._repairs || []).slice(),
        lastRaidId: profile.lastRaidId,
        source: profileState.source,
        storage: storageInfo(),
      };
    },
    lobby() {
      return {
        tab: lobby.tab,
        statsText: lobby.el.stats ? lobby.el.stats.textContent : '',
        toastText: lobby.el.toast ? lobby.el.toast.textContent : '',
        interruptedVisible: lobby.el.interruptedNotice
          ? lobby.el.interruptedNotice.getClientRects().length > 0
          : false,
        views: lobbyViews,
        /**
         * ★ M6：进战区前的简报（纯函数产物，界面显示的就是它）。
         * 暴露它是为了让端到端能断言"装不下这件事在**进战区之前**就告诉玩家了" ——
         * 只看局内的话，玩家已经站在战区里，那时才发现少带已经晚了。
         */
        briefing: buildRaidBriefing(cfg, buildRaidKit(profile, cfg)),
      };
    },
    /** 进局时用的配装快照（断言"局内用的就是局外配的"要靠它） */
    raidKit() {
      return raidKit;
    },
    /** 这一局从仓库取走了什么（结算要还回去的那份清单） */
    raidTaken() {
      return raidTaken ? raidTaken.map((t) => ({ ...t })) : null;
    },
    /** 上一局的落库摘要（结算界面显示的就是它） */
    lastRaidSummary() {
      return lastRaidSummary;
    },
    grantTestKit,
    restockLoadout,
    clearStash,
    equipCarry,
    stuffLoadout,
    ammoInGrid,
    grantWeapon,
    /**
     * ★ M6-2 测试隔离：让全部 AI 停止更新（不移动、不开火）。**不是产品功能**。
     *
     * 存在的理由：AI 由 7 名扩到 16 名后，冒烟里"连续开火测武器机制"的那几组
     * 会被循声聚拢的 AI 打死 —— 而那几组断言的是后坐力/开镜/切枪，
     * 本来就不该依赖"自由开火还能活"。这是一条从未言明的**隐含假设**，密度一变就碎。
     * 显式化它：不测 AI 的组先声明要"安静的世界"，测 AI 的组显式打开。
     *
     * 注意它**不削弱任何断言**：standDown 时 AI 依然存活、依然可被击中掉血。
     */
    aiStandDown(v) {
      aiManager.setStandDown(v);
      return aiManager.standDown;
    },
    /**
     * ★ M6-2：列出本局的可搜刮尸体（诊断与断言用）。
     * 为什么要它：尸体是**运行时生成**的容器，位置与内容都不在地图表里，
     * 靠快照里的一个计数证不了"尸体落在被杀的那只 AI 脚下、且带的是它那一档的掉落"。
     */
    corpseList() {
      if (!loot) return [];
      return loot.containers
        .filter((c) => c.type === 'corpse')
        .map((c) => ({
          x: +c.x.toFixed(3), z: +c.z.toFixed(3), floor: c.floor,
          tierId: c.tierId, opened: c.opened,
          items: c.items.map((i) => i.id),
        }));
    },
    /**
     * 测试用：给档案加经验（技能点随升级发放）。
     * 走与结算**同一条**路径（core/progression.js 的 applyExp）——
     * 另写一条"直接改等级"的捷径会让断言失去意义。
     */
    grantExp(n) {
      const r = applyExp(profile, Number(n) || 0, cfg);
      profile = r.profile;
      saveProfileNow();
      refreshLobby();
      return { level: r.after.level, skillPoints: profile.progression.skillPoints };
    },
    /** 清空档案（测试注入"存档损坏 / 被清空"用） */
    clearProfile() {
      clearProfile();
      // 走与启动时**同一条**加载路径（这样 repairs / source 的口径才一致）
      profileState = loadProfile(cfg, Date.now());
      profile = profileState.profile;
      refreshLobby();
      return true;
    },
    /** 直接写 localStorage 的档案键（测试注入坏档 / 未来版本档用） */
    writeRawProfile(text) {
      try {
        localStorage.setItem('h5_extract_profile', text);
        return true;
      } catch {
        return false;
      }
    },
    /** 重新加载档案（模拟"重开浏览器"） */
    reloadProfile() {
      profileState = loadProfile(cfg, Date.now());
      profile = profileState.profile;
      refreshLobby();
      return { source: profileState.source, repairs: profileState.repairs };
    },

    snapshot() {
      // 局外：返回同形状的空快照（见上）。
      if (!raidRoot) return lobbySnapshot();
      // 击杀计数在快照时对齐一次：调试接口可能在两帧之间淘汰 AI（不在武器路径上），
      // 不补这一步的话，端到端读到的 kills 会比事实小一个帧的量。
      syncKills();
      return {
        flow: flow.state,
        endReason: flow.endReason,
        // M5-1：本局 id。断言"回到大厅后再进战区拿到的确实是**新的一局**"要靠它 ——
        // 只看 world.builds 只能证明建过一次，证明不了新局不是旧局。
        raidId,
        transitions: flow.transitions.slice(),
        paused: isPaused,
        remainingMs: Math.round(flow.timing(raidClock(performance.now())).remainingMs),
        settings: { ...settings },
        // M5-8：**当前生效**的键位表（默认 + 玩家覆盖）。断言改键是否真的生效要读它，
        // 而不是读 settings.bindings —— 后者只是"玩家填了什么"。
        bindings: input.bindingsOf(),
        // M5-1：局内世界是否活着、本页面内重建过几次。
        // 断言"回大厅后世界确实被销毁、再进战区确实是新建的"要靠它，否则
        // "重建"这件事只能看代码，看不出运行时有没有真的发生。
        world: { alive: true, builds: worldBuilds, disposals: worldDisposals },
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
          // ★ M3-BUG-01：这个字段曾被当成"玩家穿墙"的判据用，但它是
          //   **第 0 层的快照**（`level.isBlockedCell` 只查一层墙体）。
          //   两层地图上"一层是墙、二层是楼面"是常态（楼板压墙）：tv_station_01 的
          //   44 个二层容器里就有 6 个正落在这种格上 —— 站在那里的二层玩家会被
          //   判成"在墙里"。它以 `player.cellBlocked` 的名义被 smoke.mjs 的
          //   十局稳定性测试当作**致命**判据使用，于是 DoD 测试会报出并不存在的问题。
          //
          //   现在两者分开：
          //     cellBlocked —— "这一格在本层是不是实心"，回答**站位是否合法**；
          //     embedded    —— "玩家的身体是否插在实体内部"，回答**有没有穿模**。
          //   真正的穿墙判据是后者（见 debug 区块的 embedded 字段）。
          cellBlocked: level.isBlockedCell(
            Math.floor(player.state.pos.x / level.cell),
            Math.floor(player.state.pos.z / level.cell)
          ),
          embedded: (() => {
            const cx = Math.floor(player.state.pos.x / level.cell);
            const cz = Math.floor(player.state.pos.z / level.cell);
            if (level.isRampCell(cx, cz)) return false; // 坡面不是盒子，交给表面插值
            const spans = level.spans;
            const r = level.spanRange(cx, cz);
            if (!r) return true; // 越界按墙处理（与 level.tallestSolidTopAt 一致）
            for (let s = r[0]; s < r[1]; s++) {
              // 脚底在跨度内部、且该跨度还向上延伸 ≥0.2m → 人是插进去的，不是站上去的
              if (
                spans.y0[s] < player.state.pos.y - 1e-4 &&
                spans.y1[s] > player.state.pos.y + 0.2
              ) {
                return true;
              }
            }
            return false;
          })(),
          armor: {
            head: { id: player.vitals.armor.head.id, durability: +player.vitals.armor.head.durability.toFixed(1) },
            body: { id: player.vitals.armor.body.id, durability: +player.vitals.armor.body.durability.toFixed(1) },
          },
          using: player.isUsing(),
          // ★ [M6-BUG-02] 读条的可观测面：进度必须与 using 同步出现、单调递增到 1。
          //   端到端断言靠它验证"按 4 的读条异常"不再复发（此前它带着暂停时长的偏移）。
          useProgress: +player.useProgress(raidClock(performance.now())).toFixed(4),
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
            // ★ M6：空手时 id/label 有明确取值（null / 空手），而不是靠"一定有枪"。
            //   端到端因此能断言"缺件进局不会崩，且状态是可读的"。
            id: w.def.id,
            label: w.def.label,
            hasWeapon: !!w.def.id,
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
          // M3-1b-2 ③ 起 AI 有明确的层：不暴露 y 就无法断言"它真的上楼了"，
          // 只能看水平距离 —— 而水平距离在一层正下方与真的在楼上是一样的。
          y: a.position.y,
          floor: level.floorOfY(a.position.y),
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
        // M4-3：结算结果（纯函数产物）。暴露它是为了让端到端断言能验证
        // "带出/损失/保险箱"与幂等重放，而不是只检查界面上有没有字。
        raidResult: lastRaidResult,
        loot: {
          opened: loot.openedCount(),
          total: loot.containers.length,
          // 字段名沿用（smoke.mjs 的"搜到物品并产生估值"断言依赖它），
          // 数据源从 loot 内部数组换成 M3-5 的 inventory。
          // ★ M6：口径仍是**战利品件数**（不含自己带的弹药药品）——
          //   若把它改成"全部条目"，"新局背包为空"这类断言会被自带品顶掉，
          //   也就是一条检查悄悄变成永远为假。
          inventory: inventory.lootCount,
          value: inventory.value(),
          bag: { used: inventory.usedSlots(), total: inventory.totalSlots(),
                 rigTotal: inventory.rigTotalSlots(),
                 kitSlots: inventory.kitSlots(), lootSlots: inventory.lootSlots(),
                 weightKg: +inventory.weightKg().toFixed(2), limitKg: inventory.weightLimitKg,
                 backpackId: inventory.backpack.id, rigId: inventory.rig ? inventory.rig.id : null },
          safe: { value: inventory.safeValue(), tier: inventory.safeTier.id },
          byType: loot.countByType(),
        },
        consumables: consumablesSnapshot(),
        // M4-1：开放状态随撤离点一起暴露，端到端断言才能验证"条件点在该开的时候开"。
        extract: extract.zones.map((z) => ({
          x: z.x, z: z.z, r: z.radius, progress: z.progress, floor: z.floor,
          rule: z.openRule ? z.openRule.type : 'always',
          open: z.open.open, reason: z.open.reason, opensInMs: z.open.opensInMs,
          remainingKills: z.open.remainingKills,
        })),
        // M4-2：中断状态暴露给端到端断言。
        // 注意 `ex` 是帧内局部变量（每帧重建），DEV 接口在模块级拿不到它，
        // 所以沿用 kills 那样的做法：帧内把最近一次结果记到模块级变量。
        extractInterrupt: {
          leaveMs: lastExtract ? lastExtract.leaveMs : 0,
          cause: lastExtract && lastExtract.interrupted ? lastExtract.interrupted.cause : null,
        },
        scheduler: {
          processedLastFrame: scheduler.stats.processedThisFrame,
          peakQueriesPerFrame: scheduler.stats.peakQueriesPerFrame,
          peakFrameMs: +scheduler.stats.peakFrameMs.toFixed(3),
          totalProcessed: scheduler.stats.totalProcessed,
          pending: scheduler.pendingCount(),
        },
        audio: {
          unlocked: audio.isUnlocked(),
          gain: audio.currentGain(),
          buses: audio.busGains(),
          ...audio.stats,
        },
        // M5-8：画质档位实际生效的参数（断言读它，而不是读"我以为设成了什么"）
        quality: qualityState,
        decals: decals.placedTotal,
        // M6-2：可搜刮的尸体数（断言击杀真的掉东西用）
        corpses: loot ? loot.corpseCount() : 0,
        level: { W: level.W, cell: level.cell, free: level.free.length, walls: level.wallCount,
                 cover: level.coverList.length, stepHeight: level.stepHeight },
      };
    },

    /**
     * @param {number} x
     * @param {number} z
     * @param {number} [floor] 目标层（缺省 0）。
     *   两层地图落地后这一参数是必需的：写死 y=0 会把玩家放到**一层地面**，
     *   而二层的容器/撤离点都在 3.6m 上 —— 那样任何"传送到二层对象"的测试
     *   实际测的都是一层，二层的内容永远不会被端到端覆盖到。
     */
    teleport(x, z, floor = 0) {
      const baseY = level.floorBaseY(floor);
      player.state.pos.x = x;
      player.state.pos.z = z;
      player.state.pos.y = baseY;
      player.state.vel.x = 0;
      player.state.vel.z = 0;
      player.state.vel.y = 0;
      // 传 stepHeight：低掩体不该把人挡在外面，传 0 会把玩家推离掩体格
      level.resolveCircle(player.state.pos, cfg.player.radius, baseY, cfg.player.bodyHeight, cfg.player.stepHeight);
      // 若落点正好在掩体顶上，直接站上去（否则会先"陷进去"再由台阶吸附弹出）。
      // feetY 用 baseY：从一层地面问的话，二层的楼板会被当成"迈不上去的实体"而算错。
      player.state.pos.y = level.surfaceAt(player.state.pos.x, player.state.pos.z, baseY, cfg.player.stepHeight);
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
      // ★ M6-2：目标 AI **可能在二层**（M6-2 起二层也布 AI）。本夹具原先有两处分层盲区：
      //   ① 可走性用扁平的 `level.isBlockedCell`（只有第 0 层）
      //   ② 落位后玩家的 y 在第 0 层
      //   于是"玩家在一层、AI 在二层"时，32 个角度候选**全部**因为楼板挡住视线而失败，
      //   夹具返回 null，冒烟在 `shot.aiId` 上崩掉（表现为"测试执行未中断"失败）。
      //   现在按目标 AI 所在的层判定可走性、并把玩家传送到**同一层**。
      const floor = level.floorOfY(a.position.y);
      const targetY = a.position.y + cfg.hitZones.chest.centerY;
      const eyeY = level.floorBaseY(floor) + cfg.player.eyeHeight;
      const CELLS = level.W * level.H;
      const navBlocked = level.nav.blocked;
      const walkableAt = (cx, cz) =>
        cx >= 0 && cz >= 0 && cx < level.W && cz < level.H &&
        navBlocked[floor * CELLS + cz * level.W + cx] === 0;
      // 距离也备几档：16 名 AI 会让"某个 AI 周围 12m 恰好没有合法落点"变得常见
      for (const d of [dist, dist * 0.7, dist * 1.4]) {
        for (let k = 0; k < 32; k++) {
          const ang = (k / 32) * Math.PI * 2;
          const x = a.position.x + Math.cos(ang) * d;
          const z = a.position.z + Math.sin(ang) * d;
          if (!walkableAt(Math.floor(x / level.cell), Math.floor(z / level.cell))) continue;
          if (!level.hasLineOfSight(x, eyeY, z, a.position.x, targetY, a.position.z)) continue;
          this.teleport(x, z, floor);
          this.aimAt(a.position.x, targetY, a.position.z);
          return {
            x, z, dist: d, angleDeg: Math.round((ang * 180) / Math.PI),
            aiId: a.id, tier: a.tier.id, floor,
          };
        }
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
    /**
     * 立刻淘汰一名 AI（不造成其它副作用），供测试制造"击杀计数"。
     *
     * ★ [M4-BUG-01] 这里曾经**一调就抛异常**，而且从 M0~M2 那次提交起就是这样：
     *   `damage` 写的是一个标量（`maxHealth * 10`），而 `core/ballistics.js` 的
     *   `rawZoneDamage()` 取的是**按部位的对象** `weapon.damage[zone]` ——
     *   于是每次都抛 `[ballistics] 武器 debug 未定义部位 chest 的伤害`。
     *
     *   为什么一直没人发现：`verify-prod-bundle.mjs` 只校验"这个名字有没有被打进
     *   生产包"，**从不调用它**。于是它长期处于"已注册、已列入校验名单、一调就炸"
     *   的状态，直到 M4-1 给地图加了 `killsAfter` 撤离点（e4_archive）——
     *   那条规则需要"累计 3 杀"，而这是自动化里唯一能可靠制造击杀的手段，
     *   缺陷这才暴露（详见 docs/M4-TEMP-REGISTRY.md）。
     *
     * 修法：形状对齐真实武器（`weapons.json` 的 `damage` 就是 `{head, chest, stomach, limb}`），
     * 伤害取"远超最大生命"以保证一次命中必定淘汰 —— 它是夹具，不该被护甲/衰减影响。
     * 部位 ×10 而没有写死 10000：这样任何写入部位表的单位（点/百分比）都不会让它失效。
     */
    killOneAi() {
      const a = aiManager.ais.find((x) => !x.isDead);
      if (!a) return false;
      const lethal = a.vitals.maxHealth * 10;
      a.applyHitFrom(
        {
          id: 'debug',
          class: 'rifle',
          damage: { head: lethal, chest: lethal, stomach: lethal, limb: lethal },
          falloff: { startM: 1, endM: 2, minScale: 1 },
          pellets: 1,
          fireIntervalMs: 100,
        },
        { id: 'debug', damageScale: 1, armorPenetration: 9 },
        'chest',
        1,
        player.state.pos.x,
        player.state.pos.z,
        player.state.pos.y
      );
      // ★ 击杀计数必须显式补上（[M4-BUG-01] 的第二层）：
      //   `combatStats.kills` 原先只由武器的 hit 事件自增，而这个接口绕过了武器 ——
      //   于是 AI 确实死了，但"累计击杀数"仍是 0，依赖它的 killsAfter 撤离点开不了。
      //   这里一次补两处，与武器那条路径（main.js 的 hit 事件）做的事完全一致。
      aiManager.noteKill();
      syncKills();
      return true;
    },
    setSetting(key, value) {
      settings[key] = value;
      // M5-1：走与界面**同一条**下发路径（applySettings），不在这里另写一遍副作用 ——
      // 否则"从界面改"与"从接口改"会各有一套生效逻辑，迟早分叉。
      // 它本身不做合法性校验：非法取值会被 saveSettings 内部的 sanitize 丢掉，
      // 所以返回值是"落盘后的真值"，断言应以返回值为准。
      applySettings(settings, true);
      // 设置面板若正开着，同步重绘（改键/画质从接口改也要看得见 —— 与界面同一条路径）
      if (settingsOpen) renderSettingsNow();
      return { ...settings };
    },
    getSettings() {
      return { ...settings };
    },
    isPaused: () => isPaused,
    startRaid() {
      startRaid(performance.now());
    },
    /** M5-1：结算页 → 返回大厅（与界面按钮走同一条路径） */
    returnToLobby() {
      returnToLobby();
    },
    killPlayer() {
      player.takeDamage(9999);
    },
    /**
     * 主动放弃本局（跳过 UI，直接结束）。
     * 端到端走的是**真实 UI 流程**（点按钮 → 弹确认 → 确认），
     * 这个接口留作手动调试用：在控制台里一步触发"主动退出"这条结束路径。
     */
    abandonRaid() {
      endRaid(END_REASON.ABANDONED, raidClock(performance.now()));
    },
    /** 复活式回血，用于让长时稳定性测试能继续跑 */
    healPlayer(amount = 9999) {
      player.vitals.health = Math.min(player.vitals.maxHealth, player.vitals.health + amount);
      player.state.alive = true;
    },
    /**
     * 把生命**设为**指定值（测试夹具）。
     * 为什么需要它：`healPlayer` 只会加血，而 [M6-BUG-01] 的现场恰恰是"未满血、但高于
     * 绷带旧上限 45"这个血量区间（例如 60）—— 没有这个夹具，端到端就无法在真实血量上
     * 验证"按 3 能用绷带"，只能退化成读代码。
     */
    setHealth(hp) {
      player.vitals.health = Math.max(0, Math.min(player.vitals.maxHealth, Number(hp) || 0));
      player.state.alive = player.vitals.health > 0;
      return player.vitals.health;
    },
    /**
     * 增发消耗品（测试夹具）。
     * ★ M6：往**网格里真的放**（而不是改一个计数）—— 夹具必须走产品同一条路径，
     *   否则"网格满了放不下"这类缺陷会被夹具掩盖掉。
     * @returns {{bandage:number, medkit:number, rejected:number}} 实际放进去的数量
     */
    grantConsumables(bandage = 0, medkit = 0) {
      const before = consumablesSnapshot();
      let rejected = 0;
      for (const [id, n] of [['bandage', bandage], ['medkit', medkit]]) {
        const def = cfg.itemDefs[id];
        if (!def) continue;
        for (let i = 0; i < n; i++) {
          if (!inventory.tryAdd(def).ok) rejected++;
        }
      }
      const after = consumablesSnapshot();
      return { bandage: after.bandage - before.bandage, medkit: after.medkit - before.medkit, rejected };
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
    /**
     * 传送到一个未开启容器的旁边。
     * @param {number} [floor] 只找该层的容器（缺省不限）。
     *   `floor` 必须一并传给 teleport —— 否则二层容器会被"传送到它的一层正下方"，
     *   而 loot 按层判定，于是这条夹具**永远搜不到**二层那 44 个容器。
     * @returns {false|{floor:number}} 找不到容器返回 false
     */
    teleportToContainer(floor = null) {
      const c = loot.containers.find(
        (x) => !x.opened && (floor === null || x.floor === floor)
      );
      if (!c) return false;
      const ang = Math.random() * Math.PI * 2;
      this.teleport(c.x + Math.cos(ang) * 1.2, c.z + Math.sin(ang) * 1.2, c.floor);
      return { floor: c.floor, type: c.type };
    },
    /**
     * 传送到一个撤离点。
     * @param {number} [floor] 只找该层的撤离点（缺省取第一个）。
     *   两层地图的 e2_roof 在二层，缺省写法永远测不到它 —— 于是"二层能不能撤离"
     *   这条 M3 的必答项在端到端测试里从未被走过。
     */
    teleportToExtract(floor = null) {
      const z = extract.zones.find((x) => floor === null || x.floor === floor);
      if (!z) return false;
      this.teleport(z.x, z.z, z.floor);
      return { floor: z.floor, id: z.id };
    },
    setTimeLimitMs(ms) {
      cfg.raid.timeLimitMs = ms;
    },
    levelInfo() {
      return { W: level.W, cell: level.cell, free: level.free, walls: level.wallCount };
    },
    /** 容器清单（含**层号**）。给测试用：按层选夹具，避免"只测得到一层"。 */
    debugContainerList() {
      return loot.containers.map((c) => ({
        id: c.id, x: c.x, y: c.y, z: c.z, floor: c.floor, type: c.type, opened: c.opened,
      }));
    },
  };
}
