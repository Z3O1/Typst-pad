// 自定义右键菜单的纯逻辑模块：右键区域判定、菜单项 enabled 计算、弹出位置收边。
// 与 DOM/组件解耦（依赖以参数注入），便于单元测试；
// 菜单 UI 与事件绑定在 ContextMenu.svelte，命令到执行函数的映射在 +page.svelte。

/**
 * 右键命中区域：
 * - editor / preview：编辑器、预览区，弹自定义菜单；
 * - chrome：顶部菜单栏/底部状态栏等程序框架区，右键无效果（自定义菜单与浏览器
 *   原生菜单均不弹，见 +page.svelte 的 handleContextMenu）；
 * - other：其余区域，保持浏览器原生菜单。
 */
export type ContextZone = "editor" | "preview" | "chrome" | "other";

/** 菜单项对应的命令（由调用方映射到具体执行函数，避免纯逻辑依赖 DOM 与异步操作） */
export type ContextMenuCommand =
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "save"
  | "export-pdf"
  | "settings"
  | "open";

/** 菜单项描述：不含 onClick，enabled 已按区域与选区状态算好 */
export interface ContextMenuItemSpec {
  type: "item" | "separator";
  label?: string;
  command?: ContextMenuCommand;
  disabled?: boolean;
}

/**
 * 按 event target 判断右键所属区域：
 * - target 位于 .cm-content 或其祖先 .editor-host 内 → editor（覆盖行号栏等 CM 附属区域）；
 * - target 位于带 data-context-zone="preview" 的容器内 → preview；
 * - target 位于 .toolbar（顶部菜单栏，含展开的下拉菜单）或 .statusbar（底部状态栏，
 *   含错误徽标/错误 Popover）内 → chrome，右键无效果；
 * - 其余（弹窗遮罩等）→ other，保持原生菜单。
 * 判定顺序：chrome 检查放在 editor/preview 之后。三者元素互不嵌套（工具栏在 header、
 * 编辑/预览在主区、状态栏在 footer），顺序不影响命中结果，仅需在兜底返回 other 前
 * 把 chrome 检查补上即可。
 */
export function resolveContextZone(target: EventTarget | null): ContextZone {
  if (!(target instanceof Node)) return "other";
  const el = target instanceof Element ? target : target.parentElement;
  if (!el) return "other";
  if (el.closest(".cm-content, .editor-host")) return "editor";
  if (el.closest('[data-context-zone="preview"]')) return "preview";
  if (el.closest(".toolbar, .statusbar")) return "chrome";
  return "other";
}

/**
 * 编辑器是否存在非空选区。
 * 入参为 CodeMirror 的 selection 主选区（{ empty }）：基于 CM6 state 而非原生
 * selection，多光标/编辑器未聚焦时依然准确。
 */
export function editorSelectionHasContent(sel: { empty: boolean } | null): boolean {
  return sel !== null && !sel.empty;
}

/**
 * 预览区是否存在非空选区：选区必须落在预览容器内。
 * 编辑器持有时原生 selection 也在页面上，若不限定容器会把编辑器的选区误算进预览。
 */
export function previewSelectionHasContent(
  sel: { isCollapsed: boolean; anchorNode: Node | null } | null,
  host: Node | null,
): boolean {
  if (!sel || sel.isCollapsed) return false;
  if (!sel.anchorNode || !host) return false;
  return host.contains(sel.anchorNode);
}

/**
 * 生成某区域右键菜单的完整条目（含分隔线与应用操作）：
 * - 编辑器：剪切/复制随选区 enabled，粘贴/全选始终可用；
 * - 预览区：剪切/粘贴恒置灰（不可编辑），复制随预览选区 enabled，全选始终可用；
 * - 两区均附「保存 / 导出 PDF… / 设置… / 打开…」应用操作。
 */
export function buildContextMenuItems(
  zone: "editor" | "preview",
  hasSelection: boolean,
): ContextMenuItemSpec[] {
  const editItems: ContextMenuItemSpec[] =
    zone === "editor"
      ? [
          { type: "item", label: "剪切", command: "cut", disabled: !hasSelection },
          { type: "item", label: "复制", command: "copy", disabled: !hasSelection },
          { type: "item", label: "粘贴", command: "paste", disabled: false },
          { type: "item", label: "全选", command: "select-all", disabled: false },
        ]
      : [
          { type: "item", label: "剪切", command: "cut", disabled: true },
          { type: "item", label: "复制", command: "copy", disabled: !hasSelection },
          { type: "item", label: "粘贴", command: "paste", disabled: true },
          { type: "item", label: "全选", command: "select-all", disabled: false },
        ];
  const appItems: ContextMenuItemSpec[] = [
    { type: "item", label: "保存", command: "save", disabled: false },
    { type: "item", label: "导出 PDF…", command: "export-pdf", disabled: false },
    { type: "item", label: "设置…", command: "settings", disabled: false },
    { type: "item", label: "打开…", command: "open", disabled: false },
  ];
  return [...editItems, { type: "separator" }, ...appItems];
}

/**
 * 计算菜单弹出位置：以鼠标坐标为准，超出视口时自动收边（保留 margin 边距）。
 * 纯函数便于单测；实际尺寸由组件在 DOM 就绪后测量传入。
 */
export function computeMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  margin = 4,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin));
  const top = Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin));
  return { left, top };
}
