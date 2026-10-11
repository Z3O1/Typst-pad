import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER,
  DOCUMENT_PREVIEW_MARGIN_PT,
  usesDefaultPageLayout,
  EDITOR_FONT_PX,
  PREVIEW_PAGE_MIN_PT,
  TYPST_DEFAULT_TEXT_PT,
  isReflowApplied,
  naturalScale,
  paperShapeFromPages,
  previewCanvasWidth,
  previewPage,
  previewScale,
  reflowCanvasWidth,
  viewBoxSizePt,
} from "./preview-scale";

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

describe("paperShapeFromPages", () => {
  it("取指定原文产物的最宽页，不与raw展示页混用", () => {
    const original = ['<svg viewBox="0 0 240 320"/>', '<svg viewBox="0 0 480 960"/>'];
    const raw = ['<svg viewBox="0 0 595.28 841.89"/>'];
    expect(paperShapeFromPages(original)).toEqual({ widthPt: 480, heightPt: 960 });
    expect(paperShapeFromPages(raw)).toEqual({ widthPt: 595.28, heightPt: 841.89 });
  });
  it("缺页或非法页面不伪造纸型", () => {
    expect(paperShapeFromPages([])).toBeNull();
    expect(paperShapeFromPages(["<svg/>"])).toBeNull();
    expect(
      paperShapeFromPages(['<svg viewBox="0 0 480 960"/>', '<svg viewBox="0 0 0 5"/>']),
    ).toBeNull();
  });
});

describe("文档模式紧凑默认页面", () => {
  it("宽栏保持自然纸型但减少真实编译内边距，窄栏同比例缩小", () => {
    const wide = previewPage(1400, DEFAULT_PAPER, true)!;
    expect(wide).toEqual({ ...DEFAULT_PAPER, marginPt: DOCUMENT_PREVIEW_MARGIN_PT });
    const narrow = previewPage(400, DEFAULT_PAPER, true)!;
    expect(narrow.marginPt).toBeCloseTo((24 * narrow.widthPt) / DEFAULT_PAPER.widthPt);
    expect(narrow.widthPt).toBeCloseTo((400 * 11) / 14);
    expect(wide.widthPt - 2 * wide.marginPt).toBeGreaterThan(DEFAULT_PAPER.widthPt - 2 * 70.87);
  });
  it("明确页面规则、导入和非默认纸型保持原策略", () => {
    expect(usesDefaultPageLayout("正文", DEFAULT_PAPER)).toBe(true);
    expect(usesDefaultPageLayout("// #set page(margin: 2cm)\n正文", DEFAULT_PAPER)).toBe(true);
    expect(usesDefaultPageLayout("`#set page(margin: 2cm)`", DEFAULT_PAPER)).toBe(true);
    for (const source of [
      "#set page(margin: 2cm)\n正文",
      "#show page: it => it",
      '#import "layout.typ": *',
      '#include "part.typ"',
      "#{set page(margin: 2cm); [正文]}",
      "#page(margin: 2cm)[正文]",
      "#let layout = page\n#layout[正文]",
      '#eval("set page(margin: 2cm)")',
    ]) {
      expect(usesDefaultPageLayout(source, DEFAULT_PAPER)).toBe(false);
    }
    expect(usesDefaultPageLayout("正文", { widthPt: 480, heightPt: 960 })).toBe(false);
  });
});

describe("naturalScale", () => {
  it("typst 11pt 正文 ↔ 编辑区 14px", () => {
    expect(naturalScale()).toBeCloseTo(EDITOR_FONT_PX / TYPST_DEFAULT_TEXT_PT, 10);
    expect(A4_WIDTH_PT * naturalScale()).toBeCloseTo(757.63, 1);
  });
});

describe("previewScale（兜底路径：等比缩放整页）", () => {
  it("窄栏：画布铺满栏宽，但永远不超过它（永不横向滚动）", () => {
    const width = previewCanvasWidth({ containerWidth: 400, pageWidthPt: A4_WIDTH_PT });
    expect(width).toBeCloseTo(400, 10);
    expect(width).toBeLessThanOrEqual(400);
  });

  it("宽栏：停在自然字号（不再随窗口放大），字与代码一样大", () => {
    for (const containerWidth of [800, 960, 1600]) {
      const width = previewCanvasWidth({ containerWidth, pageWidthPt: A4_WIDTH_PT });
      expect(width).toBeCloseTo(A4_WIDTH_PT * naturalScale(), 10);
      expect(width).toBeLessThanOrEqual(containerWidth);
    }
  });

  it("任何栏宽下画布都 ≤ 栏宽（硬保证）", () => {
    for (const containerWidth of [120, 300, 757.6, 758, 1200, 2400]) {
      expect(previewCanvasWidth({ containerWidth, pageWidthPt: A4_WIDTH_PT })).toBeLessThanOrEqual(
        containerWidth + 1e-9,
      );
    }
  });

  it("非法尺寸返回 NaN", () => {
    expect(previewScale({ containerWidth: 0, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: Number.NaN, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: 800, pageWidthPt: 0 })).toBeNaN();
  });
});

