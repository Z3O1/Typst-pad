<script lang="ts">
  import { onMount } from "svelte";

  export interface MenuItem {
    label: string;
    action: () => void;
    checked?: boolean;
  }

  export interface MenuGroup {
    label: string;
    accessKey?: string; // 菜单栏选中态下按此字母跳转/展开，如 文件(F) 的 F
    items: MenuItem[];
  }

  let {
    groups,
    onMenuFocusChange,
  }: {
    groups: MenuGroup[];
    onMenuFocusChange?: (focused: boolean) => void;
  } = $props();

  let openIndex: number | null = $state(null); // 展开的菜单（键盘/点击）
  let selectedIndex: number | null = $state(null); // 键盘选中的分类（Alt 激活）
  let rootEl: HTMLElement;

  function toggle(i: number) {
    openIndex = openIndex === i ? null : i;
    selectedIndex = i;
  }

  function runAction(item: MenuItem) {
    openIndex = null;
    if (selectedIndex !== null) {
      // 动作执行后菜单不再处于选中态，通知外部恢复编辑器光标
      selectedIndex = null;
      onMenuFocusChange?.(false);
    }
    item.action();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Alt") {
      if (e.repeat) return; // 长按 Alt 的重复 keydown 不应反复切换选中态
      // Alt 按下：切换菜单栏选中态。未选中 → 选中第一个分类（编辑器失焦）；
      // 已选中 → 取消选中（恢复编辑器光标）。
      e.preventDefault();
      if (selectedIndex === null) {
        selectedIndex = 0;
        openIndex = null;
        onMenuFocusChange?.(true);
      } else {
        selectedIndex = null;
        openIndex = null;
        onMenuFocusChange?.(false);
      }
      return;
    }
    if (selectedIndex === null) return;

    // 字母 accessKey：跳转到对应选项卡；按当前已选中选项卡的字母则直接展开
    if (!e.ctrlKey && !e.metaKey && e.key.length === 1) {
      const ch = e.key.toLowerCase();
      const match = groups.findIndex((g) => g.accessKey?.toLowerCase() === ch);
      if (match !== -1) {
        e.preventDefault();
        if (match === selectedIndex) {
          openIndex = match; // 已选中该选项卡：直接展开
        } else {
          selectedIndex = match;
          openIndex = null;
        }
        return;
      }
    }

    if (e.key === " " || e.key === "Enter") {
      // 空格/Enter：展开/收起选中的分类
      e.preventDefault();
      openIndex = openIndex === selectedIndex ? null : selectedIndex;
    } else if (e.key === "Escape") {
      // Esc：先取消展开（保留选中），再按取消选中（恢复编辑器光标）
      e.preventDefault();
      if (openIndex !== null) openIndex = null;
      else {
        selectedIndex = null;
        onMenuFocusChange?.(false);
      }
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

  function onWindowBlur() {
    // 窗口失焦（如 Alt+Tab 切走）：清空展开与选中态，恢复编辑器光标
    if (selectedIndex === null && openIndex === null) return;
    selectedIndex = null;
    openIndex = null;
    onMenuFocusChange?.(false);
  }

  function onClickOutside(e: MouseEvent) {
    // mousedown 在菜单栏外部：关闭下拉并退出选中态（恢复编辑器光标）。
    // 菜单项按钮都在 rootEl 内部，不会被误判为外部，不干扰 click 的 runAction 流程。
    if (rootEl && !rootEl.contains(e.target as Node)) {
      openIndex = null;
      if (selectedIndex !== null) {
        selectedIndex = null;
        onMenuFocusChange?.(false);
      }
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("blur", onWindowBlur);
    };
  });
</script>

<nav
  class="menubar"
  class:menu-selected={selectedIndex !== null}
  bind:this={rootEl}
  aria-label="主菜单"
>
  {#each groups as group, i (group.label)}
    <div class="menu">
      <button
        class="menu-title"
        class:active={openIndex === i}
        class:selected={selectedIndex === i}
        onclick={() => toggle(i)}
        onmouseenter={() => {
          if (openIndex !== null) openIndex = i; // 已展开时悬停切换
        }}
      >
        {group.label}{#if group.accessKey} (<span class="access-key">{group.accessKey}</span>){/if}
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
    padding: 2px 10px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
  }

  .menu-title:hover,
  .menu-title.active,
  .menu-title.selected {
    background: var(--bg-pane);
  }

  /* 选中态（Alt 激活）：全部标题括号内字母加下划线（Windows 菜单风格） */
  .menubar.menu-selected .access-key {
    text-decoration: underline;
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
