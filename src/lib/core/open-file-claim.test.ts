// `open-file` 接球规则的单测：有焦点的窗口接、没焦点时主窗口延迟兜底（队列空就放手）、
// 副窗口没焦点不抢、启动时就绪后只主窗口取一次、卸载取消还没落地的兜底。
// 定时器全注入（假定时器），不碰 Tauri / DOM。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_FILE_FALLBACK_DELAY_MS, createOpenFileClaim } from "./open-file-claim";
import type { OpenFileClaimHooks } from "./open-file-claim";

describe("createOpenFileClaim", () => {
  let focused: boolean;
  let focusError: boolean;
  let pending: string[];
  let takeError: boolean;
  /** 记下每一次"真正打开"的路径，按顺序 */
  let opened: string[];
  /** `takePending` 被调用的次数（队列取空 = "已被接走"的记号，次数也要对） */
  let takes: number;

  function make(overrides: Partial<OpenFileClaimHooks> = {}) {
    return createOpenFileClaim({
      isFocused: async () => {
        if (focusError) throw new Error("查询焦点失败");
        return focused;
      },
      isSecondaryWindow: false,
      // 契约：页面侧自己吞掉 invoke 失败并返回 null（不往上抛）
      takePending: async () => {
        takes += 1;
        if (takeError) return null;
        return pending.length > 0 ? pending[pending.length - 1] : null;
      },
      openPath: (path) => {
        opened.push(path);
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    focusError = false;
    pending = [];
    takeError = false;
    opened = [];
    takes = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("有焦点：**立刻**打开广播里的路径，并把待打开队列取空（= 告诉主窗口「已经有人接了」）", async () => {
    pending = ["/tmp/别人的.typ"];
    const claim = make();
    await claim.onBroadcast("/tmp/双击的.typ");
    expect(opened).toEqual(["/tmp/双击的.typ"]);
    expect(takes).toBe(1); // 队列被取空
    // 不排兜底：推进时间也不该再打开别的
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS * 2);
    expect(opened).toEqual(["/tmp/双击的.typ"]);
  });

  it("没焦点 + 主窗口：延迟兜底，兜底时队列里还有东西才打开（取最后一个 = 最新请求）", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/双击的.typ");
    expect(opened).toEqual([]); // 还没到兜底时刻
    pending = ["/tmp/旧.typ", "/tmp/新.typ"];
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual(["/tmp/新.typ"]);
  });

  it("没焦点 + 主窗口：兜底时队列**已空**（别的窗口接走了）→ 放手，不打开广播里的路径", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/双击的.typ");
    pending = []; // 有焦点的窗口已经把它取走了
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual([]); // 主窗口自己的会话不被别人的双击顶掉
  });

  it("没焦点 + **副窗口**：不抢也不兜底（交给主窗口）", async () => {
    focused = false;
    const claim = make({ isSecondaryWindow: true });
    await claim.onBroadcast("/tmp/双击的.typ");
    expect(takes).toBe(0);
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS * 3);
    expect(opened).toEqual([]);
  });

  it("连着两条广播（都没焦点）：只兜底**最后一次**", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/第一条.typ");
    pending = ["/tmp/两条.typ"];
    await claim.onBroadcast("/tmp/第二条.typ");
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(takes).toBe(1); // 前一条的定时器被取消
    expect(opened).toEqual(["/tmp/两条.typ"]);
  });

  it("焦点查询失败按「没有焦点」处理（主窗口延迟兜底，副窗口不抢）", async () => {
    focusError = true;
    const main = make();
    await main.onBroadcast("/tmp/x.typ");
    pending = ["/tmp/兜底.typ"];
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual(["/tmp/兜底.typ"]);

    opened = [];
    takes = 0;
    const secondary = make({ isSecondaryWindow: true });
    await secondary.onBroadcast("/tmp/x.typ");
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual([]);
  });

  it("队列取用失败（invoke 抛）当作「没有待打开文件」：兜底不打开、启动路径返回 false", async () => {
    focused = false;
    takeError = true;
    const claim = make();
    await claim.onBroadcast("/tmp/x.typ");
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual([]);
    await expect(claim.claimStartup()).resolves.toBe(false);
  });

  it("claimStartup：主窗口取到就打开并返回 true；队列空返回 false", async () => {
    pending = ["/tmp/启动参数.typ"];
    const claim = make();
    await expect(claim.claimStartup()).resolves.toBe(true);
    expect(opened).toEqual(["/tmp/启动参数.typ"]);

    pending = [];
    await expect(claim.claimStartup()).resolves.toBe(false);
    expect(opened).toEqual(["/tmp/启动参数.typ"]);
  });

  it("claimStartup：**副窗口不取**（草稿窗口不该被启动参数里的文件顶掉内容）", async () => {
    pending = ["/tmp/启动参数.typ"];
    const claim = make({ isSecondaryWindow: true });
    await expect(claim.claimStartup()).resolves.toBe(false);
    expect(takes).toBe(0);
    expect(opened).toEqual([]);
  });

  it("dispose：取消还没落地的兜底打开（关窗后不该再打开文件）", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/x.typ");
    pending = ["/tmp/兜底.typ"];
    claim.dispose();
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS * 2);
    expect(opened).toEqual([]);
    // dispose 之后再收到广播仍然照常工作（幂等，不留下坏状态）
    focused = true;
    await claim.onBroadcast("/tmp/y.typ");
    expect(opened).toEqual(["/tmp/y.typ"]);
  });
});
