// **块级装饰**：切片（未展开的格子整格替换成块 widget）、隐藏块（引擎没输出的块整格藏掉）、
// 围栏隐藏（整块选中时代码块的围栏不露出来）、以及"要不要请父组件补渲"的通知。
//
// 边界都取自 `block-plan.planBlockCovers` 铺满全文、首尾相接的格子 —— 所以这些 replace 区间
// 互不重叠（CodeMirror 拒绝重叠的替换装饰，会直接抛异常）。
import { Decoration } from "@codemirror/view";
import { insideCovered } from "./covered";
import type { Range } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { planBlockCovers } from "../../core/block-plan";
import type { BlockCover } from "../../core/block-plan";
import { PREFETCH_MARGIN } from "./options";
import type { LivePreviewOptions } from "./options";
import { BlockCropWidget } from "./widgets";
import { applyBlockSelection } from "../../core/block-plan";

/**
 * 把块表算成"当前文档下要覆盖哪些区间"（块表已是 CodeMirror 位置，见 block-plan.toBlockTable）。
 * 越界 / 反序的格子直接丢掉（文档在编译期间被大改时可能出现）——宁可少渲染，不可乱渲染。
 *
 * 注意：这里**特意不做"文档变了就退回源码"**。块表在编译结果回来之前是旧的，而编辑只发生在
 * 已展开的那一格；其它格的边界都落在空白处（上一块的源码终点），偏一两个字符既不会露出来
 * 也不会吃掉正文。反过来"一变就退回"会让每敲一个字都闪一次源码（见 block-plan 的说明）。
 */
export function buildBlockCovers(
  state: EditorState,
  opts: LivePreviewOptions,
  _doc: string,
): BlockCover[] {
  const blocks = opts.blocks?.() ?? null;
  if (!blocks || blocks.length === 0) return [];
  const docLength = state.doc.length;
  const covers = planBlockCovers(blocks, state.doc).filter(
    (c) =>
      c.coverFrom >= 0 &&
      c.coverTo <= docLength &&
      c.coverTo > c.coverFrom &&
      c.block.from < docLength,
  );
  applyBlockSelection(
    covers,
    state.selection.ranges.map((r) => ({ from: r.from, to: r.to, head: r.head })),
    docLength,
  );
  return covers;
}

/**
 * 视口附近有没有"能渲染却没有切片"的块 —— 有的话通知父组件按新窗口重编译。
 *
 * 窗口化渲染（见 block-plan.carryOverCrops 的说明）下这是常态：滚动到没渲过的区域时，
 * 那几块先是源码，等这一轮窗口编译回来就变成切片。
 */
export function notifyBlocksNeeded(
  opts: LivePreviewOptions,
  visible: readonly { from: number; to: number }[],
): void {
  if (!opts.enabled() || !opts.onBlocksNeeded) return;
  // **直接看块表，不要走 buildBlockCovers**：那条路会把"能渲染但还没有切片"的块标成
  // `revealed`（它们当下确实显示源码），于是"要不要补渲"的判据 `!cover.revealed` 永远为假 ——
  // 滚动到没渲过的区域时**一次重编译都不会触发**（这段代码曾经就是这样：要么等着用户敲一个字，
  // 要么永远显示源码）。判据只该是"这个块能渲染（found）但这一轮没拿到 svg"。
  const blocks = opts.blocks?.() ?? null;
  if (!blocks || blocks.length === 0) return;
  for (const block of blocks) {
    // `skipped` = 后端**有意**没给这一块渲图（源码太大）：保持源码显示，**别再要求补渲** ——
    // 否则每 150ms 重编译一次（见 Block.skipped 的说明）。
    if (!block.found || block.skipped || block.svg !== "") continue;
    const near = visible.some(
      (v) => block.to >= v.from - PREFETCH_MARGIN && block.from <= v.to + PREFETCH_MARGIN,
    );
    if (near) {
      opts.onBlocksNeeded();
      return;
    }
  }
}

/**
 * 块切片装饰集：**未展开且可渲染**的格子整格替换成块 widget。
 *
 * 边界都取自"已铺满全文、彼此首尾相接"的格子（见 block-plan.planBlockCovers），所以
 * 这些 replace 区间互不重叠 —— CodeMirror 拒绝重叠的替换装饰（会抛
 * "Overlapping replacement decorations"），这条是硬约束。
 */
