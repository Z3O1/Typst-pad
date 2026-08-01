<script lang="ts">
  import { onMount } from "svelte";
  import Editor from "$lib/Editor.svelte";
  import { compileToSvg, compileToPdf } from "$lib/typst-engine";
  import { openTypFile, saveTypFile } from "$lib/file-ops";

  const SAMPLE_DOC = `= 欢迎使用 Typst-pad

这是左侧的 *Typst* 源码，右侧将显示实时预览。

== 数学公式

$ sum_(k=1)^n k = (n(n+1)) / 2 $

== 列表

- 第一项
- 第二项
- 第三项
`;

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

  function handleCursor(line: number, col: number) {
    cursorLine = line;
    cursorCol = col;
  }

  function handleDocChange(newDoc: string) {
    doc = newDoc;
    dirty = true;
    scheduleCompile();
  }

  async function handleOpen() {
    try {
      const opened = await openTypFile();
      if (!opened) return;
      doc = opened.content;
      filePath = opened.path;
      fileTitle = opened.path.split(/[\\/]/).pop() ?? opened.path;
      dirty = false;
      editorDoc = opened.content; // 触发编辑器替换全文
      scheduleCompile();
    } catch (e) {
      statusText = "打开失败";
    }
  }

  async function handleSave() {
    try {
      const saved = await saveTypFile(filePath, doc);
      if (!saved) return;
      filePath = saved;
      fileTitle = saved.split(/[\\/]/).pop() ?? saved;
      dirty = false;
      statusText = "已保存";
    } catch (e) {
      statusText = "保存失败";
    }
  }

  function systemPrefersDark(): boolean {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function resolveTheme(): void {
    resolvedTheme = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
  }

  // theme 变化（含手动切换）时重算生效主题
  $effect(() => {
    resolveTheme();
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

  function handleKeydown(e: KeyboardEvent) {
    // Ctrl/Cmd + S：保存当前文档
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      handleSave();
    }
  }

  onMount(() => {
    runCompile();
    resolveTheme();
    // 系统主题变化时跟随（仅当处于“自动”态）
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (theme === "system") resolveTheme();
    };
    media.addEventListener("change", onSystemThemeChange);
    window.addEventListener("keydown", handleKeydown);
    return () => {
      media.removeEventListener("change", onSystemThemeChange);
      window.removeEventListener("keydown", handleKeydown);
      compileSeq++; // 使在途编译结果过期，防止卸载后写入 DOM
    };
  });
</script>

<div class="app" class:light={resolvedTheme === "light"}>
  <header class="toolbar">
    <div class="app-title">Typst-pad</div>
    <div class="file-title" title="当前文件">{dirty ? "● " : ""}{fileTitle}</div>
    <div class="toolbar-actions">
      <button class="tool-btn" onclick={handleOpen}>打开</button>
      <button class="tool-btn" onclick={handleSave}>保存</button>
      <button class="tool-btn" onclick={toggleTheme} title="当前生效: {resolvedTheme === "dark" ? "暗色" : "亮色"}">主题: {theme === "system" ? "自动" : theme === "dark" ? "暗" : "明"}</button>
      <button class="tool-btn" onclick={handleExportPdf}>导出 PDF</button>
    </div>
  </header>

  <main class="panes">
    <section class="pane editor-pane">
      <div class="pane-label">编辑</div>
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
      <div class="pane-label">预览</div>
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
    gap: 16px;
    padding: 8px 16px;
    background: var(--bg-toolbar);
    border-bottom: 1px solid var(--border);
    user-select: none;
  }

  .app-title {
    font-weight: 600;
    color: var(--accent);
  }

  .file-title {
    flex: 1;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toolbar-actions {
    display: flex;
    gap: 8px;
  }

  .tool-btn {
    padding: 4px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-pane);
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
  }

  .tool-btn:hover {
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

  .pane-label {
    padding: 6px 12px;
    font-size: 12px;
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    user-select: none;
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
