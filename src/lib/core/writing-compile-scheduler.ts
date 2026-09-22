// **写作模式编译调度器**（报告 T3）：把"什么时候编译"收成**一个入口**。
//
// 背景：改这一版之前，写作模式的编译由四个地方各自挂定时器 —— 编辑（`scheduleCompile`，
// 150ms）、视口里出现没切片的块（`handleBlocksNeeded`，150ms）、版心宽变化
//（`scheduleWritingReflow`，250ms）、以及公式让路（`deferPendingBlockCompile`，240ms）。
// 它们是**四个互不知情的定时器**：一次"改字 + 滚动 + 公式到货"可以同时挂上两三个编译，
// 而三个编译命令在 Rust 侧共用一把锁 —— 表现就是"打得快的时候编译排长队"。
//
// 这一版把"要不要编译"合并成一个**单槽**模型（不引队列，队列只会把延迟堆起来）：
//   * **最多一个在途**（`inFlight`）：在途期间来的请求只把**理由**并进 `pending`，不另起一次；
//   * **最多一份待执行**（`pending` 是一个 Set，不是数组）：新需求**替换**旧的，不追加；
//   * 在途那次跑完，若 `pending` 非空再排一次（这才是"合并成一次"的收益）。
//
// **去抖是尾随的**（PR #77 复审的第 1 条）：`edit` 请求会**重置**还没到点的那次计时，
// 所以"持续打字"期间一次都不会启动，停手 150ms 才编译。曾经的写法看到已有定时器就直接返回，
// 那实际是"从首个请求计时的节流"：连打超过 150ms 时整篇编译会在用户还在打字时启动。
// 只有 `edit` 重置 —— `blocks-needed`（滚动）与 `reflow`（拖窗口）也是高频来源，
// 让它们续期会把编译无限推迟（一直滚就一直不编译）。
//
// **两个入口**：`request`（去抖，编辑/补渲/重排走它）与 `requestNow`（立即 + 返回"这一轮跑完"
// 的 Promise，启动首编译 / 设置保存这类"必须马上看到结果"的入口走它）。**写作模式的编译
// 一律经由本调度器**（PR #77 复审的第 2 条）：绕过它就等于在 Rust 那把编译锁外面又排一条队，
// 单槽模型也就不成立了。
//
// 与既有约定的关系（**不许因为有了调度器就省掉**）：
//   1. 结果的版本过滤仍然由调用方做（`runCompile` 里的排版戳比较）—— 合并队列**不能**
//      替代结果校验：在途那次可能是文档改之前发的；
//   2. 公式让路的**意图**保留（`holdForMath`），只是不再另挂一个定时器；
//   3. 输入法合成期间**不启动**新的后台编译（`setComposing`）：合成中的文本由 IME 持有，
//      这时候整篇重排会让候选串与合成状态一起坏掉（用户是中文作者，这条每天都要走）。
//      注意语义是"不**启动**"：已经在跑的那次允许跑完（它的结果由版本过滤决定去留）。
//
// 纯逻辑、依赖注入（`run` / 定时器 / 日志都可替身），单测用假时钟钉死。

/** 这次编译是**为什么**排的。合并时取并集（诊断用；真正跑的时候并不区分） */
export type CompileReason =
  "edit" | "blocks-needed" | "reflow" | "context" | "mode" | "composing-end";

export interface WritingCompileSchedulerHooks {
  /** 真正跑一次编译（页面的 `runCompile`）。异常由它自己处理，这里只保证 `inFlight` 会复位 */
  run: () => Promise<void>;
  /** 写作模式的去抖（缺省 150ms，见 `WRITE_COMPILE_DEBOUNCE_MS`） */
  debounceMs?: number;
  /** 诊断日志（页面的 `dbg.log`） */
  log?: (message: string) => void;
}

