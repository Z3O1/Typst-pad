// **公式装饰**：行内/行间公式的 widget 替换与"选区进出展开"。
// 范围来自 `math-ranges.ts`（`$` 配对扫描），渲染结果来自父组件经 `opts` 注入的缓存。
import { Decoration } from "@codemirror/view";
import { insideCovered } from "./covered";
import type { Range } from "@codemirror/state";
import type { EditorState, Text } from "@codemirror/state";
import { mathCacheKey, mathRevealDecision } from "../../core/math-ranges";
import type { MathRange } from "../../core/math-ranges";
import type { LivePreviewOptions } from "./options";
import { MathBlockWidget, MathWidget } from "./widgets";
import { MATH_TEXT_PT } from "../../core/typst-engine";

/**
 * 该行间公式是否**独占所在各行**（前后只有空白）。
 * 只有独占时才能整行替换成块级 widget；与文字同行的 `$ x $`（typst 里也会排成独立式子，
 * 但就地整行替换会连同旁边的文字一起盖掉）仍按行内 widget 处理，避免"吃掉正文"。
 */
export function blockRangeFor(doc: Text, range: MathRange): { from: number; to: number } | null {
  if (!range.display) return null;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(Math.min(range.to, doc.length));
  if (doc.sliceString(first.from, range.from).trim() !== "") return null;
  if (doc.sliceString(Math.min(range.to, last.to), last.to).trim() !== "") return null;
  return { from: first.from, to: last.to };
}

/** 依据「文档 + 选区 + 渲染缓存」算出公式 widget 装饰集 */
export function buildMathDecorations(
  state: EditorState,
  opts: LivePreviewOptions,
  ranges: MathRange[],
  context: string,
  covered: readonly { from: number; to: number }[] = [],
): Range<Decoration>[] {
  if (!opts.enabled()) return [];
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decorations: Range<Decoration>[] = [];
  for (const range of ranges) {
    const block = blockRangeFor(state.doc, range);
    // 呈现方式决定"整块被选中时能不能不展开"（见 mathRevealDecision 的说明）：
    // 跨行的行间公式只能整行 block 替换，那种 widget 里没有可编辑的行容器。
    const asBlockWidget = block !== null && range.multiline;
    // 光标 / 部分选区进入 → 展开源码；**选区完整盖住公式**时不展开（保持渲染 + 淡色底，
    // 用户要求「选中整个公式请不要展开」，判定与理由见 math-ranges.mathRevealDecision）
    //
    // 判据用的是**装饰实际盖住的区间**（`decorated`），不是只看公式本身：单行行间公式会把
    // 行首行尾的空白一起盖掉（`  $ x $  ` 也居中），只按公式范围判"完整盖住"就会出现
    // "选区盖住公式、但只盖住 widget 的一部分" —— DOM 里 widget 是原子节点，浏览器只能在它
    // 边缘插入，实测结果是**字符被插到行尾**（`  $ x^2 $  ` 选中 `$ x^2 $` 打字 →
    // `  $ x^2 $  z`）。这种"部分盖住 widget"必须展开源码。
    const decorated = block ?? { from: range.from, to: range.to };
    const decision = mathRevealDecision(decorated, selections, {
      inlinePresentation: !asBlockWidget,
    });
    if (decision.reveal) continue;
    // 落在"已被块切片盖住"的区间里：整块已经由块 widget 呈现，这里不能再叠一层 replace
    if (insideCovered(range.from, range.to, covered)) continue;
    const sizePt = opts.mathSizePt?.() ?? MATH_TEXT_PT;
    const render = opts.lookup(mathCacheKey(range.body, range.display, context, sizePt));
    // 未渲染 / 渲染失败 → 保持源码显示
    if (!render?.ok) continue;
    if (block && range.multiline) {
      // 跨行行间公式：整行（多行）→ 块级 widget（inline 装饰不允许跨行）
      decorations.push(
        Decoration.replace({
          widget: new MathBlockWidget(render, range, opts.dark(), decision.selected),
          block: true,
        }).range(block.from, block.to),
      );
      continue;
    }
    if (block) {
      // **单行**行间公式（独占整行）：整行居中，但装饰是**行内** replace、widget 落在 `.cm-line` 里。
      // 别退回"整行 block 替换"（实测踩过）：那样 widget 是 contenteditable=false 的顶层元素，
      // 被选区完整盖住时打字会把字符插到**下一行**（浏览器找不到可编辑的行容器），
      // 于是"选中整个公式不展开"就不能成立；落在 .cm-line 里的 inline widget 没有这个问题
      // （浏览器删掉它、在同一位置插入文本，CodeMirror 能正常读到改动）。
      // 替换区间用**整行**（block.from..block.to）而不是只盖公式：行内可能有前后空白
      // （`  $ x $  ` 这种写法），一起盖掉才真的居中——widget 是 inline-box，留着空白会被推到一边。
      decorations.push(
        Decoration.line({ class: "cm-math-line" }).range(state.doc.lineAt(block.from).from),
      );
      decorations.push(
        Decoration.replace({
          widget: new MathBlockWidget(render, range, opts.dark(), decision.selected, true),
          inclusive: false,
        }).range(block.from, block.to),
      );
      continue;
    }
    // 跨行但并非独占整行（少见写法）：保持源码，避免与同行文字打架
    if (range.multiline) continue;
    decorations.push(
      Decoration.replace({
        widget: new MathWidget(render, range, opts.dark(), decision.selected),
        inclusive: false,
      }).range(range.from, range.to),
    );
  }
  return decorations;
}
