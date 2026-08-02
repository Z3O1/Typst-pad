// SVG 页间分隔线：Typst 多页产物是单个 <svg class="typst-doc">，
// 每页是 <g class="typst-page" data-page-width data-page-height transform="translate(0, N*H)">，
// 页与页紧贴无空隙——在每对相邻页边界插入一条 <line class="page-separator"> 作为分页视觉分隔。
// 独立模块以便单元测试（不依赖 wasm 编译引擎）。

// 注意：类名固定为 page-separator，不能含 typst-page 前缀——
// 引擎侧 pageCount 用 /class="typst-page"/g 正则统计页数，避免误伤。

/** 在相邻页边界插入分隔线；单页/无页不插入，解析失败原样返回输入（防御） */
export function paginateSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) return svg; // 解析失败不吞掉原产物

  const pages = doc.querySelectorAll("g.typst-page");
  if (pages.length < 2) return svg; // 单页/无页不画分隔线

  const SVG_NS = "http://www.w3.org/2000/svg";
  for (let i = 0; i < pages.length - 1; i++) {
    const page = pages[i];
    const width = Number(page.getAttribute("data-page-width") ?? NaN);
    const height = Number(page.getAttribute("data-page-height") ?? NaN);
    // 分隔线 Y = 本页 translate Y + 页高（即下一页的起始 Y），x 横贯整页宽
    const y = pageTranslateY(page) + height;
    if (!Number.isFinite(width) || !Number.isFinite(y)) continue; // 缺属性时跳过该边界

    const line = doc.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "page-separator");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    line.setAttribute("stroke-width", "1");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", String(y));
    line.setAttribute("x2", String(width));
    line.setAttribute("y2", String(y));
    // 作为本页 <g> 的兄弟节点插入（下一页之前），绘制顺序在页内容之后
    page.parentNode!.insertBefore(line, page.nextSibling);
  }
  return new XMLSerializer().serializeToString(doc);
}

/** 解析页 <g> 的 transform="translate(x, y)" 中的 Y（缺省为 0） */
function pageTranslateY(page: Element): number {
  const m = /translate\(\s*-?[\d.]+\s*,\s*(-?[\d.]+)\s*\)/.exec(
    page.getAttribute("transform") ?? "",
  );
  return m ? Number(m[1]) : 0;
}
