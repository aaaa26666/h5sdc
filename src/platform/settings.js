// 本机偏好设置：加载 / 校验 / 保存
//
// 重要定位说明：这不是"游戏存档"。
//   游戏存档（仓库、等级、任务、货币）属 M5-7，在 platform/profileStore.js +
//   core/profile.js 里，带版本号与迁移规则。本文件只处理**本机偏好设置**：
//   画质、灵敏度、音量、操作方式、键位。它不进档案、不参与迁移 ——
//   因为"换台机器后鼠标灵敏度应该跟着走吗"的答案显然是否（键位则不一定，见下）。
//
// [M1-TEMP-17] 用 localStorage 持久化偏好设置。**已补重置入口**（M5-8 设置面板里的
//              「恢复默认」），因此该条已销账。
// [M1-TEMP-19] **改键已实现**（M5-8）：合法性与冲突规则在 core/keybinds.js，
//              它把约束 C-19（拒绝 Ctrl/Alt/Meta 组合）做成**拒绝**而不是提示。
//              [M5-TEMP] 鼠标键（开火/开镜）仍不可改，属 M6+。
//
// ★ M5-1 变更：合法取值与默认值改由**配置表**决定（tunables.settings.schema）。
//   M5-8 追加：type='keymap' 的设置项（bindings）走 core/keybinds.js 的校验，
//   而"档位 → 倍率"的映射由表里的 levelsKey 声明（此前映射表名硬编码在本文件与
//   校验器两处，加一个带倍率的档位要改代码）。

import { config } from '../config/index.js';
import { sanitizeBindings, resolveBindings } from '../core/keybinds.js';

const STORAGE_KEY = 'h5extract.settings.v1';

/** 配置表里的设置项定义。以 `_` 开头的键是注释，跳过（全项目统一约定）。 */
const SCHEMA_KEYS = Object.keys(config.settings.schema).filter((k) => !k.startsWith('_'));

const specOf = (key) => config.settings.schema[key];
const typeOf = (key) => specOf(key).type || 'enum';

function defaultOf(key) {
  // keymap 的默认值是空对象（"全部用默认键位"）。这里给一份**新对象**：
  // 冻结常量被调用方就地改写是这类配置最常见的污染源。
  return typeOf(key) === 'keymap' ? {} : specOf(key).default;
}

/** 默认设置（逐项取自配置表） */
export const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(SCHEMA_KEYS.map((k) => [k, defaultOf(k)]))
);

/**
 * 逐字段校验：只接受已知键且取值在配置表的枚举内，其余一律丢弃。
 * 为什么必须校验：localStorage 的内容是**外部输入** —— 玩家可以手动改、
 * 旧版本写入的结构可能与新版本不同、也可能被其他脚本污染。
 * 直接信任它会让游戏在启动时崩在一个坏值上。
 */
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of SCHEMA_KEYS) {
    if (typeOf(key) === 'keymap') {
      // 键位：只保留合法覆盖项。被拒绝的项不进设置 —— 界面会另外显示拒绝原因，
      // 而不是让一个非法绑定悄悄生效（那正是 C-19 要防的）。
      out[key] = sanitizeBindings(raw[key]).bindings;
      continue;
    }
    const v = raw[key];
    if (typeof v === 'string' && specOf(key).values.includes(v)) out[key] = v;
  }
  return out;
}

export function loadSettings() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(text));
  } catch {
    // 存储不可用（隐私模式/被禁用）或内容损坏：回落默认值，绝不因此中断游戏
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    // 存储写入失败不影响本局游玩，静默降级
  }
}

/** 恢复默认设置（M5-8 的"重置"入口，销 M1-TEMP-17）。 */
export function resetSettings() {
  const d = { ...DEFAULT_SETTINGS };
  saveSettings(d);
  return d;
}

/**
 * 档位 → 倍率的**唯一**换算。
 *
 * 表里用 levelsKey 声明这一项对应哪张倍率表，因此加一档只改表。
 * 不做缺省兜底：sanitizeSettings 保证取值合法，配置表结构由启动期校验保证完整。
 */
export function levelScale(key, value) {
  const spec = specOf(key);
  if (!spec || !spec.levelsKey) return 1;
  return config.settings[spec.levelsKey][value];
}

/**
 * 鼠标灵敏度倍率：档位字符串 → 数值。
 *
 * **只在这里换算一次**。运行时（player.js）与诊断读数必须用同一份换算结果，
 * 否则 M2-TEMP-1 的"视角变化里鼠标贡献了多少"会与实际转视角的量不一致。
 */
export function mouseSensScale(settings) {
  return levelScale('mouseSens', settings.mouseSens);
}

/** 主音量倍率（总线）。实际增益 = audio.masterGain × 本值 × 分轨倍率（见 audio.js）。 */
export function volumeScale(settings) {
  return levelScale('masterVolume', settings.masterVolume);
}

/** 音效分轨倍率（M5-8） */
export function sfxVolumeScale(settings) {
  return levelScale('sfxVolume', settings.sfxVolume);
}

/** 音乐分轨倍率（M5-8；BGM 属 M7，此处先把总线接上，避免"分轨是假的"） */
export function musicVolumeScale(settings) {
  return levelScale('musicVolume', settings.musicVolume);
}

/**
 * 画质档位的**参数对象**（{shadows, shadowMapSize, pixelRatioMax}）。
 *
 * 与其它档位不同：它的值不是"一个倍率"而是一张参数表，因此走 schema 的
 * `tableKey` 声明（校验器会保证表覆盖了每一个档位）。加一档只改表，不改代码。
 */
export function qualityParams(settings) {
  const spec = specOf('graphicsQuality');
  return config.settings[spec.tableKey][settings.graphicsQuality];
}

/** 某设置项的全部合法档位（界面按它排版，而不是在 HTML 里手写选项） */
export function settingsValues(key) {
  return specOf(key).values.slice();
}

/** 当前生效的完整键位表（默认 + 玩家覆盖） */
export function bindingsOf(settings) {
  return resolveBindings(settings);
}

export { STORAGE_KEY };
