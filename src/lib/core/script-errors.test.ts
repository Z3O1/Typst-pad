// 脚本错误归类单元测试（状态栏「脚本错误」通道）
//
// 重点是 benign 白名单的两侧：Chromium 的两种 ResizeObserver 原文必须被放过（0.7.6 的红线），
// 而真正的脚本错误一个都不许被吞掉 —— 那会让"页面坏了但状态栏干净"。
import { describe, it, expect } from "vitest";
import {
  BENIGN_SCRIPT_ERRORS,
  isBenignScriptError,
  scriptErrorMessage,
  scriptErrorStatus,
} from "./script-errors";

describe("isBenignScriptError 白名单", () => {
  it("放过 Chromium 的两种 ResizeObserver 原文", () => {
    expect(isBenignScriptError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(
      isBenignScriptError("ResizeObserver loop completed with undelivered notifications."),
    ).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isBenignScriptError("RESIZEOBSERVER LOOP LIMIT EXCEEDED")).toBe(true);
  });

  it("真正的脚本错误不许放过", () => {
    expect(isBenignScriptError("Cannot read properties of undefined (reading 'line')")).toBe(false);
    expect(isBenignScriptError("CodeMirror plugin crashed")).toBe(false);
    expect(isBenignScriptError("")).toBe(false);
  });

  it("只是碰巧带 ResizeObserver 字样、但不是那条循环提示 → 不算 benign", () => {
    // 白名单的粒度就是"ResizeObserver loop"这半句；写成 /ResizeObserver/ 会把真 bug 一起吞掉
    expect(isBenignScriptError("ResizeObserver is not defined")).toBe(false);
  });

  it("白名单条目本身只有一个（别越加越宽）", () => {
    expect(BENIGN_SCRIPT_ERRORS).toHaveLength(1);
  });
});

describe("scriptErrorMessage 抠消息", () => {
  it("Error → message", () => {
    expect(scriptErrorMessage(new Error("炸了"))).toBe("炸了");
    expect(scriptErrorMessage(new TypeError("类型不对"))).toBe("类型不对");
  });

  it("字符串原样", () => {
    expect(scriptErrorMessage("纯字符串")).toBe("纯字符串");
  });

  it("其它类型 String(...)（含 undefined / null，保持既有行为）", () => {
    expect(scriptErrorMessage(42)).toBe("42");
    expect(scriptErrorMessage(undefined)).toBe("undefined");
    expect(scriptErrorMessage(null)).toBe("null");
    expect(scriptErrorMessage({ a: 1 })).toBe("[object Object]");
  });
});

describe("scriptErrorStatus", () => {
  it("状态栏文案带「脚本错误：」前缀", () => {
    expect(scriptErrorStatus("炸了")).toBe("脚本错误：炸了");
  });
});
