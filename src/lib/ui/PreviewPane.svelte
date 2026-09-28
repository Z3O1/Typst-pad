<script lang="ts">
  import { onMount } from "svelte";
  import type { DocumentCaret } from "$lib/core/typst-engine";
  import { pageCoordinates } from "$lib/core/document-interaction";

  let {
    hidden,
    status,
    error,
    editable = false,
    stale = false,
    caret = null,
    onPageClick,
    onOpenLink,
    onEditSource,
    onCaretPosition,
    sourceExpanded = false,
    onCloseSource,
  }: {
    hidden: boolean;
    status: "idle" | "ready" | "error";
    error: string;
    editable?: boolean;
    stale?: boolean;
    caret?: DocumentCaret | null;
    onPageClick?: (point: { page: number; xPt: number; yPt: number }) => void;
    onOpenLink?: (href: string) => void;
    onEditSource?: () => void;
    onCaretPosition?: (position: { left: number; top: number; height: number } | null) => void;
    sourceExpanded?: boolean;
    onCloseSource?: () => void;
  } = $props();
  let paperEl = $state<HTMLElement | undefined>();
  let bodyEl = $state<HTMLElement | undefined>();
  let canvasEl: HTMLElement;
  let caretStyle = $state("");
  let measureFrame = 0;
  let pointerStart: { x: number; y: number } | null = null;
  export function paper(): HTMLElement | undefined {
    return paperEl;
  }
  export function body(): HTMLElement | undefined {
    return bodyEl;
  }

  function measureCaret(): void {
    if (measureFrame) cancelAnimationFrame(measureFrame);
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      caretStyle = "";
      onCaretPosition?.(null);
      if (!caret || !editable || hidden || stale || !canvasEl || !paperEl) return;
      const svg = paperEl.querySelectorAll<SVGSVGElement>(":scope > svg")[caret.page - 1];
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const root = canvasEl.getBoundingClientRect();
      const box = svg.viewBox.baseVal;
      if (box.width <= 0 || box.height <= 0 || rect.width <= 0) return;
      const scaleX = rect.width / box.width,
        scaleY = rect.height / box.height;
      onCaretPosition?.({
        left: rect.left + (caret.xPt - box.x) * scaleX,
        top: rect.top + (caret.yPt - box.y) * scaleY,
        height: Math.max(2, caret.heightPt * scaleY),
      });
      caretStyle = `left:${rect.left - root.left + (caret.xPt - box.x) * scaleX}px;top:${rect.top - root.top + (caret.yPt - box.y) * scaleY}px;height:${Math.max(2, caret.heightPt * scaleY)}px;transform:rotate(${caret.rotationDeg ?? 0}deg)`;
    });
  }
  $effect(() => {
    void caret;
    void editable;
    void hidden;
    void stale;
    void status;
    measureCaret();
  });
  onMount(() => {
    const observer = new ResizeObserver(measureCaret);
    if (paperEl) observer.observe(paperEl);
    return () => {
      observer.disconnect();
      if (measureFrame) cancelAnimationFrame(measureFrame);
    };
  });

  function handleClick(event: MouseEvent): void {
    const moved =
      pointerStart &&
      Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5;
    pointerStart = null;
    if (moved || event.button !== 0 || !(event.target instanceof Element) || !paperEl) return;
    const anchor = event.target.closest("a");
    if (anchor) {
      const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href");
      if (href && /^(https?:|mailto:)/i.test(href)) {
        event.preventDefault();
        onOpenLink?.(href);
        return;
      }
      // Typst 的页内链接保留浏览器行为。
      if (href?.startsWith("#")) return;
      event.preventDefault();
    }
    if (!editable) return;
    let svg = event.target.closest("svg");
    while (svg && svg.parentElement !== paperEl) svg = svg.parentElement?.closest("svg") ?? null;
    if (!(svg instanceof SVGSVGElement)) return;
    const pages = [...paperEl.querySelectorAll(":scope > svg")];
    const point = pageCoordinates(
      { x: event.clientX, y: event.clientY },
      svg.getBoundingClientRect(),
      svg.viewBox.baseVal,
    );
    if (point) onPageClick?.({ page: pages.indexOf(svg) + 1, ...point });
  }
</script>

<section class="pane preview-pane" class:hidden class:document-pane={editable}>
  <!-- 展开源码也由 Typst 整页编译；光标单独叠加在页面上。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="pane-body preview-body"
    data-context-zone="preview"
    bind:this={bodyEl}
    tabindex={editable ? 0 : undefined}
    onscroll={measureCaret}
    onclick={handleClick}
    onpointerdown={(event) => {
      pointerStart = { x: event.clientX, y: event.clientY };
    }}
    onkeydown={(event) => {
      if (editable && (event.key === "Enter" || event.key === "F2")) {
        event.preventDefault();
        onEditSource?.();
      }
    }}
  >
    {#if editable && sourceExpanded}<button
        class="close-source"
        onclick={(event) => {
          event.stopPropagation();
          onCloseSource?.();
        }}>收起源码</button
      >{/if}
    {#if editable}<button
        class="edit-source"
        onclick={(event) => {
          event.stopPropagation();
          onEditSource?.();
        }}>源码模式</button
      >{/if}
    {#if error}
      <div class="preview-error" role="status">
        <div class="preview-error-title">
          编译错误{status === "ready" ? " · 显示上次成功结果" : ""}
        </div>
        <pre class="preview-error-text">{error}</pre>
      </div>
    {:else if status === "idle"}<div class="preview-placeholder">等待编译…</div>{/if}
    {#if stale && !error}<div class="preview-notice" role="status">正在更新排版…</div>{/if}
    <div class="preview-canvas" bind:this={canvasEl}>
      <div
        id="preview-host"
        bind:this={paperEl}
        class="preview-paper"
        hidden={status !== "ready"}
      ></div>
      {#if caretStyle}<div class="document-caret" style={caretStyle} aria-hidden="true"></div>{/if}
    </div>
  </div>
</section>

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明 —— `.preview-error` 是 `width:100%` + 内边距 + 边框，缺了它会横向溢出。 */
  * {
    box-sizing: border-box;
  }

  .preview-pane.hidden {
    display: none;
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

  .preview-canvas {
    position: relative;
    width: 100%;
  }
  .document-caret {
    position: absolute;
    width: 2px;
    background: var(--accent, #4daafc);
    pointer-events: none;
    transform-origin: top left;
  }
  .edit-source,
  .close-source {
    align-self: flex-end;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 10px;
    background: var(--bg-paper);
    color: var(--fg);
    cursor: pointer;
  }
  .preview-notice {
    color: var(--fg-dim);
    font-size: 12px;
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
     （容器宽度由缩放逻辑控制）、高度按比例——等宽缩放，文本不拉伸变形。
     夜间滤镜：typst 产物永远是白纸黑字，深色主题下整页反色成"深色纸 + 浅色字"。
     值走页面变量 --night-svg-filter（`:root` 深色 / `.app.light` = none），
     所以切换主题不需要重新编译。
     （彩色图形与嵌入图片也会被反色，这是"不重新编译"的代价，取舍见 docs/development/architecture.md。） */
  .preview-paper > :global(svg) {
    display: block;
    width: 100%;
    height: auto;
    filter: var(--night-svg-filter, none);
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
</style>