describe("previewPage（重排路径：纸张跟着预览栏走）", () => {
  it("栏宽 → 页宽 = 栏宽 × 11/14：正文按 14px 排版", () => {
    const page = previewPage(700);
    expect(page).not.toBeNull();
    expect(page!.widthPt).toBeCloseTo(700 * (TYPST_DEFAULT_TEXT_PT / EDITOR_FONT_PX), 10);
    // 页高与页边距按文档自己的纸型等比缩放
    const factor = page!.widthPt / A4_WIDTH_PT;
    expect(page!.heightPt).toBeCloseTo(A4_HEIGHT_PT * factor, 6);
    expect(page!.marginPt).toBeCloseTo(70.87 * factor, 6);
    expect(page!.marginPt).toBeLessThan(70.87);
  });

  it("栏宽够放下自然尺寸：不重排（返回 null，走兜底路径）", () => {
    expect(previewPage(A4_WIDTH_PT * naturalScale())).toBeNull();
    expect(previewPage(2000)).toBeNull();
  });

  it("极窄栏：页宽停在 180pt 下限（正文不成碎字）", () => {
    const page = previewPage(30);
    expect(page!.widthPt).toBeCloseTo(PREVIEW_PAGE_MIN_PT, 10);
    // 文档纸型比下限还窄时只缩窄、不加宽
    expect(previewPage(30, { widthPt: 120, heightPt: 200 })!.widthPt).toBeCloseTo(120, 10);
  });

  it("按文档自己的纸型缩放（不是写死 A4）", () => {
    const a5 = { widthPt: 419.53, heightPt: 595.28 };
    const page = previewPage(400, a5);
    const factor = page!.widthPt / a5.widthPt;
    expect(page!.heightPt).toBeCloseTo(a5.heightPt * factor, 6);
    // A5 窄，同样的栏宽下比例与 A4 不同：页宽只由栏宽与字号决定
    expect(page!.widthPt).toBeCloseTo(400 * (TYPST_DEFAULT_TEXT_PT / EDITOR_FONT_PX), 10);
  });

  it("纸型非法/栏宽不可测：退回默认 A4 / 不给请求", () => {
    expect(previewPage(0)).toBeNull();
    expect(previewPage(Number.NaN)).toBeNull();
    const page = previewPage(400, { widthPt: 0, heightPt: 0 });
    expect(page!.widthPt).toBeCloseTo(400 * (TYPST_DEFAULT_TEXT_PT / EDITOR_FONT_PX), 10);
    expect(page!.heightPt).toBeCloseTo(
      DEFAULT_PAPER.heightPt * (page!.widthPt / DEFAULT_PAPER.widthPt),
      6,
    );
  });
});

describe("reflowCanvasWidth（重排生效时的画布）", () => {
  it("恒 ≤ 栏宽：这是无横向滚动条的保证", () => {
    for (const containerWidth of [180, 320, 700, 1400]) {
      const page = previewPage(containerWidth);
      if (!page) continue;
      const canvas = reflowCanvasWidth(containerWidth, page.widthPt);
      expect(canvas).toBeLessThanOrEqual(containerWidth + 1e-9);
      expect(canvas).toBeCloseTo(containerWidth, 6);
    }
  });

  it("页宽被下限夹住时不再铺满（栏太窄，画布跟着变小）", () => {
    const page = previewPage(30)!;
    expect(reflowCanvasWidth(30, page.widthPt)).toBeCloseTo(30, 10);
  });

  it("非法输入返回 NaN", () => {
    expect(reflowCanvasWidth(0, 300)).toBeNaN();
    expect(reflowCanvasWidth(500, Number.NaN)).toBeNaN();
  });
});

describe("isReflowApplied", () => {
  it("产物页宽等于请求页宽（±1pt）才算生效", () => {
    expect(isReflowApplied(400, 400)).toBe(true);
    expect(isReflowApplied(400.8, 400)).toBe(true);
    expect(isReflowApplied(595.28, 400)).toBe(false);
    expect(isReflowApplied(Number.NaN, 400)).toBe(false);
    expect(isReflowApplied(400, Number.NaN)).toBe(false);
  });
});

describe("viewBoxSizePt", () => {
  it("读取空格或逗号分隔的纸型", () => {
    expect(viewBoxSizePt("0 0 595.28 841.89")).toEqual({
      widthPt: 595.28,
      heightPt: 841.89,
    });
    expect(viewBoxSizePt("0,0,360,480")).toEqual({ widthPt: 360, heightPt: 480 });
  });

  it("拒绝无效 viewBox", () => {
    expect(viewBoxSizePt("")).toBeNull();
    expect(viewBoxSizePt("0 0 x 841")).toBeNull();
    expect(viewBoxSizePt("0 0 0 841")).toBeNull();
    expect(viewBoxSizePt("0 0 595")).toBeNull();
  });
});
