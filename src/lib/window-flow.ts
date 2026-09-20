// 窗口级流程（从 +page.svelte 搬出来）：多窗口（新建/关闭/焦点）与 `open-file` 广播的认领，
// 外加窗口级拖放（把 .typ 拖进窗口打开）。Tauri 的具体 API 由页面注入。
//
// 两条红线（展开见 docs/实现细则/05-窗口与更新.md）：
//
// 1. **`open-file` 是广播，只能有一个窗口接**（Rust 侧是 `app.emit`，所有窗口都会收到）：
//    有焦点的窗口接（用户看得见文件开在哪）；一个窗口都没焦点时（应用在后台/最小化）由**主窗口**
//    延迟一拍兜底，兜底前先看队列 —— 队列空说明已经有窗口接走了，就放手（否则两个窗口会同时切到
//    同一个文件，各自未保存的内容都可能被顶掉）。
// 2. **副窗口是空白草稿窗口**：没焦点就不抢，交给主窗口兜底。另外新窗口的 label 前缀 `editor-`
//    必须与 `capabilities/default.json` 的 `windows` 对得上，否则新窗口里的文件读写会在 ACL 层
//    被拒；`new WebviewWindow()` 还额外需要 `core:webview:allow-create-webview-window`
//    （`core:webview:default` 里没有这一条）—— 改这里的 Tauri 调用后去
//    `scripts/capabilities.test.mjs` 那张表里补一行（浏览器验收碰不到这类 ACL 拒绝）。

import { pickTypPath } from "./file-ops";

/** 新窗口 label 前缀：必须唯一（重名会创建失败），且要与 capabilities 里的 `editor-*` 一致 */
export const NEW_WINDOW_LABEL_PREFIX = "editor-";
/** 新窗口标题（空白草稿窗口，还没保存过） */
export const NEW_WINDOW_TITLE = "未命名.typ - Typst-pad";
/** 拖进来的文件里没有 .typ 时状态栏的一句说明 */
export const ONLY_TYP_NOTICE = "仅支持打开 .typ 文件";
/** open-file 广播的兜底延迟：等有焦点的窗口先接 */
export const OPEN_FILE_FALLBACK_DELAY_MS = 250;

/**
 * 新建窗口失败的原因：同步抛错给 `Error.message`，异步的 `tauri://error` 事件给字符串 payload
 * （拿不到就给空串，不写一个光秃秃的 `undefined`）。
 */
export function newWindowFailureReason(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  return String(detail ?? "");
}

export interface WindowFlowHooks {
  isTauri(): boolean;
  /**
   * 建一个窗口（页面接 `new WebviewWindow(label, { url: "/", ... })`）。
   * **同步抛错 = 创建失败**（label 撞车 / 系统拒绝）；创建过程里的异步失败走 `onAsyncError`
   * （页面把 `tauri://error` 事件的 payload 交给它）。
   */
  createWindow(
    label: string,
    title: string,
    onAsyncError: (detail: unknown) => void,
  ): void;
  /** 关闭当前窗口（未保存修改会先弹确认，见页面 onCloseRequested） */
  closeWindow(): void;
  /** 当前窗口有焦点吗；查询失败按"没有焦点"处理 */
  isFocused(): Promise<boolean>;
  /** 取走 Rust 侧待打开队列（`take_pending_files`）；失败返回空数组 */
  takePendingFiles(): Promise<string[]>;
  /** 按路径打开（file-flow.openPath） */
  openPath(path: string): Promise<boolean>;
  /** 是不是副窗口（空白草稿窗口，不抢 open-file 的兜底） */
  isSecondaryWindow(): boolean;
  /** 拖放悬停中（显示覆盖层提示） */
  setDragActive(active: boolean): void;
  setStatus(text: string): void;
  /** 建窗口失败的调试日志（发布版没有 devtools，留一份可查的现场） */
  logCreateFailure(detail: unknown): void;
  /** 生成 label 用的时间戳（注入以便单测确定化） */
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
}

