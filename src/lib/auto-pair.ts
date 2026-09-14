// 输入时的自动配对：目前只有数学公式定界符 `$`（用户要求「加入功能：自动补全 $$」）。
// 纯函数、可单测；CodeMirror 侧只在 Editor.svelte 的 inputHandler（插入）与
// editor-keymap.ts 的退格命令里落事务。
//
// 为什么要配对：公式是 `$...$` 成对的定界符，手打时漏掉闭合符是最常见的输入事故；
// 配好之后光标落在中间，打完公式直接继续写，不用回头补 `$`。
//
// 与 typst 语义对齐的两条（见 math-ranges.ts）：
// - 行内公式 `$x$`：定界符内侧无空白；
// - 行间公式 `$ x $`：内侧**两侧都是空白**（display 风格）——所以独占一行时补的是
//   `$  $`（两个空格）并把光标放在中间，用户敲 `x` 就得到 `$ x $` 这个行间公式。
import { regionAt, scanNonMarkupRegions } from "./typst-lex";
import { scanMathRanges } from "./math-ranges";

/** 行间公式脚手架：`$` + 两个空格 + `$`（光标落在中间第 2 个字符位，敲字即 `$ x $`） */
const DISPLAY_SCAFFOLD = "$  $";
const DISPLAY_SCAFFOLD_CARET = 2;

/** 行内公式配对：`$$`，光标落在中间 */
const INLINE_PAIR = "$$";
const INLINE_PAIR_CARET = 1;

/**
 * 输入 `$` 时的决策。`caret` 一律是**相对输入起点**的偏移（调用方 `from + caret`）。
 */
export type DollarPlan =
  | { kind: "insert"; text: string; caret: number } // 补出一对定界符
  | { kind: "skip"; caret: number } // 右侧已有闭合 `$`：只把光标移过去，不再插一对
  | { kind: "none" }; // 交给默认行为（原样插入一个 `$`）

/** 某行的行首/行尾 offset（行尾不含换行符） */
function lineBounds(doc: string, pos: number): { start: number; end: number } {
  const start = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = doc.indexOf("\n", pos);
  return { start, end: nl === -1 ? doc.length : nl };
}

/** 光标所在行是否只有空白（独占一行的公式按 typst 语义是行间公式） */
function onBlankLine(doc: string, pos: number): boolean {
  const { start, end } = lineBounds(doc, pos);
  return doc.slice(start, end).trim() === "";
}

/** 同行右侧（跳过空格/制表符）若是 `$`，返回它的 offset；否则 -1 */
function nextDollarOnLine(doc: string, pos: number): number {
  const { end } = lineBounds(doc, pos);
  let k = pos;
  while (k < end && (doc[k] === " " || doc[k] === "\t")) k++;
  return k < end && doc[k] === "$" ? k : -1;
}

/** 光标是否落在已有公式**内部**（`$a + |b$`）——那里的 `$` 是"闭合公式"，不该再补一对 */
function insideMath(doc: string, pos: number, opaque: ReturnType<typeof scanNonMarkupRegions>): boolean {
  return scanMathRanges(doc, opaque).some((r) => pos > r.from && pos < r.to);
}

/**
 * 决定输入 `$` 时做什么。不配对（返回 none）的四类上下文，都是踩过或必然踩的坑：
 * 1. 代码 / 原始文本 / 注释 / 字符串里（`#let s = "$"`、`// $`、`` `$` ``）——那里的 `$` 不是公式定界符；
 * 2. **代码区**的紧邻右边界（`#let s = 1|` 这种"正在写代码"的位置）——区域末端那个位置本身
 *    已经不算代码了（`regionAt` 是左闭右开），但用户显然还在写代码，补一对会插出
 *    `#let s = 1$$` 这种直接报错的垃圾。代价是 `#f(1)|$x$` 这种"代码后面紧跟公式"也要手打
 *    闭合符——按本仓库"宁可漏配对，不可误配对"的取向，这个代价可以接受；
 *    （raw 的右边界不受此限：```` ``` ```` 之后回到 markup，那里该配对。）
 * 3. 已有公式**内部**（`$a + |b$`）——用户这时要的是闭合公式，补一对会插出 `$a + $|$b$` 这种垃圾；
 * 4. 前面是反斜杠（`\$`）——转义的字面美元号。
 */
export function planDollarInput(doc: string, pos: number): DollarPlan {
  if (!(pos >= 0) || pos > doc.length) return { kind: "none" };
  const opaque = scanNonMarkupRegions(doc);
  if (regionAt(opaque, pos)) return { kind: "none" };
  if (pos > 0 && regionAt(opaque, pos - 1)?.kind === "code") return { kind: "none" };
  if (insideMath(doc, pos, opaque)) return { kind: "none" };
  if (doc[pos - 1] === "\\") return { kind: "none" };

  // 右侧（跳过同行空白）已经有 `$`：把光标移过去。没有这条的话，`$  $` 里再按一次 `$`
  // 会插出 `$ $|$  $` 这种垃圾（实测过），而连按两下 `$` 是很容易发生的手势。
  const next = nextDollarOnLine(doc, pos);
  if (next !== -1) return { kind: "skip", caret: next + 1 - pos };

  // 独占一行 → 行间公式脚手架（内侧两侧留白才是 typst 的 display 公式）；
  // 行内（同行还有别的字）→ 普通配对。
  return onBlankLine(doc, pos)
    ? { kind: "insert", text: DISPLAY_SCAFFOLD, caret: DISPLAY_SCAFFOLD_CARET }
    : { kind: "insert", text: INLINE_PAIR, caret: INLINE_PAIR_CARET };
}

/** 空配对的整对删除范围（相对光标）：`before` 个字符在光标左边、`after` 个在右边 */
export interface PairBackspace {
  before: number;
  after: number;
}

/**
 * 光标正好在**空配对**中间时要删掉的范围，否则返回 null（走默认退格）。
 *
 * 返回值是"光标两侧各删几个字符"而不是一个总长度：行间脚手架 `$  |  $` 的配对**跨在光标两侧**
 * （左 `$ `、右 ` $`），用一个"向前删 N 个"的长度表达会算出负数位置（实测踩过：写成一侧长度后
 * 浏览器里退格只删掉一个空格、还抛了异常）。只有补出来的那两种空配对算，模式精确匹配：
 * - `$|$` → `{1, 1}`；
 * - `$  |  $`（行间脚手架，光标夹在两个空格中间）→ `{2, 2}`；
 * - `$$|$$` 这类相邻成对每处只删自己那一对；`$x$` 这种有内容的配对**不**匹配（不接管）。
 */
export function emptyPairBackspace(doc: string, pos: number): PairBackspace | null {
  if (pos <= 0 || pos > doc.length) return null;
  if (doc[pos - 1] === "$" && doc[pos] === "$") return { before: 1, after: 1 };
  if (pos >= 2 && doc.slice(pos - 2, pos) === "$ " && doc.slice(pos, pos + 2) === " $") {
    return { before: 2, after: 2 };
  }
  return null;
}
