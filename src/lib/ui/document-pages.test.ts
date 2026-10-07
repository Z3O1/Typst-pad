// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createDocumentPages } from "./document-pages";

const svg = (width: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 400"><defs><path id="glyph" d="M0 0"/></defs><use href="#glyph"/><text>${label}</text></svg>`;

describe("完整页面宿主", () => {
  it("隔离重复 SVG ID、保持产物原样，更新只替换变化页", () => {
    const paper = document.createElement("div");
    const pages = createDocumentPages(paper);
    const input = [svg(300, "第一页"), svg(400, "第二页")];
    expect(pages.update(input)).toBe(2);
    const first = pages.page(1)!;
    const second = pages.page(2)!;
    const expected = document.createElement("div");
    expected.innerHTML = input[0];
    expect(first.svg.isEqualNode(expected.firstChild)).toBe(true);
    expect(first.svg.getRootNode()).not.toBe(second.svg.getRootNode());
    expect(first.host.style.width).toBe("75%");
    expect(pages.widthPt()).toBe(400);
    expect(pages.update([...input])).toBe(0);
    expect(pages.page(1)!.svg).toBe(first.svg);
    expect(pages.update([svg(300, "修改"), input[1]])).toBe(1);
    expect(pages.page(1)!.host).toBe(first.host);
    expect(pages.page(1)!.svg).not.toBe(first.svg);
    expect(pages.page(2)!.svg).toBe(second.svg);
    pages.update([input[0]]);
    expect(paper.contains(second.host)).toBe(false);
    expect(paper.children).toHaveLength(1);
    expect(pages.page(1)!.host.style.width).toBe("100%");
    pages.clear();
    expect(paper.children).toHaveLength(0);
    expect(pages.widthPt()).toBe(0);
    expect(pages.nearest({ x: 10, y: 10 })).toBeNull();
  });

  it("长文档点击只测量对数数量的宿主，页间与纸张外侧仍按最近页映射", () => {
    const pages = createDocumentPages(document.createElement("div"));
    pages.update(Array.from({ length: 100 }, (_, i) => svg(300, String(i))));
    const rects = Array.from({ length: 100 }, (_, i) => {
      const rect = { left: 10, top: i * 410, width: 300, height: 400, bottom: i * 410 + 400 };
      return vi
        .spyOn(pages.page(i + 1)!.host, "getBoundingClientRect")
        .mockReturnValue(rect as DOMRect);
    });
    expect(pages.nearest({ x: 400, y: 99 * 410 + 30 })).toEqual({ page: 100, xPt: 390, yPt: 30 });
    expect(rects.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBeLessThan(12);
    expect(pages.nearest({ x: 10, y: 405 })!.page).toBe(1);
    expect(pages.nearest({ x: 10, y: 406 })!.page).toBe(2);
    expect(pages.nearest({ x: 10, y: -10 })!.page).toBe(1);
    expect(pages.nearest({ x: 10, y: 999999 })!.page).toBe(100);
  });
});
