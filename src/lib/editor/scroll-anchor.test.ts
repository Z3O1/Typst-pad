import { describe, it, expect } from "vitest";
import { anchorYMargin } from "./scroll-anchor";

describe("anchorYMargin：把光标钉在鼠标那个屏幕高度", () => {
  it("行盒中心对齐：滚动容器顶部 100、点击在 y=300、行高 30 → 余量 = 300-100-15", () => {
    expect(anchorYMargin(300, 100, 1000, 30, "center")).toBe(185);
  });

  it("顶部对齐：不减半行高", () => {
    expect(anchorYMargin(300, 100, 1000, 30, "top")).toBe(200);
  });

  it("点在滚动容器上方（客户区之外）→ 夹到 0", () => {
    expect(anchorYMargin(80, 100, 1000, 30, "center")).toBe(0);
  });

  it("点在滚动容器下方 → 夹到视口高 - 1", () => {
    expect(anchorYMargin(5000, 100, 1000, 30, "center")).toBe(999);
  });

  it("视口高不可测（0 / NaN）→ 只夹下界", () => {
    expect(anchorYMargin(300, 100, 0, 30)).toBe(0);
    expect(anchorYMargin(300, 100, NaN, 30)).toBe(0);
  });

  it("坐标非法 → 0（最保守：顶到最上面）", () => {
    expect(anchorYMargin(NaN, 100, 1000, 30)).toBe(0);
    expect(anchorYMargin(300, NaN, 1000, 30)).toBe(0);
    expect(anchorYMargin(Infinity, 100, 1000, 30)).toBe(0);
  });

  it("行高不可测时按顶部对齐处理（不产出 NaN）", () => {
    expect(anchorYMargin(300, 100, 1000, NaN, "center")).toBe(200);
  });
});
