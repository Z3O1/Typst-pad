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
  previewPageWidthPt,
  reflowCanvasWidth,
  isReflowApplied,
  PREVIEW_PAGE_MIN_PT,
  PREVIEW_PAGE_MAX_PT,
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

describe("界面缩放（uiZoom）：预览必须跟着变大，但永不超出栏宽", () => {
  // 背景（2026-09-14 用户先后两次反馈「预览框大小还是没变」「预览框里面的字的大小还是没变」）：
  // 界面缩放走 webview setZoom，预览栏的 CSS 宽度会一起变小；若拿这个变小后的宽度算"铺满"，
  // 画布就缩回原样，引擎再放大一次正好抵消 —— 缩放对编辑区有效、对预览无效。
  // 传 uiZoom 后按缩放**前**的栏宽算画布，物理尺寸才跟着缩放真的变大（1.5 档大 1.5 倍）。
  //
  // **2026-09-18 用户反馈「为什么预览框还是会出现下方的滑动条」后改口「永不横滚」**：
  // 画布再多也不能超过**当前**栏宽（min(缩放前栏宽, 当前栏宽)）—— 下面第一组用例就是那次
  // 真机现场（文档自带 `#set page(paper: "a4")`，150% 下栏宽 451、画布原本 568 → 溢出 117px）。

  it("150%：画布铺满栏宽（不再溢出），物理尺寸仍接近 100% 时的画布宽", () => {
    const zoomedContainer = 331; // 1040px 窗口在 150% 下量到的栏宽
    const at100 = previewCanvasWidth({ containerWidth: 505, pageWidthPt: A4_WIDTH_PT });
    const zoomed = previewCanvasWidth({
      containerWidth: zoomedContainer,
      pageWidthPt: A4_WIDTH_PT,
      uiZoom: 1.5,
    });
    // 不传 uiZoom 会缩回 331（这就是"预览没变"的现场）；传了之后**也不许超过栏宽**
    expect(previewCanvasWidth({ containerWidth: zoomedContainer, pageWidthPt: A4_WIDTH_PT })).toBeCloseTo(331, 10);
    expect(zoomed).toBeCloseTo(zoomedContainer, 10);
    // 但物理尺寸（CSS × 缩放）与 100% 时基本一致 —— 所以"跟着变大"这件事没有丢
    expect((zoomed * 1.5) / at100).toBeGreaterThan(0.95);
  });

  it("**回归**（用户那份 A4 文档）：150% / 250% 下画布 = 栏宽，一点不溢出", () => {
    // 真机几何：1400px 窗口在 150% 下 CSS 视口 933px → 预览栏 451px；250% 下 264px。
    // 修前画布被自然尺寸（A4 ≈ 568px）封顶 → 分别溢出 117px / 304px（浏览器验收实测）。
    for (const [containerWidth, uiZoom] of [
      [451, 1.5],
      [264, 2.5],
    ] as const) {
      const width = previewCanvasWidth({ containerWidth, pageWidthPt: A4_WIDTH_PT, uiZoom });
      expect(width).toBeCloseTo(containerWidth, 10);
      expect(width).toBeLessThanOrEqual(containerWidth);
    }
  });

  it("任何缩放档位下画布都不超过栏宽（永不横滚的硬保证）", () => {
    for (const zoom of [0.5, 0.8, 1, 1.2, 1.5, 2, 2.5]) {
      for (const containerWidth of [180, 264, 451, 685, 1200]) {
        const width = previewCanvasWidth({ containerWidth, pageWidthPt: A4_WIDTH_PT, uiZoom: zoom });
        expect(width).toBeLessThanOrEqual(containerWidth + 1e-9);
      }
    }
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

// ---------------------------------------------------------------------------
// 预览**按栏宽重新排版**（2026-09-14 用户反馈「预览模式还是有横的拖动的条」）：
// 栏宽 → 页宽（pt）→ 画布宽度，三者必须自洽：**画布恒 ≤ 栏宽**（这是"永不横滚"的保证），
// 且重排生效时预览字号与编辑器一致（用户单位→CSS px = 14/11）。
// ---------------------------------------------------------------------------
describe("previewPageWidthPt（栏宽 → 重排页宽）", () => {
  it("页宽 = 栏宽 × 11/14（于是画布 1:1 铺满栏宽时，正文渲染成 14px）", () => {
    expect(previewPageWidthPt(700)).toBeCloseTo((700 * TYPST_DEFAULT_TEXT_PT) / EDITOR_FONT_PX, 6);
  });

  it("重排后 1:1 铺满，等价于 naturalScale 的字号对齐", () => {
    const container = 512;
    const pagePt = previewPageWidthPt(container);
    // 画布 = 栏宽 ÷ 页宽 = 每 pt 多少 CSS px，应等于 14/11
    expect(container / pagePt).toBeCloseTo(EDITOR_FONT_PX / TYPST_DEFAULT_TEXT_PT, 6);
  });

  it("页宽夹在 180..=A4 之间（栏太窄不会挤成碎字，太宽不会行长过长）", () => {
    expect(previewPageWidthPt(100)).toBe(PREVIEW_PAGE_MIN_PT);
    expect(previewPageWidthPt(2000)).toBe(PREVIEW_PAGE_MAX_PT);
  });

  it("容器不可测（0 / 负数 / NaN）→ NaN（调用方据此关掉重排）", () => {
    expect(previewPageWidthPt(0)).toBeNaN();
    expect(previewPageWidthPt(-10)).toBeNaN();
    expect(previewPageWidthPt(Number.NaN)).toBeNaN();
  });
});

describe("reflowCanvasWidth（重排画布宽度）", () => {
  it("**恒 ≤ 容器宽**——栏从宽到窄扫一遍都不许溢出（永不横滚）", () => {
    for (const container of [240, 320, 480, 700, 900, 1400]) {
      const pagePt = previewPageWidthPt(container);
      const canvas = reflowCanvasWidth(container, pagePt);
      expect(canvas).toBeLessThanOrEqual(container + 1e-9);
    }
  });

  it("栏宽在上下限之内时正好铺满栏宽", () => {
    expect(reflowCanvasWidth(700, previewPageWidthPt(700))).toBeCloseTo(700, 6);
  });

  it("栏极窄（页宽被夹到下限量）时仍不溢出：画布退到栏宽", () => {
    expect(reflowCanvasWidth(150, previewPageWidthPt(150))).toBeCloseTo(150, 6);
  });

  it("容器/页宽非法 → NaN", () => {
    expect(reflowCanvasWidth(0, 300)).toBeNaN();
    expect(reflowCanvasWidth(500, Number.NaN)).toBeNaN();
  });
});

describe("isReflowApplied（注入的页设置是否生效）", () => {
  it("产物页宽 = 请求页宽（±1pt）→ 生效", () => {
    expect(isReflowApplied(300, 300)).toBe(true);
    expect(isReflowApplied(300.5, 300)).toBe(true);
  });

  it("文档自己 #set page 覆盖了注入（产物仍是 A4）→ 不生效，退回等比缩放", () => {
    expect(isReflowApplied(A4_WIDTH_PT, 300)).toBe(false);
  });

  it("测量失败（NaN）→ 不生效", () => {
    expect(isReflowApplied(Number.NaN, 300)).toBe(false);
    expect(isReflowApplied(300, Number.NaN)).toBe(false);
  });
});