export interface WindowFlow {
  /** `Ctrl+Shift+N` / 菜单「文件 → 新建窗口」 */
  openNewWindow(): void;
  /** `Ctrl+W` / 标题栏关闭：与标题栏走同一条路 */
  closeCurrentWindow(): void;
  /** `open-file` 广播的接球人（关联双击 / 跨实例转发打开） */
  claimOpenFileOnBroadcast(path: string): Promise<void>;
  /**
   * 首次启动 / 跨实例转发的待打开文件（关联双击）：监听器就绪后取走队列里最后一个（最新请求）。
   * **只由主窗口取**：副窗口是草稿窗口，不该被启动参数里带的文件顶掉内容。
   */
  claimPendingFileOnStartup(): Promise<void>;
  /** 窗口级拖放事件（payload 的 type + paths） */
  handleDragDrop(type: "enter" | "over" | "drop" | "leave", paths: string[]): void;
  /** 关窗：取消还没落地的兜底打开 */
  dispose(): void;
}

export function createWindowFlow(hooks: WindowFlowHooks): WindowFlow {
  /** open-file 广播的兜底定时器（没窗口有焦点时由主窗口延迟接） */
  let pendingOpenTimer: number | null = null;

  /**
   * 取走待打开队列里的最后一个路径（并清空）。多窗口下它同时是**"这个文件已被某窗口接走"**
   * 的记号：都从 Rust 侧这份队列里取，取到空 = 别人先接了。
   */
  async function claimPendingFile(): Promise<string | null> {
    try {
      const paths = await hooks.takePendingFiles();
      return paths.length > 0 ? paths[paths.length - 1] : null;
    } catch {
      return null;
    }
  }

  /** 当前窗口有焦点吗；**查询失败按"没有焦点"处理**（宁可走主窗口兜底，也别两个窗口都接） */
  async function currentIsFocused(): Promise<boolean> {
    try {
      return (await hooks.isFocused()) === true;
    } catch {
      return false;
    }
  }

  function openNewWindow(): void {
    if (!hooks.isTauri()) return; // 浏览器预览没有多窗口（应用本身也只在桌面版渲染）
    try {
      hooks.createWindow(
        `${NEW_WINDOW_LABEL_PREFIX}${hooks.now()}`,
        NEW_WINDOW_TITLE,
        (detail) => {
          // 创建失败（label 撞车 / 系统拒绝）在发布版里是看不见的（没有 devtools），报到状态栏
          hooks.setStatus(`新建窗口失败：${newWindowFailureReason(detail)}`);
          hooks.logCreateFailure(detail);
        },
      );
    } catch (e) {
      hooks.setStatus(`新建窗口失败：${newWindowFailureReason(e)}`);
    }
  }

  function closeCurrentWindow(): void {
    if (!hooks.isTauri()) return;
    hooks.closeWindow();
  }

  async function claimOpenFileOnBroadcast(path: string): Promise<void> {
    if (await currentIsFocused()) {
      void claimPendingFile(); // 清掉队列 = 告诉主窗口"已经有人接了"
      await hooks.openPath(path);
      return;
    }
    if (hooks.isSecondaryWindow()) return; // 副窗口没焦点就不抢：交给主窗口兜底
    if (pendingOpenTimer !== null) hooks.clearTimer(pendingOpenTimer);
    pendingOpenTimer = hooks.setTimer(() => {
      pendingOpenTimer = null;
      void claimPendingFile().then((unclaimed) => {
        if (unclaimed) void hooks.openPath(unclaimed);
      });
    }, OPEN_FILE_FALLBACK_DELAY_MS);
  }

  /** 启动/关联打开：就绪后取走待打开队列里的最后一个路径（只由主窗口取） */
  async function claimPendingFileOnStartup(): Promise<void> {
    if (hooks.isSecondaryWindow()) return; // 副窗口是草稿窗口，不该被启动参数里的文件顶掉内容
    const path = await claimPendingFile();
    if (path) await hooks.openPath(path);
  }

  function handleDragDrop(
    type: "enter" | "over" | "drop" | "leave",
    paths: string[],
  ): void {
    if (type === "enter" || type === "over") {
      hooks.setDragActive(true); // 悬停中：显示覆盖层提示
      return;
    }
    hooks.setDragActive(false);
    if (type !== "drop") return;
    const path = pickTypPath(paths);
    if (path) {
      void hooks.openPath(path);
    } else if (paths.length > 0) {
      hooks.setStatus(ONLY_TYP_NOTICE);
    }
  }

  function dispose(): void {
    if (pendingOpenTimer !== null) {
      hooks.clearTimer(pendingOpenTimer);
      pendingOpenTimer = null;
    }
  }

  return {
    openNewWindow,
    closeCurrentWindow,
    claimOpenFileOnBroadcast,
    claimPendingFileOnStartup,
    handleDragDrop,
    dispose,
  };
}
