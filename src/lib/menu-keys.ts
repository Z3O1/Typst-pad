// 菜单栏按键决策纯函数：把「按下哪个键应做什么」从 MenuBar.svelte 抽出，
// 便于单元测试（键盘语义不依赖 DOM 与 Svelte 运行时）。
// 决策只返回动作类型与目标，具体状态变更 / 焦点恢复仍由 MenuBar 执行。
//
// 决策顺序（对应 MenuBar.onKeydown 的需求约束）：
// 1. Alt：切换菜单选中态（长按重复不响应）；
// 2. Ctrl/Meta 组合键：全局菜单快捷键（#3），先于退出判断处理，未命中不退出选择；
// 3. 选中态下：accessKey 字母 / 空格 / Enter / Esc / Tab / 方向键；
// 4. 其余按键（数字、标点、非 accessKey 字母等）→ 退出选择（#2）。

/** 按键事件结构子集（与 KeyboardEvent 同形，测试可直接构造） */
export interface MenuKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

/** 菜单分类结构子集：决策只需 accessKey 与项内 shortcut（与 MenuGroup/MenuItem 结构兼容） */
export interface MenuGroupLike {
  accessKey?: string;
  items: Array<{ shortcut?: string }>;
}

/** 按键决策结果：MenuBar 据此执行状态变更，并按需 preventDefault */
export type MenuKeyDecision =
  | { type: "ignored" } // 不处理：无选中态 / Alt 长按重复 / 未命中菜单项的组合键
  | { type: "alt-toggle"; selected: boolean } // Alt：切换菜单选中态
  | { type: "shortcut"; group: number; item: number } // Ctrl/Meta 组合键命中菜单项快捷键
  | { type: "accesskey"; index: number; expand: boolean } // accessKey 字母：跳转 / 展开
  | { type: "toggle" } // 空格 / Enter：展开收起
  | { type: "escape" } // Esc：先收起下拉再退出选中
  | { type: "next" } // Tab / →：下一分类
  | { type: "prev" } // ←：上一分类
  | { type: "exit" }; // 其余按键：退出选中态（不 preventDefault）

/** 决策输入：当前菜单状态 + 分类结构 */
export interface MenuKeyState {
  selectedIndex: number | null;
  groups: MenuGroupLike[];
}

/** 解析菜单项快捷键文本（当前支持 "Ctrl+X" 形式）→ 归一化匹配条件 */
export interface ParsedShortcut {
  key: string; // 归一化小写（字母 / 标点，如 "n"、","）
}

export function parseShortcut(text: string): ParsedShortcut | null {
  const m = /^Ctrl\+(.+)$/.exec(text);
  if (!m) return null;
  return { key: m[1].toLowerCase() };
}

/** 组合键是否命中某快捷键：Ctrl 或 Meta 修饰、无 Alt / Shift（Shift 视为不同快捷键） */
export function shortcutMatches(parsed: ParsedShortcut, e: MenuKeyEvent): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === parsed.key;
}

/** 在所有菜单项中查找命中当前组合键的第一项（按菜单顺序） */
export function findShortcutTarget(
  groups: MenuGroupLike[],
  e: MenuKeyEvent,
): { group: number; item: number } | null {
  for (let g = 0; g < groups.length; g++) {
    for (let i = 0; i < groups[g].items.length; i++) {
      const text = groups[g].items[i].shortcut;
      if (!text) continue;
      const parsed = parseShortcut(text);
      if (parsed && shortcutMatches(parsed, e)) return { group: g, item: i };
    }
  }
  return null;
}

export function decideMenuKey(e: MenuKeyEvent, s: MenuKeyState): MenuKeyDecision {
  // Alt：切换菜单选中态（长按的重复 keydown 不响应）
  if (e.key === "Alt") {
    if (e.repeat) return { type: "ignored" };
    return { type: "alt-toggle", selected: s.selectedIndex !== null };
  }
  // Ctrl/Meta 组合键：全局菜单快捷键（#3），先于选中态判断与退出判断。
  // 未命中任何菜单项的组合键保持忽略：不退出选择、不 preventDefault（事件自然结束）。
  if (e.ctrlKey || e.metaKey) {
    if (e.repeat) return { type: "ignored" }; // 长按组合键不重复触发动作
    const target = findShortcutTarget(s.groups, e);
    if (target !== null) return { type: "shortcut", group: target.group, item: target.item };
    return { type: "ignored" };
  }
  // 无选中态：普通按键一律不处理（交回编辑器 / 浏览器）
  if (s.selectedIndex === null) return { type: "ignored" };

  // accessKey 字母：跳转到对应分类；按当前已选中分类的字母则直接展开
  if (e.key.length === 1) {
    const ch = e.key.toLowerCase();
    const match = s.groups.findIndex((g) => g.accessKey?.toLowerCase() === ch);
    if (match !== -1) {
      return { type: "accesskey", index: match, expand: match === s.selectedIndex };
    }
  }
  if (e.key === " " || e.key === "Enter") return { type: "toggle" };
  if (e.key === "Escape") return { type: "escape" };
  if (e.key === "Tab" || e.key === "ArrowRight") return { type: "next" };
  if (e.key === "ArrowLeft") return { type: "prev" };
  // #2 退出规则：其余按键（数字、标点、非 accessKey 字母等）退出选中态
  return { type: "exit" };
}
