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
import type { Block, BlockCover } from "../../core/block-plan";
import { scanNonMarkupRegions } from "../../core/typst-lex";
import type { Region } from "../../core/typst-lex";
import { PREFETCH_MARGIN } from "./options";
import type { LivePreviewOptions, WriteFontMetrics } from "./options";
import { BlockCropWidget } from "./widgets";
import { applyBlockSelection } from "../../core/block-plan";

/**
 * 第一阶段的“可编辑正文”只接管能保守判定为纯 markup 的 Paragraph / Heading。
 *
 * `Paragraph` 只是 Typst 顶层分块的兜底类别，里面仍可能混有 `#image(...)`、自定义宏、raw、
 * 注释等内容；仅按 kind 放开会把这些复杂内容从可靠的引擎切片退回近似源码显示。这里复用
 * live-preview 已有的 lexer：块内只要出现**代码 / raw / 注释**区域，就继续沿用局部渲染。
 *
 * **`string` 区域不算复杂**（2026-09-22 审查发现）：lexer 把 `"` 无条件登记成 string（为了让
 * `"$5"` 不被当成公式，见 `typst-lex` 的说明），但 markup 里的 `"` 就是 typst 的弯引号、是
 * 纯 markup —— 一旦把它算作复杂内容，写了一对引号的正文（`他说"你好"，然后走了。`）就会整段
 * 退回切片，未闭合的引号更会让其后所有段落一起退化，正好违背这条规则本身。真在代码里的字符串
 * 一定被外层的 `code` 区域包住（`#let s = "x"`、`#image("x.png")`），所以放宽 string
 * 不会漏掉任何代码。
 *
 * 公式不属于 opaque 区域，因此“普通文字 + 行内公式”仍是可编辑正文，公式本身继续由
 * math decoration 局部替换。粗体 / 斜体也属于 markup，直接作用在真实文本上。
 *
 * **段内有单 LF 的段落也不再直接编辑**（`docString` 里含换行）：Typst 把段落内的单换行当空白、
 * 整段连排（实测数分作业一块源 6 行 → 引擎 5 个视觉行），而逐源码行的可编辑文本每行必占一个
 * 行盒（同一块浏览器 9 行），纵向位置从这一段起就再也对不上。这类块改用引擎切片呈现，
 * 光标进入时照旧展开成源码（与复杂块同一条路径）。编辑器自己的 Enter 写的是两个换行（新段落）、
 * Shift+Enter 写的是 `\` + 换行（Typst 显式换行），都不会产生"段内单 LF"，所以这条只影响
 * 粘贴/手写的硬折行文本。
 */
export function isDirectlyEditableTextBlock(
  block: Pick<Block, "from" | "to" | "kind" | "found" | "skipped">,
  opaque: readonly Region[],
  docString = "",
): boolean {
  if ((block.kind !== "Paragraph" && block.kind !== "Heading") || !block.found || block.skipped) {
    return false;
  }
  if (docString.slice(block.from, block.to).includes("\n")) return false;
  return !overlapsComplexRegion(block.from, block.to, opaque);
}

/**
 * 块区间与“复杂区域”（code / raw / comment）相交吗。
 *
 * `opaque` 按位置有序且互不重叠 ⇒ 二分找到第一个 `from >= from` 的区域，再往后扫到越过块尾
 * 为止。**别写成从头线性扫**：那是每个格子一次、每次按键重建装饰一次，即 O(块 × 区域)；
 * `markup-ranges` 里记过同样的教训（40k 字符实测 47ms/次）。
 */
function overlapsComplexRegion(from: number, to: number, opaque: readonly Region[]): boolean {
  let lo = 0;
  let hi = opaque.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (opaque[mid].from < from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = Math.max(0, lo - 1); i < opaque.length; i++) {
    const region = opaque[i];
    if (region.from >= to) break;
    // 引号是 markup：见 isDirectlyEditableTextBlock 的说明（只有 code/raw/comment 算复杂）
    if (region.kind === "string") continue;
    if (region.to > from && region.from < to) return true;
  }
  return false;
}

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
  doc: string,
  opaque: readonly Region[] = scanNonMarkupRegions(doc),
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
  // 普通正文与标题始终保留为真实文本：光标进出不会再触发整块图片/源码切换。
  // 复杂 Paragraph / Heading（含代码、raw、注释等）不命中此规则，仍保留原来的可靠退路。
  for (const cover of covers) {
    if (isDirectlyEditableTextBlock(cover.block, opaque, doc)) cover.revealed = true;
  }
  return covers;
}

