// **常用标记装饰**（标题/粗体/斜体/行内代码/链接/列表符号）：只把标记隐藏或改样式，不渲染排版。
// 范围来自 `markup-ranges.ts` 的纯函数扫描（`scanMarkupDecorations`）。
import { Decoration } from "@codemirror/view";
import { insideCovered } from "./covered";
import type { Range } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import type { MarkupDecoration, MarkupKind } from "../../core/markup-ranges";
import type { Region } from "../../core/typst-lex";
import { ListMarkerWidget, TextWidget } from "./widgets";
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
 * 列表标记盒的 CSS 变量（**呈现态与揭示态共用**，见下面 list-marker 分支的说明）。
 *
 * `width` = 引擎给的**正文起点**（相对列左缘，pt → px 的 4/3 与 widget 同一口径），
 * `padding-left` = 标记起点（`marker-align: end` 的序号要右对齐，圆点则在列左缘：
 * 实测 `markerXPt` 是 −0.0014 这种负抖动，所以只在 > 0 时才写）。
 */
function listMarkerBoxStyle(markerXPt: number, bodyOffsetPt: number): string {
  const widthPx = (bodyOffsetPt * 4) / 3;
  const markerXPx = (markerXPt * 4) / 3;
  const parts = [`--write-list-w:${widthPx.toFixed(3)}px`];
  if (markerXPx > 0 && Number.isFinite(markerXPx)) {
    parts.push(`--write-list-pad:${markerXPx.toFixed(3)}px`);
  }
  return parts.join(";");
}

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
  /**
   * 这一轮装饰里"可编辑正文"整篇走**块级带高盒**（见 block-decorations 的
   * `buildBlockBandFitDecorations`）：带高里已经含了前后各半个段距，空白源码行必须归零，否则
   * 每一条空行都会把后面所有块往下推一份重复的间距（实测四份作业 19~112 条空行 × 3.05px）。
   * 关掉时行为与加带高盒之前**逐字节一致**（源码模式、块表过期、jsdom 都走这条）。
   */
  bandBoxes = false,
  /**
   * 取某个位置所在块的**列表标记**（引擎给的符号 + 正文起点偏移，任务 2）。
   * 取到就用 `ListMarkerWidget` 按引擎偏移画（符号/缩进/编号与 typst 一致）；
   * 取不到（非列表项 / 旧后端 / 自定义 marker 指回定义处）回退到扫描器的近似文本。
   */
  listMarkerAt?: (pos: number) => { text: string; markerXPt: number; bodyOffsetPt: number } | null,
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
    const em = bandBoxes
      ? 0 // 带高盒生效：段距已经在相邻块的带高里，空行只留 0 高（见函数头注释）
      : (TYPOGRAPHIC_PARBREAK_ROW_EM / row.count) * (afterBand ? 0.5 : 1);
    const style = `--write-parbreak-height: ${em.toFixed(6)}em`;
    decorations.push(
      Decoration.line({
        class: "cm-write-parbreak",
        attributes: { style },
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
      /**
       * **列表标记：呈现态与揭示态共用同一套盒子模型**（任务 2 的后续，2026-09-26）。
       *
       * 呈现态是 `ListMarkerWidget`（定宽 inline-block + 伪元素画符号）；揭示态以前**什么都不加**，
       * 源码 `- ` 就按自然字宽画 —— 于是点击项目符号时正文左缘会往左跳：真实夹具实测
       * `- 第一项：无序列表` 的正文从 66.47px 跳到 61.97px（−4.5px），序号项 `+ 有序一` 从
       * 71.38 跳到 61.97（**−9.4px**），点过的那一项与同级其它项的文字**对不齐**了；用户报的
       * "点击后缩进/排版明显不同"就是这条。
       *
       * 现在揭示态给源码套一个 `Decoration.mark`（**不是 replace** —— 源码必须仍然可编辑），
       * 盒宽/左内边距与 widget 完全相同（`--write-list-w` / `--write-list-pad`），于是正文左缘
       * 在点击前后一致，唯一变化就是符号本身（`•` → 可编辑的 `- `，那是允许的局部揭示）。
       */
      const exact =
        item.kind === "list-marker" ? (listMarkerAt?.(item.content.from) ?? null) : null;
      if (selectionTouchesRange(marker, selections)) {
        if (exact && exact.text !== "") {
          decorations.push(
            Decoration.mark({
              class: "cm-markup-list-indent",
              attributes: { style: listMarkerBoxStyle(exact.markerXPt, exact.bodyOffsetPt) },
            }).range(marker.from, marker.to),
          );
        }
        continue;
      }
      // 列表符号：优先用**引擎实际画出来的**标记（符号/缩进/编号，见 ListMarkerWidget）
      if (exact && exact.text !== "") {
        decorations.push(
          Decoration.replace({
            widget: new ListMarkerWidget(
              exact.text,
              (exact.markerXPt * 4) / 3,
              (exact.bodyOffsetPt * 4) / 3,
            ),
          }).range(marker.from, marker.to),
        );
        continue;
      }
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
