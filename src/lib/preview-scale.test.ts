// preview-scale 单元测试：容器宽度、页宽、基准字号 → 缩放系数/画布尺寸（纯函数，无 DOM）
import { describe, it, expect } from "vitest";
import {
  PT_TO_PX,
  TYPST_DEFAULT_TEXT_PT,
  EDITOR_FONT_PX,
  naturalScale,
  previewScale,
  previewCanvasWidth,
  viewBoxWidthPt,
} from "./preview-scale";

/** A4 页面物理宽度（pt）——Typst 默认页面尺寸 */
const A4_WIDTH_PT = 595.28;

describe("naturalScale（字号对齐自然系数）", () => {
  it("输入区基准字号 14px：Typst 默认正文 11pt 渲染为 14px", () => {
    expect(naturalScale(EDITOR_FONT_PX) * TYPST_DEFAULT_TEXT_PT * PT_TO_PX).toBeCloseTo(
      EDITOR_FONT_PX,
      10,
    );
  });

  it("自然系数 = 基准字号 / (11pt × 4/3px每pt)", () => {
    expect(naturalScale(14)).toBeCloseTo(14 / (11 * PT_TO_PX), 10);
  });
});

describe("previewScale（容器宽度 → 缩放系数）", () => {
  it("容器足够宽：取自然系数（字号恒定，不随窗口放大）", () => {
    const scale = previewScale({ containerWidth: 1200, pageWidthPt: A4_WIDTH_PT });
    expect(scale).toBeCloseTo(naturalScale(EDITOR_FONT_PX), 10);
  });

  it("容器恰好等于自然画布宽度：仍取自然系数（临界不放大）", () => {
    const naturalWidth = A4_WIDTH_PT * naturalScale(EDITOR_FONT_PX);
    const scale = previewScale({ containerWidth: naturalWidth, pageWidthPt: A4_WIDTH_PT });
    expect(scale).toBeCloseTo(naturalScale(EDITOR_FONT_PX), 10);
  });

  it("容器变窄：等比缩小铺满容器宽度（等宽显示，不出现横向溢出）", () => {
    const container = 400;
    const scale = previewScale({ containerWidth: container, pageWidthPt: A4_WIDTH_PT });
    expect(scale).toBeCloseTo(container / A4_WIDTH_PT, 10);
    expect(scale).toBeLessThan(naturalScale(EDITOR_FONT_PX));
  });

  it("自定义基准字号：自然系数随之变化", () => {
    const scale = previewScale({
      containerWidth: 1200,
      pageWidthPt: A4_WIDTH_PT,
      targetFontPx: 16,
    });
    expect(scale).toBeCloseTo(naturalScale(16), 10);
  });

  it("容器宽度为 0 / 负数 / NaN：返回 NaN（调用方跳过应用）", () => {
    expect(previewScale({ containerWidth: 0, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: -1, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewScale({ containerWidth: NaN, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
  });

  it("页宽为 0 / NaN：返回 NaN", () => {
    expect(previewScale({ containerWidth: 800, pageWidthPt: 0 })).toBeNaN();
    expect(previewScale({ containerWidth: 800, pageWidthPt: NaN })).toBeNaN();
  });
});

describe("previewCanvasWidth（画布显示宽度）", () => {
  it("窄容器：画布宽度 = 容器宽度（铺满）", () => {
    expect(previewCanvasWidth({ containerWidth: 500, pageWidthPt: A4_WIDTH_PT })).toBeCloseTo(
      500,
      10,
    );
  });

  it("宽容器：画布宽度 = 页宽 × 自然系数（A4 约 568px）", () => {
    expect(
      previewCanvasWidth({ containerWidth: 1200, pageWidthPt: A4_WIDTH_PT }),
    ).toBeCloseTo(A4_WIDTH_PT * naturalScale(EDITOR_FONT_PX), 10);
  });

  it("测量失败：返回 NaN", () => {
    expect(previewCanvasWidth({ containerWidth: 0, pageWidthPt: A4_WIDTH_PT })).toBeNaN();
    expect(previewCanvasWidth({ containerWidth: 800, pageWidthPt: NaN })).toBeNaN();
  });
});

describe("viewBoxWidthPt（SVG viewBox → 页宽 pt）", () => {
  it("空格分隔：0 0 595.28 841.89 → 595.28", () => {
    expect(viewBoxWidthPt("0 0 595.28 841.89")).toBeCloseTo(595.28, 10);
  });

  it("逗号分隔", () => {
    expect(viewBoxWidthPt("0,0,595.28,841.89")).toBeCloseTo(595.28, 10);
  });

  it("容忍多余空白", () => {
    expect(viewBoxWidthPt("  0  0  595.28  841.89 ")).toBeCloseTo(595.28, 10);
  });

  it("解析失败：返回 NaN", () => {
    expect(viewBoxWidthPt("")).toBeNaN();
    expect(viewBoxWidthPt("0 0 x 841")).toBeNaN();
    expect(viewBoxWidthPt("0 0")).toBeNaN();
  });
});
