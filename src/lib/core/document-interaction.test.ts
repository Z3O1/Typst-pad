import { describe, it, expect } from "vitest";
import {
  clickSourceRange,
  nearestPageCoordinates,
  pageCoordinates,
  sourceRevealRange,
} from "./document-interaction";

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
  it("纸张外侧空白保留页外坐标，按垂直距离选择不同纸型的页面", () => {
    const pages = [
      {
        rect: { left: 100, top: -100, width: 180, height: 200 },
        box: { x: 0, y: 0, width: 360, height: 400 },
      },
      {
        rect: { left: 100, top: 110, width: 240, height: 150 },
        box: { x: 5, y: 10, width: 480, height: 300 },
      },
    ];
    expect(nearestPageCoordinates({ x: 350, y: 0 }, pages)).toEqual({
      page: 1,
      xPt: 500,
      yPt: 200,
    });
    expect(nearestPageCoordinates({ x: 50, y: 150 }, pages)).toEqual({
      page: 2,
      xPt: -95,
      yPt: 90,
    });
    expect(nearestPageCoordinates({ x: 200, y: 104 }, pages)?.page).toBe(1);
    expect(nearestPageCoordinates({ x: 200, y: 106 }, pages)?.page).toBe(2);
    expect(nearestPageCoordinates({ x: 200, y: -200 }, pages)).toEqual({
      page: 1,
      xPt: 200,
      yPt: -200,
    });
    expect(nearestPageCoordinates({ x: 200, y: 300 }, pages)).toEqual({
      page: 2,
      xPt: 205,
      yPt: 390,
    });
  });
  it("空产物、隐藏页面和非法坐标不生成点击位置，页号不因跳过无效页而变化", () => {
    const hidden = {
      rect: { left: 0, top: 0, width: 0, height: 0 },
      box: { x: 0, y: 0, width: 100, height: 200 },
    };
    const visible = { ...hidden, rect: { left: 0, top: 0, width: 100, height: 200 } };
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [])).toBeNull();
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [hidden])).toBeNull();
    expect(nearestPageCoordinates({ x: NaN, y: 10 }, [visible])).toBeNull();
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [hidden, visible])?.page).toBe(2);
  });
  it("空白落点只移动光标，不因邻近公式或脚本而展开；直接命中仍展开", () => {
    for (const doc of ["正文 $x + y$", "正文 #text[宏输出]"]) {
      const pos = doc.length;
      expect(clickSourceRange(doc, pos, null, true)).toBeNull();
      expect(clickSourceRange(doc, pos, null, false)).toEqual({
        from: 3,
        to: doc.length,
      });
    }
    expect(clickSourceRange("普通正文", 2, null, false)).toBeNull();
  });
  it("已展开的源码内点击空白保留展开，离开其范围才收起", () => {
    const doc = "正文 $x + y$ 后文";
    const current = { from: 3, to: 10 };
    for (const pos of [current.from, 6, current.to]) {
      expect(clickSourceRange(doc, pos, current, true)).toBe(current);
    }
    expect(clickSourceRange(doc, doc.length, current, true)).toBeNull();
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
