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

interface ParRule {
  kind: "set" | "show";
  /** `#set par(...)` 的实参文本（`#show par` 为空串） */
  args: string;
}

/** 取从 `(` 起配对到 `)` 的实参文本；不是以 `(` 开头则返回空串 */
function balancedArgs(source: string, openIndex: number): string {
  if (source[openIndex] !== "(") return "";
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return "";
}

/** 收集**活动**的 `#set/#show par` 规则（注释、raw、字符串里的示例不算） */
function activeParRules(source: string, regions: readonly Region[]): ParRule[] {
  const rules: ParRule[] = [];
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
    if (hidden) continue;
    rules.push({
      kind: match[0].includes("show") ? "show" : "set",
      args: balancedArgs(source, to),
    });
  }
  return rules;
}

/**
 * 活动 par 规则是否**改变了段距**。
 *
 * `#show par: …` 可以整段重排，一律按自定义处理；`#set par(spacing: …)` 直接改了段距。
 * **只改 `leading` / `justify` / `first-line-indent` 不算**：段距仍是 typst 默认的 1.2em，
 * 空白行压缩照旧适用。以前只要有 `#set par` 就整篇不压缩，真实作业（活动
 * `#set par(leading: 0.9em)`）里每条空白行因此多占近一整行（24.2px），沿全文累计成上千 px；
 * 而 typst 侧只改 leading 时段距并不变（实测默认/0.9em 两种 leading 下，普通段间距都≈20.4pt）。
 */
