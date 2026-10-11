// 整页编译调度：有界尾随去抖、至多一个在途与一份待执行，合成期间暂停启动。
/** 这次编译是**为什么**排的。合并时取并集（诊断用；真正跑的时候并不区分） */
export type CompileReason = "edit" | "context" | "mode" | "composing-end" | "preview-reflow";

export interface DocumentCompileSchedulerHooks {
  /** 真正跑一次编译（页面的 `runCompile`）。异常由它自己处理，这里只保证 `inFlight` 会复位 */
  run: () => Promise<void>;
  /** 整页编译的尾随去抖（缺省 150ms）；getter 允许模式独立策略。 */
  debounceMs?: number | (() => number);
  /** 首份需求到启动的等待上限（缺省 300ms）；在途时间消耗预算，合成时间不计入。 */
  maxWaitMs?: number | (() => number);
  /** 诊断日志（页面的 `dbg.log`） */
  log?: (message: string) => void;
}

export interface DocumentCompileSchedulerStats {
  /** 有没有一次编译正在跑 */
  inFlight: boolean;
  /** 有没有一份攒着还没跑的需求 */
  pending: boolean;
  /** 攒着的理由（诊断用） */
  reasons: CompileReason[];
  /** 在这个调度器里真正跑过几次（单测/验收用来断言"合并生效"） */
  runs: number;
  /** 合成中（此时不启动新的编译） */
  composing: boolean;
}

export interface DocumentCompileScheduler {
  /** 请求一次编译（理由取并集；同一时刻最多一份待执行）。`edit` 续期但不超过首请求期限。 */
  request(reason: CompileReason): void;
  /**
   * **立即**跑一次（不等去抖），返回的 Promise 在**覆盖这次请求的那一轮编译跑完**后 resolve。
   *
   * 给"必须马上编译、而且要在落地后做点什么"的入口用（启动首编译要写状态栏、设置保存后要
   * 更新"设置已保存"文案）。在途时它**不抢跑**：理由并进待执行的那一份，等这一轮跑完立刻接上
   * （不走 150ms 去抖）；所以 Promise 反映的是"包含我这次请求的那一轮"，不是"随便一轮"。
   */
  requestNow(reason: CompileReason): Promise<void>;
  /** 输入法合成开始/结束：合成期间不启动新编译；结束时把攒下的那次排上 */
  setComposing(active: boolean): void;
  /** 文档切换 / 改字体：把攒着的那份丢掉（在途那次由调用方的版本过滤去丢） */
  cancelPending(): void;
  stats(): DocumentCompileSchedulerStats;
  /** 组件销毁：清掉挂着的定时器（别让它打到已拆的页面） */
  dispose(): void;
}

