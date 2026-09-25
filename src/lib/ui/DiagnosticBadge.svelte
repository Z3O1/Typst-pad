<script lang="ts">
  // 状态栏的一个计数徽标 + 它的诊断浮层（原来内联在 +page.svelte 的 <footer> 里）。
  //
  // 错误与警告**共用这一个组件、同一份行为**：0.8.4 那轮用户反馈「点击警告 / 关闭警告的行为
  // 应该和错误是一样的」，根因就是两侧各写一遍、警告侧漏了 Esc / 点外部 / 跳转即关 / 视口收边。
  // 现在这三条交互都收在本组件里：内容没了自动收、Esc 与点外部收、打开瞬间视口收边。
  // （浮层的开合状态仍在页面手里：那里还有"点条目跳转就顺手收起"这条路。）
  import { tick } from "svelte";
  import { clampPopoverRect } from "./popover-utils";
  import {
    formatErrorLoc,
    hasErrorToShow,
    type ErrorListItem,
    type LocatedErrorItem,
  } from "./error-list";
  import {
    badgePopoverStyle,
    errorPopoverVisible,
    warningPopoverVisible,
    type BadgeKind,
    type BadgePopoverState,
  } from "./badge-popover";

  let {
    kind,
    count,
    items,
    openBadge,
    lastNonPosError = null,
    onToggle,
    onClose,
    onItemClick,
    onCopyOne,
    onCopyAll,
  }: {
    kind: BadgeKind;
    count: number;
    items: ErrorListItem[];
    /** 页面里的浮层开合状态（"两个徽标共用一份"⇒ 同一时刻只会开一个） */
    openBadge: BadgePopoverState;
    /** 非定位错误（只有错误侧有）：决定"没有定位错误时徽标还能不能点" */
    lastNonPosError?: string | null;
    onToggle: () => void;
    onClose: () => void;
    onItemClick: (item: LocatedErrorItem) => void;
    onCopyOne: (item: ErrorListItem) => void;
    onCopyAll: () => void;
  } = $props();

  const isErrors = $derived(kind === "errors");
  /** 本徽标的浮层是不是开着（共用状态里指向自己才算） */
  const open = $derived(openBadge === kind);
  /** 徽标是否可点：有可展示内容才可点（错误侧还认"非定位错误"） */
  const clickable = $derived(isErrors ? hasErrorToShow(count, lastNonPosError) : count > 0);
  /** 浮层是否真的存在：开着 **且** 有内容 —— 空浮层（只有标题）没意义 */
  const visible = $derived(
    isErrors
      ? errorPopoverVisible(openBadge, count, lastNonPosError)
      : warningPopoverVisible(openBadge, count),
  );
  const title = $derived(
    isErrors ? `编译错误${count > 0 ? `（${count} 处）` : ""}` : `编译警告（${count} 处）`,
  );

  let wrapEl = $state<HTMLElement | undefined>(undefined);
  let popoverEl = $state<HTMLElement | undefined>(undefined);
  let clamp = $state({ translateX: 0, translateY: 0, maxWidth: 0 });

  function toggle() {
    if (clickable) onToggle();
  }

  // ① 内容没了就收起。**这条不能省**：错误侧修好错误后会留一个只有标题的空浮层；警告侧
  //    只靠条件渲染隐藏时状态仍留在"开着"，同一份文档里警告一回来浮层就自己弹开
  //    （验收第 43 组锁这两条）。写在 effect 里是因为它读的都是编译结果。
  $effect(() => {
    if (open && !visible) onClose();
  });

  // ② 浮层打开期间：Esc 关闭；点击浮层外部（mousedown，先于 click）关闭。
  //    徽标本身在自己的 wrap 内，所以点徽标的切换逻辑不受外部判定干扰。
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (wrapEl && !wrapEl.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
    };
  });

  // ③ 打开瞬间做一次视口收边：浮层是 `left: 0` 锚定的 520px 宽块，窄窗口下会从窗口右缘溢出
  //    （用户在 400px 视口下实测右缘 406 > 400）。下一 tick 等 {#if} 渲染完成再量，越界则用
  //    transform 平移（必要时叠加限宽）收回视口内，不破坏锚定关系。窗口 resize 不重算。
  //    先复位上次遗留的 clamp：不复位的话第二次打开时量到的是"已平移过的"矩形，算出位移 ≈ 0，
  //    把变换清零后浮层跳回自然（溢出窗口）位置（实测「第一次对，第二次错」）。
  $effect(() => {
    if (!open) return;
    let disposed = false;
    clamp = { translateX: 0, translateY: 0, maxWidth: 0 };
    void tick().then(() => {
      if (disposed || !popoverEl) return;
      clamp = clampPopoverRect(popoverEl.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      });
    });
    return () => {
      disposed = true;
    };
  });
</script>

