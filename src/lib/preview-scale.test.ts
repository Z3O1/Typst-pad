// preview-scale 单元测试：容器宽度、页宽、基准字号 → 缩放系数/画布尺寸（纯函数，无 DOM）
import { describe, it, expect } from "vitest";
import {
  PT_TO_PX,
  TYPST_DEFAULT_TEXT_PT,
  EDITOR_FONT_PX,
  naturalScale,
  normalizeUiZoom,
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

describe("界面缩放（uiZoom）：预览必须跟着变大", () => {
  // 背景（2026-09-14 用户先后两次反馈「预览框大小还是没变」「预览框里面的字的大小还是没变」）：
  // 界面缩放走 webview setZoom，预览栏的 CSS 宽度会一起变小；若拿这个变小后的宽度算"铺满"，
  // 画布就缩回原样，引擎再放大一次正好抵消 —— 缩放对编辑区有效、对预览无效。
  // 传 uiZoom 后按缩放前的栏宽算，画布 CSS 宽度保持 100% 时的值，由引擎把它真正放大（1.5 档大 1.5 倍）。
  // 代价：页面是固定版心，放大到超过栏宽时预览栏出现横向滚动条（"跟着变大"与"永不横向滚动"只能二选一，
  // 用户选了前者；配套的"左缘可达"见 +page.svelte 的 .preview-paper { margin-inline: auto }）。

  it("150%：画布 CSS 宽度保持 100% 时的值，物理尺寸由引擎放大 1.5 倍", () => {
    const zoomedContainer = 331; // 1040px 窗口在 150% 下量到的栏宽
    const at100 = previewCanvasWidth({ containerWidth: 505, pageWidthPt: A4_WIDTH_PT });
    const zoomed = previewCanvasWidth({
      containerWidth: zoomedContainer,
      pageWidthPt: A4_WIDTH_PT,
      uiZoom: 1.5,
    });
    // 不传 uiZoom 会缩回 331（这就是"预览没变"的现场）；传了之后与 100% 时的 505 基本一致
    expect(previewCanvasWidth({ containerWidth: zoomedContainer, pageWidthPt: A4_WIDTH_PT })).toBeCloseTo(331, 10);
    expect(zoomed).toBeCloseTo(zoomedContainer * 1.5, 10);
    expect(Math.abs(zoomed - at100) / at100).toBeLessThan(0.05);
    // 物理尺寸（CSS × 缩放）真的变大 —— 用户要的就是这个
    expect((zoomed * 1.5) / at100).toBeGreaterThan(1.4);
  });

  it("缩放 200% 且栏宽换算后超过自然尺寸：仍被自然系数夹住（字号仍与编辑区一致）", () => {
    const naturalWidth = A4_WIDTH_PT * naturalScale(EDITOR_FONT_PX);
    const width = previewCanvasWidth({
      containerWidth: 600,
      pageWidthPt: A4_WIDTH_PT,
      uiZoom: 2,
    });
    expect(width).toBeCloseTo(naturalWidth, 10);
  });

  it("缩小到 50%：铺满分支按缩放前的栏宽算（引擎再把它缩一半）", () => {
    // 50% 缩放时 CSS 视口是窗口的两倍宽：量到的栏宽 800 → 换算回未缩放的 400，
    // 等价于"100% 时这栏只有 400px"；物理尺寸 = 400 × 0.5 = 200（正好一半）。
    const width = previewCanvasWidth({
      containerWidth: 800,
      pageWidthPt: A4_WIDTH_PT,
      uiZoom: 0.5,
    });
    expect(width).toBeCloseTo(400, 10);
  });

  it("uiZoom 缺省 / 非法值：按 1 处理（老调用方行为不变）", () => {
    const base = previewCanvasWidth({ containerWidth: 400, pageWidthPt: A4_WIDTH_PT });
    for (const uiZoom of [undefined, 0, -1, NaN, Infinity]) {
      expect(previewCanvasWidth({ containerWidth: 400, pageWidthPt: A4_WIDTH_PT, uiZoom })).toBeCloseTo(
        base,
        10,
      );
    }
  });

  it("normalizeUiZoom：只认有限正数", () => {
    expect(normalizeUiZoom(1.3)).toBe(1.3);
    expect(normalizeUiZoom(undefined)).toBe(1);
    expect(normalizeUiZoom(0)).toBe(1);
    expect(normalizeUiZoom(-2)).toBe(1);
    expect(normalizeUiZoom(NaN)).toBe(1);
    expect(normalizeUiZoom(Infinity)).toBe(1);
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
