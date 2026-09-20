// Typst 源码「区域扫描」：把文档切成 markup（普通标记文本）与几种"不参与标记识别"的区域
// （code / raw / comment / string），供所见即所得的两个消费者使用：
//   1. math-ranges.ts    —— 只在 markup 区里找公式定界 `$`
//   2. markup-ranges.ts  —— 只在 markup 区里找 `*粗体*`/`_斜体_`/标题/列表符号
// 纯函数、无依赖，可单测。
//
// 为什么需要它：Typst 是图灵完备语言，`*`、`_`、`$` 在代码里可以是乘号、标识符字符、
// 字符串内容。`#let a = b*c*d` 若被当成粗体、`#let s = "$5"` 若被当成公式，
// 就会出现"渲染错位"——比"不渲染"更糟。
//
// 保守原则（宁可漏判，不可误判）：无法确定归属的构造并入邻近的不可见区域。
// 已识别的构造：
//   - `//` 行注释、`/* */` 块注释（支持嵌套）
//   - `` ` `` 行内原始文本、``` ``` ``` 多行原始文本（反引号数量须配对）
//   - `"..."` 字符串（含转义）
//   - `#` 代码表达式：`#ident`、`#f(a)("b")`、`#(...)`、`#{ ... }`、
//     以及 `#let/set/show/import/... ` 这类**语句**（吃到行尾，括号未闭合则续行）
//   - 代码里成对的 `[...]`：Typst 语义中它是**内容块**，内部回到 markup，
//     故不标为 code（`#show ...: it => [*粗*]` 里的粗体仍能被识别）

/** 区域类别：markup = 普通标记文本；其余为"不参与标记识别"的区域 */
export type RegionKind = "markup" | "code" | "raw" | "comment" | "string";

export interface Region {
  kind: RegionKind;
  /** 起始 offset（含） */
  from: number;
  /** 结束 offset（不含） */
  to: number;
}

/** offset → 所在区域（二分查找；区域按 from 有序且互不重叠） */
export function regionAt(regions: Region[], pos: number): Region | undefined {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid];
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/** 需要"吃到语句末尾"的关键字（其后是声明/导入，而不是一个简单表达式） */
const STATEMENT_KEYWORDS = new Set([
  "let",
  "set",
  "show",
  "import",
  "include",
  "return",
  "break",
  "continue",
  "while",
  "for",
  "if",
  "else",
  "context",
]);

/** 连续反引号个数（原始文本定界符长度）；非反引号返回 0 */
function backtickRun(src: string, i: number): number {
  let n = 0;
  while (src[i + n] === "`") n++;
  return n;
}

/** 从开引号位置跳过字符串（含转义），返回结束 offset（不含） */
function skipString(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return src.length;
}

/**
 * 从 open 处匹配配对的 close，返回 close 的下标（不匹配返回 -1）。
 * 中途跳过字符串与同类嵌套（`[` 里再出现 `(` 不影响 `]` 的配对；typst 亦然）。
 */
function matchBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      i = skipString(src, i);
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 语句结束位置：吃到行尾；括号/花括号/中括号未配平时继续吃下一行；`;` 亦终止 */
function statementEnd(src: string, start: number): number {
  let i = start;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      i = skipString(src, i);
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0) break; // 语句外的 `}`：归还外层
      brace--;
    } else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "\n" && paren === 0 && brace === 0 && bracket === 0) break;
    else if (ch === ";" && paren === 0 && brace === 0 && bracket === 0) break;
    i++;
  }
  return i;
}

