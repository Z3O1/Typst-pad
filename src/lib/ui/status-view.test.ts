// 状态栏「看数据」层单元测试（+page.svelte 的 warningItems / errorItems / 复制文案）
import { describe, it, expect } from "vitest";
import {
  COPY_FAILED_NOTICE,
  buildErrorItems,
  buildWarningItems,
  diagnosticCopyAllStatus,
  diagnosticCopyStatus,
  diagnosticListTitle,
  truncateStatus,
} from "./status-view";
import type { CompileErrorLocation, Diagnostic } from "../core/typst-engine";

const warning = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  message: "示例警告",
  severity: "warning",
  line: 1,
  column: 1,
  ...over,
});

const error = (over: Partial<CompileErrorLocation> = {}): CompileErrorLocation => ({
  message: "示例错误",
  line: 2,
  col: 5,
  endLine: 2,
  endCol: 9,
  ...over,
});

describe("truncateStatus", () => {
  it("不超过上限时原样返回", () => {
    expect(truncateStatus("就绪")).toBe("就绪");
    expect(truncateStatus("x".repeat(70))).toBe("x".repeat(70));
  });

  it("超出上限时截断并补省略号（默认 70）", () => {
    const long = "y".repeat(71);
    expect(truncateStatus(long)).toBe(`${"y".repeat(70)}…`);
    expect(truncateStatus(long).length).toBe(71); // 70 + 省略号
  });

  it("自定义上限", () => {
    expect(truncateStatus("abcdef", 3)).toBe("abc…");
    expect(truncateStatus("abc", 3)).toBe("abc");
  });

  it("空串不炸", () => {
    expect(truncateStatus("")).toBe("");
    expect(truncateStatus("", 0)).toBe("");
  });
});

describe("buildWarningItems", () => {
  it("有源码位置的警告 → located（column 映到 col、路径原样带上）", () => {
    const items = buildWarningItems([
      warning({ message: "unknown font family: 微软雅黑", line: 7, column: 3, path: "/tmp/a.typ" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "located", line: 7, col: 3, path: "/tmp/a.typ" });
    expect(items[0].message).toContain("未知字体族「微软雅黑」");
  });

  it("主源警告的 path（null / 缺失）归一成 undefined", () => {
    const items = buildWarningItems([
      warning({ path: null }),
      warning({ path: undefined }),
      warning({}),
    ]);
    for (const i of items) expect(i.kind === "located" && i.path).toBeFalsy();
  });

  it("line = 0（没有位置）→ generic，不带给 formatErrorLoc 的行列", () => {
    const items = buildWarningItems([warning({ line: 0, column: 0 })]);
    expect(items[0]).toEqual({ kind: "generic", message: "示例警告" });
  });

  it("未知字体族提示同样作用于无位置警告", () => {
    const items = buildWarningItems([warning({ line: 0, message: "unknown font family: X" })]);
    expect(items[0].message).toContain("未知字体族「X」");
  });

  it("空数组 → 空数组（浮层不会只留个标题）", () => {
    expect(buildWarningItems([])).toEqual([]);
  });

  it("顺序与输入一致", () => {
    const items = buildWarningItems([
      warning({ message: "一", line: 1, column: 1 }),
      warning({ message: "二", line: 0 }),
      warning({ message: "三", line: 9, column: 4 }),
    ]);
    expect(items.map((i) => i.message)).toEqual(["一", "二", "三"]);
  });
});

describe("buildErrorItems", () => {
  it("有定位错误时逐条给出（非定位错误与之同源，不重复展示）", () => {
    const items = buildErrorItems([error(), error({ line: 9, col: 1 })], "包不存在");
    expect(items.map((i) => i.kind)).toEqual(["located", "located"]);
    expect(items[0]).toMatchObject({ line: 2, col: 5 });
  });

  it("只有非定位错误时单列一条 generic", () => {
    expect(buildErrorItems([], "包不存在")).toEqual([{ kind: "generic", message: "包不存在" }]);
  });

  it("什么都没有 → 空数组", () => {
    expect(buildErrorItems([], null)).toEqual([]);
    expect(buildErrorItems([], "")).toEqual([]);
  });

  it("主源错误 path 为 null → undefined", () => {
    const items = buildErrorItems([error({ path: null })], null);
    expect(items[0].kind === "located" && items[0].path).toBeFalsy();
  });
});

describe("复制反馈文案与浮层标题", () => {
  it("单条复制成功/失败", () => {
    expect(diagnosticCopyStatus("errors", true)).toBe("已复制错误信息");
    expect(diagnosticCopyStatus("warnings", true)).toBe("已复制警告信息");
    expect(diagnosticCopyStatus("errors", false)).toBe(COPY_FAILED_NOTICE);
    expect(diagnosticCopyStatus("warnings", false)).toBe(COPY_FAILED_NOTICE);
  });

  it("复制全部成功/失败（带条数）", () => {
    expect(diagnosticCopyAllStatus("errors", 2, true)).toBe("已复制全部 2 处错误");
    expect(diagnosticCopyAllStatus("warnings", 7, true)).toBe("已复制全部 7 处警告");
    expect(diagnosticCopyAllStatus("errors", 2, false)).toBe(COPY_FAILED_NOTICE);
  });

  it("浮层标题（也是复制全部的首行）", () => {
    expect(diagnosticListTitle("errors", 0)).toBe("编译错误（0 处）");
    expect(diagnosticListTitle("errors", 3)).toBe("编译错误（3 处）");
    expect(diagnosticListTitle("warnings", 1)).toBe("编译警告（1 处）");
  });
});
