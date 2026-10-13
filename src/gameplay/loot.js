// M3-3 容器分级、搜索进度、打断规则
// M3-4 掉落权重与稀有度表现（光束 / 音效档 / 颜色）
//
// 职责：容器摆放（按层）、按类型分级掉落、按住 F 搜索、打断规则、稀有度表现。
//
// 数值来源：`src/config/loot.json`（containers / rarity / items / interruptRules），
// 本文件不含任何掉落数字 —— 权重、件数、搜索耗时、打断规则全部读表。
// 抽稀有度与抽物品的**算法**来自 `src/core/lootTable.js`，
// 与 tools/validate-loot-tables.mjs 的理论统计同源（M3 DoD ① 的前提）。
//
// 已销账：
//   [M1-TEMP-9]  搜索打断规则 —— 已按容器档位从配置表读（lose_all / keep_partial）
//   [M1-TEMP-11] 容器开启后无表现变化 —— 已改为按类型着色 + 开启变暗 + 光束熄灭
//   （[M1-TEMP-10] 背包容量由独立的 src/gameplay/inventory.js 承接，见该文件）
//
// [M3-TEMP-1] 背包/负重满时，装不下的物品**留在容器里**，玩家只能靠近再按一次 F 重试。
//             **没有主动丢弃** —— 玩家无法主动腾出空间，于是"取舍"只能被动发生。
//             完整的拾取/丢弃要等 M5-2 的背包 UI（格子拖拽 + 丢弃确认）。
// [M3-TEMP-4] 钥匙房要求的 `keycard_armory` 目前只能靠随机掉落获得，
//             没有任务线发放，也没有"带钥匙进局"的概念 —— 钥匙房实际是可遇不可求。
// [M3-TEMP-5] 稀有度光束是纯色圆柱 InstancedMesh：无贴图、无淡出、无距离 LOD，
//             强度直接映射为柱高。属 M7 美术替换范围。
import * as THREE from 'three';
import { mulberry32 } from '../core/rng.js';
import { containerById, rarityById, rollItems, rollItemsFromDef, interruptRule } from '../core/lootTable.js';

// 容器分级的外观。尺寸与颜色只影响"一眼看出这是什么容器"，不参与任何数值。
const TYPE_STYLE = {
  crate_civil: { color: 0x9a7b4f, w: 1.1, h: 0.9, d: 0.8 },
  crate_military: { color: 0x5c6b47, w: 1.3, h: 1.0, d: 0.9 },
  safe: { color: 0x44545f, w: 1.0, h: 1.2, d: 1.0 },
  key_room: { color: 0x6d4340, w: 1.5, h: 1.3, d: 1.1 },
  // M6-2：AI 尸体。低、扁、宽 —— 一眼能与箱子区分开（"这是个人，不是个箱子"）。
  corpse: { color: 0x77302c, w: 0.9, h: 0.45, d: 1.5 },
};
const FALLBACK_STYLE = { color: 0x9a7b4f, w: 1.1, h: 0.9, d: 0.8 };

/**
 * @param {object} cfg 配置
 * @param {object} level 关卡（提供 cellToWorld / floorBaseY / floorOfY）
 * @param {object} scene three 场景
 * @param {object} [opts]
 * @param {(c:object, items:Array)=>void} [opts.onOpened] 开箱回调（入包与音效由调用方接线）
 * @param {(keyItemId:string)=>boolean} [opts.hasKey] 是否持有某钥匙物品
 */
