// 玩家设置：加载 / 校验 / 保存
//
// 重要定位说明：这不是"游戏存档"。
//   游戏存档（仓库、进度、任务）属 M5 范围，且必须遵守 M0-TECH-02 的要求：
//   带版本号 + 迁移规则 + 幂等结算。本文件只处理**本机偏好设置**。
//
// [M1-TEMP-17] 用 localStorage 持久化偏好设置，且没有任何 UI 层面的"重置"入口。
//              M5 接入正式存档体系时应一并接管设置项，并与账号绑定。
//
// [M1-TEMP-19] 设置项只有"冲刺/蹲下 的按住与切换"，**没有按键自定义（改键）**。
//              改键属 M2 范围，且实现时**必须**遵守 M0-TECH-01 约束 C-19：
//              拒绝一切 Ctrl/Alt/Meta 组合 —— 这类组合由浏览器保留、页面无法拦截，
//              绑定它会让玩家一按键就关闭页面（M1 已真实发生过，见 M1 报告 2.6）。
//
// 为什么必须校验：localStorage 的内容是**外部输入** ——
//   玩家可以手动改、旧版本写入的结构可能与新版本不同、也可能被其他脚本污染。
//   直接信任它会让游戏在启动时崩在一个坏值上（例如 mode 值是 undefined
//   或不是 'hold'/'toggle'）。因此一律"逐字段校验 + 不合法即回落默认值"，
//   而不是 try/catch 一个 JSON.parse 就完事。

const STORAGE_KEY = 'h5extract.settings.v1';

/** 允许的取值。任何不在枚举内的值都会被拒绝并回落默认值 */
const ENUMS = {
  sprintMode: ['hold', 'toggle'],
  crouchMode: ['hold', 'toggle'],
};

export const DEFAULT_SETTINGS = Object.freeze({
  sprintMode: 'hold',
  crouchMode: 'hold',
});

/** 逐字段校验：只接受已知键且取值在枚举内，其余一律丢弃 */
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = raw[key];
    if (typeof v === 'string' && ENUMS[key].includes(v)) out[key] = v;
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

export { STORAGE_KEY };
