<script lang="ts">
  import { onMount, tick } from "svelte";
  import Editor from "$lib/Editor.svelte";
  import { compileToSvg, compileToPdf, compileMath } from "$lib/typst-engine";
  import type { CompileErrorLocation, MathRender } from "$lib/typst-engine";
  import type { MathRequest } from "$lib/live-preview";
  import type { WriteCommand } from "$lib/write-commands";
  import {
    openTypFile,
    saveTypFile,
    readTypFile,
    pickTypPath,
    isTauri,
  } from "$lib/file-ops";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getVersion } from "@tauri-apps/api/app";
  import { getCurrentWindow } from "@tauri-apps/api/window";
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
    type LocatedErrorItem,
  } from "$lib/error-list";
  import { mark, reportStartup } from "$lib/startup-timing";
  import { dbg, setCliDebug } from "$lib/debug";
  import { clampPopoverRect } from "$lib/popover-utils";
  import { previewCanvasWidth, viewBoxWidthPt } from "$lib/preview-scale";

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
  // 启动时恢复上次未保存的内容（设置弹窗里的开关，默认开；关掉即回到"每次全新开始"）
  let restoreSession = $state(true);
  let settingsRestoreSession = $state(true);

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
        dirty,
        restoreSession,
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

  /** 写作模式 ↔ 源码模式（仿 Typora 的"源代码模式"）：预览栏随模式联动 */
  function toggleViewMode() {
    viewMode = viewMode === "write" ? "source" : "write";
    // 写作模式单栏（编辑区即排版结果）；源码模式双栏（源码 + 整页预览对照）
    showPreview = viewMode === "source";
    schedulePersist();
    statusText = viewMode === "write" ? "写作模式" : "源代码模式";
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
          { label: "主题：自动", checked: theme === "system", action: () => (theme = "system") },
          { label: "主题：暗", checked: theme === "dark", action: () => (theme = "dark") },
          { label: "主题：明", checked: theme === "light", action: () => (theme = "light") },
        ],
      },
      {
        label: "帮助",
        accessKey: "H",
        items: [{ label: "关于 Typst-pad", action: () => (showAbout = true) }],
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
      const result = await compileToPdf(source, filePath, fileTitle);
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
      let render = await compileMath(req.body, req.display, req.context, filePath);
      if (!render.ok && prefixOnly !== req.context) {
        const fallback = await compileMath(req.body, req.display, prefixOnly, filePath);
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

  function scheduleCompile() {
    runCompile(); // 立即编译：内容变化后直接编译，编译完即显示（无防抖延迟）
  }

  /** 打开设置弹窗：载入当前前缀配置副本，点“保存”才生效 */
  function openSettings() {
    settingsPrefixEnabled = prefixEnabled;
    settingsPrefixCode = prefixCode;
    settingsRestoreSession = restoreSession;
    showSettings = true;
  }

  /** 保存设置：应用前缀配置并持久化 */
  function saveSettings() {
    prefixEnabled = settingsPrefixEnabled;
    prefixCode = settingsPrefixCode;
    restoreSession = settingsRestoreSession;
    schedulePersist();
    showSettings = false;
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
   * 测量失败（无产物/容器不可测）时清空内联宽度，回退 CSS width: 100%。
   */
  function applyPreviewScale() {
    if (!previewBodyEl || !previewHost) return;
    const svg = previewHost.querySelector("svg");
    if (!svg) {
      previewHost.style.width = "";
      return;
    }
    const displayWidth = previewCanvasWidth({
      containerWidth: previewBodyEl.clientWidth,
      pageWidthPt: viewBoxWidthPt(svg.getAttribute("viewBox") ?? ""),
    });
    previewHost.style.width = Number.isNaN(displayWidth) ? "" : `${displayWidth}px`;
  }

  async function runCompile() {
    if (compileSeq === 0) mark("compile-request");
    const mySeq = ++compileSeq;
    const t0 = performance.now(); // 编译耗时（调试日志用）
    // 编译期间保留旧预览，完成后直接替换（不做 loading 遮罩）
    // 拼接编译源：前缀补尾随换行（非空且未以 \n 结尾时），避免前缀末行与用户文档首行合并成一行；
    // documentPath 传当前文档绝对路径（未保存为 null），Rust 侧以其所在目录解析 include
    const source = prefixEnabled ? ensureTrailingNewline(prefixCode) + doc : doc;
    const result = await compileToSvg(source, filePath);
    if (mySeq === 1) {
      // 首次编译完成 = 应用「可正常编辑/预览」就绪点，输出一次启动报告
      mark("first-compile-result");
      reportStartup();
    }
    if (mySeq !== compileSeq) return; // 已有更新的编译请求，丢弃本结果
    if (result.ok) {
      if (!previewHost) return; // 预览栏未挂载（理论上隐藏时仍在 DOM，这里兜底）
      previewHost.innerHTML = result.svg;
      applyPreviewScale(); // 新产物注入后按当前容器宽度重算画布缩放
      pageCount = result.pageCount;
      previewStatus = "ready";
      editorDiagnostics = [];
      errorCount = 0; // 编译成功：错误徽标归零（与状态栏文本同源）
      lastNonPosError = null; // 编译成功：无非定位错误
      charCount = doc.length;
      statusText = "就绪";
      // 调试日志：编译结果摘要（ok/页数/耗时），排查编译链路时对照 compile-diagnostics
      dbg.log("compile", `ok pages:${result.pageCount} t:${(performance.now() - t0).toFixed(1)}ms`);
    } else {
      // 编译错误：保留最后一次成功预览（不置 error、不隐藏预览、不显示错误面板），
      // 状态栏提示错误个数，编辑器内以红色波浪线标出错误位置（hover 可看详情）
      editorDiagnostics = result.errors;
      errorCount = result.errors.length; // 与状态栏文本「编译错误：N 处」同源
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

  function handleKeydown(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
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

    // 旧存档迁移：只有 livePreview 字段时，按其值推断模式
    viewMode = saved.viewMode ?? (saved.livePreview === false ? "source" : "write");
    // 旧存档没有 showPreview：单栏与否跟随模式（写作模式单栏，源码模式双栏对照）
    showPreview = saved.showPreview ?? viewMode === "source";
    restoreSession = saved.restoreSession ?? true;
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

    runCompile();
    resolveTheme();
    // 系统主题变化时跟随（仅当处于“自动”态）
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme === "system") resolveTheme();
    };
    media.addEventListener("change", onSystemThemeChange);
    window.addEventListener("keydown", handleKeydown);
    // 自定义右键菜单：编辑器/预览区替换原生菜单（菜单栏/状态栏拦截无效果，其余区域放行给浏览器原生）
    window.addEventListener("contextmenu", handleContextMenu);
    // 预览画布缩放：观测预览容器宽度变化（窗口 resize / 分栏布局变化），重算画布宽度；
    // observe 首次回调立即触发一次（覆盖挂载时已渲染的产物）
    previewResizeObserver = new ResizeObserver(() => applyPreviewScale());
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
    mark("mount-end");

    return () => {
      disposed = true;
      media.removeEventListener("change", onSystemThemeChange);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("contextmenu", handleContextMenu);
      previewResizeObserver?.disconnect();
      unlisteners.forEach((un) => un());
      clearTimeout(persistTimer);
      clearTimeout(mathTimer); // 停止在途公式渲染批次
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
    <span>{statusText}</span>
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
        <span class="error-icon">✕</span><span class="error-count">{errorCount}</span>
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
    <span class="spacer"></span>
    <span class="mode-tag">{viewMode === "write" ? "写作" : "源码"}</span>
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
        <div class="modal-actions">
          <button class="modal-btn primary" onclick={saveSettings}>保存</button>
          <button class="modal-btn" onclick={closeSettings}>关闭</button>
        </div>
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
    align-items: center;
    gap: 16px;
    padding: 4px 12px;
    background: var(--bg-toolbar);
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--fg-dim);
    user-select: none;
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

  .error-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 13px;
    height: 13px;
    border: 1.5px solid currentColor; /* CSS 圆环，不用 ⓧ 字形（跨字体渲染不一致） */
    border-radius: 50%;
    font-size: 9px;
    line-height: 1;
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

  .preview-body {
    display: flex;
    flex-direction: column;
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

  /* 编译错误 Popover：锚定徽标上方，圆角阴影风格与菜单下拉一致，不遮全屏 */
  .error-popover {
    position: absolute;
    right: 0;
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
</style>
