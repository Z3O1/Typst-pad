// **公式装饰**：行内/行间公式的 widget 替换与"选区进出展开"。
// 范围来自 `math-ranges.ts`（`$` 配对扫描），渲染结果来自父组件经 `opts` 注入的缓存。
import { Decoration } from "@codemirror/view";
import { insideCovered } from "./covered";
import type { Range } from "@codemirror/state";
import type { EditorState, Text } from "@codemirror/state";
import { mathCacheKey, mathRevealDecision } from "../../core/math-ranges";
import type { MathRange } from "../../core/math-ranges";
import type { LivePreviewOptions } from "./options";
import { MathBlockWidget, MathWidget, ReserveWidget } from "./widgets";
import { MATH_TEXT_PT } from "../../core/typst-engine";
import { planEditReserve, sourceHeightPx } from "./edit-session";

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
    // 落在"已被块切片盖住"的区间里：整块已经由块 widget 呈现，这里不能再叠一层 replace
    if (insideCovered(range.from, range.to, covered)) continue;
    // **独占单行的行间公式：行级居中要在 reveal 分支之前挂**（报告 V1）。
    // 以前这枚 `Decoration.line` 只挂在"渲染态"那条分支里（`!decision.reveal && render.ok`），
    // 于是光标一进公式、widget 一撤，`text-align: center` 跟着消失 —— 实测同一行从
    // `text-align:center`（行盒 33.5px）变成 `text-align:start`（行盒 24.2px），
    // 用户看到的就是"点进公式，公式跳到左边、整段还矮了一截"。
    // 对齐是**行的属性**，不是渲染产物：源码形态与渲染形态必须共用同一个对齐，
    // 所以它属于"决定展开与否之前"这一步，也不该受渲染缓存到没到货影响。
    // 条件严格限定 `block !== null && !range.multiline`：多行行间公式走整行 block widget、
    // 不套单行对齐；与文字同行的 `$ x $`（`block === null`）更不能整行居中（会把正文一起居中）。
    if (block !== null && !range.multiline) {
      decorations.push(
        Decoration.line({ class: "cm-math-line" }).range(state.doc.lineAt(block.from).from),
      );
      // **已展开时补一点临时空白**（报告 T4）：高公式（`frac(a,b)`、求和式）展开成一行源码
      // 会把下方内容整体往上拽（实测 49.66px → 24.2px）。补的规则全在 `planEditReserve` 里：
      // 上限 1 个可视高度、不超过进进入时的渲染盒、无状态不累积。
      if (decision.reveal) {
        const reservePt = opts.mathSizePt?.() ?? MATH_TEXT_PT;
        const cached = opts.lookup(mathCacheKey(range.body, range.display, context, reservePt));
        const reserve = planEditReserve({
          // 公式盒高是 pt，编辑器 CSS 里 1pt = 4/3 px（见 widgets.ts 的说明）
          renderPx: cached?.ok ? (cached.heightPt * 4) / 3 : 0,
          sourcePx: sourceHeightPx(
            state.doc.sliceString(block.from, block.to),
            opts.lineHeight?.() ?? 0,
          ),
          viewportPx: opts.viewportHeight?.() ?? 0,
        });
        if (reserve.reservePx > 0) {
          decorations.push(
            Decoration.widget({
              widget: new ReserveWidget(reserve.reservePx),
              block: true,
              side: 1,
            }).range(block.to),
          );
        }
      }
    }
    if (decision.reveal) continue;
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
      // （行级居中的 `Decoration.line` 已经在上面、reveal 之前挂好，这里不再重复挂。）
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
