// 页面级脚本错误的归类（从 +page.svelte 原样搬出来，行为零改动）。
//
// 为什么值得单独一层：引擎（WebView2 / Chromium）自己吐的 `ResizeObserver loop` 提示**不是我们的
// bug**，必须滤掉 —— 0.7.6 之前它会被报成状态栏的「脚本错误」，用户截图里的现象是"放大到 190%
// 之后界面像烂了"。这条白名单只有真机遇得到，所以用单测把它钉住（含 Chromium 的两种原文）。

/** 引擎提示类「脚本错误」的白名单（大小写不敏感） */
export const BENIGN_SCRIPT_ERRORS: RegExp[] = [/ResizeObserver loop/i];

/** 这条消息是不是引擎提示（是则只记 debug 日志，不进状态栏） */
export function isBenignScriptError(msg: string): boolean {
  return BENIGN_SCRIPT_ERRORS.some((re) => re.test(msg));
}

/** 把 onerror / unhandledrejection 拿到的东西抠成一句消息（Error → message；其余 String） */
export function scriptErrorMessage(detail: unknown): string {
  return detail instanceof Error
    ? detail.message
    : typeof detail === "string"
      ? detail
      : String(detail);
}

/** 状态栏那行「脚本错误：…」 */
export function scriptErrorStatus(msg: string): string {
  return `脚本错误：${msg}`;
}
