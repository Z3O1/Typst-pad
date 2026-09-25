<script lang="ts">
  // 受控右键菜单弹层：props 传入条目与弹出位置，position 为 null 时不渲染。
  // - 弹出位置超出视口时自动收边（computeMenuPosition 纯函数）；
  // - 点击外部 / Escape / 窗口滚动（捕获阶段，覆盖内部滚动）/ 窗口失焦时回调 onClose。
  // 样式与 MenuBar 下拉一致（共用 +page.svelte `:root` / `.app.light` 里那组「弹出来的面板」
  // --panel-*，圆角阴影同款；**跟随主题**：深色主题深面板 + 浅字，浅色主题白面板 + 深字）。
  import { computeMenuPosition } from "./context-menu-utils";

  export type ContextMenuItem =
    | { type: "separator" }
    | { type: "item"; label: string; disabled?: boolean; onClick?: () => void };

  let {
    items,
    position,
    onClose,
  }: {
    items: ContextMenuItem[];
    position: { x: number; y: number } | null;
    onClose: () => void;
  } = $props();

  let menuEl = $state<HTMLElement | null>(null); // bind:this；effect 中读取，需响应式声明
  let pos = $state({ left: 0, top: 0 });

  // position 变化 / 菜单尺寸变化（ResizeObserver 兜底条目增删引起的宽度变化）/
  // 窗口缩放时重算收边后的位置
  $effect(() => {
    if (!position) return;
    const el = menuEl;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      pos = computeMenuPosition(
        position.x,
        position.y,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      );
    };
    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  });

  // 打开期间注册关闭监听（position 为 null 时不注册）
  $effect(() => {
    if (!position) return;
    const onMousedown = (e: MouseEvent) => {
      // 菜单项按钮都在 menuEl 内部，点击项时不会被误判为外部关闭；
      // 点击后由 onclick 统一关闭并执行命令
      if (menuEl && !menuEl.contains(e.target as Node)) onClose();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScroll = () => onClose();
    const onWindowBlur = () => onClose();
    window.addEventListener("mousedown", onMousedown);
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("scroll", onScroll, true); // 捕获：编辑器/预览内部滚动也触发
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("mousedown", onMousedown);
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  });
</script>

{#if position}
  <div
    class="context-menu"
    bind:this={menuEl}
    role="menu"
    tabindex="-1"
    style="left: {pos.left}px; top: {pos.top}px;"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each items as item, i (item.type === "separator" ? `sep-${i}` : item.label)}
      {#if item.type === "separator"}
        <div class="menu-separator" role="separator"></div>
      {:else}
        <button
          class="menu-item"
          class:disabled={item.disabled}
          role="menuitem"
          disabled={item.disabled}
          onclick={() => {
            onClose();
            item.onClick?.();
          }}
        >
          {item.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .context-menu {
    /* 与菜单下拉/弹窗/诊断浮层共用「弹出来的面板」配色（--panel-*，定义在 +page.svelte 的
       `:root` 与 `.app.light`）。做法同 MenuBar 下拉：就地重绑主题变量 + 面板自己的 color。 */
    --border: var(--panel-border);
    --fg: var(--panel-fg);
    --fg-dim: var(--panel-fg-dim);
    --accent: var(--panel-accent);
    position: fixed;
    z-index: 150; /* 高于 MenuBar 下拉(50)，低于弹窗遮罩(200) */
    min-width: 160px;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    box-shadow: var(--panel-shadow);
    color: var(--panel-fg);
    padding: 4px;
    display: flex;
    flex-direction: column;
    user-select: none;
  }

  .menu-item {
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    font-family: inherit;
  }

  .menu-item:hover {
    background: var(
      --panel-hover-bg
    ); /* 浅蓝底 + 蓝字：与菜单下拉的悬停一致（白底上用蓝底白字不清楚） */
    color: var(--panel-hover-fg);
  }

  .menu-item:disabled {
    color: var(--fg-dim);
    cursor: default;
  }

  .menu-item:disabled:hover {
    background: transparent;
    color: var(--fg-dim);
  }

  .menu-separator {
    height: 1px;
    margin: 4px 8px;
    background: var(--border);
  }
</style>
