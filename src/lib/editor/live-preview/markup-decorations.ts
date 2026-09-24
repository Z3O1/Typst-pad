// **常用标记装饰**（标题/粗体/斜体/行内代码/链接/列表符号）：只把标记隐藏或改样式，不渲染排版。
// 范围来自 `markup-ranges.ts` 的纯函数扫描（`scanMarkupDecorations`）。
import { Decoration } from "@codemirror/view";
import { insideCovered } from "./covered";
import type { Range } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { MarkupDecoration, MarkupKind } from "../../core/markup-ranges";
import type { Region } from "../../core/typst-lex";
import { TextWidget } from "./widgets";
import type { MathRange } from "../../core/math-ranges";
import { selectionTouchesRange } from "../../core/math-ranges";
import { CodeBlockWidget } from "./widgets";
import type { ParagraphGapRow } from "../../core/paragraph-breaks";
import { TYPOGRAPHIC_PARBREAK_ROW_EM } from "../../core/paragraph-breaks";

/** markup 装饰对应的 CSS 类（样式见 livePreviewTheme） */
const MARKUP_CLASS: Record<MarkupKind, string> = {
  heading: "cm-markup-heading",
  strong: "cm-markup-strong",
  emph: "cm-markup-emph",
  "raw-inline": "cm-markup-raw",
  "list-marker": "cm-markup-list",
  link: "cm-markup-link",
  "raw-block": "cm-markup-raw", // 块级代码块由 widget 呈现，样式类仅作兜底
};

/**
 * 常用标记的装饰（标题 / 粗体 / 斜体 / 行内代码 / 列表符号）：
 * - 样式（mark）**始终**应用；
 * - 标记符号（`= `、`*`、`` ` ``）只在选区不触碰该构造时隐藏——Typora 式「光标进去就露出源码」；
 * - 无序列表符号替换成圆点。
 */
export function buildMarkupDecorations(
  state: EditorState,
  scan: {
    docString: string;
    opaque: Region[];
    math: MathRange[];
    markup: MarkupDecoration[];
    paragraphGapRows: ParagraphGapRow[];
  },
  covered: readonly { from: number; to: number }[] = [],
): Range<Decoration>[] {
  const doc = scan.docString;
  const marks = scan.markup;
  /** 切片格子的终点集合：空行紧跟在切片后面时，那份间距已经含在切片的带高里 */
  const coverEnds = new Set(covered.map((c) => c.to));
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decorations: Range<Decoration>[] = [];
  for (const row of scan.paragraphGapRows) {
    // **空行高度要看上一块是不是"按带高渲染的切片"**：Typst 的段距已经含在切片的带高里
    // （每块带 = 自身墨迹 + 相邻间距的一半），再给空行留整份间距就是重复计高。PKU 高代周二实测：
    // 112 个空行 × 3.05px ≈ 342px，与"实际落位 − 各块带高之和"量到的 ~390px 同量级；
    // 把空行全压到 0 能把最大累计偏差 450→246px，但纯正文之间的段距也没了（相邻越界 71→93）。
    // 所以只对"上一块是切片"的空行取半份——那半个间距已经由切片的带提供。
    // 判据是"上一块的格子正好在这里结束"：covered 是切片格子的 [coverFrom, coverTo)，
    // 而 coverTo == 上一块的源码终点 == 这串空行的起点（格子首尾相接，见 planBlockCovers）。
    // 空行起点比上一块的终点晚一个换行（块终点在第一个 `\n` 上，空行从第二个 `\n` 起算）
    const afterBand = coverEnds.has(row.from - 1) || coverEnds.has(row.from);
    const em = (TYPOGRAPHIC_PARBREAK_ROW_EM / row.count) * (afterBand ? 0.5 : 1);
    decorations.push(
      Decoration.line({
        class: "cm-write-parbreak",
        attributes: {
          style: `--write-parbreak-height: ${em.toFixed(6)}em`,
        },
      }).range(row.from),
    );
  }
  for (const item of marks) {
    // 块级结构（代码块）：整段替换为 widget；光标/选区进入即整段回到源码
    if (item.block) {
      if (insideCovered(item.block.from, item.block.to, covered)) continue;
      const reveal = selectionTouchesRange(item.block, selections);
      if (!reveal) {
        decorations.push(
          Decoration.replace({
            widget: new CodeBlockWidget(item.block.code, item.block),
            block: true,
          }).range(item.block.from, item.block.to),
        );
      }
      continue;
    }
    // 「整个构造」= 标记 + 正文的并集，只用于判断它是否已经被块切片覆盖。
    const from = Math.min(item.content.from, ...item.markers.map((m) => m.from));
    const to = Math.max(item.content.to, ...item.markers.map((m) => m.to));
    if (insideCovered(from, to, covered)) continue; // 整块已由切片呈现，别再叠标记隐藏
    // 标题额外带级别类（字号按级别递增，见 livePreviewTheme）
    const cls =
      item.kind === "heading"
        ? `${MARKUP_CLASS.heading} cm-markup-heading-${item.level ?? 1}`
        : MARKUP_CLASS[item.kind];
    // **空正文不能建 mark 装饰**：正文长度为 0 时（刚敲下 `== ` 还没写标题文字、`**` 还没写内容）
    // CM6 会抛 `RangeError: Mark decorations may not be empty`——异常冒泡进 StateField 的事务会让
    // 编辑区直接卡死（用户报过"输入 `= 1 = 2` 后无法再输入"），装了 try/catch 兜底后则表现为
    // "所有标题都被展开成源码"（整套装饰被丢弃）。这里按"没有正文就不加样式"处理。
    if (item.content.to > item.content.from) {
      decorations.push(Decoration.mark({ class: cls }).range(item.content.from, item.content.to));
    }
    for (const marker of item.markers) {
      if (marker.from >= marker.to) continue;
      // 只在光标/选区真正靠近这一枚标记时显示它。正文内部始终保持排版样式，避免光标
      // 在标题或强调文字中移动时，两端定界符一起出现、引起可见文字横向跳动。
      if (selectionTouchesRange(marker, selections)) continue;
      decorations.push(
        marker.text !== undefined
          ? Decoration.replace({ widget: new TextWidget(marker.text) }).range(
              marker.from,
              marker.to,
            )
          : Decoration.replace({}).range(marker.from, marker.to),
      );
    }
  }
  return decorations;
}
