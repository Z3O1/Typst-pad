import { describe, expect, it } from "vitest";
import { caretScrollDelta, projectDocumentCaret } from "./document-caret";

const caret = { offset: 3, page: 2, xPt: 30, yPt: 50, heightPt: 12 };
const rect = { left: 100, top: -40, width: 400, height: 600 };
const box = { x: 20, y: 30, width: 200, height: 300 };

describe("文档光标投影", () => {
  it("非零 viewBox、滚动和共同缩放都使用同一坐标系", () => {
    expect(projectDocumentCaret(caret, rect, box)).toEqual({
      left: 120,
      top: 0,
      height: 24,
      rotation: 0,
    });
  });

  it.each([-90, 30, 90, 180])("旋转 %s° 后起点及方向不受包围盒影响", (rotationDeg) => {
    const result = projectDocumentCaret({ ...caret, rotationDeg }, rect, box)!;
    expect(result.left).toBe(120);
    expect(result.top).toBe(0);
    expect(result.height).toBeCloseTo(24);
    expect(result.rotation).toBeCloseTo(rotationDeg);
  });

  it("非等比测量先缩放真实方向向量，而非只缩放高度", () => {
    const result = projectDocumentCaret(
      { ...caret, rotationDeg: 30 },
      { ...rect, width: 600 },
      box,
    )!;
    const radians = (result.rotation * Math.PI) / 180;
    expect(-Math.sin(radians) * result.height).toBeCloseTo(-18);
    expect(Math.cos(radians) * result.height).toBeCloseTo(Math.sqrt(3) * 12);
  });

  it("最小可见高度不影响实际插入点", () => {
    expect(projectDocumentCaret({ ...caret, heightPt: 0.1 }, rect, box)).toEqual({
      left: 120,
      top: 0,
      height: 2,
      rotation: 0,
    });
  });

  it("视口内光标不滚动，越界只移动需要的轴", () => {
    const viewport = { left: 10, top: 20, width: 200, height: 300 };
    expect(caretScrollDelta({ left: 100, top: 100, height: 20, rotation: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
    expect(caretScrollDelta({ left: 250, top: 350, height: 20, rotation: 0 }, viewport)).toEqual({
      x: 64,
      y: 74,
    });
    expect(caretScrollDelta({ left: 0, top: 0, height: 20, rotation: 0 }, viewport)).toEqual({
      x: -34,
      y: -44,
    });
  });

  it("旋转插入线按两端可见范围滚动，超大光标优先显露插入点", () => {
    const viewport = { left: 0, top: 0, width: 100, height: 100 };
    const rotated = caretScrollDelta({ left: 30, top: 50, height: 50, rotation: 90 }, viewport);
    expect(rotated.x).toBeCloseTo(-44);
    expect(rotated.y).toBe(0);
    expect(caretScrollDelta({ left: 50, top: 50, height: 500, rotation: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      caretScrollDelta(
        { left: 50, top: 50, height: 20, rotation: 0 },
        { ...viewport, width: 0, height: 0 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("无效或隐藏页面不生成可写入 CSS 的坏坐标", () => {
    expect(projectDocumentCaret(caret, { ...rect, width: 0 }, box)).toBeNull();
    expect(projectDocumentCaret(caret, rect, { ...box, height: 0 })).toBeNull();
    expect(projectDocumentCaret({ ...caret, rotationDeg: NaN }, rect, box)).toBeNull();
  });
});
