// 完整 SVG 保持原样；每页独立引用作用域，稳定宿主只替换实际变化的产物。
import { nearestPageCoordinates } from "../core/document-interaction";
import type { PaperShape } from "../core/preview-scale";

export interface DocumentPage {
  host: HTMLDivElement;
  svg: SVGSVGElement;
  source: string;
  box: { x: number; y: number; width: number; height: number };
}

export function createDocumentPages(paper: HTMLElement) {
  const pages: DocumentPage[] = [];
  let widthPt = 0;
  // 文档自己的纸型（取最宽那页）：预览重排按它等比缩放页高/页边距（不写死 A4）
  let shape: PaperShape | null = null;

  function update(sources: string[]): number {
    let changed = 0;
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      if (pages[index]?.source === source) continue;
      const host = pages[index]?.host ?? document.createElement("div");
      if (!pages[index]) {
        host.className = "document-page";
        host.dataset.page = String(index + 1);
        host.attachShadow({ mode: "open" });
        if (index > 0) {
          const separator = document.createElement("div");
          separator.className = "page-separator";
          paper.append(separator);
        }
        paper.append(host);
      }
      const root = host.shadowRoot!;
      root.innerHTML = `<style>svg{display:block;width:100%;height:auto}</style>${source}`;
      const svg = root.querySelector("svg");
      if (!svg) throw new Error("整页产物缺少 SVG");
      const [x, y, width, height] = (svg.getAttribute("viewBox") ?? "")
        .trim()
        .split(/\s+/)
        .map(Number);
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
        throw new Error("整页产物缺少有效尺寸");
      host.style.aspectRatio = `${width} / ${height}`;
      pages[index] = { host, svg, source, box: { x, y, width, height } };
      changed++;
    }
    while (pages.length > sources.length) {
      const host = pages.pop()!.host;
      const separator = host.previousElementSibling;
      if (separator?.classList.contains("page-separator")) separator.remove();
      host.remove();
    }
    const nextWidth = pages.reduce((max, page) => Math.max(max, page.box.width), 0);
    // 宿主宽度与页面内容分开；窗口缩放不遍历或修改 SVG。
    for (const page of pages) {
      const width = `${(page.box.width / nextWidth) * 100}%`;
      if (page.host.style.width !== width) page.host.style.width = width;
    }
    widthPt = nextWidth;
    const widest = pages.reduce<DocumentPage | null>(
      (max, page) => (max && max.box.width >= page.box.width ? max : page),
      null,
    );
    shape = widest ? { widthPt: widest.box.width, heightPt: widest.box.height } : null;
    return changed;
  }

  function clear(): void {
    pages.length = 0;
    widthPt = 0;
    shape = null;
    paper.replaceChildren();
  }

  function nearest(point: { x: number; y: number }) {
    // 页面按垂直顺序排列。二分只量宿主，不强制布局每个离屏 SVG。
    let low = 0,
      high = pages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pages[mid].host.getBoundingClientRect().bottom < point.y) low = mid + 1;
      else high = mid;
    }
    const start = Math.max(0, low - 1);
    const candidates = pages.slice(start, Math.min(pages.length, low + 1));
    const result = nearestPageCoordinates(
      point,
      candidates.map((page) => ({ rect: page.host.getBoundingClientRect(), box: page.box })),
    );
    return result ? { ...result, page: result.page + start } : null;
  }

  return {
    update,
    clear,
    nearest,
    page: (number: number) => pages[number - 1],
    widthPt: () => widthPt,
    shape: () => shape,
  };
}
