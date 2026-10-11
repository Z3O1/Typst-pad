// 缩放编排层单元测试（createZoomController）。
//
// 这一层的三条红线**只有真机能撞出来**（引擎接受/不接受、量歪了、旧复核把新档位拉回），
// 所以这里用假时钟 + 假宽度 + 假 dpr + 假引擎把它们变成可判定的断言：
//   ① 只观察、绝不改档（0.8.0 用户取舍）；
//   ② 沉降窗口内 resize 不重校 100% 基准（用户第五次反馈「未生效」的根因）；
//   ③ 新复核一开始，旧复核立刻作废（否则旧读数会把新档位拉回）。
//
// 假环境的语义要和页面一致：`getLevel()` 就是页面里的 uiZoom —— 用户改档时**先**变它、
// 再让 `$effect` 调 apply()，所以测试里先 setLevel 再 apply。
import { describe, it, expect } from "vitest";
import { createZoomController, type ZoomControllerHooks } from "./zoom-controller";
import { ZOOM_CONFIRM_DELAY_MS, ZOOM_DEFAULT, ZOOM_SETTLE_MAX_MS } from "./zoom";

interface Harness {
  c: ReturnType<typeof createZoomController>;
  calls: { sets: number[]; status: string[]; logs: string[]; levels: number[] };
  level(): number;
  setLevel(z: number): void;
  setWidth(w: number): void;
  setDpr(d: number): void;
  advance(ms: number): void;
  pendingTimers(): number;
  runTimers(): void;
  /** 只排空微任务（不放行 sleep）：让 apply 跑到"注册确认定时器"那一步 */
  drain(): Promise<void>;
  /** 放行当前挂着的 sleep 一次 + 排空微任务（复核会往前走一格，但不会走完） */
  flushOnce(): Promise<void>;
  /** 反复放行 sleep 直到没有新的：复核全部跑完 */
  flush(): Promise<void>;
}

async function drainMicrotasks(rounds = 40) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** 假时钟 + 假 DOM；`manualSleep` 让 sleep 变成可控闸门（用来制造"两次复核重叠"） */
function harness(over: Partial<ZoomControllerHooks> = {}, manualSleep = false): Harness {
  let level = ZOOM_DEFAULT;
  let width = 1000;
  let dpr = 2;
  let now = 0;
  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sleepers: (() => void)[] = [];
  const calls = {
    sets: [] as number[],
    status: [] as string[],
    logs: [] as string[],
    levels: [] as number[],
  };

  const hooks: ZoomControllerHooks = {
    enabled: () => true,
    getLevel: () => level,
    requestLevel: (z) => {
      level = z;
      calls.levels.push(z);
    },
    setStatus: (t) => {
      calls.status.push(t);
    },
    setWebviewZoom: async (z) => {
      calls.sets.push(z);
      width = 1000 / z;
      dpr = 2 * z;
    },
    layoutWidth: () => width,
    devicePixelRatio: () => dpr,
    isFakeZoom: () => false,
    now: () => now,
    sleep: manualSleep ? () => new Promise<void>((r) => sleepers.push(r)) : async () => {},
    nextFrame: async () => {},
    setTimer: (fn, ms) => {
      const id = ++timerSeq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    log: (m) => {
      calls.logs.push(m);
    },
    ...over,
  };

  const releaseSleepers = () => {
    const pending = sleepers.splice(0, sleepers.length);
    for (const r of pending) r();
  };

  return {
    c: createZoomController(hooks),
    calls,
    level: () => level,
    setLevel: (z) => {
      level = z;
    },
    setWidth: (w) => {
      width = w;
    },
    setDpr: (d) => {
      dpr = d;
    },
    advance: (ms) => {
      now += ms;
    },
    pendingTimers: () => timers.size,
    runTimers: () => {
      for (const [id, t] of [...timers]) {
        timers.delete(id);
        t.fn();
      }
    },
    drain: () => drainMicrotasks(),
    flushOnce: async () => {
      // 先让代码跑到下一个闸门（注册 sleeper），再放行它 —— 顺序反了就什么都没放行
      await drainMicrotasks();
      releaseSleepers();
      await drainMicrotasks();
    },
    flush: async () => {
      for (let i = 0; i < 40; i++) {
        releaseSleepers();
        await drainMicrotasks(4);
      }
    },
  };
}

describe("apply：校准 + 确认 + 收敛", () => {
  it("非 Tauri 环境（enabled=false）什么都不做", async () => {
    const h = harness({ enabled: () => false });
    await h.c.apply(1.5);
    expect(h.calls.sets).toEqual([]);
    expect(h.calls.levels).toEqual([]);
  });

  it("初次存档缩放直接请求目标档位，基准不写入100%", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    expect(h.calls.sets).toEqual([1.5]);
    expect(h.c.debugState()).toMatchObject({ baseline100: 1000, dprAt100: 2, appliedZoom: 1.5 });
    h.setLevel(1.3);
    await h.c.apply(1.3);
    expect(h.calls.sets).toEqual([1.5, 1.3]); // 校准不再写引擎
  });

  it("目标档位由 clampZoom 收敛到 0.5 ~ 2.5", async () => {
    const h = harness();
    h.setLevel(2.5);
    await h.c.apply(9);
    expect(h.calls.sets.at(-1)).toBe(2.5);
    h.setLevel(0.5);
    await h.c.apply(0.01);
    expect(h.calls.sets.at(-1)).toBe(0.5);
  });

  it("确认只观察，不再次写引擎", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    expect(h.pendingTimers()).toBe(1);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.sets).toEqual([1.5]);
  });

  it("连续调档只保留最后一次确认（重复调用只留一个定时器）", async () => {
    const h = harness();
    h.setLevel(1.1);
    await h.c.apply(1.1);
    h.setLevel(1.2);
    await h.c.apply(1.2);
    expect(h.pendingTimers()).toBe(1);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.sets).toEqual([1.1, 1.2]);
  });

  it("校准失败不影响后续（记日志、不抛）", async () => {
    const h = harness({
      setWebviewZoom: async () => {
        throw new Error("引擎不在");
      },
    });
    await expect(h.c.apply(1.5)).resolves.toBeUndefined();
    expect(h.calls.logs.some((l) => l.includes("校准失败") || l.includes("setZoom failed"))).toBe(
      true,
    );
  });
});

