import type { MathRange } from "./math-ranges";
import type { MarkupDecoration } from "./markup-ranges";
import { scanNonMarkupRegions, type Region } from "./typst-lex";

/**
 * 空白分隔行在写作模式里的目标高度（相对当前正文 em）。
 *
 * 这是按 Typst 0.15 + 项目内置字体的真实产物量出来的：默认 11pt 下，
 * `1 \\n\\n 1` 的字形顶部相隔 20.438pt；编辑器普通行高为 1.65em，
 * 因此中间那条源码行只应占 0.208em。它是空行的行盒高度，不是 par.spacing 本身。
 */
export const TYPOGRAPHIC_PARBREAK_ROW_EM = 0.208;

const PAR_RULE = /#(?:set|show)\s+par\b/g;

/** 注释、raw 与字符串中的示例不是活动的段落规则。 */
function hasActiveParRule(source: string, regions: readonly Region[]): boolean {
  PAR_RULE.lastIndex = 0;
  let regionIndex = 0;
  for (const match of source.matchAll(PAR_RULE)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    while (regionIndex < regions.length && regions[regionIndex].to <= from) regionIndex++;
    let hidden = false;
    for (let i = regionIndex; i < regions.length && regions[i].from < to; i++) {
      const region = regions[i];
      if (
        (region.kind === "comment" || region.kind === "raw" || region.kind === "string") &&
        region.to > from
      ) {
        hidden = true;
        break;
      }
    }
    if (!hidden) return true;
  }
  return false;
}

export interface ParagraphGapRow {
  /** CodeMirror line decoration 的位置（该源码行起点） */
  from: number;
  /** 同一段落分隔中的行数，用于将总高度平均分配，避免多空行挤压段距 */
  count: number;
}

/** 区间有序且互不重叠时，是否存在与行盒相交的范围（O(log n)）。 */
function overlapsSorted(
  ranges: readonly { from: number; to: number }[],
  from: number,
  to: number,
): boolean {
  let lo = 0;
  let hi = ranges.length;
  // 找到第一个结束位置大于 from 的区间。
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo].from < to;
}

function lineIndexAt(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, lo - 1);
}

/**
 * 找出两个普通 markup 段落之间的空白源码行。
 *
 * 保守排除标题 / 列表 / 行间公式，以及代码、raw、注释中的行。字符串区域不作为排除项：
 * 普通 markup 里的直引号会被 lexer 记成 string，但仍属于可编辑的正文。
 */
export function scanParagraphGapRows(
  doc: string,
  opaque: readonly Region[],
  math: readonly MathRange[],
  markup: readonly MarkupDecoration[],
  prefix = "",
): ParagraphGapRow[] {
  if (!doc.includes("\n")) return [];
  // 当前块数据没有携带自定义段距。只把活动的 set/show 规则视为自定义段距；
  // 注释、raw 与字符串中的示例不能禁用段距压缩。
  if (hasActiveParRule(prefix, scanNonMarkupRegions(prefix)) || hasActiveParRule(doc, opaque)) {
    return [];
  }

  const starts = [0];
  const ends: number[] = [];
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) === 10) {
      ends.push(i);
      starts.push(i + 1);
    }
  }
  ends.push(doc.length);

  // string 不作为排除项：普通 markup 里的直引号仍是正文。
  const nonStringOpaque = opaque.filter((region) => region.kind !== "string");

  const lineHasNonMarkup = (row: number): boolean => {
    const from = starts[row];
    // 包含换行字符本身，才能识别跨行注释 / raw / 代码区域里的空行。
    const to = Math.min(doc.length, ends[row] + 1);
    return overlapsSorted(nonStringOpaque, from, to);
  };

  const displayMathRanges = math.filter((range) => range.display);
  const isDisplayMathRow = (row: number): boolean => {
    const from = starts[row];
    const to = ends[row];
    return overlapsSorted(displayMathRanges, from, to);
  };

  const structuralLines = new Set<number>();
  for (const item of markup) {
    if (item.kind !== "heading" && item.kind !== "list-marker") continue;
    for (const marker of item.markers) {
      structuralLines.add(lineIndexAt(starts, marker.from));
    }
  }

  const isPlainParagraphRow = (row: number): boolean => {
    if (row < 0 || row >= starts.length || doc.slice(starts[row], ends[row]).trim() === "") {
      return false;
    }
    return !lineHasNonMarkup(row) && !structuralLines.has(row) && !isDisplayMathRow(row);
  };

  const rows: ParagraphGapRow[] = [];
  let row = 0;
  while (row < starts.length) {
    if (doc.slice(starts[row], ends[row]).trim() !== "") {
      row++;
      continue;
    }
    const first = row;
    while (row < starts.length && doc.slice(starts[row], ends[row]).trim() === "") row++;
    const count = row - first;
    if (first === 0 || !isPlainParagraphRow(first - 1)) continue;

    // 文末尚未输入内容的新段也要先拿到稳定段距：Enter 后的最后一行是光标所在段落，
    // 前面的空白行负责段距。若等首字出现后才压缩这些行，光标会突然上跳约 1.44em。
    const trailingEmptyParagraph = row === starts.length;
    const gapCount = trailingEmptyParagraph ? count - 1 : count;
    if (gapCount <= 0) continue;
    if (!trailingEmptyParagraph && !isPlainParagraphRow(row)) continue;
    // 多行非 markup 区域可能跨过看起来为空的源码行。
    if (Array.from({ length: gapCount }, (_, i) => first + i).some(lineHasNonMarkup)) continue;
    for (let i = 0; i < gapCount; i++) {
      rows.push({ from: starts[first + i], count: gapCount });
    }
  }
  return rows;
}
