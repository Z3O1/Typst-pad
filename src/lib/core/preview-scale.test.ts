import { describe, expect, it } from "vitest";
import { normalizeUiZoom, previewCanvasWidth, previewScale, viewBoxWidthPt } from "./preview-scale";

const A4_WIDTH_PT = 595.28;

describe("previewScale", () => {
  it("100% 时页面始终铺满预览栏", () => {
    expect(previewCanvasWidth({ containerWidth: 400, pageWidthPt: A4_WIDTH_PT })).toBeCloseTo(
      400,
      10,
    );
    expect(previewCanvasWidth({ containerWidth: 960, pageWidthPt: A4_WIDTH_PT })).toBeCloseTo(
      960,
      10,
    );
  });

  it("窗口宽度持续影响页面，不在固定自然尺寸停止", () => {
    const narrow = previewCanvasWidth({ containerWidth: 480, pageWidthPt: A4_WIDTH_PT });
    const wide = previewCanvasWidth({ containerWidth: 960, pageWidthPt: A4_WIDTH_PT });
    expect(wide).toBeCloseTo(narrow * 2, 10);
  });

  it("用户缩放继续作用于页面内容", () => {
    expect(
      previewCanvasWidth({ containerWidth: 500, pageWidthPt: A4_WIDTH_PT, uiZoom: 1.5 }),
    ).toBeCloseTo(750, 10);
    expect(
      previewCanvasWidth({ containerWidth: 500, pageWidthPt: A4_WIDTH_PT, uiZoom: 0.5 }),
    ).toBeCloseTo(250, 10);
  });

  it("非法尺寸返回 NaN", () => {
    expect(previewScale({ containerWidth: 0, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: Number.NaN, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: 800, pageWidthPt: 0 })).toBeNaN();
  });
});

describe("normalizeUiZoom", () => {
  it("只接受有限正数", () => {
    expect(normalizeUiZoom(1.3)).toBe(1.3);
    for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeUiZoom(value)).toBe(1);
    }
  });
});

describe("viewBoxWidthPt", () => {
  it("读取空格或逗号分隔的页面宽度", () => {
    expect(viewBoxWidthPt("0 0 595.28 841.89")).toBeCloseTo(595.28, 10);
    expect(viewBoxWidthPt("0,0,360,480")).toBe(360);
  });

  it("拒绝无效 viewBox", () => {
    expect(viewBoxWidthPt("")).toBeNaN();
    expect(viewBoxWidthPt("0 0 x 841")).toBeNaN();
  });
});
