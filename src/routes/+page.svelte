<script lang="ts">
  import { onMount } from "svelte";
  import Editor from "$lib/Editor.svelte";
  import { compileToSvg, compileToPdf } from "$lib/typst-engine";
  import {
    openTypFile,
    saveTypFile,
    readTypFile,
    pickTypPath,
    isTauri,
  } from "$lib/file-ops";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import { loadState, saveState } from "$lib/persistence";
  import MenuBar from "$lib/MenuBar.svelte";
  import type { MenuGroup } from "$lib/MenuBar.svelte";
  import { clearState } from "$lib/persistence";

  // 新建时默认空白文档（不再预填示例内容）
  const SAMPLE_DOC = "";

  let fileTitle = $state("未命名.typ");
  let dirty = $state(false);
  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let statusText = $state("就绪");
  let theme: "system" | "dark" | "light" = $state("system");
  let resolvedTheme: "dark" | "light" = $state("dark");

  let doc: string = SAMPLE_DOC;
  let editorDoc = $state(SAMPLE_DOC); // 绑定给 Editor 的受控文档
  let filePath: string | null = null;
  let previewStatus: "idle" | "ready" | "error" = $state("idle");
  let previewError = $state("");
  let pageCount = $state(0);
  let previewHost: HTMLElement;
  let compileSeq = 0; // 代次令牌：丢弃过期编译结果
  let dragActive = $state(false); // 拖放悬停中：显示覆盖层提示
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  let showAbout = $state(false);

  /** 轻量防抖：内容/主题/路径变化后 300ms 写入 localStorage */
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      saveState({ theme, content: doc, filePath, fileTitle });
    }, 300);
  }

  function handleCursor(line: number, col: number) {
    cursorLine = line;
    cursorCol = col;
  }

  function handleDocChange(newDoc: string) {
    doc = newDoc;
    dirty = true;
    scheduleCompile();
    schedulePersist();
  }

  /** 有未保存修改时请求确认（打开/拖放/关联打开前） */
  async function confirmDiscard(): Promise<boolean> {
    const message = "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？";
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
    if (dirty && filePath !== path) {
      const ok = await confirmDiscard();
      if (!ok) return false;
    }
    try {
      const opened = await readTypFile(path);
      doc = opened.content;
      filePath = opened.path;
      fileTitle = opened.path.split(/[\\/]/).pop() ?? opened.path;
      dirty = false;
      editorDoc = opened.content; // 触发编辑器替换全文
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

  async function handleSave() {
    try {
      const saved = await saveTypFile(filePath, doc);
      if (!saved) return;
      filePath = saved;
      fileTitle = saved.split(/[\\/]/).pop() ?? saved;
      dirty = false;
      schedulePersist();
      statusText = "已保存";
    } catch (e) {
      statusText = "保存失败";
    }
  }

  /** 新建：清空文档并清除持久化的上次内容 */
  function handleNew() {
    doc = "";
    editorDoc = "";
    filePath = null;
    fileTitle = "未命名.typ";
    dirty = false;
    clearState();
    scheduleCompile();
    statusText = "已新建";
  }

  function menuGroups(): MenuGroup[] {
    return [
      {
        label: "文件",
        items: [
          { label: "新建", action: handleNew },
          { label: "打开…", action: handleOpen },
          { label: "保存", action: handleSave },
          { label: "导出 PDF…", action: handleExportPdf },
        ],
      },
      {
        label: "视图",
        items: [
          { label: "主题：自动", checked: theme === "system", action: () => (theme = "system") },
          { label: "主题：暗", checked: theme === "dark", action: () => (theme = "dark") },
          { label: "主题：明", checked: theme === "light", action: () => (theme = "light") },
        ],
      },
      {
        label: "帮助",
        items: [{ label: "关于 Typst-pad", action: () => (showAbout = true) }],
      },
    ];
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
      const blob = await compileToPdf(doc);
      const name = (fileTitle.replace(/\.[^.]+$/, "") || "document") + ".pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // 延迟回收避免中断下载
      statusText = "已导出 PDF";
    } catch (e) {
      statusText = "导出失败";
      previewStatus = "error";
      previewError = e instanceof Error ? e.message : String(e);
    }
  }

  function scheduleCompile() {
    runCompile(); // 立即编译：内容变化后直接编译，编译完即显示（无防抖延迟）
  }

  async function runCompile() {
    const mySeq = ++compileSeq;
    // 编译期间保留旧预览，完成后直接替换（不做 loading 遮罩）
    const result = await compileToSvg(doc);
    if (mySeq !== compileSeq) return; // 已有更新的编译请求，丢弃本结果
    if (result.ok) {
      previewHost.innerHTML = result.svg;
      pageCount = result.pageCount;
      previewStatus = "ready";
      statusText = `${doc.length} 字符 · ${result.pageCount} 页`;
    } else {
      previewStatus = "error";
      previewError = result.error;
      statusText = "编译错误";
    }
  }

  /** 窗口标题同步为“文件名 - Typst-pad”（Tauri）；文件名不再显示在 UI 顶部 */
  function syncWindowTitle() {
    if (!isTauri()) return;
    getCurrentWindow().setTitle(`${fileTitle} - Typst-pad`);
  }

  // fileTitle 变化时（打开/保存/新建）同步窗口标题
  $effect(() => {
    syncWindowTitle();
  });

  function handleKeydown(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    // Ctrl/Cmd + S：保存当前文档
    if (key === "s") {
      e.preventDefault();
      handleSave();
      return;
    }
    // Ctrl/Cmd + N：打开新窗口（Tauri）；浏览器环境阻止默认并忽略
    if (key === "n") {
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
    // 每次启动都是全新会话：仅恢复主题偏好，不恢复上次编辑内容/文件
    const saved = loadState();
    if (saved.theme === "system" || saved.theme === "dark" || saved.theme === "light") {
      theme = saved.theme;
    }

    runCompile();
    resolveTheme();
    // 系统主题变化时跟随（仅当处于“自动”态）
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme === "system") resolveTheme();
    };
    media.addEventListener("change", onSystemThemeChange);
    window.addEventListener("keydown", handleKeydown);

    // Tauri 内：支持拖放打开 / 关联双击打开 / 跨实例转发打开
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const keepUnlisten = (p: Promise<() => void>) =>
      p.then((un) => {
        if (disposed) un();
        else unlisteners.push(un);
      });
    if (isTauri()) {
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

    return () => {
      disposed = true;
      media.removeEventListener("change", onSystemThemeChange);
      window.removeEventListener("keydown", handleKeydown);
      unlisteners.forEach((un) => un());
      clearTimeout(persistTimer);
      compileSeq++; // 使在途编译结果过期，防止卸载后写入 DOM
    };
  });
