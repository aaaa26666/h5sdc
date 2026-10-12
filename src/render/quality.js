// M5-8 画质档位的应用（表现层）
//
// 职责：把配置表里的档位参数**应用到渲染器上**，并返回实际生效的值。
//
// 为什么要把"档位 → 参数"放在配置表而不是这里：
//   它是策划/性能数值（阴影尺寸、像素比上限），改它不该改代码。
//   本文件只做"把参数装上去"这一件事 —— 参数由调用方从
//   `tunables.settings.qualityTable[settings.graphicsQuality]` 取来。
//
// ★ 一条明确的限制（写在代码里，免得被当成 bug）：
//   抗锯齿 `antialias` 是 WebGLRenderer 的**构造参数**，运行时改不了。
//   三档都不动它，配置表里也刻意没有这个字段。
//
// ★ 阴影尺寸变更需要**释放旧的 shadow map**：three.js 只在 map 为 null 时按
//   新的 mapSize 重建。不释放的话，改档位后阴影分辨率不会变 ——
//   而界面上"档位已经变了"，是一类看不见的假生效。

/**
 * 应用画质档位。
 * @param {object} renderer THREE.WebGLRenderer
 * @param {object} sun THREE.DirectionalLight（投影光源）
 * @param {object} params qualityTable 的某一档 { shadows, shadowMapSize, pixelRatioMax }
 * @param {number} devicePixelRatio 当前的 window.devicePixelRatio
 * @returns {{shadows:boolean, shadowMapSize:number, pixelRatioMax:number, pixelRatio:number}}
 *          实际生效的值（断言读它，而不是读"我以为设置成了什么"）
 */
export function applyQuality(renderer, sun, params, devicePixelRatio) {
  if (!params) throw new Error('[quality] 缺少画质参数（配置表的 qualityTable 没有这一档）');

  // 像素比：上限来自表，实际取 min(设备 DPR, 上限)
  renderer.setPixelRatio(Math.min(devicePixelRatio, params.pixelRatioMax));

  // 阴影：开着才设置尺寸；关掉时把 castShadow 也关掉（省掉一次阴影 pass）
  renderer.shadowMap.enabled = params.shadows;
  sun.castShadow = params.shadows;
  if (params.shadows) {
    sun.shadow.mapSize.set(params.shadowMapSize, params.shadowMapSize);
    // 释放旧贴图 → three 会按新尺寸重建（见文件顶部说明）
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }
  // 阴影开关变化后需要重算一次，否则本帧仍用旧的阴影贴图
  renderer.shadowMap.needsUpdate = true;

  return {
    shadows: renderer.shadowMap.enabled,
    shadowMapSize: sun.shadow.mapSize.x,
    pixelRatioMax: params.pixelRatioMax,
    pixelRatio: renderer.getPixelRatio(),
  };
}
