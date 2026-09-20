// diagnostics-utils 编译诊断纯函数单元测试（位置映射 / 波浪线区间）。
// 诊断已切换为 Rust 侧结构化对象（1-based 行列，见 typst-engine.ts），
// 不再有 range 字符串解析；测试数据直接构造 CompileErrorLocation。
import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import { offsetAt, mapCompiledPosToDoc, squiggleRanges } from "./diagnostics-utils";
import type { CompileErrorLocation } from "./typst-engine";

function err(over: Partial<CompileErrorLocation>): CompileErrorLocation {
  return { message: "m", line: 1, col: 1, endLine: 1, endCol: 2, ...over };
}

describe("offsetAt（1-based 行列 → offset）", () => {
  // CM6 Text.of 以 "\n" 拼接：行 1 "#let a = b" 占 0-9，\n 在 10，行 2 "hello" 占 11-15
  const doc = Text.of(["#let a = b", "hello", "world"]);

  it("常规位置", () => {
    expect(offsetAt(doc, 1, 1)).toBe(0);
    expect(offsetAt(doc, 1, 10)).toBe(9); // 行 1 的 "b"（0-based 9）
    expect(offsetAt(doc, 2, 1)).toBe(11); // 行 2 起点（\n 之后）
    expect(offsetAt(doc, 3, 3)).toBe(19);
  });

  it("列越界 clamp 到行尾；行越界 clamp 到文档范围内", () => {
    expect(offsetAt(doc, 3, 6)).toBe(22); // "world" 只有 5 列 → 行尾（含越界 1 列）
    expect(offsetAt(doc, 99, 1)).toBe(17); // 最后一行起点
    expect(offsetAt(doc, 2, 0)).toBe(11); // 列 0 → 1
    expect(offsetAt(doc, 0, 1)).toBe(0); // 行 0 → 1
  });

  it("空文档返回 0", () => {
    expect(offsetAt(Text.empty, 1, 1)).toBe(0);
  });
});

describe("mapCompiledPosToDoc（编译源 → 用户文档）", () => {
  it("无前缀：原样映射为用户文档", () => {
    expect(mapCompiledPosToDoc(1, 5, "")).toEqual({ kind: "user", line: 1, col: 5 });
    expect(mapCompiledPosToDoc(3, 2, "")).toEqual({ kind: "user", line: 3, col: 2 });
  });

  it("前缀以换行结尾：前缀占前 N 行，用户第 1 行 = 编译源第 N+1 行", () => {
    const p = "A\n";
    expect(mapCompiledPosToDoc(1, 1, p)).toEqual({ kind: "prefix" });
    expect(mapCompiledPosToDoc(2, 1, p)).toEqual({ kind: "user", line: 1, col: 1 });
    expect(mapCompiledPosToDoc(2, 7, p)).toEqual({ kind: "user", line: 1, col: 7 });
    expect(mapCompiledPosToDoc(3, 4, p)).toEqual({ kind: "user", line: 2, col: 4 });
  });

  it("前缀未以换行结尾：最后一行与用户第 1 行同属一行，按列区分归属", () => {
    const p = "A";
    expect(mapCompiledPosToDoc(1, 1, p)).toEqual({ kind: "prefix" }); // "A" 本身
    expect(mapCompiledPosToDoc(1, 2, p)).toEqual({ kind: "user", line: 1, col: 1 }); // 用户第 1 列
    expect(mapCompiledPosToDoc(2, 9, p)).toEqual({ kind: "user", line: 2, col: 9 });
  });

  it("多行前缀（无结尾换行）：边界行为 'A'，其后是用户第 1 行", () => {
    const p = "A\nB";
    expect(mapCompiledPosToDoc(1, 1, p)).toEqual({ kind: "prefix" });
    expect(mapCompiledPosToDoc(2, 1, p)).toEqual({ kind: "prefix" }); // "B" 占第 2 行第 1 列
    expect(mapCompiledPosToDoc(2, 2, p)).toEqual({ kind: "user", line: 1, col: 1 });
    expect(mapCompiledPosToDoc(3, 5, p)).toEqual({ kind: "user", line: 2, col: 5 });
  });
});

