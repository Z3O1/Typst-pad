// 公式渲染队列单元测试。
//
// 把五条"改起来很容易踩回去"的规则钉住：
//  ① 已缓存 / 已在队列的 key 不重复入队，整批无新增时连定时器都不排；
//  ② 写作模式下有挂着的整篇块编译时，把它往后推（公式先拿编译锁），源码模式不推；
//  ③ 缓存超限按插入顺序淘汰最早的（被淘汰的再请求会重新编译）；
//  ④ 失败也进缓存（不反复重试），但只有成功才自增版本号；
//  ⑤ 请求自带上下文编译失败时退回"仅前缀"再试一次（两者相同则不重试）。
import { describe, it, expect } from "vitest";
import {
  MATH_CACHE_LIMIT,
  MATH_COMPILE_HEADSTART_MS,
  MATH_DEBOUNCE_MS,
  createMathQueue,
  type MathQueueHooks,
} from "./math-queue";
import type { MathRequest } from "./live-preview";
import type { MathRender } from "./typst-engine";

const req = (key: string, over: Partial<MathRequest> = {}): MathRequest => ({
  key,
  body: key,
  display: false,
  context: "文档上下文",
  sizePt: 10.5,
  ...over,
});

const okRender = (): MathRender => ({
  ok: true,
  svg: "<svg/>",
  widthPt: 10,
  heightPt: 8,
  baselinePt: 6,
});
const failRender = (): MathRender => ({
  ok: false,
  svg: "",
  widthPt: 0,
  heightPt: 0,
  baselinePt: 0,
  error: "公式有语法错误",
});

function harness(over: Partial<MathQueueHooks> = {}) {
  const compiled: Array<{ key: string; context: string }> = [];
  const logs: string[] = [];
  const calls: string[] = [];
  let timer: (() => Promise<void>) | undefined;
  let scheduleCount = 0;
  let scheduledMs: number | undefined;
  let bumps = 0;
  let renders: MathRender[] = [];

  const hooks: MathQueueHooks = {
    compile: async (r) => {
      compiled.push({ key: r.key, context: r.context });
      calls.push(`compile:${r.key}:${r.context}`);
      return renders.shift() ?? okRender();
    },
    isWriteMode: () => true,
    hasPendingBlockCompile: () => true,
    rescheduleBlockCompile: (ms) => calls.push(`reschedule:${ms}`),
    prefixContext: () => "仅前缀",
    bumpVersion: () => {
      bumps++;
    },
    log: (message) => logs.push(message),
    schedule: (fn, ms) => {
      scheduleCount++;
      scheduledMs = ms;
      timer = fn;
      return 7;
    },
    clearTimer: () => {
      timer = undefined;
    },
    ...over,
  };

  return {
    queue: createMathQueue(hooks),
    compiled,
    logs,
    calls,
    /** 定时器排过几次（"整批无新增时不排定时器"靠它判定） */
    get scheduleCount() {
      return scheduleCount;
    },
    get scheduledMs() {
      return scheduledMs;
    },
    get bumps() {
      return bumps;
    },
    /** 让页面注入的下一条编译结果按序返回 */
    pushRender: (...r: MathRender[]) => {
      renders = r;
    },
    /** 跑掉排着的定时器（模拟去抖时间到） */
    flush: async () => {
      const fn = timer;
      timer = undefined;
      await fn?.();
    },
    get hasTimer() {
      return timer !== undefined;
    },
  };
}

