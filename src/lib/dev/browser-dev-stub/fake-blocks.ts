// 桩的**假块级渲染**（`compile_blocks` 的产物）：**不是 typst 排版**，只用来在真实浏览器里
// 验证"块级切片"这条链路的交互（非光标块被替换、光标进入展开、点击回到源码、源码模式不受影响）。
//
// 切块规则与 Rust 侧 `block_geometry` 的"块"大致对应（空行分段、`=` 标题、`-`/`+` 列表项、
// 围栏代码块各自成块），足以让验收脚本构造出想要的结构。**真实几何由 Rust 侧负责**，
// 真产物走 `fixtures:*` 注入（见 browser-dev-stub.ts 的 fixtureHit）。
import { LINE_HEIGHT, MARGIN, PAGE_WIDTH } from "./fake-layout";

/** 与 Rust `block_geometry::MAX_CROP_SOURCE_BYTES` 同一个值（改一处要改两处，契约要紧） */
const STUB_MAX_CROP_SOURCE_BYTES = 8_000;

/** 假切片的几何记录（桩的命中测试用它做"坐标 ↔ 字符"换算） */
export interface FakeBlockRecord {
  start: number;
  end: number;
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}

export function fakeBlocks(doc: string): {
  ok: true;
  blocks: {
    start: number;
    end: number;
    kind: string;
    found: boolean;
    pages: number;
    page: number;
    xPt: number;
    yPt: number;
    widthPt: number;
    heightPt: number;
    bands: number;
    svg: string;
    /** 与真 Rust 侧同形：超大块被有意跳过渲图（见 block_geometry::MAX_CROP_SOURCE_BYTES） */
    skipped: boolean;
  }[];
  pages: number;
  pageWidthPt: number;
} {
  const encoder = new TextEncoder();
  const lines = doc.split("\n");
  /** 行号 → 该行起始字节偏移 */
  const lineStart: number[] = [];
  let bytes = 0;
  for (const line of lines) {
    lineStart.push(bytes);
    bytes += encoder.encode(line).length + 1; // +1 = 换行
  }
  const lineEnd = (i: number) => lineStart[i] + encoder.encode(lines[i]).length;

  const out: ReturnType<typeof fakeBlocks>["blocks"] = [];
  let i = 0;
  let y = MARGIN;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const isHeading = /^=+\s/.test(line);
    const isList = /^\s*[-+]\s/.test(line);
    const isFence = line.trimStart().startsWith("```");
    let j = i;
    if (isFence) {
      j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith("```")) j++;
      if (j < lines.length) j++; // 收尾围栏
    } else if (isHeading || isList) {
      j = i + 1; // 标题/列表项：一行一块（列表不合并，便于验收精确断言）
    } else {
      // 段落：吃到空行为止
      while (j + 1 < lines.length && lines[j + 1].trim() !== "" && !/^=+\s/.test(lines[j + 1])) j++;
      j++;
    }
    const rows = j - i;
    const heightPt = rows * LINE_HEIGHT + 6;
    const kind = isHeading ? "Heading" : isList ? "ListItem" : isFence ? "Raw" : "Paragraph";
    // 假切片：与整页 SVG 同构（svg 根 + 若干 text），尺寸按块自身高度。
    // **标记要抹掉**（`= ` 标题、`- ` 列表符号、围栏、行间公式的 `$`）：真实 typst 渲染
    // 出来的就是"没有标记"的样子；验收也正是靠这一点断言"被切片盖住的块不再是源码形态"
    // （留着标记的话，切片内文本与源码文本无法区分）。
    const texts = lines
      .slice(i, j)
      .filter((t) => !t.trimStart().startsWith("```"))
      .map((raw, k) => {
        const t = raw
          .replace(/^\s*=+\s*/, "")
          .replace(/^\s*[-+]\s+/, "• ")
          .replace(/^\s*\$\s*/, "")
          .replace(/\s*\$\s*$/, "");
        const esc = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `<text x="${MARGIN}" y="${MARGIN + (k + 1) * LINE_HEIGHT - 6}" font-size="14">${esc}</text>`;
      })
      .join("");
    const svg =
      `<svg viewBox="0 0 ${PAGE_WIDTH} ${heightPt}" width="${PAGE_WIDTH}pt" height="${heightPt}pt" ` +
      `xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/>` +
      `<g data-block="${kind}">${texts}</g></svg>`;
    // **契约要与真后端同形**：超过上限的单块被有意跳过渲图（`skipped: true`、svg 为空），
    // 前端必须把它与"缺切片"区分开（否则会每 150ms 要求补渲一次）。桩按同样的 8KB 判据走，
    // 这样 `&blocks=1` 的验收也能覆盖这条契约（见 live-preview.test.ts 的同名用例）。
    const skipped = lineEnd(j - 1) - lineStart[i] > STUB_MAX_CROP_SOURCE_BYTES;
    out.push({
      start: lineStart[i],
      end: lineEnd(j - 1),
      kind,
      found: true,
      pages: 1,
      page: 1,
      xPt: MARGIN,
      yPt: y,
      widthPt: PAGE_WIDTH,
      heightPt,
      bands: rows,
      svg: skipped ? "" : svg,
      skipped,
    });
    y += heightPt;
    i = j;
  }
  return { ok: true, blocks: out, pages: 1, pageWidthPt: PAGE_WIDTH };
}

/** 假切片上的粗略定位：等宽字符 + 均分行高（只保证"方向对、钳在块内"）。
 *  `last` = 最近一次假编译的文档与块（由调用方持有，见 browser-dev-stub.ts 的 lastFake）。 */
export function syntheticHit(
  args: Record<string, unknown>,
  last: { doc: string; blocks: FakeBlockRecord[] } | null,
): number | null {
  if (!last) return null;
  const block = last.blocks.find((b) => b.start === args.start && b.end === args.end);
  if (!block) return null;
  const bytes = new TextEncoder().encode(last.doc);
  const src = new TextDecoder().decode(bytes.slice(block.start, block.end));
  const lines = src.split("\n");
  const rows = Math.max(1, lines.length);
  const rowH = block.heightPt / rows;
  const row = Math.min(rows - 1, Math.max(0, Math.floor((Number(args.yPt) - block.yPt) / rowH)));
  const line = Array.from(lines[row] ?? "");
  const maxChars = Math.max(1, ...lines.map((l) => Array.from(l).length));
  const charW = block.widthPt / maxChars;
  const col = Math.min(
    line.length,
    Math.max(0, Math.round((Number(args.xPt) - block.xPt) / charW)),
  );
  const before = new TextEncoder();
  const inLine = before.encode(line.slice(0, col).join("")).length;
  const rowStart = before.encode(lines.slice(0, row).join("\n")).length + (row > 0 ? 1 : 0);
  const offset = block.start + rowStart + inLine;
  return Math.min(block.end, Math.max(block.start, offset));
}
