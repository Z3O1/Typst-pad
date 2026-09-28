import { describe, it, expect } from "vitest";
import { pageCoordinates, sourceRevealRange } from "./document-interaction";

describe("整页交互", () => {
  it("缩放与滚动后的页面坐标沿用原始 viewBox", () => {
    expect(
      pageCoordinates(
        { x: 135, y: 220 },
        { left: 10, top: -30, width: 250, height: 500 },
        { x: 0, y: 0, width: 500, height: 1000 },
      ),
    ).toEqual({ xPt: 250, yPt: 500 });
    expect(
      pageCoordinates(
        { x: 0, y: 0 },
        { left: 0, top: 0, width: 0, height: 1 },
        { x: 0, y: 0, width: 5, height: 5 },
      ),
    ).toBeNull();
  });
  it("公式末尾和多行脚本内容展开完整源码", () => {
    const math = "正文 $x^2 + y$";
    expect(sourceRevealRange(math, math.length)).toEqual({
      from: 3,
      to: math.length,
      kind: "math",
    });
    const script = "前文\n#table(columns: 2,\n [甲],\n [乙])\n后文";
    const range = sourceRevealRange(script, script.indexOf("甲") + 1);
    expect(script.slice(range.from, range.to)).toBe("#table(columns: 2,\n [甲],\n [乙])");
    expect(range.kind).toBe("code");
    expect(sourceRevealRange("\n正文", 0)).toEqual({ from: 0, to: 0, kind: "text" });
  });
});

it("图片调用起点和 Hash 边界展开完整多行脚本", () => {
  const doc = '前文\n#image(\n "a.png",\n width: 60pt,\n)\n后文';
  for (const pos of [doc.indexOf("#"), doc.indexOf("image"), doc.indexOf("width")]) {
    const range = sourceRevealRange(doc, pos);
    expect(range.kind).toBe("code");
    expect(doc.slice(range.from, range.to)).toBe('#image(\n "a.png",\n width: 60pt,\n)');
  }
});
