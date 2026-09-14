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
   * 源码模式的自动换行开关（Alt+Z 切换，见 word-wrap.ts）。
   * 与"是否显示预览栏"同属视图偏好，所以一起持久化；默认关（保持长行不折行的原有观感）。
   */
  editorWrap: boolean;
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
  /**
   * 启动时是否自动检查更新（设置弹窗里的开关，默认开）。
   * 只影响**自动**检查；菜单「帮助 → 检查更新…」始终可用。
   */
  autoCheckUpdates: boolean;
  /**
   * 上次检查更新的时间戳（ms）：**只是一条记录，不参与任何判定**。
   * 它曾经用来做跨启动节流（6 小时才自动查一次），2026-09-14 用户报「自动更新没法用」就是被它拦的
   * ——现在是"每次启动都查"，留这个字段只为了出问题时能看出上次检查发生在什么时候（见 update-utils.ts）。
   */
  lastUpdateCheckAt: number | null;
  /**
   * 用户点过更新弹窗里的「稍后」的时刻（ms）：**非 null = 以后别再自动弹更新窗**
   * （用户要求原话「不更新就再也别跳出来，直到点了检查更新」）。
   * 自动检查照常做（状态栏仍会出现「可更新到 vX」入口），但不再弹窗、也不改状态文字；
   * 手动检查 / 点状态栏入口 / 点「下载并安装」都会清掉它（见 update-utils.ts 的注解）。
   */
  updateDismissedAt: number | null;
  /**
   * 界面缩放系数（0.5~2.5，默认 1 = 100%），Ctrl+滚轮调整（见 zoom.ts）。
   * 走 webview 缩放（Tauri `setZoom`），启动时恢复并重新应用。
   */
  uiZoom: number;
  /**
   * 正文字体（中文）选择：空串 = 用内置默认（思源宋体优先，缺字回退系统宋体）。
   * 非空时是 FontBook 里的**英文族名**（如 "SimSun"、"Microsoft YaHei"），
   * 由设置里的下拉选择产生——手写族名极易写错，而 typst 对不存在的族名只发 warning 后静默回退。
   */
  chineseFont: string;
  /** 额外字体目录（对齐 typst CLI 的 --font-path）：与打包字体、系统字体一起注册进 FontBook */
  fontDirs: string[];
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
    // 源码模式自动换行（0.7.6 后的存档才有）：默认关
    if (state.editorWrap === undefined) state.editorWrap = false;
    // 旧存档没有这两个字段：脏标记保守取 false（内容非空的恢复逻辑会另行判定），恢复会话默认开
    if (state.dirty === undefined) state.dirty = false;
    if (state.restoreSession === undefined) state.restoreSession = true;
    // 自动更新（0.7.2 后的存档才有）：默认开；没检查过时时间戳为 null（→ 启动即检查一次）
    if (state.autoCheckUpdates === undefined) state.autoCheckUpdates = true;
    if (typeof state.lastUpdateCheckAt !== "number") state.lastUpdateCheckAt = null;
    // "点过稍后 = 别再自动弹更新窗"（0.7.7 之后的存档才有）：缺失 → null = 照常弹窗
    if (typeof state.updateDismissedAt !== "number") state.updateDismissedAt = null;
    // 界面缩放（旧存档没有）：默认 100%；只认数字，越界值交给调用方收敛（读档方用 zoom.clampZoom）
    if (typeof state.uiZoom !== "number" || !Number.isFinite(state.uiZoom)) {
      state.uiZoom = 1;
    }
    // 字体设置（旧存档没有）：正文字体默认空串 = 用内置默认列表；字体目录默认空
    if (typeof state.chineseFont !== "string") state.chineseFont = "";
    if (!Array.isArray(state.fontDirs)) state.fontDirs = [];
    return state;
  } catch {
    return {};
  }
}

/**
 * 把 `next` 里的**会话字段**换成 `previous` 里的那份。
 *
 * 存档只有一个 key，而多窗口（`Ctrl+Shift+N` 新建窗口）共享同一个 localStorage 源：
 * 副窗口是"空白草稿窗口"，它改设置（主题/字体/缩放…）时如果用自己那份空文档覆盖存档，
 * 主窗口那次会话就被一次无关的设置改动清掉了。所以副窗口写存档前先把会话字段搬过来。
 */
export function mergeSessionFields(
  next: PersistedState,
  previous: Partial<PersistedState>,
): PersistedState {
  return {
    ...next,
    content: typeof previous.content === "string" ? previous.content : "",
    filePath: typeof previous.filePath === "string" ? previous.filePath : null,
    fileTitle: typeof previous.fileTitle === "string" ? previous.fileTitle : null,
    dirty: previous.dirty === true,
  };
}

export interface SaveStateOptions {
  /**
   * `false` = 只写设置：先读回存档，把里面的会话字段（content / filePath / fileTitle / dirty）
   * 原样带过去。**副窗口（新建窗口）用它** —— 它没有自己的会话，不该动主窗口那一份。
   * 默认 `true`（主窗口：连会话一起写）。
   */
  session?: boolean;
}

/** 保存状态；存储不可用（隐私模式/配额超限）时静默失败 */
export function saveState(state: PersistedState, options: SaveStateOptions = {}): void {
  try {
    const payload = options.session === false ? mergeSessionFields(state, loadState()) : state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 忽略：持久化失败不影响使用
  }
}

/**
 * 清空持久化状态（用于"新建"）。
 * **只由主窗口调用**：它连会话一起清掉，而那份会话是主窗口的 —— 副窗口（新建窗口）里点"新建"
 * 绝不该把主窗口的未保存内容从存档里抹掉（见 mergeSessionFields）。
 */
export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