describe("squiggleRanges（编辑器波浪线区间）", () => {
  // CM6 Text.of 以 "\n" 拼接：行 1 "#let a = b" 占 0-9，\n 在 10，行 2 "hello" 占 11-15
  const doc = Text.of(["#let a = b", "hello"]);

  it("第 1 行错误：区间精确覆盖出错 token（1-based 10-11 列 → 0-based [9,10)）", () => {
    const ranges = squiggleRanges(doc, [err({ line: 1, col: 10, endLine: 1, endCol: 11 })]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(9);
    expect(ranges[0].to).toBe(10);
  });

  it("第 2 行错误：区间落在第 2 行（不再偏上一行）", () => {
    const ranges = squiggleRanges(doc, [
      err({ line: 2, col: 3, endLine: 2, endCol: 6 }), // "ell"
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(13);
    expect(ranges[0].to).toBe(16);
  });

  it("单点错误（EOF 处，'expected expression'）：至少画 1 个字符", () => {
    const d = Text.of(["#let x = "]); // 0-based 0-8，无结尾换行
    const ranges = squiggleRanges(d, [err({ line: 1, col: 9, endLine: 1, endCol: 9 })]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(8); // 错误点 0-based 8 = 末尾空格
    expect(ranges[0].to).toBe(9);
  });

  it("错误点落在文档末尾之后：clamp 到最后一个字符，不丢弃", () => {
    const d = Text.of(["#let x = "]); // 0-based 0-8
    const ranges = squiggleRanges(d, [err({ line: 1, col: 11, endLine: 1, endCol: 11 })]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(8);
    expect(ranges[0].to).toBe(9);
  });

  it("空文档：无法构成区间，返回空", () => {
    expect(squiggleRanges(Text.empty, [err({ line: 1, col: 1, endLine: 1, endCol: 1 })])).toEqual(
      [],
    );
  });

  it("非主源文件（本地库）的错误：不为主文档画波浪线", () => {
    const ranges = squiggleRanges(doc, [
      err({ line: 2, col: 3, endLine: 2, endCol: 6, path: "/lib.typ" }),
    ]);
    expect(ranges).toEqual([]);
  });

  it("path 为空（Rust 契约：空表示主文档）：画波浪线", () => {
    const ranges = squiggleRanges(doc, [
      err({ line: 1, col: 10, endLine: 1, endCol: 11, path: "" }),
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(9);
  });

  it("path 缺失：视为主源（兼容旧数据）", () => {
    const ranges = squiggleRanges(doc, [err({ line: 1, col: 10, endLine: 1, endCol: 11 })]);
    expect(ranges).toHaveLength(1);
  });

  it("path 为 null（Rust 0.4.0~0.8.2 发的就是 null）：同样视为主源，必须画波浪线", () => {
    // 回归背景：判据曾经只认 undefined/""，`null` 被当成"非主源文件"跳过 ⇒ 桌面版从
    // 0.4.0 起编译错误的红波浪线一条都不画（浏览器验收用的桩不发该字段，所以没抓住）。
    const ranges = squiggleRanges(doc, [
      err({ line: 1, col: 10, endLine: 1, endCol: 11, path: null }),
    ]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(9);
    expect(ranges[0].to).toBe(10);
  });

  it("path 是 main.typ（历史默认值）也当主源", () => {
    const ranges = squiggleRanges(doc, [
      err({ line: 1, col: 10, endLine: 1, endCol: 11, path: "main.typ" }),
    ]);
    expect(ranges).toHaveLength(1);
  });

  it("前缀启用：错误行号按编译源映射回用户文档", () => {
    // 前缀 "A\n" 一行，用户第 1 行 = 编译源第 2 行；实测 "#set ...\n#let a = b" → "1:9-1:10"
    const ranges = squiggleRanges(doc, [err({ line: 2, col: 10, endLine: 2, endCol: 11 })], "A\n");
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(9); // 用户文档第 1 行的 "b"
    expect(ranges[0].to).toBe(10);
  });

  it("前缀启用：错误落在前缀代码内 → 不画波浪线", () => {
    const ranges = squiggleRanges(doc, [err({ line: 1, col: 3, endLine: 1, endCol: 4 })], "A\n");
    expect(ranges).toEqual([]);
  });

  it("前缀启用且未以换行结尾：混合行按列区分（列在前缀尾行内 → 前缀）", () => {
    const prefix = "A";
    expect(squiggleRanges(doc, [err({ line: 1, col: 1, endLine: 1, endCol: 2 })], prefix)).toEqual(
      [],
    );
    const user = squiggleRanges(doc, [err({ line: 1, col: 2, endLine: 1, endCol: 3 })], prefix);
    expect(user).toHaveLength(1);
    expect(user[0].from).toBe(0); // 用户第 1 行第 1 列
    expect(user[0].to).toBe(1);
  });

  it("跨行区间（起点在用户第 1 行、终点在第 2 行）", () => {
    const ranges = squiggleRanges(doc, [err({ line: 1, col: 10, endLine: 2, endCol: 4 })]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].from).toBe(9);
    expect(ranges[0].to).toBe(14); // 覆盖 "b"、换行符与第 2 行 "hel"
  });
});
