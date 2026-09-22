// 写作模式编译调度器（报告 T3）的单元测试：用假时钟把"合并成一次"这件事钉死。
//
// 这一版要防的回归：
//  ① 在途期间来的请求**不许**另起一次编译（否则一次"改字 + 滚动 + 公式到货"就是三次）；
//  ② 待执行永远只有**一份**（Set 合并理由，不是数组追加）；
//  ③ 在途那次跑完必须复位（不复位就永远卡住，后续请求全丢）；
//  ④ 公式让路只推"挂着没跑"的那次；
//  ⑤ 合成期间不启动新编译，合成结束把攒下的排上；
//  ⑥ 文档切换清掉挂着的那份。
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