describe("红线①：只观察、绝不改档", () => {
  it("引擎没接受（布局宽度不变）：只写一句状态栏说明，档位一动不动", async () => {
    const h = harness({ setWebviewZoom: async () => {} });
    await h.c.apply(1); // 已知当前读数基准；下一请求被拒绝。
    h.setLevel(1.5);
    await h.c.apply(1.5);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.status).toHaveLength(1);
    expect(h.calls.status[0]).toContain("150%");
    expect(h.calls.levels).toEqual([]); // 没有写回档位（这就是"软件别自己动"）
    expect(h.calls.sets).toEqual([]); // 覆盖的拒绝引擎不记录；档位不被回改
  });

  it("引擎接受（布局宽度按档位变化）：什么都不说", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    h.setWidth(1000 / 1.5);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.status).toEqual([]);
    expect(h.calls.levels).toEqual([]);
  });

  it("宽度判据读不出来、dpr 判据看得见 → 也算观察到了（不误报）", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    h.setWidth(1000); // 宽度没变（真机上量歪的那种）
    h.setDpr(3); // dpr / dprAt100 = 3 / 2 = 1.5
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.status).toEqual([]);
  });

  it("假引擎（浏览器桩的 fakeZoom）不做复核：不写任何说明", async () => {
    const h = harness({ isFakeZoom: () => true });
    h.setLevel(1.5);
    await h.c.apply(1.5);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    expect(h.calls.status).toEqual([]);
  });

  it("复核结束会收尾：沉降窗口清零、不再算「复核在跑」", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.flush();
    const st = h.c.debugState();
    expect(st.verifyInFlight).toBe(false);
    expect(st.settlingUntil).toBe(0);
  });
});

describe("红线②：沉降窗口内 resize 不重校 100% 基准", () => {
  it("改档后的 resize 被跳过；窗口过了才按当前档位重校", async () => {
    const h = harness();
    h.setLevel(1.5);
    await h.c.apply(1.5);
    expect(h.c.debugState().baseline100).toBe(1000);

    h.setWidth(800);
    h.c.onResize();
    expect(h.c.debugState().baseline100).toBe(1000); // 沉降窗口内：跳过（否则判据被自己带偏）

    h.advance(ZOOM_SETTLE_MAX_MS + 1);
    h.c.onResize();
    expect(h.c.debugState().baseline100).toBe(800 * 1.5); // 用户拖过窗口：按当前档位重校
  });

  it("复核在跑时也不重校（哪怕沉降窗口已过）", async () => {
    const h = harness({}, true); // 手动 sleep：把复核卡在半路
    h.setLevel(1.5);
    const p = h.c.apply(1.5);
    await h.flushOnce(); // 校准的 sleep(90) 放行 → set(1.5) → 注册确认定时器
    expect(h.pendingTimers()).toBe(1);
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.drain(); // 不放行测量，复核仍在跑
    expect(h.c.debugState().verifyInFlight).toBe(true);

    h.advance(ZOOM_SETTLE_MAX_MS + 1); // 沉降窗口已过，但复核还在跑
    h.setWidth(800);
    h.c.onResize();
    expect(h.c.debugState().baseline100).toBe(1000);
    await h.flush();
    await p;
  });
});

