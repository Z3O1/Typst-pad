<script lang="ts">
  import { onMount, tick } from "svelte";
  import Editor from "$lib/editor/Editor.svelte";
  import {
    compileToSvg,
    compileBlocks,
    compileToPdf,
    compileMath,
    hitTestBlock,
    listFontFamilies,
    defaultFontFamilies,
  } from "$lib/core/typst-engine";
  import type {
    BlocksFail,
    BlocksOk,
    CompileErrorLocation,
    Diagnostic,
  } from "$lib/core/typst-engine";
  import {
    byteOffsetsToPositions,
    positionRangeToByteRange,
    utf8Length,
  } from "$lib/core/block-offsets";
  import { carryOverCrops, remapBlocksThroughEdit, toBlockTable } from "$lib/core/block-plan";
  import { clampHitOffset } from "$lib/core/block-hit";
  import type { Block } from "$lib/core/block-plan";
  import {
    buildFontFamilies,
    FONT_CHOICE_DEFAULT,
    normalizeFontDirs,
  } from "$lib/core/font-settings";
  import { createMathQueue } from "$lib/editor/math-queue";
  import type { WriteCommand } from "$lib/core/write-commands";
  import {
    openTypFile,
    saveTypFile,
    readTypFile,
    pickTypPath,
    pickFontDir,
    isTauri,
  } from "$lib/core/file-ops";
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
  import { isEffectiveDirty, ensureTrailingNewline } from "$lib/core/doc-utils";
  import {
    createDocumentSession,
    fileNameOf,
    loadedState,
    newState,
    savedState,
    UNTITLED_TITLE,
  } from "$lib/core/document-session";
  import type { DocumentState } from "$lib/core/document-session";
  import { failureStatus } from "$lib/core/failure-text";
  import { installEditorFonts, loadBundledFont } from "$lib/editor/editor-font";
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
  import {
    TYPST_DEFAULT_TEXT_PT,
    isReflowApplied,
    previewCanvasWidth,
    previewPageWidthPt,
    reflowCanvasWidth,
    viewBoxWidthPt,
  } from "$lib/core/preview-scale";
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

  /** 窗口 label 前缀：新窗口的 label 必须唯一（重名会创建失败），前缀要与 capabilities 里的 `editor-*` 一致 */
  const NEW_WINDOW_LABEL_PREFIX = "editor-";

  /** open-file 广播的兜底延迟：等有焦点的窗口先接（见 claimOpenFileOnBroadcast） */
  const OPEN_FILE_FALLBACK_DELAY_MS = 250;

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
    /** 写作模式正文列宽（CSS px）：块级渲染的版心宽据此换算（见 scheduleWritingReflow） */
    contentWidthPx(): number;
    /** 当前视口覆盖的文档范围（块级渲染窗口据此计算，见 compile_blocks 的窗口说明） */
    visibleRange(): { from: number; to: number } | null;
  }

  /** MenuBar 组件实例方法（右键菜单弹出前联动收起） */
  interface MenuBarHandle {
    closeMenus(): void;
  }

  let fileTitle = $state(UNTITLED_TITLE);
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
  /**
   * 预览栏组件句柄：画布（paper）与滚动容器（body）两个元素都在 PreviewPane.svelte 里，
   * 页面拿不到 bind:this ⇒ 组件用 export function 交出来（见那边文件头）。
   * 挂载前为 null；页面对这两个元素只做四件事：写 innerHTML、设内联宽度、找 <svg>、量 clientWidth。
   */
  let previewPaneRef = $state<{
    paper(): HTMLElement | undefined;
    body(): HTMLElement | undefined;
  } | null>(null);
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
  /** open-file 广播的兜底定时器（多窗口：没窗口有焦点时由主窗口延迟接，见 claimOpenFileOnBroadcast） */
  let pendingOpenTimer: ReturnType<typeof setTimeout> | null = null;
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
  let prefixEnabled = $state(false); // 编译/导出前是否自动插入前缀
  let prefixCode = $state(""); // 前缀代码（插入到用户代码之前）
  /**
   * 界面模式（两套 UI）：
   * - "write"  写作模式（仿 Typora，默认）：整页纸张、衬线正文、无行号，公式与标记就地排版；
   * - "source" 源码模式：等宽代码编辑器 + 行号，直接编辑 Typst 源码，右栏整页预览。
   * 视图菜单 / Ctrl+E 切换（`Ctrl+/` 归注释，见 MenuBar 那段的注解）。
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
  // 公式渲染的**队列与缓存**在 `$lib/editor/math-queue`（可单测：依赖全注入 + 假时钟）。
  // 这里只留一个**响应式代次**：队列每渲染成功一个公式就自增一次，编辑器据此重整装饰
  // （`Map` 本身不需要响应式，见那边的说明）。
  let mathVersion = $state(0);
  const mathQueue = createMathQueue({
    compile: (req, context) =>
      // 上下文字号都取自请求本身（必须与生成缓存键时用的一致，见 MathRequest 的说明）
      compileMath(req.body, req.display, context, filePath, req.sizePt, fontArgs()),
    fallbackContext: () => (prefixEnabled ? ensureTrailingNewline(prefixCode) : ""),
    // 队列只在**渲染成功**时回调（失败的结果也进缓存，但装饰集没变、自增代次是白跑）
    onRendered: () => {
      mathVersion++;
    },
    deferBlockCompile: deferPendingBlockCompile,
    log: (message) => dbg.log("live-preview", message),
  });
  // ---------------------------------------------------------------------------
  // 写作模式的块级渲染（阶段 1）：整篇编译一次 → 每个源块切一张真实排版切片
  // 见 docs/文档模式渲染保真-调研.md。后端没有 compile_blocks（浏览器开发桩 / 旧版本）
  // 时自动退回"只渲染公式 + 整页预览"的老路径（compile_blocks 返回 unavailable）。
  // ---------------------------------------------------------------------------
  /** 最近一次编译产出的块切片（null = 未启用 / 后端不支持 → 编辑器保持源码显示） */
  let writingBlocks = $state<Block[] | null>(null);
  /** 块切片代次（自增即通知编辑器重整块装饰） */
  let blocksVersion = $state(0);
  /**
   * 块表对应的**文档原文**（= 生成这批切片时编译的那一份）与"能否精确定位"标记。
   *
   * `writingBlocksExact` 为 false 时说明区间是**估算**的（最近一次编译失败了，见
   * applyBlocksResult 的失败分支：区间靠前后缀差分平移过来），这时不做点击精确定位 ——
   * Rust 侧几何缓存里的字节区间还是失败前那一版的，混着用会点错地方（宁可退回块首）。
   */
  let writingBlocksDoc = $state("");
  let writingBlocksExact = $state(false);
  /**
   * 生成当前块表的那次编译在 Rust 侧写下的**几何编号**（`BlocksOutput.geometryId`）。
   * 点切片时带回 `block_hit_test`：命中几何是**进程级**的，多窗口下会被另一个窗口的编译
   * 覆盖，编号对不上时后端拒绝命中、这里退回"光标落到块首"（PR #60 审查的第 4 条）。
   */
  let writingGeometryId = $state(0);
  /**
   * 写作模式正文列宽（pt）：块级渲染的**版心宽**，随编辑器列宽走。
   * 0 = 还没量到（编辑器未挂载）→ 编译时用默认值兜底，量到之后 scheduleWritingReflow 会重编一次。
   */
  let writingWidthPt = $state(0);
  /**
   * **文档正文实际字号**（pt，Rust 侧按字符数投票取众数）—— 写作模式"源码透镜"的字号基准：
   * 编辑器正文按它渲染（`Editor.svelte` 的 `--write-doc-px`），于是光标进出块时**字号不跳**
   * （用户：「不要光标在哪里哪里就变大了」）。后端没给（旧版本/桩/源码模式）时用 typst 默认 11pt。
   */
  let writingTextPt = $state(TYPST_DEFAULT_TEXT_PT);
  let writingReflowTimer: ReturnType<typeof setTimeout> | undefined;
  /** 量不到列宽时的兜底版心宽（495px = 371.25pt，写作模式常见列宽） */
  const DEFAULT_WRITING_WIDTH_PT = 371.25;
  /** "视口内出现没切片的块"的重编译定时器（去抖：滚动过程中会连着触发） */
  let blocksTimer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次**已经渲过**的窗口（`from:to` 或 `all`）：同一个窗口不重复编译，防抖成环 */
  let lastBlocksWindow = $state("");

  /**
   * **点切片里的链接**（阶段 3）：交给系统默认浏览器打开（opener 插件，与「关于 → 项目主页」
   * 同一条链路）。URL 是 typst 文档里写的，所以只开 http/https/mailto（Rust 侧已过滤过一次）。
   */
  function handleOpenLink(href: string): void {
    dbg.log("link", `打开切片里的链接：${href}`);
    void openUrl(href).catch((e) => {
      console.error("[link] 打开链接失败：", e);
      statusText = truncateStatus(`打开链接失败：${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * 视口内出现了"能渲染但还没有切片"的块 → 去抖 150ms 后按**新的视口窗口**重编译一次。
   *
   * 窗口化渲染的正常中间态：滚动到没渲过的区域，那几块先是源码，这一轮回来后变成切片。
   * 与公式渲染请求（math-queue 的 handleRequest）同一套思路，只是这里整篇编译一次即含所有可见块。
   */
  function handleBlocksNeeded() {
    if (viewMode !== "write") return;
    // 同一个窗口不重复编译：补渲后仍有块没拿到 svg（后端渲染不出来）时，
    // 不去抖反复重编译（否则就是每 150ms 一次的编译循环）
    const window = writingWindowBytes();
    const key = window === null ? "all" : `${window.from}:${window.to}`;
    if (key === lastBlocksWindow) return;
    clearTimeout(blocksTimer);
    blocksTimer = setTimeout(() => void runCompile(), 150);
  }

  /**
   * **点击定位**（阶段 2）：切片上点到的那一点 → 源码位置。
   *
   * 链路（见 block-hit.ts 的说明）：编辑器量出点击点的页面坐标（pt）→ 这里把块的
   * CodeMirror 位置换算成**文档字节偏移** → `block_hit_test` 在 Rust 侧的排版帧里找最近的
   * 字形 → 返回的字节偏移再换算回位置。
   *
   * 两道"别乱点"的闸门：
   *  ① 块表必须**与当前文档一致**（`writingBlocksDoc === doc`）：编译是异步的，刚敲完字
   *     就点下去时旧区间可能已经偏移了几十字节，硬按旧区间定位会落到别的段落里；
   *  ② 块表必须是**精确**的（见 writingBlocksExact）：编译失败后沿用旧切片时区间是估算的。
   * 任一不满足 → 返回 null，编辑器退回"光标落到块首"。
   */
  async function handleCropClick(req: {
    page: number;
    xPt: number;
    yPt: number;
    from: number;
    to: number;
  }): Promise<number | null> {
    if (!writingBlocksExact || writingBlocksDoc !== doc) return null;
    const range = positionRangeToByteRange(doc, req.from, req.to);
    if (range.to <= range.from) return null;
    const bounds = { fromByte: range.from, toByte: range.to };
    const hit = clampHitOffset(
      await hitTestBlock(
        bounds.fromByte,
        bounds.toByte,
        req.page,
        req.xPt,
        req.yPt,
        writingGeometryId,
      ),
      bounds,
    );
    if (hit === null) return null;
    const pos = byteOffsetsToPositions(doc, [hit])[0];
    if (!Number.isFinite(pos)) return null;
    dbg.log(
      "hit-test",
      `点击 (${req.xPt.toFixed(1)}, ${req.yPt.toFixed(1)})pt → 字节 ${hit} → 位置 ${pos}（块 ${req.from}..${req.to}）`,
    );
    return pos;
  }

  /**
   * 块级渲染窗口（**文档坐标的字节偏移**）：视口范围 → 字节 + 前后各留一段预取。
   * 取不到视口（编辑器未挂载）或文档很短（≤ 2×预取）时返回 null = 整篇都渲。
   */
  const BLOCK_WINDOW_MARGIN = 4000; // 字符
  function writingWindowBytes(): { from: number; to: number } | null {
    if (doc.length <= BLOCK_WINDOW_MARGIN * 2) return null; // 短文档：全渲，省一次换算
    // 编辑器还没挂载（首帧编译）→ 从文档开头起一段：光标在启动时本来就在开头，
    // 而"取不到视口就整篇渲"在长文档下会一次性渲出十几 MB（实测 58 字节/字符）。
    const visible = editorRef?.visibleRange() ?? { from: 0, to: 0 };
    const from = Math.max(0, visible.from - BLOCK_WINDOW_MARGIN);
    const to = Math.min(doc.length, visible.to + BLOCK_WINDOW_MARGIN);
    return positionRangeToByteRange(doc, from, to);
  }

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
  // 启动时恢复上次未保存的内容（设置弹窗里的开关，默认开；关掉即回到"每次全新开始"）
  let restoreSession = $state(true);
  let settingsRestoreSession = $state(true);

  // ---------------------------------------------------------------------------
  // 自动更新（tauri-plugin-updater；端点与签名公钥在 tauri.conf.json 的 plugins.updater）
  // ---------------------------------------------------------------------------
  /** 启动时自动检查更新（设置弹窗开关，默认开）。只影响自动检查，菜单里的手动检查始终可用 */
  let autoCheckUpdates = $state(true);
  let settingsAutoCheckUpdates = $state(true);

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
    editorRef?.runWriteCommand(command);
  }

  /**
   * 改缩放并反馈（滚轮 / 键盘 / 菜单共用）；值没变时提示"已到边界"，不重复写存档。
   * **这是唯一的档位写入口**：控制器只通过 requestLevel 表达"用户要这个值"，不自己写 uiZoom。
   */
  function setUiZoom(next: number) {
    const target = clampZoom(next);
    if (target === uiZoom) {
      statusText = `缩放已是 ${zoomLabel(target)}（到边界了）`;
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

  // 缩放变化（含启动恢复后的首次赋值）→ 交给 webview；失败不影响其它逻辑
  $effect(() => {
    void zoom.apply(uiZoom);
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
    // 两种模式的产物不通用（写作模式 = 每块切片，源码模式 = 整页 SVG），切换后立刻重编一次；
    // 写作模式还要按新的列宽重量版心宽（换布局了，列宽也会变）
    if (viewMode === "write") scheduleWritingReflow();
    else scheduleCompile();
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
    remapBlocksForEdit(newDoc);
    scheduleCompile();
    schedulePersist();
  }

  /**
   * **每次编辑都让块表跟上**（阶段 2 补的，修"在块内按 Enter 之后会出问题"）：
   *
   * 块表与切片是上一次编译的产物，位置是**旧文档的坐标**。此前只有在编译失败时才用前后缀差分
   * 平移一次，编辑期间则原样沿用（"偏一两个字符无害"）。但**插入换行会改变行结构**，
   * 而格子的边界是按"块的最后一行之后"算的 —— 旧坐标放在新文档上会算到错误的行，
   * 于是出现两类可见毛病：① 用户刚打的那一行落进**旁边那张旧切片**里（被图片盖住 = 字看不见，
   * 编译失败时更不会自愈）；② 同一段文字既出现在旧切片里、又有一部分露成源码（看起来像重复）。
   *
   * 做法与"编译失败保留切片"完全相同（`remapBlocksThroughEdit`：前后缀差分 → 没被碰到的块
   * 原样平移、被碰到的块退回源码），只是**每次编辑都跑**（O(n) 一次双指针比较，微秒级）。
   * 跑完自增 `blocksVersion` 让编辑器按新表重建装饰（不然这一帧渲染出来的还是旧表的格子）。
   *
   * 注意：平移**不**等于"精确"——几何（y/高度）与 Rust 侧的命中测试缓存都还是上一次编译的，
   * 所以点击精确定位的闸门（`writingBlocksExact`）在这里置回 false，等编译回来再打开。
   */
  function remapBlocksForEdit(newDoc: string) {
    if (!writingBlocks || writingBlocks.length === 0) return;
    if (writingBlocksDoc === newDoc) return;
    const remap = remapBlocksThroughEdit(writingBlocks, writingBlocksDoc, newDoc);
    writingBlocks = remap.blocks;
    writingBlocksDoc = newDoc;
    writingBlocksExact = false;
    blocksVersion++;
  }

  // ---------------------------------------------------------------------------
  // 文档生命周期（打开 / 保存 / 重新读取 / 新建）在 `$lib/core/document-session`
  // ---------------------------------------------------------------------------
  // 这里只注入页面状态与文件读写；四条契约（脏文档必问、写盘唯一入口、`applyLoaded` 只此一份、
  // 新建连会话存档一起清）的完整说明在那边。**读页面状态的 hook 全是箭头函数**，在调用时取值 ——
  // 别改成创建时快照（`filePath` / `dirty` / `doc` 每次都不同）；`isDesktop` / `readFile` /
  // `writeFile` / `pickFile` 直接引用 import 进来的纯函数，它们不读 `$state`。
  //
  // **唯一**把文档状态写回 `$state` 的地方：字段清单与"迁移后该长什么样"都在
  // `core/document-session.ts` 的三个纯函数里（`loadedState` / `savedState` / `newState`），
  // 这里只负责赋值。`editorDoc` 放**最后**落 —— 它是编辑器内容的实时镜像（见其声明处）。
  function applyDocState(next: DocumentState) {
    doc = next.doc;
    filePath = next.filePath;
    fileTitle = next.fileTitle;
    dirty = next.dirty;
    editorDoc = next.editorDoc;
  }

  const docSession = createDocumentSession({
    doc: () => doc,
    filePath: () => filePath,
    fileTitle: () => fileTitle,
    dirty: () => dirty,
    applyLoaded: (content, path) => applyDocState(loadedState(content, path)),
    applySaved: (path) => applyDocState(savedState(path, doc)),
    applyNew: () => applyDocState(newState()),
    afterLoad: () => {
      resetMathCache();
      resetBlocks();
      scheduleCompile();
      schedulePersist();
    },
    afterSave: () => schedulePersist(),
    afterNew: () => {
      resetMathCache();
      resetBlocks();
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
      editorWrap,
      uiZoom,
      theme,
      onNew: () => void docSession.createNew(),
      onNewWindow: openNewWindow,
      onOpen: () => void docSession.open(),
      onSave: () => void docSession.save(),
      onOpenSettings: openSettings,
      onExportPdf: handleExportPdf,
      runFormat,
      onToggleViewMode: toggleViewMode,
      onTogglePreview: () => (showPreview = !showPreview),
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
        previewStatus = "error";
        previewError = result.error;
      }
    } catch (e) {
      statusText = failureStatus("导出失败", e);
      previewStatus = "error";
      previewError = e instanceof Error ? e.message : String(e);
    }
  }

  /** 挂着的块编译被公式推到这个时刻（比公式自身的 120ms 去抖稍晚一点） */
  const MATH_COMPILE_HEADSTART_MS = 240;

  /**
   * 有公式要渲时**把挂着的块编译往后推**：两者共用 Rust 侧同一把编译锁，公式是小活
   * （几毫秒）、整篇块编译是几十~几百毫秒，不让路就会出现"打完公式半天不显示"
   * （实测慢编译桩下版面对齐要等 338ms）。判据用 `writeCompileTimer === undefined`
   * 表示"没有挂着的编译"（见 `scheduleCompile` 里"跑完必须置回 undefined"的说明）。
   */
  function deferPendingBlockCompile() {
    if (viewMode !== "write" || writeCompileTimer === undefined) return;
    clearTimeout(writeCompileTimer);
    writeCompileTimer = setTimeout(() => {
      writeCompileTimer = undefined;
      void runCompile();
    }, MATH_COMPILE_HEADSTART_MS);
  }

  /** 文档切换（打开/新建/重读）：公式缓存作废（include 根与上下文都可能变），并让装饰重建一次 */
  function resetMathCache() {
    mathQueue.reset();
    mathVersion++;
  }

  /**
   * 文档切换时**块切片必须立刻清空**：块区间是上一个文档的坐标，套在新文档上会盖住正文
   * （比公式缓存的危害大得多 —— 那是"渲染错内容"，这是"看不到内容"）。
   * 新文档的编译结果（数十毫秒后）会填回来。
   */
  function resetBlocks() {
    clearTimeout(blocksTimer);
    writingBlocks = null;
    writingBlocksDoc = "";
    writingBlocksExact = false;
    writingGeometryId = 0; // 没有块表就没有对应的几何，别拿旧编号去问后端
    blocksVersion++;
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

  /**
   * 警告列表条目（组装在 status-view.ts，有单测）：有源码位置的可点击跳转（消息已翻成中文
   * 可行动提示），否则纯展示。
   */
  function warningItems(): ErrorListItem[] {
    return buildWarningItems(compileWarnings);
  }

  /** 写作模式"打字期间不编译"的去抖时长（见 scheduleCompile） */
  const WRITE_COMPILE_DEBOUNCE_MS = 150;
  /**
   * 挂着的写作模式编译定时器（去抖）。
   * **跑完要置回 undefined**：它同时被当成"有没有挂着的编译"的判据（见 math-queue 的 deferBlockCompile：
   * 有挂着的块编译才把公式优先级提前）。不置回的话，每一个公式请求都会在 240ms 后再排一次
   * 整篇编译 —— 公式多的文档接近双倍编译量（PR #60 审查的第 8 条）。
   */
  let writeCompileTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * 内容变化后的编译调度。**两种模式走两条路**（用户反馈「输入手感很差（公式）」后改的）：
   *
   * - **源代码模式**：立即编译（原有行为）。右侧预览是另一块区域，晚一点没关系但要跟手。
   * - **写作模式**：**去抖 150ms**。写作模式下的编译是"整篇编译一次 + 窗口内每个块渲一张切片"，
   *   实测一次几十到几百毫秒（debug 构建更久），而且**每敲一个字都触发一次**：实测打 12 个字符
   *   → 12 次 `compile_blocks`（外加公式那边 12 次 `compile_math`），三个编译命令共用一把互斥锁
   *   → 打字时队列一直是满的，最直接的后果是"公式半天不出来"（公式渲染排在整篇编译后面）。
   *   打字期间**不需要**编译：正在编辑的那一块本来就是源码形态，其它块的切片内容也没变。
   */

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
    if (viewMode === "write") {
      clearTimeout(writeCompileTimer);
      // **跑完必须置回 undefined**（`let` 声明处有说明）：这个变量同时是"有没有挂着的编译"
      // 的判据 —— math-queue 的 deferBlockCompile 只在有挂着的编译时才把块编译往后推。
      writeCompileTimer = setTimeout(() => {
        writeCompileTimer = undefined;
        void runCompile();
      }, WRITE_COMPILE_DEBOUNCE_MS);
      return;
    }
    runCompile();
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
    const body = previewPaneRef?.body();
    const paper = previewPaneRef?.paper();
    if (!body || !paper) return;
    const svg = paper.querySelector("svg");
    if (!svg) {
      paper.style.width = "";
      return;
    }
    const containerWidth = body.clientWidth;
    const actualPageWidthPt = viewBoxWidthPt(svg.getAttribute("viewBox") ?? "");
    // 重排生效（产物页宽 = 我们请求的页宽）：画布恒 ≤ 栏宽 —— 这是"预览永不横向滚动"的保证。
    // 请求被文档自己的 #set page 覆盖时落到下面的等比缩放路径（那也是用户自己的纸型）。
    if (previewPageWidthUsed > 0 && isReflowApplied(actualPageWidthPt, previewPageWidthUsed)) {
      const reflowWidth = reflowCanvasWidth(containerWidth, actualPageWidthPt);
      paper.style.width = Number.isNaN(reflowWidth) ? "" : `${reflowWidth}px`;
      return;
    }
    const displayWidth = previewCanvasWidth({
      containerWidth,
      pageWidthPt: actualPageWidthPt,
      uiZoom,
    });
    paper.style.width = Number.isNaN(displayWidth) ? "" : `${displayWidth}px`;
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
      const body = previewPaneRef?.body();
      const width = body ? previewPageWidthPt(body.clientWidth) : NaN;
      const next = Number.isNaN(width) ? 0 : width;
      const changed =
        next === 0 ? previewPageWidthUsed > 0 : Math.abs(next - previewPageWidthRequest) > 2;
      if (!changed) return;
      previewPageWidthRequest = next;
      dbg.log("preview-reflow", `页宽 ${next === 0 ? "关闭（不重排）" : `${next.toFixed(1)}pt`}`);
      void runCompile();
    }, 250);
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
    const t0 = performance.now(); // 编译耗时（调试日志用）
    // 编译期间保留旧预览，完成后直接替换（不做 loading 遮罩）
    // 拼接编译源：前缀补尾随换行（非空且未以 \n 结尾时），避免前缀末行与用户文档首行合并成一行；
    // documentPath 传当前文档绝对路径（未保存为 null），Rust 侧以其所在目录解析 include
    const source = prefixEnabled ? ensureTrailingNewline(prefixCode) + doc : doc;
    // 首次编译可能早于 ResizeObserver 的第一次回调：这里补算一次页宽，避免启动时多编译一遍
    const previewBody = previewPaneRef?.body();
    if (previewPageWidthRequest === 0 && previewBody) {
      const initialWidth = previewPageWidthPt(previewBody.clientWidth);
      if (!Number.isNaN(initialWidth)) previewPageWidthRequest = initialWidth;
    }
    // 预览重排的页宽是**编译期输入**（Rust 侧据此注入 #set page），所以随本次编译一起发出；
    // 请求值只在结果落地时记进 previewPageWidthUsed（与产物一一对应，见 applyPreviewScale）
    const requestedPreviewWidthPt = previewPageWidthRequest;

    // 写作模式：走块级编译（每个源块一张真实排版切片），不渲染整页预览 —— 整页 SVG 在写作
    // 模式下是看不见的（预览栏隐藏），省下的是同一量级的工作，换来的是"编辑区里就是真排版"。
    if (viewMode === "write") {
      const window = writingWindowBytes();
      // 记下这一轮渲的窗口：视口内仍有"没拿到切片"的块时，同一个窗口不重复编译（见 handleBlocksNeeded）
      lastBlocksWindow = window === null ? "all" : `${window.from}:${window.to}`;
      // **编译请求发出时的文档**：块区间是**字节偏移**，只有配上同一份文档才有意义。
      // 写作模式的编译是去抖的（150ms），所以"文档已经改了、但新一轮编译还没开始"是常态 ——
      // 这期间回来的旧结果若直接套到当前文档上，格子就会错位：旧切片盖住被移动的正文
      // （表现为整行凭空消失 / 同一段既在切片里又露成源码），而 `compileSeq` 只在**新编译
      // 开始**时才自增，拦不住这一段（PR #60 审查抓到；`remapBlocksForEdit` 此时无用，
      // 因为它比较的是同一份新文档，前后缀差分看不出差别）。
      const requestDoc = doc;
      const blocksResult = await compileBlocks(
        source,
        utf8Length(prefixEnabled ? ensureTrailingNewline(prefixCode) : ""),
        filePath,
        writingWidthPt > 0 ? writingWidthPt : DEFAULT_WRITING_WIDTH_PT,
        fontArgs(),
        window,
      );
      if (mySeq === 1) {
        // 首次编译完成 = 应用「可正常编辑/预览」就绪点（与整页预览路径同一打点）
        mark("first-compile-result");
        reportStartup();
      }
      if (mySeq !== compileSeq) return; // 已有更新的编译请求，丢弃本结果
      if (requestDoc !== doc) {
        // 文档在这次编译期间变过 → 这份结果的坐标属于旧文档，**丢掉**。
        // 编辑那条路已经排了一次去抖编译（handleDocChange → scheduleCompile），
        // 它会带着新坐标回来；这期间块表保持 remapBlocksThroughEdit 之后的样子
        // （改动过的块退回源码），是设计中的中间态。
        dbg.log("compile", "块级渲染结果已过期（编译期间文档变了），丢弃");
        return;
      }
      if (!blocksResult.unavailable) {
        applyBlocksResult(blocksResult, t0);
        // 预览栏被手动打开时（视图菜单可以单独开），整页预览也要跟上：接着走下面的
        // compile_doc 路径把预览填上。只在写作模式额外付一次编译 —— 那是用户显式要的。
        if (!showPreview) return;
      }
      // 后端没有这个命令（浏览器开发桩 / 旧版本）→ 落到下面的整页预览路径，
      // 行为与加这个功能之前完全一致（块切片保持 null，编辑器只做公式内联渲染）。
      dbg.log("compile", "compile_blocks 不可用，退回整页预览路径");
    }

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
      // 预览栏未挂载（组件句柄没接上、或槽里的元素还没落地）就兜底返回 ——
      // 拆分前判的是 `previewHost` 元素本身，这里同样判元素、不用非空断言
      const paper = previewPaneRef?.paper();
      if (!paper) return;
      paper.innerHTML = result.svg;
      previewPageWidthUsed = requestedPreviewWidthPt; // 本次产物的请求页宽（0 = 没请求重排）
      applyPreviewScale(); // 新产物注入后按当前容器宽度重算画布宽度
      applyCompileStatus(result, doc.length);
      // 调试日志：编译结果摘要（ok/页数/耗时），排查编译链路时对照 compile-diagnostics
      dbg.log("compile", `ok pages:${result.pageCount} t:${(performance.now() - t0).toFixed(1)}ms`);
    } else {
      // 编译错误：保留最后一次成功预览（不置 error、不隐藏预览、不显示错误面板），
      // 状态栏提示错误个数，编辑器内以红色波浪线标出错误位置（hover 可看详情）
      applyCompileStatus(result, doc.length);
      // 调试日志：编译失败摘要（错误数/耗时），错误详情见 compile-diagnostics
      dbg.log(
        "compile",
        `fail errors:${result.errors.length} t:${(performance.now() - t0).toFixed(1)}ms`,
      );
    }
  }

  /**
   * 写作模式块级编译的结果落地：成功 → 换上新切片；失败 → **块切片作废**（旧表的区间
   * 已经对不上新文档），编辑器退回源码 + 波浪线，状态栏照旧显示错误数。
   *
   * 与整页预览路径的差别只有一处：整页预览在编译失败时**保留上一次成功产物**，而块切片
   * 必须立刻撤掉 —— 位置对不上的 widget 会盖住错的正文。
   */
  function applyBlocksResult(result: BlocksOk | BlocksFail, t0: number) {
    if (result.ok) {
      // 字节偏移 → CodeMirror 位置（只在这里做一次，编辑器侧直接用位置）
      const table = toBlockTable(doc, result.blocks);
      // 窗口化渲染：窗口外的块这轮没有 SVG，按"块类型 + 源码文本相同"沿用上一轮结果
      const carried = carryOverCrops(writingBlocks, table.blocks, doc);
      writingBlocks = carried.blocks;
      // 这一批切片与这份文档、这份几何（Rust 侧 HIT_CACHE 也是同一次编译）严格对应
      writingBlocksDoc = doc;
      writingBlocksExact = true;
      writingGeometryId = result.geometryId;
      blocksVersion++;
      // 文档正文实际字号（源码透镜的字号基准，见 writingTextPt 的说明）
      if (result.textPt > 0 && Math.abs(result.textPt - writingTextPt) > 0.01) {
        writingTextPt = result.textPt;
      }
      if (carried.carried > 0 || carried.missing > 0) {
        dbg.log(
          "compile",
          `切片窗口：新渲 ${result.blocks.filter((b) => b.svg).length} / 沿用 ${carried.carried} / 待渲 ${carried.missing}`,
        );
      }
      applyCompileStatus(result, doc.length);
      dbg.log(
        "compile",
        `blocks ok blocks:${result.blocks.length} 页宽:${result.pageWidthPt.toFixed(1)}pt t:${(
          performance.now() - t0
        ).toFixed(1)}ms`,
      );
      return;
    }
    // 失败：**不整篇作废**，只把"被改动到的那一块"退回源码（阶段 2）。
    // 旧表是上一次成功编译的产物（区间 + 切片成套），而块切片一旦丢掉，写作模式会整篇退回
    // 源码 —— 敲错一个字符就看到整篇源码闪一下，改好才回来。用前后缀差分把没被碰到的块
    // 原样留下/整体平移（见 block-plan.remapBlocksThroughEdit，含两条"别盖住正文"的约束）。
    const remap = writingBlocks
      ? remapBlocksThroughEdit(writingBlocks, writingBlocksDoc, doc)
      : { blocks: [] as Block[], kept: 0 };
    // 区间是**估算**的（平移过的），点击精确定位据此退出（见 writingBlocksExact 的说明）
    writingBlocks = remap.blocks.length > 0 ? remap.blocks : null;
    writingBlocksDoc = doc;
    writingBlocksExact = false;
    blocksVersion++;
    applyCompileStatus(result, doc.length);
    dbg.log(
      "compile",
      `blocks fail errors:${result.errors.length} 保留切片:${remap.kept}/${remap.blocks.length} t:${(
        performance.now() - t0
      ).toFixed(1)}ms`,
    );
  }

  /**
   * 写作模式正文列宽（pt）的测量 + **重编译**（去抖 250ms）。
   *
   * 版心宽是**编译期输入**（Rust 侧按列宽注入 `#set page(width: …)`），所以窗口尺寸、
   * 界面缩放、模式切换引起的列宽变化都要重排一次 —— 与源码模式预览的
   * schedulePreviewReflow 同一套思路。阈值 1.5pt：避免像素级抖动引起的无意义重编译。
   * （滚动条槽位在写作模式下常驻，见 Editor.svelte 的 scrollbar-gutter，所以不会出现
   * "重编译 → 高度变 → 滚动条变 → 列宽再变"的反馈环。）
   */
  function scheduleWritingReflow() {
    clearTimeout(writingReflowTimer);
    writingReflowTimer = setTimeout(() => {
      const px = editorRef?.contentWidthPx() ?? 0;
      if (!(px > 0)) return;
      const next = px * 0.75; // CSS px → pt（1pt = 4/3 px）
      if (Math.abs(next - writingWidthPt) <= 1.5) return;
      writingWidthPt = next;
      dbg.log("writing-reflow", `版心宽 ${next.toFixed(1)}pt（列宽 ${px}px）`);
      void runCompile();
    }, 250);
  }

  /** 窗口标题同步为“文件名 - Typst-pad”；未保存修改时文件名后加圆点（Tauri） */
  function syncWindowTitle() {
    if (!isTauri()) return;
    getCurrentWindow().setTitle(
      `${fileTitle}${isEffectiveDirty(dirty, doc) ? " ●" : ""} - Typst-pad`,
    );
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
      openSettings(); // 载入当前前缀副本到 settingsPrefixCode，点“保存”才生效
      // 下一 tick：等设置弹窗渲染出前缀 textarea，再让组件自己定位（偏移按草稿前缀算）
      void tick().then(() => settingsDialogRef?.focusPrefixLine(item.line));
    } else {
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
   * 新建窗口（`Ctrl+Shift+N` / 菜单「文件 → 新建窗口」）。新窗口是**空白草稿窗口**：
   * 起来不恢复上次内容、写存档只写设置（见 isSecondaryWindow 的说明）。
   *
   * label 用时间戳保证唯一（Tauri 要求 label 唯一，重名会创建失败），前缀 `editor-` 必须与
   * capabilities/default.json 的 `windows: ["main", "editor-*"]` 对得上 —— 否则新窗口里的
   * 文件读写会在 ACL 层被拒（0.2.x 踩过，见提交 b187118）。
   *
   * **另外还得有 create 的权限**：`new WebviewWindow()` 走的是 `plugin:webview|create_webview_window`，
   * 需要在 capabilities/default.json 里显式写 `core:webview:allow-create-webview-window` ——
   * `core:webview:default`（我们引的 `core:default` 里含它）**没有**这一条，缺了就在**运行时**被拒：
   * 状态栏原文「新建窗口失败：Command plugin:webview|create_webview_window not allowed by ACL」
   * （0.7.9 就是这样发出去的）。这类 ACL 拒绝浏览器验收碰不到，所以另加了
   * `scripts/capabilities.test.mjs` 做静态体检：改这里的 Tauri 调用后，去那张表里补一行。
   */
  function openNewWindow() {
    if (!isTauri()) return; // 浏览器预览没有多窗口（应用本身也只在桌面版渲染）
    try {
      const win = new WebviewWindow(`${NEW_WINDOW_LABEL_PREFIX}${Date.now()}`, {
        url: "/",
        title: "未命名.typ - Typst-pad",
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        center: true,
      });
      // 创建失败（label 撞车 / 系统拒绝）在发布版里是看不见的（没有 devtools），报到状态栏
      void win.once("tauri://error", (e) => {
        const detail = (e as { payload?: unknown }).payload;
        statusText = `新建窗口失败：${typeof detail === "string" ? detail : String(detail ?? "")}`;
        dbg.log("window", "new-window error", detail);
      });
    } catch (e) {
      statusText = `新建窗口失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** 关闭当前窗口（Ctrl+W）：与标题栏关闭走同一条路（未保存修改会先弹确认，见 onCloseRequested） */
  function closeCurrentWindow() {
    if (!isTauri()) return;
    void getCurrentWindow().close();
  }

  /** 当前窗口是否有焦点（多窗口下决定 open-file 广播由谁接）；查询失败按"没有焦点"处理 */
  async function currentIsFocused(): Promise<boolean> {
    try {
      return (await getCurrentWindow().isFocused()) === true;
    } catch {
      return false;
    }
  }

  /**
   * 取走待打开队列里的最后一个路径（并清空队列）。多窗口下它同时是**"这个文件已被某窗口接走"
   * 的记号**：都从 Rust 侧这份队列里取，取到空 = 别人先接了（见 claimOpenFileOnBroadcast）。
   */
  async function claimPendingFile(): Promise<string | null> {
    try {
      const paths = await invoke<string[]>("take_pending_files");
      return paths.length > 0 ? paths[paths.length - 1] : null;
    } catch {
      return null;
    }
  }

  /**
   * `open-file` 广播的接球人（关联双击 / 跨实例转发打开）。
   * Rust 侧是 `app.emit`，**所有窗口都会收到**，必须挑一个窗口接，否则两个窗口会同时切到同一个
   * 文件、各自未保存的内容都可能被顶掉。规则：**有焦点的窗口接**（用户看得见文件开在哪）；
   * 一个窗口都没焦点时（应用在后台/最小化）由主窗口延迟一拍兜底，兜底前先看队列——队列空说明
   * 已经有窗口接走了，就放手（主窗口自己的会话不会被别人的双击顶掉）。
   */
  async function claimOpenFileOnBroadcast(path: string) {
    if (await currentIsFocused()) {
      void claimPendingFile(); // 清掉队列 = 告诉主窗口"已经有人接了"
      await docSession.openPath(path);
      return;
    }
    if (isSecondaryWindow) return; // 副窗口没焦点就不抢：交给主窗口兜底
    if (pendingOpenTimer !== null) clearTimeout(pendingOpenTimer);
    pendingOpenTimer = setTimeout(() => {
      pendingOpenTimer = null;
      void claimPendingFile().then((unclaimed) => {
        if (unclaimed) void docSession.openPath(unclaimed);
      });
    }, OPEN_FILE_FALLBACK_DELAY_MS);
  }

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
        openNewWindow,
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
    lastUpdateCheckAt =
      typeof saved.lastUpdateCheckAt === "number" ? saved.lastUpdateCheckAt : null;
    // "点过稍后 = 别再自动弹窗"（旧存档没有这个字段 → null = 照常弹窗）
    updateDismissedAt =
      typeof saved.updateDismissedAt === "number" ? saved.updateDismissedAt : null;
    // 界面缩放：旧存档没有该字段 → 100%；越界/脏数据由 clampZoom 收敛（随后由 $effect 应用）
    uiZoom = clampZoom(saved.uiZoom);
    // **副窗口（Ctrl+Shift+N 新建的窗口）一律不恢复**：它是空白草稿窗口，恢复出主窗口的文档
    // 会让人以为"新窗口把我正在写的文章带过来了"，而那个窗口的内容改动又不会记进存档。
    if (
      !isSecondaryWindow &&
      restoreSession &&
      typeof saved.content === "string" &&
      saved.content.trim() !== ""
    ) {
      doc = saved.content;
      editorDoc = saved.content; // 镜像同步，见 editorDoc 声明处
      if (saved.filePath) {
        filePath = saved.filePath;
        fileTitle = saved.fileTitle ?? fileNameOf(saved.filePath);
      }
      // 未保存标记原样恢复：存过盘又没再改的文档恢复出来不该带"未保存"圆点
      dirty = saved.dirty ?? false;
      statusText = "已恢复上次内容";
    }
    mark("persist-restore");

    // 关于弹窗版本号：从 Tauri 运行时读取（getVersion 返回 tauri.conf.json 的
    // version，如 0.4.0）；失败静默忽略，弹窗显示占位符
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
    // 内置默认字体族（拼"选中项 + 其余兜底"用）：静态列表，取一次即可
    void defaultFontFamilies().then((v) => {
      if (v.length > 0) defaultFonts = v;
    });
    /**
     * **写作模式的源码透镜装上打包字体**（Libertinus Serif + 思源宋体子集，见 editor-font.ts）：
     * 字号（--write-doc-px）与行高早就跟着文档走了，字体是最后一条腿 —— 装上之后源码形态与
     * 引擎切片才是同一套排版（字宽、断行都对得上）。字体本来就随应用分发，这一步不增加体积；
     * 装不上（老后端没这个命令 / 文件缺失）就什么都不做，字体栈自己退回系统族。
     */
    void installEditorFonts({ load: loadBundledFont })
      .then((families) => {
        if (families.length > 0) dbg.log("font", `写作模式已装上打包字体：${families.join(" / ")}`);
      })
      .catch((e) => dbg.log("font", "打包字体没装上（保持系统字体栈）：", e));

    const firstCompile = runCompile();
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
      // 写作模式的版心宽跟着编辑器列宽走：窗口/分栏变化后复核一次（去抖在函数里）
      scheduleWritingReflow();
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
        // 栏宽变了（窗口缩放 / Ctrl+滚轮 / 切换模式）：重排的页宽是编译期输入，
        // 所以除了重算画布宽度，还要按新栏宽去抖重编译一次（见 schedulePreviewReflow）
        schedulePreviewReflow();
      });
    });
    const previewBody = previewPaneRef?.body();
    if (previewBody) previewResizeObserver.observe(previewBody); // 组件在 onMount 前已挂载
    // 写作模式的版心宽要等编辑器挂载后才能量到：量到就重排一次（首帧编译用的是兜底值）
    scheduleWritingReflow();

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
              void docSession.openPath(path);
            } else if (event.payload.paths.length > 0) {
              statusText = "仅支持打开 .typ 文件";
            }
          } else {
            dragActive = false;
          }
        }),
      );
      // 应用已运行时再次打开文件（single-instance 转发）：先注册监听再取队列，
      // 避免转发事件落在两者之间而丢失。**多窗口下这条是广播**，要挑一个窗口接，见
      // claimOpenFileOnBroadcast（有焦点的窗口接，都没焦点时主窗口延迟兜底）。
      const unlistenOpen = listen<string>("open-file", (e) => {
        if (e.payload) void claimOpenFileOnBroadcast(e.payload);
      });
      keepUnlisten(unlistenOpen);
      unlistenOpen.then(() => {
        // 首次启动/跨实例转发的待打开文件（关联双击）：就绪后取走（取最后一个，即最新请求）。
        // **只由主窗口取**：副窗口是草稿窗口，不该被启动参数里带的文件顶掉内容。
        if (isSecondaryWindow) return;
        void claimPendingFile().then((path) => {
          if (path) void docSession.openPath(path);
        });
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
      if (pendingOpenTimer !== null) clearTimeout(pendingOpenTimer); // 关窗时取消还没落地的兜底打开
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      previewResizeObserver?.disconnect();
      if (previewScaleFrame !== 0) cancelAnimationFrame(previewScaleFrame);
      unlisteners.forEach((un) => un());
      clearTimeout(persistTimer);
      mathQueue.reset(); // 作废公式队列：清缓存 + 取消定时器 + 丢掉已发出请求的结果
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
            lookupMath={mathQueue.lookup}
            onMathRequest={mathQueue.handleRequest}
            {mathVersion}
            blocks={writingBlocks}
            {blocksVersion}
            docTextPt={writingTextPt}
            onBlocksNeeded={handleBlocksNeeded}
            onCropClick={handleCropClick}
            onOpenLink={handleOpenLink}
          />
        </div>
      </section>
      <PreviewPane
        bind:this={previewPaneRef}
        hidden={!showPreview}
        status={previewStatus}
        error={previewError}
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
        bind:restoreSession={settingsRestoreSession}
        bind:autoCheckUpdates={settingsAutoCheckUpdates}
        bind:prefixEnabled={settingsPrefixEnabled}
        bind:prefixCode={settingsPrefixCode}
        bind:chineseFont={settingsChineseFont}
        bind:fontDirs={settingsFontDirs}
        {availableFonts}
        {fontsLoading}
        onAddFontDir={addFontDir}
        onRemoveFontDir={removeFontDir}
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

    /* 「弹出来的面板」的固定浅色（2026-09-18 用户要求：先「把上方菜单栏的展开菜单改成白色」，
       再「所有弹出来的窗口、错误/警告浮层改成白色（每一个条目改成灰色）」）——
       菜单下拉、右键菜单、弹窗（关于/设置/更新/未保存确认）、错误/警告浮层**共用这一组**，
       **深色主题下也是白底黑字**，所以这几条**不跟上面那组主题变量走**。
       用法（三处都一样，别逐个改子元素的颜色）：在面板根元素上把主题变量就地重绑一遍 ——
       `.modal` / `.error-popover` / `.context-menu` 里的子元素本来就只用
       --fg / --fg-dim / --bg-pane / --border / --accent，重绑一次就整体变浅色、
       而且不用去数有几个标题几个按钮。**必须同时给定面板自己的 `color`**：
       继承下来的是 `.app` 上算好的 #d4d4d4（深色主题的浅灰），白底上等于看不见。
       要调色只改这几行；**别把某一条改回主题变量**（白底 + 浅灰字 = 看不见）。 */
    --panel-bg: #ffffff;
    --panel-soft-bg: #f0f0f0; /* 影子面板上的「凹下去」的东西：诊断条目 / 输入框 / 进度槽 */
    --panel-border: #d9d9d9;
    --panel-fg: #1f1f1f;
    --panel-fg-dim: #6b6b6b;
    --panel-accent: #0b6bb5; /* 白底上的蓝用浅色主题那一支（深色的 #4fc1ff 在白底上太浅） */
    --panel-hover-bg: #e8f2f9; /* 悬停：浅蓝底 + 蓝字（白底上用「亮蓝底 + 白字」看不清） */
    --panel-hover-fg: #0b6bb5;
    /* 白底面板的阴影要比深色面板时代浅（原来 0.45~0.5 会让白块边缘发黑） */
    --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
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

  /* 单栏（写作模式）：编辑区不再与预览栏分界；纸张限宽居中由上面的 .pane-body 负责 */
  .panes.single .editor-pane {
    border-right: none;
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