export function buildBlockCropDecorations(
  state: EditorState,
  doc: string,
  covers: BlockCover[],
  opts: LivePreviewOptions,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const cover of covers) {
    if (cover.revealed || !cover.renderable) continue;
    const from = Math.max(0, cover.coverFrom);
    const to = Math.min(cover.coverTo, state.doc.length);
    if (to <= from) continue;
    out.push(
      Decoration.replace({
        widget: new BlockCropWidget(cover, doc.slice(from, to), opts.dark(), opts.onOpenLink),
        block: true,
      }).range(from, to),
    );
  }
  return out;
}

/**
 * **没有输出的块整格隐藏**（用户 2026-09-16 选定「完全隐藏，和 PDF 一样什么都看不到」）。
 *
 * 哪些块算"没有输出"：`#set` / `#show` / `#let` / 纯注释行 —— 引擎对它们**什么都不画**
 * （实测：用户真实文档首行 `#show math.equation: set text(...)` 的块 `found=false`、
 * 高度 `0.0pt`、SVG 0KB），所以真排版里那一行本来就不存在。以前它照旧显示源码，
 * 用户问「为什么 `#` 的代码还是会显示出来」。
 *
 * 实现要点：
 *  - 只在 `cover.noOutput && !cover.revealed` 时隐藏 —— `revealed` 由选区判定（光标/选区进去就展开，
 *    照旧可编辑）；**"块表过期 / 编译失败"那种不可渲染的块绝不能走这里**（见 block-plan 的注释）。
 *  - 用**整行**的 `Decoration.replace({ block: true })`（不带 widget）= 把这几行藏掉、高度归零；
 *    连**块尾空行**也一起藏（格子本来就含它，留着会凭空多一行空行）。
 *  - 区间取格子（`coverFrom..coverTo`）而不是块本身，保证与切片装饰**不重叠**（同一格只有一个装饰）。
 */
export function buildHiddenBlockDecorations(
  state: EditorState,
  covers: BlockCover[],
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  for (const cover of covers) {
    if (cover.revealed || !cover.noOutput) continue;
    const from = Math.max(0, Math.min(cover.coverFrom, state.doc.length));
    const to = Math.max(from, Math.min(cover.coverTo, state.doc.length));
    if (to <= from) continue;
    out.push(Decoration.replace({ block: true }).range(from, to));
  }
  return out;
}

/**
 * **整块被选中的围栏代码块：把两行围栏藏起来**（用户要求「选中整个代码块请不要展开」）。
 *
 * 背景：整块被选中时那一块本来就不展开（保持切片外观，见 block-plan 的 selected）。但**光标
 * 所在的那一块必须展开成源码**（DOM 里得有真实文本，浏览器的输入事件才落得下去 —— 否则
 * Ctrl+A 之后打字一个字都进不去，实测踩过）。于是"选中整个代码块"最常见的那个手势
 * （在代码块里拖一整块）会走到这一条路：展开是必须的，但**围栏没必要露出来**。
 *
 * 做法与写作模式隐藏 `= ` / `**` 一致：把围栏那两行**整行**替换掉（连行尾换行一起，
 * 免得留两条空行），代码正文仍是可编辑、可选中的真实文本。
 */
export function buildFenceHidingDecorations(
  state: EditorState,
  covers: BlockCover[],
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  const isFenceLine = (text: string) => /^\s*(```|~~~)/.test(text);
  /** 整行（含行尾换行）的范围；末行没有换行时到行尾为止 */
  const wholeLine = (lineNo: number) => {
    const line = state.doc.line(lineNo);
    const to = lineNo < state.doc.lines ? state.doc.line(lineNo + 1).from : line.to;
    return { from: line.from, to };
  };
  for (const cover of covers) {
    if (!cover.selected || !cover.revealed || cover.block.kind !== "Raw") continue;
    const from = Math.max(0, Math.min(cover.block.from, state.doc.length));
    const to = Math.max(from, Math.min(cover.block.to, state.doc.length));
    if (to <= from) continue;
    const first = state.doc.lineAt(from);
    const last = state.doc.lineAt(to - 1);
    if (isFenceLine(first.text))
      out.push(
        Decoration.replace({ block: true }).range(
          wholeLine(first.number).from,
          wholeLine(first.number).to,
        ),
      );
    if (last.number !== first.number && isFenceLine(last.text)) {
      out.push(
        Decoration.replace({ block: true }).range(
          wholeLine(last.number).from,
          wholeLine(last.number).to,
        ),
      );
    }
  }
  return out;
}