export interface WritingCompileSchedulerStats {
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

export interface WritingCompileScheduler {
  /** 请求一次编译（理由取并集；同一时刻最多一份待执行）。`edit` 会**重置**尾随去抖 */
  request(reason: CompileReason): void;
  /**
   * **立即**跑一次（不等去抖），返回的 Promise 在**覆盖这次请求的那一轮编译跑完**后 resolve。
   *
   * 给"必须马上编译、而且要在落地后做点什么"的入口用（启动首编译要写状态栏、设置保存后要
   * 更新"设置已保存"文案）。在途时它**不抢跑**：理由并进待执行的那一份，等这一轮跑完立刻接上
   * （不走 150ms 去抖）；所以 Promise 反映的是"包含我这次请求的那一轮"，不是"随便一轮"。
   */
  requestNow(reason: CompileReason): Promise<void>;
  /**
   * 有公式要渲：把**挂着的**那次编译再往后推（公式是小活，整篇块编译是几十~几百毫秒，
   * 两者共用同一把编译锁，不让路就会出现"打完公式半天不显示"）。在途时不打扰。
   */
  holdForMath(ms: number): void;
  /** 输入法合成开始/结束：合成期间不启动新编译；结束时把攒下的那次排上 */
  setComposing(active: boolean): void;
  /** 文档切换 / 改字体：把攒着的那份丢掉（在途那次由调用方的版本过滤去丢） */
  cancelPending(): void;
  stats(): WritingCompileSchedulerStats;
  /** 组件销毁：清掉挂着的定时器（别让它打到已拆的页面） */
  dispose(): void;
}

export function createWritingCompileScheduler(
  hooks: WritingCompileSchedulerHooks,
): WritingCompileScheduler {
  const debounceMs = hooks.debounceMs ?? 150;
  const log = hooks.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 公式让路还要等多久（ms，0 = 没有让路）。**不用绝对时刻**：`edit` 重置尾随去抖时要按
   * 让路的重排（不能把 240ms 的让路掀回 150ms —— 那正是让路要避免的"公式排在整篇编译后面"），
   * 而绝对时刻在假时钟/系统时间被改时都不稳，直接记"让路多长"更省事。
   */
  let holdMs = 0;
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

  /** 挂一个定时器（唯一入口：`holdMs` 的清理与 `timer` 的复位都收在这里） */
  function arm(delay: number): void {
    timer = setTimeout(() => {
      timer = undefined;
      holdMs = 0;
      void pump();
    }, delay);
  }

  function clearTimer(): void {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    holdMs = 0;
  }

  function schedule(delay = debounceMs): void {
    if (disposed) return;
    if (composing) {
      // 合成期间**不启动**：理由留着，`setComposing(false)` 时再排
      log(`写作编译：合成中，攒下 ${[...pending].join("+")}`);
      return;
    }
    if (pending.size === 0) return;
    // 立即请求（`requestNow`）不走定时器：它自己（或 `scheduleNext`）直接叫 `pump`
    if (pendingImmediate) return;
    if (timer !== undefined) return; // 已经有一份在等：不重复挂定时器
    arm(delay);
  }

  /** 在途那次跑完之后怎么接上攒下的那一份：立即请求不走去抖，其余按去抖排 */
  function scheduleNext(): void {
    if (disposed || pending.size === 0) return;
    if (!pendingImmediate) {
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
    pendingImmediate = false;
    // 这一轮**覆盖**的等待者：本轮开始时已经在等的人（他们的理由就在刚清掉的那份里）。
    // 本轮进行期间新登记的等待者留到下一轮 —— 否则它们的请求还没跑就被告知"跑完了"。
    const covered = waiters;
    waiters = [];
    inFlight = true;
    runs += 1;
    log(`写作编译：开始（理由 ${reasons.join("+")}）`);
    try {
      await hooks.run();
    } catch (e) {
      // 编译失败**不许**变成未处理的 rejection（那会在 WebView 里冒到 window.onerror，
      // 状态栏就多一条"脚本错误"）：吞掉并记日志，状态由 `run` 自己往状态栏写。
      log(`写作编译失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // **必须复位**：不复位就永远卡在"在途"，后续请求全部石沉大海
      //（原来那个 `writeCompileTimer` 也踩过同一个坑：跑完不置回 undefined，
      // math-queue 的"有挂着的编译"判据就永远是假的）
      inFlight = false;
      releaseWaiters(covered);
      scheduleNext(); // 在途期间攒下的：跑完再排一次
    }
  }

  function request(reason: CompileReason): void {
    if (disposed) return;
    pending.add(reason);
    // **尾随去抖**：`edit` 重置还没到点的那次计时（"打字停顿 150ms 才编译"）。
    // 在途/合成中不重置 —— 那时手里这份反正要等下一轮（`pump` 的校验会挡住）。
    if (reason === "edit" && !inFlight && !composing && timer !== undefined) {
      const held = holdMs; // 公式让路排得比去抖晚时按让路的重排（见 holdMs 的说明）
      clearTimer();
      arm(Math.max(debounceMs, held));
    }
    schedule();
  }

  function requestNow(reason: CompileReason): Promise<void> {
    if (disposed) return Promise.resolve();
    const done = new Promise<void>((resolve) => waiters.push(resolve));
    pending.add(reason);
    pendingImmediate = true;
    clearTimer();
    // 在途/合成中就不抢跑：`pump` 的 finally 会立刻接上（`scheduleNext` 认 pendingImmediate）
    if (!inFlight && !composing) void pump();
    return done;
  }

  function holdForMath(ms: number): void {
    if (disposed || composing) return;
    // 只有"挂着还没跑"的那次可以让路；在途的不打扰（它已经在编译了）
    if (timer === undefined) return;
    const delay = Math.max(ms, 0);
    clearTimeout(timer);
    holdMs = delay;
    arm(delay);
    log(`写作编译：给公式让路 ${Math.round(delay)}ms`);
  }

  function setComposing(active: boolean): void {
    if (composing === active) return;
    composing = active;
    if (composing) {
      // 合成开始：挂着的那次先别跑（定时器到点时 `pump` 会自己让开，这里顺手清掉更干净）
      clearTimer();
      return;
    }
    // 合成结束：**读取最终文档快照之后再排**（调用方负责刷新 editorDoc 与 ranges，
    // 这里的 `request("composing-end")` 是页面在 compositionend 里调的）
    scheduleNext();
  }

  function cancelPending(): void {
    clearTimer();
    pending.clear();
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

  function stats(): WritingCompileSchedulerStats {
    return { inFlight, pending: pending.size > 0, reasons: [...pending], runs, composing };
  }

  return { request, requestNow, holdForMath, setComposing, cancelPending, stats, dispose };
}
