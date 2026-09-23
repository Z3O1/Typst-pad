import { describe, expect, it } from "vitest";
import { scanMarkupDecorations } from "./markup-ranges";
import { scanMathRanges } from "./math-ranges";
import { scanParagraphGapRows } from "./paragraph-breaks";
import { scanNonMarkupRegions } from "./typst-lex";

function gaps(doc: string, prefix = "") {
  const opaque = scanNonMarkupRegions(doc);
  const math = scanMathRanges(doc, opaque);
  const markup = scanMarkupDecorations(doc, { opaque, math });
  return scanParagraphGapRows(doc, opaque, math, markup, prefix);
}

describe("scanParagraphGapRows", () => {
  it("认出普通段落间的空白行，但不改动源码", () => {
    const doc = "1 \n\n 1";
    expect(gaps(doc)).toEqual([{ from: 3, count: 1 }]);
  });

  it("连续空行共享一份段距，空白缩进也保留为源码", () => {
    const doc = "前段\n  \n\n后段";
    expect(gaps(doc)).toEqual([
      { from: 3, count: 2 },
      { from: 6, count: 2 },
    ]);
  });

  it("文档首部空行不作为段距，文末新段预留稳定段距", () => {
    expect(gaps("\n首段\n\n尾段\n")).toEqual([{ from: 4, count: 1 }]);
    expect(gaps("正文\n\n")).toEqual([{ from: 3, count: 1 }]);
    expect(gaps("正文\n\n  ")).toEqual([{ from: 3, count: 1 }]);
    expect(gaps("正文\n\n\n")).toEqual([
      { from: 3, count: 2 },
      { from: 4, count: 2 },
    ]);
  });

  it("标题、列表、行间公式、代码和注释周围保持原样", () => {
    const doc = [
      "普通段落",
      "",
      "= 标题",
      "",
      "正文",
      "",
      "- 列表项",
      "",
      "正文",
      "",
      "$ x^2 $",
      "",
      "正文",
      "",
      "#let x = 1",
      "",
      "正文",
      "",
      "/* 注释",
      "",
      "注释 */",
      "",
      "正文",
    ].join("\n");
    expect(gaps(doc)).toEqual([]);
  });

  it("出现自定义 par 规则时不假设 1.2em 默认段距", () => {
    expect(gaps("#set par(spacing: 0.8em)\n\n正文一\n\n正文二")).toEqual([]);
    expect(gaps("#show par: set block(breakable: false)\n\n正文一\n\n正文二")).toEqual([]);
    expect(gaps("正文一\n\n正文二", "#set par(spacing: 0.8em)\n")).toEqual([]);
  });

  it("注释里的 par 示例不禁用段距压缩", () => {
    const lineComment = "// #set par(spacing: 0.8em)\n\n正文一\n\n正文二";
    const blockComment = "/* #show par: ... */\n\n正文一\n\n正文二";
    expect(gaps(lineComment)).toEqual([{ from: lineComment.indexOf("\n\n正文二") + 1, count: 1 }]);
    expect(gaps(blockComment)).toEqual([
      { from: blockComment.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
    expect(gaps("正文一\n\n正文二", "// #set par(spacing: 0.8em)\n")).toEqual([
      { from: 4, count: 1 },
    ]);
  });

  it("活动 par 规则仍禁用段距压缩，即使注释里也有示例", () => {
    expect(
      gaps("// #set par(spacing: 0.8em)\n#set par(spacing: 0.6em)\n\n正文一\n\n正文二"),
    ).toEqual([]);
  });

  it("正文里的直引号与行内公式不妨碍识别段间隔", () => {
    expect(gaps('他说 "你好"，公式 $x^2$。\n\n下一段。')).toEqual([{ from: 18, count: 1 }]);
  });
});