/** `#` 之后那一坨代码的结束位置（不含） */
function hashSpanEnd(src: string, hash: number): number {
  let i = hash + 1;
  if (i >= src.length) return i;
  // `#{ ... }` 代码块
  if (src[i] === "{") {
    const close = matchBalanced(src, i, "{", "}");
    return close < 0 ? src.length : close + 1;
  }
  // `#(...)` 表达式
  if (src[i] === "(") {
    const close = matchBalanced(src, i, "(", ")");
    return close < 0 ? src.length : close + 1;
  }
  // `#"字符串"`（罕见但合法）
  if (src[i] === '"') return skipString(src, i);
  // 标识符：关键字 → 整条语句；否则 → 表达式（可带 `.字段`、`(...)`、`[...]`）
  const wordStart = i;
  while (i < src.length && /[A-Za-z0-9_\-]/.test(src[i])) i++;
  const word = src.slice(wordStart, i);
  if (STATEMENT_KEYWORDS.has(word)) return statementEnd(src, i);
  if (wordStart === i) return Math.max(hash + 1, i); // `#` 后非标识符：按单字符处理
  for (;;) {
    if (src[i] === "(") {
      const close = matchBalanced(src, i, "(", ")");
      if (close < 0) return src.length;
      i = close + 1;
      continue;
    }
    if (src[i] === "[") {
      const close = matchBalanced(src, i, "[", "]");
      if (close < 0) return src.length;
      i = close + 1;
      continue;
    }
    if (src[i] === ".") {
      i++;
      while (i < src.length && /[A-Za-z0-9_\-]/.test(src[i])) i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * 把 [from, to) 这段代码按「成对 `[...]` 是内容块（markup）」切开，
 * 返回 code / markup 片段；调用方只把 code 片段登记为不可见区域，
 * markup 片段留给后续扫描（于是 `#show x: it => [*粗*]` 里的粗体仍可识别）。
 */
function splitCodeSpan(
  src: string,
  from: number,
  to: number,
): { kind: "code" | "markup"; from: number; to: number }[] {
  const parts: { kind: "code" | "markup"; from: number; to: number }[] = [];
  let seg = from;
  let i = from;
  while (i < to) {
    const ch = src[i];
    if (ch === '"') {
      i = Math.min(skipString(src, i), to);
      continue;
    }
    if (ch === "[") {
      const close = matchBalanced(src, i, "[", "]");
      if (close < 0 || close >= to) {
        i++;
        continue;
      }
      if (i > seg) parts.push({ kind: "code", from: seg, to: i });
      parts.push({ kind: "markup", from: i, to: close + 1 });
      i = close + 1;
      seg = i;
      continue;
    }
    i++;
  }
  if (to > seg) parts.push({ kind: "code", from: seg, to });
  return parts;
}

// 单条记忆化：编辑器**一次更新**里这个扫描会被三处用到（StateField 的装饰重建、
// ViewPlugin 的渲染请求收集、编译上下文里的 `#let` 提取）。40k 字符文档实测一次扫描
// 约 4.5ms，三处各扫一遍就是 13ms/按键——同一次更新里 doc 完全相同，缓存一条即可。
// 返回的数组被冻结：调用方一律只读（要改的地方自己复制）。
let cachedDoc: string | null = null;
let cachedRegions: Region[] = [];

/**
 * 扫描全文，返回按 from 升序的**非 markup** 区域列表（markup 区由补集推导）。
 * 相邻同类区域合并。**同参数重复调用直接返回上一次结果（只读，勿修改）。**
 */
export function scanNonMarkupRegions(doc: string): Region[] {
  if (cachedDoc === doc) return cachedRegions;
  const regions = scanNonMarkupRegionsUncached(doc);
  Object.freeze(regions);
  cachedDoc = doc;
  cachedRegions = regions;
  return regions;
}

/** 实际扫描（每次调用都重算；外部请用带记忆化的 scanNonMarkupRegions） */
function scanNonMarkupRegionsUncached(doc: string): Region[] {
  const out: Region[] = [];
  const push = (kind: RegionKind, from: number, to: number) => {
    if (to <= from) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to === from) last.to = to;
    else out.push({ kind, from, to });
  };

  let i = 0;
  while (i < doc.length) {
    const ch = doc[i];

    // 转义：`\$`、`\*` 等——跳过被转义字符，避免把转义定界符认成标记
    if (ch === "\\") {
      i += 2;
      continue;
    }

    // 行注释
    if (ch === "/" && doc[i + 1] === "/") {
      const nl = doc.indexOf("\n", i);
      const end = nl < 0 ? doc.length : nl;
      push("comment", i, end);
      i = end;
      continue;
    }

    // 块注释（可嵌套）
    if (ch === "/" && doc[i + 1] === "*") {
      let depth = 0;
      let j = i;
      while (j < doc.length) {
        if (doc[j] === "/" && doc[j + 1] === "*") {
          depth++;
          j += 2;
          continue;
        }
        if (doc[j] === "*" && doc[j + 1] === "/") {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      push("comment", i, j);
      i = j;
      continue;
    }

    // 原始文本：`...` 与 ```...```（反引号数量须配对）
    if (ch === "`") {
      const n = backtickRun(doc, i);
      const fence = "`".repeat(n);
      const close = doc.indexOf(fence, i + n);
      const end = close < 0 ? doc.length : close + n;
      push("raw", i, end);
      i = end;
      continue;
    }

    // 字符串：仅代码里出现，保守起见全文按字符串处理（避免 `"$5"` 被当成公式）
    if (ch === '"') {
      const end = skipString(doc, i);
      push("string", i, end);
      i = end;
      continue;
    }

    // 代码：`#` 开头的表达式 / 语句 / 代码块
    if (ch === "#") {
      const end = hashSpanEnd(doc, i);
      for (const part of splitCodeSpan(doc, i, end)) {
        if (part.kind === "code") push("code", part.from, part.to);
      }
      i = Math.max(end, i + 1);
      continue;
    }

    i++;
  }
  return out;
}

/**
 * 扫描全文，返回 markup 区域（`scanNonMarkupRegions` 的补集）。
 * `opaque` 可传入已算好的不可见区域：一次重建里 lexer 只跑一遍（见 live-preview.collect）。
 */
export function scanMarkupRegions(doc: string, opaque?: Region[]): Region[] {
  const out: Region[] = [];
  let cursor = 0;
  for (const r of opaque ?? scanNonMarkupRegions(doc)) {
    if (r.from > cursor) out.push({ kind: "markup", from: cursor, to: r.from });
    cursor = r.to;
  }
  if (cursor < doc.length) out.push({ kind: "markup", from: cursor, to: doc.length });
  return out;
}