describe("红线③：新复核一开始，旧复核立刻作废", () => {
  it("第二次改档后，第一次复核的读数不许写进状态栏", async () => {
    const h = harness({}, true); // 手动 sleep 才能制造"两次复核重叠"
    h.setLevel(1.5);
    const p1 = h.c.apply(1.5);
    await h.flushOnce();
    expect(h.pendingTimers()).toBe(1);
    h.setWidth(1000);
    h.setDpr(2); // 模拟引擎随后回到旧读数
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers();
    await h.drain(); // 复核 #1 卡在测量
    expect(h.c.debugState().verifyInFlight).toBe(true);

    h.setLevel(2);
    const p2 = h.c.apply(2);
    await h.drain();
    h.advance(ZOOM_CONFIRM_DELAY_MS);
    h.runTimers(); // 复核 #2 开始 → verifySeq 自增，作废 #1
    await h.drain(); // 先让复核 #2 真的跑起来（verifySeq 自增）
    h.setWidth(1000 / 2); // 让 #2 看到"引擎接受了 200%"
    await h.flush();
    await p1;
    await p2;

    // #1 的读数（宽度没变 → 本该写"未生效"）被作废，#2 观察成功也没写 → 状态栏一句话都没有
    expect(h.calls.status).toEqual([]);
    expect(h.calls.levels).toEqual([]);
  });
});

