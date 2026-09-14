<script lang="ts">
  import { onMount, tick } from "svelte";
  import Editor from "$lib/Editor.svelte";
  import {
    compileToSvg,
    compileToPdf,
    compileMath,
    listFontFamilies,
    defaultFontFamilies,
  } from "$lib/typst-engine";
  import type { CompileErrorLocation, Diagnostic, MathRender } from "$lib/typst-engine";
  import { buildFontFamilies, FONT_CHOICE_DEFAULT, normalizeFontDirs } from "$lib/font-settings";
  import { describeCompileWarning } from "$lib/font-warnings";
  import type { MathRequest } from "$lib/live-preview";
  import type { WriteCommand } from "$lib/write-commands";
  import {
    openTypFile,
    saveTypFile,
    readTypFile,
    pickTypPath,
    pickFontDir,
    isTauri,
  } from "$lib/file-ops";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { loadState, saveState } from "$lib/persistence";
  import { isEffectiveDirty, ensureTrailingNewline } from "$lib/doc-utils";
  import MenuBar from "$lib/MenuBar.svelte";
  import type { MenuGroup } from "$lib/MenuBar.svelte";
  import ContextMenu from "$lib/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/ContextMenu.svelte";
  import {
    resolveContextZone,
    previewSelectionHasContent,
    buildContextMenuItems,
    type ContextZone,
    type ContextMenuItemSpec,
  } from "$lib/context-menu-utils";
  import { clearState } from "$lib/persistence";
  import {
    buildErrorListItems,
    formatErrorLoc,
    formatCompileFailMessage,
    hasErrorToShow,
    isErrorLineInPrefix,
    prefixLineCharOffset,
    type ErrorListItem,
    type LocatedErrorItem,
  } from "$lib/error-list";
  import { mark, reportStartup } from "$lib/startup-timing";
  import { dbg, setCliDebug } from "$lib/debug";
  import { clampPopoverRect } from "$lib/popover-utils";
  import {
    isReflowApplied,
    previewCanvasWidth,
    previewPageWidthPt,
    reflowCanvasWidth,
    viewBoxWidthPt,
  } from "$lib/preview-scale";
  import {
    checkForUpdate,
    downloadAndInstallUpdate,
    closeUpdate,
    type AvailableUpdate,
  } from "$lib/updater";
  import {
    AUTO_CHECK_DELAY_MS,
    UPDATE_DISMISS_NOTICE,
    formatBytes,
    formatProgress,
    isUpdatePromptSuppressed,
    type DownloadProgress,
  } from "$lib/update-utils";
  import { renderUpdateNotes } from "$lib/update-notes";
  import {
    ZOOM_DEFAULT,
    ZOOM_CONFIRM_DELAY_MS,
    zoomFromWidths,
    clampZoom,
    nextZoom,
    zoomApplied,
    zoomIn,
    zoomLabel,
    zoomOut,
  } from "$lib/zoom";
  import { WRAP_SOURCE_ONLY_NOTICE, isWrapToggleKey, wrapNotice } from "$lib/word-wrap";

  // 新建时默认空白文档（不再预填示例内容）
  const SAMPLE_DOC = "";

  // 浏览器 gate：已移除浏览器支持（编译走 Tauri 进程内原生命令），
  // 非 Tauri 环境（无 __TAURI_INTERNALS__）不渲染应用 UI，仅显示提示页
  const isDesktopApp = isTauri();

  // 启动打点：组件脚本求值时刻（JS chunk 加载后的首个可测点）
  mark("page-module-eval");

  /** Editor 组件实例方法（bind:this 获取，右键菜单调用） */
  interface EditorHandle {
    hasSelection(): boolean;
    selectAll(): void;
    execCommand(cmd: "cut" | "copy" | "paste"): void;
    /** 写作模式的格式命令（见 write-commands.ts） */
    runWriteCommand(command: WriteCommand): void;
    /** 切换模式前记下光标在视口里的高度（用户要求：切换模式不改变光标位置，见 Editor.svelte） */
    captureCaretAnchor(): void;
  }

  /** MenuBar 组件实例方法（右键菜单弹出前联动收起） */
  interface MenuBarHandle {
    closeMenus(): void;
  }

  let fileTitle = $state("未命名.typ");
  let dirty = $state(false);
  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let statusText = $state("就绪");
  let theme: "system" | "dark" | "light" = $state("system");
  let resolvedTheme: "dark" | "light" = $state("dark");

  // $state：窗口标题 effect 依赖内容——输入过又删光后 dirty 不变，须由内容变化驱动圆点实时清除
  let doc: string = $state(SAMPLE_DOC);
  // 编辑器文档的**镜像**：既作为"外部推送"通道（打开/新建/重读时赋新值 → 编辑器替换全文），
  // 也随每次输入同步（handleDocChange）。**必须保持镜像同步**：若只更新 doc，editorDoc 会停在
  // 上次打开/保存时的旧值，任何让 Editor 重挂载或让 props 重新生效的情形（窗口重载、组件树重建）
  // 都会把旧值当成"外部文档"推回去，表现为"切个模式未保存的新内容就退回上一个版本"。
  let editorDoc = $state(SAMPLE_DOC);
  let filePath: string | null = null;
  let previewStatus: "idle" | "ready" | "error" = $state("idle");
  let previewError = $state("");
  let pageCount = $state(0);
  let charCount = $state(0); // 字符数（状态栏右侧独立显示）
  let previewHost: HTMLElement;
  // 预览滚动容器（ResizeObserver 观测其宽度变化）；$state 避免 bind:this 的
  // non_reactive_update 警告（previewHost 属历史既有模式，此处新变量按新写法声明）
  let previewBodyEl = $state<HTMLElement>();
  let previewResizeObserver: ResizeObserver | undefined; // 容器尺寸监听（窗口/分栏变化时重算画布缩放）
  let previewScaleFrame = 0; // 已排队的重算帧号（见 onMount 里的 ResizeObserver）
  /**
   * 预览重排（用户 2026-09-14 选定）：预览栏多宽、纸张就多宽，让 Rust 侧按这个页宽（pt）
   * **重新排版**预览，画布因此恒 ≤ 栏宽 → 永不出现横向滚动条，且预览字号仍与编辑器一致。
   * 0 = 本次编译不重排（预览栏隐藏 / 不可测时走旧的等比缩放路径）。
   * 见 preview-scale.ts 的「预览按栏宽重新排版」一节。
   */
  let previewPageWidthRequest = 0;
  /** 最近一次编译请求的页宽（0 = 没请求）：判定产物是否真的重排了（文档自己 #set page 会覆盖） */
  let previewPageWidthUsed = 0;
  let previewReflowTimer: ReturnType<typeof setTimeout> | undefined;
  let compileSeq = 0; // 代次令牌：丢弃过期编译结果
  let dragActive = $state(false); // 拖放悬停中：显示覆盖层提示
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let showAbout = $state(false);
  // 关于弹窗版本号：运行时经 getVersion 异步读取（tauri.conf.json 的 version），
  // 未返回前显示占位符，避免每次发版漏更新硬编码版本号
  let appVersion = $state("");
  let showClosePrompt = $state(false); // 关闭确认弹窗（保存/不保存/取消）
  let showSettings = $state(false); // 设置弹窗（编译前缀代码）
  let editorDiagnostics = $state<CompileErrorLocation[]>([]); // 编译错误位置（传给编辑器画波浪线）
  let errorCount = $state(0); // 编译错误个数（状态栏徽标，常驻显示）
  let showErrors = $state(false); // 错误列表 Popover（点击状态栏徽标切换）
  // 自定义右键菜单：位置 + 条目；null 表示关闭
  let contextMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  let editorRef = $state<EditorHandle | null>(null); // Editor 组件实例（选区/剪贴板命令）
  let menuBarRef = $state<MenuBarHandle | null>(null); // MenuBar 组件实例（联动收起）
  let lastNonPosError = $state<string | null>(null); // 最近一次编译的非定位错误（无位置，如包不存在）
  let jumpSeq = 0; // 跳转代次：保证重复点击同一错误也触发跳转 effect
  let jumpTarget = $state<{ line: number; col: number; seq: number } | null>(null); // 编辑器跳转目标
  let errorWrapEl = $state<HTMLElement | undefined>(undefined); // 徽标 + Popover 的外层容器（锚点，供外部点击判定）
  let errorPopoverEl = $state<HTMLElement | undefined>(undefined); // 错误列表 Popover 元素（打开后测量收边）
  // Popover 视口收边结果（打开时计算一次）：transform 平移量 + 可选限宽，内联样式应用
  let errorPopoverClamp = $state({ translateX: 0, translateY: 0, maxWidth: 0 });
  let settingsPrefixTextarea = $state<HTMLTextAreaElement | undefined>(undefined); // 设置弹窗中的前缀代码 textarea（错误落前缀时定位）
  let prefixEnabled = $state(false); // 编译/导出前是否自动插入前缀
  let prefixCode = $state(""); // 前缀代码（插入到用户代码之前）
  /**
   * 界面模式（两套 UI）：
   * - "write"  写作模式（仿 Typora，默认）：整页纸张、衬线正文、无行号，公式与标记就地排版；
   * - "source" 源码模式：等宽代码编辑器 + 行号，直接编辑 Typst 源码，右栏整页预览。
   * 视图菜单 / Ctrl+/ 切换。
   */
  let viewMode = $state<"write" | "source">("write");
  // 是否显示右侧预览栏。所见即所得形态是**单栏**（Typora 式）：编辑区里已经是排版结果，
  // 右栏只是为了核对分页/整页效果才需要，故默认跟着 livePreview 走（开=单栏，关=双栏），
  // 也可以用视图菜单单独打开（例如所见即所得下仍想对照整页）。
  let showPreview = $state(false);
  /**
   * 源码模式的**自动换行**（Alt+Z 切换，VS Code 同款手势）。
   * 打开时长行折行显示（CodeMirror 的 `cm-lineWrapping`：`white-space: break-spaces` + 断词），
   * 不再需要横向滚动看完整行。默认关（保持代码编辑器原有的"长行横向滚动"观感），随存档持久化。
   * 只作用于源码模式：**写作模式始终折行**（文档形态，见 toggleEditorWrap 的注释），不读这个开关。
   */
  let editorWrap = $state(false);
  /**
   * 界面缩放系数（0.5~2.5，默认 1 = 100%），**Ctrl+滚轮**调（见 handleZoomWheel）。
   * 走 Tauri 的 webview 缩放（`setZoom`），效果等于浏览器 Ctrl+滚轮缩放：编辑区、预览、
   * 菜单、状态栏一起等比放大，CSS 像素不变——所以 CodeMirror 的行高测量与 SVG 预览的尺寸
   * 计算都不会错位。
   *
   * **为什么不用 CSS `zoom`**（2026-09-14 实测过一次，别再试）：在 `<html>` 上打 `zoom: 1.5`
   * 之后 `document.documentElement.scrollHeight` 会从 802 变成 1203（`height: 100%` 被一起
   * 放大）、状态栏被推到视口下方 401px，而且 `getBoundingClientRect()` 给的是**放大后**的 px
   * 而 `window.innerWidth` 仍是**未放大**的 px —— 两套单位混用会打烂右键菜单/popover 的定位。
   * webview 缩放发生在 CSS 层之下，所有这些单位都不动。
   */
  let uiZoom = $state(ZOOM_DEFAULT);
  /** 缩放的"再确认一次"定时器（见 applyUiZoom / scheduleZoomConfirm） */
  let zoomConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 我们对"引擎实际接受了多少缩放"的最佳估计（见 zoom.ts 的 zoomFromWidths）。
   * 启动校准（先设 100%）后为 1；每次调档都按 CSS 布局宽度重新估一遍。
   */
  let appliedZoom = 1;
  /** 100% 时的 CSS 布局宽度（视口宽度判据的基准）；改档/窗口尺寸变化后按当前档位再校一遍 */
  let zoomBaseline100 = 0;
  /** 正在设一次缩放并测量（期间不接受 resize 事件改基准——那是缩放自己引起的） */
  let zoomStepInFlight = false;
  /** 校准只做一次；并发调用共用同一个 promise */
  let zoomCalibration: Promise<void> | null = null;
  // 公式渲染缓存：key = mathCacheKey(body, display, context)（见 math-ranges.ts）；
  // Map 本身不需要响应式（变更后靠 mathVersion 代次通知编辑器重整装饰）
  const mathCache = new Map<string, MathRender>();
  // 已排队待渲染的 key（防止同一公式重复入队）；队列与定时器同理不需要响应式
  const mathPending = new Set<string>();
  let mathQueue: MathRequest[] = [];
  let mathTimer: ReturnType<typeof setTimeout> | undefined;
  let mathVersion = $state(0); // 渲染结果代次（自增即触发编辑器重整装饰）
  /** 公式渲染缓存条数上限（超出按插入顺序淘汰最早的） */
  const MATH_CACHE_LIMIT = 500;
  // 设置弹窗中的临时值（点“保存”才写回并持久化）
  let settingsPrefixEnabled = $state(false);
  let settingsPrefixCode = $state("");
  // ---------------------------------------------------------------------------
  // 字体设置（见 font-settings.ts / font-warnings.ts 的模块注释）
  // 起因：typst 默认正文是 Libertinus Serif（无汉字），不指定字体时中文全走自动回退，
  // 结果是 Windows 楷体/隶书、Linux 黑体日文字形（2026-09-14 实测）。Rust 侧注入默认字体族
  // 终结了这件事，这里只是把用户的选择与"额外字体目录"传下去。
  // ---------------------------------------------------------------------------
  /** 正文字体（中文）：空串 = 内置默认（思源宋体优先 + 系统宋体兜底） */
  let chineseFont = $state(FONT_CHOICE_DEFAULT);
  /** 额外字体目录（对齐 typst CLI 的 --font-path） */
  let fontDirs = $state<string[]>([]);
  let settingsChineseFont = $state(FONT_CHOICE_DEFAULT);
  let settingsFontDirs = $state<string[]>([]);
  /** 可用字体族（设置里下拉的数据源，打开设置时从 Rust 取一次） */
  let availableFonts = $state<string[]>([]);
  /** Rust 内置默认字体族（拼"选中项 + 其余兜底"用；启动时取一次） */
  let defaultFonts = $state<string[]>([]);
  let fontsLoading = $state(false);
  /** 编译警告（Rust 侧 warnings）：字体族写错只会以警告形式出现，必须显示出来 */
  let compileWarnings = $state<Diagnostic[]>([]);
  let showWarnings = $state(false);
  // 启动时恢复上次未保存的内容（设置弹窗里的开关，默认开；关掉即回到"每次全新开始"）
  let restoreSession = $state(true);
  let settingsRestoreSession = $state(true);

  // ---------------------------------------------------------------------------
  // 自动更新（tauri-plugin-updater；端点与签名公钥在 tauri.conf.json 的 plugins.updater）
  // ---------------------------------------------------------------------------
  /** 启动时自动检查更新（设置弹窗开关，默认开）。只影响自动检查，菜单里的手动检查始终可用 */
  let autoCheckUpdates = $state(true);
  let settingsAutoCheckUpdates = $state(true);

  /**
   * 更新流程状态机。刻意做成**单个对象**而不是若干布尔量：状态栏提示、弹窗内容、
   * 按钮可用性都由它派生，避免出现"弹窗开着但状态是 idle""下载中又是 available"这类
   * 自相矛盾的组合（更新流程有 7 个阶段，布尔量一多必然打架）。
   */
  type UpdateFlow =
    | { kind: "idle" }
    | { kind: "checking"; manual: boolean }
    | { kind: "latest" }
    | { kind: "available"; version: string; currentVersion: string; notes: string }
    | { kind: "downloading"; version: string; progress: DownloadProgress }
    | { kind: "installing"; version: string }
    | { kind: "error"; message: string };

  let updateFlow = $state<UpdateFlow>({ kind: "idle" });
  // 待安装的更新句柄：持有 Rust 侧资源（rid），不进响应式（模板不渲染它），换版本时 close
  let updateHandle: AvailableUpdate | null = null;
  let showUpdateDialog = $state(false);
  /** 上次检查更新的时间（持久化）：**只是记录，不参与判定**（诊断用，见 update-utils.ts 的注解） */
  let lastUpdateCheckAt: number | null = null;
  /**
   * 用户点过「稍后」的时刻（持久化）：有值 = 自动检查不再弹窗。
   * 用户要求原话「不更新就再也别跳出来，直到点了检查更新」——判定与清标记见
   * update-utils.isUpdatePromptSuppressed / 本文件的 dismissUpdatePrompt / clearUpdateDismissed。
   */
  let updateDismissedAt: number | null = null;
  let startupCheckTimer: ReturnType<typeof setTimeout> | undefined;

  /** 状态栏的更新提示（点击重开更新弹窗）；无提示时为 null */
  const updateNotice = $derived.by(() => {
    const flow = updateFlow;
    if (flow.kind === "available") return `可更新到 v${flow.version}`;
    if (flow.kind === "downloading") {
      return flow.progress.percent === null
        ? `正在下载更新 v${flow.version}（已下载 ${formatBytes(flow.progress.downloaded)}）`
        : `正在下载更新 v${flow.version}（${flow.progress.percent}%）`;
    }
    return null;
  });

  /**
   * 检查更新。manual = 用户点菜单：这类操作必须有明确反馈（"已是最新"也要说）；
   * 自动检查（manual = false）保持安静——没更新、失败都只留调试日志，
   * 绝不在状态栏刷"检查更新失败"打扰正在写作的人。
   */
  async function checkUpdates(manual: boolean) {
    // 下载/安装中不重入（否则会丢掉手上的句柄）
    if (updateFlow.kind === "downloading" || updateFlow.kind === "installing") return;
    updateFlow = { kind: "checking", manual };
    if (manual) {
      statusText = "正在检查更新…";
      // 手动检查 = 用户主动想知道有没有更新：清掉"别再自动弹窗"标记（"直到点了检查更新"）
      clearUpdateDismissed();
    }

    const outcome = await checkForUpdate();
    // 记一笔"上次检查时间"备查（自动 / 手动都记）：**它不再是节流门**，别拿它拦启动检查
    lastUpdateCheckAt = Date.now();
    schedulePersist();

    if (outcome.kind === "none") {
      updateFlow = { kind: "latest" };
      if (manual) statusText = "已是最新版本";
      return;
    }
    if (outcome.kind === "unsupported") {
      updateFlow = { kind: "idle" };
      if (manual) statusText = "当前环境不支持自动更新（仅桌面版可用）";
      return;
    }
    if (outcome.kind === "error") {
      updateFlow = { kind: "error", message: outcome.message };
      if (manual) statusText = `检查更新失败：${outcome.message}`;
      return;
    }

    // 有可用新版本：释放上一个句柄，换成新的
    await closeUpdate(updateHandle);
    updateHandle = outcome.update;
    updateFlow = {
      kind: "available",
      version: outcome.update.version,
      currentVersion: outcome.update.currentVersion,
      notes: outcome.update.notes,
    };
    // 用户点过「稍后」之后，自动检查只把入口留在状态栏（`updateNotice` 那个「可更新到 vX」按钮）：
    // **不弹窗、也不动状态文字** —— 用户原话「不更新就再也别跳出来，直到点了检查更新」。
    // 手动检查永远弹窗（上面的 clearUpdateDismissed 已经把标记清掉了）。
    if (manual || !isUpdatePromptSuppressed(updateDismissedAt)) {
      statusText = `发现新版本 v${outcome.update.version}`;
      // 发现新版本 → 弹窗确认（不自动下载）；关掉弹窗后状态栏仍留着入口
      showUpdateDialog = true;
    }
  }

  /** 清掉"别再自动弹更新窗"标记（显式操作：手动检查 / 点状态栏入口 / 开始下载） */
  function clearUpdateDismissed() {
    if (updateDismissedAt === null) return;
    updateDismissedAt = null;
    schedulePersist();
  }

  /**
   * 弹窗里点「稍后」：**以后自动检查只更新状态栏，不再弹窗**，直到用户手动检查
   * （用户 2026-09-14 明确要求：「不更新就再也别跳出来，直到点了检查更新」）。
   * 曾经实现成"静默 6 小时"，被否掉——别再退回按时间窗口的版本。
   */
  function dismissUpdatePrompt() {
    showUpdateDialog = false;
    updateDismissedAt = Date.now();
    schedulePersist();
    statusText = UPDATE_DISMISS_NOTICE;
  }

  /** 点状态栏的更新入口：与手动检查同属显式操作（清标记），然后打开弹窗 */
  function openUpdateDialogFromNotice() {
    clearUpdateDismissed();
    showUpdateDialog = true;
  }

  /** 下载并安装（弹窗里的「下载并安装」）。Windows 上成功后应用会自动退出并重开 */
  async function startUpdateInstall() {
    const handle = updateHandle;
    if (!handle) return;
    // 用户改主意开始装了：标记没必要再留着（装完重启后又能正常自动提示下一个版本）
    clearUpdateDismissed();
    updateFlow = {
      kind: "downloading",
      version: handle.version,
      progress: { downloaded: 0, total: 0, percent: null },
    };
    const result = await downloadAndInstallUpdate(handle, (progress) => {
      // 用户可能已经点了「关闭」；只要还在下载阶段就继续更新进度
      if (updateFlow.kind === "downloading") updateFlow = { ...updateFlow, progress };
    });
    if (result.ok) {
      updateFlow = { kind: "installing", version: handle.version };
      statusText = "更新已就绪：应用即将退出并安装新版本…";
    } else {
      updateFlow = { kind: "error", message: result.message };
      statusText = `更新失败：${result.message}`;
      showUpdateDialog = true; // 失败必须让用户看见（否则点了按钮好像什么也没发生）
    }
  }

  /** 关闭弹窗：保存后关闭 */
  async function onClosePromptSave() {
    showClosePrompt = false;
    const saved = await handleSave();
    if (saved) getCurrentWindow().destroy(); // destroy 不再次触发 close-requested
  }

  /** 关闭弹窗：不保存，直接关闭 */
  function onClosePromptDiscard() {
    showClosePrompt = false;
    getCurrentWindow().destroy();
  }

  /** 关闭弹窗：取消，保持窗口打开 */
  function onClosePromptCancel() {
    showClosePrompt = false;
  }

  /** 轻量防抖：内容/主题/路径变化后 300ms 写入 localStorage */
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      saveState({
        theme,
        content: doc,
        filePath,
        fileTitle,
        prefixEnabled,
        prefixCode,
        viewMode,
        showPreview,
        editorWrap,
        dirty,
        restoreSession,
        autoCheckUpdates,
        lastUpdateCheckAt,
        updateDismissedAt,
        uiZoom,
        chineseFont,
        fontDirs,
      });
    }, 300);
  }

  /**
   * 执行格式命令（菜单 / 快捷键）：把标记插到编辑器光标处，由编辑器侧完成事务。
   * 焦点在输入框（设置弹窗的 textarea）时不动编辑器——否则打字会被插标记。
   */
  function runFormat(command: WriteCommand) {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    editorRef?.runWriteCommand(command);
  }

  /**
   * 把缩放系数交给 webview。非 Tauri 环境（提示页）或调用失败都静默忽略——
   * 缩放不是关键路径，失败不该弹错（调试日志里留痕）。
   *
   * **为什么要"设完再确认一次"**（2026-09-14，实机反馈「放大根本没用、缩小有用」）：
   * WebView2 在 Ctrl+滚轮这种缩放手势进行中/结束时，会用它自己那套逻辑处理这次手势
   * （见 WebView2Feedback #1022：手势期间宿主设的 ZoomFactor 会被"还原"回手势开始时的值），
   * 于是在滚轮事件里立刻就 setZoom 有可能被引擎抹掉。这里在**手势停下来之后**再设一遍同一个
   * 系数：值没被抹掉时这次调用等价于空操作，被抹掉时就把界面拉回用户要的档位。
   */
  async function applyUiZoom(zoom: number) {
    if (!isTauri()) return;
    const target = clampZoom(zoom);
    // 先校准 100% 基线（只做一次），后面才能把 devicePixelRatio 换算成"引擎实际接受的档位"
    await ensureZoomCalibration();
    try {
      await getCurrentWebview().setZoom(target);
      dbg.log("zoom", `set ${zoomLabel(target)}`);
    } catch (e) {
      dbg.log("zoom", "setZoom failed", e);
      return;
    }
    scheduleZoomConfirm();
  }

  /** 手势/连续调档停止后再确认一次缩放（见 applyUiZoom 的注解）；重复调用只保留最后一次 */
  function scheduleZoomConfirm() {
    if (zoomConfirmTimer !== null) clearTimeout(zoomConfirmTimer);
    zoomConfirmTimer = setTimeout(() => {
      zoomConfirmTimer = null;
      const target = clampZoom(uiZoom);
      void getCurrentWebview()
        .setZoom(target)
        .then(() => {
          dbg.log("zoom", `confirm ${zoomLabel(target)}`);
          void verifyZoomApplied(target);
        })
        // 这次是兜底重试，失败只记日志（首次调用已经把失败报过了）
        .catch((e) => dbg.log("zoom", "confirm failed", e));
    }, ZOOM_CONFIRM_DELAY_MS);
  }

  /** 浏览器开发桩的 setZoom 是假的吗（桩在 app.html 挂了 __browserDevStub；zoomsim 模式下是模拟的，照常复核） */
  function zoomIsFaked(): boolean {
    return (
      (window as unknown as { __browserDevStub?: { fakeZoom?: boolean } }).__browserDevStub
        ?.fakeZoom === true
    );
  }

  /**
   * 启动后校准一次：先把引擎设到 100%（顺便排掉 WebView2"记住上次站点缩放"的干扰），
   * 记下此时的 **CSS 布局宽度** 作为基准。100% 是恒等档，任何引擎都会接受，所以这个基准可靠。
   */
  function ensureZoomCalibration(): Promise<void> {
    if (zoomCalibration === null) {
      zoomCalibration = (async () => {
        try {
          await getCurrentWebview().setZoom(ZOOM_DEFAULT);
          await new Promise((r) => setTimeout(r, 90));
          const width = document.documentElement.clientWidth;
          if (width > 0) {
            zoomBaseline100 = width;
            appliedZoom = ZOOM_DEFAULT;
          }
          dbg.log("zoom", `校准：100% 布局宽度 ${width}px`);
        } catch (e) {
          dbg.log("zoom", "缩放校准失败（本次不判定引擎档位）", e);
        }
      })();
    }
    return zoomCalibration;
  }

  /** 按"当前档位 × 当前宽度"重校基准：缩放与用户拖窗口之后都要校，否则判据会失真 */
  function rebaselineZoom() {
    const width = document.documentElement.clientWidth;
    if (width > 0 && appliedZoom > 0) zoomBaseline100 = width * appliedZoom;
  }

  /** 引擎**实际接受**的档位（读 CSS 布局宽度；量不到时 null＝本次不判定） */
  function engineZoomNow(): number | null {
    return zoomFromWidths(zoomBaseline100, document.documentElement.clientWidth);
  }

  /**
   * 复核 webview 到底有没有接受这个系数，**没接受就把界面状态拉回引擎给的档位**。
   *
   * 为什么必须拉回来（2026-09-14 三次实机反馈串起来看）：真机上引擎没接受"放大"，而 uiZoom 照旧
   * 一路涨到上限 250%，于是从 250% 往下滚要滚十几档才有反应——用户看到的就是「放大根本没用，
   * 缩小有用」，接着是「最大后无法用滚轮缩小」，第三次仍是「缩放到最大后无法从 Ctrl+滚轮缩小」。
   * 让状态永远等于引擎实际接受的档位，滚轮就再也不会掉进这种死区：放大被拒时档位原地不动
   * （界面与状态都保持一致，并在状态栏说明原因），缩小立刻有效。
   *
   * **判据是 CSS 布局宽度不是 devicePixelRatio**（0.7.8 之后换的）：dpr 依赖显示器缩放、真机上
   * 可能不跟随宿主设的 ZoomFactor，那时旧代码会把复核整体关掉（fail-open）→ 状态又开始一路涨。
   * 布局宽度比是页面缩放的定义本身，精确且与显示器无关。详见 zoom.ts 的 zoomFromWidths。
   */
  async function verifyZoomApplied(target: number) {
    if (zoomIsFaked()) return;
    if (zoomCalibration === null) return; // 还没校准过（正常路径一定先经过 applyUiZoom）
    let observed: number | null = null;
    zoomStepInFlight = true;
    try {
      await getCurrentWebview().setZoom(target); // 顺带把这一档再设一遍（兜底重试）
      // 等引擎把布局重排完再量：一帧 + 一小段余量（校准那边用的是 90ms，同一量级）
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await new Promise((r) => setTimeout(r, 60));
      observed = engineZoomNow();
    } catch (e) {
      dbg.log("zoom", "复核时 setZoom 失败", e);
      return;
    } finally {
      zoomStepInFlight = false;
    }
    if (observed === null) return; // 量不到：不判定、不改状态（绝不拿坏读数动用户的状态）
    if (zoomApplied(target, observed)) {
      appliedZoom = clampZoom(target);
      rebaselineZoom(); // 测量刚做完，此刻"宽度 × 档位"就是 100% 基准
      return; // 引擎接受了，正常路径
    }
    const snapped = clampZoom(observed);
    appliedZoom = snapped;
    rebaselineZoom();
    if (snapped === clampZoom(uiZoom)) return; // 状态已经在引擎给的档位上了
    dbg.log(
      "zoom",
      `引擎未接受 ${zoomLabel(target)}（实测 ${observed.toFixed(3)}），状态拉回 ${zoomLabel(snapped)}`,
    );
    uiZoom = snapped; // 触发 $effect → 再把引擎对齐到这个档位（已经是了，等价空操作）
    schedulePersist();
    statusText = `界面缩放未生效：引擎把 ${zoomLabel(target)} 限制在 ${zoomLabel(snapped)}`;
  }

  /** 改缩放并反馈（滚轮 / 菜单共用）；值没变时提示"已到边界"，不重复写存档 */
  function setUiZoom(next: number) {
    const target = clampZoom(next);
    if (target === uiZoom) {
      statusText = `缩放已是 ${zoomLabel(target)}（到边界了）`;
      return;
    }
    uiZoom = target; // $effect 把它交给 webview（见下方 applyUiZoom 的 effect）
    statusText = `缩放 ${zoomLabel(target)}`;
    schedulePersist();
  }

  /** 缩放复位 100%（视图菜单） */
  function resetUiZoom() {
    if (uiZoom === ZOOM_DEFAULT) {
      statusText = "缩放已是 100%";
      return;
    }
    setUiZoom(ZOOM_DEFAULT);
  }

  /**
   * Ctrl+滚轮：放大/缩小整个界面（编辑区 + 预览 + 菜单 + 状态栏）。
   *
   * 命中时**必须 preventDefault**：否则这次滚动会继续滚动编辑器/预览区，WebView2 还可能顺手
   * 用它自己那套系数缩放页面（与我们的系数打架，表现为"缩放了但系数对不上"）。
   * 位移量同时看 deltaY / deltaX（见 zoom.ts 的注解）：按 Shift 滚轮时浏览器把纵向滚动转成横向。
   *
   * 监听挂在 `window` 的**捕获阶段**（注册见 onMount），不是挂在 `<main>` 上：
   * ① 鼠标在菜单栏/状态栏上滚也该能缩放（原先只有编辑区/预览区那一块有效）；
   * ② 捕获阶段早于编辑器与预览区自己的滚动处理，preventDefault 更稳。
   * **注意**：window 上的 wheel 监听默认会被浏览器当"被动监听"，必须显式 `{ passive: false }`，
   * 否则 preventDefault 无效（滚动继续、缩放也拦不住）。
   */
  function handleZoomWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setUiZoom(nextZoom(uiZoom, e.deltaY, e.deltaX, e.deltaMode));
  }

  // 缩放变化（含启动恢复后的首次赋值）→ 交给 webview；失败不影响其它逻辑
  $effect(() => {
    void applyUiZoom(uiZoom);
  });

  /** 写作模式 ↔ 源码模式（仿 Typora 的"源代码模式"）：预览栏随模式联动 */
  function toggleViewMode() {
    // 切换前先记下光标在屏幕上的高度：两种模式的字号/行距/栏宽完全不同，CodeMirror 的滚动
    // 锚点（最上面那条可见行）会让光标被甩出视口 —— 用户反馈「切换模式不应该改变光标位置」。
    // 必须在改 viewMode **之前**记（改完布局就换了，量到的已经是新布局）。见 Editor.svelte。
    editorRef?.captureCaretAnchor();
    viewMode = viewMode === "write" ? "source" : "write";
    // 写作模式单栏（编辑区即排版结果）；源码模式双栏（源码 + 整页预览对照）
    showPreview = viewMode === "source";
    schedulePersist();
    statusText = viewMode === "write" ? "写作模式" : "源代码模式";
  }

  /**
   * 源码模式的自动换行开关（**Alt+Z**，VS Code 同款手势；菜单「视图 → 自动换行」同一入口）。
   *
   * 只作用于**源码模式**（传给 Editor 的 `wrap` 是 `viewMode === "source" ? editorWrap : true`）。
   * 写作模式**始终折行、不设开关**（2026-09-14 用户要求「预览模式和文档模式的内容不应该有横向
   * 拖动，而是自动换行，Alt+Z 只对代码起效」）——它是"整页纸张"的文档形态，正文长行必须像
   * Typora 那样自动折行；实测改前一条长行会给写作模式带来 2855px 的横向滚动。
   * 所以写作模式下按 Alt+Z 不改任何状态，只说明这条规则。
   */
  function toggleEditorWrap() {
    if (viewMode !== "source") {
      statusText = WRAP_SOURCE_ONLY_NOTICE;
      return;
    }
    editorWrap = !editorWrap;
    schedulePersist();
    statusText = wrapNotice(editorWrap);
  }

  function handleCursor(line: number, col: number) {
    cursorLine = line;
    cursorCol = col;
  }

  function handleDocChange(newDoc: string) {
    doc = newDoc;
    editorDoc = newDoc; // 镜像同步（见 editorDoc 声明处）：陈旧镜像 = 切模式/重挂载时丢内容
    dirty = true;
    scheduleCompile();
    schedulePersist();
  }

  /** 有未保存修改时请求确认（打开/拖放/关联打开/重新读取前） */
  async function confirmDiscard(
    message = "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
  ): Promise<boolean> {
    if (isTauri()) {
      return await confirm(message, {
        title: "未保存的修改",
        kind: "warning",
      });
    }
    return window.confirm(message);
  }

  /** 按路径加载 .typ 文件到编辑器（供打开对话框/拖放/关联打开复用） */
  async function openPath(path: string): Promise<boolean> {
    // 有未保存修改就必须确认——**包括打开的就是当前这个文件**：此前用 `filePath !== path`
    // 放行同路径，拖放/关联打开同一个文件（Windows 上把 .typ 拖进窗口很常见）会静默用磁盘内容
    // 覆盖未保存的输入，表现为"内容退回上次保存时的版本"。
    if (isEffectiveDirty(dirty, doc)) {
      const same = filePath === path;
      const ok = await confirmDiscard(
        same
          ? `「${fileTitle}」有未保存的修改，重新打开将丢弃这些修改。仍要打开吗？`
          : "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
      );
      if (!ok) return false;
    }
    try {
      const opened = await readTypFile(path);
      doc = opened.content;
      filePath = opened.path;
      fileTitle = opened.path.split(/[\\/]/).pop() ?? opened.path;
      dirty = false;
      editorDoc = opened.content; // 触发编辑器替换全文
      resetMathCache();
      scheduleCompile();
      schedulePersist();
      statusText = "已打开";
      return true;
    } catch (e) {
      statusText = "打开失败";
      return false;
    }
  }

  async function handleOpen() {
    const path = await openTypFile();
    if (!path) return;
    await openPath(path);
  }

  async function handleSave(): Promise<string | null> {
    try {
      const saved = await saveTypFile(filePath, doc);
      if (!saved) return null;
      filePath = saved;
      fileTitle = saved.split(/[\\/]/).pop() ?? saved;
      dirty = false;
      schedulePersist();
      return saved;
    } catch (e) {
      statusText = "保存失败";
      return null;
    }
  }

  /** Ctrl+R：从磁盘重新读取当前文件到编辑器（未命名文档忽略；有未保存修改先确认） */
  async function reloadFile() {
    if (!filePath) return; // 未命名文档：忽略
    if (isEffectiveDirty(dirty, doc)) {
      const ok = await confirmDiscard(
        "当前文档有未保存的修改，重新读取将丢失这些修改。仍要重新读取吗？",
      );
      if (!ok) return;
    }
    try {
      const opened = await readTypFile(filePath);
      doc = opened.content;
      filePath = opened.path;
      fileTitle = opened.path.split(/[\\/]/).pop() ?? opened.path;
      dirty = false;
      editorDoc = opened.content; // 触发编辑器替换全文
      resetMathCache();
      scheduleCompile();
      schedulePersist();
      statusText = "已重新读取";
    } catch {
      statusText = "重新读取失败";
    }
  }

  /**
   * 窗口级右键处理：
   * - 编辑器/预览区：替换原生菜单为自定义菜单；打开前联动收起 MenuBar 下拉/选中态
   *   （右键是 contextmenu 事件而非 mousedown，不会触发 MenuBar 的外部关闭监听，
   *   不显式收起会导致两菜单叠加）；
   * - 菜单栏/状态栏（chrome）：preventDefault 拦截但无效果——不弹自定义菜单，
   *   也不放行给浏览器原生，避免与 MenuBar 选中态/错误 Popover 交互冲突；
   * - 其余区域：原样放行浏览器原生菜单。
   */
  function handleContextMenu(e: MouseEvent) {
    const zone = resolveContextZone(e.target);
    if (zone === "other") return;
    e.preventDefault();
    // chrome（菜单栏/状态栏）无效果：无需弹自定义菜单，也无需收起 MenuBar
    if (zone === "chrome") return;
    menuBarRef?.closeMenus();
    // enabled 依据：编辑器用 CM6 state（未聚焦也准确）；预览用原生选区（须落在预览容器内，
    // 避免把编辑器的选区误算进来）
    const hasSelection =
      zone === "editor"
        ? (editorRef?.hasSelection() ?? false)
        : previewSelectionHasContent(window.getSelection(), previewHost);
    contextMenu = {
      x: e.clientX,
      y: e.clientY,
      items: buildContextMenuItems(zone, hasSelection).map((spec) => contextMenuItem(spec, zone)),
    };
  }

  /** 菜单项描述 → 组件条目：把命令映射到具体执行函数（应用操作为异步，命令统一在这里接线） */
  function contextMenuItem(spec: ContextMenuItemSpec, zone: "editor" | "preview"): ContextMenuItem {
    if (spec.type === "separator") return { type: "separator" };
    const label = spec.label ?? "";
    const disabled = spec.disabled ?? false;
    switch (spec.command) {
      case "cut":
        return { type: "item", label, disabled, onClick: () => editorRef?.execCommand("cut") };
      case "copy":
        return {
          type: "item",
          label,
          disabled,
          onClick: () => {
            if (zone === "editor") editorRef?.execCommand("copy");
            else document.execCommand("copy"); // 预览为不可编辑内容：直接复制当前选区
          },
        };
      case "paste":
        return { type: "item", label, disabled, onClick: () => editorRef?.execCommand("paste") };
      case "select-all":
        return {
          type: "item",
          label,
          disabled,
          onClick: () => {
            if (zone === "editor") editorRef?.selectAll();
            else selectAllPreview();
          },
        };
      case "save":
        return { type: "item", label, disabled, onClick: () => handleSave() };
      case "export-pdf":
        return { type: "item", label, disabled, onClick: () => handleExportPdf() };
      case "settings":
        return { type: "item", label, disabled, onClick: () => openSettings() };
      case "open":
        return { type: "item", label, disabled, onClick: () => handleOpen() };
      default:
        return { type: "item", label, disabled };
    }
  }

  /** 预览区全选：用 Selection API 选中整个预览容器（SVG 不可编辑，execCommand selectAll 不适用） */
  function selectAllPreview() {
    const sel = window.getSelection();
    if (!sel || !previewHost) return;
    const range = document.createRange();
    range.selectNodeContents(previewHost);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** 新建：清空文档并清除持久化的上次内容 */
  function handleNew() {
    doc = "";
    editorDoc = "";
    filePath = null;
    fileTitle = "未命名.typ";
    dirty = false;
    clearState();
    resetMathCache();
    scheduleCompile();
    statusText = "已新建";
  }

  function menuGroups(): MenuGroup[] {
    return [
      {
        label: "文件",
        accessKey: "F",
        items: [
          // shortcut 同时是菜单项右侧灰字显示与全局 Ctrl/Meta 组合键的触发来源（MenuBar 统一处理）
          { label: "新建", shortcut: "Ctrl+N", action: handleNew },
          { label: "打开…", shortcut: "Ctrl+O", action: handleOpen },
          { label: "保存", shortcut: "Ctrl+S", action: handleSave },
          { label: "设置…", shortcut: "Ctrl+,", action: openSettings },
          { label: "导出 PDF…", shortcut: "Ctrl+P", action: handleExportPdf },
        ],
      },
      {
        label: "格式",
        accessKey: "O",
        items: [
          { label: "加粗", shortcut: "Ctrl+B", action: () => runFormat("bold") },
          { label: "斜体", shortcut: "Ctrl+I", action: () => runFormat("italic") },
          { label: "行内代码", shortcut: "Ctrl+Shift+`", action: () => runFormat("code") },
          { label: "行内公式", shortcut: "Ctrl+M", action: () => runFormat("math-inline") },
          { label: "公式块", shortcut: "Ctrl+Shift+M", action: () => runFormat("math-block") },
          { label: "标题 1", shortcut: "Ctrl+1", action: () => runFormat("heading1") },
          { label: "标题 2", shortcut: "Ctrl+2", action: () => runFormat("heading2") },
          { label: "标题 3", shortcut: "Ctrl+3", action: () => runFormat("heading3") },
          { label: "正文", shortcut: "Ctrl+0", action: () => runFormat("body") },
          { label: "无序列表", shortcut: "Ctrl+Shift+]", action: () => runFormat("bullet") },
          { label: "有序列表", shortcut: "Ctrl+Shift+[", action: () => runFormat("ordered") },
          { label: "引用", shortcut: "Ctrl+Shift+Q", action: () => runFormat("quote") },
          { label: "代码块", shortcut: "Ctrl+Shift+C", action: () => runFormat("code-block") },
          { label: "链接", shortcut: "Ctrl+K", action: () => runFormat("link") },
        ],
      },
      {
        label: "视图",
        accessKey: "V",
        items: [
          {
            label: "源代码模式",
            shortcut: "Ctrl+/",
            checked: viewMode === "source",
            action: () => toggleViewMode(),
          },
          {
            label: "显示预览栏",
            checked: showPreview,
            action: () => (showPreview = !showPreview),
          },
          {
            label: "自动换行",
            // 同样只是灰字提示（MenuBar 的匹配器只认「Ctrl+单键」，不会命中 Alt+Z）；
            // 真正的触发在 +page.svelte 的 handleKeydown 里
            shortcut: "Alt+Z",
            checked: editorWrap,
            action: () => toggleEditorWrap(),
          },
          {
            label: "放大",
            // 这里的 shortcut 不是真快捷键（MenuBar 的匹配器只支持「Ctrl+单键」，不会命中），
            // 而是把操作姿势当灰字提示显示出来：Ctrl+滚轮 没法写进快捷键匹配
            shortcut: "Ctrl+滚轮",
            action: () => setUiZoom(zoomIn(uiZoom)),
          },
          { label: "缩小", action: () => setUiZoom(zoomOut(uiZoom)) },
          {
            label: "重置缩放",
            checked: uiZoom === ZOOM_DEFAULT,
            action: resetUiZoom,
          },
          { label: "主题：自动", checked: theme === "system", action: () => (theme = "system") },
          { label: "主题：暗", checked: theme === "dark", action: () => (theme = "dark") },
          { label: "主题：明", checked: theme === "light", action: () => (theme = "light") },
        ],
      },
      {
        label: "帮助",
        accessKey: "H",
        items: [
          { label: "检查更新…", action: () => checkUpdates(true) },
          { label: "关于 Typst-pad", action: () => (showAbout = true) },
        ],
      },
    ];
  }

  /**
   * 菜单栏选中态与编辑器焦点协调。
   * **激活菜单不再让编辑器失焦**（用户反馈："不要改变当前编辑位置"）：失焦会让编辑区光标消失，
   * 之后的字母还会被菜单当成 accessKey 吃掉，光标得手动点回去。现在编辑器全程保持焦点 ——
   * 菜单栏本身只依赖 window 上的 keydown（accessKey / 方向键 / Esc 都照常），不需要 DOM 焦点。
   * 只有"取消选中"这一侧要把焦点交回编辑器：鼠标点过菜单项后焦点落在按钮上，必须还回去。
   */
  function handleMenuFocusChange(focused: boolean) {
    if (focused) return; // 菜单激活：编辑器继续持有焦点，光标与滚动位置都不动
    document.querySelector<HTMLElement>(".editor-host .cm-content")?.focus();
  }

  function systemPrefersDark(): boolean {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function resolveTheme(): void {
    resolvedTheme = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  }

  // theme 变化（含手动切换）时重算生效主题并持久化
  $effect(() => {
    resolveTheme();
    schedulePersist();
  });

  function toggleTheme() {
    theme =
      theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  }

  async function handleExportPdf() {
    statusText = "导出 PDF…";
    try {
      // 拼接编译源：前缀补尾随换行（非空且未以 \n 结尾时），避免前缀末行与用户文档首行合并成一行
      const source = prefixEnabled ? ensureTrailingNewline(prefixCode) + doc : doc;
      // 导出流程：推导默认文件名 → 弹系统"另存为"对话框 → Rust 侧编译并直接落盘
      // （typst-engine.compileToPdf；不再经前端出 PDF 字节 + write_binary）
      const result = await compileToPdf(source, filePath, fileTitle, fontArgs());
      if (result.ok) {
        statusText = "已导出 PDF";
      } else if (result.cancelled) {
        statusText = "已取消导出";
      } else {
        statusText = "导出失败";
        previewStatus = "error";
        previewError = result.error;
      }
    } catch (e) {
      statusText = "导出失败";
      previewStatus = "error";
      previewError = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 所见即所得：编辑器请求渲染公式（视口内出现未缓存的公式时触发）。
   * 去重（已缓存 / 已在队列的 key 跳过）后进队，120ms 防抖再批量交给 Rust 侧编译——
   * 连续输入时不会每个按键都排队，停手后一次性补齐。
   */
  function handleMathRequest(requests: MathRequest[]) {
    let added = false;
    for (const req of requests) {
      if (mathCache.has(req.key) || mathPending.has(req.key)) continue;
      mathPending.add(req.key);
      mathQueue.push(req);
      added = true;
    }
    if (!added) return;
    clearTimeout(mathTimer);
    mathTimer = setTimeout(drainMathQueue, 120);
  }

  /** 逐个渲染队列中的公式（Rust 侧编译本身串行），每完成一个就刷新装饰 */
  async function drainMathQueue() {
    const batch = mathQueue;
    mathQueue = [];
    if (batch.length === 0) return;
    // 仅前缀的兜底上下文：文档内定义本身有错、或与前缀重名时，至少还能渲染不依赖它们的公式
    const prefixOnly = prefixEnabled ? ensureTrailingNewline(prefixCode) : "";
    for (const req of batch) {
      // 用请求自带的上下文编译（与生成缓存键时一致，见 MathRequest.context 的说明）
      let render = await compileMath(
        req.body,
        req.display,
        req.context,
        filePath,
        undefined,
        fontArgs(),
      );
      if (!render.ok && prefixOnly !== req.context) {
        const fallback = await compileMath(
          req.body,
          req.display,
          prefixOnly,
          filePath,
          undefined,
          fontArgs(),
        );
        if (fallback.ok) render = fallback;
      }
      mathCache.set(req.key, render);
      // 缓存上限：键按公式文本累积，长会话里可能堆很多（每条含一份 SVG）。
      // 超限按插入顺序淘汰最早的条目；若它仍在视口内，编辑器会重新请求并渲染。
      while (mathCache.size > MATH_CACHE_LIMIT) {
        const oldest = mathCache.keys().next().value;
        if (oldest === undefined) break;
        mathCache.delete(oldest);
      }
      mathPending.delete(req.key);
      // 只有渲染成功才需要重整装饰：失败的结果同样进缓存（避免反复重试），
      // 但装饰集不变（仍显示源码），自增版本号只会白跑一次全量重建
      if (render.ok) mathVersion++;
      dbg.log(
        "live-preview",
        `math ${render.ok ? "ok" : "fail"} ${req.display ? "display" : "inline"} ${JSON.stringify(req.body)}`,
      );
    }
  }

  /** 文档切换（打开/新建/重读）：公式缓存作废（include 根与上下文都可能变） */
  function resetMathCache() {
    mathCache.clear();
    mathPending.clear();
    mathQueue = [];
    clearTimeout(mathTimer);
    mathVersion++;
  }

  /**
   * 当前字体设置 → 传给 Rust 的字体配置。每次编译都要带：设置改了必须同时作用于
   * 正文预览、公式 widget 与 PDF 导出（三者都走 Rust 侧同一个注入）。
   */
  function fontArgs() {
    return {
      families: buildFontFamilies(chineseFont, defaultFonts),
      dirs: normalizeFontDirs(fontDirs),
    };
  }

  /** 取可用字体族（下拉数据源）与内置默认列表；打开设置、增删字体目录后调用 */
  async function refreshFontList(dirs: string[]) {
    fontsLoading = true;
    try {
      const [families, defaults] = await Promise.all([
        listFontFamilies(normalizeFontDirs(dirs)),
        defaultFontFamilies(),
      ]);
      availableFonts = families;
      if (defaults.length > 0) defaultFonts = defaults;
    } finally {
      fontsLoading = false;
    }
  }

  /** 添加额外字体目录（系统目录选择器）→ 立刻重新扫描字体，让下拉里出现新字体 */
  async function addFontDir() {
    const dir = await pickFontDir();
    if (!dir) return;
    settingsFontDirs = normalizeFontDirs([...settingsFontDirs, dir]);
    await refreshFontList(settingsFontDirs);
  }

  /** 移除额外字体目录 → 同步刷新字体列表 */
  function removeFontDir(dir: string) {
    settingsFontDirs = settingsFontDirs.filter((d) => d !== dir);
    void refreshFontList(settingsFontDirs);
  }

  /** 状态栏单行文案截断（警告可能很长，别把状态栏挤变形） */
  function truncateStatus(text: string, max = 70): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  /** 警告列表条目：有源码位置的可点击跳转（消息已翻成中文可行动提示），否则纯展示 */
  function warningItems(): ErrorListItem[] {
    return compileWarnings.map((w) =>
      w.line > 0
        ? {
            kind: "located" as const,
            message: describeCompileWarning(w.message),
            line: w.line,
            col: w.column,
          }
        : { kind: "generic" as const, message: describeCompileWarning(w.message) },
    );
  }

  function scheduleCompile() {
    runCompile(); // 立即编译：内容变化后直接编译，编译完即显示（无防抖延迟）
  }

  /** 打开设置弹窗：载入当前前缀配置副本，点“保存”才生效 */
  function openSettings() {
    settingsPrefixEnabled = prefixEnabled;
    settingsPrefixCode = prefixCode;
    settingsRestoreSession = restoreSession;
    settingsAutoCheckUpdates = autoCheckUpdates;
    settingsChineseFont = chineseFont;
    settingsFontDirs = [...fontDirs];
    showSettings = true;
    // 字体下拉的选项来自 Rust 侧真实注册的字体（结构上不可能写出一个不存在的族名）
    void refreshFontList(settingsFontDirs);
  }

  /** 保存设置：应用前缀配置并持久化 */
  function saveSettings() {
    const fontsChanged =
      settingsChineseFont !== chineseFont ||
      normalizeFontDirs(settingsFontDirs).join("\n") !== fontDirs.join("\n");
    const prefixChanged =
      settingsPrefixEnabled !== prefixEnabled || settingsPrefixCode !== prefixCode;
    prefixEnabled = settingsPrefixEnabled;
    prefixCode = settingsPrefixCode;
    restoreSession = settingsRestoreSession;
    autoCheckUpdates = settingsAutoCheckUpdates;
    chineseFont = settingsChineseFont;
    fontDirs = normalizeFontDirs(settingsFontDirs);
    schedulePersist();
    showSettings = false;
    // 公式缓存的键是「风格 + 前缀 + 公式文本」，不含字体配置 → 改了字体必须整体作废，
    // 否则视口内的公式会一直用旧字体（编辑器收到 mathVersion 变化后重新请求渲染）。
    if (fontsChanged) resetMathCache();
    // **保存后立即重编译**：以前只写状态不重编译，预览停在上一次结果，看起来就是
    // "改了字体/前缀没生效"（要在正文里敲一个字才刷新）。字体与前缀都会进编译源，故都要重编译。
    if (fontsChanged || prefixChanged) {
      // 重编译完成后再补一次确认：编译成功会把状态栏写成「就绪」，先写的那句会被顶掉
      // （实测：点保存后 "设置已保存" 一闪而过，验收也因此判失败）。只在编译没有给出更重要的
      // 提示（警告/编译错误）时才补——那些提示比"已保存"要紧。
      void runCompile().finally(() => {
        if (statusText === "就绪") statusText = "设置已保存";
      });
    }
    statusText = "设置已保存";
  }

  /** 关闭设置弹窗：放弃未保存的修改 */
  function closeSettings() {
    showSettings = false;
  }

  /**
   * 预览画布等宽缩放：按预览容器可用宽度与页面物理宽度（pt，页 SVG 的 viewBox）计算
   * 缩放系数，把画布宽度写入预览容器内联样式（各页 SVG width:100% 随之等宽显示）——
   * - 字号恒定：默认字号对齐输入区（14px），窗口拉宽时画布停在自然尺寸不再放大；
   * - 等宽显示：窗口变窄时画布等比缩小铺满容器宽度，文本不拉伸变形。
   *
   * **必须把界面缩放（uiZoom）一起传进去**（用户两次反馈「预览框大小还是没变」「预览框里面的字
   * 的大小还是没变」）：界面缩放走 webview `setZoom`，预览栏的 CSS 宽度会跟着变小，直接拿它算
   * "铺满"会把画布缩回原样、与引擎的放大正好抵消 —— 表现为"预览一点没变"。传 uiZoom 后按缩放
   * **前**的栏宽算，画布的 CSS 宽度保持在 100% 时的值，由引擎把它真正放大（1.5 档就是 1.5 倍，
   * 页面和里面的字一起变大）。依据是实测：1040px 窗口下 100%→150% 时画布物理尺寸比只有 0.983。
   *
   * **代价与配套**：预览是固定版心的排版结果，放大到超过栏宽时预览栏会出现横向滚动条（"跟着缩放
   * 变大"与"永不横向滚动"对固定版心的页面只能二选一，用户选了前者）。所以 `.preview-paper`
   * 用 `margin-inline: auto` 居中而不是容器 `align-items: center` —— 后者在溢出时会把页面左缘顶到
   * 滚动区之外（scrollLeft 不能为负，那部分永远看不到），auto 外边距在负剩余空间下退化成 0，
   * 于是"装得下就居中、装不下就左对齐"。
   * 测量失败（无产物/容器不可测）时清空内联宽度，回退 CSS width: 100%。
   */
  function applyPreviewScale() {
    if (!previewBodyEl || !previewHost) return;
    const svg = previewHost.querySelector("svg");
    if (!svg) {
      previewHost.style.width = "";
      return;
    }
    const containerWidth = previewBodyEl.clientWidth;
    const actualPageWidthPt = viewBoxWidthPt(svg.getAttribute("viewBox") ?? "");
    // 重排生效（产物页宽 = 我们请求的页宽）：画布恒 ≤ 栏宽 —— 这是"预览永不横向滚动"的保证。
    // 请求被文档自己的 #set page 覆盖时落到下面的等比缩放路径（那也是用户自己的纸型）。
    if (previewPageWidthUsed > 0 && isReflowApplied(actualPageWidthPt, previewPageWidthUsed)) {
      const reflowWidth = reflowCanvasWidth(containerWidth, actualPageWidthPt);
      previewHost.style.width = Number.isNaN(reflowWidth) ? "" : `${reflowWidth}px`;
      return;
    }
    const displayWidth = previewCanvasWidth({
      containerWidth,
      pageWidthPt: actualPageWidthPt,
      uiZoom,
    });
    previewHost.style.width = Number.isNaN(displayWidth) ? "" : `${displayWidth}px`;
  }

  /**
   * 预览栏宽度（或界面缩放）变化后，按新栏宽**重新编译**预览（去抖 250ms）。
   *
   * 为什么必须重编译：重排的页宽是**编译期**的输入（Rust 侧注入 `#set page`），画布宽度
   * 只是它的结果。所以每次栏宽有明显变化（窗口缩放 / Ctrl+滚轮 / 切换模式）就要重排一次。
   * 去抖是因为拖窗口边会连着触发几十次；阈值 2pt 是避免像素级抖动引起无意义重编译。
   * 预览栏不可测（写作模式隐藏预览、宽度 0）时不重排 —— 那时也没有横向滚动条的问题。
   */
  function schedulePreviewReflow() {
    clearTimeout(previewReflowTimer);
    previewReflowTimer = setTimeout(() => {
      const width = previewBodyEl ? previewPageWidthPt(previewBodyEl.clientWidth) : NaN;
      const next = Number.isNaN(width) ? 0 : width;
      const changed = next === 0 ? previewPageWidthUsed > 0 : Math.abs(next - previewPageWidthRequest) > 2;
      if (!changed) return;
      previewPageWidthRequest = next;
      dbg.log("preview-reflow", `页宽 ${next === 0 ? "关闭（不重排）" : `${next.toFixed(1)}pt`}`);
      void runCompile();
    }, 250);
  }

  async function runCompile() {
    if (compileSeq === 0) mark("compile-request");
    const mySeq = ++compileSeq;
    const t0 = performance.now(); // 编译耗时（调试日志用）
    // 编译期间保留旧预览，完成后直接替换（不做 loading 遮罩）
    // 拼接编译源：前缀补尾随换行（非空且未以 \n 结尾时），避免前缀末行与用户文档首行合并成一行；
    // documentPath 传当前文档绝对路径（未保存为 null），Rust 侧以其所在目录解析 include
    const source = prefixEnabled ? ensureTrailingNewline(prefixCode) + doc : doc;
    // 首次编译可能早于 ResizeObserver 的第一次回调：这里补算一次页宽，避免启动时多编译一遍
    if (previewPageWidthRequest === 0 && previewBodyEl) {
      const initialWidth = previewPageWidthPt(previewBodyEl.clientWidth);
      if (!Number.isNaN(initialWidth)) previewPageWidthRequest = initialWidth;
    }
    // 预览重排的页宽是**编译期输入**（Rust 侧据此注入 #set page），所以随本次编译一起发出；
    // 请求值只在结果落地时记进 previewPageWidthUsed（与产物一一对应，见 applyPreviewScale）
    const requestedPreviewWidthPt = previewPageWidthRequest;
    const result = await compileToSvg(
      source,
      filePath,
      fontArgs(),
      requestedPreviewWidthPt || undefined,
    );
    if (mySeq === 1) {
      // 首次编译完成 = 应用「可正常编辑/预览」就绪点，输出一次启动报告
      mark("first-compile-result");
      reportStartup();
    }
    if (mySeq !== compileSeq) return; // 已有更新的编译请求，丢弃本结果
    if (result.ok) {
      if (!previewHost) return; // 预览栏未挂载（理论上隐藏时仍在 DOM，这里兜底）
      previewHost.innerHTML = result.svg;
      previewPageWidthUsed = requestedPreviewWidthPt; // 本次产物的请求页宽（0 = 没请求重排）
      applyPreviewScale(); // 新产物注入后按当前容器宽度重算画布宽度
      pageCount = result.pageCount;
      previewStatus = "ready";
      editorDiagnostics = [];
      errorCount = 0; // 编译成功：错误徽标归零（与状态栏文本同源）
      lastNonPosError = null; // 编译成功：无非定位错误
      charCount = doc.length;
      // 编译警告（典型：unknown font family）必须可见——typst 对写错的字体族名只发 warning
      // 然后静默改用其他字体，不显示出来用户只会看到"改了字体没用"（见 font-warnings.ts）
      compileWarnings = result.warnings ?? [];
      statusText =
        compileWarnings.length > 0
          ? truncateStatus(`警告：${describeCompileWarning(compileWarnings[0].message)}`)
          : "就绪";
      // 调试日志：编译结果摘要（ok/页数/耗时），排查编译链路时对照 compile-diagnostics
      dbg.log("compile", `ok pages:${result.pageCount} t:${(performance.now() - t0).toFixed(1)}ms`);
    } else {
      // 编译错误：保留最后一次成功预览（不置 error、不隐藏预览、不显示错误面板），
      // 状态栏提示错误个数，编辑器内以红色波浪线标出错误位置（hover 可看详情）
      editorDiagnostics = result.errors;
      errorCount = result.errors.length; // 与状态栏文本「编译错误：N 处」同源
      compileWarnings = []; // 编译失败时 Rust 不返回 warnings（错误优先，避免两套提示打架）
      // 非定位错误（如包不存在 / 访问模型异常）单独记录，供徽标弹窗展示
      // （定位错误存在时与第一条同源，弹窗内不重复展示）
      lastNonPosError = result.errors.length === 0 ? result.error : null;
      // 非定位错误（如包不存在 / 访问模型异常）必须可见，不再被吞掉
      statusText =
        result.errors.length === 0 && result.error
          ? formatCompileFailMessage(0, result.error)
          : `编译错误：${result.errors.length} 处`;
      // 调试日志：编译失败摘要（错误数/耗时），错误详情见 compile-diagnostics
      dbg.log("compile", `fail errors:${result.errors.length} t:${(performance.now() - t0).toFixed(1)}ms`);
    }
  }

  /** 窗口标题同步为“文件名 - Typst-pad”；未保存修改时文件名后加圆点（Tauri） */
  function syncWindowTitle() {
    if (!isTauri()) return;
    getCurrentWindow().setTitle(`${fileTitle}${isEffectiveDirty(dirty, doc) ? " ●" : ""} - Typst-pad`);
  }

  // fileTitle / dirty 变化时（打开/保存/新建/编辑）同步窗口标题
  $effect(() => {
    syncWindowTitle();
  });

  /**
   * 错误列表 Popover 点击项：
   * - 错误落在前缀代码内（启用前缀时）：不跳编辑器，打开设置弹窗并定位到前缀对应行；
   * - 否则：跳转编辑器对应行列。
   */
  function onErrorItemClick(item: LocatedErrorItem) {
    // 注：isErrorLineInPrefix / prefixLineCharOffset 用未规范化的 prefixCode 草稿值即可——
    // 追加尾换行不改变前缀区内行号与行首偏移，与规范化后的编译源语义一致
    if (prefixEnabled && isErrorLineInPrefix(item.line, prefixCode)) {
      showErrors = false;
      openSettings(); // 载入当前前缀副本到 settingsPrefixCode，点“保存”才生效
      void tick().then(() => locatePrefixLine(item.line)); // 下一 tick：等设置弹窗渲染出 textarea
    } else {
      jumpTarget = { line: item.line, col: item.col, seq: ++jumpSeq };
      showErrors = false;
    }
  }

  /** 在设置弹窗的前缀代码 textarea 中定位第 line 行起点（偏移按 settingsPrefixCode 计算） */
  function locatePrefixLine(line: number) {
    const textarea = settingsPrefixTextarea;
    if (!textarea) return;
    const offset = prefixLineCharOffset(settingsPrefixCode, line);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    textarea.scrollIntoView({ block: "nearest" });
  }

  // 错误列表 Popover 打开期间：Esc 关闭；点击 Popover 外部（mousedown，先于 click）
  // 关闭——徽标本身在 errorWrapEl 内，点击徽标的切换逻辑不受干扰。
  // （Svelte 5 runes：effect 内注册/清理监听）
  $effect(() => {
    if (!showErrors) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") showErrors = false;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (errorWrapEl && !errorWrapEl.contains(e.target as Node)) {
        showErrors = false;
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  });

  // 错误列表 Popover 打开时做一次视口收边：徽标在状态栏内靠左排布（状态文本短时
  // 不在窗口右侧），right:0 锚定的 Popover 向左展开 520px 会从窗口左缘溢出。
  // 下一 tick 等 {#if showErrors} 渲染完成后再测量 getBoundingClientRect，
  // 越界则用 transform 平移（必要时叠加限宽）收回视口内，不破坏 right:0 锚定。
  // 仅在打开瞬间 clamp 一次；窗口 resize 不重算——本页无现成 resize 监听，
  // 且缩放时 Popover 通常已关闭，保持最小实现（ContextMenu 组件另有自己的重算逻辑）。
  $effect(() => {
    if (!showErrors) return;
    let disposed = false;
    // 关键：先复位上次打开遗留的 clamp（$state 在关闭时不自动清零）——否则第二次打开时
    // Popover 带着旧的 transform 渲染，测量到的是已平移的正确矩形，算出位移 ≈ 0，
    // 把变换清零后 Popover 跳回自然（溢出窗口）位置（实测「第一次对，第二次错」）。
    // 复位触发一次额外渲染，tick() 在其后执行，保证测到的是未变换的自然矩形。
    errorPopoverClamp = { translateX: 0, translateY: 0, maxWidth: 0 };
    void tick().then(() => {
      if (disposed || !errorPopoverEl) return;
      errorPopoverClamp = clampPopoverRect(
        errorPopoverEl.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
      );
    });
    return () => {
      disposed = true;
    };
  });

  /** 脚本错误统一提示：状态栏给出可读原因 + 调试日志留完整堆栈 */
  /**
   * Chromium 自己的提示，不算应用的脚本错误：
   * "ResizeObserver loop completed with undelivered notifications." 是引擎在"RO 回调里改了布局、
   * 同一帧又要再触发一次回调"时发的警告，规范上允许、后果只是把这次通知推迟到下一帧。
   * 我们的预览画布正好是"量到宽度 → 设宽度"这种模式，所以它在缩放/改分栏时会偶发出现。
   * 报成「脚本错误」会让用户以为应用坏了（2026-09-14 实测被反馈），只写调试日志。
   */
  const BENIGN_SCRIPT_ERRORS = [/ResizeObserver loop/i];

  function isBenignScriptError(msg: string): boolean {
    return BENIGN_SCRIPT_ERRORS.some((re) => re.test(msg));
  }

  function reportScriptError(label: string, detail: unknown) {
    const msg =
      detail instanceof Error ? detail.message : typeof detail === "string" ? detail : String(detail);
    if (isBenignScriptError(msg)) {
      dbg.log("error", `${label}（引擎提示，忽略）`, detail);
      return;
    }
    statusText = `脚本错误：${msg}`;
    dbg.log("error", label, detail);
    console.error(`[script-error] ${label}`, detail);
  }

  function onWindowError(e: ErrorEvent) {
    reportScriptError("window.onerror", e.error ?? e.message);
  }

  function onUnhandledRejection(e: PromiseRejectionEvent) {
    reportScriptError("unhandledrejection", e.reason);
  }

  function handleKeydown(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Alt+Z：源码模式的自动换行开关（VS Code 同款手势）。它没有 Ctrl/Meta 修饰，
    // 所以必须放在下面那句 `if (!mod) return` **之前**。判定见 word-wrap.isWrapToggleKey
    // （排除 Ctrl+Z 撤销与 Alt+Shift+Z，理由在那边的注释里）。
    if (isWrapToggleKey(e)) {
      e.preventDefault();
      toggleEditorWrap();
      return;
    }

    if (!mod) return;

    // Shift 组合的格式快捷键（MenuBar 的匹配器只支持「Ctrl+单键」，这些由页面处理）。
    // 键位沿用 Typora 习惯，菜单里以同样的文字展示。
    if (e.shiftKey) {
      const shiftCommands: Record<string, WriteCommand> = {
        "`": "code",
        m: "math-block",
        "]": "bullet",
        "[": "ordered",
        q: "quote",
        c: "code-block",
      };
      const command = shiftCommands[key];
      if (command) {
        e.preventDefault();
        runFormat(command);
      }
      return;
    }

    // 注意：菜单项全局快捷键（Ctrl+N 新建 / Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+, 设置 /
    // Ctrl+P 导出 PDF）由 MenuBar 的 window keydown 统一处理，不在此重复绑定，
    // 避免同一组合键双重触发（如保存对话框双弹）。
    // 此处仅保留未进菜单的键：Ctrl+R 重读、Ctrl+Shift+N 新窗口、Ctrl+W 关窗。

    // Ctrl/Cmd + R：重新读取当前文件（磁盘 → 编辑器）
    if (key === "r") {
      if (filePath) {
        e.preventDefault(); // 仅在有文件时拦截；浏览器 dev 无文件路径 → 放行给浏览器刷新
        reloadFile();
      }
      return;
    }
    // Ctrl/Cmd + Shift + N：打开新窗口（Tauri）；浏览器环境阻止默认并忽略。
    // 必须带 Shift：无 Shift 的 Ctrl+N 是菜单「新建文档」（由 MenuBar 处理），
    // MenuBar 的快捷键匹配排除 Shift 修饰，两者互不干扰
    if (key === "n" && e.shiftKey) {
      e.preventDefault();
      if (isTauri()) {
        new WebviewWindow(`editor-${Date.now()}`, {
          url: "/",
          title: "未命名.typ - Typst-pad",
          width: 1280,
          height: 800,
          minWidth: 800,
          minHeight: 600,
          center: true,
        });
      }
      return;
    }
    // Ctrl/Cmd + W：关闭当前窗口
    if (key === "w") {
      e.preventDefault();
      if (isTauri()) {
        getCurrentWindow().close();
      }
    }
  }

  onMount(() => {
    // 浏览器 gate：非 Tauri 环境（提示页）不初始化应用逻辑——编译走 Tauri 进程内命令，浏览器不可用
    if (!isDesktopApp) return;
    mark("mount-start");
    // 启动恢复：主题/前缀/界面模式总是恢复；**上次未保存的内容**按设置决定（默认恢复，
    // 见设置弹窗"启动时恢复上次内容"）——这是"内容丢了"的最后一道安全网。
    const saved = loadState();
    if (saved.theme === "system" || saved.theme === "dark" || saved.theme === "light") {
      theme = saved.theme;
    }
    prefixEnabled = saved.prefixEnabled ?? false;
    prefixCode = saved.prefixCode ?? "";
    chineseFont = saved.chineseFont ?? FONT_CHOICE_DEFAULT;
    fontDirs = normalizeFontDirs(saved.fontDirs ?? []);

    // 旧存档迁移：只有 livePreview 字段时，按其值推断模式
    viewMode = saved.viewMode ?? (saved.livePreview === false ? "source" : "write");
    // 旧存档没有 showPreview：单栏与否跟随模式（写作模式单栏，源码模式双栏对照）
    showPreview = saved.showPreview ?? viewMode === "source";
    // 源码模式自动换行（旧存档没有）：默认关，保持"高亮一格不折行"的原有观感
    editorWrap = saved.editorWrap ?? false;
    restoreSession = saved.restoreSession ?? true;
    autoCheckUpdates = saved.autoCheckUpdates ?? true;
    // 上次检查时间只用于显示/诊断，读回来原样存回去即可（启动检查不再看它）
    lastUpdateCheckAt = typeof saved.lastUpdateCheckAt === "number" ? saved.lastUpdateCheckAt : null;
    // "点过稍后 = 别再自动弹窗"（旧存档没有这个字段 → null = 照常弹窗）
    updateDismissedAt = typeof saved.updateDismissedAt === "number" ? saved.updateDismissedAt : null;
    // 界面缩放：旧存档没有该字段 → 100%；越界/脏数据由 clampZoom 收敛（随后由 $effect 应用）
    uiZoom = clampZoom(saved.uiZoom);
    if (restoreSession && typeof saved.content === "string" && saved.content.trim() !== "") {
      doc = saved.content;
      editorDoc = saved.content; // 镜像同步，见 editorDoc 声明处
      if (saved.filePath) {
        filePath = saved.filePath;
        fileTitle = saved.fileTitle ?? saved.filePath.split(/[\\/]/).pop() ?? "未命名.typ";
      }
      // 未保存标记原样恢复：存过盘又没再改的文档恢复出来不该带"未保存"圆点
      dirty = saved.dirty ?? false;
      statusText = "已恢复上次内容";
    }
    mark("persist-restore");

    // 关于弹窗版本号：从 Tauri 运行时读取（getVersion 返回 tauri.conf.json 的
    // version，如 0.4.0）；失败静默忽略，弹窗显示占位符
    getVersion().then((v) => (appVersion = v)).catch(() => {});
    // 内置默认字体族（拼"选中项 + 其余兜底"用）：静态列表，取一次即可
    void defaultFontFamilies().then((v) => {
      if (v.length > 0) defaultFonts = v;
    });

    runCompile();
    resolveTheme();
    // 系统主题变化时跟随（仅当处于“自动”态）
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme === "system") resolveTheme();
    };
    media.addEventListener("change", onSystemThemeChange);
    window.addEventListener("keydown", handleKeydown);
    // 未捕获的脚本异常 / Promise 拒绝：桌面 WebView 里没有可见控制台，错误会静默丢失，
    // 用户只看到"应用坏了"（实测踩过：装饰重建抛异常 → 编辑区卡死，却没有任何提示）。
    // 这里统一报到状态栏 + 调试日志，便于用户直接把原因念给我们。
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    // 自定义右键菜单：编辑器/预览区替换原生菜单（菜单栏/状态栏拦截无效果，其余区域放行给浏览器原生）
    window.addEventListener("contextmenu", handleContextMenu);
    // Ctrl+滚轮缩放：挂 window 捕获阶段 + 显式 passive: false（见 handleZoomWheel 的注解）
    window.addEventListener("wheel", handleZoomWheel, { capture: true, passive: false });
    // 用户拖动窗口会改变布局宽度 → 视口判据的 100% 基准要跟着校（见 rebaselineZoom）。
    // 缩放本身也会引起 resize：那种情况由测量那边自己校准，这里用 zoomStepInFlight 让开。
    const onWindowResize = () => {
      if (zoomStepInFlight) return;
      rebaselineZoom();
    };
    window.addEventListener("resize", onWindowResize);
    // 预览画布缩放：观测预览容器宽度变化（窗口 resize / 分栏布局变化），重算画布宽度；
    // observe 首次回调立即触发一次（覆盖挂载时已渲染的产物）
    // 回调里把工作推到下一帧：applyPreviewScale 会改预览画布宽度 → 又改容器布局，
    // 同步改会让 ResizeObserver 报 "loop completed with undelivered notifications"
    //（规范允许、但会在控制台/状态栏刷提示，见 reportScriptError 的注解）。
    previewResizeObserver = new ResizeObserver(() => {
      if (previewScaleFrame !== 0) return; // 同一帧只排一次
      previewScaleFrame = requestAnimationFrame(() => {
        previewScaleFrame = 0;
        applyPreviewScale();
        // 栏宽变了（窗口缩放 / Ctrl+滚轮 / 切换模式）：重排的页宽是编译期输入，
        // 所以除了重算画布宽度，还要按新栏宽去抖重编译一次（见 schedulePreviewReflow）
        schedulePreviewReflow();
      });
    });
    if (previewBodyEl) previewResizeObserver.observe(previewBodyEl); // bind:this 已在 onMount 前赋值

    // Tauri 内：支持拖放打开 / 关联双击打开 / 跨实例转发打开
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keepUnlisten = (p: Promise<() => void>) =>
      p.then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      });
    if (isTauri()) {
      // CLI --debug 开关（异步，仅桌面构建生效）：invoke 返回后补开调试日志；
      // 浏览器 dev 环境无此来源（且 dev 构建本身已默认开启），跳过
      invoke<boolean>("get_debug_flag").then(setCliDebug).catch(() => {});
      // 关闭确认：有实际未保存修改（dirty 且内容非空）时显示前端自定义三按钮弹窗
      // （不依赖 dialog 插件返回值的语义差异，保证 保存/不保存/取消 可靠）
      // 内容为空（含仅空白字符）视为无可丢失内容：输入过又删光后 dirty 仍为 true，
      // 但 isEffectiveDirty 以内容为准判定为未修改，直接关闭
      keepUnlisten(
        getCurrentWindow().onCloseRequested(async (event) => {
          if (!isEffectiveDirty(dirty, doc)) return; // 无实际未保存修改（含空文档），直接关闭
          event.preventDefault();
          showClosePrompt = true;
        }),
      );
      // 窗口级拖放：把 .typ 文件拖到窗口内自动打开
      keepUnlisten(
        getCurrentWindow().onDragDropEvent((event) => {
          if (event.payload.type === "over" || event.payload.type === "enter") {
            dragActive = true;
          } else if (event.payload.type === "drop") {
            dragActive = false;
            const path = pickTypPath(event.payload.paths);
            if (path) {
              openPath(path);
            } else if (event.payload.paths.length > 0) {
              statusText = "仅支持打开 .typ 文件";
            }
          } else {
            dragActive = false;
          }
        }),
      );
      // 应用已运行时再次打开文件（single-instance 转发）：先注册监听再取队列，
      // 避免转发事件落在两者之间而丢失
      const unlistenOpen = listen<string>("open-file", (e) => {
        if (e.payload) openPath(e.payload);
      });
      keepUnlisten(unlistenOpen);
      unlistenOpen.then(() => {
        // 首次启动/跨实例转发的待打开文件（关联双击）：就绪后取走（取最后一个，即最新请求）
        invoke<string[]>("take_pending_files")
          .then((paths) => {
            if (paths.length > 0) openPath(paths[paths.length - 1]);
          })
          .catch(() => {});
      });
    }
    mark("mount-listeners-done");

    // 自动更新：启动后延迟一次静默检查（不阻塞首屏）。
    // **每次启动都查**，只受设置里的开关约束 —— 这里曾经还有一道"距上次检查满 6 小时才查"的节流，
    // 2026-09-14 用户报「自动更新没法用（打开的时候没有自动更新，但是检查的时候能检查到）」就是它：
    // 时间戳是上次检查写下的，于是启动时几乎永远被拦掉。别再把这道理加回来，见 update-utils.ts 的注解。
    if (autoCheckUpdates) {
      startupCheckTimer = setTimeout(() => checkUpdates(false), AUTO_CHECK_DELAY_MS);
    }
    mark("mount-end");

    return () => {
      disposed = true;
      media.removeEventListener("change", onSystemThemeChange);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("wheel", handleZoomWheel, { capture: true });
      window.removeEventListener("resize", onWindowResize);
      if (zoomConfirmTimer !== null) clearTimeout(zoomConfirmTimer);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      previewResizeObserver?.disconnect();
      if (previewScaleFrame !== 0) cancelAnimationFrame(previewScaleFrame);
      unlisteners.forEach((un) => un());
      clearTimeout(persistTimer);
      clearTimeout(mathTimer); // 停止在途公式渲染批次
      clearTimeout(previewReflowTimer); // 停止在途的预览重排（避免卸载后还发起编译）
      clearTimeout(startupCheckTimer); // 关窗时取消还没发起的自动更新检查
      compileSeq++; // 使在途编译结果过期，防止卸载后写入 DOM
    };
  });