export function hasCustomParSpacing(source: string, regions: readonly Region[]): boolean {
  return activeParRules(source, regions).some(
    (rule) => rule.kind === "show" || /(?:^|[,\s(])spacing\s*:/.test(rule.args),
  );
}

export interface ParagraphGapRow {
  /** CodeMirror line decoration 的位置（该源码行起点） */
  from: number;
  /**
   * 同一串**分隔行**的条数，用于把段距总高平均分配，避免多空行挤压段距。
   *
   * 注意它不再是"这串空白行的条数"：一串空白行里只有前几条（通常一条）是必需的分隔行，
   * 其余是用户自己创建的空段落、按普通行盒呈现 —— 它们**不在**这个数组里，
   * 也因此在竖直导航里仍是停靠点（见 `block-plan.sourceVerticalTarget` 的 `isSeparator` 判据）。
   */
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
  // 当前块数据没有携带自定义段距。只把**改了段距**的活动规则视为自定义段距；
  // 注释、raw 与字符串中的示例不能禁用段距压缩；只改 leading/justify 也不禁用（见 hasCustomParSpacing）。
  if (
    hasCustomParSpacing(prefix, scanNonMarkupRegions(prefix)) ||
    hasCustomParSpacing(doc, opaque)
  ) {
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

  /**
   * 空白行两侧可否压缩：普通段落行，或者**标题/列表行**。
   *
   * 标题与列表在编辑器里不经过切片的路，只有段落符号是纯文本；它们与相邻块之间的空白源码行
   * 在 Typst 里被标题/列表间距吸收，编辑器如果不压缩就会多占一整行。真实作业实测：高代作业
   * 标题→列表首项的相邻锚点偏差 +24.8px ≈ 一整行（24.2px），而列表项之间是 0.0px；
   * 数分作业标题→段落压缩后该处偏差从 +85.5px 降到 +43.3px。
   * 行间公式、代码、raw、注释仍不压缩（那些块的裁剪带承载了几何，别重复分配段距）。
   */
  /**
   * **整行就是一条规则 / 注释**（`#let` / `#set` / `#show` / `#import` 或整行注释）。
   *
   * 这些行在 Typst 里**没有输出**，也就没有自己的裁剪带；它们两侧的空白源码行不会被任何带高
   * 吸收，编辑器再按整行（24.2px）渲染就直接变成纵向漂移。PKU 高代周二实测：视口内 21 个空行
   * 里有 6 个是这种"贴着规则/注释的空行"，全文约 16 个 × 24px ≈ 390px，正好等于
   * "实际落位 − 各块带高之和"量到的 390px 与最大累计偏差 450px。
   *
   * raw 区域（``` 代码块）里的行不算：那种块有裁剪带承载几何，压缩会重复分配。
   */
  const rawRegions = opaque.filter((region) => region.kind === "raw");

  /** 以规则关键字（或块注释）开头、且不在 raw 里的区域起点 */
  const ruleRegionStarts = new Set<number>();
  for (const region of opaque) {
    if (region.kind !== "code" && region.kind !== "comment") continue;
    if (overlapsSorted(rawRegions, region.from, region.to)) continue;
    const head = doc.slice(region.from, Math.min(region.to, region.from + 12));
    if (/^(#(?:let|set|show|import)\b|\/\*)/.test(head)) ruleRegionStarts.add(region.from);
  }

  const isRuleOrCommentRow = (row: number): boolean => {
    if (row < 0 || row >= starts.length) return false;
    const trimmed = doc.slice(starts[row], ends[row]).trim();
    if (trimmed === "") return false;
    if (overlapsSorted(rawRegions, starts[row], ends[row])) return false;
    if (/^(#(?:let|set|show|import)\b|\/\/|\/\*)/.test(trimmed)) return true;
    // 多行规则的后续行（`#set page(` … `)`）：所在区域的起点是规则/块注释
    for (const region of opaque) {
      if (region.from <= starts[row] && region.to >= ends[row]) {
        return ruleRegionStarts.has(region.from);
      }
    }
    return false;
  };

  /**
   * 行间公式所在的**可编辑段落**也算"要压缩的一侧"。
   *
   * 历史注释说"行间公式周围不压缩，因为裁剪带承载了几何"——那只在整段被当成切片时成立。
   * 现在 `$ … $` 单独成段时它是**可编辑段落**（只有 MathBlockWidget，没有块带），段距没有任何
   * 带高承载；不压缩就按整行 24.2px 走。PKU 高代周二实测：全文这类空行与最大累计偏差同量级
   * （视口内 4 行 × 21px 就是 84px）。
   */
  /**
   * **整行以 `#` 开头的代码行**（`#table(`、`#figure(`、`#let` …）：与规则行同理，
   * 这些行不是"纯文本段落"，但它们两侧的空白行同样不该按整行渲染——真排版里那段间距要么
   * 由相邻切片带承载、要么由本行自己的代码块高度决定。PKU 高代周二实测：`#table(` 前的空行
   * 原本占 24.2px，正是该处 +45.8px 相邻偏差里的一整行。
   */
  const isCodeRow = (row: number): boolean => {
    if (row < 0 || row >= starts.length) return false;
    const trimmed = doc.slice(starts[row], ends[row]).trim();
    if (trimmed === "") return false;
    if (overlapsSorted(rawRegions, starts[row], ends[row])) return false;
    if (trimmed.startsWith("#")) return lineHasNonMarkup(row);
    // 多行代码块 / 多行规则的后续行（`#table(` 的 `)`、`#set page(` 的 `)`）：
    // 所在区域是 code（且不在 raw 里）即算
    for (const region of opaque) {
      if (region.kind === "code" && region.from <= starts[row] && region.to >= ends[row]) {
        return true;
      }
    }
    return false;
  };

  const isGapSideRow = (row: number): boolean =>
    isPlainParagraphRow(row) ||
    structuralLines.has(row) ||
    isRuleOrCommentRow(row) ||
    isDisplayMathRow(row) ||
    isCodeRow(row);

  /**
   * **正文行**：普通段落行，或标题 / 列表项这类由标记开头的结构性正文行。
   *
   * 与 `isGapSideRow` 的差别：后者还包含规则行（`#set` / `#let`）、整行注释、行间公式与 `#` 代码行
   * —— 那些构造的纵向几何由裁剪带承载，不该在段距扫描里额外长出一行（见下面的 gapCount）。
   */
  const isProseRow = (row: number): boolean => isPlainParagraphRow(row) || structuralLines.has(row);

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
    if (first === 0 || !isGapSideRow(first - 1)) continue;

    /**
     * **这一串空白行里哪几条是"维持两个段落所必需的分隔行"**（压缩到 Typst 的段距），
     * 其余的是**用户自己创建的空段落**（按普通行盒呈现，也是竖直导航的停靠点）。
     *
     * 为什么必须分开（用户 2026-09-26）：写作模式的 ↑/↓ 过去沿源码行前进，"分隔行"也被当成
     * 停靠点 —— 但它在版面上只有 0~3px 高（段距由相邻块的带高承载），光标停上去几乎看不见，
     * 表现为"卡在两段之间"；而 Enter 的落点又正好压在这种行上，于是按完 Enter 光标先跳到那里、
     * 编译落地再跳回来。改成按**可见行**移动，就必须先把两者区分开。
     *
     * 判定（`count` = 这一串空白行的条数）：
     *  - **文末那一行永远是光标所在的新段落**（Typst 里它没有内容，但编辑器必须给光标一个可见
     *    的行盒），所以它不参与分配 —— 下面先用 `movable = count - 1` 把它摘出去；
     *  - **只余一条**（`正文\n\n`、`正文\n`、`前段\n\n后段`）：它就是那两个段落之间必需的分隔行；
     *  - **余下多条、两侧都是正文行**：只有**第一条**是必需的分隔行，其余是用户的空段落
     *    —— 连续按 Enter 建出来的空段落因此仍能进入、输入、删除；
     *  - **贴着规则 / 注释 / 代码 / 行间公式**：整串仍按分隔行压缩。那些构造的几何由裁剪带
     *    承载，多长出一条可见空行会让整页偏离真实排版（PKU 高代周一实测：`#pagebreak()`
     *    后面那两条空行若各长出 24px，后续所有锚点会整段错位）。
     */
    const trailingEmptyParagraph = row === starts.length;
    const movable = trailingEmptyParagraph ? count - 1 : count;
    let gapCount: number;
    if (movable <= 0) {
      // 文末只有一条空白行（`正文\n`）：它是光标所在的新段落，没有分隔行要压缩。
      gapCount = 0;
    } else if (movable === 1) {
      gapCount = 1;
    } else if (isProseRow(first - 1) && (trailingEmptyParagraph || isProseRow(row))) {
      gapCount = 1;
    } else {
      gapCount = movable;
    }
    if (gapCount <= 0) continue;
    if (!trailingEmptyParagraph && !isGapSideRow(row)) continue;
    // 多行非 markup 区域可能跨过看起来为空的源码行。
    if (Array.from({ length: gapCount }, (_, i) => first + i).some(lineHasNonMarkup)) continue;
    for (let i = 0; i < gapCount; i++) {
      rows.push({ from: starts[first + i], count: gapCount });
    }
  }
  return rows;
}
