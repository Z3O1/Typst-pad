// localStorage 持久化：记住主题偏好、上次编辑内容与文件路径。
// 跨 dev（浏览器）与 Tauri（WebView2）环境一致；容量小（文档通常 <5MB）。

const STORAGE_KEY = "typst-pad:state";

export type ThemePreference = "system" | "dark" | "light";

export interface PersistedState {
  theme: ThemePreference;
  content: string;
  filePath: string | null;
  fileTitle: string | null;
  /** 编译/导出时是否自动在代码前插入前缀 */
  prefixEnabled: boolean;
  /** 前缀代码（插入到用户代码之前） */
  prefixCode: string;
  /** 所见即所得（编辑器内公式内联渲染）开关 */
  livePreview: boolean;
  /** 是否显示右侧预览栏（所见即所得形态为单栏） */
  showPreview: boolean;
}

/** 读取持久化状态；不存在或损坏时返回空对象 */
export function loadState(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const state = parsed as Partial<PersistedState>;
    // 兼容旧存档：新增字段缺失时补默认值
    if (state.prefixEnabled === undefined) state.prefixEnabled = false;
    if (state.prefixCode === undefined) state.prefixCode = "";
    // 旧存档没有该字段时默认开启（与「所见即所得」的产品默认值一致）
    if (state.livePreview === undefined) state.livePreview = true;
    // 未记录过预览栏开关时跟随形态：所见即所得 → 单栏
    if (state.showPreview === undefined) state.showPreview = !state.livePreview;
    return state;
  } catch {
    return {};
  }
}

/** 保存状态；存储不可用（隐私模式/配额超限）时静默失败 */
export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略：持久化失败不影响使用
  }
}

/** 清空持久化状态（用于"新建"） */
export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
