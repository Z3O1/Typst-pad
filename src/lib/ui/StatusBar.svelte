<script lang="ts">
  // 状态栏（原来内联在 +page.svelte 的 <footer> 里）。
  //
  // 两个计数徽标是 StatusBar 的**子组件** DiagnosticBadge（错误 / 警告共用一份行为，
  // 见那边文件头的说明），浮层的开合状态仍由页面持有（页面还有"点条目跳转就顺手收起"那条路）。
  // 这里只把状态摆出来 + 把交互回调转给页面。
  import DiagnosticBadge from "./DiagnosticBadge.svelte";
  import { ZOOM_DEFAULT, zoomLabel } from "../core/zoom";
  import type { ErrorListItem, LocatedErrorItem } from "./error-list";
  import type { DiagnosticKind } from "./status-view";

  let {
    statusText,
    updateNotice,
    onOpenUpdate,
    viewMode,
    uiZoom,
    charCount,
    pageCount,
    cursorLine,
    cursorCol,
    errorCount,
    lastNonPosError,
    errorItems,
    warningCount,
    warningItems,
    openBadge,
    onToggleBadge,
    onCloseBadge,
    onItemClick,
    onCopyOne,
    onCopyAll,
  }: {
    statusText: string;
    /** 状态栏的更新提示（点击重开更新弹窗）；无提示时为 null */
    updateNotice: string | null;
    onOpenUpdate: () => void;
    viewMode: "write" | "source";
    uiZoom: number;
    charCount: number;
    pageCount: number;
    cursorLine: number;
    cursorCol: number;
    errorCount: number;
    /** 最近一次编译的非定位错误（无位置，如包不存在） */
    lastNonPosError: string | null;
    errorItems: ErrorListItem[];
    warningCount: number;
    warningItems: ErrorListItem[];
    /** 当前开着哪个浮层（两个徽标共用一份状态，见 badge-popover.ts） */
    openBadge: "none" | DiagnosticKind;
    onToggleBadge: (kind: DiagnosticKind) => void;
    onCloseBadge: () => void;
    onItemClick: (item: LocatedErrorItem) => void;
    onCopyOne: (item: ErrorListItem, kind: DiagnosticKind) => void;
    onCopyAll: (kind: DiagnosticKind) => void;
  } = $props();
</script>

<footer class="statusbar">
  <!-- 左侧最前：编译错误 + 编译警告计数（VS Code 状态栏同序：⊗ 0 ⚠ 0，用户给的参照图）。
       两者都**常驻显示**（无问题时是 0）——它们在同一列里，常驻才能一眼看出"编译干净"，
       也避免数字出现/消失时整条状态栏左右抖动。错误在警告**左边**。 -->
  <span class="badge-group">
    <DiagnosticBadge
      kind="errors"
      count={errorCount}
      items={errorItems}
      {openBadge}
      {lastNonPosError}
      onToggle={() => onToggleBadge("errors")}
      onClose={onCloseBadge}
      {onItemClick}
      onCopyOne={(item) => onCopyOne(item, "errors")}
      onCopyAll={() => onCopyAll("errors")}
    />
    <DiagnosticBadge
      kind="warnings"
      count={warningCount}
      items={warningItems}
      {openBadge}
      onToggle={() => onToggleBadge("warnings")}
      onClose={onCloseBadge}
      {onItemClick}
      onCopyOne={(item) => onCopyOne(item, "warnings")}
      onCopyAll={() => onCopyAll("warnings")}
    />
  </span>
  <!-- 状态文字：占满剩余空间、单行省略（可伸缩项，见 .status-text 的样式） -->
  <span class="status-text">{statusText}</span>
  {#if updateNotice}
    <button class="status-update" title="打开更新窗口" onclick={onOpenUpdate}>{updateNotice}</button
    >
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

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明 —— 漏了就是静默退回 content-box。 */
  * {
    box-sizing: border-box;
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

  /* 状态栏右侧的「可更新到 vX」入口（点击重开更新弹窗） */
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

  /* 模式标签（写作 / 源码）与缩放徽标共用 */
  .mode-tag {
    padding: 0 8px;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg-dim);
    font-size: 12px;
  }
</style>
