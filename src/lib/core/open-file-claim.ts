// `open-file` 广播的**接球规则**（关联双击 / 跨实例转发打开）。
//
// 从 `+page.svelte` 搬出来（原来 `claimOpenFileOnBroadcast` / `claimPendingFile` 两个函数 + 一个
// 兜底定时器状态）。Rust 侧用 `app.emit` 广播，**所有窗口都会收到**，必须挑一个窗口接 ——
// 否则两个窗口会同时切到同一个文件、各自未保存的内容都可能被顶掉。规则：
//
// 1. **有焦点的窗口接**（用户看得见文件开在哪）：接之前先把 Rust 侧那份待打开队列**取空**，
//    那是"这个文件已经被接走"的记号（见 `takePending`）。
// 2. **一个窗口都没焦点**（应用在后台/最小化）时，**主窗口延迟一拍兜底**：延迟之后先看队列 ——
//    队列空说明已经有窗口接走了，就放手（主窗口自己的会话不会被别人的双击顶掉）。
// 3. **副窗口没焦点就不抢**：它是草稿窗口，交给主窗口兜底。
// 4. **启动时就绪后再取一次队列**（首次启动带的文件 / 跨实例转发）：**只主窗口取**，副窗口不取
//    （草稿窗口不该被启动参数里的文件顶掉内容）。
//
// 这些规则以前只写在注释里、且只有桌面版真机才走得到（多窗口 + 系统"用 Typst-pad 打开"），
// 所以抽成依赖全注入的工厂，用单测把"谁接、谁兜底、兜底前要不要放手"钉住。
// 定时器直接用全局的（单测定时器用 vitest 的假定时器，与 `math-queue` 同一套路）——
// 这里只有一个兜底定时器、不依赖真实时钟，不值得像 `zoom-controller` 那样注入。
/** 兜底延迟：等有焦点的窗口先接（应用在后台时两个窗口都没焦点，主窗口等这一拍再出手） */
export const OPEN_FILE_FALLBACK_DELAY_MS = 250;

export interface OpenFileClaimHooks {
  /** 当前窗口是否有焦点（页面侧查 Tauri）。**抛异常、或返回非 `true`，都按"没有焦点"处理** */
  isFocused: () => Promise<boolean>;
  /** 本窗口是不是副窗口（草稿窗口） */
  isSecondaryWindow: boolean;
  /**
   * 取走待打开队列并**清空**它（同时是"已被某窗口接走"的记号）。**原样返回数组** ——
   * 取哪一条由本模块的 `lastPending` 决定（Rust 侧 `take_pending_files` 会把队列一起清掉）。
   * **页面侧要自己吞掉 invoke 失败并返回空数组**，不要往上抛。
   */
  takePending: () => Promise<readonly string[]>;
  /** 真正打开文件（页面侧就是 `docSession.openPath`，返回值本模块不看） */
  openPath: (path: string) => unknown;
}

export interface OpenFileClaim {
  /** 收到一条 `open-file` 广播 */
  onBroadcast(path: string): Promise<void>;
  /** 启动/转发时就绪后取一次队列（只主窗口取）；返回是否从队列里认领到了文件（不看 `openPath` 的结果） */
  claimStartup(): Promise<boolean>;
  /** 卸载：取消还没落地的兜底打开 */
  dispose(): void;
}

/** 队列里取哪个：**最后一个**（最新一次请求；Rust 侧按发生顺序 push） */
export function lastPending(paths: readonly string[]): string | null {
  return paths.length > 0 ? paths[paths.length - 1] : null;
}

export function createOpenFileClaim(hooks: OpenFileClaimHooks): OpenFileClaim {
  /** 还没落地的兜底定时器（null = 没有挂着的兜底） */
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 查焦点，失败按"没有焦点"（宁可让主窗口延迟兜底，也不要因为一次查询失败把文件丢在地上） */
  async function isFocused(): Promise<boolean> {
    try {
      return (await hooks.isFocused()) === true;
    } catch {
      return false;
    }
  }

  async function onBroadcast(path: string): Promise<void> {
    if (await isFocused()) {
      // 先把队列取空 = 告诉主窗口"已经有人接了"（结果本身不用，直接用广播里的 path）
      void hooks.takePending();
      await hooks.openPath(path);
      return;
    }
    if (hooks.isSecondaryWindow) return; // 副窗口没焦点就不抢：交给主窗口兜底
    if (timer !== null) clearTimeout(timer); // 连着来两条广播时只兜底最后一次
    timer = setTimeout(() => {
      timer = null;
      void hooks.takePending().then((paths) => {
        // 队列空 = 已经有窗口接走了 → 放手（照旧不吭声：这不是错误）
        const unclaimed = lastPending(paths);
        if (unclaimed) void hooks.openPath(unclaimed);
      });
    }, OPEN_FILE_FALLBACK_DELAY_MS);
  }

  async function claimStartup(): Promise<boolean> {
    if (hooks.isSecondaryWindow) return false;
    const path = lastPending(await hooks.takePending());
    if (!path) return false;
    await hooks.openPath(path);
    return true;
  }

  function dispose(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  return { onBroadcast, claimStartup, dispose };
}
