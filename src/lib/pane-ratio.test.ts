// pane-ratio 单元测试：Ctrl+Shift+滚轮改分栏比例的纯逻辑（方向 / 档距 / 收敛 / 非法输入）。
import { describe, it, expect } from "vitest";
import {
  PANE_RATIO_DEFAULT,
  PANE_RATIO_MAX,
  PANE_RATIO_MIN,
  PANE_RATIO_STEP,
  clampPaneRatio,
  nextPaneRatio,
  paneRatioFlexStyle,
  paneRatioPercent,
  wheelResizeDelta,
} from "./pane-ratio";

describe("clampPaneRatio", () => {
  it("界内原样返回", () => {
    expect(clampPaneRatio(0.5)).toBe(0.5);
    expect(clampPaneRatio(PANE_RATIO_MIN)).toBe(PANE_RATIO_MIN);
    expect(clampPaneRatio(PANE_RATIO_MAX)).toBe(PANE_RATIO_MAX);
  });

  it("超界收敛到上下限（编辑区与预览区都不会被挤没）", () => {
    expect(clampPaneRatio(0.1)).toBe(PANE_RATIO_MIN);
    expect(clampPaneRatio(0.99)).toBe(PANE_RATIO_MAX);
    expect(clampPaneRatio(-3)).toBe(PANE_RATIO_MIN);
  });

  it("非法值（NaN / null / undefined）回落到默认 50%", () => {
    expect(clampPaneRatio(Number.NaN)).toBe(PANE_RATIO_DEFAULT);
    expect(clampPaneRatio(null)).toBe(PANE_RATIO_DEFAULT);
    expect(clampPaneRatio(undefined)).toBe(PANE_RATIO_DEFAULT);
  });
});

describe("nextPaneRatio", () => {
  it("滚轮向上（deltaY < 0）= 预览区变宽", () => {
    expect(nextPaneRatio(0.5, -100)).toBeCloseTo(0.5 + PANE_RATIO_STEP, 6);
    expect(nextPaneRatio(0.5, -120)).toBeCloseTo(0.5 + PANE_RATIO_STEP, 6);
  });

  it("滚轮向下 = 预览区变窄", () => {
    expect(nextPaneRatio(0.5, 100)).toBeCloseTo(0.5 - PANE_RATIO_STEP, 6);
  });

  it("触摸板的小 delta 不会一划到底（按幅度折算，下限 0.2 档）", () => {
    expect(nextPaneRatio(0.5, -4)).toBeCloseTo(0.5 + 0.2 * PANE_RATIO_STEP, 6);
  });

  it("大 delta（页模式 / 惯性滑动）最多 3 档，不会一步跨到边界", () => {
    expect(nextPaneRatio(0.5, -1000)).toBeCloseTo(0.5 + 3 * PANE_RATIO_STEP, 6);
    expect(nextPaneRatio(0.5, -1, 2)).toBeCloseTo(0.5 + 3 * PANE_RATIO_STEP, 6);
  });

  it("行模式（deltaMode = 1）一格算一档", () => {
    expect(nextPaneRatio(0.5, -3, 1)).toBeCloseTo(0.5 + 3 * PANE_RATIO_STEP, 6);
    expect(nextPaneRatio(0.5, -1, 1)).toBeCloseTo(0.5 + PANE_RATIO_STEP, 6);
  });

  it("到边界后不再变化（继续滚不越界）", () => {
    expect(nextPaneRatio(PANE_RATIO_MAX, -100)).toBe(PANE_RATIO_MAX);
    expect(nextPaneRatio(PANE_RATIO_MIN, 100)).toBe(PANE_RATIO_MIN);
    expect(nextPaneRatio(0.74, -100)).toBe(PANE_RATIO_MAX); // 只会顶到上限，不会超过
  });

  it("deltaY 为 0 / 非法时不动", () => {
    expect(nextPaneRatio(0.6, 0)).toBe(0.6);
    expect(nextPaneRatio(0.6, Number.NaN)).toBe(0.6);
  });

  it("起点非法时从默认值开始算（旧存档 / 脏数据不至于把分栏搞乱）", () => {
    expect(nextPaneRatio(Number.NaN, -100)).toBeCloseTo(PANE_RATIO_DEFAULT + PANE_RATIO_STEP, 6);
  });
});

describe("wheelResizeDelta", () => {
  it("有纵向位移就用纵向", () => {
    expect(wheelResizeDelta(-100, 0)).toBe(-100);
    expect(wheelResizeDelta(100, -50)).toBe(100); // 两者都有时纵向优先
  });

  it("纵向为 0 时退回横向（Shift 滚轮被浏览器转成横向的真机形态）", () => {
    expect(wheelResizeDelta(0, 100)).toBe(100);
    expect(wheelResizeDelta(0, -100)).toBe(-100);
  });

  it("都没有 / 非法值 → 0（不动）", () => {
    expect(wheelResizeDelta(0, 0)).toBe(0);
    expect(wheelResizeDelta(Number.NaN, Number.NaN)).toBe(0);
    expect(wheelResizeDelta(Number.NaN, 100)).toBe(100);
  });

  it("配合 nextPaneRatio：横向位移同样能改比例（不再「按了没反应」）", () => {
    const delta = wheelResizeDelta(0, -100);
    expect(nextPaneRatio(0.5, delta)).toBeCloseTo(0.5 + PANE_RATIO_STEP, 6);
  });
});

describe("paneRatioPercent / paneRatioFlexStyle", () => {
  it("百分比取整，越界先收敛", () => {
    expect(paneRatioPercent(0.5)).toBe(50);
    expect(paneRatioPercent(0.614)).toBe(61);
    expect(paneRatioPercent(0.95)).toBe(75);
  });

  it("内联样式是 flex-basis（编辑区的 flex:1 拿剩下的）", () => {
    expect(paneRatioFlexStyle(0.6)).toBe("flex: 0 0 60%");
    expect(paneRatioFlexStyle(Number.NaN)).toBe("flex: 0 0 50%");
  });
});
