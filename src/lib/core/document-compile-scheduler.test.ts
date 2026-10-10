// 整页编译调度器的假时钟测试：单槽、去抖、合成、取消与立即请求。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDocumentCompileScheduler,
  type DocumentCompileScheduler,
} from "./document-compile-scheduler";

describe("createDocumentCompileScheduler", () => {
  let runs: number;
  /** 手动控制"编译什么时候跑完" */
  let release: (() => void) | null;
  let scheduler: DocumentCompileScheduler;

  const make = (debounceMs = 150) =>
    createDocumentCompileScheduler({
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
    scheduler.request("context");
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
    scheduler.request("mode"); // t=100，不续期
    vi.advanceTimersByTime(40);
    scheduler.request("context"); // t=140，不续期
    vi.advanceTimersByTime(10); // t=150：首请求那次的期限到了
    expect(runs).toBe(1);
    await settle();
  });

  it("持续输入有上限，不会被尾随去抖无限饿死", async () => {
    scheduler.request("edit");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50);
      scheduler.request("edit");
    }
    expect(runs).toBe(0);
    vi.advanceTimersByTime(50);
    expect(runs).toBe(1); // 首请求 +300ms，即使最后一次输入尚不足150ms
    await settle();
  });

  it("在途等待已超过输入期限，结束后立即消费最新需求", async () => {
    scheduler.requestNow("context");
    scheduler.request("edit");
    vi.advanceTimersByTime(1000);
    expect(runs).toBe(1);
    await settle();
    expect(runs).toBe(2); // 不再追加150ms
    expect(scheduler.stats().pending).toBe(false);
    await settle();
  });

  it("慢编译期间持续编辑只消费最终快照，不堆逐键队列或追加去抖", async () => {
    let revision = 0;
    let active = 0;
    let maxActive = 0;
    let finish!: () => void;
    const snapshots: number[] = [];
    const slow = createDocumentCompileScheduler({
      debounceMs: 30,
      maxWaitMs: 100,
      run: () => {
        snapshots.push(revision);
        maxActive = Math.max(maxActive, ++active);
        return new Promise<void>((resolve) => {
          finish = () => {
            active--;
            resolve();
          };
        });
      },
    });
    try {
      const first = slow.requestNow("context");
      for (revision = 1; revision <= 24; revision++) {
        slow.request("edit");
        vi.advanceTimersByTime(20);
        expect(slow.stats().pending).toBe(true);
        expect(snapshots).toEqual([0]);
      }
      revision = 24;
      finish();
      await first;
      expect(snapshots).toEqual([0, 24]); // 已过首需求100ms，直接接上最后源码
      expect(maxActive).toBe(1);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(1000);
      expect(snapshots).toEqual([0, 24]);
      expect(slow.stats().pending).toBe(false);
      expect(slow.stats().inFlight).toBe(false);
    } finally {
      slow.dispose();
    }
  });

  it("短在途编译只等待输入去抖的剩余时间", async () => {
    scheduler.requestNow("context");
    scheduler.request("edit");
    vi.advanceTimersByTime(100);
    await settle();
    expect(runs).toBe(1);
    vi.advanceTimersByTime(49);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(2);
    await settle();
  });

  it("两种模式的输入策略独立，连续编辑仍单槽且合成不抢跑", async () => {
    let write = true;
    const starts: number[] = [];
    const fast = createDocumentCompileScheduler({
      debounceMs: () => (write ? 30 : 150),
      maxWaitMs: () => (write ? 100 : 300),
      run: async () => {
        starts.push(Date.now());
      },
    });
    try {
      const start = Date.now();
      fast.request("edit");
      await vi.advanceTimersByTimeAsync(30);
      expect(starts).toEqual([start + 30]);
      write = false;
      fast.request("edit");
      await vi.advanceTimersByTimeAsync(150);
      expect(starts).toEqual([start + 30, start + 180]);
      fast.setComposing(true);
      fast.request("edit");
      await vi.advanceTimersByTimeAsync(1000);
      expect(starts).toHaveLength(2);
      write = true;
      fast.setComposing(false);
      await vi.advanceTimersByTimeAsync(30);
      expect(starts).toHaveLength(3);
    } finally {
      fast.dispose();
    }
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
    scheduler.request("mode");
    scheduler.request("context");
    scheduler.request("edit");
    expect(scheduler.stats().pending).toBe(true);
    expect(scheduler.stats().reasons).toEqual(["mode", "context", "edit"]);
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
    const failing = createDocumentCompileScheduler({
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
