// 桩的**假排版**：把文档按行转成 SVG 文本行、超过一页容量就分页。
//
// 目的是让预览区有真实的多页结构（含 page-separator 分隔），便于调试滚动/缩放/分栏。
// **注意：这只是"看起来像排版结果"，不是 Typst 的真实输出** —— 真实排版只能靠桌面版或
// `fixtures:*` 导出的真实产物（见 scripts/browser-check/wysiwyg-visual.mjs）。
//
// 这里的 A4 常量与折行规则只服务"结构正确"；真实页宽重排由 Rust 的
// `typst_world::preview_page_setup` 做，本文件的行为要与它*同形*（窄页 → 页数变多、字号不变）。

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

/** XML 文本转义（拼进 SVG 前调用；**不要对已转义结果二次调用**）。
 *  `fake-blocks.ts` 里那份行内版只转 `&<>` 三个实体（它只用在文本节点里），
 *  这里连引号一起转（5 个）—— 两者各自够用，但**不是同一件事**，别互相替换。 */
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
  // 预览重排：**纸张宽度变窄、字号不变**（这正是"重排"与"等比缩小"的区别——真实后端由
  // typst 按新页宽重排正文，`#set page(width:)` 不改 text size）。页高与边距按 A4 比例缩放
  // （与 Rust 侧 preview_page_setup 一致），行高与字号保持原值 → 窄页排下更多行、页数变多。
  const ratio = pageWidthPt / PAGE_WIDTH;
  const width = pageWidthPt;
  const height = PAGE_HEIGHT * ratio;
  const margin = MARGIN * ratio;
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
 * 桩的「文档正文实际字号」（pt）：真实现是 Rust 侧按字符数投票取众数
 * （`block_geometry::document_text_pt`）。桩只要认得 `#set text(size: Npt)` 就够了 ——
 * 有了它，浏览器验收才能覆盖"源码透镜跟随文档字号"（默认 11pt → 14.67px、
 * `#set text(size: 12pt)` → 16px，见 writing-mode-scenes.mjs 的检查）。
 */
export function fakeDocumentTextPt(doc: string): number {
  const m = /#set\s+text\(\s*size:\s*([0-9.]+)pt/.exec(doc);
  const pt = m ? Number(m[1]) : NaN;
  return Number.isFinite(pt) && pt > 0 ? pt : 11;
}

/**
 * 真产物的可用性提示：如果**真实编译未接入**（浏览器里只能假渲染），首次挂载时在控制台
 * 明确说一次，并把提示写进页面标题，避免"假排版当成真排版"。
 */
export function warnFakeRendering(): void {
  console.warn(
    "[browser-dev] 公式与整页预览都是**桩产物**（不是 typst 排版）：仅用于调 UI 与交互。\n" +
      "要看到真实排版，请用桌面版 `npm run tauri dev`。",
  );
}

/** 当前文档 → 假 SVG 页数组；pageWidthPt = 预览重排请求的页宽（缺省 A4） */
export function fakePages(doc: string, pageWidthPt?: number): string[] {
  const lines = docToLines(doc);
  // 预览重排（compile_doc 的 previewWidthPt）在假实现里也要有可见效果：页更窄 → 同一段文字
  // 排到更多页（真实后端由 typst 重排，见 typst_world::preview_page_setup）
  const width = typeof pageWidthPt === "number" && pageWidthPt > 0 ? pageWidthPt : PAGE_WIDTH;
  // 每页行数按"纸张高度（随宽度等比缩放）− 边距"算：字号与行高不变 → 窄页排得下的行更少、页数更多
  const ratio = width / PAGE_WIDTH;
  const usableHeight = PAGE_HEIGHT * ratio - 2 * MARGIN * ratio;
  const perPage = Math.max(1, Math.floor(usableHeight / LINE_HEIGHT));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) {
    pages.push(lines.slice(i, i + perPage));
  }
  if (pages.length === 0) pages.push([""]);
  return pages.map((pageLines, i) => renderPage(pageLines, i, pages.length, width));
}
