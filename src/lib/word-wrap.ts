// 源码模式「自动换行」开关的纯逻辑：Alt+Z 切换（VS Code 同款手势）。
// 与 menu-keys.ts 同样的理由抽成纯函数：键盘语义不该依赖 DOM 与 Svelte 运行时，便于单测。

/** 按键事件结构子集（与 KeyboardEvent 同形，测试可直接构造） */
export interface WrapKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 是否命中「切换自动换行」手势：**Alt+Z**。
 *
 * 必须排除的两个修饰键（都有实测/常识理由，别图省事放宽）：
 * - **Ctrl/Meta**：Ctrl+Z 是撤销，抢过来就是灾难；
 * - **Shift**：Alt+Shift+Z 在部分输入法/编辑器里另有语义（某些布局下 Alt+Shift 本身就是切换输入法），
 *   我们的手势只认最干净的那一种。
 *
 * `key` 统一小写比对：按住 Alt 时浏览器给的可能是 "z"，某些布局/输入法下会是 "Z" 或带别的形态。
 */
export function isWrapToggleKey(e: WrapKeyEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === "z";
}

/** 切换后的状态栏反馈文案（与缩放「缩放 130%」同一风格） */
export function wrapNotice(enabled: boolean): string {
  return enabled ? "自动换行：开" : "自动换行：关";
}

/**
 * 写作模式下按 Alt+Z 的提示。
 * 换行开关只作用于**源码模式**的编辑器；写作模式是文档形态，**始终自动折行**、没有开关
 * （2026-09-14 用户要求「文档模式的内容不应该有横向拖动，而是自动换行，Alt+Z 只对代码起效」）。
 * 按了不生效时必须说清规则，不能像没响应一样。
 */
export const WRAP_SOURCE_ONLY_NOTICE = "写作模式始终自动换行；Alt+Z 只切换源代码模式的换行";
