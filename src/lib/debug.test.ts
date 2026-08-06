// debug.ts 纯逻辑单元测试：开关判定优先级 / 运行时补开 / 门控日志器行为。
import { describe, it, expect, vi } from "vitest";
import {
  debugEnabledFrom,
  enableDebug,
  createDebugLog,
  setCliDebug,
  dbg,
  DEBUG_STORAGE_KEY,
  type DebugEnv,
} from "./debug";

function env(over: Partial<DebugEnv>): DebugEnv {
  return {
    isDev: false,
    cliDebug: false,
    getLocalStorage: () => null,
    getUrlParam: () => null,
    ...over,
  };
}

describe("debugEnabledFrom（开关判定，优先级 dev > CLI > URL > localStorage）", () => {
  it("dev 构建默认开启（URL/localStorage/CLI 均为否也开启）", () => {
    expect(debugEnabledFrom(env({ isDev: true }))).toBe(true);
    expect(
      debugEnabledFrom(env({ isDev: true, getUrlParam: () => "0", getLocalStorage: () => "0" })),
    ).toBe(true);
  });

  it("无任何来源：关闭", () => {
    expect(debugEnabledFrom(env({}))).toBe(false);
  });

  it("命令行 --debug 标志（CLI 来源）开启", () => {
    expect(debugEnabledFrom(env({ cliDebug: true }))).toBe(true);
  });

  it("URL ?debug=1 开启；非 '1' 值不开启", () => {
    expect(debugEnabledFrom(env({ getUrlParam: (p) => (p === "debug" ? "1" : null) }))).toBe(true);
    expect(debugEnabledFrom(env({ getUrlParam: () => "0" }))).toBe(false);
    expect(debugEnabledFrom(env({ getUrlParam: () => "true" }))).toBe(false);
  });

  it("localStorage 'typst-pad:debug' === '1' 开启；'0'/其他值不开启", () => {
    expect(
      debugEnabledFrom(env({ getLocalStorage: (k) => (k === DEBUG_STORAGE_KEY ? "1" : null) })),
    ).toBe(true);
    expect(debugEnabledFrom(env({ getLocalStorage: () => "0" }))).toBe(false);
    expect(debugEnabledFrom(env({ getLocalStorage: () => "true" }))).toBe(false);
  });

  it("优先级：CLI 优先于 URL/localStorage（CLI 开启时 URL '0'/localStorage '0' 也开启）", () => {
    expect(
      debugEnabledFrom(
        env({ cliDebug: true, getUrlParam: () => "0", getLocalStorage: () => "0" }),
      ),
    ).toBe(true);
  });

  it("优先级：URL 优先于 localStorage（URL '1' + localStorage '0' → 开启）", () => {
    expect(
      debugEnabledFrom(env({ getUrlParam: () => "1", getLocalStorage: () => "0" })),
    ).toBe(true);
  });
});

describe("enableDebug（CLI 标志异步补开，只增不减）", () => {
  it("关闭 + CLI 标志 → 开启", () => {
    expect(enableDebug(false, true)).toBe(true);
  });
  it("已开启不受 CLI 关闭影响；全关仍关闭", () => {
    expect(enableDebug(true, false)).toBe(true);
    expect(enableDebug(false, false)).toBe(false);
  });
});

describe("createDebugLog（门控日志器）", () => {
  function fakeSink() {
    return {
      log: vi.fn(),
      group: vi.fn(),
      groupEnd: vi.fn(),
    } as unknown as Console;
  }

  it("关闭时：log/group/groupEnd 均不触碰 sink，enabled() 为 false", () => {
    const sink = fakeSink();
    const d = createDebugLog(() => false, sink);
    expect(d.enabled()).toBe(false);
    d.log("tag", "a", 1);
    d.group("g");
    d.groupEnd();
    expect(sink.log).not.toHaveBeenCalled();
    expect(sink.group).not.toHaveBeenCalled();
    expect(sink.groupEnd).not.toHaveBeenCalled();
  });

  it("开启时：log 带 [debug] 前缀与 tag 输出到 sink", () => {
    const sink = fakeSink();
    const d = createDebugLog(() => true, sink);
    expect(d.enabled()).toBe(true);
    d.log("compile", { a: 1 });
    expect(sink.log).toHaveBeenCalledWith("[debug] compile", { a: 1 });
  });

  it("开启时：group/groupEnd 同样带 [debug] 前缀", () => {
    const sink = fakeSink();
    const d = createDebugLog(() => true, sink);
    d.group("x");
    d.groupEnd();
    expect(sink.group).toHaveBeenCalledWith("[debug] x");
    expect(sink.groupEnd).toHaveBeenCalled();
  });

  it("开关函数每次调用时求值（运行时补开可生效）", () => {
    const sink = fakeSink();
    let on = false;
    const d = createDebugLog(() => on, sink);
    d.log("t", 1);
    expect(sink.log).not.toHaveBeenCalled();
    on = true; // 模拟 setCliDebug 后状态变化
    d.log("t", 2);
    expect(sink.log).toHaveBeenCalledWith("[debug] t", 2);
  });
});

describe("setCliDebug（单例运行时补开，只增不减）", () => {
  it("CLI 标志为 true 时补开；false 不关闭", () => {
    setCliDebug(true);
    expect(dbg.enabled()).toBe(true);
    setCliDebug(false);
    expect(dbg.enabled()).toBe(true);
  });
});
