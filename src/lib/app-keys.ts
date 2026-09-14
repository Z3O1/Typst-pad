// 页面级快捷键的**路由决策**（纯函数，可单测）：把"按下哪个键该做什么"从 +page.svelte 抽出，
// 与 menu-keys.ts / word-wrap.ts 同样的理由——键盘语义不该依赖 DOM 与 Svelte 运行时。
//
// **这里是踩过的坑的所在地**：`Ctrl+Shift+N`（新建窗口）曾被"Shift 组合的格式表"整段吞掉。
// 旧代码在格式表那一支里对**任何**带 Shift 的组合都无条件 return，而新建窗口的判定排在它后面，
// 于是那条路从 0.7.0（仿 Typora 两套 UI 引入格式表）起就再也没触发过 —— 2026-09-14 用户报
// 「Ctrl+Shift+N 新建窗口」没反应就是这个。**判定顺序本身就是行为的一部分**，所以顺序写死在
// decideAppKey 里，并用单测锁住："新窗口必须排在格式表前面"。

import type { WrapKeyEvent } from "./word-wrap";
import { isWrapToggleKey } from "./word-wrap";
import type { WriteCommand } from "./write-commands";

/** 打开中的弹窗（Esc 的收件人） */
export type AppModal = "close-prompt" | "update" | "settings" | "about";

/** Esc 的收件人优先级（数组顺序 = 叠放优先级）：关闭确认最"上层"（它挡着关窗），其次更新弹窗、设置、关于 */
export const MODAL_PRIORITY: readonly AppModal[] = ["close-prompt", "update", "settings", "about"];

/** 决策输入：按键事件 + 页面当前状态 */
export interface AppKeyState {
  /** 当前有文件路径：`Ctrl+R` 只在有文件时拦（没有文件时放行给浏览器刷新，保持旧行为） */
  hasFilePath: boolean;
  /** 打开中的弹窗（无 = null）：Esc 只关它，不做别的 */
  openModal: AppModal | null;
}

/** 决策结果：由 +page.svelte 执行并决定是否 preventDefault */
export type AppKeyAction =
  | { type: "wrap-toggle" } // Alt+Z：源码模式自动换行开关
  | { type: "format"; command: WriteCommand } // Ctrl+Shift+<键>：格式命令
  | { type: "reload-file" } // Ctrl+R：重新读取当前文件
  | { type: "new-window" } // Ctrl+Shift+N：新建窗口
  | { type: "close-window" } // Ctrl+W：关闭当前窗口
  | { type: "dismiss-modal"; modal: AppModal }; // Esc：关掉最上层的弹窗

/**
 * Shift 组合的格式快捷键（Typora 习惯；菜单里以同样的文字展示，见 menuGroups 的「格式」）。
 * MenuBar 的匹配器只认「Ctrl+单键」（见 menu-keys.shortcutMatches 排除 Shift），所以这一张表
 * 由页面侧处理，不会和菜单的全局快捷键双重触发。
 */
export const SHIFT_FORMAT_COMMANDS: Readonly<Record<string, WriteCommand>> = {
  "`": "code",
  m: "math-block",
  "]": "bullet",
  "[": "ordered",
  q: "quote",
  c: "code-block",
};

/** 打开中的弹窗里最"上层"的那个（Esc 关它）；都没开则 null */
export function topModal(open: Partial<Record<AppModal, boolean>>): AppModal | null {
  return MODAL_PRIORITY.find((m) => open[m] === true) ?? null;
}

/**
 * 按键 → 动作。返回 null = 本页不处理（交回编辑器 / 浏览器 / 系统）。
 *
 * 判定顺序（改动前先读完这一段的理由）：
 * 1. **Esc**：只关最上层的弹窗（哪怕同时按着 Ctrl）。弹窗开着时按 Esc 不该触发任何编辑类动作。
 * 2. **Alt+Z**：自动换行开关。它没有 Ctrl/Meta，必须排在任何 `mod` 门之前（见 word-wrap）。
 * 3. **Ctrl/Cmd 门**：没有 Ctrl/Meta 一律不处理。
 * 4. **Ctrl+Shift+N**：新建窗口。**必须在格式表之前**——格式表那一支对 Shift 组合会 return。
 * 5. **Ctrl+Shift+<键>**：格式命令；表里没有的组合不处理（不抢系统的 Shift 手势）。
 * 6. **Ctrl+R / Ctrl+W**：重读文件 / 关窗。
 *
 * 注：Alt 修饰不参与判定（`Ctrl+Alt+R` 之类的怪组合按旧行为同样会触发），改动这里等于改行为，别顺手。
 */
export function decideAppKey(e: WrapKeyEvent, state: AppKeyState): AppKeyAction | null {
  if (e.key === "Escape") {
    return state.openModal ? { type: "dismiss-modal", modal: state.openModal } : null;
  }
  if (isWrapToggleKey(e)) return { type: "wrap-toggle" };
  if (!(e.ctrlKey || e.metaKey)) return null;

  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    // **新建窗口必须排在格式表之前**（见文件头注释：曾经因为顺序反了而彻底失效）
    if (key === "n") return { type: "new-window" };
    const command = SHIFT_FORMAT_COMMANDS[key];
    return command ? { type: "format", command } : null;
  }
  if (key === "r") return state.hasFilePath ? { type: "reload-file" } : null;
  if (key === "w") return { type: "close-window" };
  return null;
}
