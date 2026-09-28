// 桩的**假排版**：把文档按行转成 SVG 文本行、超过一页容量就分页。
//
// 目的是让预览区有真实的多页结构（含 page-separator 分隔），便于调试滚动/缩放/分栏。
// **注意：这只是"看起来像排版结果"，不是 Typst 的真实输出** —— 真实排版只能靠桌面版或
// `fixtures:pages` 导出的真实产物（见 scripts/browser-check/document-mode.mjs）。
//
// 固定 A4 尺寸只服务基础 UI 桩；完整排版验收使用真实整页夹具。

/** A4 宽（pt） */
export const PAGE_WIDTH = 595.28;
/** A4 高（pt） */
const PAGE_HEIGHT = 841.89;
/** 页边距（pt） */
export const MARGIN = 70;
/** 行高（pt） */
export const LINE_HEIGHT = 22;
const FONT_SIZE = 12;
const MAX_COLUMNS = 32; // 超出按 CJK 双宽折行

/** 拼入 SVG 文本前转义 XML 实体。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** CJK 字符按 2 列计宽的简单折行（仅为了假预览不横向溢出，不做真实排版） */
function wrapLine(line: string): string[] {
  const lines: string[] = [];
  let current = "";
  let columns = 0;
  for (const ch of line) {
    const width = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (columns + width > MAX_COLUMNS) {
      lines.push(current);
      current = "";
      columns = 0;
    }
    current += ch;
    columns += width;
  }
  lines.push(current);
  return lines;
}

/** 文档 → 供假 SVG 渲染的行数组（空行保留为空白行，段落不丢失） */
function docToLines(doc: string): string[] {
  const out: string[] = [];
  for (const raw of doc.split("\n")) {
    if (raw.trim() === "") {
      out.push("");
      continue;
    }
    out.push(...wrapLine(raw));
  }
  if (out.length === 0) out.push("");
  return out;
}

/** 渲染单页 SVG 字符串（结构模仿 typst 的 SVG 输出：一个 svg 根 + 一组 text） */
function renderPage(
  lines: string[],
  pageIndex: number,
  pageCount: number,
  pageWidthPt: number = PAGE_WIDTH,
): string {
  const width = pageWidthPt;
  const height = PAGE_HEIGHT;
  const margin = MARGIN;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  );
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    const y = margin + (i + 1) * LINE_HEIGHT;
    parts.push(
      `<text x="${margin}" y="${y}" font-family="Noto Serif CJK SC, Songti SC, serif" font-size="${FONT_SIZE}" fill="#111111">${escapeXml(line)}</text>`,
    );
  });
  // 页脚页号：便于确认多页拼接与 page-separator 分隔生效
  parts.push(
    `<text x="${width / 2}" y="${height - margin / 2}" text-anchor="middle" font-family="Noto Serif CJK SC, serif" font-size="10" fill="#666666">${pageIndex + 1} / ${pageCount}</text>`,
  );
  parts.push("</svg>");
  return parts.join("");
}

/**
 * 真产物的可用性提示：如果**真实编译未接入**（浏览器里只能假渲染），首次挂载时在控制台
 * 明确说一次，并把提示写进页面标题，避免"假排版当成真排版"。
 */
export function warnFakeRendering(): void {
  console.warn(
    "[browser-dev] 未注入真实夹具时，整页预览是**桩产物**（不是 typst 排版）：仅用于调 UI 与交互。\n" +
      "要看到真实排版，请用桌面版 `npm run tauri dev`。",
  );
}

/** 当前文档 → 假 SVG 页数组；只用于没有原生夹具的基础 UI 验收。 */
export function fakePages(doc: string): string[] {
  const lines = docToLines(doc);
  const perPage = Math.max(1, Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([""]);
  return pages.map((pageLines, i) => renderPage(pageLines, i, pages.length));
}
