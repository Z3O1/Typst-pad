<script lang="ts">
  import { onMount, tick } from "svelte";
  import Editor from "$lib/editor/Editor.svelte";
  import {
    compileToSvg,
    compileToPdf,
    hitTestDocument,
    locateDocumentCursor,
    listFontFamilies,
    defaultFontFamilies,
  } from "$lib/core/typst-engine";
  import type {
    CompileErrorLocation,
    CompileOk,
    Diagnostic,
    DocumentCaret,
  } from "$lib/core/typst-engine";
  import { createSourceCoordinates } from "$lib/core/source-coordinates";
  import { clickSourceRange, sourceRevealRange } from "$lib/core/document-interaction";
  import { compileDocumentWithFallback } from "$lib/core/document-error-fallback";
  import {
    projectDocument,
    type SourceRange,
    type DocumentProjection,
  } from "$lib/core/document-projection";
  import { buildFontFamilies, normalizeFontDirs } from "$lib/core/font-settings";
  import {
    copySettings,
    defaultSettings,
    diffSettings,
    SETTINGS_SAVED_STATUS,
    statusAfterSettingsSave,
  } from "$lib/core/app-settings";
  import type { AppSettings } from "$lib/core/app-settings";
  import { createFontList } from "$lib/core/font-list";
  import { createOpenFileClaim } from "$lib/core/open-file-claim";
  import { createNewWindow } from "$lib/core/new-window";
  import { createCloseGuard, createDropHandler } from "$lib/core/window-events";
  import { planRestore } from "$lib/core/session-restore";
  import { createDocumentCompileScheduler } from "$lib/core/document-compile-scheduler";
  import type { CompileReason } from "$lib/core/document-compile-scheduler";
  import type { WriteCommand } from "$lib/core/write-commands";
  import { openTypFile, saveTypFile, readTypFile, pickFontDir, isTauri } from "$lib/core/file-ops";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { loadState, saveState } from "$lib/core/persistence";
  import { decideAppKey, runAppKeyAction, topModal } from "$lib/editor/app-keys";
  import type { AppModal } from "$lib/editor/app-keys";
  import { isDocModified, ensureTrailingNewline, UNTITLED_TITLE } from "$lib/core/doc-utils";
  import {
    createDocumentSession,
    loadedState,
    newState,
    savedState,
  } from "$lib/core/document-session";
  import type { DocumentState } from "$lib/core/document-session";
  import { failureStatus } from "$lib/core/failure-text";
  import MenuBar from "$lib/ui/MenuBar.svelte";
  import type { MenuGroup } from "$lib/ui/MenuBar.svelte";
  import { buildMenuGroups } from "$lib/ui/menu-model";
  import ContextMenu from "$lib/ui/ContextMenu.svelte";
  import type { ContextMenuItem } from "$lib/ui/ContextMenu.svelte";
  import AboutDialog from "$lib/ui/AboutDialog.svelte";
  import ClosePromptDialog from "$lib/ui/ClosePromptDialog.svelte";
  import StatusBar from "$lib/ui/StatusBar.svelte";
  import PreviewPane from "$lib/ui/PreviewPane.svelte";
  import BrowserGate from "$lib/ui/BrowserGate.svelte";
  import SettingsDialog from "$lib/ui/SettingsDialog.svelte";
  import UpdateDialog from "$lib/ui/UpdateDialog.svelte";
  // 弹窗共享外壳样式见 src/lib/ui/modal.css（页面作用域命中不了子组件）
  import "$lib/ui/modal.css";
  import {
    resolveContextZone,
    previewSelectionHasContent,
    buildContextMenuItems,
    type ContextMenuItemSpec,
  } from "$lib/ui/context-menu-utils";
  import { clearState } from "$lib/core/persistence";
  // 浏览器验收的**只读**钩子（`?browserdev=1` 才挂；见各自文件头）：验收要断言块表带的是
  // 新排版戳、写作模式的编译次数与调度器运行次数对得上 —— 这两件事在 DOM 里都看不出来。
  import {
    registerWriteTestHooks,
    reportSessionRestored,
    unregisterWriteTestHooks,
  } from "$lib/dev/write-test-hook";
  import {
    isErrorLineInPrefix,
    formatDiagnosticForClipboard,
    formatDiagnosticListForClipboard,
    type ErrorListItem,
    type LocatedErrorItem,
  } from "$lib/ui/error-list";
  import { nextBadgePopover, type BadgeKind } from "$lib/ui/badge-popover";
  import {
    buildErrorItems,
    buildWarningItems,
    diagnosticCopyAllStatus,
    diagnosticCopyStatus,
    diagnosticListTitle,
    truncateStatus,
  } from "$lib/ui/status-view";
  import { reduceCompileStatus, type CompileStatusSource } from "$lib/ui/compile-status";
  import {
    isBenignScriptError,
    scriptErrorMessage,
    scriptErrorStatus,
  } from "$lib/core/script-errors";
  import { copyPlainText } from "$lib/core/clipboard";
  import { mark, reportStartup } from "$lib/core/startup-timing";
  import { dbg, setCliDebug } from "$lib/core/debug";
  import { previewCanvasWidth } from "$lib/core/preview-scale";
  import {
    checkForUpdate,
    downloadAndInstallUpdate,
    closeUpdate,
    type AvailableUpdate,
  } from "$lib/core/updater";
  import { AUTO_CHECK_DELAY_MS, type UpdateFlow } from "$lib/core/update-utils";
  import {
    CHECKING_STATUS,
    planDismiss,
    planInstallResult,
    planInstallStart,
    planUpdateCheck,
    updateNoticeText,
  } from "$lib/core/update-flow";
  // zoom.ts 是纯逻辑（档位换算、判据、文案）；"引擎改档 + 复核"的编排在 zoom-controller.ts，
  // 这里只留页面自己用得到的三样：默认档、收敛、档位文案。
  import { ZOOM_DEFAULT, clampZoom, zoomLabel } from "$lib/core/zoom";
  import { createZoomController } from "$lib/core/zoom-controller";
  // isWrapToggleKey 的判定已挪进 app-keys.decideAppKey（那里统一管按键路由，含它的顺序要求）
  import { WRAP_SOURCE_ONLY_NOTICE, wrapNotice } from "$lib/editor/word-wrap";

  // 新建时默认空白文档（不再预填示例内容）
  const SAMPLE_DOC = "";

  // 浏览器 gate：已移除浏览器支持（编译走 Tauri 进程内原生命令），
  // 非 Tauri 环境（无 __TAURI_INTERNALS__）不渲染应用 UI，仅显示提示页
  const isDesktopApp = isTauri();

  /**
   * 本窗口是不是**副窗口**（`Ctrl+Shift+N` 新建出来的窗口，label 形如 `editor-<时间戳>`；
   * 主窗口的 label 是 tauri.conf.json 里那个默认的 `main`）。
   *
   * 副窗口 = 空白草稿窗口：起来**不恢复**上次内容、"新建"也不清存档、写存档只写设置
   * （会话字段由 persistence.saveState 的 `{ session: false }` 原样保留），启动自动检查更新也不做。
   * 理由：存档只有一个 localStorage key、两个窗口共用一个源，副窗口一旦按"主窗口"那套走，
   * 就会把主窗口那份未保存内容顶掉（或反过来恢复成主窗口的文档）。
   *
   * 取不到 label 时按主窗口处理（`isTauri()` 为假、或 API 抛错）：宁可行为和以前完全一致，
   * 也不要凭空把窗口判成副窗口而丢掉"恢复上次内容"。
   */
  const isSecondaryWindow = (() => {
    try {
      return isTauri() && getCurrentWindow().label !== "main";
    } catch {
      return false;
    }
  })();

  /** 副窗口首屏编译落地后写在状态栏的一句说明（见 onMount 末尾） */
  const NEW_WINDOW_NOTICE = "新窗口：这里的修改不会记进「上次内容」";

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
    revealAt(pos: number, range?: { from: number; to: number }): void;
    focus(): void;
  }

  /** MenuBar 组件实例方法（右键菜单弹出前联动收起） */
  interface MenuBarHandle {
    closeMenus(): void;
  }

  let fileTitle = $state(UNTITLED_TITLE);
  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let statusText = $state("就绪");
  let theme: "system" | "dark" | "light" = $state("system");
  let resolvedTheme: "dark" | "light" = $state("dark");

  let doc: string = $state(SAMPLE_DOC);
  // 编辑器文档的**镜像**：既作为"外部推送"通道（打开/新建/重读时赋新值 → 编辑器替换全文），
  // 也随每次输入同步（handleDocChange）。**必须保持镜像同步**：若只更新 doc，editorDoc 会停在
  // 上次打开/保存时的旧值，任何让 Editor 重挂载或让 props 重新生效的情形（窗口重载、组件树重建）
  // 都会把旧值当成"外部文档"推回去，表现为"切个模式未保存的新内容就退回上一个版本"。
  let editorDoc = $state(SAMPLE_DOC);
  let filePath = $state<string | null>(null);
  /**
   * 未保存修改的判据基线 = **上次打开 / 保存时**的正文（`null` = 基线未知，见 `doc-utils`
   * 的 `isDocModified`）；打开/重新读取/保存/新建四条路都由 `core/document-session` 的状态迁移
   * 纯函数给（见 applyDocState）。未命名文档的初值：空正文的基线就是空串。
   */
  let baseline: string | null = $state("");
  /**
   * 有没有未保存修改：由「正文 vs 基线」**现算**，不是自己维护的标志位 ——
   * 标志位在"打开有内容的文件后全选删光"（会判成干净）与"改了又撤销回原样"（会一直带圆点）
   * 这两种情况下都会和正文脱节。圆点、打开/重读/新建/关闭的确认框读的都是它。
   */
  const dirty = $derived(isDocModified(doc, baseline));
  let previewStatus: "idle" | "ready" | "error" = $state("idle");
  let previewError = $state("");
  let pageCount = $state(0);
  let charCount = $state(0); // 字符数（状态栏右侧独立显示）
  /**
   * 预览栏组件句柄：画布（paper）与滚动容器（body）两个元素都在 PreviewPane.svelte 里，
   * 页面拿不到 bind:this ⇒ 组件用 export function 交出来（见那边文件头）。
   * 挂载前为 null；SVG 页级更新由组件管理，页面只装配产物与计算共同缩放比例。
   */
  let previewPaneRef = $state<{
    paper(): HTMLElement | undefined;
    body(): HTMLElement | undefined;
    updatePages(pages: string[]): void;
    clearPages(): void;
    pageWidthPt(): number;
  } | null>(null);
  let previewResizeObserver: ResizeObserver | undefined; // 容器尺寸监听（窗口/分栏变化时重算画布缩放）
  let previewScaleFrame = 0; // 已排队的重算帧号（见 onMount 里的 ResizeObserver）
  let compileSeq = 0; // 代次令牌：丢弃过期编译结果
  let dragActive = $state(false); // 拖放悬停中：显示覆盖层提示
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let showAbout = $state(false);
  /** 关于弹窗里的「项目主页」地址（开源仓库；关于弹窗与打开失败文案共用） */
  const PROJECT_URL = "https://github.com/Z3O1/Typst-pad";
  // 关于弹窗版本号：运行时经 getVersion 异步读取（tauri.conf.json 的 version），
  // 未返回前显示占位符，避免每次发版漏更新硬编码版本号
  let appVersion = $state("");
  let showClosePrompt = $state(false); // 关闭确认弹窗（保存/不保存/取消）
  let showSettings = $state(false); // 设置弹窗（编译前缀代码）
  let editorDiagnostics = $state<CompileErrorLocation[]>([]); // 编译错误位置（传给编辑器画波浪线）
  let errorCount = $state(0); // 编译错误个数（状态栏徽标，常驻显示）
  /**
   * 状态栏两个计数徽标的 Popover 开合状态（"none" = 都关着）。
   * **两个徽标共用一份、行为只写一遍**（用户 2026-09-18 反馈：「点击警告 / 关闭警告的行为
   * 应该和错误是一样的」—— 当时警告侧少了 Esc、点外部关闭、点条目跳转即关、视口收边四条）。
   * 别再退回 `showErrors` + `showWarnings` 两套状态：那正是"警告侧只有一半行为"的来源。
   */
  let openBadgePopover = $state<"none" | "errors" | "warnings">("none");
  // 自定义右键菜单：位置 + 条目；null 表示关闭
  let contextMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  let editorRef = $state<EditorHandle | null>(null); // Editor 组件实例（选区/剪贴板命令）
  let menuBarRef = $state<MenuBarHandle | null>(null); // MenuBar 组件实例（联动收起）
  let lastNonPosError = $state<string | null>(null); // 最近一次编译的非定位错误（无位置，如包不存在）
  let jumpSeq = 0; // 跳转代次：保证重复点击同一错误也触发跳转 effect
  let jumpTarget = $state<{ line: number; col: number; seq: number } | null>(null); // 编辑器跳转目标
  /**
   * 编译警告（Rust 侧 warnings）：字体族写错只会以警告形式出现，必须显示出来。
   * 条数传给状态栏的警告徽标（DiagnosticBadge），条目由 warningItems() 组装。
   */
  let compileWarnings = $state<Diagnostic[]>([]);
  // 浮层的可见性判定、Esc/点外部关闭、打开时视口收边都在 DiagnosticBadge 组件里
  // （两个徽标共用同一份行为）；这里只留开合状态本身 —— 点浮层条目跳转后也要收起它。
  /** 点徽标/Enter：开这个、并顺手把另一个关掉（两个徽标共用一份状态 ⇒ 一次只开一个） */
  function toggleBadgePopover(kind: BadgeKind) {
    openBadgePopover = nextBadgePopover(openBadgePopover, kind);
  }
  // 设置弹窗组件句柄（bind:this）：错误落在前缀代码内时用它定位到对应行（见 focusPrefixLine）
  let settingsDialogRef = $state<{ focusPrefixLine(line: number): void } | null>(null);
  // 默认值只有一份（`core/app-settings.ts` 的 `defaultSettings()`）：生效配置的初值、草稿的初值、
  // 以及"存档里没有这个字段"时的兜底都用它；草稿那份另外拷一层，别与这里的数组共享引用。
  const SETTINGS_DEFAULTS = defaultSettings();
  let prefixEnabled = $state(SETTINGS_DEFAULTS.prefixEnabled); // 编译/导出前是否自动插入前缀
  let prefixCode = $state(SETTINGS_DEFAULTS.prefixCode); // 前缀代码（插入到用户代码之前）

  let viewMode = $state<"write" | "source">("write");
  // 源码模式是否显示整页预览；文档模式的完整页面始终可见。
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
  /**
   * 缩放编排（引擎改档 / 100% 基准 / 沉降窗口 / 复核代次 / 滚轮余量）在 zoom-controller.ts：
   * 那边依赖全部由 hooks 注入，24 项单测把三条红线钉住了 —— ① 只观察、绝不改档（用户 2026-09-16
   * 的取舍）；② 沉降窗口内 resize 不重校 100% 基准；③ 新复核一开始旧复核立刻作废。
   * 这里只提供页面这一侧的东西：档位状态、状态栏反馈、真正的引擎 setZoom。
   */
  const zoom = createZoomController({
    enabled: isTauri,
    getLevel: () => uiZoom,
    requestLevel: (level) => setUiZoom(level),
    setStatus: (text) => {
      statusText = text;
    },
    setWebviewZoom: (level) => getCurrentWebview().setZoom(level),
    layoutWidth: () => document.documentElement.clientWidth,
    devicePixelRatio: () => window.devicePixelRatio,
    // 浏览器开发桩的 setZoom 是假的（`?browserdev=1` 的 fakeZoom）；zoomsim=1 是模拟引擎，照常复核
    isFakeZoom: () =>
      (window as unknown as { __browserDevStub?: { fakeZoom?: boolean } }).__browserDevStub
        ?.fakeZoom === true,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nextFrame: () => new Promise((r) => requestAnimationFrame(() => r())),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    log: (msg) => dbg.log("zoom", msg),
  });
  // 展开范围生成临时 Typst 编译输入；原文档与光标交互保持各自状态。
  let documentSession = $state(0);
  let documentRevision = $state(0);
  let renderedInput = $state("");
  let documentGeometryId = $state(0);
  let sourceOpen = $state(false);
  let sourceRange = $state<SourceRange | null>(null);
  let documentErrorRanges: SourceRange[] = [];
  let errorEditRange: SourceRange | null = null;
  let renderedProjection: DocumentProjection = projectDocument("", null);
  let renderedPages: CompileOk | null = null;
  let renderedCoordinates = createSourceCoordinates("");
  const documentCoordinates = $derived(createSourceCoordinates(doc));
  let inputPosition = $state<{ left: number; top: number; height: number } | null>(null);
  let documentCaret = $state<DocumentCaret | null>(null);
  let interactionSeq = 0;
  let positioningFromPage = false;

  // 按输入变化生成一次指纹，而不是在滚动/选区查询里反复序列化全文。
  const inputFingerprint = $derived(
    JSON.stringify([
      documentSession,
      documentRevision,
      doc,
      prefixEnabled,
      prefixCode,
      filePath,
      fontArgs(),
      viewMode === "write" ? sourceRange : null,
    ]),
  );
  function currentInput(): string {
    return inputFingerprint;
  }

  function handleOpenLink(href: string): void {
    if (!/^(https?:|mailto:)/i.test(href)) return;
    void openUrl(href).catch((e) => {
      statusText = truncateStatus(`打开链接失败：${e}`);
    });
  }

  async function handlePageClick(req: { page: number; xPt: number; yPt: number }): Promise<void> {
    const input = currentInput();
    const seq = ++interactionSeq;
    if (input !== renderedInput || documentGeometryId === 0) {
      statusText = previewError ? "请先修正编译错误" : "正在编译";
      return;
    }
    const hit = await hitTestDocument(documentGeometryId, req.page, req.xPt, req.yPt);
    if (seq !== interactionSeq || input !== currentInput() || input !== renderedInput) return;
    if (!hit) {
      statusText = "无法定位此处源码";
      return;
    }
    const prefix = prefixEnabled ? ensureTrailingNewline(prefixCode) : "";
    const renderedPos = renderedCoordinates.toPosition(hit.offset);
    const sourcePos = renderedProjection.renderedToSource(renderedPos);
    if (sourcePos < prefix.length) {
      statusText = "请在设置中编辑前缀代码";
      return;
    }
    const pos = Math.min(doc.length, sourcePos - prefix.length);
    const previousEdit = errorEditRange;
    const errorRange =
      previousEdit && pos >= previousEdit.from && pos <= previousEdit.to
        ? previousEdit
        : documentErrorRanges.find((range) => pos >= range.from && pos <= range.to);
    // 错误区的编辑锁独立于手动展开；空白落点只移动光标，不展开邻近公式或脚本。
    const nextRange = errorRange
      ? null
      : clickSourceRange(doc, pos, sourceRange, hit.isWhitespace === true);
    const changed =
      JSON.stringify(nextRange) !== JSON.stringify(sourceRange) ||
      (previousEdit !== null && previousEdit !== errorRange);
    errorEditRange = errorRange ?? null;
    sourceOpen = true;
    sourceRange = nextRange;
    documentCaret = changed ? null : hit;
    const clickedInput = currentInput();
    await tick();
    if (seq !== interactionSeq || clickedInput !== currentInput()) return;
    positioningFromPage = true;
    try {
      editorRef?.revealAt(pos, sourceRange ?? errorRange);
    } finally {
      positioningFromPage = false;
    }
    if (changed || (previousEdit !== errorEditRange && writeScheduler.stats().inFlight))
      void compileNow("mode");
  }

  function closeSource(): void {
    const expanded = sourceRange !== null || errorEditRange !== null;
    sourceOpen = false;
    sourceRange = null;
    errorEditRange = null;
    interactionSeq++;
    previewPaneRef?.body()?.focus();
    if (expanded) void compileNow("mode");
  }

  async function updateDocumentCaret(line: number, col: number): Promise<void> {
    const input = currentInput();
    const seq = ++interactionSeq;
    if (input !== renderedInput || documentGeometryId === 0) {
      documentCaret = null;
      return;
    }
    const pos = documentCoordinates.linePosition(line, col);
    const prefix = prefixEnabled ? ensureTrailingNewline(prefixCode) : "";
    const offset = renderedCoordinates.toByte(
      renderedProjection.sourceToRendered(prefix.length + pos),
    );
    if (documentCaret?.offset === offset) return;
    const caret = await locateDocumentCursor(documentGeometryId, offset);
    if (seq === interactionSeq && input === currentInput() && input === renderedInput)
      documentCaret = caret;
  }

  // 设置弹窗里的**草稿**（点“保存”才写回并持久化）：一个 `$state` 对象，
  // 打开时用 `copySettings` 从生效配置拷一份 —— 见 core/app-settings.ts 的三条理由。
  // 模板里用 `bind:xxx={settingsDraft.xxx}` 绑进它的成员（SettingsDialog 的 props 形状没变）。
  let settingsDraft = $state<AppSettings>(copySettings(SETTINGS_DEFAULTS));
  // ---------------------------------------------------------------------------
  // 字体设置（见 font-settings.ts / font-warnings.ts 的模块注释）
  // 起因：typst 默认正文是 Libertinus Serif（无汉字），不指定字体时中文全走自动回退，
  // 结果是 Windows 楷体/隶书、Linux 黑体日文字形（2026-09-14 实测）。Rust 侧注入默认字体族
  // 终结了这件事，这里只是把用户的选择与"额外字体目录"传下去。
  // ---------------------------------------------------------------------------
  /** 正文字体（中文）：空串 = 内置默认（思源宋体优先 + 系统宋体兜底） */
  let chineseFont = $state(SETTINGS_DEFAULTS.chineseFont);
  /** 额外字体目录（对齐 typst CLI 的 --font-path） */
  let fontDirs = $state<string[]>([...SETTINGS_DEFAULTS.fontDirs]);
  /** 可用字体族（设置里下拉的数据源，打开设置时从 Rust 取一次） */
  let availableFonts = $state<string[]>([]);
  /** Rust 内置默认字体族（拼"选中项 + 其余兜底"用；启动时取一次） */
  let defaultFonts = $state<string[]>([]);
  let fontsLoading = $state(false);
  // 启动时恢复上次未保存的内容（设置弹窗里的开关，默认开；关掉即回到"每次全新开始"）
  let restoreSession = $state(SETTINGS_DEFAULTS.restoreSession);

  // ---------------------------------------------------------------------------
  // 自动更新（tauri-plugin-updater；端点与签名公钥在 tauri.conf.json 的 plugins.updater）
  // ---------------------------------------------------------------------------
  /** 启动时自动检查更新（设置弹窗开关，默认开）。只影响自动检查，菜单里的手动检查始终可用 */
  let autoCheckUpdates = $state(SETTINGS_DEFAULTS.autoCheckUpdates);

  // 更新流程状态机：类型与语义见 update-utils.ts 的 UpdateFlow（刻意做成单个可判别联合，
  // 而不是若干布尔量——理由写在那边的注释里）
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

  /** 状态栏的更新提示（点击重开更新弹窗）；无提示时为 null（文案在 update-flow.ts，有单测） */
  const updateNotice = $derived(updateNoticeText(updateFlow));

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
      statusText = CHECKING_STATUS;
      // 手动检查 = 用户主动想知道有没有更新：清掉"别再自动弹窗"标记（"直到点了检查更新"）
      clearUpdateDismissed();
    }

    const outcome = await checkForUpdate();
    // 记一笔"上次检查时间"备查（自动 / 手动都记）：**它不再是节流门**，别拿它拦启动检查
    lastUpdateCheckAt = Date.now();
    schedulePersist();

    // 有可用新版本：释放上一个句柄，换成新的
    if (outcome.kind === "available") {
      await closeUpdate(updateHandle);
      updateHandle = outcome.update;
    }
    // 状态机 / 状态栏 / 弹窗怎么摆全在 update-flow.ts（有单测）：那里锁着"点过「稍后」之后
    // 自动检查不弹窗、也不动状态文字"这条红线，以及"手动检查永远弹窗"。
    const plan = planUpdateCheck(outcome, { manual, dismissedAt: updateDismissedAt });
    updateFlow = plan.flow;
    if (plan.status !== null) statusText = plan.status;
    if (plan.openDialog) showUpdateDialog = true;
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
    const plan = planDismiss(Date.now());
    updateDismissedAt = plan.dismissedAt;
    schedulePersist();
    statusText = plan.status;
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
    updateFlow = planInstallStart(handle.version);
    const result = await downloadAndInstallUpdate(handle, (progress) => {
      // 用户可能已经点了「关闭」；只要还在下载阶段就继续更新进度
      if (updateFlow.kind === "downloading") updateFlow = { ...updateFlow, progress };
    });
    const plan = planInstallResult(result, handle.version);
    updateFlow = plan.flow;
    statusText = plan.status;
    if (plan.openDialog) showUpdateDialog = true; // 失败必须让用户看见
  }

  /** 关闭弹窗：保存后关闭 */
  async function onClosePromptSave() {
    showClosePrompt = false;
    const saved = await docSession.save();
    if (saved) getCurrentWindow().destroy(); // destroy 不再次触发 close-requested
  }

  /** 关闭弹窗：不保存，直接关闭 */
  function onClosePromptDiscard() {
    showClosePrompt = false;
    getCurrentWindow().destroy();
  }

  /**
   * 关于弹窗里的「项目主页」：交给系统默认浏览器打开（opener 插件，权限 `opener:default`
   * 里的 `allow-open-url`；**加新的外部链接时别忘了它还在权限表里**）。
   * 失败只写状态栏 + 调试日志（不弹错窗）：这只是一种"顺手点一下"的动作。
   */
  async function openProjectPage() {
    try {
      await openUrl(PROJECT_URL);
      showAbout = false;
      statusText = "已在浏览器打开项目主页";
    } catch (e) {
      dbg.log("about", "打开项目主页失败", e);
      statusText = `打开项目主页失败：${PROJECT_URL}`;
    }
  }

  /** 关闭弹窗：取消，保持窗口打开 */
  function onClosePromptCancel() {
    showClosePrompt = false;
  }

  /** 轻量防抖：内容/主题/路径变化后 300ms 写入 localStorage */
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      saveState(
        {
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
        },
        // 副窗口（Ctrl+Shift+N 新建的草稿窗口）只写设置：它对存档里的会话字段没有所有权，
        // 否则改一次主题就把主窗口的未保存内容换成自己这份空文档（见 persistence.saveState）
        { session: !isSecondaryWindow },
      );
    }, 300);
  }

  /**
   * 执行格式命令（菜单 / 快捷键）：把标记插到编辑器光标处，由编辑器侧完成事务。
   * 焦点在输入框（设置弹窗的 textarea）时不动编辑器——否则打字会被插标记。
   */
  function runFormat(command: WriteCommand) {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
    if (viewMode === "write") sourceOpen = true;
    void tick().then(() => editorRef?.runWriteCommand(command));
  }

  /**
   * 改缩放并反馈（滚轮 / 键盘 / 菜单共用）；值没变时提示"已到边界"，不重复写存档。
   * **这是唯一的档位写入口**：控制器只通过 requestLevel 表达"用户要这个值"，不自己写 uiZoom。
   */
  function setUiZoom(next: number) {
    const target = clampZoom(next);
    if (target === uiZoom) {
      statusText = `缩放已是 ${zoomLabel(target)}`;
      return;
    }
    uiZoom = target; // $effect 把它交给 webview（见下方 zoom.apply 的 effect）
    statusText = `缩放 ${zoomLabel(target)}`;
    schedulePersist();
  }

  /** 缩放复位 100%（视图菜单）：整档操作，先丢掉滚轮余量 */
  function resetUiZoom() {
    if (uiZoom === ZOOM_DEFAULT) {
      statusText = "缩放已是 100%";
      return;
    }
    zoom.resetWheel();
    setUiZoom(ZOOM_DEFAULT);
  }

  /**
   * `Ctrl+Shift+=` / `Ctrl+Shift+-`：±1 格（用户 2026-09-16 要求）。
   *
   * 与滚轮走**同一条** setUiZoom → 引擎改档 → 复核链路，所以状态栏文案、存档、复核三处行为完全
   * 一致；差别只在于**没有滚轮手势**——WebView2 那条"手势结束时把 ZoomFactor 抹回去"的路径
   * （#1022）碰不到这里，这也是它被用户当"缩放失败的备用手段"的原因（见 app-keys.zoomKeySteps）。
   */
  function zoomBySteps(steps: 1 | -1) {
    zoom.step(steps); // 里面先丢掉滚轮余量（键盘调档没有"半格"这回事）
  }

  /**
   * Ctrl+滚轮：放大/缩小整个界面（编辑区 + 预览 + 菜单 + 状态栏）。
   *
   * 命中时**必须 preventDefault**：否则这次滚动会继续滚动编辑器/预览区，WebView2 还可能顺手用
   * 它自己那套系数缩放页面（与我们的系数打架，表现为"缩放了但系数对不上"）。位移量同时看
   * deltaY / deltaX（按 Shift 滚轮时浏览器把纵向转成横向）；"不足一档要攒着"的余量逻辑在
   * zoom-controller.ts（那里还有 2026-09-16 修的那个死区）。
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
    zoom.wheel(e.deltaY, e.deltaX, e.deltaMode);
  }

  // 缩放变化同时更新预览画布与 webview；ResizeObserver 会在引擎完成缩放后再校正一次。
  $effect(() => {
    applyPreviewScale();
    void zoom.apply(uiZoom);
  });

  /** 模式切换保留编辑器；离开展开态时恢复原文的编译输入。 */
  function toggleViewMode() {
    editorRef?.captureCaretAnchor();
    interactionSeq++;
    const needsCompile =
      sourceRange !== null ||
      errorEditRange !== null ||
      documentErrorRanges.length > 0 ||
      errorCount > 0 ||
      previewError !== "" ||
      writeScheduler.stats().inFlight;
    sourceRange = null;
    errorEditRange = null;
    viewMode = viewMode === "write" ? "source" : "write";
    if (needsCompile) {
      documentGeometryId = 0;
      documentCaret = null;
      void compileNow("mode");
    }
    showPreview = viewMode === "source";
    sourceOpen = false;
    schedulePersist();
    statusText = viewMode === "write" ? "文档模式" : "源代码模式";
    void tick().then(() => {
      applyPreviewScale();
      if (viewMode === "source") editorRef?.focus();
    });
  }

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
    if (viewMode === "write" && sourceOpen && !sourceRange && !positioningFromPage) {
      const pos =
        doc
          .split("\n")
          .slice(0, line - 1)
          .reduce((sum, text) => sum + text.length + 1, 0) +
        col -
        1;
      let recompile = false;
      if (errorEditRange && (pos < errorEditRange.from || pos > errorEditRange.to)) {
        errorEditRange = null;
        recompile = true;
      }
      const inErrorSource =
        errorEditRange !== null ||
        documentErrorRanges.some((range) => pos >= range.from && pos <= range.to);
      if (!inErrorSource) {
        const range = sourceRevealRange(doc, pos);
        if (range.kind !== "text" && range.to > range.from) {
          sourceRange = { from: range.from, to: range.to };
          recompile = true;
        }
      }
      if (recompile) void compileNow("mode");
    }
    void updateDocumentCaret(line, col);
  }

  function handleDocChange(newDoc: string, mapPosition: (pos: number, assoc?: number) => number) {
    if (sourceRange)
      sourceRange = { from: mapPosition(sourceRange.from, -1), to: mapPosition(sourceRange.to, 1) };
    if (errorEditRange)
      errorEditRange = {
        from: mapPosition(errorEditRange.from, -1),
        to: mapPosition(errorEditRange.to, 1),
      };
    documentErrorRanges = documentErrorRanges.map((range) => ({
      from: mapPosition(range.from, -1),
      to: mapPosition(range.to, 1),
    }));
    doc = newDoc;
    editorDoc = newDoc; // 镜像同步（见 editorDoc 声明处）：陈旧镜像 = 切模式/重挂载时丢内容
    // 脏标记不用手动置位：`dirty` 由 doc 与 baseline 现算（见其声明处），改回原样/删光都自然跟上
    // 文档修订 +1：在途的编译结果据此判废（见 runCompile 的戳比较）
    documentRevision += 1;
    interactionSeq++;
    documentCaret = null;
    scheduleCompile();
    schedulePersist();
  }

  // ---------------------------------------------------------------------------
  // 文档生命周期（打开 / 保存 / 重新读取 / 新建）在 `$lib/core/document-session`
  // ---------------------------------------------------------------------------
  // 这里只注入页面状态与文件读写；四条契约（脏文档必问、写盘唯一入口、`applyLoaded` 只此一份、
  // 新建连会话存档一起清）的完整说明在那边。**读页面状态的 hook 全是箭头函数**，在调用时取值 ——
  // 别改成创建时快照（`filePath` / `baseline` / `doc` 每次都不同）；`isDesktop` / `readFile` /
  // `writeFile` / `pickFile` 直接引用 import 进来的纯函数，它们不读 `$state`。
  //
  // **唯一**把文档状态写回 `$state` 的地方：字段清单与"迁移后该长什么样"都在
  // `core/document-session.ts` 的三个纯函数里（`loadedState` / `savedState` / `newState`），
  // 这里只负责赋值（`dirty` 从中派生，见其声明处）。`editorDoc` 放**最后**落 —— 它是编辑器内容的
  // 实时镜像（见其声明处）。
  function applyDocState(next: DocumentState) {
    doc = next.doc;
    filePath = next.filePath;
    fileTitle = next.fileTitle;
    baseline = next.baseline;
    editorDoc = next.editorDoc;
  }

  const docSession = createDocumentSession({
    doc: () => doc,
    filePath: () => filePath,
    fileTitle: () => fileTitle,
    baseline: () => baseline,
    applyLoaded: (content, path) => applyDocState(loadedState(content, path)),
    applySaved: (path) => applyDocState(savedState(path, doc)),
    applyNew: () => applyDocState(newState()),
    afterLoad: () => {
      resetDocumentRender();
      scheduleCompile();
      schedulePersist();
    },
    afterSave: () => {
      schedulePersist();
      // 首次保存/另存为改变相对路径的解析根，整页产物必须对应新路径。
      if (renderedInput !== currentInput()) scheduleCompile();
    },
    afterNew: () => {
      resetDocumentRender();
      scheduleCompile();
    },
    // 清存档**只由主窗口做**：这份会话是主窗口的，副窗口里点"新建"不该把主窗口的未保存内容
    // 从存档里抹掉（副窗口自己的内容是空的，后面 schedulePersist 也只写设置）
    clearSession: () => {
      if (!isSecondaryWindow) clearState();
    },
    setStatus: (text) => {
      statusText = text;
    },
    isDesktop: isTauri,
    confirmNative: (message, title) => confirm(message, { title, kind: "warning" }),
    readFile: readTypFile,
    writeFile: saveTypFile,
    pickFile: openTypFile,
  });

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
        : previewSelectionHasContent(window.getSelection(), previewPaneRef?.paper() ?? null);
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
        return { type: "item", label, disabled, onClick: () => void docSession.save() };
      case "export-pdf":
        return { type: "item", label, disabled, onClick: () => handleExportPdf() };
      case "settings":
        return { type: "item", label, disabled, onClick: () => openSettings() };
      case "open":
        return { type: "item", label, disabled, onClick: () => void docSession.open() };
      default:
        return { type: "item", label, disabled };
    }
  }

  /** 预览区全选：用 Selection API 选中整个预览容器（SVG 不可编辑，execCommand selectAll 不适用） */
  function selectAllPreview() {
    const sel = window.getSelection();
    const paper = previewPaneRef?.paper();
    if (!sel || !paper) return;
    const range = document.createRange();
    range.selectNodeContents(paper);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * 菜单表：结构由 menu-model.ts 的 buildMenuGroups 纯函数产出（快捷键 → 命令映射、勾选态
   * 都有单测，见 menu-model.test.ts）；这里只把当前状态与命令回调喂进去。
   */
  function menuGroups(): MenuGroup[] {
    return buildMenuGroups({
      viewMode,
      showPreview,
      sourceOpen,
      editorWrap,
      uiZoom,
      theme,
      onNew: () => void docSession.createNew(),
      onNewWindow: () => newWindow.open(),
      onOpen: () => void docSession.open(),
      onSave: () => void docSession.save(),
      onOpenSettings: openSettings,
      onExportPdf: handleExportPdf,
      runFormat,
      onToggleViewMode: toggleViewMode,
      onTogglePreview: () => {
        if (viewMode === "source") showPreview = !showPreview;
        else {
          if (sourceOpen) closeSource();
          else {
            sourceOpen = true;
            handleCursor(cursorLine, cursorCol);
            void tick().then(() => editorRef?.focus());
          }
        }
      },
      onToggleWrap: toggleEditorWrap,
      onZoomIn: () => zoomBySteps(1),
      onZoomOut: () => zoomBySteps(-1),
      onResetZoom: resetUiZoom,
      onSetTheme: (t) => (theme = t),
      onCheckUpdates: () => checkUpdates(true),
      onShowAbout: () => (showAbout = true),
    });
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
    if (viewMode === "source" || sourceOpen) editorRef?.focus();
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
        statusText = failureStatus("导出失败", result.error);
      }
    } catch (e) {
      statusText = failureStatus("导出失败", e);
    }
  }

  function handleComposition(active: boolean): void {
    writeScheduler.setComposing(active);
  }

  function resetDocumentRender(): void {
    writeScheduler.cancelPending();
    documentSession++;
    documentRevision = 0;
    interactionSeq++;
    documentGeometryId = 0;
    renderedInput = "";
    documentCaret = null;
    sourceOpen = false;
    sourceRange = null;
    renderedProjection = projectDocument("", null);
    renderedCoordinates = createSourceCoordinates("");
    renderedPages = null;
    documentErrorRanges = [];
    errorEditRange = null;
    previewStatus = "idle";
    previewError = "";
    pageCount = 0;
    previewPaneRef?.clearPages();
  }

  function fontArgs() {
    return {
      families: buildFontFamilies(chineseFont, defaultFonts),
      dirs: normalizeFontDirs(fontDirs),
    };
  }

  // 字体下拉的数据源（扫描 / 添加目录 / 移除目录）在 `$lib/core/font-list`：
  // 这里只注入页面状态与三个 Rust 调用，"归一化目录"和"默认族不许被空列表覆盖"两条规则在那边。
  const fontList = createFontList({
    listFamilies: listFontFamilies,
    defaultFamilies: defaultFontFamilies,
    pickDir: pickFontDir,
    setFamilies: (families) => {
      availableFonts = families;
    },
    setDefaults: (families) => {
      const before = JSON.stringify(fontArgs());
      defaultFonts = families;
      if (before !== JSON.stringify(fontArgs())) void compileNow("context");
    },
    setLoading: (loading) => {
      fontsLoading = loading;
    },
    dirs: () => settingsDraft.fontDirs,
    setDirs: (dirs) => {
      settingsDraft.fontDirs = dirs;
    },
  });

  /**
   * 警告列表条目（组装在 status-view.ts，有单测）：有源码位置的可点击跳转（消息已翻成中文
   * 可行动提示），否则纯展示。
   */
  function warningItems(): ErrorListItem[] {
    return buildWarningItems(compileWarnings);
  }

  const writeScheduler = createDocumentCompileScheduler({
    run: () => runCompile(),
    debounceMs: 150,
    log: (message) => dbg.log("compile-schedule", message),
  });
  // 浏览器验收的只读计数钩子（`?browserdev=1` 才挂；桌面版空操作）
  registerWriteTestHooks(() => writeScheduler.stats());

  function compileNow(reason: CompileReason): Promise<void> {
    return writeScheduler.requestNow(reason);
  }

  /** 错误浮层当前的条目（组装在 status-view.ts，有单测；复制/渲染共用一份来源） */
  function errorItems(): ErrorListItem[] {
    return buildErrorItems(editorDiagnostics, lastNonPosError);
  }

  /**
   * 复制诊断信息（状态栏浮层里的「复制」/「复制全部」按钮，用户要求"路径贴到前面"）。
   * 只写剪贴板 + 状态栏反馈，**不动浮层开合、不动光标、不触发重编译**。
   */
  async function copyDiagnostic(item: ErrorListItem, kind: "errors" | "warnings") {
    const text = formatDiagnosticForClipboard(item, filePath);
    const ok = await copyPlainText(text);
    statusText = diagnosticCopyStatus(kind, ok);
  }

  /** 复制整个列表：首行是浮层标题原文（如 `编译错误（2 处）`），其后每条一行 */
  async function copyDiagnosticList(kind: "errors" | "warnings") {
    const items = kind === "errors" ? errorItems() : warningItems();
    const count = items.length;
    const title = diagnosticListTitle(kind, count);
    const ok = await copyPlainText(formatDiagnosticListForClipboard(title, items, filePath));
    statusText = diagnosticCopyAllStatus(kind, count, ok);
  }

  function scheduleCompile() {
    writeScheduler.request("edit");
  }

  /** 生效配置（读页面 `$state`）：**调用时**取值，别缓存 */
  function currentSettings(): AppSettings {
    return {
      prefixEnabled,
      prefixCode,
      chineseFont,
      fontDirs,
      restoreSession,
      autoCheckUpdates,
    };
  }

  /**
   * 把生效配置写回 `$state` 的唯一入口：设置弹窗保存走它，启动恢复（`planRestore`）也走它。
   * 但 `AppSettings` 的字段清单**别处还有三份**要跟着改：① `currentSettings()`（读页面状态）、
   * ② `core/session-restore.ts` 的 `planRestore`（存档 → 设置）、③ `schedulePersist` 的快照
   * （设置 → 存档）。漏一处就是"设置了但没恢复 / 没持久化"——加字段时
   * `app-settings.test.ts` 的"字段清单绊线"会红，提醒回来把这几处对齐。
   */
  function applySettings(next: AppSettings) {
    prefixEnabled = next.prefixEnabled;
    prefixCode = next.prefixCode;
    restoreSession = next.restoreSession;
    autoCheckUpdates = next.autoCheckUpdates;
    chineseFont = next.chineseFont;
    fontDirs = next.fontDirs;
  }

  /** 打开设置弹窗：载入生效配置的**副本**，点“保存”才生效 */
  function openSettings() {
    settingsDraft = copySettings(currentSettings());
    showSettings = true;
    // 字体下拉的选项来自 Rust 侧真实注册的字体（结构上不可能写出一个不存在的族名）
    void fontList.refresh(settingsDraft.fontDirs);
  }

  /** 保存设置：把草稿落成生效配置并持久化 */
  function saveSettings() {
    const diff = diffSettings(currentSettings(), settingsDraft);
    applySettings(diff.applied);
    schedulePersist();
    showSettings = false;
    // **保存后立即重编译**：以前只写状态不重编译，预览停在上一次结果，看起来就是
    // "改了字体/前缀没生效"（要在正文里敲一个字才刷新）。字体与前缀都会进编译源，故都要重编译。
    if (diff.fontsChanged || diff.prefixChanged) {
      // 重编译落地后再定状态栏文案：编译只写「就绪」时补「设置已保存」，有警告/错误就让位
      // （实测：点保存后 "设置已保存" 一闪而过，验收也因此判失败 —— 见 app-settings.ts）。
      // 走 `compileNow`：写作模式下这是"编译上下文的输入变了"，必须由单槽调度器登记（复审第 2 条）
      void compileNow("context").finally(() => {
        statusText = statusAfterSettingsSave(statusText);
      });
    }
    statusText = SETTINGS_SAVED_STATUS;
  }

  /** 关闭设置弹窗：放弃未保存的修改 */
  function closeSettings() {
    showSettings = false;
  }

  function applyPreviewScale() {
    const body = previewPaneRef?.body();
    const paper = previewPaneRef?.paper();
    if (!body || !paper) return;
    const actualPageWidthPt = previewPaneRef?.pageWidthPt() ?? 0;
    if (actualPageWidthPt <= 0) {
      paper.style.width = "";
      return;
    }
    const containerWidth = body.clientWidth;
    const displayWidth = previewCanvasWidth({
      containerWidth,
      pageWidthPt: actualPageWidthPt,
      uiZoom,
    });
    const width = Number.isNaN(displayWidth) ? "" : `${displayWidth}px`;
    if (paper.style.width !== width) paper.style.width = width;
  }

  /**
   * 把编译结果这份派生状态落到页面（组装在 compile-status.ts，有单测）：
   * 状态栏文案、错误/警告计数、波浪线、字符数。
   * **成功才动页数与字符数**——失败时保留上一次成功预览（两条编译路径共用这一条语义）。
   */
  function applyCompileStatus(result: CompileStatusSource, docLength: number) {
    const patch = reduceCompileStatus(result, docLength);
    editorDiagnostics = patch.editorDiagnostics;
    errorCount = patch.errorCount;
    compileWarnings = patch.compileWarnings;
    lastNonPosError = patch.lastNonPosError;
    statusText = patch.statusText;
    if (patch.ok) {
      pageCount = patch.pageCount;
      charCount = patch.charCount;
      previewStatus = "ready";
    }
  }

  async function runCompile() {
    if (compileSeq === 0) mark("compile-request");
    const mySeq = ++compileSeq;
    const input = currentInput();
    const source = prefixEnabled ? ensureTrailingNewline(prefixCode) + doc : doc;
    const prefixLength = source.length - doc.length;
    const mode = viewMode;
    const path = filePath;
    const fonts = fontArgs();
    // 基准只来自已经落地的本会话产物；在途和回退中的临时产物不能成为引用来源。
    const previous = renderedPages;
    const editing = errorEditRange;
    const isCurrent = () =>
      mySeq === compileSeq &&
      input === currentInput() &&
      mode === viewMode &&
      editing === errorEditRange;
    const { result, projection, failure, errorRanges, editingRange, deferred } =
      await compileDocumentWithFallback({
        source,
        prefixLength,
        reveal:
          mode === "write" && sourceRange
            ? { from: prefixLength + sourceRange.from, to: prefixLength + sourceRange.to }
            : null,
        editing:
          mode === "write" && editing
            ? { from: prefixLength + editing.from, to: prefixLength + editing.to }
            : null,
        recover: mode === "write",
        compile: (src) => compileToSvg(src, path, fonts, previous),
        isCurrent,
        canRetry: () => {
          if (!writeScheduler.stats().composing) return true;
          // 留下一份需求，合成结束后再从最终原文重新诊断与恢复。
          scheduleCompile();
          return false;
        },
      });
    if (mySeq === 1) {
      mark("first-compile-result");
      reportStartup();
    }
    // 文本、会话、字体和前缀在等待期间变化时，迟到的成功与失败均不能落地。
    if (!isCurrent() || deferred) return;
    if (result.ok) {
      if (!previewPaneRef?.paper()) return;
      previewPaneRef.updatePages(result.pages);
      renderedPages = result;
      documentGeometryId = result.geometryId ?? 0;
      documentCaret = null;
      renderedInput = input;
      if (renderedProjection.source !== projection.source)
        renderedCoordinates = createSourceCoordinates(projection.source);
      renderedProjection = projection;
      documentErrorRanges = errorRanges.map((range) => ({
        from: range.from - prefixLength,
        to: range.to - prefixLength,
      }));
      if (!editingRange) errorEditRange = null;
      previewError = failure?.error ?? "";
      applyCompileStatus(result, doc.length);
      if (failure) applyCompileStatus(failure, doc.length);
      await tick();
      applyPreviewScale();
      void updateDocumentCaret(cursorLine, cursorCol);
    } else {
      documentGeometryId = 0;
      documentCaret = null;
      documentErrorRanges = [];
      applyCompileStatus(failure ?? result, doc.length);
      previewError = (failure ?? result).error;
      // 前缀、外部文件或不可定位的错误无法局部回退，保留旧产物并禁用命中。
      if (previewStatus !== "ready") previewStatus = "error";
    }
  }

  /**
   * 窗口标题同步为“文件名 - Typst-pad”；有未保存修改时文件名后加圆点（Tauri）。
   *
   * 圆点用 `•`（U+2022）而不是 `●`（U+25CF）：原生标题栏的字号由系统定、改不了，只有换更小的
   * 字形这一条路（用户 2026-09-28 反馈「圆点太大」）。判据是 `dirty`（正文 ≠ 基线），
   * 不再看"编辑过没有"的标志位——见 `isDocModified`。
   */
  function syncWindowTitle() {
    if (!isTauri()) return;
    getCurrentWindow().setTitle(`${fileTitle}${dirty ? " •" : ""} - Typst-pad`);
  }

  // fileTitle / dirty 变化时（打开/保存/新建/编辑）同步窗口标题
  $effect(() => {
    syncWindowTitle();
  });

  /**
   * 状态栏 Popover 点击条目（错误列表与警告列表**共用**这一条路径）：
   * - 条目落在前缀代码内（启用前缀时）：不跳编辑器，打开设置弹窗并定位到前缀对应行；
   * - 否则：跳转编辑器对应行列。
   * 两种情况都**顺手收起浮层** —— 跳完还盖在编辑区上就没法用了（警告列表以前漏了这步，
   * 用户 2026-09-18 反馈「关闭警告的行为应该和错误是一样的」）。
   */
  function onDiagnosticItemClick(item: LocatedErrorItem) {
    // 注：isErrorLineInPrefix（组件里的 focusPrefixLine → prefixLineCharOffset 同理）用未规范化的
    // prefixCode 草稿值即可——
    // 追加尾换行不改变前缀区内行号与行首偏移，与规范化后的编译源语义一致
    if (prefixEnabled && isErrorLineInPrefix(item.line, prefixCode)) {
      openBadgePopover = "none";
      openSettings(); // 载入当前前缀的**草稿副本**（settingsDraft），点“保存”才生效
      // 下一 tick：等设置弹窗渲染出前缀 textarea，再让组件自己定位（偏移按草稿前缀算）
      void tick().then(() => settingsDialogRef?.focusPrefixLine(item.line));
    } else {
      sourceOpen = true;
      jumpTarget = { line: item.line, col: item.col, seq: ++jumpSeq };
      openBadgePopover = "none";
    }
  }

  /** 脚本错误统一提示：状态栏给出可读原因 + 调试日志留完整堆栈 */
  /**
   * Chromium 自己的提示，不算应用的脚本错误：
   * "ResizeObserver loop completed with undelivered notifications." 是引擎在"RO 回调里改了布局、
   * 同一帧又要再触发一次回调"时发的警告，规范上允许、后果只是把这次通知推迟到下一帧。
   * 我们的预览画布正好是"量到宽度 → 设宽度"这种模式，所以它在缩放/改分栏时会偶发出现。
   * 报成「脚本错误」会让用户以为应用坏了（2026-09-14 实测被反馈），只写调试日志。
   */
  function reportScriptError(label: string, detail: unknown) {
    const msg = scriptErrorMessage(detail);
    if (isBenignScriptError(msg)) {
      dbg.log("error", `${label}（引擎提示，忽略）`, detail);
      return;
    }
    statusText = scriptErrorStatus(msg);
    dbg.log("error", label, detail);
    console.error(`[script-error] ${label}`, detail);
  }

  function onWindowError(e: ErrorEvent) {
    reportScriptError("window.onerror", e.error ?? e.message);
  }

  function onUnhandledRejection(e: PromiseRejectionEvent) {
    reportScriptError("unhandledrejection", e.reason);
  }

  /**
   * 新建窗口（`Ctrl+Shift+N` / 菜单「文件 → 新建窗口」）：新窗口是**空白草稿窗口**，
   * 起来不恢复上次内容、写存档只写设置（见 isSecondaryWindow 的说明）。
   *
   * 三条规则（label 唯一 + 前缀与 capabilities 的 `editor-*` 一致 + 失败报到状态栏）在
   * `$lib/core/new-window`：这里只把 Tauri 的建窗口动作、状态栏与调试日志喂进去。
   *
   * **`new WebviewWindow()` 走的是 `plugin:webview|create_webview_window`**，需要在
   * capabilities/default.json 里显式写 `core:webview:allow-create-webview-window`（`core:default`
   * 里没有），缺了就在**运行时**被拒（0.7.9 这样发出去过）。这类 ACL 拒绝浏览器验收碰不到，
   * 所以另有 `scripts/capabilities.test.mjs` 做静态体检：改这里的 Tauri 调用后去那张表补一行。
   */
  const newWindow = createNewWindow({
    isTauri,
    createWindow: (label, title, onAsyncError) => {
      const win = new WebviewWindow(label, {
        url: "/",
        title,
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        center: true,
      });
      // 创建失败（label 撞车 / 系统拒绝）在发布版里是看不见的（没有 devtools），由模块报到状态栏
      void win.once("tauri://error", (e) => {
        onAsyncError((e as { payload?: unknown }).payload);
      });
    },
    setStatus: (text) => {
      statusText = text;
    },
    logCreateFailure: (detail) => dbg.log("window", "new-window error", detail),
    now: () => Date.now(),
  });

  /** 关闭当前窗口（Ctrl+W）：与标题栏关闭走同一条路（未保存修改会先弹确认，
   * 判据见 `core/window-events.ts` 的 `createCloseGuard`） */
  function closeCurrentWindow() {
    if (!isTauri()) return;
    void getCurrentWindow().close();
  }

  // `open-file` 广播的接球规则（有焦点的窗口接 / 没焦点时主窗口延迟兜底 / 副窗口不抢 /
  // 启动时就绪后只主窗口取一次）在 `$lib/core/open-file-claim`：这里只注入 Tauri 侧的
  // "有没有焦点"、待打开队列，以及文档会话的打开动作。
  const openFileClaim = createOpenFileClaim({
    // 查询失败按"没有焦点"处理这条规则在模块里（`isFocused` 的 try/catch）
    isFocused: () => getCurrentWindow().isFocused(),
    isSecondaryWindow,
    // Rust 侧那份队列同时是"这个文件已被某窗口接走"的记号（取到空数组 = 别人先接了）；
    // 取哪一条（最后一个 = 最新请求）由模块的 `lastPending` 决定
    takePending: async () => {
      try {
        return await invoke<string[]>("take_pending_files");
      } catch {
        return [];
      }
    },
    openPath: (path) => docSession.openPath(path),
  });

  // 桌面窗口级事件的两条规则（拖放 / 关闭确认）在 `$lib/core/window-events`：
  // 这里只注入页面状态（覆盖层开关、状态栏、关闭确认弹窗）与文档会话的打开动作。
  const dropHandler = createDropHandler({
    setDragActive: (active) => {
      dragActive = active;
    },
    openPath: (path) => docSession.openPath(path),
    setStatus: (text) => {
      statusText = text;
    },
  });
  const closeGuard = createCloseGuard({
    doc: () => doc,
    baseline: () => baseline,
    prompt: () => {
      showClosePrompt = true;
    },
  });

  /** Esc 关掉最上层的弹窗（顺序见 app-keys.topModal）；每种都取**破坏性最小**的那个"关闭"语义 */
  function dismissModal(modal: AppModal) {
    switch (modal) {
      case "close-prompt":
        onClosePromptCancel(); // = 弹窗里的「取消」：窗口继续开着
        return;
      case "update":
        // 只把弹窗收起来（状态栏仍留着「可更新到 vX」入口）。**绝不能在这里写 updateDismissedAt**：
        // 那等于替用户点了「稍后」= 以后再也不自动弹更新窗，一个 Esc 不该有这种后果。
        showUpdateDialog = false;
        return;
      case "settings":
        closeSettings(); // = 弹窗里的「关闭」：放弃未保存的草稿（按「保存」才生效，见 openSettings）
        return;
      case "about":
        showAbout = false;
        return;
    }
  }

  /**
   * 页面级快捷键：判定在 app-keys.decideAppKey（纯函数，有单测），执行在 app-keys.runAppKeyAction
   * （动作 → 回调表，preventDefault 统一在动作之前）。这里只提供当前状态与回调。
   *
   * **判定顺序本身就是行为**：`Ctrl+Shift+N` 必须排在 Shift 格式表之前，否则新建窗口会被整段吞掉
   * —— 0.7.0 起就是这个状态，用户 2026-09-14 报「Ctrl+Shift+N 新建窗口」没反应（顺序锁在
   * decideAppKey 里，app-keys.test.ts 逐条对着）。
   * 菜单项的全局快捷键（Ctrl+N 新建 / Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+, 设置 / Ctrl+P 导出 PDF）
   * 由 MenuBar 的 window keydown 统一处理，不在此重复绑定（避免同一组合键双重触发）。
   */
  function handleKeydown(e: KeyboardEvent) {
    if (
      e.key === "Escape" &&
      sourceOpen &&
      !showClosePrompt &&
      !showUpdateDialog &&
      !showSettings &&
      !showAbout &&
      openBadgePopover === "none" &&
      !contextMenu
    ) {
      e.preventDefault();
      closeSource();
      return;
    }
    runAppKeyAction(
      decideAppKey(e, {
        hasFilePath: filePath !== null,
        openModal: topModal({
          "close-prompt": showClosePrompt,
          update: showUpdateDialog,
          settings: showSettings,
          about: showAbout,
        }),
      }),
      {
        toggleWrap: toggleEditorWrap,
        runFormat,
        // Ctrl+Shift+= / Ctrl+Shift+-：±1 格（走和滚轮同一条 setUiZoom → 引擎改档 → 复核）。
        // 必须 preventDefault（runAppKeyAction 统一做了）：否则引擎自己那套缩放会一并插手。
        zoom: zoomBySteps,
        // reloadFile 只在有文件时才会走到（没文件时 decideAppKey 返回 null，放行给浏览器刷新）
        reloadFile: () => void docSession.reload(),
        openNewWindow: () => newWindow.open(),
        closeWindow: () => void closeCurrentWindow(),
        dismissModal,
      },
      () => e.preventDefault(),
    );
  }

  onMount(() => {
    // 浏览器 gate：非 Tauri 环境（提示页）不初始化应用逻辑——编译走 Tauri 进程内命令，浏览器不可用
    if (!isDesktopApp) return;
    mark("mount-start");
    // 启动恢复：主题/前缀/模式/字体/缩放总是恢复，**上次未保存的内容**按设置决定（默认恢复，
    // 见设置弹窗"启动时恢复上次内容"）——这是"内容丢了"的最后一道安全网。
    // 五条规则（主题只认合法值、副窗口不恢复内容、空白内容不算上次内容、开关关掉只恢复偏好、
    // 标题优先用存档里那份）都在 `core/session-restore.ts`，这里只把计划落到状态上。
    const plan = planRestore(loadState(), { isSecondaryWindow });
    theme = plan.theme;
    applySettings(plan.settings); // 前缀 / 字体 / 两个开关（与设置弹窗保存走同一条落状态的路）
    viewMode = plan.viewMode;
    showPreview = plan.showPreview;
    editorWrap = plan.editorWrap;
    uiZoom = plan.uiZoom;
    lastUpdateCheckAt = plan.lastUpdateCheckAt;
    updateDismissedAt = plan.updateDismissedAt;
    if (plan.content) {
      doc = plan.content.text;
      editorDoc = plan.content.text; // 镜像同步，见 editorDoc 声明处
      filePath = plan.content.filePath;
      fileTitle = plan.content.fileTitle;
      // 存档只存了"还有没有未保存修改"，**没存基线**（基线就是整篇正文，再存一份会把
      // localStorage 撑成两倍）：还有未保存修改 ⇒ 基线未知（`null`，圆点先留着，保存一次就落到
      // 真实基线）；上次是干净的 ⇒ 恢复出来的正文就是基线（与磁盘一致）。
      baseline = plan.content.dirty ? null : plan.content.text;
      statusText = "已恢复上次内容";
    }
    mark("persist-restore");
    // 浏览器验收的只读标记：**存档已经落到 $state 上**（`?browserdev=1` 才写；见 write-test-hook）。
    // 子组件的 onMount 比这里先跑完，所以验收脚本必须等这个标记再动手（见那边的说明）。
    reportSessionRestored();

    // 关于弹窗版本号：从 Tauri 运行时读取（getVersion 返回 tauri.conf.json 的
    // version，如 0.4.0）；失败静默忽略，弹窗显示占位符
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
    // 内置默认字体族（拼"选中项 + 其余兜底"用）：静态列表，取一次即可
    const firstCompile = defaultFontFamilies().then((v) => {
      if (v.length > 0) defaultFonts = v;
      return compileNow("context");
    });
    if (isSecondaryWindow) {
      // 副窗口是草稿窗口，说明一句"这里的内容不会记进上次内容"。首次编译成功会把状态栏写成
      // 「就绪」，所以等它落地再写（只在没有更重要的话时才顶替，与 saveSettings 同一套路）。
      void firstCompile.finally(() => {
        if (statusText === "就绪") statusText = NEW_WINDOW_NOTICE;
      });
    }
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
    // **但缩放自己引发的 resize 必须让开**：引擎改档会让 `window.innerWidth` 跟着变，浏览器
    // 随即派发一次 resize，而此刻 `appliedZoom` 还是旧档位，一校就把基准压低成"新宽度"，
    // 复核就会把"引擎接受了"读成"引擎没动"（用户第五次反馈的「界面缩放未生效」就是这个）。
    // 所以判据交给纯函数 shouldRebaselineZoom：复核在跑、或还在沉降窗口内 → 不校。
    const onWindowResize = () => {
      // 视口判据的 100% 基准要跟着校；"缩放自己引发的 resize"由控制器按沉降窗口让开
      // （判据是纯函数 shouldRebaselineZoom，见 zoom-controller.onResize）
      zoom.onResize();
    };
    window.addEventListener("resize", onWindowResize);
    // 回到前台/重新聚焦时把当前档位再设一遍：WebView2 在一些时机（失焦、被系统改过缩放状态）
    // 可能把宿主设的 ZoomFactor 丢掉，而那时界面已经和状态不一致了（用户看到的就是"放大没用"）。
    // 值没被丢时这次调用是空操作；丢掉时它自己会走复核，结论照样写进状态栏（见 verifyZoomApplied）。
    const reapplyZoomOnReturn = () => {
      if (document.visibilityState !== "visible") return;
      zoom.reapply(); // 假引擎（浏览器桩）在里面直接返回
    };
    window.addEventListener("focus", reapplyZoomOnReturn);
    document.addEventListener("visibilitychange", reapplyZoomOnReturn);
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
      });
    });
    const previewBody = previewPaneRef?.body();
    if (previewBody) previewResizeObserver.observe(previewBody); // 组件在 onMount 前已挂载

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
      invoke<boolean>("get_debug_flag")
        .then(setCliDebug)
        .catch(() => {});
      // 关闭确认：只有正文与基线不同（有未保存修改）才拦下来弹三按钮弹窗（规则见
      // `core/window-events.ts` 的 `createCloseGuard`）
      keepUnlisten(getCurrentWindow().onCloseRequested((event) => closeGuard.handle(event)));
      // 窗口级拖放：把 .typ 文件拖到窗口内自动打开（覆盖层开关与"只认 .typ"的规则同上）
      keepUnlisten(
        getCurrentWindow().onDragDropEvent((event) => dropHandler.handle(event.payload)),
      );
      // 应用已运行时再次打开文件（single-instance 转发）：先注册监听再取队列，
      // 避免转发事件落在两者之间而丢失。**多窗口下这条是广播**，要挑一个窗口接，见
      // `core/open-file-claim.ts`（有焦点的窗口接，都没焦点时主窗口延迟兜底）。
      const unlistenOpen = listen<string>("open-file", (e) => {
        if (e.payload) void openFileClaim.onBroadcast(e.payload);
      });
      keepUnlisten(unlistenOpen);
      unlistenOpen.then(() => {
        // 首次启动/跨实例转发的待打开文件（关联双击）：就绪后取走（取最后一个，即最新请求）。
        // **只由主窗口取**：副窗口是草稿窗口，不该被启动参数里带的文件顶掉内容。
        // 启动/转发时就绪后取一次队列（`claimStartup` 里再判一次"只主窗口"，这层是早退）
        if (isSecondaryWindow) return;
        void openFileClaim.claimStartup();
      });
    }
    mark("mount-listeners-done");

    // 自动更新：启动后延迟一次静默检查（不阻塞首屏）。
    // **每次启动都查**，只受设置里的开关约束 —— 这里曾经还有一道"距上次检查满 6 小时才查"的节流，
    // 2026-09-14 用户报「自动更新没法用（打开的时候没有自动更新，但是检查的时候能检查到）」就是它：
    // 时间戳是上次检查写下的，于是启动时几乎永远被拦掉。别再把这道理加回来，见 update-utils.ts 的注解。
    // **只由主窗口查**：两个窗口各查一次就会各弹一个更新窗（手动检查不受限，随时可用）。
    if (autoCheckUpdates && !isSecondaryWindow) {
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
      window.removeEventListener("focus", reapplyZoomOnReturn);
      document.removeEventListener("visibilitychange", reapplyZoomOnReturn);
      zoom.dispose(); // 取消还没落地的"缩放再确认一次"
      openFileClaim.dispose(); // 关窗时取消还没落地的兜底打开
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      previewResizeObserver?.disconnect();
      if (previewScaleFrame !== 0) cancelAnimationFrame(previewScaleFrame);
      unlisteners.forEach((un) => un());
      clearTimeout(persistTimer);
      clearTimeout(startupCheckTimer); // 关窗时取消还没发起的自动更新检查
      // 取消待执行编译，并用请求代次作废在途结果。
      writeScheduler.dispose();
      unregisterWriteTestHooks();
      interactionSeq++; // 卸载后不得展开源码或写入页面光标
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

    <main
      class="panes"
      class:single={viewMode === "write" || !showPreview}
      class:document-mode={viewMode === "write"}
    >
      {#if dragActive}<div class="drop-overlay">释放以打开 .typ 文件</div>{/if}
      <section
        class="pane editor-pane"
        class:input-proxy={viewMode === "write"}
        style={viewMode === "write"
          ? `left:${inputPosition?.left ?? 0}px;top:${inputPosition?.top ?? 0}px;height:${inputPosition?.height ?? 20}px`
          : undefined}
      >
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
            wrap={viewMode === "source" ? editorWrap : false}
            onComposition={handleComposition}
          />
        </div>
      </section>
      <PreviewPane
        bind:this={previewPaneRef}
        hidden={viewMode === "source" && !showPreview}
        status={previewStatus}
        editable={viewMode === "write"}
        caret={viewMode === "write" ? documentCaret : null}
        stale={previewStatus === "ready" && renderedInput !== currentInput()}
        onPageClick={handlePageClick}
        onOpenLink={handleOpenLink}
        onCaretPosition={(position) => {
          if (position) inputPosition = position;
        }}
        onEditSource={toggleViewMode}
      />
    </main>

    <StatusBar
      {statusText}
      {updateNotice}
      onOpenUpdate={openUpdateDialogFromNotice}
      {viewMode}
      {uiZoom}
      {charCount}
      {pageCount}
      {cursorLine}
      {cursorCol}
      {errorCount}
      {lastNonPosError}
      errorItems={errorItems()}
      warningCount={compileWarnings.length}
      warningItems={warningItems()}
      openBadge={openBadgePopover}
      onToggleBadge={toggleBadgePopover}
      onCloseBadge={() => (openBadgePopover = "none")}
      onItemClick={onDiagnosticItemClick}
      onCopyOne={(item, kind) => void copyDiagnostic(item, kind)}
      onCopyAll={(kind) => void copyDiagnosticList(kind)}
    />

    {#if showAbout}
      <AboutDialog
        version={appVersion}
        projectUrl={PROJECT_URL}
        onClose={() => (showAbout = false)}
        onOpenProject={openProjectPage}
      />
    {/if}

    {#if showClosePrompt}
      <ClosePromptDialog
        onSave={onClosePromptSave}
        onDiscard={onClosePromptDiscard}
        onCancel={onClosePromptCancel}
      />
    {/if}

    {#if showSettings}
      <SettingsDialog
        bind:this={settingsDialogRef}
        bind:restoreSession={settingsDraft.restoreSession}
        bind:autoCheckUpdates={settingsDraft.autoCheckUpdates}
        bind:prefixEnabled={settingsDraft.prefixEnabled}
        bind:prefixCode={settingsDraft.prefixCode}
        bind:chineseFont={settingsDraft.chineseFont}
        bind:fontDirs={settingsDraft.fontDirs}
        {availableFonts}
        {fontsLoading}
        onAddFontDir={() => void fontList.addDir()}
        onRemoveFontDir={fontList.removeDir}
        onSave={saveSettings}
        onClose={closeSettings}
      />
    {/if}

    {#if showUpdateDialog && updateFlow.kind !== "latest" && updateFlow.kind !== "checking"}
      <UpdateDialog
        flow={updateFlow}
        onInstall={startUpdateInstall}
        onDismiss={dismissUpdatePrompt}
        onClose={() => (showUpdateDialog = false)}
        onRetry={() => checkUpdates(true)}
      />
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
  <BrowserGate />
{/if}

<style>
  .document-mode {
    position: relative;
  }
  .document-mode :global(.preview-pane) {
    width: 100%;
    flex: 1;
  }
  .panes.document-mode .editor-pane.input-proxy {
    position: fixed;
    width: 1px;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
    z-index: 5;
  }
  .input-proxy .pane-body {
    padding: 0;
    height: 100%;
  }

  :root {
    /* 原生控件（复选框 / 下拉框 / 滚动条）跟随主题；`.app.light` 里改回 light */
    color-scheme: dark;
    --bg: #1e1e1e;
    --bg-pane: #252526;
    --bg-backdrop: #1a1a1a;
    --bg-paper: #252526;
    --bg-toolbar: #2d2d30;
    --border: #3c3c3c;
    --fg: #d4d4d4;
    --fg-dim: #9d9d9d;
    --accent: #4fc1ff;

    /* 「弹出来的面板」配色（菜单下拉、右键菜单、弹窗（关于/设置/更新/未保存确认）、
       错误/警告浮层**共用这一组**）：**跟随主题**——这里给的是深色默认值，
       浅色值在下面的 `.app.light` 里恢复（2026-09-26 改：此前把这组钉成固定白色，
       深色主题下也是一块白板 + 整页预览一张白纸）。
       用法（四处都一样，别逐个改子元素的颜色）：在面板根元素上把主题变量就地重绑一遍 ——
       `.modal` / `.error-popover` / `.context-menu` 里的子元素本来就只用
       --fg / --fg-dim / --bg-pane / --border / --accent，重绑一次就整体换色、
       而且不用去数有几个标题几个按钮。面板都挂在 `.app` 子树里，所以 `.app.light`
       覆盖这几条即可整体切回浅色。**必须同时给定面板自己的 `color`**：
       继承下来的是 `.app` 上算好的字色，与面板底色不是一对时等于看不见。
       要调色只改 `:root` 与 `.app.light` 这两处；**两条必须成对**。 */
    --panel-bg: #252526;
    --panel-soft-bg: #303033; /* 面板上「凹下去」的东西：诊断条目 / 输入框 / 进度槽 */
    --panel-border: #3c3c3c;
    --panel-fg: #e6e6e6;
    --panel-fg-dim: #aeb0b5;
    --panel-accent: #4fc1ff;
    --panel-hover-bg: #2b3d4d; /* 悬停：深蓝底 + 亮蓝字 */
    --panel-hover-fg: #4fc1ff;
    --panel-hover-dim: #8fb6d0; /* 悬停时的快捷键/次要字，比 --panel-fg-dim 偏蓝 */
    /* 实心主按钮（底色 = --panel-accent）上的字：亮蓝底配白字对比度不够 */
    --panel-btn-fg: #10242f;
    /* 仅改变完整页面的屏幕显示，浅色主题恢复原始颜色。 */
    --night-svg-filter: invert(1) contrast(0.71);
    --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }

  .app.light {
    color-scheme: light;
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

    /* 「弹出来的面板」的浅色（深色默认值见上面的 `:root`）：白底 + 深色字 + 浅蓝悬停 */
    --panel-bg: #ffffff;
    --panel-soft-bg: #f0f0f0;
    --panel-border: #d9d9d9;
    --panel-fg: #1f1f1f;
    --panel-fg-dim: #6b6b6b;
    --panel-accent: #0b6bb5; /* 白底上的蓝用浅色主题那一支（深色的 #4fc1ff 在白底上太浅） */
    --panel-hover-bg: #e8f2f9; /* 悬停：浅蓝底 + 蓝字（白底上用「亮蓝底 + 白字」看不清） */
    --panel-hover-fg: #0b6bb5;
    --panel-hover-dim: #5a7f9c;
    --panel-btn-fg: #ffffff;
    --night-svg-filter: none;
    /* 白底面板的阴影要比深色面板浅（0.45~0.5 会让白块边缘发黑） */
    --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
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

  .panes {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  /* 两栏共用的骨架。**必须是 :global** —— 预览栏已经搬进 PreviewPane.svelte，
     页面 `<style>` 的作用域命中不了子组件里的元素（编辑栏那一半仍在页面里，一起用这两条）。 */
  :global(.pane) {
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

  :global(.pane-body) {
    flex: 1;
    min-height: 0;
    overflow: auto;
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
</style>