<span class="error-badge-wrap" class:warning-badge-wrap={!isErrors} bind:this={wrapEl}>
  <span
    class="error-badge"
    class:warning-badge={!isErrors}
    class:clickable
    class:active={visible}
    role="button"
    tabindex="0"
    aria-expanded={visible}
    title={isErrors ? "编译错误（渲染已停止）" : "编译警告（不中断渲染）"}
    onclick={toggle}
    onkeydown={(e) => {
      if (e.key === "Enter") toggle();
    }}
  >
    {#if isErrors}
      <!-- 圆圈叉（VS Code 的 error 图标形状）：**整幅内联 SVG**，圆圈与叉一起画。
           以前是 CSS 圆环 + `✕` 字形，字形随系统字体变粗变细、叉的粗细与圆圈对不上，
           用户比对参照图后指出"不像"——现在两个图标都是 16×16 视图框里的描边图形，
           线宽比例也照参照图定（圆环 1.5、叉 1.35，叉的线略细于圆环）。 -->
      <svg class="error-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path
          d="M5 5 11 11M11 5 5 11"
          fill="none"
          stroke="currentColor"
          stroke-width="1.35"
          stroke-linecap="round"
        />
      </svg>
    {:else}
      <!-- 三角形内部感叹号（VS Code 的 warning 图标形状）：内联 SVG，用 currentColor
           上色（不用 ⚠ 字形——跨字体渲染差异大，而且它是彩色 emoji 字体）。
           描边路径的三个角都是**显式圆弧**（半径 1.25），比 stroke-linejoin 的圆角更接近
           参照图里那种圆钝的三角；感叹号按参照图量出来的比例：竖杠略粗于三角线宽、圆点稍大。 -->
      <svg class="warning-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M15.09 12.83A1.3 1.3 0 0 1 13.95 14.75L2.05 14.75A1.3 1.3 0 0 1 0.91 12.83L6.86 1.93A1.3 1.3 0 0 1 9.14 1.93Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M8 5.4V9.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
      </svg>
    {/if}
    <span class="error-count">{count}</span>
  </span>
  {#if visible}
    <div
      class="error-popover"
      class:warning-popover={!isErrors}
      bind:this={popoverEl}
      role="dialog"
      aria-label={isErrors ? "编译错误列表" : "编译警告列表"}
      style={badgePopoverStyle(clamp)}
    >
      <div class="error-popover-title">
        <span>{title}</span>
        <!-- 复制整份列表（首行是这段标题原文，其后每条一行，路径在行列前面） -->
        <button
          class="error-copy-all"
          title={isErrors
            ? "复制全部错误信息（含文件路径与行列）"
            : "复制全部警告信息（含文件路径与行列）"}
          aria-label={isErrors ? "复制全部错误信息" : "复制全部警告信息"}
          onclick={onCopyAll}>复制全部</button
        >
      </div>
      <div class="error-list">
        {#each items as item}
          <!-- 每条 = 「条目（点击跳转）」+「复制」两个兄弟按钮：
               按钮不能嵌按钮（HTML 非法），所以必须有这层 row 包裹 -->
          <div class="error-item-row">
            {#if item.kind === "located"}
              <button class="error-item" onclick={() => onItemClick(item)}>
                <span class="error-item-loc">{formatErrorLoc(item)}</span>
                <span class="error-item-msg">{item.message}</span>
              </button>
            {:else}
              <div class="error-item error-item-generic">
                {#if isErrors}
                  <span class="error-item-loc">{formatErrorLoc(item)}</span>
                {/if}
                <span class="error-item-msg">{item.message}</span>
              </div>
            {/if}
            <button
              class="error-item-copy"
              title={isErrors
                ? "复制这条错误信息（含文件路径与行列）"
                : "复制这条警告信息（含文件路径与行列）"}
              aria-label={isErrors ? "复制这条错误信息" : "复制这条警告信息"}
              onclick={() => onCopyOne(item)}>复制</button
            >
          </div>
        {/each}
      </div>
    </div>
  {/if}
</span>

<style>
  /* 页面那条 `* { box-sizing: border-box }` 因 Svelte 作用域命中不了子组件（见 07 分册），
     搬出来的组件要自己声明 —— 浮层是 520px 定宽 + 内边距 + 边框，缺了它宽度会多出 18px。 */
  * {
    box-sizing: border-box;
  }

  /* 错误徽标容器：Popover 的定位锚点（徽标 + 浮层同一容器） */
  .error-badge-wrap {
    position: relative;
    display: inline-flex;
  }

  /* 编译错误徽标：圆圈 ✕ + 个数，常驻显示（无错误时为 0） */
  .error-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-dim);
  }

  /* 两个状态徽标的图标：都是 16×16 视图框、显示 14px 的内联 SVG（尺寸与线宽都照
     参照图标定：图标高度 / 数字高度 ≈ 1.6）。别再退回 CSS 圆环 + `✕` 字形或 `⚠` 字形 ——
     字形随系统字体变粗细，跟旁边的描边图形不是一套观感（用户比对参照图后指出过）。 */
  .error-icon,
  .warning-icon {
    display: block;
    flex: none;
  }

  .error-count {
    font-variant-numeric: tabular-nums; /* 数字变化时宽度稳定，不抖动 */
  }

  /* 徽标可点击（存在可展示内容时）：指针 + 悬停变亮，提示可查看详情。
     **警告徽标也吃这条**（它的类名是 `error-badge warning-badge`）—— 所以这里的
     `cursor: pointer` 是两个徽标共用的，别只留下面的黄色规则、把这条当成错误专用
     （验收第 43 组两个徽标都断言 cursor: pointer，拆类名会让警告侧悄悄丢掉指针）。 */
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

  /* 编译警告徽标：与错误徽标同款但偏黄——警告不中断渲染，别让人以为编译挂了。
     图标是内联 SVG 三角形+感叹号（VS Code 形状），用 currentColor 上色；
     指针（`cursor: pointer`）由上面 `.error-badge.clickable` 那条一起给（类名共用）。 */
  .warning-badge.clickable {
    color: #e5c07b;
  }
  .warning-badge.clickable:hover,
  .warning-badge.clickable.active {
    color: #ffd79a;
  }

  /* 编译错误/警告 Popover：锚定徽标上方，圆角阴影风格与菜单下拉一致，不遮全屏。
     `left: 0` 而不是 `right: 0` —— 徽标现在在状态栏最左（2026-09-14），右对齐会把 520px 宽的
     浮层整体推到窗口左侧外面（靠 clampPopoverRect 也能救回来，但那样每次都是"被夹住"的状态）。 */
  .error-popover {
    /* 与弹窗/菜单同一套「弹出来的面板」配色（--panel-*，定义在 +page.svelte 的
       `:root` 与 `.app.light`）：面板本体一个底色，里面的**每一条诊断（.error-item）
       用次级底色**——深色主题是「深面板 + 略亮条目」，浅色是「白面板 + 浅灰条目」，
       两边都是条目比面板"凸"一点。 */
    --bg-pane: var(--panel-soft-bg);
    --border: var(--panel-border);
    --fg: var(--panel-fg);
    --fg-dim: var(--panel-fg-dim);
    --accent: var(--panel-accent);
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    width: 520px;
    max-width: 90vw;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    box-shadow: var(--panel-shadow);
    color: var(--panel-fg); /* 面板自己的字色；不写这条会继承 `.app` 的字色 */
    padding: 8px;
    z-index: 50;
    /* 状态栏整条是 user-select: none，这里必须显式放开：浮层里的诊断文字要能拖选复制
       （「复制」按钮之外的第二条出路，用户 2026-09-18 要求"复制错误信息"） */
    user-select: text;
  }

  /* 标题行：左边标题、右边「复制全部」（两个浮层同款） */
  .error-popover-title {
    margin: 2px 4px 6px;
    color: var(--fg-dim);
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  /* 一条诊断 = 「条目」+「复制」两个兄弟按钮（按钮不能嵌按钮，见 markup 注释）。
     条目占满剩余宽度（原来靠 width:100%，进了 flex row 要改成 flex: 1） */
  .error-item-row {
    display: flex;
    align-items: stretch;
    gap: 6px;
  }

  .error-item-row > .error-item {
    flex: 1 1 auto;
    /* min-width: 0 不能省：flex 项默认 min-width: auto，长消息会把 row 撑宽、
       把旁边的「复制」挤出浮层（消息本身已有 word-break，交给它换行） */
    min-width: 0;
  }

  /* 复制按钮：透明底、无边框的小字，悬停才描边 —— 不加色块（"界面不要多余凸出"） */
  .error-item-copy,
  .error-copy-all {
    flex: none;
    align-self: center;
    padding: 3px 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-dim);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
    cursor: pointer;
    white-space: nowrap;
  }

  .error-item-copy:hover,
  .error-copy-all:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .error-list {
    margin-top: 4px;
    min-height: 0; /* 允许在 max-height 的 Popover 内收缩，列表内部滚动 */
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* 可点击的错误条目：左对齐、等宽定位、悬停高亮。
     底色走 `--bg-pane`（浮层里已重绑成 --panel-soft-bg 的**次级底色**）——
     条目比面板底色亮一档（深色主题 #303033 / #252526，浅色主题 #f0f0f0 / #ffffff）。 */
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
    background: var(--panel-hover-bg);
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

  /* 非定位错误条目：纯文本展示，不可点击（悬停不高亮 —— 连底色也不许变） */
  .error-item-generic {
    cursor: default;
  }

  .error-item-generic:hover {
    background: var(--bg-pane);
    border-color: transparent;
    color: var(--fg);
  }
</style>
