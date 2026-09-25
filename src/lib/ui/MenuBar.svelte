<script lang="ts">
  import { onMount } from "svelte";
  import { decideMenuKey } from "./menu-keys";
  // 菜单表的结构定义在 menu-model.ts（那份表由 buildMenuGroups 纯函数产出，可单测）。
  // 这里保留 MenuBar 原有的 `export interface` 用法，语义不变。
  import type { MenuModelGroup, MenuModelItem } from "./menu-model";

  export interface MenuItem extends MenuModelItem {}

  export interface MenuGroup extends MenuModelGroup {}

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

  /**
   * 关闭当前展开/选中的菜单（供右键菜单等外部入口联动收起）。
   * 不依赖 mousedown 外部关闭监听：右键弹出自定义菜单不产生 mousedown 事件，
   * 需要在打开前显式调用，避免两个菜单叠加显示。
   */
  export function closeMenus(): void {
    if (selectedIndex === null && openIndex === null) return;
    selectedIndex = null;
    openIndex = null;
    onMenuFocusChange?.(false);
  }

  function onKeydown(e: KeyboardEvent) {
    // 按键决策抽在 menu-keys.ts（纯函数，可单测）；这里只负责执行状态变更
    const decision = decideMenuKey(e, { selectedIndex, groups });
    switch (decision.type) {
      case "ignored":
        return;
      case "alt-toggle": {
        // Alt 按下：切换菜单栏选中态。未选中 → 选中第一个分类；已选中 → 取消选中。
        // **不再让编辑器失焦**（用户反馈"不要改变当前编辑位置"）：编辑器全程保持焦点与光标，
        // 菜单栏只靠 window 上的 keydown 工作，不需要 DOM 焦点（见 +page.svelte handleMenuFocusChange）。
        e.preventDefault();
        if (decision.selected) {
          selectedIndex = null;
          openIndex = null;
          onMenuFocusChange?.(false);
        } else {
          selectedIndex = 0;
          openIndex = null;
          onMenuFocusChange?.(true);
        }
        return;
      }
      case "shortcut": {
        // Ctrl/Meta 组合键命中菜单项快捷键：触发动作并收起菜单（#3）
        const item = groups[decision.group].items[decision.item];
        e.preventDefault();
        runAction(item);
        return;
      }
      case "accesskey": {
        // 字母 accessKey：跳转到对应选项卡；按当前已选中选项卡的字母则直接展开
        e.preventDefault();
        if (decision.expand) {
          openIndex = decision.index; // 已选中该选项卡：直接展开
        } else {
          selectedIndex = decision.index;
          openIndex = null;
        }
        return;
      }
      case "toggle": {
        // 空格/Enter：展开/收起选中的分类
        e.preventDefault();
        openIndex = openIndex === selectedIndex ? null : selectedIndex;
        return;
      }
      case "escape": {
        // Esc：先取消展开（保留选中），再按取消选中（恢复编辑器光标）
        e.preventDefault();
        if (openIndex !== null) openIndex = null;
        else {
          selectedIndex = null;
          onMenuFocusChange?.(false);
        }
        return;
      }
      case "next":
      case "prev": {
        // Tab / 方向键左右：循环切换选中的分类
        e.preventDefault();
        const cur = selectedIndex ?? 0;
        selectedIndex = (cur + (decision.type === "next" ? 1 : -1) + groups.length) % groups.length;
        openIndex = null;
        return;
      }
      case "exit": {
        // #2 退出规则：数字、标点、非 accessKey 字母等按键 → 退出选中态。
        // 不 preventDefault：编辑器保持焦点，这个按键就正常输入到文档里（不会像以前那样被吞掉）。
        selectedIndex = null;
        openIndex = null;
        onMenuFocusChange?.(false);
        return;
      }
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
        {group.label}{#if group.accessKey}
          (<span class="access-key">{group.accessKey}</span>){/if}
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
              <span class="menu-item-label">{item.label}</span>
              {#if item.shortcut}
                <span class="menu-item-shortcut">{item.shortcut}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  /* 文本式菜单栏：内容宽不拉伸、贴窗口左边界无留白，无按钮边框感 */
  .menubar {
    display: flex;
    align-items: center;
    min-width: 0;
    padding-left: 0; /* 贴边：首项直接顶到窗口左边界 */
    user-select: none;
  }

  .menu {
    position: relative;
  }

  .menu-title {
    padding: 2px 6px;
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

  /* 展开菜单：与右键菜单 / 弹窗 / 诊断浮层共用「弹出来的面板」配色（--panel-*，
     定义在 +page.svelte 的 `:root` 与 `.app.light`）。**跟随主题**：深色主题深面板 + 浅字，
     浅色主题白面板 + 深字（2026-09-26 改，此前固定白色）。这里只把主题变量就地重绑，
     子元素（.menu-item / .menu-item-shortcut）自动跟着走。
     阴影也走 --panel-shadow：深色面板要重一点，白面板要浅（否则白块边缘发黑）。 */
  .menu-dropdown {
    --menu-bg: var(--panel-bg);
    --menu-fg: var(--panel-fg);
    --menu-fg-dim: var(--panel-fg-dim);
    --menu-hover-bg: var(--panel-hover-bg);
    --menu-hover-fg: var(--panel-hover-fg);
    --menu-hover-dim: var(--panel-hover-dim); /* 悬停时的快捷键灰字 */
    color: var(--panel-fg); /* 面板自己的字色——不写这条会继承 `.app` 的字色，与面板底色不是一对 */
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 180px;
    background: var(--menu-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    box-shadow: var(--panel-shadow);
    padding: 4px;
    z-index: 50;
    display: flex;
    flex-direction: column;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--menu-fg);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .menu-item:hover {
    background: var(--menu-hover-bg);
    color: var(--menu-hover-fg);
  }

  .menu-item.checked {
    color: var(--menu-hover-fg);
  }

  .menu-item.checked:hover {
    color: var(--menu-hover-fg);
  }

  /* 快捷键灰字：与标签左右分布（Windows 菜单风格）；悬停时压成偏蓝的灰，仍在蓝色标签之下 */
  .menu-item-shortcut {
    color: var(--menu-fg-dim);
    font-size: 12px;
  }

  .menu-item:hover .menu-item-shortcut {
    color: var(--menu-hover-dim);
  }
</style>
