// error-list 错误列表组装纯函数单元测试（状态栏徽标弹窗的数据准备逻辑）
import { describe, it, expect } from "vitest";
import type { CompileErrorLocation } from "./typst-engine";
import {
  buildErrorListItems,
  formatErrorLoc,
  hasErrorToShow,
} from "./error-list";

/** 构造一个定位错误（1-based 行列；end 取下一字符，模拟单点错误） */
function loc(line: number, col: number, message = "错误消息"): CompileErrorLocation {
  return { message, line, col, endLine: line, endCol: col + 1 };
}

describe("buildErrorListItems", () => {
  it("仅定位错误：逐条转成 located 项", () => {
    const items = buildErrorListItems([loc(2, 5, "a"), loc(7, 1, "b")], null);
    expect(items).toEqual([
      { kind: "located", message: "a", line: 2, col: 5 },
      { kind: "located", message: "b", line: 7, col: 1 },
    ]);
  });

  it("仅非定位错误：非定位消息转成 generic 项", () => {
    const items = buildErrorListItems([], "package @preview/cetz:0.1.0 not found");
    expect(items).toEqual([
      { kind: "generic", message: "package @preview/cetz:0.1.0 not found" },
    ]);
  });

  it("定位 + 非定位混合：只展示定位错误（非定位与第一条同源，不重复）", () => {
    const items = buildErrorListItems([loc(1, 1, "x")], "同源错误消息");
    expect(items).toEqual([{ kind: "located", message: "x", line: 1, col: 1 }]);
  });

  it("空数组且无非定位错误：返回空列表（弹窗不可开）", () => {
    expect(buildErrorListItems([], null)).toEqual([]);
  });

  it("空字符串非定位错误视为不存在", () => {
    expect(buildErrorListItems([], "")).toEqual([]);
  });
});

describe("formatErrorLoc", () => {
  it("located 项显示「行 x, 列 y」", () => {
    expect(
      formatErrorLoc({ kind: "located", message: "m", line: 3, col: 12 }),
    ).toBe("行 3, 列 12");
  });

  it("generic 项显示 —", () => {
    expect(formatErrorLoc({ kind: "generic", message: "m" })).toBe("—");
  });
});

describe("hasErrorToShow", () => {
  it("0 且无非定位：不可点击", () => {
    expect(hasErrorToShow(0, null)).toBe(false);
    expect(hasErrorToShow(0, "")).toBe(false);
  });

  it("errorCount > 0：可点击", () => {
    expect(hasErrorToShow(2, null)).toBe(true);
    expect(hasErrorToShow(1, "某错误")).toBe(true);
  });

  it("0 但有非定位错误：可点击", () => {
    expect(hasErrorToShow(0, "package @preview/cetz:0.1.0 not found")).toBe(true);
  });
});