</script>

{#if isDesktopApp}
<div class="app" class:light={resolvedTheme === "light"}>
  <header class="toolbar">
    <MenuBar
      bind:this={menuBarRef}
      groups={menuGroups()}
      onMenuFocusChange={handleMenuFocusChange}
    />
  </header>

  <main class="panes" class:single={!showPreview}>
    {#if dragActive}
      <div class="drop-overlay">释放以打开 .typ 文件</div>
    {/if}
    <section class="pane editor-pane">
      <div class="pane-body">
        <Editor
          bind:this={editorRef}
          initialDoc={editorDoc}
          doc={editorDoc}
          theme={resolvedTheme}
          diagnostics={editorDiagnostics}
          prefixCode={prefixEnabled ? ensureTrailingNewline(prefixCode) : ""}
          jumpTo={jumpTarget}
          onCursor={handleCursor}
          onDocChange={handleDocChange}
          mode={viewMode}
          wrap={viewMode === "source" ? editorWrap : true}
          lookupMath={(key) => mathCache.get(key)}
          onMathRequest={handleMathRequest}
          mathVersion={mathVersion}
        />
      </div>
    </section>
    <section class="pane preview-pane" class:hidden={!showPreview}>
      <!-- data-context-zone：右键区域判定标记（覆盖占位/错误/预览纸张全部子区域） -->
      <div
        class="pane-body preview-body"
        data-context-zone="preview"
        bind:this={previewBodyEl}
      >
        {#if previewStatus === "error"}
          <div class="preview-error">
            <div class="preview-error-title">编译错误</div>
            <pre class="preview-error-text">{previewError}</pre>
          </div>
        {:else if previewStatus === "idle"}
          <div class="preview-placeholder">等待编译…</div>
        {/if}
        <div
          id="preview-host"
          bind:this={previewHost}
          class="preview-paper"
          hidden={previewStatus !== "ready"}
        ></div>
      </div>
    </section>
  </main>

  <footer class="statusbar">
    <!-- 左侧最前：编译错误 + 编译警告计数（VS Code 状态栏同序：⊗ 0 ⚠ 0，用户给的参照图）。
         两者都**常驻显示**（无问题时是 0）——它们在同一列里，常驻才能一眼看出"编译干净"，
         也避免数字出现/消失时整条状态栏左右抖动。错误在警告**左边**。 -->
    <span class="badge-group">
      <span class="error-badge-wrap" bind:this={errorWrapEl}>
        <span
          class="error-badge"
          class:clickable={hasErrorToShow(errorCount, lastNonPosError)}
          class:active={showErrors}
          role="button"
          tabindex="0"
          aria-expanded={showErrors}
          onclick={() => {
            if (hasErrorToShow(errorCount, lastNonPosError)) showErrors = !showErrors;
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" && hasErrorToShow(errorCount, lastNonPosError)) {
              showErrors = !showErrors;
            }
          }}
        >
          <!-- 圆圈叉（VS Code 的 error 图标形状）：**整幅内联 SVG**，圆圈与叉一起画。
               以前是 CSS 圆环 + `✕` 字形，字形随系统字体变粗变细、叉的粗细与圆圈对不上，
               用户比对参照图后指出"不像"——现在两个图标都是 16×16 视图框里的描边图形，
               线宽比例也照参照图定（圆环 1.5、叉 1.35，叉的线略细于圆环）。 -->
          <svg class="error-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M5 5 11 11M11 5 5 11"
              fill="none"
              stroke="currentColor"
              stroke-width="1.35"
              stroke-linecap="round"
            />
          </svg><span class="error-count">{errorCount}</span>
        </span>
        {#if showErrors}
          <div
            class="error-popover"
            bind:this={errorPopoverEl}
            role="dialog"
            aria-label="编译错误列表"
            style="transform: translate({errorPopoverClamp.translateX}px, {errorPopoverClamp.translateY}px);{errorPopoverClamp.maxWidth > 0 ? `max-width:${errorPopoverClamp.maxWidth}px` : ""}"
          >
            <div class="error-popover-title">
              编译错误{errorCount > 0 ? `（${errorCount} 处）` : ""}
            </div>
            <div class="error-list">
              {#each buildErrorListItems(editorDiagnostics, lastNonPosError) as item}
                {#if item.kind === "located"}
                  <button class="error-item" onclick={() => onErrorItemClick(item)}>
                    <span class="error-item-loc">{formatErrorLoc(item)}</span>
                    <span class="error-item-msg">{item.message}</span>
                  </button>
                {:else}
                  <div class="error-item error-item-generic">
                    <span class="error-item-loc">{formatErrorLoc(item)}</span>
                    <span class="error-item-msg">{item.message}</span>
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}
      </span>
      <span class="error-badge-wrap">
        <span
          class="error-badge warning-badge"
          class:clickable={compileWarnings.length > 0}
          class:active={showWarnings && compileWarnings.length > 0}
          role="button"
          tabindex="0"
          aria-expanded={showWarnings && compileWarnings.length > 0}
          title="编译警告（不中断渲染）"
          onclick={() => {
            if (compileWarnings.length > 0) showWarnings = !showWarnings;
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" && compileWarnings.length > 0) {
              showWarnings = !showWarnings;
            }
          }}
        >
          <!-- 三角形内部感叹号（VS Code 的 warning 图标形状）：内联 SVG，用 currentColor
               上色（不用 ⚠ 字形——跨字体渲染差异大，而且它是彩色 emoji 字体）。
               描边路径的三个角都是**显式圆弧**（半径 1.25），比 stroke-linejoin 的圆角更接近
               参照图里那种圆钝的三角；感叹号按参照图量出来的比例：竖杠略粗于三角线宽、圆点稍大。 -->
          <svg class="warning-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M15.09 12.83A1.3 1.3 0 0 1 13.95 14.75L2.05 14.75A1.3 1.3 0 0 1 0.91 12.83L6.86 1.93A1.3 1.3 0 0 1 9.14 1.93Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path d="M8 5.4V9.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
          </svg>
          <span class="error-count">{compileWarnings.length}</span>
        </span>
        {#if showWarnings && compileWarnings.length > 0}
          <div class="error-popover" role="dialog" aria-label="编译警告列表">
            <div class="error-popover-title">编译警告（{compileWarnings.length} 处）</div>
            <div class="error-list">
              {#each warningItems() as item}
                {#if item.kind === "located"}
                  <button class="error-item" onclick={() => onErrorItemClick(item)}>
                    <span class="error-item-loc">{formatErrorLoc(item)}</span>
                    <span class="error-item-msg">{item.message}</span>
                  </button>
                {:else}
                  <div class="error-item error-item-generic">
                    <span class="error-item-msg">{item.message}</span>
                  </div>
                {/if}
              {/each}
            </div>
          </div>
        {/if}
      </span>
    </span>
    <!-- 状态文字：占满剩余空间、单行省略（可伸缩项，见 .status-text 的样式） -->
    <span class="status-text">{statusText}</span>
    {#if updateNotice}
      <button
        class="status-update"
        title="打开更新窗口"
        onclick={openUpdateDialogFromNotice}
      >{updateNotice}</button>
    {/if}
    <span class="spacer"></span>
    <span class="mode-tag">{viewMode === "write" ? "写作" : "源码"}</span>
    {#if uiZoom !== ZOOM_DEFAULT}
      <!-- 只在非 100% 时出现：缩放是"整界面都在变"的状态，得有个常驻的地方能看出来 -->
      <span class="mode-tag" title="Ctrl+滚轮缩放；视图 → 重置缩放">缩放 {zoomLabel(uiZoom)}</span>
    {/if}
    <span>{charCount} 字符 · {pageCount} 页</span>
    {#if viewMode === "source"}
      <span>行 {cursorLine}, 列 {cursorCol}</span>
    {/if}
  </footer>

  {#if showAbout}
    <button
      class="modal-overlay"
      aria-label="关闭关于窗口"
      onclick={(e) => {
        if (e.target === e.currentTarget) showAbout = false;
      }}
    >
      <div class="modal">
        <h3 class="modal-title">Typst-pad</h3>
        <p class="modal-text">版本 {appVersion || "…"}</p>
        <p class="modal-text">Typora 式布局的 Typst 桌面编辑器：左编辑 / 右实时预览。</p>
        <p class="modal-text">MIT License © 2026 Z3O1</p>
        <span
          class="modal-close"
          role="button"
          tabindex="0"
          onclick={() => (showAbout = false)}
          onkeydown={(e) => e.key === "Enter" && (showAbout = false)}
        >关闭</span>
      </div>
    </button>
  {/if}

  {#if showClosePrompt}
    <div class="modal-overlay-static">
      <div class="modal">
        <h3 class="modal-title">未保存的修改</h3>
        <p class="modal-text">当前文档有未保存的修改，是否保存？</p>
        <div class="modal-actions">
          <button class="modal-btn primary" onclick={onClosePromptSave}>保存</button>
          <button class="modal-btn" onclick={onClosePromptDiscard}>不保存</button>
          <button class="modal-btn" onclick={onClosePromptCancel}>取消</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showSettings}
    <div class="modal-overlay-static">
      <div class="modal settings-modal">
        <h3 class="modal-title">设置</h3>
        <p class="modal-text">编译/导出时自动在代码前插入前缀代码（可配置页面、字体等全局项）。</p>
        <label class="settings-row">
          <input type="checkbox" bind:checked={settingsRestoreSession} />
          <span>启动时恢复上次内容（未保存的修改不会丢）</span>
        </label>
        <label class="settings-row">
          <input type="checkbox" bind:checked={settingsAutoCheckUpdates} />
          <span>启动时自动检查更新（发现新版本会先询问，不会自己下载）</span>
        </label>
        <label class="settings-row">
          <input type="checkbox" bind:checked={settingsPrefixEnabled} />
          <span>启用前缀代码</span>
        </label>
        <textarea
          class="settings-textarea"
          bind:value={settingsPrefixCode}
          bind:this={settingsPrefixTextarea}
          placeholder="#set page(margin: 2cm)"
          spellcheck="false"
        ></textarea>
        <label class="settings-row settings-row-font">
          <span>正文字体（中文）</span>
          <select class="settings-select" bind:value={settingsChineseFont}>
            <option value={FONT_CHOICE_DEFAULT}>默认（思源宋体，缺字回退系统宋体）</option>
            {#each availableFonts as font (font)}
              <option value={font}>{font}</option>
            {/each}
          </select>
        </label>
        <p class="settings-hint">
          只认字体文件里的英文族名；用「额外字体目录」加入自己的字体后，这里会多出对应选项。
        </p>
        <div class="settings-block">
          <div class="settings-block-title">
            额外字体目录（放进这里的字体立即可用，等同于 typst CLI 的 --font-path）
          </div>
          {#each settingsFontDirs as dir (dir)}
            <div class="settings-dir">
              <span class="settings-dir-path" title={dir}>{dir}</span>
              <button class="modal-btn" onclick={() => removeFontDir(dir)}>移除</button>
            </div>
          {/each}
          <div class="settings-dir-actions">
            <button class="modal-btn" onclick={addFontDir} disabled={fontsLoading}>
              添加字体目录…
            </button>
            {#if fontsLoading}
              <span class="settings-hint">正在读取字体…</span>
            {:else if availableFonts.length > 0}
              <span class="settings-hint">可用字体族 {availableFonts.length} 个</span>
            {/if}
          </div>
        </div>
        <div class="modal-actions">
          <button class="modal-btn primary" onclick={saveSettings}>保存</button>
          <button class="modal-btn" onclick={closeSettings}>关闭</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showUpdateDialog && updateFlow.kind !== "latest" && updateFlow.kind !== "checking"}
    <div class="modal-overlay-static">
      <div class="modal update-modal">
        {#if updateFlow.kind === "available"}
          <h3 class="modal-title">发现新版本</h3>
          <p class="modal-text">
            当前 v{updateFlow.currentVersion} → 最新 v{updateFlow.version}
          </p>
          {#if updateFlow.notes}
            <!-- 更新说明是 CHANGELOG 的 Markdown 原文（见 generate-latest-json.mjs）：
                 交给 update-notes.ts 渲染成受控子集的安全 HTML，别再退回 <pre> 显示原文 -->
            <div class="update-notes">{@html renderUpdateNotes(updateFlow.notes)}</div>
          {/if}
          <p class="modal-text update-hint">
            下载并安装后应用会自动重启；安装包有签名校验，来源不对会被拒绝。
          </p>
          <div class="modal-actions">
            <button class="modal-btn primary" onclick={startUpdateInstall}>下载并安装</button>
            <!-- 「稍后」= 用户选择不更新：此后自动检查只更新状态栏、不再弹窗（见 dismissUpdatePrompt） -->
            <button class="modal-btn" onclick={dismissUpdatePrompt}>稍后</button>
          </div>
        {:else if updateFlow.kind === "downloading"}
          <h3 class="modal-title">正在下载更新 v{updateFlow.version}</h3>
          <div class="update-progress">
            <div
              class="update-progress-fill"
              style="width: {updateFlow.progress.percent ?? 0}%"
            ></div>
          </div>
          <p class="modal-text">{formatProgress(updateFlow.progress)}</p>
          <div class="modal-actions">
            <button class="modal-btn" onclick={() => (showUpdateDialog = false)}>
              后台继续下载
            </button>
          </div>
        {:else if updateFlow.kind === "installing"}
          <h3 class="modal-title">更新已就绪</h3>
          <p class="modal-text">
            应用即将退出并安装 v{updateFlow.version}，安装完成后会自动重新打开。
          </p>
          <p class="modal-text update-hint">有未保存的修改请先返回保存（安装期间窗口会关闭）。</p>
          <div class="modal-actions">
            <!-- Windows 上安装器会自己把应用拉起来；留个关闭按钮是为了非 Windows
                 （安装完不退出的平台）不会被一个没有按钮的弹窗卡住 -->
            <button class="modal-btn" onclick={() => (showUpdateDialog = false)}>关闭</button>
          </div>
        {:else if updateFlow.kind === "error"}
          <h3 class="modal-title">更新失败</h3>
          <p class="modal-text">{updateFlow.message}</p>
          <div class="modal-actions">
            <button class="modal-btn" onclick={() => (showUpdateDialog = false)}>关闭</button>
            <button class="modal-btn primary" onclick={() => checkUpdates(true)}>重试</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if contextMenu}
    <ContextMenu
      position={{ x: contextMenu.x, y: contextMenu.y }}
      items={contextMenu.items}
      onClose={() => (contextMenu = null)}
    />
  {/if}
</div>
{:else}
  <!-- 非 Tauri（浏览器直开）时的提示页。开发模式下额外给一键入口：
       浏览器开发模式（?browserdev=1）会装假的 Tauri 环境 + 假编译，能完整调试编辑器交互
       （所见即所得、快捷键、菜单、分栏），只是没有真实 typst 排版与文件功能。
       不加这个入口时，裸开 http://localhost:1420/ 只会看到"请使用桌面应用版本"，
       很容易误判成"用不了了"（实测踩过）。生产构建（非 DEV）不显示该入口。 -->
  <div class="browser-gate">
    <p class="browser-gate-title">请使用桌面应用版本</p>
    <p class="browser-gate-text">Typst-pad 已移除浏览器支持，请下载桌面应用后使用。</p>
    {#if import.meta.env.DEV}
      <p class="browser-gate-text browser-gate-dev">
        开发调试可改用<strong>浏览器开发模式</strong>：带 <code>?browserdev=1</code> 打开本页
        （假 Tauri 环境 + 假编译，可调试编辑器交互与所见即所得）。
      </p>
      <button
        class="modal-btn primary"
        onclick={() => {
          const url = new URL(location.href);
          url.searchParams.set("browserdev", "1");
          location.href = url.toString();
        }}
      >打开浏览器开发模式</button>
    {/if}
  </div>
{/if}

<style>
  :root {
    --bg: #1e1e1e;
    --bg-pane: #252526;
    --bg-backdrop: #1a1a1a;
    --bg-paper: #252526;
    --bg-toolbar: #2d2d30;
    --border: #3c3c3c;
    --fg: #d4d4d4;
    --fg-dim: #9d9d9d;
    --accent: #4fc1ff;
  }

  .app.light {
    --typora-caret: #1a1a1a;
    --bg: #f5f5f5;
    --bg-pane: #ffffff;
    --bg-backdrop: #e8e8e8;
    --bg-paper: #ffffff;
    --bg-toolbar: #ececec;
    --border: #d4d4d4;
    --fg: #1f1f1f;
    --fg-dim: #6b6b6b;
    --accent: #0b6bb5;
  }

  * {
    box-sizing: border-box;
  }

  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
    color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 14px;
  }

  .toolbar {
    display: flex;
    align-items: center;
    padding: 0 4px 0 0; /* 左内边距归 0：菜单栏贴窗口左边界 */
    background: var(--bg-pane);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    border: none;
    padding: 0;
    cursor: default;
  }

  .app.light .modal-overlay {
    background: rgba(255, 255, 255, 0.55);
  }

  .modal {
    min-width: 320px;
    background: var(--bg-toolbar);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    padding: 20px 24px;
  }

  .modal-title {
    margin: 0 0 8px;
    color: var(--accent);
  }

  .modal-text {
    margin: 4px 0;
    font-size: 13px;
    color: var(--fg);
  }

  .modal-close {
    display: inline-block;
    margin-top: 12px;
    padding: 6px 18px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-pane);
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }

  .modal-close:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* 关闭确认弹窗（纯静态遮罩：不响应点击，必须选择按钮） */
  .modal-overlay-static {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
  }

  .app.light .modal-overlay-static {
    background: rgba(255, 255, 255, 0.55);
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    justify-content: flex-end;
  }

  .modal-btn {
    padding: 6px 18px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-pane);
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  .modal-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .modal-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
  }

  .modal-btn.primary:hover {
    opacity: 0.9;
  }

  .panes {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  /* 写作模式（仿 Typora）：灰底 + 居中白纸 + 轻阴影；源码模式保持原来的代码编辑器观感 */
  .panes.single .editor-pane {
    background: var(--bg-backdrop);
  }

  .panes.single .editor-pane .pane-body {
    background: var(--bg-paper);
    max-width: 900px;
    margin: 0 auto;
    width: 100%;
    /* 纸张内左右各 48px 阅读边距由 Editor.svelte 的 `.editor-host.write .cm-scroller` 提供
       （**不能**放在 .cm-content 上：整行选区底色会把内边距一起铺满、两边凸出来） */
    box-shadow: 0 0 12px rgba(0, 0, 0, 0.12);
  }

  .mode-tag {
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg-dim);
    font-size: 12px;
  }

  /* 单栏（所见即所得）：编辑区占满整宽，预览栏整体不参与布局 */
  .panes.single .preview-pane {
    display: none;
  }

  .preview-pane.hidden {
    display: none;
  }

  /* 单栏（写作模式）：编辑区不再与预览栏分界；纸张限宽居中由上面的 .pane-body 负责 */
  .panes.single .editor-pane {
    border-right: none;
  }

  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .editor-pane {
    border-right: 1px solid var(--border);
    background: var(--bg-pane);
  }

  .pane-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .statusbar {
    display: flex;
    flex-wrap: nowrap; /* 不许换行：换行会让状态栏长成一大块（缩放到 190% + 长报错时实测过） */
    align-items: center;
    gap: 16px;
    padding: 4px 12px;
    background: var(--bg-toolbar);
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--fg-dim);
    user-select: none;
  }

  /* 状态文字：占满剩余空间、**单行省略**（以前会被压成多行，把整条状态栏顶高）。
     按**类名**定位而不是 `:first-child` —— 左侧最前现在是警告/错误两个徽标（2026-09-14 用户要求）。 */
  .statusbar > .status-text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* 其余徽标/标签/计数：保持原尺寸，既不被压缩也不换行。
     两条 `:not()` 都不可省：`.spacer`（撑开左右两组）与 `.status-text`（要可伸缩 + 省略号）
     都在这条规则的命中范围里，漏掉就会被 `flex: none` 压成不可伸缩。 */
  .statusbar > span:not(.spacer):not(.status-text) {
    flex: none;
    white-space: nowrap;
  }

  /* 左侧最前的两个计数徽标（警告、错误）成组：组内间距比状态栏主间距紧凑一点 */
  .statusbar > .badge-group {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .spacer {
    flex: 1;
  }

  /* 编译错误徽标：圆圈 ✕ + 个数，常驻显示（无错误时为 0） */
  .error-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-dim);
  }

  /* 两个状态徽标的图标：都是 16×16 视图框、显示 14px 的内联 SVG（尺寸与线宽都照
     参照图标定：图标高度 / 数字高度 ≈ 1.6）。别再退回 CSS 圆环 + `✕` 字形或 `⚠` 字形 ——
     字形随系统字体变粗细，跟旁边的描边图形不是一套观感（用户比对参照图后指出过）。 */
  .error-icon,
  .warning-icon {
    display: block;
    flex: none;
  }

  .error-count {
    font-variant-numeric: tabular-nums; /* 数字变化时宽度稳定，不抖动 */
  }

  /* 徽标可点击（存在可展示错误时）：指针 + 悬停变亮，提示可查看详情 */
  .error-badge.clickable {
    cursor: pointer;
    color: #ff8a8a;
  }

  .error-badge.clickable:hover {
    color: #ffc9c9;
  }

  /* 徽标 Popover 展开中：保持高亮，提示再次点击可收起 */
  .error-badge.clickable.active {
    color: #ffc9c9;
  }

  /* 编译警告徽标：与错误徽标同款但偏黄——警告不中断渲染，别让人以为编译挂了。
     图标是内联 SVG 三角形+感叹号（VS Code 形状），用 currentColor 上色 */
  .warning-badge.clickable {
    color: #e5c07b;
  }
  .warning-badge.clickable:hover,
  .warning-badge.clickable.active {
    color: #ffd79a;
  }

  /* 设置弹窗里的字体项：下拉与目录列表 */
  .settings-row-font {
    justify-content: space-between;
    cursor: default;
  }
  .settings-select {
    max-width: 260px;
    padding: 4px 6px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--fg);
    font-size: 13px;
  }
  .settings-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 10px 0 4px;
  }
  .settings-block-title {
    color: var(--fg-dim);
    font-size: 12px;
  }
  .settings-hint {
    margin: 2px 0;
    color: var(--fg-dim);
    font-size: 12px;
  }
  .settings-dir {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .settings-dir-path {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
  }
  .settings-dir-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .preview-body {
    display: flex;
    flex-direction: column;
    /* 交叉轴（水平）居中只作用于"装得下"的元素（错误框/占位符）；
       画布自己用 margin-inline: auto，溢出时退化成左对齐（见 .preview-paper） */
    align-items: center;
    background: var(--bg-pane);
    overflow: auto;
    /* 常驻滚动条槽位：修复"窄窗口下预览画布持续闪烁"（实测 2026-09-10）。
       成因是滚动条反馈环——画布宽度写为"容器可用宽度"时：
         画布略宽 → 出现竖滚动条 → clientWidth 少 15px → 重算变窄 → 滚动条消失 → 变宽 …
       无限循环，DOM 里 host 内联宽度在两个值之间反复翻转，视觉上就是来回闪。
       窗口够宽（≥ 自然缩放 840px，缩放被 natural 夹住）或全屏时不再随容器变化，
       所以此前只在中等窗口宽度复现（实测 1040~1060px 视口下 flips=7/秒）。
       stable 让槽位常驻，clientWidth 不再随滚动条变化，反馈环断裂。
       实测：修复前取值 ['512px','527px'] flips=22；修复后 ['512px'] flips=0。 */
    scrollbar-gutter: stable;
  }

  .drop-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.45);
    border: 3px dashed var(--accent);
    color: var(--fg);
    font-size: 18px;
    font-weight: 600;
    pointer-events: none;
  }

  .app.light .drop-overlay {
    background: rgba(255, 255, 255, 0.6);
  }

  .preview-paper {
    width: 100%;
    /* 宽度默认铺满容器；applyPreviewScale 按容器宽度与页物理尺寸（pt）计算后
       以内联样式覆盖为画布显示宽度（字号恒定等宽缩放），测量失败时回退本规则 */
    /* 居中用**自身的 auto 外边距**，不用容器上的 align-items: center：
       界面缩放放大后画布会比栏宽宽，此时 auto 外边距退化为 0（负剩余空间）→ 页面左对齐、
       横向滚动条能真正滚到左缘；若靠容器居中，溢出的左半部分会被顶到滚动区之外，
       scrollLeft 又不能为负 → 那部分永远看不到（实测踩过）。 */
    margin-inline: auto;
  }

  /* 每页 SVG 顶层文档（compileToSvg 按页序拼接入预览容器）：铺满预览容器宽度
     （容器宽度由缩放逻辑控制）、高度按比例——等宽缩放，文本不拉伸变形 */
  .preview-paper > :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }

  /* 页间分隔线（typst-engine composePages 注入的 <div class="page-separator">），随主题自适应 */
  .preview-paper > :global(.page-separator) {
    height: 1px;
    background: var(--border);
  }

  .preview-placeholder {
    color: var(--fg-dim);
    font-size: 13px;
    padding: 40px 0;
  }

  .preview-error {
    width: 100%;
    max-width: 820px;
    background: #3c1f1f;
    border: 1px solid #7a3a3a;
    border-radius: 6px;
    padding: 12px 16px;
  }

  .preview-error-title {
    color: #ff8a8a;
    font-weight: 600;
    margin-bottom: 6px;
  }

  .preview-error-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: #ffc9c9;
    font-size: 12px;
  }

  /* 设置弹窗 */
  .settings-modal {
    width: 520px;
    max-width: 90vw;
  }

  .settings-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 4px;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
    user-select: none;
  }

  .settings-row input[type="checkbox"] {
    accent-color: var(--accent);
    width: 15px;
    height: 15px;
  }

  .settings-textarea {
    width: 100%;
    min-height: 160px;
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font-family: Consolas, "Cascadia Code", "Courier New", monospace;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    box-sizing: border-box;
  }

  .settings-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* 错误徽标容器：Popover 的定位锚点（徽标 + 浮层同一容器） */
  .error-badge-wrap {
    position: relative;
    display: inline-flex;
  }

  /* 编译错误/警告 Popover：锚定徽标上方，圆角阴影风格与菜单下拉一致，不遮全屏。
     `left: 0` 而不是 `right: 0` —— 徽标现在在状态栏最左（2026-09-14），右对齐会把 520px 宽的
     浮层整体推到窗口左侧外面（靠 clampPopoverRect 也能救回来，但那样每次都是"被夹住"的状态）。 */
  .error-popover {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    width: 520px;
    max-width: 90vw;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-toolbar);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    padding: 8px;
    z-index: 50;
  }

  .error-popover-title {
    margin: 2px 4px 6px;
    color: var(--fg-dim);
    font-size: 12px;
  }

  .error-list {
    margin-top: 4px;
    min-height: 0; /* 允许在 max-height 的 Popover 内收缩，列表内部滚动 */
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* 可点击的错误条目：左对齐、等宽定位、悬停高亮 */
  .error-item {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--bg-pane);
    color: var(--fg);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }

  .error-item:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .error-item-loc {
    flex: none;
    font-family: Consolas, "Courier New", monospace;
    font-size: 12px;
    color: var(--fg-dim);
    white-space: nowrap;
  }

  .error-item-msg {
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* 非定位错误条目：纯文本展示，不可点击（悬停不高亮） */
  .error-item-generic {
    cursor: default;
  }

  .error-item-generic:hover {
    border-color: transparent;
    color: var(--fg);
  }

  /* 浏览器提示页（非 Tauri 环境；已移除浏览器支持） */
  .browser-gate {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--bg);
    color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  }

  .browser-gate-title {
    margin: 0;
    font-size: 18px;
    color: var(--accent);
  }

  .browser-gate-dev {
    max-width: 520px;
    line-height: 1.7;
  }

  .browser-gate-dev code {
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(128, 128, 128, 0.25);
  }

  .browser-gate-text {
    margin: 0;
    font-size: 13px;
    color: var(--fg-dim);
  }

  /* 状态栏的更新提示：只作文字强调（无底色块，保持状态栏干净），点击重开更新弹窗 */
  .status-update {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
  }

  .status-update:hover {
    text-decoration: underline solid;
  }

  /* 更新弹窗：说明可能很长，限宽 + 内部滚动，不把弹窗撑到屏幕外。
     内容是 update-notes.ts 渲染的受控 HTML（标题/列表/粗体/行内代码），不是 <pre> 原文 */
  .update-modal {
    max-width: 560px;
  }

  .update-notes {
    margin: 8px 0 0;
    padding: 8px 12px;
    max-height: 260px;
    overflow-y: auto;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--fg);
    font-size: 12.5px;
    line-height: 1.7;
    word-break: break-word;
  }

  .update-notes :global(h4),
  .update-notes :global(h5) {
    margin: 10px 0 4px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }

  /* 第一节的小标题不需要上边距，免得贴着一片空白 */
  .update-notes :global(:first-child) {
    margin-top: 0;
  }

  .update-notes :global(p) {
    margin: 0 0 6px;
  }

  .update-notes :global(ul),
  .update-notes :global(ol) {
    margin: 0 0 6px;
    padding-left: 20px;
  }

  .update-notes :global(li) {
    margin: 2px 0;
  }

  .update-notes :global(strong) {
    font-weight: 600;
  }

  .update-notes :global(code) {
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--bg-hover, rgba(128, 128, 128, 0.16));
    font-family: var(--mono-font, ui-monospace, monospace);
    font-size: 11.5px;
  }

  .update-notes :global(hr) {
    margin: 8px 0;
    border: none;
    border-top: 1px solid var(--border);
  }

  .update-hint {
    color: var(--fg-dim);
    font-size: 12px;
  }

  .update-progress {
    height: 6px;
    margin: 12px 0 6px;
    border-radius: 3px;
    background: var(--bg-pane);
    border: 1px solid var(--border);
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s linear; /* 进度回调是分片的，平滑一点免得跳 */
  }
</style>
