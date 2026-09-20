// 公式队列的单测：去重、防抖批量、失败兜底、失败也进缓存、缓存上限、reset。
// 依赖全注入 + 假时钟，所以不需要 DOM/Tauri（与 `zoom-controller.test.ts` 同一套思路）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATH_CACHE_LIMIT, MATH_DEBOUNCE_MS, createMathQueue } from "./math-queue";
import type { MathRequest } from "./live-preview";
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
const fail = (): MathRender => ({
  ok: false,
  svg: "",
  widthPt: 0,
  heightPt: 0,
  baselinePt: 0,
  error: "坏了",
});

describe("createMathQueue", () => {
  let rendered: boolean[];
  let deferred: number;
  let logged: string[];

  function make(compile: (r: MathRequest, ctx: string) => Promise<MathRender>, limit?: number) {
    return createMathQueue({
      compile,
      fallbackContext: () => "prefix-only",
      onRendered: (good) => rendered.push(good),
      deferBlockCompile: () => {
        deferred += 1;
      },
      log: (m) => logged.push(m),
      ...(limit === undefined ? {} : { cacheLimit: limit }),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    rendered = [];
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
    expect(rendered).toEqual([true]);
  });

  it("失败也进缓存（不反复重试），且**不通知代次**（装饰集没变，重建是白跑）", async () => {
    const compile = vi.fn(async () => fail());
    const q = make(compile);
    q.handleRequest([req("a")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(q.lookup("a")?.ok).toBe(false);
    expect(rendered).toEqual([]);
    q.handleRequest([req("a")]); // 已缓存 → 不再请求
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(compile).toHaveBeenCalledTimes(2); // 只有那两次（首次 + 兜底）
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
    const q = make(async () => ok(), 2);
    for (const k of ["a", "b", "c"]) {
      q.handleRequest([req(k)]);
      await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    }
    expect(q.lookup("a")).toBeUndefined();
    expect(q.lookup("b")).toBeDefined();
    expect(q.lookup("c")).toBeDefined();
  });

  it("缺省上限是 MATH_CACHE_LIMIT（常量本身是契约的一部分）", () => {
    expect(MATH_CACHE_LIMIT).toBe(500);
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

  it("日志带 ok/fail 与风格（排障时靠它认公式）", async () => {
    const q = make(async () => fail());
    q.handleRequest([req("a", "x^2")]);
    await vi.advanceTimersByTimeAsync(MATH_DEBOUNCE_MS + 1);
    expect(logged.at(-1)).toBe('math fail inline "x^2"');
  });
});
