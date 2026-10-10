import { describe, expect, it } from "vitest";
import {
  FORMULA_PREVIEW_ARROW,
  FORMULA_PREVIEW_EDGE_MARGIN,
  FORMULA_PREVIEW_GAP,
  FORMULA_PREVIEW_MIN_READABLE,
  FORMULA_PREVIEW_PADDING,
  layoutFormulaPreview,
  type FormulaPreviewRect,
} from "./formula-preview-layout";

const viewport: FormulaPreviewRect = { left: 0, top: 0, right: 600, bottom: 800 };
const centerAnchor: FormulaPreviewRect = { left: 280, top: 100, right: 320, bottom: 116 };

function layout(
  overrides: {
    widthPt?: number;
    heightPt?: number;
    scale?: number;
    anchor?: FormulaPreviewRect;
    viewport?: FormulaPreviewRect;
  } = {},
) {
  return layoutFormulaPreview({
    widthPt: overrides.widthPt ?? 40,
    heightPt: overrides.heightPt ?? 20,
    scale: overrides.scale ?? 1.27,
    anchor: overrides.anchor ?? centerAnchor,
    viewport: overrides.viewport ?? viewport,
  });
}

describe("layoutFormulaPreview", () => {
  it("短公式按页面缩放展示，不无谓拉满", () => {
    const box = layout({ widthPt: 40, heightPt: 20 });
    expect(box).not.toBeNull();
    expect(box!.contentWidth).toBeCloseTo(40 * 1.27);
    expect(box!.contentHeight).toBeCloseTo(20 * 1.27);
    expect(box!.width).toBeCloseTo(40 * 1.27 + 2 * FORMULA_PREVIEW_PADDING);
    expect(box!.scrollX).toBe(false);
    expect(box!.scrollY).toBe(false);
  });

  it("保持公式宽高比，不把窄高公式拉满", () => {
    const box = layout({ widthPt: 40, heightPt: 800 });
    expect(box).not.toBeNull();
    expect(box!.contentHeight).toBeCloseTo(box!.contentWidth * (800 / 40));
    // 高公式自然高度超出可见区 → 卡片内纵向滚动，但宽度仍是自然窄宽。
    expect(box!.scrollY).toBe(true);
    expect(box!.contentWidth).toBeCloseTo(40 * 1.27);
  });

  it("长行公式先缩到可见区，保持可读且不横滚", () => {
    // 自然宽 500pt×1.27 ≈ 635px，远超 600px 视口但仍可缩到可读。
    const box = layout({ widthPt: 500, heightPt: 40 });
    expect(box).not.toBeNull();
    const availW =
      viewport.right - viewport.left - 2 * (FORMULA_PREVIEW_EDGE_MARGIN + FORMULA_PREVIEW_PADDING);
    expect(box!.contentWidth).toBeCloseTo(availW);
    expect(box!.scrollX).toBe(false);
    expect(box!.width).toBeLessThanOrEqual(viewport.right - viewport.left);
    // 缩小后仍不低于可读下限。
    expect(box!.contentWidth).toBeGreaterThanOrEqual(500 * 1.27 * FORMULA_PREVIEW_MIN_READABLE);
  });

  it("极长公式保住可读下限，改为卡片内横向滚动", () => {
    // 视口极窄：可见宽只有约 120px，小于可读下限。
    const narrow: FormulaPreviewRect = { left: 0, top: 0, right: 160, bottom: 600 };
    const box = layout({ widthPt: 800, heightPt: 40, viewport: narrow });
    expect(box).not.toBeNull();
    expect(box!.scrollX).toBe(true);
    expect(box!.contentWidth).toBeCloseTo(800 * 1.27 * FORMULA_PREVIEW_MIN_READABLE);
    // 卡片整体仍不越出窄视口。
    expect(box!.left).toBeGreaterThanOrEqual(FORMULA_PREVIEW_EDGE_MARGIN);
    expect(box!.left + box!.width).toBeLessThanOrEqual(narrow.right - FORMULA_PREVIEW_EDGE_MARGIN);
  });

  it("高矩阵/多行公式限制高度并在卡片内滚动", () => {
    const box = layout({ widthPt: 200, heightPt: 2000 });
    expect(box).not.toBeNull();
    expect(box!.scrollY).toBe(true);
    expect(box!.height).toBeLessThanOrEqual(viewport.bottom - viewport.top);
    expect(box!.viewHeight).toBeLessThan(box!.contentHeight);
  });

  it("靠右锚点时卡片向左平移，箭头仍指回锚点", () => {
    const anchor: FormulaPreviewRect = { left: 570, top: 100, right: 590, bottom: 116 };
    const box = layout({ widthPt: 400, heightPt: 40, anchor });
    expect(box).not.toBeNull();
    expect(box!.left + box!.width).toBeLessThanOrEqual(
      viewport.right - FORMULA_PREVIEW_EDGE_MARGIN + 0.01,
    );
    const arrowTip = box!.left + box!.arrowOffset;
    expect(arrowTip).toBeGreaterThanOrEqual(box!.left);
    expect(arrowTip).toBeLessThanOrEqual(box!.left + box!.width);
  });

  it("锚点靠底部时翻到上方，箭头方向随之切换", () => {
    const anchor: FormulaPreviewRect = { left: 280, top: 720, right: 320, bottom: 736 };
    const box = layout({ widthPt: 200, heightPt: 300, anchor });
    expect(box).not.toBeNull();
    expect(box!.flipped).toBe(true);
    // 翻上去后卡片底边在锚点上方，且不越出视口顶边。
    expect(box!.top + box!.height).toBeLessThanOrEqual(anchor.top - FORMULA_PREVIEW_GAP + 0.01);
    expect(box!.top).toBeGreaterThanOrEqual(FORMULA_PREVIEW_EDGE_MARGIN - 0.01);
  });

  it("卡片高度含箭头", () => {
    const box = layout();
    expect(box).not.toBeNull();
    expect(box!.height).toBeCloseTo(
      box!.viewHeight + 2 * FORMULA_PREVIEW_PADDING + FORMULA_PREVIEW_ARROW,
    );
  });

  it("非法输入返回 null", () => {
    expect(layout({ widthPt: 0 })).toBeNull();
    expect(layout({ heightPt: -1 })).toBeNull();
    expect(layout({ scale: Number.NaN })).toBeNull();
    expect(layout({ viewport: { left: 0, top: 0, right: 0, bottom: 100 } })).toBeNull();
    expect(layout({ viewport: { left: 0, top: 0, right: 100, bottom: 0 } })).toBeNull();
  });
});