describe("最新目标与异步校准", () => {
  it("校准等待期间连续改档没有100%或旧目标回写", async () => {
    const h = harness({}, true);
    h.setLevel(1.5);
    const first = h.c.apply(1.5);
    await h.drain();
    h.setLevel(1.6);
    const second = h.c.apply(1.6);
    h.setLevel(1.7);
    const last = h.c.apply(1.7);
    await h.flush();
    await Promise.all([first, second, last]);
    h.runTimers();
    await h.flush();
    expect(h.calls.sets).toEqual([1.5, 1.7]);
    expect(h.c.debugState()).toMatchObject({ appliedZoom: 1.7, baseline100: 1000 });
    expect(h.calls.levels).toEqual([]);
  });

  it("延迟引擎写入串行，中间目标合并且最后请求落地", async () => {
    const calls: number[] = [];
    const gates: (() => void)[] = [];
    const h = harness({
      setWebviewZoom: (z) => {
        calls.push(z);
        return new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    h.setLevel(1.2);
    const first = h.c.apply(1.2);
    h.setLevel(1.3);
    const second = h.c.apply(1.3);
    h.setLevel(1.4);
    const last = h.c.apply(1.4);
    expect(calls).toEqual([1.2]);
    gates.shift()!();
    await h.drain();
    expect(calls).toEqual([1.2, 1.4]);
    gates.shift()!();
    await Promise.all([first, second, last]);
    h.runTimers();
    await h.flush();
    expect(calls).toEqual([1.2, 1.4]);
    expect(h.c.debugState().appliedZoom).toBe(1.4);
  });

  it("排空引擎队列与finally之间收到的目标仍会执行", async () => {
    let trigger = false;
    let h: Harness;
    h = harness({
      setTimer: () => {
        if (trigger) {
          trigger = false;
          queueMicrotask(() => {
            void h.c.apply(1.8);
          });
        }
        return 1;
      },
    });
    await h.c.apply(1.5);
    trigger = true;
    await h.c.apply(1.7);
    await h.flush();
    expect(h.calls.sets).toEqual([1.5, 1.7, 1.8]);
    expect(h.c.debugState().appliedZoom).toBe(1.8);
    h.c.dispose();
  });

  it("超过沉降上限仍在等待引擎时，真实resize不污染旧基准", async () => {
    let release: (() => void) | undefined;
    let delayed = false;
    const h = harness({
      setWebviewZoom: () =>
        delayed
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
    });
    await h.c.apply(1);
    const baseline = h.c.debugState().baseline100;
    delayed = true;
    const apply = h.c.apply(1.5);
    h.advance(ZOOM_SETTLE_MAX_MS + 100);
    h.setWidth(700);
    h.c.onResize();
    expect(h.c.debugState().baseline100).toBe(baseline);
    release!();
    await apply;
    h.c.dispose();
  });

  it("拒绝写入后可重新请求当前档，确认不会偷偷重试", async () => {
    const sets: number[] = [];
    let rejected = true;
    const h = harness({
      setWebviewZoom: async (z) => {
        sets.push(z);
        if (rejected) throw Error("拒绝");
      },
    });
    h.setLevel(1.7);
    await h.c.apply(1.7);
    h.runTimers();
    await h.flush();
    expect(sets).toEqual([1.7]);
    rejected = false;
    h.c.reapply();
    await h.flush();
    h.runTimers();
    await h.flush();
    expect(sets).toEqual([1.7, 1.7]);
    expect(h.calls.levels).toEqual([]);
  });

  it("销毁使等待中的校准/确认作废", async () => {
    const h = harness({}, true);
    const applied = h.c.apply(1.8);
    await h.drain();
    h.c.dispose();
    await h.flush();
    await applied;
    await h.c.apply(1.9);
    expect(h.calls.sets).toEqual([1.8]);
    expect(h.pendingTimers()).toBe(0);
  });
});

describe("滚轮余量与键盘调档", () => {
  it("40px 一格不足一档：不动档位，不显示内部累计细节", () => {
    const h = harness();
    expect(h.c.wheel(-40, 0, 0)).toBe(false);
    expect(h.calls.levels).toEqual([]);
    expect(h.calls.status).toEqual([]);
  });

  it("再滚一格凑够一档：请求 +10%（滚轮向上 = 放大）", () => {
    const h = harness();
    h.c.wheel(-40, 0, 0);
    expect(h.c.wheel(-40, 0, 0)).toBe(true);
    expect(h.calls.levels).toEqual([1.1]);
  });

  it("往下滚是缩小", () => {
    const h = harness();
    expect(h.c.wheel(100, 0, 0)).toBe(true);
    expect(h.calls.levels).toEqual([0.9]);
  });

  it("反向滚动丢掉余量（不粘手）", () => {
    const h = harness();
    h.c.wheel(-40, 0, 0); // +0.4 档
    expect(h.c.wheel(40, 0, 0)).toBe(false); // 反向：丢掉 +0.4，只攒 -0.4
    expect(h.calls.levels).toEqual([]);
  });

  it("滚轮事件计数进诊断文案（区分'事件没到页面'与'引擎没动'）", () => {
    const h = harness();
    h.c.wheel(-40, 0, 0);
    h.c.wheel(40, 0, 0);
    expect(h.c.debugState().wheelEvents).toBe(2);
  });

  it("step() / resetWheel() 丢掉滚轮余量（键盘调档没有半格）", () => {
    const h = harness();
    h.c.wheel(-40, 0, 0); // 攒 0.4
    h.c.step(1);
    expect(h.calls.levels).toEqual([1.1]);
    h.c.wheel(-40, 0, 0); // 余量已丢：这一格不足以走档
    expect(h.calls.levels).toEqual([1.1]);

    h.c.resetWheel();
    h.c.step(-1);
    expect(h.calls.levels).toEqual([1.1, 1]);
  });

  it("横向位移（Shift 滚轮把纵向转成横向）也参与换算", () => {
    const h = harness();
    expect(h.c.wheel(0, -100, 0)).toBe(true);
    expect(h.calls.levels).toEqual([1.1]);
  });

  it("请求改档走 requestLevel（档位由页面落地，控制器不自己写）", () => {
    const h = harness();
    h.c.wheel(-100, 0, 0);
    expect(h.calls.levels).toEqual([1.1]);
    expect(h.level()).toBe(1.1);
  });
});

describe("reapply：回到前台时把当前档位再设一遍", () => {
  it("真引擎：按当前档位再 apply 一次", async () => {
    const h = harness();
    h.setLevel(1.2);
    await h.c.apply(1.2);
    h.calls.sets.length = 0;
    h.c.reapply();
    await h.flush();
    expect(h.calls.sets[0]).toBe(1.2); // 校准已缓存，直接就是当前档位
  });

  it("假引擎：什么都不做（桩的 setZoom 是假的）", async () => {
    const h = harness({ isFakeZoom: () => true });
    h.c.reapply();
    await h.flush();
    expect(h.calls.sets).toEqual([]);
  });
});
