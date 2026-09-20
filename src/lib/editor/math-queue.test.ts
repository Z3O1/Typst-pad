// 公式队列的单测：去重、防抖批量与重新计时、兜底重试、失败也进缓存、缓存上限、
// reset（含"作废在途批次"）、日志。
// 依赖全注入 + 假时钟，所以不需要 DOM/Tauri（与 `zoom-controller.test.ts` 同一套思路）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATH_CACHE_LIMIT, MATH_DEBOUNCE_MS, createMathQueue } from "./math-queue";
import type { MathRequest } from "./live-preview/options";
import type { MathRender } from "../core/typst-engine";

const req = (key: string, body = key): MathRequest => ({
  key,
  body,
  display: false,
  context: "ctx",
  sizePt: 10.5,
});

const ok = (svg = "<svg/>"): MathRender => ({
  ok: true,
  svg,
  widthPt: 10,
  heightPt: 5,
  baselinePt: 4,
});
const fail = (error = "坏了"): MathRender => ({
  ok: false,
  svg: "",
  widthPt: 0,
  heightPt: 0,
  baselinePt: 0,
  error,
});

describe("createMathQueue", () => {
  /** 渲染成功的回调次数（页面据此 `mathVersion++`） */
  let notified: number;
  let deferred: number;
  let logged: string[];

  function make(
    compile: (r: MathRequest, ctx: string) => Promise<MathRender>,
    opts: { limit?: number; fallback?: string } = {},
  ) {
    return createMathQueue({
      compile,
      fallbackContext: () => opts.fallback ?? "prefix-only",
      onRendered: () => {
        notified += 1;
      },
      deferBlockCompile: () => {
        deferred += 1;
      },
      log: (m) => logged.push(m),
      ...(opts.limit === undefined ? {} : { cacheLimit: opts.limit }),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    notified = 0;
    deferred = 0;
    logged = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("去重：同一个 key 连续请求两次只编译一次（第二次直接跳过）", async () => {
    const compile = vi.fn(async () => ok());
    const q = make(compile);
    q.handleRequest([req("a")]);
    q.handleRequest([req("a")]); // 还在队列里
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(1);
    // 渲染完再请求同一个 key：命中缓存，也不再编译
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(1);
    // 契约 2 的正向半边：成功要通知代次，且只通知一次
    expect(notified).toBe(1);
  });

  it("防抖批量：120ms 内的多次请求合并成一次 drain（一起编译）", async () => {
    const compile = vi.fn(async () => ok());
    const q = make(compile);
    q.handleRequest([req("a")]);
    expect(q.queued()).toBe(1);
    q.handleRequest([req("b")]);
    expect(q.queued()).toBe(2);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(q.queued()).toBe(0);
  });

  it("防抖是**重新计时**：窗口内又来一个请求，前面那个也要等满 120ms 才走", async () => {
    const compile = vi.fn(async () => ok());
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS - 20);
    q.handleRequest([req("b")]); // 只剩 20ms 时又来一个 → 定时器必须重置
    await vi.advanceTimersByTimeAsync(30); // 距 a 已 130ms（> 120），但距 b 只有 30ms
    expect(compile).not.toHaveBeenCalled();
    expect(q.queued()).toBe(2);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS); // 距 b 满了 → 一次性补齐
    expect(compile).toHaveBeenCalledTimes(2);
    expect(q.queued()).toBe(0);
  });

  it("首次失败 → 用「仅前缀」的兜底上下文重试，成功则用兜底结果", async () => {
    const compile = vi.fn(async (_r: MathRequest, ctx: string) =>
      ctx === "ctx" ? fail() : ok("<svg>fallback</svg>"),
    );
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(q.lookup("a")?.ok).toBe(true);
    expect(notified).toBe(1);
  });

  it("失败也进缓存（不反复重试），且**不通知代次**（装饰集没变，重建是白跑）", async () => {
    const compile = vi.fn(async () => fail());
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(q.lookup("a")?.ok).toBe(false);
    expect(notified).toBe(0);
    q.handleRequest([req("a")]); // 已缓存 → 不再请求
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2); // 只有那两次（首次 + 兜底）
  });

  it("首次与兜底都失败：缓存里留的是**首次**那份（兜底只是「再试一次」，不覆盖失败原因）", async () => {
    const compile = vi.fn(async (_r: MathRequest, ctx: string) =>
      ctx === "ctx" ? fail("首编错") : fail("兜底错"),
    );
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(q.lookup("a")?.error).toBe("首编错");
    expect(notified).toBe(0);
  });

  it("兜底上下文与请求上下文相同时**不重试**（`prefixEnabled=false` + 文档无 `#let` 时两者都是空串）", async () => {
    const compile = vi.fn(async () => fail());
    const q = make(compile, { fallback: "ctx" }); // 与 `req()` 的 context 相同
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(1); // 拿同一上下文再编一遍 = 白花一次 IPC
    expect(q.lookup("a")?.ok).toBe(false);
  });

  it("drain 进行中又来请求：同 key 不重复入队，新 key 另起一批", async () => {
    const resolvers: ((r: MathRender) => void)[] = [];
    const compile = vi.fn(() => new Promise<MathRender>((res) => resolvers.push(res)));
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1); // drain 已开始，卡在 a 的 await 上
    expect(compile).toHaveBeenCalledTimes(1);
    q.handleRequest([req("a")]); // 仍在 pending 里 → 跳过
    q.handleRequest([req("b")]); // 新 key → 入队 + 重新计时
    expect(q.queued()).toBe(1);
    resolvers[0](ok());
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2); // a 只编了一次（同 key 没重复入队），b 一次
    resolvers[1](ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(q.lookup("a")?.ok).toBe(true);
    expect(q.lookup("b")?.ok).toBe(true);
  });

  it("有公式入队时才推一次块编译（deferBlockCompile）", () => {
    const q = make(async () => ok());
    q.handleRequest([req("a")]);
    expect(deferred).toBe(1);
    q.handleRequest([req("b")]);
    expect(deferred).toBe(2);
    // 全都在缓存/队列里 → 没有新增 → 不推
    q.handleRequest([req("a"), req("b")]);
    expect(deferred).toBe(2);
  });

  it("缓存上限：超出后淘汰最早插入的条目（仍在视口内的会被编辑器重新请求）", async () => {
    const q = make(async () => ok(), { limit: 2 });
    for (const k of ["a", "b", "c"]) {
      q.handleRequest([req(k)]);
      await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    }
    expect(q.lookup("a")).toBeUndefined();
    expect(q.lookup("b")).toBeDefined();
    expect(q.lookup("c")).toBeDefined();
  });

  it("不传 cacheLimit 时真的按 MATH_CACHE_LIMIT 淘汰（常量本身是契约的一部分）", async () => {
    expect(MATH_CACHE_LIMIT).toBe(500);
    const q = make(async () => ok());
    const keys = Array.from({ length: MATH_CACHE_LIMIT + 1 }, (_, i) => `k${i}`);
    q.handleRequest(keys.map((k) => req(k)));
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(q.lookup("k0")).toBeUndefined(); // 最早那条被淘汰
    expect(q.lookup(`k${MATH_CACHE_LIMIT}`)).toBeDefined(); // 刚插入的那条还在
  });

  it("reset：缓存、队列、待渲染集合一起清掉（文档切换后 include 根与上下文都会变）", async () => {
    const compile = vi.fn(async () => ok());
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(q.lookup("a")).toBeDefined();

    q.handleRequest([req("b")]); // 入队但还没 drain
    q.reset();
    expect(q.lookup("a")).toBeUndefined();
    expect(q.queued()).toBe(0);
    // 定时器也被清掉：推进时间不会再编译
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS * 2);
    expect(compile).toHaveBeenCalledTimes(1);
    // reset 之后同一个 key 能重新入队（pending 也被清了）
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("reset 作废**在途**批次：晚到的结果不写回缓存、也不通知代次", async () => {
    let release!: (r: MathRender) => void;
    const compile = vi.fn(() => new Promise<MathRender>((res) => (release = res)));
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1); // drain 已开始，卡在 await
    q.reset(); // 此刻切了文档 / 改了字体
    release(ok("<svg>旧文档的渲染</svg>"));
    await vi.advanceTimersByTimeAsync(0);
    // 键里既没有文档路径也没有字体 → 这条脏数据一旦写回就会被编辑器**永远**命中
    expect(q.lookup("a")).toBeUndefined();
    expect(notified).toBe(0);
  });

  it("reset 之后同 key 重新入队：旧批次不得吃掉新登记的 pending 标记", async () => {
    const resolvers: ((r: MathRender) => void)[] = [];
    const compile = vi.fn(() => new Promise<MathRender>((res) => resolvers.push(res)));
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1); // drain#1 卡在 a
    q.reset();
    q.handleRequest([req("a")]); // 新文档里同一个公式：重新入队
    expect(q.queued()).toBe(1);
    resolvers[0](ok("<svg>旧文档的渲染</svg>")); // 旧批次现在才回来 → 只许被丢掉
    await vi.advanceTimersByTimeAsync(0);
    expect(q.lookup("a")).toBeUndefined();
    // 新一批照常跑（pending 标记还在，所以它此刻仍在队列里而不是被旧批次删掉）
    expect(q.queued()).toBe(1);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2); // 新一批真的又编了一次（没被旧批次吞掉）
    resolvers[1](ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(q.lookup("a")?.ok).toBe(true);
  });

  it("日志带 ok/fail 与风格（排障时靠它认公式）", async () => {
    const q = make(async () => fail());
    q.handleRequest([req("a", "x^2")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(logged.at(-1)).toBe('math fail inline "x^2"');
  });
});