describe("request：入队与去重", () => {
  it("整批无新增：不排定时器（编辑器每次重整装饰都把这批报一遍）", () => {
    const h = harness();
    h.queue.request([]);
    expect(h.scheduleCount).toBe(0);
    expect(h.hasTimer).toBe(false);
  });

  it("新公式入队：按去抖时长排一次定时器", () => {
    const h = harness();
    h.queue.request([req("a"), req("b")]);
    expect(h.scheduleCount).toBe(1);
    expect(h.scheduledMs).toBe(MATH_DEBOUNCE_MS);
  });

  it("同一批里重复的 key 只入队一次", async () => {
    const h = harness();
    h.queue.request([req("a"), req("a")]);
    await h.flush();
    expect(h.compiled.map((c) => c.key)).toEqual(["a"]);
  });

  it("已缓存的 key 不再入队、也不重排定时器", async () => {
    const h = harness();
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.scheduleCount).toBe(1);
    h.queue.request([req("a")]);
    expect(h.scheduleCount).toBe(1); // 无新增 → 连定时器都不排
    expect(h.compiled).toHaveLength(1);
  });

  it("已在队列里的 key 不重复入队（去抖窗口内重复请求）", async () => {
    const h = harness();
    h.queue.request([req("a")]);
    h.queue.request([req("a")]);
    expect(h.scheduleCount).toBe(1); // 第二次没有新增 → 不重排
    await h.flush();
    expect(h.compiled.map((c) => c.key)).toEqual(["a"]);
  });

  it("连续两批新公式：各自排一次定时器，第一批照旧落地", async () => {
    const h = harness();
    h.queue.request([req("a")]);
    const first = h.flush();
    h.queue.request([req("b")]);
    await first;
    await h.flush();
    expect(h.compiled.map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("一次请求多条：按入队顺序逐条编译", async () => {
    const h = harness();
    h.queue.request([req("a"), req("b"), req("c")]);
    await h.flush();
    expect(h.compiled.map((c) => c.key)).toEqual(["a", "b", "c"]);
  });
});

describe("公式优先：把挂着的整篇块编译往后推", () => {
  it("写作模式 + 有挂着的块编译 → 推到 MATH_COMPILE_HEADSTART_MS", () => {
    const h = harness();
    h.queue.request([req("a")]);
    expect(h.calls).toContain(`reschedule:${MATH_COMPILE_HEADSTART_MS}`);
  });

  it("源码模式：不推（那边没有块编译，整页预览不抢锁）", () => {
    const h = harness({ isWriteMode: () => false });
    h.queue.request([req("a")]);
    expect(h.calls.filter((c) => c.startsWith("reschedule"))).toEqual([]);
  });

  it("没有挂着的块编译：不推（否则会凭空排一次编译）", () => {
    const h = harness({ hasPendingBlockCompile: () => false });
    h.queue.request([req("a")]);
    expect(h.calls.filter((c) => c.startsWith("reschedule"))).toEqual([]);
  });

  it("整批无新增（全是缓存命中）时不推：不打扰正在跑的块编译", async () => {
    const h = harness();
    h.queue.request([req("a")]);
    await h.flush();
    const pushes = h.calls.filter((c) => c.startsWith("reschedule")).length;
    h.queue.request([req("a")]);
    expect(h.calls.filter((c) => c.startsWith("reschedule")).length).toBe(pushes);
  });
});

describe("渲染结果：缓存、版本号、日志", () => {
  it("成功：进缓存 + 自增版本号 + 日志带 ok/display", async () => {
    const h = harness();
    h.queue.request([req("a", { display: true })]);
    await h.flush();
    expect(h.bumps).toBe(1);
    expect(h.logs).toEqual(['math ok display "a"']);
  });

  it("失败：也进缓存（不反复重试），但**不自增版本号**", async () => {
    const h = harness();
    // 两次都失败：第一次（文档上下文）+ 兜底一次（仅前缀），免得兜底那步拿到默认的成功结果
    h.pushRender(failRender(), failRender());
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.bumps).toBe(0);
    expect(h.logs).toEqual(['math fail inline "a"']);
    // 再请求同一个 key：缓存命中，不再编译（说明失败结果确实留在缓存里）
    const before = h.compiled.length;
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.compiled).toHaveLength(before);
  });
});

describe("上下文兜底：请求自带上下文失败 → 仅前缀再试一次", () => {
  it("第一次失败、兜底成功：用兜底结果（版本号照增）", async () => {
    const h = harness();
    h.pushRender(failRender(), okRender());
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.compiled).toEqual([
      { key: "a", context: "文档上下文" },
      { key: "a", context: "仅前缀" },
    ]);
    expect(h.bumps).toBe(1);
    expect(h.logs).toEqual(['math ok inline "a"']);
  });

  it("两次都失败：不重试第三次，结果为失败（版本号不动）", async () => {
    const h = harness();
    h.pushRender(failRender(), failRender());
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.compiled).toHaveLength(2);
    expect(h.bumps).toBe(0);
  });

  it("请求上下文本来就是「仅前缀」：不重复编译同一份", async () => {
    const h = harness();
    h.pushRender(failRender());
    h.queue.request([req("a", { context: "仅前缀" })]);
    await h.flush();
    expect(h.compiled).toEqual([{ key: "a", context: "仅前缀" }]);
  });
});

describe("缓存上限", () => {
  it(`超过 ${MATH_CACHE_LIMIT} 条按插入顺序淘汰最早的：再请求会重新编译`, async () => {
    const h = harness();
    const many = Array.from({ length: MATH_CACHE_LIMIT + 1 }, (_, i) => req(`k${i}`));
    h.queue.request(many);
    await h.flush();
    expect(h.compiled).toHaveLength(MATH_CACHE_LIMIT + 1);
    // k0 已被淘汰 → 重新请求时会再编译一次（说明它不在缓存里）
    h.queue.request([req("k0")]);
    await h.flush();
    expect(h.compiled.filter((c) => c.key === "k0")).toHaveLength(2);
    // 最后一条仍在缓存里 → 不会再编译
    h.queue.request([req(`k${MATH_CACHE_LIMIT}`)]);
    await h.flush();
    expect(h.compiled.filter((c) => c.key === `k${MATH_CACHE_LIMIT}`)).toHaveLength(1);
  });
});

describe("reset：文档切换", () => {
  it("缓存与队列作废、定时器取消、版本号自增一次（通知编辑器丢掉公式装饰）", async () => {
    const h = harness();
    h.queue.request([req("a")]);
    h.queue.reset();
    expect(h.hasTimer).toBe(false);
    expect(h.bumps).toBe(1);
    await h.flush(); // 队列已空：什么也不做
    expect(h.compiled).toEqual([]);
    // 缓存已清 → 同一个 key 会重新编译
    h.queue.request([req("a")]);
    await h.flush();
    expect(h.compiled.map((c) => c.key)).toEqual(["a"]);
  });
});
