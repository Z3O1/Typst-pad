import { describe, expect, it } from "vitest";
import { isDirectlyEditableTextBlock } from "./block-decorations";
import { scanNonMarkupRegions } from "../../core/typst-lex";
import type { Block } from "../../core/block-plan";

/** 造一个块：区间 [from,to)、kind、found */
function block(from: number, to: number, kind: Block["kind"] = "Paragraph"): Block {
  return {
    from,
    to,
    kind,
    found: true,
    skipped: false,
    noOutput: false,
    svg: "<svg/>",
    page: 1,
    pages: 1,
    xPt: 0,
    yPt: 0,
    anchorBaselinePt: null,
    widthPt: 100,
    heightPt: 10,
    links: [],
  };
}

function editable(doc: string, b: Block): boolean {
  return isDirectlyEditableTextBlock(b, scanNonMarkupRegions(doc), doc);
}

describe("isDirectlyEditableTextBlock", () => {
  it("单源码行的纯 markup 段落/标题可直接编辑", () => {
    const doc = "= 标题\n\n正文 $x^2$ 与 **粗体**。";
    expect(editable(doc, block(0, 4, "Heading"))).toBe(true);
    expect(editable(doc, block(6, doc.length))).toBe(true);
  });

  it("段内有单 LF 的段落不直接编辑（Typst 当空白连排，逐行呈现会多出行盒）", () => {
    const doc = "第一段第一行，\n第二行继续。\n\n另一段。";
    const first = block(0, doc.indexOf("\n\n"));
    expect(first.to).toBeGreaterThan(first.from);
    expect(editable(doc, first)).toBe(false);
  });

  it("含代码 / raw / 注释的块仍走切片", () => {
    const doc = "正文里 `code` 与 // 注释\n\n另一段。";
    expect(editable(doc, block(0, doc.indexOf("\n\n")))).toBe(false);
  });

  it("没有几何或有意跳过的块不可直接编辑", () => {
    const doc = "正文。";
    expect(
      isDirectlyEditableTextBlock({ ...block(0, doc.length), found: false }, [], doc),
    ).toBe(false);
    expect(
      isDirectlyEditableTextBlock({ ...block(0, doc.length), skipped: true }, [], doc),
    ).toBe(false);
  });
});
