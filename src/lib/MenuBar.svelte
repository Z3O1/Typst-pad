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

  let openIndex: number | null = $state(null);
  let rootEl: HTMLElement;

  function toggle(i: number) {
    openIndex = openIndex === i ? null : i;
  }

  function runAction(item: MenuItem) {
    openIndex = null;
    item.action();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      openIndex = null;
    } else if (e.key === "Alt") {
      // Alt 按下：打开/聚焦第一个菜单（阻止系统菜单）
      e.preventDefault();
      openIndex = openIndex ?? 0;
    } else if (openIndex !== null) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        openIndex = (openIndex + 1) % groups.length;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        openIndex = (openIndex - 1 + groups.length) % groups.length;
      }
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
        onclick={() => toggle(i)}
        onmouseenter={() => {
          if (openIndex !== null) openIndex = i; // 已展开时悬停切换
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
  .menubar {
    display: flex;
    align-items: center;
    gap: 2px;
    user-select: none;
  }

  .menu {
    position: relative;
  }

  .menu-title {
    padding: 4px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  .menu-title:hover,
  .menu-title.active {
    background: var(--bg-pane);
    outline: 1px solid var(--border);
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