/**
 * **块级带高盒**：把可编辑正文的行盒**精确**摆到引擎给的带上。
 *
 * 背景（见 REPORT「混合高度模型」）：引擎返回的带是"首尾相接、铺满全页"的 —— 相邻两块在两者墨迹的
 * 中点处切，所以每块带高 = 自身内容 + 前后各半个间距。切片走这条路时高度天然精确（SVG 的固有比例
 * 就是带高），但可编辑正文原来按浏览器自然行盒（字号 × 1.65）排：正文块盒高与带高差 3~10px，
 * 且首行基线在带内的偏移也不同（Typst 侧取决于带顶切在哪，浏览器侧永远是"半 leading + 上升部"）。
 * 四份真实作业实测：相邻锚点越界 47/18/11/59 处、页内累计最大 34~63px，全部长在这条缝里。
 *
 * 两条 CSS 就能把这块对齐（都是**行盒模型**的直接后果，不是拟合）：
 *   - `height = 带高`：块的**盒顶/盒底**与带顶/带底重合 ⇒ 块间距不再靠空行反算；
 *   - `line-height = 2 × (首行主基线 − 带顶) − 上升部 + 下降部`：由
 *     `行盒基线 = 盒顶 + (line-height − (上升部 + 下降部)) / 2 + 上升部` 反解，
 *     让首行主基线**正好**落回 `anchorBaselinePt`。
 *
 * 因此带高盒生效的同一轮里，段落之间的空白源码行高度归零（间距已经含在带里，再给一份就是
 * 重复计高 —— 历史上"把正文撑到带高"失败三次都是因为这个）。这条由 `markup-decorations` 的
 * `bandBoxes` 开关执行，`writing-blocks` 那套光标用例里 bandBoxes 不生效（假块没有 `anchorBaselinePt`），
 * 所以空行照旧占整行。
 */
export interface BlockBandFit {
  /** 行盒应占的高度（px）= 引擎给这块的带高 */
  heightPx: number;
  /** 行高（px）：见上，由首行主基线偏移反解 */
  lineHeightPx: number;
}

/** 一块能不能走带高盒；不能则返回 null（调用方保持自然行盒，绝不半套规则混用） */
export function blockBandFit(block: Block, metrics: WriteFontMetrics): BlockBandFit | null {
  if (!block.found || block.noOutput) return null;
  if (!(block.heightPt > 0.5) || !(block.widthPt > 0)) return null;
  const baseline = block.anchorBaselinePt;
  if (baseline == null || !Number.isFinite(baseline)) return null;
  // 一律用 CSS 的 4/3（pt → px）：列宽换算会引入 0.06% 的系统偏差，长页面累计成几个像素
  const factor = 4 / 3;
  const heightPx = block.heightPt * factor;
  const offsetPx = (baseline - block.yPt) * factor;
  const lineHeightPx = 2 * offsetPx - metrics.ascent + metrics.descent;
  if (!Number.isFinite(lineHeightPx) || lineHeightPx < 0) return null;
  return { heightPx, lineHeightPx };
}

/**
 * 带高盒装饰：给可编辑正文所在的那**一条源码行**挂上盒高与行高。
 *
 * 只处理单源码行块（多源码行的块由 `isDirectlyEditableTextBlock` 判定为切片，见那里的说明）；
 * 块区间可能带行尾换行，所以按"块尾不超过行尾"判定。挂两个自定义属性而不是直接写
 * `height`/`line-height`：样式规则留在 `Editor.svelte` 的 CSS 里，标题 span 也能一起被规整。
 */
export function buildBlockBandFitDecorations(
  state: EditorState,
  covers: readonly BlockCover[],
  metrics: WriteFontMetrics | null,
): Range<Decoration>[] {
  const out: Range<Decoration>[] = [];
  if (!metrics) return out;
  for (const cover of covers) {
    if (!cover.revealed || cover.noOutput) continue;
    const block = cover.block;
    if (block.from < 0 || block.from >= state.doc.length) continue;
    const fit = blockBandFit(block, metrics);
    if (!fit) continue;
    const line = state.doc.lineAt(block.from);
    if (block.to > line.to) continue;
    out.push(
      Decoration.line({
        class: "cm-block-band",
        attributes: {
          style: `--write-band-h:${fit.heightPx.toFixed(3)}px; --write-band-lh:${fit.lineHeightPx.toFixed(3)}px`,
        },
      }).range(line.from),
    );
  }
  return out;
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
    if (!block.found || block.skipped) continue;
    // "这一轮没拿到图"（`svg === ""`）**或**"手里这张图是沿用来的旧产物"（`stale`）都要补渲。
    // 只看 `svg === ""` 时，沿用的旧图会让判据永远为假 —— 那一块就再也不会刷新
    //（报告 T2 / A4：旧图可以暂时留着，但滚到它附近必须去要新图）。
    if (block.svg !== "" && block.stale !== true) continue;
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
        // **`inclusiveEnd: false` 是必须的**：块替换默认在两端"包含边界"，而这一格的终点就是
        // **下一块那一行的行首** —— CodeMirror 见到"上一块是块 widget 且覆盖了这个位置"就会
        // 丢掉这一行自己的 line decoration（`blockPosCovered()`，见 docview 的
        // addLineStartIfNotCovered）。带高盒（`.cm-block-band`）正是挂在这一行上的：
        // 实测 87 条带高盒装饰只有 16 条落到 DOM，缺的 71 条全部是"紧跟在切片/隐藏块后面"的行。
        // 置 false 只改边界归属，替换区间与外观都不变。
        inclusiveEnd: false,
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
    // `inclusiveEnd: false` 的理由同 buildBlockCropDecorations：这一格的终点是下一块的行首，
    // 默认的"包含边界"会让下一行的 line decoration（带高盒）被丢掉。
    out.push(Decoration.replace({ block: true, inclusiveEnd: false }).range(from, to));
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
