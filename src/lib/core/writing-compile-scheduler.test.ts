// 写作模式编译调度器（报告 T3）的单元测试：用假时钟把"合并成一次"这件事钉死。
//
// 这一版要防的回归：
//  ① 在途期间来的请求**不许**另起一次编译（否则一次"改字 + 滚动 + 公式到货"就是三次）；
//  ② 待执行永远只有**一份**（Set 合并理由，不是数组追加）；
//  ③ 在途那次跑完必须复位（不复位就永远卡住，后续请求全丢）；
//  ④ 公式让路只推"挂着没跑"的那次；
//  ⑤ 合成期间不启动新编译，合成结束把攒下的排上；
//  ⑥ 文档切换清掉挂着的那份；
//  ⑦ **去抖是尾随的**（PR #77 复审第 1 条）：`edit` 重置计时 —— 首请求 +150ms 不许跑、
//     末请求 +150ms 才跑；只有 `edit` 续期（滚动/重排不许无限推迟编译）；
//  ⑧ `requestNow` 立即跑且返回"覆盖它的那一轮"跑完的 Promise（复审第 2 条的入口）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createWritingCompileScheduler,
  type WritingCompileScheduler,
} from "./writing-compile-scheduler";

describe("createWritingCompileScheduler", () => {
  let runs: number;
  /** 手动控制"编译什么时候跑完" */
  let release: (() => void) | null;
  let scheduler: WritingCompileScheduler;

  const make = (debounceMs = 150) =>
    createWritingCompileScheduler({
      run: () =>
        new Promise<void>((resolve) => {
          runs += 1;
          release = resolve;
        }),
      debounceMs,
      log: () => {},
    });

  beforeEach(() => {
    vi.useFakeTimers();
    runs = 0;
    release = null;
    scheduler = make();
  });
  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  const settle = async () => {
    release?.();
    release = null;
    await Promise.resolve();
    await Promise.resolve();
  };

  it("去抖：连续三次请求只跑一次编译", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(50);
    scheduler.request("edit");
    vi.advanceTimersByTime(50);
    scheduler.request("reflow");
    expect(runs).toBe(0);
    vi.advanceTimersByTime(150);
    await settle();
    expect(runs).toBe(1);
  });

  it("尾随去抖：从**最后一次编辑**起算 150ms，不是从第一次", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(140); // 距首请求只差 10ms
    scheduler.request("edit"); // 又敲了一个字 → 重新计时
    vi.advanceTimersByTime(20); // 首请求 +160ms：若是"从首请求计时"的节流，这里已经跑了
    expect(runs).toBe(0);
    vi.advanceTimersByTime(129); // 末请求 +149ms
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1); // 末请求 +150ms
    expect(runs).toBe(1);
    await settle();
  });

  it("只有 edit 续期：滚动 / 重排不许把编译无限推迟", async () => {
    scheduler.request("edit"); // t=0，定时器排到 t=150
    vi.advanceTimersByTime(100);
    scheduler.request("blocks-needed"); // t=100，不续期
    vi.advanceTimersByTime(40);
    scheduler.request("reflow"); // t=140，不续期
    vi.advanceTimersByTime(10); // t=150：首请求那次的期限到了
    expect(runs).toBe(1);
    await settle();
  });

  it("公式让路之后按让路的时刻重排（edit 重置不许把 240ms 的让路掀回 150ms）", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(100);
    scheduler.holdForMath(240); // 让路到 t=340
    scheduler.request("edit"); // 又敲字：重置，但仍要等让路到期
    vi.advanceTimersByTime(239);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    await settle();
  });

  it("requestNow：不在途时**立刻**跑，Promise 在这一轮跑完后 resolve", async () => {
    let resolved = false;
    const done = scheduler.requestNow("context").then(() => {
      resolved = true;
    });
    expect(runs).toBe(1); // 不等 150ms
    expect(resolved).toBe(false);
    await settle();
    await done;
    expect(resolved).toBe(true);
  });

  it("requestNow：在途时并进待执行，跑完**立刻**接上（不走 150ms 去抖）", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(150); // 第一轮在途
    expect(runs).toBe(1);
    let resolved = false;
    const done = scheduler.requestNow("context").then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(50);
    expect(runs).toBe(1); // 在途期间一次都没多跑
    await settle(); // 第一轮跑完 → 立刻接上第二轮
    expect(runs).toBe(2);
    expect(resolved).toBe(false); // 第二轮还在跑，Promise 不许提前兑现
    await settle();
    await done;
    expect(resolved).toBe(true);
  });

  it("requestNow 撞上合成：不启动，合成结束后立刻跑（不等去抖）", async () => {
    scheduler.setComposing(true);
    let resolved = false;
    const done = scheduler.requestNow("context").then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(500);
    expect(runs).toBe(0);
    scheduler.setComposing(false);
    expect(runs).toBe(1);
    await settle();
    await done;
    expect(resolved).toBe(true);
  });

  it("cancelPending / dispose 会放行 requestNow 的等待者（作废不许让 Promise 悬空）", async () => {
    scheduler.setComposing(true);
    let cancelled = false;
    const a = scheduler.requestNow("context").then(() => {
      cancelled = true;
    });
    scheduler.cancelPending();
    await a;
    expect(cancelled).toBe(true);
    expect(runs).toBe(0);
    scheduler.setComposing(false);

    scheduler.setComposing(true);
    let disposed = false;
    const b = scheduler.requestNow("context").then(() => {
      disposed = true;
    });
    scheduler.dispose();
    await b;
    expect(disposed).toBe(true);
  });

  it("在途期间来的请求**不另起**：并进同一份待执行，跑完再排一次", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(150);
    expect(scheduler.stats().inFlight).toBe(true);
    expect(runs).toBe(1);

    // 在途期间：三次请求（不同理由）合并成一份
    scheduler.request("blocks-needed");
    scheduler.request("reflow");
    scheduler.request("edit");
    expect(scheduler.stats().pending).toBe(true);
    expect(scheduler.stats().reasons).toEqual(["blocks-needed", "reflow", "edit"]);
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(1); // 在途期间一次都没多跑

    await settle();
    // 跑完 → 攒下的那一份排上（去抖后跑第二次，总共 2 次而不是 4 次）
    vi.advanceTimersByTime(150);
    await settle();
    expect(runs).toBe(2);
    expect(scheduler.stats().pending).toBe(false);
    expect(scheduler.stats().inFlight).toBe(false);
  });

  it("在途那次跑完必须复位：否则后续请求永远排不上", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(150);
    await settle();
    expect(scheduler.stats().inFlight).toBe(false);
    scheduler.request("edit");
    vi.advanceTimersByTime(150);
    expect(runs).toBe(2);
  });

  it("编译抛异常也要复位（不然一次失败就把调度器卡死）", async () => {
    const failing = createWritingCompileScheduler({
      run: async () => {
        runs += 1;
        throw new Error("编译失败");
      },
      debounceMs: 150,
    });
    failing.request("edit");
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(failing.stats().inFlight).toBe(false);
    failing.request("edit");
    vi.advanceTimersByTime(150);
    await Promise.resolve();
    expect(runs).toBe(2);
    failing.dispose();
  });

  it("公式让路：只推挂着没跑的那次；在途时不打扰", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(100); // 还差 50ms 就跑
    scheduler.holdForMath(240);
    vi.advanceTimersByTime(200); // 若没让路，这里早该跑了
    expect(runs).toBe(0);
    vi.advanceTimersByTime(50);
    await settle();
    expect(runs).toBe(1);

    // 在途时让路：不产生任何额外调度
    scheduler.request("edit");
    vi.advanceTimersByTime(150);
    scheduler.holdForMath(240);
    await settle();
    expect(runs).toBe(2);
  });

  it("合成期间不启动新编译；结束之后把攒下的排上", async () => {
    scheduler.setComposing(true);
    scheduler.request("edit");
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(0);
    expect(scheduler.stats().pending).toBe(true);
    expect(scheduler.stats().composing).toBe(true);

    scheduler.setComposing(false);
    vi.advanceTimersByTime(150);
    await settle();
    expect(runs).toBe(1);
  });

  it("合成开始时挂着的那次也先别跑（清掉定时器，合成结束再排）", async () => {
    scheduler.request("edit");
    vi.advanceTimersByTime(100);
    scheduler.setComposing(true);
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(0);
    scheduler.setComposing(false);
    vi.advanceTimersByTime(150);
    await settle();
    expect(runs).toBe(1);
  });

  it("文档切换：清掉挂着的那份（在途那次由调用方的排版戳过滤去丢）", async () => {
    scheduler.request("edit");
    scheduler.cancelPending();
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(0);
    expect(scheduler.stats().pending).toBe(false);
  });

  it("dispose 之后不再排（组件销毁）", async () => {
    scheduler.dispose();
    scheduler.request("edit");
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(0);
  });

  it("runs 计数可观测（验收用它断言「合并生效」）", async () => {
    for (let i = 0; i < 8; i++) {
      scheduler.request("edit");
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(150);
    await settle();
    expect(scheduler.stats().runs).toBe(1);
  });
});
