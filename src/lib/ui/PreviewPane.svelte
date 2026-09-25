<script lang="ts">
  // 预览栏（原来内联在 +page.svelte）。
  //
  // **这个组件对外提供句柄**：画布与滚动容器两个元素都在组件内部，而页面要
  // ① 编译成功后直接把整页 SVG 写进画布（innerHTML）、② 量容器的 CSS 宽度做"按栏宽重排"、
  // ③ 在画布上取选区（右键菜单"全选预览"）。`bind:this` 只能绑到页面自己的元素上，
  // 所以这里用 `export function` 把两个元素交出去（页面侧见 previewPaneRef）。
  //
  // 骨架样式（`.pane` / `.pane-body`）与编辑栏共用，留在页面里并写成 `:global(...)`；
  // 这里只有预览栏自己的那几条。
  let {
    hidden,
    status,
    error,
  }: {
    /** 预览栏是否收起（单栏形态：写作模式，或用户手动关掉了预览栏） */
    hidden: boolean;
    status: "idle" | "ready" | "error";
    /** 编译失败时的原始错误（面板里显示） */
    error: string;
  } = $props();

  let paperEl = $state<HTMLElement | undefined>(undefined);
  let bodyEl = $state<HTMLElement | undefined>(undefined);

  /** 画布元素：页面写 innerHTML / 设内联宽度 / 找里面的 `<svg>`（见 applyPreviewScale） */
  export function paper(): HTMLElement | undefined {
    return paperEl;
  }

  /** 滚动容器：页面量 `clientWidth`（换算页宽 pt）并挂 ResizeObserver */
  export function body(): HTMLElement | undefined {
    return bodyEl;
  }
</script>

<section class="pane preview-pane" class:hidden>
  <!-- data-context-zone：右键区域判定标记（覆盖占位/错误/预览纸张全部子区域） -->
  <div class="pane-body preview-body" data-context-zone="preview" bind:this={bodyEl}>
    {#if status === "error"}
      <div class="preview-error">
        <div class="preview-error-title">编译错误</div>
        <pre class="preview-error-text">{error}</pre>
      </div>
    {:else if status === "idle"}
      <div class="preview-placeholder">等待编译…</div>
    {/if}
    <div
      id="preview-host"
      bind:this={paperEl}
      class="preview-paper"
      hidden={status !== "ready"}
    ></div>
  </div>
</section>

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明 —— `.preview-error` 是 `width:100%` + 内边距 + 边框，缺了它会横向溢出。 */
  * {
    box-sizing: border-box;
  }

  /* 单栏（所见即所得）：预览栏整体不参与布局。祖先 `.panes` 在页面里（写作模式那半边），
     所以这里必须写成 `:global(祖先) .自己的类` —— 只写 `.panes.single .preview-pane` 的话，
     页面的作用域命中不了本组件里的元素。 */
  :global(.panes.single) .preview-pane {
    display: none;
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
     值走页面变量 --night-svg-filter（`:root` 深色 / `.app.light` = none），与写作模式的
     切片、公式**共用同一条**，所以切换主题**不需要重新编译** —— 已编译好的 SVG 立即换色。
     （彩色图形与嵌入图片也会被反色，这是"不重新编译"的代价，取舍见 docs/development/frontend.md。） */
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