export function createDocumentCompileScheduler(
  hooks: DocumentCompileSchedulerHooks,
): DocumentCompileScheduler {
  const value = (option: number | (() => number) | undefined, fallback: number) =>
    typeof option === "function" ? option() : (option ?? fallback);
  let pendingSince: number | null = null;
  let dueAt = 0;
  const log = hooks.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  /** 待执行的那**一份**需求（Set 而不是数组：新需求并进来，不追加） */
  const pending = new Set<CompileReason>();
  /** 待执行的那份是 `requestNow` 来的：跑完要**立刻**接上，不走去抖 */
  let pendingImmediate = false;
  /** `requestNow` 的等待者：在"覆盖它的那一轮"跑完时一起放行（dispose/作废时也会放行，避免悬空） */
  let waiters: Array<() => void> = [];
  let composing = false;
  let runs = 0;
  let disposed = false;

  /** 定时器到期前复位句柄，后续请求仍可调度。 */
  function arm(delay: number): void {
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, delay);
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    if (disposed) return;
    if (composing) {
      // 合成期间**不启动**：理由留着，`setComposing(false)` 时再排
      log(`整页编译：合成中，攒下 ${[...pending].join("+")}`);
      return;
    }
    if (pending.size === 0) return;
    // 立即请求（`requestNow`）不走定时器：它自己（或 `scheduleNext`）直接叫 `pump`
    if (pendingImmediate) return;
    if (timer !== undefined) return; // 已经有一份在等：不重复挂定时器
    arm(Math.max(0, dueAt - Date.now()));
  }

  /** 在途时间已计入等待：期限已到就立即接上，不再追加完整去抖。 */
  function scheduleNext(): void {
    if (disposed || pending.size === 0) return;
    if (!pendingImmediate && dueAt > Date.now()) {
      schedule();
      return;
    }
    clearTimer();
    if (!inFlight && !composing) void pump();
  }

  function releaseWaiters(list: Array<() => void>): void {
    for (const resolve of list) resolve();
  }

  async function pump(): Promise<void> {
    if (disposed || inFlight || composing || pending.size === 0) return;
    const reasons = [...pending];
    pending.clear();
    pendingSince = null;
    pendingImmediate = false;
    clearTimer();
    // 这一轮**覆盖**的等待者：本轮开始时已经在等的人（他们的理由就在刚清掉的那份里）。
    // 本轮进行期间新登记的等待者留到下一轮 —— 否则它们的请求还没跑就被告知"跑完了"。
    const covered = waiters;
    waiters = [];
    inFlight = true;
    runs += 1;
    log(`整页编译：开始（理由 ${reasons.join("+")}）`);
    try {
      await hooks.run();
    } catch (e) {
      // 编译失败**不许**变成未处理的 rejection（那会在 WebView 里冒到 window.onerror，
      // 状态栏就多一条"脚本错误"）：吞掉并记日志，状态由 `run` 自己往状态栏写。
      log(`整页编译失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // **必须复位**：不复位就永远卡在"在途"，后续请求全部石沉大海
      inFlight = false;
      releaseWaiters(covered);
      scheduleNext(); // 在途期间攒下的：跑完再排一次
    }
  }

  function request(reason: CompileReason): void {
    if (disposed) return;
    const first = pending.size === 0;
    pending.add(reason);
    pendingSince ??= Date.now();
    if (first || reason === "edit") {
      dueAt = Math.min(
        Date.now() + value(hooks.debounceMs, 150),
        pendingSince + value(hooks.maxWaitMs, 300),
      );
      clearTimer();
    }
    if (!inFlight) schedule();
  }

  function requestNow(reason: CompileReason): Promise<void> {
    if (disposed) return Promise.resolve();
    const done = new Promise<void>((resolve) => waiters.push(resolve));
    pending.add(reason);
    pendingSince ??= Date.now();
    pendingImmediate = true;
    clearTimer();
    // 在途/合成中就不抢跑：`pump` 的 finally 会立刻接上（`scheduleNext` 认 pendingImmediate）
    if (!inFlight && !composing) void pump();
    return done;
  }

  function setComposing(active: boolean): void {
    if (composing === active) return;
    composing = active;
    if (composing) {
      // 合成开始：挂着的那次先别跑（定时器到点时 `pump` 会自己让开，这里顺手清掉更干净）
      clearTimer();
      return;
    }
    // 合成时间不计入普通输入期限；调用方已先提交最终文本与光标。
    if (pending.size) {
      pendingSince = Date.now();
      dueAt = pendingSince + value(hooks.debounceMs, 150);
    }
    scheduleNext();
  }

  function cancelPending(): void {
    clearTimer();
    pending.clear();
    pendingSince = null;
    pendingImmediate = false;
    // 作废就不再有"覆盖它的那一轮"：立刻放行等待者，别让 `requestNow` 的 Promise 悬空
    // （调用方在 `.finally` 里写状态栏文案，悬空就等于那段永远不执行）
    const dropped = waiters;
    waiters = [];
    releaseWaiters(dropped);
  }

  function dispose(): void {
    disposed = true;
    cancelPending();
  }

  function stats(): DocumentCompileSchedulerStats {
    return { inFlight, pending: pending.size > 0, reasons: [...pending], runs, composing };
  }

  return { request, requestNow, setComposing, cancelPending, stats, dispose };
}
