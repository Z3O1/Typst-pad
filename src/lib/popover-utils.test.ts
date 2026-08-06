// 错误列表 Popover 视口收边纯函数的单测。
import { describe, it, expect } from "vitest";
import { clampPopoverRect } from "./popover-utils";

// 常见矩形：520px 宽（CSS 默认宽）、300px 高的 Popover，view 1000x700
const rect = { left: 240, right: 760, top: 200, width: 520, height: 300 };
const viewport = { width: 1000, height: 700 };

describe("clampPopoverRect 水平收边", () => {
  it("完全在视口内：不平移不限宽", () => {
    expect(clampPopoverRect(rect, viewport)).toEqual({
      translateX: 0,
      translateY: 0,
      maxWidth: 0,
    });
  });

  it("左缘越界：向右平移回视口（保留 margin）", () => {
    // 徽标靠左：Popover 从窗口左缘溢出，left = -300 → 平移量 = 8 - (-300) = 308
    expect(
      clampPopoverRect({ ...rect, left: -300, right: 220 }, viewport),
    ).toEqual({ translateX: 308, translateY: 0, maxWidth: 0 });
  });

  it("右缘越界：向左平移回视口（保留 margin）", () => {
    // right = 1020 → 平移量 = (1000 - 8) - 1020 = -28
    expect(
      clampPopoverRect({ ...rect, left: 500, right: 1020 }, viewport),
    ).toEqual({ translateX: -28, translateY: 0, maxWidth: 0 });
  });

  it("恰好贴边（rect.left = margin）：不平移", () => {
    expect(
      clampPopoverRect({ ...rect, left: 8, right: 528 }, viewport),
    ).toEqual({ translateX: 0, translateY: 0, maxWidth: 0 });
  });

  it("恰好贴边（rect.right = vw − margin）：不平移", () => {
    expect(
      clampPopoverRect({ ...rect, left: 472, right: 992 }, viewport),
    ).toEqual({ translateX: 0, translateY: 0, maxWidth: 0 });
  });
});

describe("clampPopoverRect 垂直收边", () => {
  it("顶部越界：向下平移回视口", () => {
    // top = -100 → 平移量 = 8 - (-100) = 108
    expect(
      clampPopoverRect({ ...rect, top: -100 }, viewport),
    ).toEqual({ translateX: 0, translateY: 108, maxWidth: 0 });
  });

  it("顶部未越界：垂直不平移", () => {
    expect(clampPopoverRect({ ...rect, top: 200 }, viewport)).toEqual({
      translateX: 0,
      translateY: 0,
      maxWidth: 0,
    });
  });
});

describe("clampPopoverRect 极小窗口（整层宽于视口可用空间）", () => {
  // 视口 500px：可用宽度 = 500 - 2*8 = 484 < 520，单纯平移无法同时满足左右 margin
  it("徽标靠左：限宽并右移，左缘对齐 margin、右缘落在 vw − margin 内", () => {
    const v500 = { width: 500, height: 700 };
    const r = { left: -420, right: 100, top: 200, width: 520, height: 300 };
    // maxWidth = 484；限宽后左缘 = right − 484 = -384；平移量 = 8 - (-384) = 392
    // 校验：新左缘 = -384 + 392 = 8 = margin；新右缘 = 100 + 392 = 492 = 500 − 8
    expect(clampPopoverRect(r, v500)).toEqual({
      translateX: 392,
      translateY: 0,
      maxWidth: 484,
    });
  });

  it("徽标靠右：限宽后仅小幅平移对齐", () => {
    const v500 = { width: 500, height: 700 };
    const r = { left: -30, right: 490, top: 200, width: 520, height: 300 };
    // 限宽后左缘 = 490 − 484 = 6 < 8；平移量 = 8 − 6 = 2
    expect(clampPopoverRect(r, v500)).toEqual({
      translateX: 2,
      translateY: 0,
      maxWidth: 484,
    });
  });

  it("Popover 未宽于可用空间时不限宽（限宽分支不误触发）", () => {
    const v500 = { width: 500, height: 700 };
    const r = { left: 10, right: 470, top: 200, width: 460, height: 300 };
    expect(clampPopoverRect(r, v500)).toEqual({
      translateX: 0,
      translateY: 0,
      maxWidth: 0,
    });
  });
});

describe("clampPopoverRect 自定义 margin 与组合越界", () => {
  it("自定义 margin（20px）生效", () => {
    expect(clampPopoverRect({ ...rect, left: -10, right: 510 }, viewport, 20)).toEqual(
      { translateX: 30, translateY: 0, maxWidth: 0 },
    );
  });

  it("水平 + 垂直同时越界：两个方向各自收边", () => {
    const r = { left: -50, right: 470, top: -80, width: 520, height: 300 };
    expect(clampPopoverRect(r, viewport)).toEqual({
      translateX: 58,
      translateY: 88,
      maxWidth: 0,
    });
  });
});
