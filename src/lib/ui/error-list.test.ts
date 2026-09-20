// error-list 错误列表组装 + 前缀定位纯函数单元测试（状态栏徽标弹窗 / 前缀错误定位）
import { describe, it, expect } from "vitest";
import type { CompileErrorLocation } from "../core/typst-engine";
import {
  buildErrorListItems,
  formatErrorLoc,
  formatDiagnosticForClipboard,
  formatDiagnosticListForClipboard,
  hasErrorToShow,
  prefixLineCharOffset,
  prefixLineCount,
  isErrorLineInPrefix,
  formatCompileFailMessage,
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
    expect(items).toEqual([{ kind: "generic", message: "package @preview/cetz:0.1.0 not found" }]);
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
    expect(formatErrorLoc({ kind: "located", message: "m", line: 3, col: 12 })).toBe("行 3, 列 12");
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

describe("prefixLineCount / isErrorLineInPrefix", () => {
  const multi = '#set page(width: 10cm)\n#set text(14pt)\n#import "lib.typ"';

  it("三行前缀：计 3 行，第 1/3 行在前缀内、第 4 行不在", () => {
    expect(prefixLineCount(multi)).toBe(3);
    expect(isErrorLineInPrefix(1, multi)).toBe(true);
    expect(isErrorLineInPrefix(3, multi)).toBe(true);
    expect(isErrorLineInPrefix(4, multi)).toBe(false);
  });

  it("单行前缀（无换行）：仅第 1 行在前缀内", () => {
    expect(prefixLineCount("#set page()")).toBe(1);
    expect(isErrorLineInPrefix(1, "#set page()")).toBe(true);
    expect(isErrorLineInPrefix(2, "#set page()")).toBe(false);
  });

  it("前缀以换行结尾：split 的末尾空行不算前缀（编译源里该行是用户文档第 1 行）", () => {
    const p = "#set page()\n";
    expect(prefixLineCount(p)).toBe(2);
    expect(isErrorLineInPrefix(1, p)).toBe(true);
    expect(isErrorLineInPrefix(2, p)).toBe(false);
    expect(isErrorLineInPrefix(3, p)).toBe(false);
  });

  it("空前缀按 split 语义计 1 行", () => {
    expect(prefixLineCount("")).toBe(1);
    expect(isErrorLineInPrefix(1, "")).toBe(true);
  });

  it("0 / 负行号不在前缀内", () => {
    expect(isErrorLineInPrefix(0, "abc\ndef")).toBe(false);
    expect(isErrorLineInPrefix(-1, "abc\ndef")).toBe(false);
  });
});

describe("prefixLineCharOffset", () => {
  const multi = "ab\ncd\nef"; // 总长 8：行起点偏移分别为 0 / 3 / 6

  it("第 1 行起点偏移为 0", () => {
    expect(prefixLineCharOffset(multi, 1)).toBe(0);
  });

  it("第 2 行起点 = 第 1 行长度 + 1 个换行", () => {
    expect(prefixLineCharOffset(multi, 2)).toBe(3);
  });

  it("第 3 行起点 = 前两行长度 + 2 个换行", () => {
    expect(prefixLineCharOffset(multi, 3)).toBe(6);
  });

  it("行号超出总行数：钳制到最后一行起点", () => {
    expect(prefixLineCharOffset(multi, 99)).toBe(6);
  });

  it("空串（1 行）：第 1 行起点为 0", () => {
    expect(prefixLineCharOffset("", 1)).toBe(0);
  });
});

describe("formatDiagnosticForClipboard / formatDiagnosticListForClipboard（复制诊断信息）", () => {
  const win = "D:\\work\\报告.typ";

  it("定位条目：路径 + 行列 + 消息（用户要求「路径贴到前面」）", () => {
    expect(
      formatDiagnosticForClipboard(
        {
          kind: "located",
          message: "expected closing `)`",
          line: 3,
          col: 5,
          path: "D:\\work\\lib.typ",
        },
        win,
      ),
    ).toBe("D:\\work\\lib.typ: 行 3, 列 5：expected closing `)`");
  });

  it("主源（无 path）：回退到当前文档路径", () => {
    expect(
      formatDiagnosticForClipboard({ kind: "located", message: "m", line: 1, col: 2 }, win),
    ).toBe(`${win}: 行 1, 列 2：m`);
  });

  it("未保存文档（既无 path 也无回退）：省略路径前缀", () => {
    expect(
      formatDiagnosticForClipboard({ kind: "located", message: "m", line: 1, col: 2 }, null),
    ).toBe("行 1, 列 2：m");
  });

  it("空串 path 与 null 回退都视为没有路径", () => {
    expect(
      formatDiagnosticForClipboard(
        { kind: "located", message: "m", line: 9, col: 9, path: "" },
        null,
      ),
    ).toBe("行 9, 列 9：m");
  });

  it("generic 条目（无位置，如包不存在）：有路径则带路径，否则只有消息", () => {
    expect(
      formatDiagnosticForClipboard({ kind: "generic", message: "package not found" }, win),
    ).toBe(`${win}: package not found`);
    expect(
      formatDiagnosticForClipboard({ kind: "generic", message: "package not found" }, null),
    ).toBe("package not found");
  });

  it("整份列表：首行是浮层标题原文，其后每条一行，末尾不带换行", () => {
    const text = formatDiagnosticListForClipboard(
      "编译错误（2 处）",
      [
        { kind: "located", message: "a", line: 3, col: 5 },
        { kind: "located", message: "b", line: 7, col: 1, path: "D:\\work\\z.typ" },
      ],
      win,
    );
    expect(text).toBe(
      ["编译错误（2 处）", `${win}: 行 3, 列 5：a`, "D:\\work\\z.typ: 行 7, 列 1：b"].join("\n"),
    );
    expect(text.endsWith("\n")).toBe(false);
  });

  it("空列表返回空串（浮层只在有内容时渲染）", () => {
    expect(formatDiagnosticListForClipboard("编译警告（1 处）", [], win)).toBe("");
  });
});

describe("formatCompileFailMessage（自 typst-libs 迁移）", () => {
  it("errorCount > 0 显示计数形式", () => {
    expect(formatCompileFailMessage(3, "anything")).toBe("编译错误：3 处");
  });

  it("errorCount = 0 显示错误消息", () => {
    expect(formatCompileFailMessage(0, "package @preview/cetz:0.1.0 not found")).toBe(
      "编译错误：package @preview/cetz:0.1.0 not found",
    );
  });

  it("长消息截断到 ~120 字符", () => {
    const long = "x".repeat(500);
    const msg = formatCompileFailMessage(0, long);
    expect(msg.startsWith("编译错误：")).toBe(true);
    expect(msg.length).toBeLessThanOrEqual("编译错误：".length + 120 + 1);
    expect(msg.endsWith("…")).toBe(true);
  });
});
