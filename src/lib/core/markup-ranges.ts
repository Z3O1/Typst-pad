// Markup（常用标记）的"所见即所得"扫描：把 Typst 标记语法拆成
//   * 需要隐藏的标记符号（`= `、`*`、`_`、`` ` ``、列表符号）
//   * 需要加样式的正文范围（标题放大、粗体、斜体、行内代码）
// 供 live-preview.ts 转成 CodeMirror 装饰（隐藏用 replace、样式用 mark）。
//
// 只处理 markup 区（代码 / 注释 / 原始文本 / 字符串里的符号不算标记，见 typst-lex.ts），
// 并跳过公式区间（`$a*b$` 里的 `*` 是数学乘号，不是粗体）。
// 纯函数、可单测。
import { scanMathRanges } from "./math-ranges";
import type { MathRange } from "./math-ranges";
import { scanNonMarkupRegions, scanMarkupRegions } from "./typst-lex";
import type { Region } from "./typst-lex";

export type MarkupKind =
  "heading" | "strong" | "emph" | "raw-inline" | "raw-block" | "list-marker" | "link";

export interface MarkupDecoration {
  kind: MarkupKind;
  /** 需要隐藏（或替换）的标记范围；`text` 给出时替换为该文本（列表符号 → 「• 」） */
  markers: { from: number; to: number; text?: string }[];
  /** 需要加样式的正文范围 */
  content: { from: number; to: number };
  /** 标题级别（kind === "heading" 时给出，1..6） */
  level?: number;
  /**
   * 块级结构（原始文本块 ``` 围栏）：整段替换为块级 widget。
   * `code` 为去掉围栏与语言标记、并做公共缩进剔除后的代码文本。
   */
  block?: { from: number; to: number; code: string };
}

/**
 * 有序且互不重叠的区间表里，是否**存在**与 r 相交的区间。
 * 用二分而非 `some(...)` 线性扫描：粗体/斜体候选很多，而区域表在大文档里是数千条，
 * 线性扫描是 O(候选数 × 区域数)——40k 字符文档实测一次重建 47ms（每按键！）。
 */
function overlapsSorted(
  ranges: { from: number; to: number }[],
  r: { from: number; to: number },
): boolean {
  // 第一个 from > r.from 的下标
  let lo = 0;
  let hi = ranges.length - 1;
  let idx = ranges.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].from > r.from) {
      idx = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  // 只需看 idx（起点紧随其后）与 idx-1（可能横跨 r.from）两个候选：区间互不重叠
  for (const i of [idx - 1, idx]) {
    const x = ranges[i];
    if (x && x.from < r.to && r.from < x.to) return true;
  }
  return false;
}

/** 行首标记规则：标题（`= `…`====== `）与列表符号（`- ` / `+ `） */
const HEADING_RE = /^(=+)[ \t]+/;
const LIST_RE = /^([ \t]*)([-+])[ \t]+/;

/** 粗体 `*text*`：内侧不得以空白开头/结尾（与 typst 的「词边界」要求一致） */
const STRONG_RE = /\*([^\s*](?:[^*\n]*[^\s*])?)\*/g;
/** 斜体 `_text_`：同上 */
const EMPH_RE = /_([^\s_](?:[^_\n]*[^\s_])?)_/g;

/**
 * 扫描文档中的 markup 标记（按 from 升序）。
 *
 * 返回的每个条目：
 * - `markers`：可隐藏的标记符号（隐藏与否由编辑器按选区决定，见 live-preview.ts）；
 * - `content`：加样式（标题字号 / 粗体 / 斜体 / 等宽）的正文。
 *
 * 保守之处：无法确定边界的构造不产生装饰（宁可少渲染），跨行的粗体/斜体不识别。
 */