</script>

<div class="app" class:light={resolvedTheme === "light"}>
  <header class="toolbar">
    <MenuBar groups={menuGroups()} />
  </header>

  <main class="panes">
    {#if dragActive}
      <div class="drop-overlay">释放以打开 .typ 文件</div>
    {/if}
    <section class="pane editor-pane">
      <div class="pane-body">
        <Editor
          initialDoc={SAMPLE_DOC}
          doc={editorDoc}
          theme={resolvedTheme}
          onCursor={handleCursor}
          onDocChange={handleDocChange}
        />
      </div>
    </section>
    <section class="pane preview-pane">
      <div class="pane-body preview-body">
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
    <span class="spacer"></span>
    <span>Ln {cursorLine}, Col {cursorCol}</span>
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
        <p class="modal-text">版本 0.2.0</p>
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
</div>

<style>
  :root {
    --bg: #1e1e1e;
    --bg-pane: #252526;
    --bg-toolbar: #2d2d30;
    --border: #3c3c3c;
    --fg: #d4d4d4;
    --fg-dim: #9d9d9d;
    --accent: #4fc1ff;
  }

  .app.light {
    --bg: #f5f5f5;
    --bg-pane: #ffffff;
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
    padding: 0 4px;
    background: var(--bg-toolbar);
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

  .panes {
    flex: 1;
    display: flex;
    min-height: 0;
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

  .preview-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px 16px;
    background: #3a3a3c;
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

  .app.light .preview-body {
    background: #c9c9cc;
  }

  .preview-paper {
    width: 100%;
    max-width: 820px;
    background: #ffffff;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    border-radius: 2px;
    padding: 16px;
  }

  .preview-paper :global(svg.typst-doc) {
    display: block;
    width: 100%;
    height: auto;
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
</style>
