// SVG 页间分隔线模块单元测试（jsdom 环境）
import { describe, it, expect } from "vitest";
import { paginateSvg } from "./svg-paginate";

/** 构造模拟 Typst 编译产物：N 页，每页 596x842，页与页紧贴无空隙 */
function pageSvg(pageCount: number): string {
  const pages = Array.from({ length: pageCount }, (_, i) => {
    const y = i * 842;
    return `<g class="typst-page" data-page-width="596" data-page-height="842" transform="translate(0, ${y})"><path d="M0 0h596v842H0z"/></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" class="typst-doc" width="596" height="${
    pageCount * 842
  }" viewBox="0 0 596 ${pageCount * 842}">${pages}</svg>`;
}

/** 从输出里取出全部分隔线元素 */
function separators(out: string): Element[] {
  const doc = new DOMParser().parseFromString(out, "image/svg+xml");
  return Array.from(doc.querySelectorAll("line.page-separator"));
}

describe("paginateSvg", () => {
  it("两页 → 恰好插入 1 条分隔线，y=842（页边界），x 从 0 到 596", () => {
    const out = paginateSvg(pageSvg(2));
    const lines = separators(out);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line.getAttribute("x1")).toBe("0");
    expect(line.getAttribute("x2")).toBe("596");
    expect(line.getAttribute("y1")).toBe("842");
    expect(line.getAttribute("y2")).toBe("842");
    expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
  });

  it("多页 → 每对相邻页边界各插入一条，Y 依次为 842/1684…", () => {
    const out = paginateSvg(pageSvg(3));
    const lines = separators(out);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.getAttribute("y1"))).toEqual(["842", "1684"]);
  });

  it("单页 → 不插入分隔线", () => {
    const out = paginateSvg(pageSvg(1));
    expect(out).not.toContain("page-separator");
  });

  it("无页 → 不插入分隔线", () => {
    const out = paginateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"/></svg>');
    expect(out).not.toContain("page-separator");
  });

  it("无效 XML → 原样返回输入（防御）", () => {
    const bad = "<svg><unclosed";
    expect(paginateSvg(bad)).toBe(bad);
  });

  it('分隔线类名不干扰 pageCount 正则统计（class="typst-page"）', () => {
    const out = paginateSvg(pageSvg(3));
    const pageCount = (out.match(/class="typst-page"/g) ?? []).length;
    expect(pageCount).toBe(3);
  });

  it("分隔线插在页 <g> 之后、下一元素之前（绘制顺序在页内容之后）", () => {
    const out = paginateSvg(pageSvg(2));
    const doc = new DOMParser().parseFromString(out, "image/svg+xml");
    const pages = doc.querySelectorAll("g.typst-page");
    const line = doc.querySelector("line.page-separator")!;
    // 分隔线紧随第 1 页，位于第 2 页之前
    expect(pages[0].nextSibling).toBe(line);
    expect(line.nextSibling).toBe(pages[1]);
  });
});
