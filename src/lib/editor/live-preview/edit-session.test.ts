// 展开占位（报告 T4）的单元测试：上限、封顶、不累积这三条是核心。
import { describe, it, expect } from "vitest";
import { MAX_RESERVED_VIEWPORTS, planEditReserve, sourceHeightPx } from "./edit-session";

describe("planEditReserve", () => {
  it("渲染盒比源码高 → 补差值（把收缩按住）", () => {
    expect(planEditReserve({ renderPx: 49.66, sourcePx: 24.2, viewportPx: 800 })).toEqual({
      reservePx: expect.closeTo(25.46, 2),
      cappedByViewport: false,
    });
  });

  it("源码比渲染盒高（代码/表格那种自然增长）→ 不补（那是真实内容，压它就得裁切）", () => {
    expect(planEditReserve({ renderPx: 50, sourcePx: 145, viewportPx: 800 })).toEqual({
      reservePx: 0,
      cappedByViewport: false,
    });
  });

  it("相等 → 不补", () => {
    expect(planEditReserve({ renderPx: 24.2, sourcePx: 24.2, viewportPx: 800 }).reservePx).toBe(0);
  });

  it("超过一个可视高度 → 只补一个可视高度，并标记 capped", () => {
    const plan = planEditReserve({ renderPx: 5000, sourcePx: 24, viewportPx: 600 });
    expect(plan.reservePx).toBe(600 * MAX_RESERVED_VIEWPORTS);
    expect(plan.cappedByViewport).toBe(true);
  });

  it("补的值不得超过进入时的渲染盒高度（补偿是按住收缩，不是凭空加高）", () => {
    // 渲染盒 300、源码 0、视口 2000 → 差值 300 全部可补（差值本来就等于渲染盒）
    expect(planEditReserve({ renderPx: 300, sourcePx: 0, viewportPx: 2000 }).reservePx).toBe(300);
  });

  it("量不到视口高 → 只按渲染盒封顶（不因为量不到就补 0）", () => {
    expect(planEditReserve({ renderPx: 40, sourcePx: 24, viewportPx: 0 }).reservePx).toBe(16);
  });

  it("量不到渲染盒（还没渲过）→ 不补（宁可漏补，不可凭空加高）", () => {
    expect(planEditReserve({ renderPx: 0, sourcePx: 24, viewportPx: 800 }).reservePx).toBe(0);
  });

  it("**同样的输入永远同样的输出**：反复算不会越算越大（不累积的根因）", () => {
    const input = { renderPx: 120, sourcePx: 24.2, viewportPx: 500 };
    const first = planEditReserve(input).reservePx;
    for (let i = 0; i < 20; i++) {
      expect(planEditReserve(input).reservePx).toBe(first);
    }
  });

  it("非法输入不产出 NaN（渲染盒/源码/视口缺失都当 0）", () => {
    expect(planEditReserve({ renderPx: NaN, sourcePx: NaN, viewportPx: NaN })).toEqual({
      reservePx: 0,
      cappedByViewport: false,
    });
  });
});

describe("sourceHeightPx", () => {
  it("行数 × 行高", () => {
    expect(sourceHeightPx("$ x^2 $", 24.2)).toBeCloseTo(24.2, 3);
    expect(sourceHeightPx("$ a +\nb = c $", 24.2)).toBeCloseTo(48.4, 3);
  });

  it("空源码算一行；行高量不到算 0", () => {
    expect(sourceHeightPx("", 24.2)).toBeCloseTo(24.2, 3);
    expect(sourceHeightPx("abc", 0)).toBe(0);
  });
});
