// 新建窗口（`Ctrl+Shift+N` / 菜单「文件 → 新建窗口」）的规则。
//
// 从 `+page.svelte` 的 `openNewWindow` 搬出来（来源：PR #63 第二轮里与主干不重复的那一块；
// 那一轮里的"拖放 / 关闭确认 / open-file 接球"已经分别落在 `core/window-events.ts` 与
// `core/open-file-claim.ts`，所以这里只剩**建窗口**这一件事）。行为零改动。
//
// 三条规则（展开见 docs/实现细则/05-窗口与更新.md）：
//
// 1. **label 必须唯一**（Tauri 要求，重名会创建失败）：`editor-<毫秒时间戳>`。
// 2. **前缀必须与 `capabilities/default.json` 的 `windows: ["main", "editor-*"]` 对得上**，
//    否则新窗口里的文件读写会在 ACL 层被拒（0.2.x 踩过）。另外 `new WebviewWindow()` 还需要
//    `core:webview:allow-create-webview-window`（`core:webview:default` 里没有），缺了会在**运行时**
//    被拒 —— 这类 ACL 拒绝浏览器验收碰不到，所以另有 `scripts/capabilities.test.mjs` 做静态体检：
//    改这里的 Tauri 调用后，去那张表里补一行。
// 3. **失败要报到状态栏**（发布版没有 devtools）：同步抛错给 `Error.message`，异步的
//    `tauri://error` 事件给字符串 payload —— 两者都可能拿不到东西，别写一个光秃秃的 `undefined`。

/** 新窗口 label 前缀：必须唯一（重名会创建失败），且要与 capabilities 里的 `editor-*` 一致 */
export const NEW_WINDOW_LABEL_PREFIX = "editor-";
/** 新窗口标题（空白草稿窗口，还没保存过） */
export const NEW_WINDOW_TITLE = "未命名.typ - Typst-pad";

/**
 * 新建窗口失败的原因：同步抛错给 `Error.message`，异步的 `tauri://error` 事件给字符串 payload
 * （拿不到就给空串，不写一个光秃秃的 `undefined`）。
 */
export function newWindowFailureReason(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  return String(detail ?? "");
}

/** 新窗口的 label（`now` 注入以便单测确定化） */
export function newWindowLabel(now: number): string {
  return `${NEW_WINDOW_LABEL_PREFIX}${now}`;
}

export interface NewWindowHooks {
  /** 浏览器预览里没有多窗口（应用本身也只在桌面版渲染） */
  isTauri(): boolean;
  /**
   * 建一个窗口（页面接 `new WebviewWindow(label, { url: "/", … })`）。
   * **同步抛错 = 创建失败**（label 撞车 / 系统拒绝）；创建过程里的异步失败走 `onAsyncError`
   * （页面把 `tauri://error` 事件的 payload 交给它）。
   */
  createWindow(label: string, title: string, onAsyncError: (detail: unknown) => void): void;
  /** 失败文案进状态栏 */
  setStatus(text: string): void;
  /** 建窗口失败的调试日志（发布版没有 devtools，留一份可查的现场） */
  logCreateFailure(detail: unknown): void;
  /** 生成 label 用的时间戳（注入以便单测确定化） */
  now(): number;
}

export interface NewWindow {
  /** `Ctrl+Shift+N` / 菜单「文件 → 新建窗口」 */
  open(): void;
}

export function createNewWindow(hooks: NewWindowHooks): NewWindow {
  function open(): void {
    if (!hooks.isTauri()) return; // 浏览器预览没有多窗口（应用本身也只在桌面版渲染）
    try {
      hooks.createWindow(newWindowLabel(hooks.now()), NEW_WINDOW_TITLE, (detail) => {
        // 创建失败（label 撞车 / 系统拒绝）在发布版里是看不见的（没有 devtools），报到状态栏
        hooks.setStatus(`新建窗口失败：${newWindowFailureReason(detail)}`);
        hooks.logCreateFailure(detail);
      });
    } catch (e) {
      hooks.setStatus(`新建窗口失败：${newWindowFailureReason(e)}`);
    }
  }

  return { open };
}