export function scanMarkupDecorations(
  doc: string,
  precomputed?: { opaque?: Region[]; math?: MathRange[] },
): MarkupDecoration[] {
  const out: MarkupDecoration[] = [];
  // 预先算好的区域/公式可传入：一次编辑器重建里 lexer 只跑一遍（见 live-preview.collect）
  const opaque = precomputed?.opaque ?? scanNonMarkupRegions(doc);
  const math = precomputed?.math ?? scanMathRanges(doc, opaque);
  const markup = scanMarkupRegions(doc, opaque);

  /** 该范围是否"干净"（不与公式/代码等区域相交）——避免误装饰公式与代码 */
  const clean = (r: { from: number; to: number }) =>
    !overlapsSorted(math, r) && !overlapsSorted(opaque, r);

  // ---- 行级：标题与列表符号（只在 markup 区里按行处理）----
  // 有序列表（`+ `）的序号：typst 会替 `+` 编号，这里按「同一缩进的连续列表」计数，
  // 遇到非列表正文就重新开始（近似 typst 的"每个列表各自从 1 开始"）。
  const counters = new Map<string, number>();
  for (const region of markup) {
    let lineStart = region.from;
    while (lineStart < region.to) {
      let lineEnd = doc.indexOf("\n", lineStart);
      if (lineEnd < 0 || lineEnd > region.to) lineEnd = region.to;
      const line = doc.slice(lineStart, lineEnd);

      const heading = HEADING_RE.exec(line);
      if (heading) {
        const markerTo = lineStart + heading[0].length;
        // 标题正文到行尾；行尾若被代码/公式截断，仍按整行加样式（样式不隐藏内容，安全）
        out.push({
          kind: "heading",
          markers: [{ from: lineStart, to: markerTo }],
          content: { from: markerTo, to: lineEnd },
          level: heading[1].length,
        });
      } else {
        const list = LIST_RE.exec(line);
        if (list) {
          const markerFrom = lineStart + list[1].length;
          const markerTo = lineStart + list[0].length;
          const indent = list[1];
          let marker: { from: number; to: number; text?: string }[];
          if (list[2] === "-") {
            marker = [{ from: markerFrom, to: markerTo, text: "• " }]; // 无序列表 → 圆点
          } else {
            // 有序列表 `+ ` → `1. `（按缩进分别计数）
            const n = (counters.get(indent) ?? 0) + 1;
            counters.set(indent, n);
            marker = [{ from: markerFrom, to: markerTo, text: `${n}. ` }];
          }
          out.push({
            kind: "list-marker",
            markers: marker,
            content: { from: markerTo, to: lineEnd },
          });
        } else if (line.trim() !== "") {
          counters.clear(); // 非列表正文 → 下一个列表重新从 1 开始
        }
      }
      lineStart = lineEnd + 1;
    }
  }

  // ---- 行内：粗体 / 斜体（在 markup 区里跑正则，再按区域与公式校验）----
  for (const region of markup) {
    const text = doc.slice(region.from, region.to);
    for (const re of [STRONG_RE, EMPH_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const from = region.from + m.index;
        const to = from + m[0].length;
        const content = { from: region.from + m.index + 1, to: to - 1 };
        const whole = { from, to };
        if (content.from >= content.to) continue;
        if (!clean(whole) || !clean(content)) continue;
        out.push({
          kind: re === STRONG_RE ? "strong" : "emph",
          markers: [
            { from, to: from + 1 },
            { from: to - 1, to },
          ],
          content,
        });
      }
    }
  }

  // ---- 原始文本：`code`（行内）与 ``` 围栏（块级）----
  for (const region of opaque) {
    if (region.kind !== "raw") continue;
    const text = doc.slice(region.from, region.to);
    const block = rawBlockFor(doc, region);
    if (block) {
      out.push({
        kind: "raw-block",
        markers: [],
        content: { from: block.from, to: block.to },
        block,
      });
      continue;
    }
    const inner = rawInlineInner(region, text);
    if (!inner) continue;
    out.push({
      kind: "raw-inline",
      markers: [
        { from: region.from, to: inner.from },
        { from: inner.to, to: region.to },
      ],
      content: inner,
    });
  }

  // ---- 链接：`#link("url")[文字]` ----
  scanLinks(doc, opaque, out);

  // ---- 简单函数白名单（任务 4）：`#strong[文字]` / `#emph[文字]` ----
  scanInlineCalls(doc, opaque, out);

  return out.sort((a, b) => a.content.from - b.content.from);
}

/**
 * 简单函数白名单（任务 4）：`#strong[文字]` 与 `#emph[文字]`。
 *
 * 只认**静态、完整闭合、正文是唯一 content block**的形态：代码区域恰好是 `#strong` / `#emph`、
 * 紧跟一个方括号内容块。任意自定义函数、`#figure`/`#table`/`#grid`/`#stack`/`#place`、
 * 以及带额外参数或非内容块参数的写法**一律不认**（整块切片或源码）。
 *
 * 隐藏的是 `#strong[` 与 `]` 两个标记，正文照常是真实文本 —— 与 `*strong*` 同一条呈现路径，
 * 所以选中、输入、删除都落在正文源码上，函数调用与定界符原样保留（除非用户主动把光标移进标记）。
 */
const INLINE_CALL_RE = /^#(strong|emph)$/;

/**
 * 白名单调用的**正文**必须是我们能可靠呈现的简单 markup。
 *
 * 为什么要这一条：lexer 不一定进得了内容块（实测 `#strong[#h(1em)字]` 只报出外层的 `#strong`），
 * 而里面的 `#h(1em)` 在 typst 里画成空白、在编辑器里却会原样显示成源码 —— 那就是"视觉上像文字"
 * 但对应不上排版。宁可整块切片：拒绝含 `#`（代码）、`` ` ``（raw）、`\`（转义/换行）、
 * `<`/`>`（标签）与换行的正文。`$公式$` 与 `*强调*` 有自己的呈现路径，放行。
 */
