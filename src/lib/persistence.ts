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
  /** 界面模式：写作模式（仿 Typora）/ 源码模式 */
  viewMode: "write" | "source";
  /** 旧字段（0.6.0 前）：仅用于迁移到 viewMode */
  livePreview?: boolean;
  /** 是否显示右侧预览栏（所见即所得形态为单栏） */
  showPreview: boolean;
  /**
   * 上次会话结束时是否有未保存修改。恢复会话时据此还原脏标记：
   * 存过盘又没再改的文档恢复出来不该显示"未保存"圆点、也不该在关闭时追问。
   */
  dirty: boolean;
  /**
   * 启动时是否恢复上次未保存的内容（设置弹窗里的开关，默认开）。
   * 关掉后回到"每次全新开始"：只恢复主题/前缀/模式。
   */
  restoreSession: boolean;
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
    // 旧的 livePreview 布尔 → 模式（0.6.0 前存档）；新存档用 viewMode
    if (state.viewMode === undefined) {
      state.viewMode = state.livePreview === false ? "source" : "write";
    }
    // 未记录过预览栏开关时跟随模式：写作模式 → 单栏
    if (state.showPreview === undefined) state.showPreview = state.viewMode === "source";
    // 旧存档没有这两个字段：脏标记保守取 false（内容非空的恢复逻辑会另行判定），恢复会话默认开
    if (state.dirty === undefined) state.dirty = false;
    if (state.restoreSession === undefined) state.restoreSession = true;
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
