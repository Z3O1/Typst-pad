<script lang="ts">
  import { onMount } from "svelte";
  import type { DocumentCaret } from "$lib/core/typst-engine";
  import { nearestPageCoordinates } from "$lib/core/document-interaction";

  let {
    hidden,
    status,
    editable = false,
    stale = false,
    caret = null,
    onPageClick,
    onOpenLink,
    onEditSource,
    onCaretPosition,
  }: {
    hidden: boolean;
    status: "idle" | "ready" | "error";
    editable?: boolean;
    stale?: boolean;
    caret?: DocumentCaret | null;
    onPageClick?: (point: { page: number; xPt: number; yPt: number }) => void;
    onOpenLink?: (href: string) => void;
    onEditSource?: () => void;
    onCaretPosition?: (position: { left: number; top: number; height: number } | null) => void;
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
    const point = nearestPageCoordinates(
      { x: event.clientX, y: event.clientY },
      [...paperEl.querySelectorAll<SVGSVGElement>(":scope > svg")].map((svg) => ({
        rect: svg.getBoundingClientRect(),
        box: svg.viewBox.baseVal,
      })),
    );
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
    <!-- 文档模式只有文档本体：预览区不画占位、更新提示、编译错误框和右上角按钮；
         失败与进度只在状态栏与错误徽标里体现（见 docs/development/writing-rendering.md）。 -->
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
  .document-caret {
    position: absolute;
    width: 2px;
    background: var(--accent, #4daafc);
    pointer-events: none;
    transform-origin: top left;
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
</style>
