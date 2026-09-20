// 公式范围扫描（所见即所得的内联渲染用）：在 markup 区里找出 `$...$`（行内）与
// `$ ... $`（行间）公式区间，供编辑器用 widget 替换显示。
// 纯函数、可单测；代码区 / 原始文本 / 注释 / 字符串内的 `$` 一律不算公式（见 typst-lex.ts）。
import { regionAt, scanNonMarkupRegions } from "./typst-lex";
import type { Region } from "./typst-lex";

export interface MathRange {
  /** 起始 offset（含开头 `$`） */
  from: number;
  /** 结束 offset（不含，即结尾 `$` 之后） */
  to: number;
  /** 公式源码（不含定界符；行间公式已去掉定界符内侧的分隔空白） */
  body: string;
  /** 行间公式（display 风格）：定界符内侧带空白，如 `$ x^2 $` */
  display: boolean;
  /** 是否跨多行（首轮不内联渲染跨行公式，保持源码显示） */
  multiline: boolean;
}

/** 空白字符判定（typst 的"定界符内侧空白 → 行间公式"规则按此判定） */
function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * 扫描文档中的公式范围（按 from 升序）。
 *
 * 规则（与 typst 语义对齐）：
 * - 只有 markup 区里的 `$` 才算**起始**定界符（`#let s = "$5"`、`` `$` ``、`// $` 都不算）；
 * - `\$` 是转义，不作定界符；
 * - 定界符内侧**两侧都是空白** → 行间公式（typst 的 block equation），否则行内公式；
 * - 闭合 `$` 允许跨过代码区（`$#x$`、`$a + #f(1)$` 都是合法公式），但会跳过注释/原始文本/字符串区
 *   （其中的 `$` 不算闭合符）；
 * - 找不到闭合 `$` → 不是公式，跳过（宁可漏渲染）；
 * - 公式内容 trim 后为空（`$$`、`$  $`）→ 跳过。
 */
export function scanMathRanges(doc: string, precomputed?: Region[]): MathRange[] {
  const opaque = precomputed ?? scanNonMarkupRegions(doc);
  const out: MathRange[] = [];
  let i = 0;
  while (i < doc.length) {
    const here = regionAt(opaque, i);
    // 注释 / 原始文本 / 字符串 / 代码区：整段跳过（代码里的 `$` 常是乘号之外的意外，
    // 保守起见不作为起始定界符）
    if (here) {
      i = here.to;
      continue;
    }
    const ch = doc[i];
    if (ch === "\\") {
      i += 2; // 转义：`\$` 不是定界符
      continue;
    }
    if (ch !== "$") {
      i++;
      continue;
    }
    // 找闭合 `$`：跳过注释/原始文本/字符串区（代码区内容算公式的一部分）
    let j = i + 1;
    let close = -1;
    while (j < doc.length) {
      const rj = regionAt(opaque, j);
      if (rj) {
        if (rj.kind === "code") {
          j = rj.to; // 公式内的代码（`#x`）跳过，继续找闭合符
          continue;
        }
        j = rj.to; // 注释/raw/字符串：其中的 `$` 不算闭合
        continue;
      }
      if (doc[j] === "\\") {
        j += 2;
        continue;
      }
      if (doc[j] === "$") {
        close = j;
        break;
      }
      j++;
    }
    if (close < 0) break; // 未闭合：其后不再有完整公式
    const raw = doc.slice(i + 1, close);
    if (raw.trim() !== "") {
      const display = isSpace(raw[0]) && isSpace(raw[raw.length - 1]);
      out.push({
        from: i,
        to: close + 1,
        body: display ? raw.trim() : raw,
        display,
        multiline: raw.includes("\n"),
      });
    }
    i = close + 1;
  }
  return out;
}

/**
 * 公式渲染缓存键：同一公式（body + 风格）在同一编译前缀与字号下渲染结果相同。
 * 前缀与字号都参与键，避免改了前缀/字号还沿用旧产物。
 */
export function mathCacheKey(
  body: string,
  display: boolean,
  context: string,
  sizePt?: number,
): string {
  const size = sizePt === undefined ? "" : String(sizePt);
  return `${display ? "D" : "I"}\u0000${size}\u0000${context}\u0000${body}`;
}

/** 范围 → [编辑区] 判断：选区（或光标）是否落在范围内（闭区间，含两端）。 */
export function selectionTouchesRange(
  range: { from: number; to: number },
  selections: readonly { from: number; to: number }[],
): boolean {
  return selections.some((s) => {
    // 非空选区：区间相交即展开（含刚好贴边的情况）
    if (s.from !== s.to) return s.from <= range.to && s.to >= range.from;
    // 光标：落在范围内（含两端）即展开，便于在公式前后继续输入
    return s.from >= range.from && s.from <= range.to;
  });
}

/** 某个**非空**选区是否**完整盖住**了这个范围（两端都在范围之外或正好贴边）。 */
export function selectionCoversRange(
  range: { from: number; to: number },
  selections: readonly { from: number; to: number }[],
): boolean {
  return selections.some((s) => s.from !== s.to && s.from <= range.from && s.to >= range.to);
}

/**
 * 公式"要不要展开成源码"的决策（用户要求「选中整个公式请不要展开」）。
 *
 * 与块级渲染**同一套规则**（见 block-plan.applyBlockSelection 的 selected）：选区**完整盖住**
 * 公式时不展开 —— 保持渲染出来的样子、挂一层淡色底表示"它被选中了"，Ctrl+C 复制的仍是源码。
 * 只盖住一部分时照旧展开（那样选中高亮才精确、能选到半个公式里的字符）。光标在公式里时也照旧展开。
 *
 * `inlinePresentation`：这个公式是不是**行内呈现**（装饰落在 `.cm-line` 里）。只有行内呈现才敢
 * 不展开 —— 行间公式若用"整行 block 替换"，那个 widget 是 `contenteditable=false` 的顶层元素，
 * 被选区完整盖住之后打字会把字符插到**下一行**（实测：doc 纹丝不动、下一行多出一个 z），
 * 所以那种形态必须照旧展开（见 live-preview 的 buildMathDecorations）。
 */
export function mathRevealDecision(
  range: { from: number; to: number },
  selections: readonly { from: number; to: number }[],
  opts: { inlinePresentation?: boolean } = {},
): { reveal: boolean; selected: boolean } {
  if ((opts.inlinePresentation ?? true) && selectionCoversRange(range, selections)) {
    return { reveal: false, selected: true };
  }
  return { reveal: selectionTouchesRange(range, selections), selected: false };
}
