// zoom 单元测试：Ctrl+滚轮界面缩放的纯逻辑（方向 / 档距 / 收敛 / 浮点圆整）。
import { describe, it, expect } from "vitest";
import {
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  nextZoom,
  wheelZoomSteps,
  zoomIn,
  zoomLabel,
  zoomOut,
  zoomPercent,
} from "./zoom";

describe("clampZoom", () => {
  it("界内原样返回，并圆整到一档（消掉浮点毛刺）", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.2)).toBe(1.2);
    expect(clampZoom(1.2000000000000002)).toBe(1.2);
    expect(clampZoom(0.5)).toBe(ZOOM_MIN);
    expect(clampZoom(2.5)).toBe(ZOOM_MAX);
  });

  it("超界收敛到上下限", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(-2)).toBe(ZOOM_MIN);
  });

  it("非法值回落 100%", () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(null)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(undefined)).toBe(ZOOM_DEFAULT);
  });

  it("圆整到最近的档（0.1 的倍数）", () => {
    expect(clampZoom(1.14)).toBe(1.1);
    expect(clampZoom(1.16)).toBe(1.2);
  });
});

describe("wheelZoomSteps", () => {
  it("滚轮向上 = 放大（正档），向下 = 缩小", () => {
    expect(wheelZoomSteps(-100)).toBe(1);
    expect(wheelZoomSteps(100)).toBe(-1);
  });

  it("纵向位移为 0 时退回横向（Shift 滚轮被浏览器转成横向的真机形态）", () => {
    expect(wheelZoomSteps(0, -100)).toBe(1);
    expect(wheelZoomSteps(0, 100)).toBe(-1);
  });

  it("两者都有时纵向优先；都没有则 0 档（不动）", () => {
    expect(wheelZoomSteps(-100, 100)).toBe(1);
    expect(wheelZoomSteps(0, 0)).toBe(0);
    expect(wheelZoomSteps(Number.NaN, Number.NaN)).toBe(0);
  });

  it("触摸板的小 delta 不会一划到尾（下限 0.2 档）", () => {
    expect(wheelZoomSteps(-4)).toBeCloseTo(0.2, 6);
  });

  it("大 delta / 页模式最多 3 档", () => {
    expect(wheelZoomSteps(-1000)).toBe(3);
    expect(wheelZoomSteps(-1, 0, 2)).toBe(3);
  });

  it("行模式（deltaMode = 1）一格算一档", () => {
    expect(wheelZoomSteps(-1, 0, 1)).toBe(1);
    expect(wheelZoomSteps(-3, 0, 1)).toBe(3);
  });
});

describe("nextZoom / zoomIn / zoomOut", () => {
  it("向上滚 5 格：100% → 150%", () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 5; i++) z = nextZoom(z, -100);
    expect(z).toBe(1.5);
    expect(zoomLabel(z)).toBe("150%");
  });

  it("累加不产生浮点毛刺", () => {
    let z = ZOOM_DEFAULT;
    for (let i = 0; i < 7; i++) z = nextZoom(z, -100);
    expect(z).toBe(1.7);
    expect(z.toString()).toBe("1.7");
  });

  it("到上下限后不再变化", () => {
    expect(nextZoom(ZOOM_MAX, -100)).toBe(ZOOM_MAX);
    expect(nextZoom(ZOOM_MIN, 100)).toBe(ZOOM_MIN);
  });

  it("起点非法时按 100% 起算", () => {
    expect(nextZoom(Number.NaN, -100)).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 6);
    expect(nextZoom(undefined, -100)).toBeCloseTo(ZOOM_DEFAULT + ZOOM_STEP, 6);
  });

  it("deltaY 为 0 且没有横向位移时不动", () => {
    expect(nextZoom(1.3, 0)).toBe(1.3);
  });

  it("菜单用的 zoomIn / zoomOut 按档步进并夹住", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomIn(1, 3)).toBe(1.3);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});

describe("zoomPercent / zoomLabel", () => {
  it("取整百分比，越界先收敛", () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(1.25)).toBe(130); // 1.25 圆整到 1.3
    expect(zoomPercent(9)).toBe(250);
    expect(zoomLabel(Number.NaN)).toBe("100%");
  });
});
