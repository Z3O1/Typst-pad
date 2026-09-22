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
  /** 请求一次编译（理由取并集；同一时刻最多一份待执行） */
  request(reason: CompileReason): void;
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
  let inFlight = false;
  /** 待执行的那**一份**需求（Set 而不是数组：新需求并进来，不追加） */
  const pending = new Set<CompileReason>();
  let composing = false;
  let runs = 0;
  let disposed = false;

  function schedule(delay = debounceMs): void {
    if (disposed) return;
    if (composing) {
      // 合成期间**不启动**：理由留着，`setComposing(false)` 时再排
      log(`写作编译：合成中，攒下 ${[...pending].join("+")}`);
      return;
    }
    if (pending.size === 0) return;
    if (timer !== undefined) return; // 已经有一份在等：不重复挂定时器
    timer = setTimeout(() => {
      timer = undefined;
      void pump();
    }, delay);
  }

  async function pump(): Promise<void> {
    if (disposed || inFlight || composing || pending.size === 0) return;
    const reasons = [...pending];
    pending.clear();
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
      if (pending.size > 0) schedule(); // 在途期间攒下的：跑完再排一次
    }
  }

  function request(reason: CompileReason): void {
    if (disposed) return;
    pending.add(reason);
    schedule();
  }

  function holdForMath(ms: number): void {
    if (disposed || composing) return;
    // 只有"挂着还没跑"的那次可以让路；在途的不打扰（它已经在编译了）
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        void pump();
      },
      Math.max(ms, 0),
    );
    log(`写作编译：给公式让路 ${Math.round(ms)}ms`);
  }

  function setComposing(active: boolean): void {
    if (composing === active) return;
    composing = active;
    if (composing) {
      // 合成开始：挂着的那次先别跑（定时器到点时 `pump` 会自己让开，这里顺手清掉更干净）
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return;
    }
    // 合成结束：**读取最终文档快照之后再排**（调用方负责刷新 editorDoc 与 ranges，
    // 这里的 `request("composing-end")` 是页面在 compositionend 里调的）
    schedule();
  }

  function cancelPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending.clear();
  }

  function dispose(): void {
    disposed = true;
    cancelPending();
  }

  function stats(): WritingCompileSchedulerStats {
    return { inFlight, pending: pending.size > 0, reasons: [...pending], runs, composing };
  }

  return { request, holdForMath, setComposing, cancelPending, stats, dispose };
}