export function createLoot(cfg, level, scene, opts = {}) {
  const table = cfg.lootTable;
  const L = cfg.loot;
  const rnd = mulberry32(cfg.level.seed + 4231);
  const onOpened = opts.onOpened || (() => {});
  const hasKey = opts.hasKey || (() => true);
  // M5-5：搜刮熟练技能提高搜索速度（>1 = 更快）。缺省 1 = 配置基线。
  const searchScale = opts.kit ? opts.kit.modifiers.searchSpeedScale : 1;
  /** 某类容器的实际搜索耗时（毫秒）—— 唯一的口径，进度条与完成判定都用它 */
  const searchMsOf = (def) => def.searchMs / searchScale;
  // 移动打断的判定半径：站在原地搜，走开就断。
  // 这个值**没有实测依据**，是我按"允许小幅走位但不允许跑开"选的，待评审裁定。
  const moveAbortM = L.moveAbortRadius ?? 1.0;

  const defs = L.containers;
  const N = defs.length;
  const rarityOrder = table.rarity.map((r) => r.id);

  // ★ M6-2：尸体是**运行时才出现**的容器，而 InstancedMesh 的实例数在创建时定死。
  //   因此这里预留一段"尸体槽位"，空槽用与光束相同的隐藏手法（缩放到 0.0001 挪走）。
  //   预留上限取「本局 AI 总数 + Boss」，由调用方传入 —— 不写死常量，
  //   否则 AI 配额一改这里就静默不够用。
  const CORPSE_SLOTS = Math.max(0, opts.corpseSlots | 0);
  const SLOTS = N + CORPSE_SLOTS;

  // ---- 容器本体：一个 InstancedMesh 装全部箱子 ----
  // 89 个容器若逐个 Mesh 提交会违反约束 C-5（静态几何必须实例化）。
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const boxMat = new THREE.MeshLambertMaterial({});
  const boxes = new THREE.InstancedMesh(boxGeo, boxMat, SLOTS);
  boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(boxes);

  // ---- 稀有度光束：另一个 InstancedMesh ----
  // 光束强度来自 rarity.beamIntensity（白 = 0，即不显示光束）。
  const beamGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 6, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false,
  });
  const beams = new THREE.InstancedMesh(beamGeo, beamMat, SLOTS);
  beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(beams);

  const mtx = new THREE.Matrix4();
  const col = new THREE.Color();
  const quat = new THREE.Quaternion();
  const vec = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const containers = defs.map((c, idx) => {
    const def = containerById(table, c.type);
    const style = TYPE_STYLE[c.type] || FALLBACK_STYLE;
    const w = level.cellToWorld(c.x, c.z);
    // 坐在**它所在那一层**的地面上（写死 0.45 会把二层的箱子摆到一层高度）
    const baseY = level.floorBaseY(c.floor);
    const y = baseY + style.h / 2;
    const items = rollItems(table, c.type, rnd);

    // 稀有度表现取容器内**最高**的那一档：它是"这个箱子值不值得冒险"的第一眼信号
    let topRarity = 'common';
    for (const it of items) {
      if (rarityOrder.indexOf(it.rarity) > rarityOrder.indexOf(topRarity)) topRarity = it.rarity;
    }
    const rarityDef = rarityById(table, topRarity);

    // 容器本体
    vec.set(w.x, y, w.z);
    scl.set(style.w, style.h, style.d);
    mtx.compose(vec, quat, scl);
    boxes.setMatrixAt(idx, mtx);
    col.setHex(style.color);
    boxes.setColorAt(idx, col);

    // 光束：强度 0（白）时不显示
    const beamH = rarityDef.beamIntensity * 4;
    if (beamH > 0) {
      vec.set(w.x, baseY + style.h + beamH / 2, w.z);
      scl.set(1, beamH, 1);
    } else {
      vec.set(w.x, -50, w.z); // 挪到看不见的地方（缩放到 0 会让矩阵退化）
      scl.set(0.0001, 0.0001, 0.0001);
    }
    mtx.compose(vec, quat, scl);
    beams.setMatrixAt(idx, mtx);
    col.set(rarityDef.colorHex);
    beams.setColorAt(idx, col);

    return {
      id: idx,
      x: w.x,
      y,
      z: w.z,
      floor: c.floor,
      type: c.type,
      def,
      style,
      rarity: topRarity,
      beamIntensity: rarityDef.beamIntensity,
      dropSoundTier: rarityDef.dropSoundTier,
      colorHex: rarityDef.colorHex,
      items,
      opened: false,
      progress: 0,
    };
  });
  boxes.instanceMatrix.needsUpdate = true;
  if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  beams.instanceMatrix.needsUpdate = true;
  if (beams.instanceColor) beams.instanceColor.needsUpdate = true;

  // 尸体槽位先全部隐藏（见 CORPSE_SLOTS 的说明）。用与光束相同的"缩到 0.0001 挪走"手法 ——
  // 缩放到 0 会让矩阵退化。
  {
    vec.set(0, -50, 0);
    scl.set(0.0001, 0.0001, 0.0001);
    mtx.compose(vec, quat, scl);
    for (let k = N; k < SLOTS; k++) {
      boxes.setMatrixAt(k, mtx);
      beams.setMatrixAt(k, mtx);
      col.setHex(0x000000);
      boxes.setColorAt(k, col);
      beams.setColorAt(k, col);
    }
    boxes.instanceMatrix.needsUpdate = true;
    beams.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
  }

  // ---- M6-2：AI 尸体 ----
  //
  // 尸体就是"运行时长出来的一具可搜刮容器"，因此它**完全复用**容器的
  // 选中 / 搜索进度 / 打断 / 入包路径（见下方 update 的 nearest 查找，它只按
  // `containers` 与层号筛选，不区分类型）。唯一的差别是三件事：
  //   · 掉落表按**兵种**取（`corpseByTier`），而不是容器类型
  //   · def 在这里现构 —— 刻意**不**往 lootTable.containers 里加一个 corpse 类型，
  //     那样它的 rarityWeights 永远不会被读到，属于死配置
  //   · 槽位来自预分配池，用尽时复用最早的一具并**记警告**（不静默丢弃）
  const corpseTable = table.corpseByTier || {};
  let corpseSeq = 0;

  /**
   * 在某处生成一具可搜刮的尸体。
   * @param {number} x @param {number} z @param {number} floor
   * @param {string} tierId 兵种 id（决定掉落表与外观强度）
   * @returns {object|null} 生成的容器对象；该兵种没配掉落表时返回 null
   */
  function spawnCorpse(x, z, floor, tierId) {
    const spec = corpseTable[tierId];
    if (!spec) return null; // 没配掉落表的兵种不生成（AI 表校验器会拦住这种表）

    let slot;
    if (corpseSeq < CORPSE_SLOTS) {
      slot = N + corpseSeq++;
    } else {
      // 槽位用尽：复用**最早**的那一具（它的东西多半还在，但比"不生成"更不容易误导玩家）
      const idx = containers.findIndex((c) => c.type === 'corpse');
      if (idx < 0) return null;
      console.warn('[loot] 尸体槽位已用尽，复用最早的一具');
      slot = containers[idx].id;
      containers.splice(idx, 1);
    }

    const style = TYPE_STYLE.corpse;
    const baseY = level.floorBaseY(floor);
    const y = baseY + style.h / 2;
    const def = {
      id: 'corpse',
      label: '尸体',
      // 搜索耗时与打断规则来自 corpseByTier 的同级字段（与 containers 的定义方式一致）
      searchMs: corpseTable.searchMs ?? 1800,
      interruptRule: corpseTable.interruptRule ?? 'keep_partial',
      requiresKey: null,
      itemsMin: spec.itemsMin,
      itemsMax: spec.itemsMax,
      rarityWeights: spec.rarityWeights,
    };
    // ★ 抽表复用 core/lootTable.js 的同一段实现（不另写一份 —— 算法同源是硬要求）
    const items = rollItemsFromDef(table, def, rnd);

    vec.set(x, y, z);
    scl.set(style.w, style.h, style.d);
    mtx.compose(vec, quat, scl);
    boxes.setMatrixAt(slot, mtx);
    col.setHex(style.color);
    boxes.setColorAt(slot, col);
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;

    const c = {
      id: slot, x, y, z, floor, type: 'corpse', def, style,
      // 尸体不发稀有度光束：光束是"这箱子值不值得冒险"的第一眼信号，
      // 而尸体已经用"我打死了他"回答了这个问题。
      rarity: null, beamIntensity: 0, dropSoundTier: 0, colorHex: '#77302c',
      items, opened: false, progress: 0, tierId,
    };
    containers.push(c);
    return c;
  }

  let activeContainer = null;
  let searchAnchor = null;
  let prevInteract = false;

  function hideBeam(c) {
    vec.set(c.x, -50, c.z);
    scl.set(0.0001, 0.0001, 0.0001);
    mtx.compose(vec, quat, scl);
    beams.setMatrixAt(c.id, mtx);
    beams.instanceMatrix.needsUpdate = true;
  }

  function dimContainer(c) {
    vec.set(c.x, c.y, c.z);
    scl.set(c.style.w, c.style.h, c.style.d);
    mtx.compose(vec, quat, scl);
    boxes.setMatrixAt(c.id, mtx);
    col.setHex(c.style.color).multiplyScalar(0.45);
    boxes.setColorAt(c.id, col);
    boxes.instanceMatrix.needsUpdate = true;
    if (boxes.instanceColor) boxes.instanceColor.needsUpdate = true;
  }

  /**
   * @param {number} dt 秒
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {object} ctx 打断信号
   * @param {boolean} ctx.interact 按住 F
   * @param {boolean} ctx.firing  本帧开火
   * @param {boolean} ctx.damaged 本帧受击
   */
  function update(dt, playerPos, ctx = {}) {
    const { interact = false, firing = false, damaged = false } = ctx;
    // 只在同一层里找容器（判定不看 y 会隔层互搜，见 M3-1b-2 ④ 的修复）
    const playerFloor = level.floorOfY(playerPos.y);

    let nearest = null;
    let nearestD = Infinity;
    for (const c of containers) {
      // 已开且还有东西没拿走的（背包/负重满导致的遗留）仍然要能被选中 ——
      // 否则那些物品就凭空消失了，"拿不下"变成了"拿不到"。
      if (c.opened && c.items.length === 0) continue;
      if (c.floor !== playerFloor) continue;
      const d = Math.hypot(c.x - playerPos.x, c.z - playerPos.z);
      if (d < L.interactRange && d < nearestD) {
        nearestD = d;
        nearest = c;
      }
    }

    // ---- 打断：规则本体在配置表里，这里只做"查表 + 应用" ----
    let interrupted = null;
    if (activeContainer) {
      const rule = interruptRule(table, activeContainer.def.interruptRule);
      let abort = false;
      let cause = null;
      if (rule.abortOnDamage && damaged) { abort = true; cause = 'damage'; }
      if (!abort && rule.abortOnFire && firing) { abort = true; cause = 'fire'; }
      if (!abort && rule.abortOnMove && searchAnchor
        && Math.hypot(playerPos.x - searchAnchor.x, playerPos.z - searchAnchor.z) > moveAbortM) {
        abort = true; cause = 'move';
      }
      if (abort) {
        // keepFraction：lose_all = 0（白搜），keep_partial = 0.5（保留一半进度）
        activeContainer.progress = Math.max(0, activeContainer.progress * (rule.keepFraction || 0));
        interrupted = {
          container: activeContainer,
          rule: activeContainer.def.interruptRule,
          cause,
          keptProgress: activeContainer.progress,
        };
        activeContainer = null;
        searchAnchor = null;
      }
    }

    // 换目标或松手：清零（M1-TEMP-9 的残留行为，规则表没覆盖这两种情形）
    if (activeContainer && (activeContainer !== nearest || !interact)) {
      activeContainer.progress = 0;
      activeContainer = null;
      searchAnchor = null;
    }

    // ---- 推进搜索 ----
    let justOpened = null;
    let blockedByKey = null;
    let pickedUp = null;

    if (nearest && nearest.opened) {
      // 已开容器：按一下 F（**边沿**，不是按住）就再试一次把遗留物装走。
      // 用边沿是因为按住会每帧触发一次，看不出"我按了几次"。
      if (nearest.items.length > 0 && interact && !prevInteract) {
        onOpened(nearest, nearest.items);
        pickedUp = nearest;
      }
    } else if (nearest && interact) {
      if (nearest.def.requiresKey && !hasKey(nearest.def.requiresKey)) {
        // 需要钥匙但没带：不推进进度，也不静默 —— 把原因交出去让 HUD 说清楚
        blockedByKey = { container: nearest, key: nearest.def.requiresKey };
      } else {
        if (!activeContainer) {
          activeContainer = nearest;
          searchAnchor = { x: playerPos.x, z: playerPos.z };
        }
        activeContainer.progress += dt * 1000;
        if (activeContainer.progress >= searchMsOf(nearest.def)) {
          nearest.opened = true;
          nearest.progress = searchMsOf(nearest.def);
          dimContainer(nearest);
          hideBeam(nearest);
          justOpened = nearest;
          activeContainer = null;
          searchAnchor = null;
          onOpened(nearest, nearest.items);
        }
      }
    }

    prevInteract = interact;
    return { nearest, activeContainer, justOpened, interrupted, blockedByKey, pickedUp };
  }

  return {
    containers,
    boxes,
    beams,
    update,
    /** M6-2：生成一具可搜刮的尸体（掉落表按兵种取） */
    spawnCorpse,
    /** M6-2：本局已生成的尸体数（诊断与断言用） */
    corpseCount: () => containers.filter((c) => c.type === 'corpse').length,
    openedCount: () => containers.filter((c) => c.opened).length,
    remaining: () => containers.filter((c) => !c.opened).length,
    /** 各类容器的数量（用于核对与地图表的容器预算是否一致） */
    countByType: () => {
      const out = {};
      for (const c of containers) out[c.type] = (out[c.type] || 0) + 1;
      return out;
    },
  };
}
