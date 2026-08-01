<script lang="ts">
  import { onMount } from "svelte";

  export interface MenuItem {
    label: string;
    action: () => void;
    checked?: boolean;
  }

  export interface MenuGroup {
    label: string;
    items: MenuItem[];
  }

  let { groups }: { groups: MenuGroup[] } = $props();

  let openIndex: number | null = $state(null); // 展开的菜单（键盘/点击）
  let selectedIndex: number | null = $state(null); // 键盘选中的分类（Alt 激活）
  let rootEl: HTMLElement;

  function toggle(i: number) {
    openIndex = openIndex === i ? null : i;
    selectedIndex = i;
  }

  function runAction(item: MenuItem) {
    openIndex = null;
    selectedIndex = null;
    item.action();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Alt") {
      // Alt 按下：选中第一个分类（不展开）；再次按 Alt 无额外效果
      e.preventDefault();
      selectedIndex = selectedIndex ?? 0;
      openIndex = null;
      return;
    }
    if (selectedIndex === null) return;

    if (e.key === " " || e.key === "Enter") {
      // 空格/Enter：展开/收起选中的分类
      e.preventDefault();
      openIndex = openIndex === selectedIndex ? null : selectedIndex;
    } else if (e.key === "Escape") {
      // Esc：先取消展开（保留选中），再按取消选中
      e.preventDefault();
      if (openIndex !== null) openIndex = null;
      else selectedIndex = null;
    } else if (e.key === "Tab") {
      // Tab：循环切换选中的分类
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % groups.length;
      openIndex = null;
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // 左右方向键：切换选中的分类
      e.preventDefault();
      selectedIndex =
        (selectedIndex + (e.key === "ArrowRight" ? 1 : -1) + groups.length) %
        groups.length;
      openIndex = null;
    }
  }

  function onClickOutside(e: MouseEvent) {
    if (rootEl && !rootEl.contains(e.target as Node)) {
      openIndex = null;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("click", onClickOutside);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("click", onClickOutside);
    };
  });
</script>

<nav class="menubar" bind:this={rootEl} aria-label="主菜单">
  {#each groups as group, i (group.label)}
    <div class="menu">
      <button
        class="menu-title"
        class:active={openIndex === i}
        class:selected={selectedIndex === i}
        onclick={() => toggle(i)}
        onmouseenter={() => {
          // 已展开时悬停切换；同步选中态保持一致
          if (openIndex !== null) {
            openIndex = i;
            selectedIndex = i;
          }
        }}
      >
        {group.label}
      </button>
      {#if openIndex === i}
        <div class="menu-dropdown" role="menu">
          {#each group.items as item (item.label)}
            <button
              class="menu-item"
              class:checked={item.checked}
              role="menuitem"
              onclick={() => runAction(item)}
            >
              {item.label}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  /* 文本式菜单栏：占满所在行（flex:1 由父级或此处控制），无按钮边框感 */
  .menubar {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    padding-left: 4px; /* 传统菜单栏：首项距左侧少量留白 */
    user-select: none;
  }

  .menu {
    position: relative;
  }

  .menu-title {
    padding: 3px 10px; /* 紧凑：上下 3px，降低菜单栏高度 */
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  /* 平时（未按 Alt）悬停不高亮：仅 Alt 激活选中（.selected）或展开中（.active）时高亮 */
  .menu-title.active,
  .menu-title.selected {
    background: var(--bg-pane);
  }

  .menu-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 180px;
    background: var(--bg-toolbar);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    padding: 4px;
    z-index: 50;
    display: flex;
    flex-direction: column;
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
  }

  .menu-item:hover {
    background: var(--accent);
    color: #ffffff;
  }

  .menu-item.checked {
    color: var(--accent);
  }

  .menu-item.checked:hover {
    color: #ffffff;
  }
</style>
