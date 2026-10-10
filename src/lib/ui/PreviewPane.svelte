<script lang="ts">
  import { onMount } from "svelte";
  import type {
    DocumentCaret,
    DocumentSelectionQuad,
    FormulaPreview,
  } from "$lib/core/typst-engine";
  import type { DocumentPoint } from "$lib/core/document-drag-selection";
  import { createDocumentPages, type DocumentPage } from "./document-pages";
  import { caretScrollDelta, projectDocumentCaret } from "./document-caret";
  import type { PaperShape } from "$lib/core/preview-scale";
  import { layoutFormulaPreview } from "$lib/core/formula-preview-layout";

  let {
    hidden,
    status,
    editable = false,
    stale = false,
    caret = null,
    caretVisible = false,
    composing = false,
    selection = [],
    formulaPreview = null,
    formulaAnchor = [],
    onPageClick,
    onSelectionStart,
    onSelectionMove,
    onSelectionCancel,
    onOpenLink,
    onEditSource,
    onFormulaClick,
    onCaretPosition,
  }: {
    hidden: boolean;
    status: "idle" | "ready" | "error";
    editable?: boolean;
    stale?: boolean;
    caret?: DocumentCaret | null;
    caretVisible?: boolean;
    composing?: boolean;
    selection?: DocumentSelectionQuad[];
    formulaPreview?: FormulaPreview | null;
    formulaAnchor?: DocumentSelectionQuad[];
    onPageClick?: (point: DocumentPoint) => void;
    onSelectionStart?: (point: DocumentPoint) => void;
    onSelectionMove?: (point: DocumentPoint) => void;
    onSelectionCancel?: () => void;
    onOpenLink?: (href: string) => void;
    onEditSource?: () => void;
    onFormulaClick?: () => void;
    onCaretPosition?: (position: { left: number; top: number; height: number } | null) => void;
  } = $props();
  let paperEl = $state<HTMLElement | undefined>();
  let bodyEl = $state<HTMLElement | undefined>();
  let canvasEl: HTMLElement;
  let caretStyle = $state("");
  let windowFocused = $state(true);
  let selectionPath = $state("");
  let formulaStyle = $state("");
  let formulaFlipped = $state(false);
  let measureFrame = 0;
  let scrollFrame = 0;
  let pointerStart: {
    id: number;
    x: number;
    y: number;
    moved: boolean;
    selectable: boolean;
    selecting: boolean;
  } | null = null;
  let dragPoint: { x: number; y: number } | null = null;
  let pages: ReturnType<typeof createDocumentPages> | undefined;
  export function updatePages(sources: string[]): void {
    if (!paperEl) return;
    pages ??= createDocumentPages(paperEl);
    pages.update(sources);
    measureCaret();
  }
  export function clearPages(): void {
    pages?.clear();
  }
  export function pageWidthPt(): number {
    return pages?.widthPt() ?? 0;
  }
  /** 文档自己的纸型（最宽那页，pt）：预览重排按它等比缩放页高/页边距；没有产物时为 null */
  export function pageShape(): PaperShape | null {
    return pages?.shape() ?? null;
  }
  export function paper(): HTMLElement | undefined {
    return paperEl;
  }
  export function body(): HTMLElement | undefined {
    return bodyEl;
  }

  /** 展开/收起后的光标跟随真实新产物，避免重排把输入位置留在视口外。 */
  export function revealCaret(value: DocumentCaret): void {
    const page = pages?.page(value.page);
    if (!page || !bodyEl || !editable || hidden || composing) return;
    const position = projectDocumentCaret(value, page.host.getBoundingClientRect(), page.box);
    if (!position) return;
    const rect = bodyEl.getBoundingClientRect();
    const delta = caretScrollDelta(position, {
      left: rect.left,
      top: rect.top,
      width: bodyEl.clientWidth,
      height: bodyEl.clientHeight,
    });
    bodyEl.scrollLeft += delta.x;
    bodyEl.scrollTop += delta.y;
    measureCaret();
  }

  function measureCaret(): void {
    if (measureFrame) cancelAnimationFrame(measureFrame);
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      const hideCaret = () => {
        if (!caretStyle) return;
        caretStyle = "";
        onCaretPosition?.(null);
      };
      if (!editable || hidden || (stale && !composing) || !canvasEl || !paperEl) {
        selectionPath = "";
        formulaStyle = "";
        formulaFlipped = false;
        return hideCaret();
      }
      const root = canvasEl.getBoundingClientRect();
      formulaStyle = "";
      formulaFlipped = false;
      if (formulaPreview && formulaAnchor.length && bodyEl && !stale) {
        const pageNumber = caret?.page ?? formulaAnchor[0].page;
        const page = pages?.page(pageNumber);
        const quads = formulaAnchor.filter((q) => q.page === pageNumber);
        if (page && quads.length) {
          const rect = page.host.getBoundingClientRect(),
            body = bodyEl.getBoundingClientRect();
          const points = quads.flatMap((q) => q.points);
          const xs = points.map((p) => p[0]);
          const ys = points.map((p) => p[1]);
          const scale = rect.width / page.box.width;
          const box = layoutFormulaPreview({
            widthPt: formulaPreview.widthPt,
            heightPt: formulaPreview.heightPt,
            scale,
            anchor: {
              left: rect.left + (Math.min(...xs) - page.box.x) * scale,
              top: rect.top + (Math.min(...ys) - page.box.y) * scale,
              right: rect.left + (Math.max(...xs) - page.box.x) * scale,
              bottom: rect.top + (Math.max(...ys) - page.box.y) * scale,
            },
            viewport: {
              left: body.left,
              top: body.top,
              right: body.left + bodyEl.clientWidth,
              bottom: body.top + bodyEl.clientHeight,
            },
          });
          if (box) {
            formulaFlipped = box.flipped;
            formulaStyle =
              `left:${box.left - root.left}px;top:${box.top - root.top}px;` +
              `--formula-content-width:${box.contentWidth}px;--formula-content-height:${box.contentHeight}px;` +
              `--formula-view-width:${box.viewWidth}px;--formula-view-height:${box.viewHeight}px;` +
              `--formula-arrow:${box.arrowOffset}px`;
          }
        }
      }
      const measured = new Map<number, { rect: DOMRect; box: DocumentPage["box"] }>();
      function pageMeasure(number: number) {
        if (measured.has(number)) return measured.get(number);
        const page = pages?.page(number);
        if (!page) return;
        const rect = page.host.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const value = { rect, box: page.box };
        measured.set(number, value);
        return value;
      }
      selectionPath = selection
        .map((quad) => {
          const page = pageMeasure(quad.page);
          if (!page) return "";
          const { rect, box } = page;
          return (
            quad.points
              .map(
                ([x, y], i) =>
                  `${i === 0 ? "M" : "L"}${rect.left - root.left + ((x - box.x) * rect.width) / box.width},${rect.top - root.top + ((y - box.y) * rect.height) / box.height}`,
              )
              .join(" ") + " Z"
          );
        })
        .join(" ");
      if (!caret) return hideCaret();
      const page = pageMeasure(caret.page);
      if (!page) return hideCaret();
      const position = projectDocumentCaret(caret, page.rect, page.box);
      if (!position) return hideCaret();
      onCaretPosition?.(position);
      caretStyle = `left:${position.left - root.left}px;top:${position.top - root.top}px;height:${position.height}px;transform:rotate(${position.rotation}deg)`;
    });
  }
  $effect(() => {
    void caret;
    void selection;
    void editable;
    void hidden;
    void stale;
    void composing;
    void status;
    void formulaPreview;
    void formulaAnchor;
    measureCaret();
  });
  onMount(() => {
    const observer = new ResizeObserver(measureCaret);
    if (paperEl) observer.observe(paperEl);
    // 自然尺寸纸张不随栏宽变化，但居中位置会变，光标与选区也需要重测。
    if (bodyEl) observer.observe(bodyEl);
    const onFocus = () => {
      windowFocused = true;
    };
    const onBlur = () => {
      windowFocused = false;
    };
    const onVisibility = () => {
      windowFocused = document.visibilityState === "visible" && document.hasFocus();
    };
    windowFocused = document.hasFocus();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      cancelDrag();
      if (measureFrame) cancelAnimationFrame(measureFrame);
    };
  });

  function cancelDrag(): void {
    const pointer = pointerStart;
    pointerStart = null;
    dragPoint = null;
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (pointer && bodyEl?.hasPointerCapture(pointer.id)) bodyEl.releasePointerCapture(pointer.id);
    if (pointer?.selecting) onSelectionCancel?.();
  }

  function moveSelection(): void {
    if (!dragPoint) return;
    const point = pages?.nearest(dragPoint);
    if (point) onSelectionMove?.(point);
  }

  function autoScroll(): void {
    scrollFrame = 0;
    if (!pointerStart?.selecting || !dragPoint || !bodyEl || !editable || hidden || stale) return;
    const rect = bodyEl.getBoundingClientRect();
    const speed = (value: number, min: number, max: number) =>
      value < min + 32
        ? -Math.min(20, (min + 32 - value) / 3)
        : value > max - 32
          ? Math.min(20, (value - max + 32) / 3)
          : 0;
    const left = bodyEl.scrollLeft,
      top = bodyEl.scrollTop;
    bodyEl.scrollLeft += speed(dragPoint.x, rect.left, rect.left + bodyEl.clientWidth);
    bodyEl.scrollTop += speed(dragPoint.y, rect.top, rect.top + bodyEl.clientHeight);
    if (left === bodyEl.scrollLeft && top === bodyEl.scrollTop) return;
    moveSelection();
    measureCaret();
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function handlePointerDown(event: PointerEvent): void {
    cancelDrag();
    if (!event.isPrimary || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".formula-preview")) return;
    const rect = bodyEl?.getBoundingClientRect();
    const selectable =
      editable &&
      !stale &&
      event.pointerType === "mouse" &&
      !!rect &&
      event.clientX < rect.left + bodyEl!.clientWidth &&
      event.clientY < rect.top + bodyEl!.clientHeight &&
      !event.composedPath().some((node) => node instanceof Element && node.localName === "a");
    pointerStart = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      selectable,
      selecting: false,
    };
    if (selectable) {
      // 保留触屏滚动和链接默认行为；鼠标交给真实源码选区，不选择 SVG DOM。
      event.preventDefault();
      bodyEl?.setPointerCapture(event.pointerId);
    }
  }

  function handlePointerMove(event: PointerEvent): void {
    const start = pointerStart;
    if (!start || start.id !== event.pointerId || event.buttons !== 1) return;
    start.moved ||= Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5;
    if (!start.selectable || !start.moved) return;
    if (!editable || stale || hidden) return cancelDrag();
    if (!start.selecting) {
      const anchor = pages?.nearest({ x: start.x, y: start.y });
      if (!anchor) return;
      start.selecting = true;
      onSelectionStart?.(anchor);
    }
    event.preventDefault();
    dragPoint = { x: event.clientX, y: event.clientY };
    moveSelection();
    if (!scrollFrame) scrollFrame = requestAnimationFrame(autoScroll);
  }

  function handlePointerUp(event: PointerEvent): void {
    if (pointerStart?.id !== event.pointerId) return;
    if (pointerStart.selecting) {
      dragPoint = { x: event.clientX, y: event.clientY };
      moveSelection();
    }
    dragPoint = null;
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    // moved 留到 click，避免松开拖动后再展开表达式或清掉选区。
  }

  $effect(() => {
    if (!editable || stale || hidden) cancelDrag();
  });

  function handleClick(event: MouseEvent): void {
    if (event.target instanceof Element && event.target.closest(".formula-preview")) {
      // 卡片只消费点击：滚动条/内边距不把点击漏给页面定位，也不切换源码焦点；
      // 只有点击 SVG 内容才恢复源码编辑（不重新编译、不丢展开）。
      event.preventDefault();
      if (event.target.closest(".formula-preview-content svg")) onFormulaClick?.();
      return;
    }
    const moved =
      pointerStart &&
      (pointerStart.moved ||
        Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 5);
    pointerStart = null;
    if (moved || event.button !== 0 || !(event.target instanceof Element) || !paperEl) return;
    const anchor = event
      .composedPath()
      .find((node): node is Element => node instanceof Element && node.localName === "a");
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
    const point = pages?.nearest({ x: event.clientX, y: event.clientY });
    if (point) onPageClick?.(point);
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
    onscroll={() => {
      measureCaret();
      if (pointerStart?.selecting) moveSelection();
    }}
    onclick={handleClick}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onpointerleave={(event) => {
      // 触屏抬指后也会发送 leave（buttons=0），不能把正常轻触算成拖动。
      if (pointerStart?.id === event.pointerId && event.buttons !== 0) pointerStart.moved = true;
    }}
    onpointercancel={cancelDrag}
    onlostpointercapture={() => {
      if (dragPoint) cancelDrag();
    }}
    onkeydown={(event) => {
      if (editable && (event.key === "Enter" || event.key === "F2")) {
        event.preventDefault();
        onEditSource?.();
      }
    }}
  >
    <!-- 文档模式只有文档本体：预览区不画占位、更新提示、编译错误框和右上角按钮；
         失败与进度只在状态栏与错误徽标里体现（见 docs/development/writing-rendering.md）。 -->
    <div class="preview-canvas" bind:this={canvasEl}>
      {#if formulaPreview && formulaStyle && editable && !stale}
        <div
          class="formula-preview"
          class:flipped={formulaFlipped}
          role="tooltip"
          aria-label="公式预览"
          style={formulaStyle}
        >
          <div class="formula-preview-content">{@html formulaPreview.svg}</div>
        </div>
      {/if}
      <div
        id="preview-host"
        bind:this={paperEl}
        class="preview-paper"
        hidden={status !== "ready"}
      ></div>
      {#if selectionPath}
        <svg class="document-selection" aria-hidden="true"><path d={selectionPath}></path></svg>
      {/if}
      {#key caret}
        {#if caretStyle && caretVisible && windowFocused}
          <div class="document-caret" class:composing style={caretStyle} aria-hidden="true"></div>
        {/if}
      {/key}
    </div>
  </div>
</section>

<style>
  .formula-preview {
    position: absolute;
    z-index: 12;
    padding: 10px;
    background: #111;
    color: white;
    border: 1px solid #2a2a2a;
    border-radius: 8px;
    box-shadow: 0 6px 20px #0006;
    user-select: none;
    cursor: text;
    /* 不裁外层的箭头：::before/::after 都画在盒外（top/bottom: -8px），SVG 裁剪与框内滚动交给 .formula-preview-content。 */
  }
  .formula-preview::before {
    content: "";
    position: absolute;
    top: -8px;
    left: var(--formula-arrow);
    transform: translateX(-50%);
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-bottom: 8px solid #111;
  }
  .formula-preview.flipped::before {
    display: none;
  }
  .formula-preview.flipped::after {
    content: "";
    position: absolute;
    bottom: -8px;
    left: var(--formula-arrow);
    transform: translateX(-50%);
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid #111;
  }
  .formula-preview-content {
    width: var(--formula-view-width);
    height: var(--formula-view-height);
    overflow: auto;
  }
  .formula-preview-content :global(svg) {
    display: block;
    width: var(--formula-content-width);
    height: var(--formula-content-height);
  }
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明 —— `.preview-pane` / `.preview-paper` 都是 `width:100%`，缺了这条
     内边距与边框会叠到宽度之外（横向溢出），计算样式守卫也按 border-box 断言。 */
  * {
    box-sizing: border-box;
  }

  .preview-pane.hidden {
    display: none;
  }

  .preview-body {
    display: flex;
    flex-direction: column;
    /* 画布自己用 margin-inline: auto 居中，溢出时退化成左对齐（见 .preview-paper） */
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
  .document-selection {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    fill: var(--accent, #4daafc);
    opacity: 0.28;
  }
  .document-pane .preview-body {
    user-select: none;
    cursor: text;
  }
  .document-caret {
    position: absolute;
    width: 2px;
    background: var(--accent, #4daafc);
    pointer-events: none;
    transform-origin: top left;
    animation: document-caret-blink 1s step-end infinite;
  }
  .document-caret.composing {
    animation: none;
  }
  @keyframes document-caret-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .document-caret {
      animation: none;
    }
  }
  .preview-paper {
    width: 100%;
    /* applyPreviewScale 按容器宽度、页面 pt 尺寸和用户缩放计算内联宽度。
       测量失败时回退为铺满容器。 */
    /* 居中用**自身的 auto 外边距**，不用容器上的 align-items: center：
       界面缩放放大后画布会比栏宽宽，此时 auto 外边距退化为 0（负剩余空间）→ 页面左对齐、
       横向滚动条能真正滚到左缘；若靠容器居中，溢出的左半部分会被顶到滚动区之外，
       scrollLeft 又不能为负 → 那部分永远看不到（实测踩过）。 */
    margin-inline: auto;
  }

  /* Shadow DOM 隔离每页 SVG 的 ID 引用，产物不改写；共同缩放只改变宿主宽度。
     离屏页跳过绘制但保留真实纸型占位，全部产物与几何仍完整存在。
     不支持 content-visibility 的 WebView 自动退化为全页绘制。 */
  .preview-paper > :global(.document-page) {
    position: relative;
    margin-inline: auto;
    content-visibility: auto;
    filter: var(--night-svg-filter, none);
  }
  .preview-paper > :global(.page-separator) {
    height: 1px;
    background: var(--border);
  }
</style>
