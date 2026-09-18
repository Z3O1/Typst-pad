// 菜单栏的**数据模型**（从 +page.svelte 的 `menuGroups()` 原样搬出来，行为零改动）。
//
// 抽出来的理由：菜单是"用户唯一能看见的命令表"，里面藏着几条踩过的红线
// （`Ctrl+E` 是模式切换而不是 `Ctrl+/`；带 Shift 的组合键匹配器不认、只作灰字提示；
// 每项的 `checked` 必须跟随状态），这些以前只能靠在真机上点菜单来保证。
// 现在它是纯函数：给状态 + 回调，出菜单表，可以在单测里逐项断言。
//
// 类型定义在这里（而不是从 MenuBar.svelte 反向导入）是照 menu-keys.ts 的 `MenuGroupLike`
// 的做法来的：.ts 模块不依赖 .svelte 的类型，`MenuBar.svelte` 反过来 extends 它们。

import type { WriteCommand } from "./write-commands";
import { ZOOM_DEFAULT } from "./zoom";

/** 菜单项（MenuBar.svelte 消费的结构） */
export interface MenuModelItem {
  label: string;
  action: () => void;
  checked?: boolean;
  /** 快捷键显示文本（如 "Ctrl+N"），同时供全局 Ctrl/Meta 组合键匹配 */
  shortcut?: string;
}

/** 菜单分类（MenuBar.svelte 消费的结构） */
export interface MenuModelGroup {
  label: string;
  /** 菜单栏选中态下按此字母跳转/展开，如 文件(F) 的 F */
  accessKey?: string;
  items: MenuModelItem[];
}

export type MenuViewMode = "write" | "source";
export type MenuTheme = "system" | "dark" | "light";

/** 构建菜单表需要的一切：5 个状态字段 + 各命令的回调（回调由页面提供，这里只摆位置） */
export interface MenuModelDeps {
  viewMode: MenuViewMode;
  showPreview: boolean;
  editorWrap: boolean;
  uiZoom: number;
  theme: MenuTheme;

  onNew(): void;
  onNewWindow(): void;
  onOpen(): void;
  onSave(): void;
  onOpenSettings(): void;
  onExportPdf(): void;
  runFormat(command: WriteCommand): void;

  onToggleViewMode(): void;
  onTogglePreview(): void;
  onToggleWrap(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onResetZoom(): void;
  onSetTheme(theme: MenuTheme): void;

  onCheckUpdates(): void;
  onShowAbout(): void;
}

/** 菜单表：文件 / 格式 / 视图 / 帮助（顺序即菜单栏顺序） */
export function buildMenuGroups(deps: MenuModelDeps): MenuModelGroup[] {
  return [
    {
      label: "文件",
      accessKey: "F",
      items: [
        // shortcut 同时是菜单项右侧灰字显示与全局 Ctrl/Meta 组合键的触发来源（MenuBar 统一处理）
        { label: "新建", shortcut: "Ctrl+N", action: deps.onNew },
        {
          // 带 Shift 的组合键 MenuBar 的匹配器不认（见 menu-keys.shortcutMatches 排除 Shift），
          // 所以这里只是把姿势当灰字提示显示出来，真正的触发在 handleKeydown → openNewWindow
          label: "新建窗口",
          shortcut: "Ctrl+Shift+N",
          action: deps.onNewWindow,
        },
        { label: "打开…", shortcut: "Ctrl+O", action: deps.onOpen },
        { label: "保存", shortcut: "Ctrl+S", action: deps.onSave },
        { label: "设置…", shortcut: "Ctrl+,", action: deps.onOpenSettings },
        { label: "导出 PDF…", shortcut: "Ctrl+P", action: deps.onExportPdf },
      ],
    },
    {
      label: "格式",
      accessKey: "O",
      items: [
        { label: "加粗", shortcut: "Ctrl+B", action: () => deps.runFormat("bold") },
        { label: "斜体", shortcut: "Ctrl+I", action: () => deps.runFormat("italic") },
        { label: "行内代码", shortcut: "Ctrl+Shift+`", action: () => deps.runFormat("code") },
        { label: "行内公式", shortcut: "Ctrl+M", action: () => deps.runFormat("math-inline") },
        { label: "公式块", shortcut: "Ctrl+Shift+M", action: () => deps.runFormat("math-block") },
        { label: "标题 1", shortcut: "Ctrl+1", action: () => deps.runFormat("heading1") },
        { label: "标题 2", shortcut: "Ctrl+2", action: () => deps.runFormat("heading2") },
        { label: "标题 3", shortcut: "Ctrl+3", action: () => deps.runFormat("heading3") },
        { label: "正文", shortcut: "Ctrl+0", action: () => deps.runFormat("body") },
        { label: "无序列表", shortcut: "Ctrl+Shift+]", action: () => deps.runFormat("bullet") },
        { label: "有序列表", shortcut: "Ctrl+Shift+[", action: () => deps.runFormat("ordered") },
        { label: "引用", shortcut: "Ctrl+Shift+Q", action: () => deps.runFormat("quote") },
        { label: "代码块", shortcut: "Ctrl+Shift+C", action: () => deps.runFormat("code-block") },
        { label: "链接", shortcut: "Ctrl+K", action: () => deps.runFormat("link") },
      ],
    },
    {
      label: "视图",
      accessKey: "V",
      items: [
        {
          label: "源代码模式",
          // 键位：**模式切换用 Ctrl+E**（2026-09-18 用户要求）。
          // 原来挂的是 Ctrl+/（Typora 的习惯），但那一按会**同时**做两件事：编辑器的 CM keymap
          // 处理 `Mod-/` 只 preventDefault、不阻断冒泡，而这里（MenuBar 的 window 级匹配）不看
          // defaultPrevented ⇒ 按一次既注释又切模式。Ctrl+/ 现在只归注释（VS Code 习惯）。
          shortcut: "Ctrl+E",
          checked: deps.viewMode === "source",
          action: deps.onToggleViewMode,
        },
        {
          label: "显示预览栏",
          checked: deps.showPreview,
          action: deps.onTogglePreview,
        },
        {
          label: "自动换行",
          // 同样只是灰字提示（MenuBar 的匹配器只认「Ctrl+单键」，不会命中 Alt+Z）；
          // 真正的触发在 +page.svelte 的 handleKeydown 里
          shortcut: "Alt+Z",
          checked: deps.editorWrap,
          action: deps.onToggleWrap,
        },
        {
          label: "放大",
          // 灰字提示：Ctrl+滚轮 是手势（写不进快捷键匹配），Ctrl+Shift+= 是这一对键盘键里的"加"
          shortcut: "Ctrl+滚轮 / Ctrl+Shift+=",
          action: deps.onZoomIn,
        },
        {
          label: "缩小",
          shortcut: "Ctrl+Shift+-",
          action: deps.onZoomOut,
        },
        {
          label: "重置缩放",
          checked: deps.uiZoom === ZOOM_DEFAULT,
          action: deps.onResetZoom,
        },
        {
          label: "主题：自动",
          checked: deps.theme === "system",
          action: () => deps.onSetTheme("system"),
        },
        {
          label: "主题：暗",
          checked: deps.theme === "dark",
          action: () => deps.onSetTheme("dark"),
        },
        {
          label: "主题：明",
          checked: deps.theme === "light",
          action: () => deps.onSetTheme("light"),
        },
      ],
    },
    {
      label: "帮助",
      accessKey: "H",
      items: [
        { label: "检查更新…", action: deps.onCheckUpdates },
        { label: "关于 Typst-pad", action: deps.onShowAbout },
      ],
    },
  ];
}