function isSimpleCallContent(content: string): boolean {
  return !/[#`\\<>\n]/.test(content);
}

/**
 * 白名单行内调用的**代码区间**（`#strong` 那一段）：决策的"复杂区域"判据把它们放行。
 *
 * 与 `scanInlineCalls` 同一口径（同一份 `INLINE_CALL_RE` 与同一个括号配对），
 * 避免"能显示"与"能编辑"两处判据漂移。
 */
export function scanAllowedInlineCode(
  doc: string,
  opaque: readonly Region[] = scanNonMarkupRegions(doc),
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const region of opaque) {
    if (region.kind !== "code") continue;
    if (!INLINE_CALL_RE.test(doc.slice(region.from, region.to))) continue;
    if (doc[region.to] !== "[") continue;
    const close = matchBracket(doc, region.to);
    if (close <= region.to + 1) continue;
    if (!isSimpleCallContent(doc.slice(region.to + 1, close))) continue;
    out.push({ from: region.from, to: region.to });
  }
  return out;
}

/** 白名单行内调用的标记（`#strong[` / `]`）与正文范围 → 隐藏标记 + 给正文加样式 */
function scanInlineCalls(doc: string, opaque: Region[], out: MarkupDecoration[]): void {
  for (const region of opaque) {
    if (region.kind !== "code") continue;
    const m = INLINE_CALL_RE.exec(doc.slice(region.from, region.to));
    if (!m) continue;
    if (doc[region.to] !== "[") continue;
    const close = matchBracket(doc, region.to);
    if (close <= region.to + 1) continue; // 空内容不加装饰（与 `**` 未写完同一条约定）
    if (!isSimpleCallContent(doc.slice(region.to + 1, close))) continue;
    out.push({
      kind: m[1] === "strong" ? "strong" : "emph",
      markers: [
        { from: region.from, to: region.to + 1 }, // `#strong[`
        { from: close, to: close + 1 }, // `]`
      ],
      content: { from: region.to + 1, to: close },
    });
  }
}

/**
 * 链接：`#link("url")[显示文字]` → 隐藏 `#link("url")` 与两侧方括号，只留显示文字（加链接样式）。
 * 只认这种最常见形态；`#link("url")` 无内容块、或内容块带嵌套方括号以外的复杂情况一律跳过。
 */
const LINK_RE = /^#link\s*\(\s*"[^"]*"\s*\)$/;

function scanLinks(doc: string, opaque: Region[], out: MarkupDecoration[]): void {
  for (const region of opaque) {
    if (region.kind !== "code") continue;
    if (!LINK_RE.test(doc.slice(region.from, region.to))) continue;
    if (doc[region.to] !== "[") continue;
    const close = matchBracket(doc, region.to);
    if (close < 0) continue;
    const content = { from: region.to + 1, to: close };
    if (content.from >= content.to) continue;
    out.push({
      kind: "link",
      markers: [
        { from: region.from, to: region.to },
        { from: region.to, to: region.to + 1 },
        { from: close, to: close + 1 },
      ],
      content,
    });
  }
}

/** 从 `[` 起找配对的 `]`（跳过字符串与嵌套方括号），返回 `]` 的下标；不匹配返回 -1 */
function matchBracket(doc: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < doc.length) {
    const ch = doc[i];
    if (ch === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"') i += doc[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 块级原始文本（``` 围栏）的整段范围与代码内容；行内原始文本返回 null */
function rawBlockFor(
  doc: string,
  region: Region,
): { from: number; to: number; code: string } | null {
  const text = doc.slice(region.from, region.to);
  if (!text.includes("\n")) return null; // 单行 → 行内原始文本，另有规则处理
  const m = /^(`{3,})[^\n`]*\n([\s\S]*?)\n?\1$/.exec(text);
  if (!m) return null;
  // 只处理"围栏独占整行"的情况：围栏两侧还有正文时不做整段替换（会连正文一起盖掉）
  const lineStart = doc.lastIndexOf("\n", region.from - 1) + 1;
  if (doc.slice(lineStart, region.from).trim() !== "") return null;
  const nextNl = doc.indexOf("\n", region.to);
  const lineEnd = nextNl < 0 ? doc.length : nextNl;
  if (doc.slice(region.to, lineEnd).trim() !== "") return null;
  // 收尾的 `\s+$` 去掉围栏前那行只剩缩进的空白（否则代码末尾会多一个换行）
  return { from: lineStart, to: lineEnd, code: dedent(m[2]).replace(/\s+$/, "") };
}

/** 去掉公共缩进（typst 渲染代码块时会剔掉公共前导空白；空行不参与计算） */
function dedent(code: string): string {
  const lines = code.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    min = Math.min(min, indent);
  }
  if (!Number.isFinite(min) || min === 0) return code;
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(min))).join("\n");
}

/** 行内原始文本的正文范围（`` `code` `` → code）；块级（多行 / ``` 围栏）返回 null */
function rawInlineInner(region: Region, text: string): { from: number; to: number } | null {
  if (text.includes("\n")) return null; // 块级原始文本：本轮不处理
  const m = /^(`+)([\s\S]*?)\1$/.exec(text);
  if (!m) return null;
  const ticks = m[1].length;
  return { from: region.from + ticks, to: region.to - ticks };
}
