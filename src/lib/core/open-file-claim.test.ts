// `open-file` 接球规则的单测：有焦点的窗口接（并把队列取空）、没焦点时主窗口延迟兜底（队列空就放手）、
// 副窗口没焦点不抢、启动时就绪后只主窗口取一次、关窗取消还没落地的兜底。
// 定时器用 vitest 的假定时器（模块直接用全局 `setTimeout`，与 `math-queue` 同一套路），不碰 Tauri / DOM。
//
// 夹具里的 `pending` 是**真队列**：`takePending` 会把数组交出去并清空，所以"取走即认领"这个记号
// 在断言里看得见（取哪一条由模块的 `lastPending` 决定）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_FILE_FALLBACK_DELAY_MS, createOpenFileClaim, lastPending } from "./open-file-claim";
import type { OpenFileClaimHooks } from "./open-file-claim";

describe("lastPending", () => {
  it("取队列里的**最后一个**（最新一次请求）；空队列返回 null", () => {
    expect(lastPending(["/tmp/旧.typ", "/tmp/新.typ"])).toBe("/tmp/新.typ");
    expect(lastPending(["/tmp/唯一.typ"])).toBe("/tmp/唯一.typ");
    expect(lastPending([])).toBeNull();
  });
});

describe("createOpenFileClaim", () => {
  let focused: boolean;
  let focusError: boolean;
  /** 待打开队列（夹具会真的把它取空） */
  let pending: string[];
  let takeError: boolean;
  /** 记下每一次"真正打开"的路径，按顺序 */
  let opened: string[];
  /** `takePending` 被调用的次数（"取走即认领"的记号，次数也要对） */
  let takes: number;

  function make(overrides: Partial<OpenFileClaimHooks> = {}) {
    return createOpenFileClaim({
      isFocused: async () => {
        if (focusError) throw new Error("查询焦点失败");
        return focused;
      },
      isSecondaryWindow: false,
      takePending: async () => {
        takes += 1;
        if (takeError) return [];
        const paths = pending;
        pending = []; // 取走 = 清空（Rust 侧 `take_pending_files` 也是这样）
        return paths;
      },
      openPath: (path) => {
        opened.push(String(path));
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
    expect(opened).toEqual(["/tmp/双击的.typ"]); // 用广播里的 path，不是队列里的
    expect(takes).toBe(1);
    expect(pending).toEqual([]); // 队列确实被取走了
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
    expect(takes).toBe(1); // 兜底真的查了队列
    expect(opened).toEqual(["/tmp/新.typ"]); // 队列里的**最后一条**，不是广播里的 path
    expect(pending).toEqual([]);
  });

  it("没焦点 + 主窗口：兜底时队列**已空**（别的窗口接走了）→ 放手，不打开广播里的路径", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/双击的.typ");
    pending = []; // 有焦点的窗口已经把它取走了
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(takes).toBe(1); // 查过了
    expect(opened).toEqual([]); // 但队列空 → 主窗口自己的会话不被别人的双击顶掉
  });

  it("没焦点 + **副窗口**：不抢也不兜底（交给主窗口）", async () => {
    focused = false;
    pending = ["/tmp/兜底.typ"]; // 故意留一条：若副窗口排了兜底，推进后就会打开它
    const claim = make({ isSecondaryWindow: true });
    await claim.onBroadcast("/tmp/双击的.typ");
    expect(takes).toBe(0);
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS * 3);
    expect(takes).toBe(0); // 推进之后也没有兜底去查队列
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

  it("焦点查询抛错 → 按「没有焦点」处理：主窗口延迟兜底", async () => {
    focusError = true;
    const claim = make();
    await claim.onBroadcast("/tmp/x.typ");
    pending = ["/tmp/兜底.typ"];
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual(["/tmp/兜底.typ"]);
  });

  it("焦点查询返回**非布尔**时按「没有焦点」处理（`undefined` 与 truthy 非 true 都算）", async () => {
    // undefined：桩/老版本可能这么返回
    const undefinedFocus = make({ isFocused: async () => undefined as unknown as boolean });
    await undefinedFocus.onBroadcast("/tmp/x.typ");
    pending = ["/tmp/兜底.typ"];
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual(["/tmp/兜底.typ"]);

    // **truthy 非 true**（比如 1）：只有 `=== true` 的收敛才会把它当"没有焦点"。
    // 直接透传 truthy 的实现会在这里当场打开广播路径 → 与"查询失败按没有焦点"的契约不符。
    opened = [];
    pending = [];
    const truthyFocus = make({ isFocused: async () => 1 as unknown as boolean });
    await truthyFocus.onBroadcast("/tmp/x.typ");
    expect(opened).toEqual([]); // 没当场打开（按没有焦点处理）
    pending = ["/tmp/兜底.typ"];
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual(["/tmp/兜底.typ"]);
  });

  it("焦点查询抛错 + 副窗口：不抢", async () => {
    focusError = true;
    pending = ["/tmp/兜底.typ"];
    const claim = make({ isSecondaryWindow: true });
    await claim.onBroadcast("/tmp/x.typ");
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(opened).toEqual([]);
  });

  it("队列取用失败（invoke 抛）当作「没有待打开文件」：兜底不打开、启动路径返回 false", async () => {
    focused = false;
    takeError = true;
    const claim = make();
    await claim.onBroadcast("/tmp/x.typ");
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS);
    expect(takes).toBe(1); // 查过了，只是没东西
    expect(opened).toEqual([]);
    await expect(claim.claimStartup()).resolves.toBe(false);
  });

  it("claimStartup：主窗口取到就打开并返回 true；队列空返回 false", async () => {
    pending = ["/tmp/旧.typ", "/tmp/启动参数.typ"];
    const claim = make();
    await expect(claim.claimStartup()).resolves.toBe(true);
    expect(opened).toEqual(["/tmp/启动参数.typ"]); // 同样是最后一个
    expect(pending).toEqual([]);

    await expect(claim.claimStartup()).resolves.toBe(false);
    expect(opened).toEqual(["/tmp/启动参数.typ"]);
  });

  it("claimStartup：**副窗口不取**（草稿窗口不该被启动参数里的文件顶掉内容）", async () => {
    pending = ["/tmp/启动参数.typ"];
    const claim = make({ isSecondaryWindow: true });
    await expect(claim.claimStartup()).resolves.toBe(false);
    expect(takes).toBe(0);
    expect(pending).toEqual(["/tmp/启动参数.typ"]); // 队列原样留着，交给主窗口
    expect(opened).toEqual([]);
  });

  it("dispose：取消还没落地的兜底打开（关窗后不该再打开文件），之后再广播仍照常工作", async () => {
    focused = false;
    const claim = make();
    await claim.onBroadcast("/tmp/x.typ");
    pending = ["/tmp/兜底.typ"];
    claim.dispose();
    await vi.advanceTimersByTimeAsync(OPEN_FILE_FALLBACK_DELAY_MS * 2);
    expect(opened).toEqual([]);
    expect(pending).toEqual(["/tmp/兜底.typ"]); // 兜底没去取，队列还留着

    // dispose 幂等，且之后仍能正常工作
    claim.dispose();
    focused = true;
    await claim.onBroadcast("/tmp/y.typ");
    expect(opened).toEqual(["/tmp/y.typ"]);
  });
});
