// 所见即所得（编辑器内联渲染）的 CodeMirror 6 扩展。
//
// 形态与 Typora / Obsidian Live Preview 一致：
//   * 非选中的公式区间 → 用 `Decoration.replace` 换成**渲染结果 widget**（Rust 侧编出的 SVG）；
//   * 光标或选区进入该区间 → 不挂 widget，源码自然露出，可直接编辑；
//   * 渲染失败 / 还没渲染好 → 保持源码显示（不显示空 widget，也不报错弹窗）。
//
// 装饰（Decoration）机制与既有的诊断波浪线同源（见 Editor.svelte 的 diagnosticsCompartment），
// 只是装饰类型由 `mark` 换成 `replace({ widget })`。
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { EditorSelection, Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range, Text } from "@codemirror/state";
import { mathCacheKey, scanMathRanges, selectionTouchesRange } from "./math-ranges";
import type { MathRange } from "./math-ranges";
import { scanMarkupDecorations } from "./markup-ranges";
import type { MarkupKind } from "./markup-ranges";
import { scanNonMarkupRegions } from "./typst-lex";
import type { Region } from "./typst-lex";
import { buildMathContext } from "./math-context";
import { applyBlockSelection, planBlockCovers, revealBlocksWithDiagnostics, verticalBlockTarget } from "./block-plan";
import type { Block, BlockCover } from "./block-plan";
import { cropPagePoint } from "./block-hit";
import { anchorPosEffect } from "./scroll-anchor";
import { dbg } from "./debug";
import { MATH_SIZE_PT } from "./typst-engine";
import type { MathRender } from "./typst-engine";

/** 待渲染的公式（父组件据此调用 Rust 侧 compile_math） */
export interface MathRequest {
  /** 缓存键（body + 风格 + 编译上下文） */
  key: string;
  body: string;
  display: boolean;
  /**
   * 生成该 key 时用的编译上下文（前缀 + 文档内定义）。
   * **必须随请求一起传**：父组件的渲染是异步批处理，若那时再取当前上下文，
   * 文档在这期间又变了，就会出现「用新上下文编出的结果存进旧 key」的错配
   * （表现为公式短暂显示旧宏的排版）。
   */
  context: string;
}

export interface LivePreviewOptions {
  /** 是否启用内联渲染（关闭时全部显示源码） */
  enabled: () => boolean;
  /**
   * 编译前缀（设置里的前缀代码；与整篇编译同源）。
   * 编译上下文（= 前缀 + 文档内 `#let` 定义）由本扩展**自己**从当前文档算：
   * 一次更新里 lexer 只跑一遍（见 typst-lex 的记忆化），也不必让页面为每次按键
   * 额外算一遍上下文（此前是 `$derived`，40k 文档每次按键多付 ~4.5ms）。
   */
  prefix: () => string;
  /** 取已渲染结果（父组件维护缓存；未命中返回 undefined） */
  lookup: (key: string) => MathRender | undefined;
  /** 需要渲染的公式（父组件负责去重 / 防抖 / 批量 invoke） */
  onRequest: (requests: MathRequest[]) => void;
  /** 是否暗色主题（typst 产物是黑字透明底，暗色下需反色；见 mathWidgetTheme） */
  dark: () => boolean;
  /**
   * 写作模式的**块级渲染**：整篇编译出的"每块一张切片"（父组件每次 compile_blocks 后更新）。
   * 返回 null / 空数时整体关闭 —— 那时的行为与加这个功能之前**逐字节一致**
   * （源码模式、浏览器开发桩、后端没有该命令时都走这条路）。
   * 见 docs/文档模式渲染保真-调研.md。
   */
  blocks?: () => Block[] | null;
  /**
   * 视口内出现了"**能渲染但还没有切片**"的块（窗口化渲染的正常中间态）：
   * 父组件去抖后按新的视口窗口重编译一次。不传则永远等着下一次按键 —— 长文档里
   * 滚动到没渲过的区域会一直显示源码。
   */
  onBlocksNeeded?: () => void;
  /**
   * **点击定位**（阶段 2）：点在某张切片上的 `(xPt, yPt)`（页面坐标）→ 返回光标的
   * CodeMirror 位置；返回 null = 定不了位，调用方退回"光标落到块首"。
   *
   * 真实实现在父组件（→ Rust 侧 `block_hit_test`，见 block-hit.ts / +page.svelte），
   * 这里只负责"量出点击点在切片里的相对位置"并把结果落在事务里。
   */
  onCropClick?: (req: {
    page: number;
    xPt: number;
    yPt: number;
    /** 被点那块的源码范围（CodeMirror 位置） */
    from: number;
    to: number;
  }) => Promise<number | null>;
  /**
   * **点切片里的链接**（阶段 3）：typst 的 `#link("…")[文字]` 在切片上是画出来的文字，
   * 点击时把 URL 交给父组件（→ opener 插件用系统浏览器打开）。不传则链接只是不可点的热区。
   */
  onOpenLink?: (href: string) => void;
  /**
   * 当前编译错误的区间（CodeMirror 位置）：**与诊断相交的块不许被切片盖住** ——
   * 波浪线画在源码上，被图片盖住的块里看不见（用户会看到"状态栏说有错，正文里找不到"）。
   * 入参是**正在算装饰的那个 state 的 doc**（不能取 `view.state`：StateField 计算时
   * view 上的 state 还是旧的）。
   */
  diagnosticRanges?: (doc: Text) => readonly { from: number; to: number }[];
}

/** 渲染结果更新后刷新装饰（父组件收齐一批渲染结果时 dispatch 一次） */
export const refreshLivePreview = StateEffect.define<null>();

/** 视口外多少字符范围内也提前渲染（滚动时不至于看到源码一闪） */
const PREFETCH_MARGIN = 2000;

/**
 * widget 构造失败的兜底：退回纯文本节点。
 * toDOM 抛异常与 StateField 抛异常同级严重 —— 它会中断 CodeMirror 这一次视图更新，
 * 表现为「编辑区卡死、打字/删除/回车全都没反应」（用户报过）。任何 widget 都必须能
 * 退化成源码文本，绝不允许把异常抛回渲染流程。
 */
function fallbackTextDom(text: string, reason: unknown): HTMLElement {
  console.error("[live-preview] widget 渲染失败，退回源码文本：", reason);
  const span = document.createElement("span");
  span.className = "cm-widget-fallback";
  span.textContent = text;
  return span;
}

/** 列表符号替换文本用的简单文本 widget（`- ` → `• `） */
class TextWidget extends WidgetType {
  constructor(private readonly text: string) {
    super();
  }
  eq(other: TextWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-markup-replacement";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 公式 widget：内联显示 Rust 侧编出的 SVG，点击回到源码编辑 */
class MathWidget extends WidgetType {
  constructor(
    private readonly render: MathRender,
    private readonly range: MathRange,
    private readonly dark: boolean,
  ) {
    super();
  }

  /** 同一公式区间且渲染结果一致时复用 DOM（否则 CM6 会因对象不等而重建） */
  eq(other: MathWidget): boolean {
    return (
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.render.svg === this.render.svg &&
      other.dark === this.dark
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      const wrap = document.createElement("span");
      wrap.className = this.dark ? "cm-math-widget cm-math-dark" : "cm-math-widget";
      // 尺寸直接用 pt：Rust 侧按编辑器字号（14px = 10.5pt）编译，故 pt 与编辑器 CSS pt 1:1
      wrap.style.width = `${this.render.widthPt}pt`;
      wrap.style.height = `${this.render.heightPt}pt`;
      // 基线对齐：盒底到基线的距离 = height - baseline，整体下移这么多
      const depth = Math.max(0, this.render.heightPt - this.render.baselinePt);
      wrap.style.verticalAlign = `${-depth}pt`;
      wrap.title = `$${this.range.body}$（点击编辑源码）`;
      wrap.innerHTML = this.render.svg;
      const svg = wrap.querySelector("svg");
      if (svg) {
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
      // 点击 widget：光标落到公式源码起点 → 选区进入该区间 → 装饰撤掉，源码展开
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.range.from } });
        view.focus();
      });
      return wrap;
    } catch (e) {
      return fallbackTextDom(`$${this.range.body}$`, e);
    }
  }

  /** 不吞事件：交给编辑器默认处理（拖选等） */
  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 块级原始文本（``` 围栏）的 widget：把整段（含围栏行）替换成一个代码块外观，
 * 与 typst 的块级 `raw` 渲染一致（等宽、浅底、无围栏）。纯文本展示，不需要 typst 编译。
 */
class CodeBlockWidget extends WidgetType {
  constructor(
    private readonly code: string,
    private readonly range: { from: number; to: number },
  ) {
    super();
  }

  eq(other: CodeBlockWidget): boolean {
    return (
      other.code === this.code &&
      other.range.from === this.range.from &&
      other.range.to === this.range.to
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      const block = document.createElement("div");
      block.className = "cm-raw-block";
      block.title = "代码块（点击编辑源码）";
      const pre = document.createElement("pre");
      pre.className = "cm-raw-block-pre";
      pre.textContent = this.code;
      block.appendChild(pre);
      block.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.range.from } });
        view.focus();
      });
      return block;
    } catch (e) {
      return fallbackTextDom(this.code, e);
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 块切片 widget（阶段 1 的"渲染表面"）：整格源码被替换成**引擎自己画的那一块**。
 *
 * 尺寸不给死值：切片 SVG 的 viewBox/尺寸就是版心的尺寸，CSS 让 svg 宽度铺满正文列、
 * 高度按固有比例自动算（见 livePreviewTheme 的 .cm-block-crop svg）—— 这样窗口宽度
 * 变化到下一次重编译之间也不会变形错位。
 *
 * 点击 = 光标落到**点到的那个字符**（阶段 2 起按页面坐标做命中测试），
 * 拖选 = 从切片里拖出去选出一段（阶段 3）——两条都走 CodeMirror 的 `mouseSelectionStyle`
 * 接管（见 `cropMouseSelection`：自己挂 mousedown 会与它抢同一次事件）。
 * 选区进入这一格 → 装饰撤掉、源码展开（与公式 widget 同款）。
 */
class BlockCropWidget extends WidgetType {
  constructor(
    private readonly cover: BlockCover,
    private readonly raw: string,
    private readonly dark: boolean,
    private readonly onOpenLink?: (href: string) => void,
  ) {
    super();
  }

  eq(other: BlockCropWidget): boolean {
    return (
      other.cover.coverFrom === this.cover.coverFrom &&
      other.cover.coverTo === this.cover.coverTo &&
      other.cover.block.from === this.cover.block.from &&
      other.cover.block.svg === this.cover.block.svg &&
      other.dark === this.dark
    );
  }

  toDOM(_view: EditorView): HTMLElement {
    try {
      const wrap = document.createElement("div");
      wrap.className = this.dark ? "cm-block-crop cm-block-crop-dark" : "cm-block-crop";
      wrap.title = `${this.cover.block.kind}（点击编辑源码）`;
      // 块起点写在 DOM 上：浏览器验收要靠它把"夹具里的第几块"与"页面里的哪张切片"对上
      // （按位置取最可靠，不依赖切片顺序；调试时也比数第几个 div 直观）
      wrap.dataset.blockFrom = String(this.cover.block.from);
      wrap.dataset.blockKind = this.cover.block.kind;
      wrap.innerHTML = this.cover.block.svg;
      const svg = wrap.querySelector("svg");
      if (svg) {
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "auto");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
      // **不挂 mousedown**：切片的点击与拖选统一由 CodeMirror 的 mouseSelectionStyle 接管
      // （见 cropMouseSelection）。自己再挂一个会与它抢同一次事件。
      this.addLinkHotspots(wrap);
      return wrap;
    } catch (e) {
      // 兜底：任何异常都退回**源码文本**（绝不把异常抛回渲染流程，见 fallbackTextDom 的说明）
      return fallbackTextDom(this.raw, e);
    }
  }

  /**
   * 切片内部的**链接热区**（阶段 3）：按"带内相对 pt"换算成百分比，铺一层透明可点的方块。
   *
   * 百分比而不是像素：切片 SVG 是 `width:100%; height:auto`，整块按列宽等比缩放，
   * 所以带内相对坐标 → 百分比这一层换算与显示尺寸无关（界面缩放、窗口宽度都不用管）。
   *
   * 命中区**必须是真正的 DOM 元素**：SVG 里的链接是画出来的字形，点不到的。
   * 热区上按下时 `stopPropagation`，免得被切片的"点击/拖选"接管（点链接是"打开"语义，
   * 不是"把光标放到这里"）。
   */
  private addLinkHotspots(wrap: HTMLElement): void {
    const block = this.cover.block;
    const links = block.links ?? [];
    if (links.length === 0 || block.widthPt <= 0 || block.heightPt <= 0) return;
    for (const link of links) {
      const a = document.createElement("a");
      a.className = "cm-block-crop-link";
      a.href = link.href; // 真 href：验收与"复制链接地址"这类浏览器行为都靠它
      a.title = link.href;
      a.draggable = false;
      a.style.left = `${(link.xPt / block.widthPt) * 100}%`;
      a.style.top = `${(link.yPt / block.heightPt) * 100}%`;
      a.style.width = `${(link.widthPt / block.widthPt) * 100}%`;
      a.style.height = `${(link.heightPt / block.heightPt) * 100}%`;
      a.addEventListener("mousedown", (e) => e.stopPropagation());
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          this.onOpenLink?.(link.href);
        } catch (err) {
          console.error("[live-preview] 打开链接失败：", err);
        }
      });
      wrap.appendChild(a);
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 把块表算成"当前文档下要覆盖哪些区间"（块表已是 CodeMirror 位置，见 block-plan.toBlockTable）。
 * 越界 / 反序的格子直接丢掉（文档在编译期间被大改时可能出现）——宁可少渲染，不可乱渲染。
 *
 * 注意：这里**特意不做"文档变了就退回源码"**。块表在编译结果回来之前是旧的，而编辑只发生在
 * 已展开的那一格；其它格的边界都落在空白处（上一块的源码终点），偏一两个字符既不会露出来
 * 也不会吃掉正文。反过来"一变就退回"会让每敲一个字都闪一次源码（见 block-plan 的说明）。
 */
function buildBlockCovers(
  state: EditorState,
  opts: LivePreviewOptions,
  _doc: string,
): BlockCover[] {
  const blocks = opts.blocks?.() ?? null;
  if (!blocks || blocks.length === 0) return [];
  const docLength = state.doc.length;
  const covers = planBlockCovers(blocks, state.doc).filter(
    (c) =>
      c.coverFrom >= 0 && c.coverTo <= docLength && c.coverTo > c.coverFrom && c.block.from < docLength,
  );
  applyBlockSelection(
    covers,
    state.selection.ranges.map((r) => ({ from: r.from, to: r.to })),
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
function notifyBlocksNeeded(
  state: EditorState,
  opts: LivePreviewOptions,
  visible: readonly { from: number; to: number }[],
  _doc: string,
): void {
  if (!opts.enabled() || !opts.onBlocksNeeded) return;
  // **直接看块表，不要走 buildBlockCovers**：那条路会把"能渲染但还没有切片"的块标成
  // `revealed`（它们当下确实显示源码），于是"要不要补渲"的判据 `!cover.revealed` 永远为假 ——
  // 滚动到没渲过的区域时**一次重编译都不会触发**（这段代码曾经就是这样：要么等着用户敲一个字，
  // 要么永远显示源码）。判据只该是"这个块能渲染（found）但这一轮没拿到 svg"。
  const blocks = opts.blocks?.() ?? null;
  if (!blocks || blocks.length === 0) return;
  for (const block of blocks) {
    if (!block.found || block.svg !== "") continue;
    const near = visible.some(
      (v) => block.to >= v.from - PREFETCH_MARGIN && block.from <= v.to + PREFETCH_MARGIN,
    );
    if (near) {
      opts.onBlocksNeeded();
      return;
    }
  }
}

/** 区间是否落在某个"已被块 widget 盖住"的格子里（covered 已按 from 递增且不重叠） */
function insideCovered(
  from: number,
  to: number,
  covered: readonly { from: number; to: number }[],
): boolean {
  let lo = 0;
  let hi = covered.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = covered[mid];
    if (to <= c.from) hi = mid - 1;
    else if (from >= c.to) lo = mid + 1;
    else return true;
  }
  return false;
}

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
function buildMarkupDecorations(
  state: EditorState,
  scan: { opaque: Region[]; math: MathRange[] },
  covered: readonly { from: number; to: number }[] = [],
): Range<Decoration>[] {
  const doc = state.doc.toString();
  const marks = scanMarkupDecorations(doc, scan);
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decorations: Range<Decoration>[] = [];
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
    // 「整个构造」= 标记 + 正文的并集。标题与列表只有**前导**标记：若只取标记范围
    // （如 `= ` 的 [0,2)），光标落在正文里就判不出"在构造内"，`= ` 不会露出（实测踩过）；
    // 粗体/斜体/行内代码的标记分列两侧，取并集同样正确。
    const from = Math.min(item.content.from, ...item.markers.map((m) => m.from));
    const to = Math.max(item.content.to, ...item.markers.map((m) => m.to));
    if (insideCovered(from, to, covered)) continue; // 整块已由切片呈现，别再叠标记隐藏
    // 选区进入整个构造（含标记）→ 露出标记符号，便于编辑源码
    const reveal = selectionTouchesRange({ from, to }, selections);
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
      decorations.push(
        Decoration.mark({ class: cls }).range(item.content.from, item.content.to),
      );
    }
    if (reveal) continue;
    for (const marker of item.markers) {
      if (marker.from >= marker.to) continue;
      decorations.push(
        marker.text !== undefined
          ? Decoration.replace({ widget: new TextWidget(marker.text) }).range(marker.from, marker.to)
          : Decoration.replace({}).range(marker.from, marker.to),
      );
    }
  }
  return decorations;
}

/**
 * 独占整行的行间公式（display）用**块级 widget**：整行替换成居中显示的排版结果，
 * 与 typst 把 `$ ... $` 排成独立居中式子的行为一致（行内 widget 只能贴着文字基线放，
 * 视觉上不像"独立成行的公式"）。
 *
 * CodeMirror 约束：块级装饰 / 跨行替换**不能来自 ViewPlugin**（会抛
 * "Block decorations may not be specified via plugins"），但来自 StateField 的装饰集可以
 * ——本扩展正是 StateField 提供（见 collect）。
 */
class MathBlockWidget extends WidgetType {
  constructor(
    private readonly render: MathRender,
    private readonly range: MathRange,
    private readonly dark: boolean,
  ) {
    super();
  }

  eq(other: MathBlockWidget): boolean {
    return (
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.render.svg === this.render.svg &&
      other.dark === this.dark
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      const block = document.createElement("div");
      block.className = this.dark ? "cm-math-block cm-math-dark" : "cm-math-block";
      block.title = `$${this.range.body}$（点击编辑源码）`;
      const box = document.createElement("span");
      box.className = "cm-math-block-box";
      box.style.width = `${this.render.widthPt}pt`;
      box.style.height = `${this.render.heightPt}pt`;
      box.innerHTML = this.render.svg;
      const svg = box.querySelector("svg");
      if (svg) {
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
      block.appendChild(box);
      block.addEventListener("mousedown", (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.range.from } });
        view.focus();
      });
      return block;
    } catch (e) {
      return fallbackTextDom(`$${this.range.body}$`, e);
    }
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * 该行间公式是否**独占所在各行**（前后只有空白）。
 * 只有独占时才能整行替换成块级 widget；与文字同行的 `$ x $`（typst 里也会排成独立式子，
 * 但就地整行替换会连同旁边的文字一起盖掉）仍按行内 widget 处理，避免"吃掉正文"。
 */
function blockRangeFor(doc: Text, range: MathRange): { from: number; to: number } | null {
  if (!range.display) return null;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(Math.min(range.to, doc.length));
  if (doc.sliceString(first.from, range.from).trim() !== "") return null;
  if (doc.sliceString(Math.min(range.to, last.to), last.to).trim() !== "") return null;
  return { from: first.from, to: last.to };
}

/**
 * 块切片装饰集：**未展开且可渲染**的格子整格替换成块 widget。
 *
 * 边界都取自"已铺满全文、彼此首尾相接"的格子（见 block-plan.planBlockCovers），所以
 * 这些 replace 区间互不重叠 —— CodeMirror 拒绝重叠的替换装饰（会抛
 * "Overlapping replacement decorations"），这条是硬约束。
 */
function buildBlockCropDecorations(
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

/** 依据「文档 + 选区 + 渲染缓存」算出公式 widget 装饰集 */
function buildMathDecorations(
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
    // 光标 / 选区进入 → 展开源码（含块级：光标落在公式内即整行回到源码）
    if (selectionTouchesRange(range, selections)) continue;
    // 落在"已被块切片盖住"的区间里：整块已经由块 widget 呈现，这里不能再叠一层 replace
    if (insideCovered(range.from, range.to, covered)) continue;
    const render = opts.lookup(mathCacheKey(range.body, range.display, context, MATH_SIZE_PT));
    // 未渲染 / 渲染失败 → 保持源码显示
    if (!render?.ok) continue;
    const block = blockRangeFor(state.doc, range);
    if (block) {
      // 独占整行的行间公式（含跨行）：整行 → 居中块级 widget
      decorations.push(
        Decoration.replace({
          widget: new MathBlockWidget(render, range, opts.dark()),
          block: true,
        }).range(block.from, block.to),
      );
      continue;
    }
    // 跨行但并非独占整行（少见写法）：保持源码，避免与同行文字打架
    if (range.multiline) continue;
    decorations.push(
      Decoration.replace({
        widget: new MathWidget(render, range, opts.dark()),
        inclusive: false,
      }).range(range.from, range.to),
    );
  }
  return decorations;
}

/**
 * 所见即所得扩展：公式内联渲染（widget 装饰 + 选区进出展开 + 渲染请求）。
 *
 * 装饰重算时机：文档变化 / 选区变化 / `refreshLivePreview` effect（渲染结果到货）。
 * 渲染请求时机：视口内（含预取边距）出现未缓存的公式。
 */
export function livePreview(opts: LivePreviewOptions): Extension {
  /**
   * 公式 widget + 常用标记样式合成一个装饰集（同一 StateField 提供，一次遍历文档）。
   * **整体 try/catch**：StateField 的 update 抛异常会让这次事务整个失败——文档不再更新，
   * 表现为"打字/删除/回车全部没反应"（用户报过：输入 `= 1 = 2` 后编辑区卡死）。
   * 任何装饰计算出的意外都必须退化成"不挂装饰"（源码照常显示、编辑照常可用），
   * 并把原因写进控制台，绝不冒泡到 CodeMirror 的事务里。
   */
  const collect = (state: EditorState): { deco: DecorationSet; covers: BlockCover[] } => {
    try {
        if (!opts.enabled()) return { deco: Decoration.none, covers: [] };
        // 一次重建里 lexer 只跑一遍：区域扫描结果同时喂给公式与标记两条扫描
        // （此前两条路径各自再扫一遍，40k 字符文档实测每次按键 ~14ms，合并后约 1/3）
        const doc = state.doc.toString();
        const opaque = scanNonMarkupRegions(doc);
        const math = scanMathRanges(doc, opaque);
        // 编译上下文与缓存键必须来自**同一次**文档快照（扩展内算，见 prefix 选项的说明）
        const context = buildMathContext(opts.prefix(), doc);
        // 块级切片（写作模式）：先算"哪些格子要被切片盖住"，再让公式/标记装饰避开它们
        const covers = buildBlockCovers(state, opts, doc);
        // 有编译错误的格子强制展开源码：波浪线画在源码上，被图片盖住就"哪儿也找不到错误"
        // （必须在 applyBlockSelection **之后**跑，否则会被选区判定覆盖回去）
        if (covers.length > 0) {
          const revealed = revealBlocksWithDiagnostics(
            covers,
            opts.diagnosticRanges?.(state.doc) ?? [],
          );
          if (revealed > 0) {
            dbg.log("blocks", `诊断所在块退回源码：${revealed} 块`);
          }
        }
        const covered = covers
          .filter((c) => !c.revealed)
          .map((c) => ({ from: c.coverFrom, to: c.coverTo }));
        const all = [
          ...buildBlockCropDecorations(state, doc, covers, opts),
          ...buildMathDecorations(state, opts, math, context, covered),
          ...buildMarkupDecorations(state, { opaque, math }, covered),
        ];
        return {
          // sort=true：两个来源的装饰按位置统一排序（CodeMirror 要求有序）
          deco: all.length === 0 ? Decoration.none : Decoration.set(all, true),
          // 格子表交给"跨块竖直移动"用（见 blockVerticalMoves）：它要按格子找相邻块
          covers,
        };
    } catch (e) {
      console.error("[live-preview] 装饰重建失败，已退化为源码显示：", e);
      return { deco: Decoration.none, covers: [] };
    }
  };

  const decoField = StateField.define<{ deco: DecorationSet; covers: BlockCover[] }>({
    create: (state) => collect(state),
    update(value, tr) {
      const refreshed = tr.effects.some((e) => e.is(refreshLivePreview));
      if (tr.docChanged || tr.selection || refreshed) {
        return collect(tr.state);
      }
      return { ...value, deco: value.deco.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
  });

  /**
   * **切片上的点击与拖选**（阶段 3）：由 CodeMirror 的 `mouseSelectionStyle` 接管鼠标选择。
   *
   * 为什么不铺"文字层"（按字形位置放绝对定位的 span、交给浏览器原生选择，pdf.js 那套）：
   * 它要①把整块字符搬进 DOM（窗口内 8000 字符 ≈ 8000 个 span，而切片本身就是一张图），
   * ②在 CodeMirror 的内容元素里造出**第二套选区**（复制走浏览器、剪切/改写走 CM，两套会打架）。
   * 这里换成"**把指针位置翻译成源码位置、再由 CM 落选区**"：选区只有一套，Ctrl+C/X、方向键、
   * 输入替换、Shift+方向键全都照旧；代价是**复制出来的是源码**（`= 标题` 而不是"标题"）——
   * 与 Typora 一致（Typora 复制出来也是 markdown 源码）。仍然拿不到的：浏览器 Ctrl+F 查找、
   * 拼写检查、无障碍，那三样确实要真正的文字层（见 docs/文档模式渲染保真-调研.md 3.4）。
   *
   * 位置解析分两种落点（都是"这一点的源码位置"）：
   *  - 落在**切片**上 → 页面坐标（pt）→ Rust 侧命中测试（图片里没有字符位置）；
   *  - 落在**源码行**上（拖过已展开的块、或本来就显示源码的块）→ 直接问 CodeMirror 的坐标映射。
   * 命中是异步的（一次 IPC），所以 `get()` 同步返回"上一次已知"的范围，异步结果回来后再补一次
   * dispatch —— 一次拖动里最多晚一帧，落点始终收敛到真实几何。
   */
  const DRAG_THRESHOLD_PX = 3;

  /** 指针位置 → 源码位置（切片走命中测试、源码行走 CM 坐标映射） */
  async function positionAtPointer(view: EditorView, x: number, y: number): Promise<number | null> {
    let crop: HTMLElement | null = null;
    try {
      // **用 Element 而不是 HTMLElement**：指针多半落在切片内部那个 `<svg>` 上，而它是 SVGElement
      // （`instanceof HTMLElement` 为 false）→ 之前会误判成"落在源码上"。实测踩过：拖选时锚点跑到
      // 下一块的边界上（走 CM 的坐标映射，而它只能给出 widget 的 from/to）。
      const el = document.elementFromPoint(x, y);
      crop = (el?.closest?.(".cm-block-crop") as HTMLElement | null) ?? null;
    } catch {
      crop = null; // jsdom 等环境没有 elementFromPoint：按"落在源码上"处理
    }
    const covers = decoFieldCovers(view);
    if (crop) {
      const cover = covers.find((c) => c.block.from === Number(crop!.dataset.blockFrom));
      const point = cover ? cropPagePoint(crop.getBoundingClientRect(), { x, y }, cover.block) : null;
      if (cover && point && opts.onCropClick) {
        try {
          const hit = await opts.onCropClick({
            page: point.page,
            xPt: point.xPt,
            yPt: point.yPt,
            from: cover.block.from,
            to: cover.block.to,
          });
          if (hit !== null && Number.isFinite(hit)) return hit;
        } catch (e) {
          console.error("[live-preview] 拖选定位失败，落回块首：", e);
        }
      }
      return cover ? cover.block.from : null;
    }
    try {
      return view.posAtCoords({ x, y });
    } catch {
      return null;
    }
  }

  class CropSelection {
    private anchor: number | null = null;
    private head: number | null = null;
    private moved = false;
    private busy = false;
    /** 松手那次解析可能撞上"上一次解析还没回来" —— 记下"要收尾"，等这一轮跑完照样收尾 */
    private wantsFinal = false;
    private sweep: HTMLElement | null = null;
    private last: { x: number; y: number };
    private readonly start: { x: number; y: number };

    constructor(
      private readonly view: EditorView,
      private readonly cover: BlockCover,
      event: MouseEvent,
    ) {
      this.start = { x: event.clientX, y: event.clientY };
      this.last = { ...this.start };
      /**
       * 松手要自己听：CM 的 `MouseSelection.up()` 只在 `dragging == null` 时才重新问 style，
       * 而且问的是**上一次 move 事件**（不是 mouseup）—— 靠 `get()` 是拿不到"松手了"这个信号的。
       * 捕获阶段挂，早于 CM 的冒泡处理。
       */
      document.addEventListener("mouseup", this.onUp, true);
    }

    private readonly onUp = (event: MouseEvent): void => {
      document.removeEventListener("mouseup", this.onUp, true);
      /**
       * **单击（没拖动过）时什么都不做**：按下的那次解析已经把光标放好了，而松手这一瞬间
       * 版面已经变了（那一块展开了源码）—— 再按松手处的坐标解析一遍就会落到**另一个位置**
       * （实测：点标题里的字，按下的解析是"位置 10"，松手时同一屏幕点已经对着别的块 → 位置 51）。
       * 拖到过才需要收尾。
       */
      if (!this.moved) return;
      this.last = { x: event.clientX, y: event.clientY };
      void this.track(true);
    };

    /** 文档变了就别再自己接管（与 CM 的 MouseSelection.update 约定一致） */
    update(update: ViewUpdate): boolean {
      if (update.docChanged) {
        document.removeEventListener("mouseup", this.onUp, true);
        this.clearSweep();
      }
      return update.docChanged;
    }

    /**
     * CM 在按下 / 每次拖动 / 松开时都会问"现在该选哪儿"。
     *
     * **拖动期间一律返回锚点光标**（常量）：一旦返回真正的选区，那块就会被展开成源码、
     * 版式跟着变，而版式一变，指针底下的内容就换了 —— 实测拖到一半位置会**倒着走**
     * （19 → 15），因为指针从"正文行"落到了刚露出来的空行上。所以拖动期间**不动布局**，
     * 只用一个半透明的"扫过"色块给出反馈，松手时才把真选区交出去（那一下版式变一次是应有的）。
     */
    get(event: MouseEvent, extend: boolean): EditorSelection {
      this.last = { x: event.clientX, y: event.clientY };
      if (!this.moved && Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y) > DRAG_THRESHOLD_PX) {
        this.moved = true;
      }
      void this.track(event.type === "mouseup");
      const current = this.view.state.selection.main;
      const anchor =
        extend && !current.empty ? current.anchor : this.anchor ?? this.cover.block.from;
      // 拖动中：保持不动（等松手再落真选区，见 onUp）。这里也必须用 single —— cursor() 返回的
      // 同样是 SelectionRange，交给 CM 的 MouseSelection 会读不到 .ranges
      if (this.moved) return EditorSelection.single(anchor, anchor);
      // 注意用 `single` 而不是 `range`：`EditorSelection.range()` 返回的是 **SelectionRange**
      // （没有 ranges/main，CM 的 MouseSelection 会拿它当 EditorSelection 用 → 读 undefined 崩掉）
      return extend && !current.empty
        ? EditorSelection.create([current.extend(this.head ?? anchor)])
        : EditorSelection.single(anchor, this.head ?? anchor);
    }

    /** 解析当前指针位置（同一时刻只跑一次；期间指针又动了就再跑一轮） */
    private async track(final: boolean): Promise<void> {
      if (final) this.wantsFinal = true;
      if (this.busy) return;
      this.busy = true;
      try {
        for (;;) {
          const point = this.last;
          const pos = await positionAtPointer(this.view, point.x, point.y);
          if (pos !== null) {
            const clamped = Math.max(0, Math.min(this.view.state.doc.length, pos));
            if (this.anchor === null) this.anchor = clamped;
            this.head = clamped;
            if (final || this.wantsFinal || !this.moved) this.commit(point);
            else this.paintSweep(point);
          }
          if (this.last === point) return;
        }
      } finally {
        this.busy = false;
        this.wantsFinal = false;
      }
    }

    /** 松手（或还没拖动时的单击）：把选区真正落下去 —— 版面这一步会变（相关块展开成源码） */
    private commit(point: { x: number; y: number }): void {
      if (this.anchor === null || this.head === null) return;
      this.clearSweep();
      const selection = this.moved
        ? EditorSelection.single(this.anchor, this.head)
        : EditorSelection.single(this.head, this.head);
      // 只点不动时把被点的字钉在指针那一带（与阶段 2 的单击行为完全一致）
      const pin = this.moved ? null : anchorPosEffect(this.view, this.head, point.y, "center");
      try {
        this.view.dispatch({ selection, effects: pin ?? undefined });
      } catch (e) {
        console.error("[live-preview] 拖选落选区失败：", e);
      }
    }

    /**
     * 拖动中的反馈：一个半透明的"扫过"色块（固定定位在视口里，从按下的高度扫到指针高度）。
     * 它只是视觉提示 —— 这段期间真正的选区还没落下（见 get 的说明）。
     */
    private paintSweep(point: { x: number; y: number }): void {
      try {
        if (!this.sweep) {
          const el = document.createElement("div");
          el.className = "cm-block-drag-sweep";
          el.setAttribute("aria-hidden", "true");
          el.style.position = "fixed";
          el.style.pointerEvents = "none";
          el.style.zIndex = "6";
          el.style.background = "rgba(128, 128, 128, 0.28)";
          document.body.appendChild(el);
          this.sweep = el;
        }
        const box = this.view.contentDOM.getBoundingClientRect();
        const top = Math.min(this.start.y, point.y);
        const height = Math.max(2, Math.abs(point.y - this.start.y));
        Object.assign(this.sweep.style, {
          left: `${box.left}px`,
          width: `${box.width}px`,
          top: `${top}px`,
          height: `${height}px`,
        });
      } catch {
        // 反馈画不出来不影响拖选本身
      }
    }

    private clearSweep(): void {
      this.sweep?.remove();
      this.sweep = null;
    }
  }

  /** 从当前状态里取"格子表"（拖选过程中指针可能落到别的切片上，要按位置查它那一格） */
  function decoFieldCovers(view: EditorView): BlockCover[] {
    try {
      return view.state.field(decoField)?.covers ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 把"按在切片上"的鼠标按下交给 `CropSelection`（见上面的长注释）。
   * 返回 null = 不是切片上的按下（或找不到那一格）→ CodeMirror 用默认的鼠标选择。
   */
  const cropMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
    try {
      // 同上：target 可能是切片里的 `<svg>`（SVGElement），别用 instanceof HTMLElement 判
      const crop = (event.target as Element | null)?.closest?.(".cm-block-crop") as HTMLElement | null;
      if (!crop) return null;
      const cover = decoFieldCovers(view).find((c) => c.block.from === Number(crop.dataset.blockFrom));
      return cover ? new CropSelection(view, cover, event) : null;
    } catch (e) {
      console.error("[live-preview] 切片鼠标选择接管失败，交回默认：", e);
      return null;
    }
  });

  /**
   * **跨块竖直移动**（修「在最后一块前面按上，跳回文档开头」）：
   * CodeMirror 的竖直移动会跳过所有 widget 去找文本行（见 `posAtCoords`），而写作模式的
   * 切片全是 widget —— 一路跳过就扫到内容顶部、返回位置 0。这里只在"默认结果会跨格"时接管，
   * 把光标放到相邻格的边界上；块内移动一律交回默认行为（逐行、保留目标列）。
   * 判定是纯函数 `verticalBlockTarget`（可单测），这里只做 CM 的接线。
   */
  const blockVerticalMoves = Prec.high(
    keymap.of([
      { key: "ArrowUp", run: (view) => crossBlock(view, -1) },
      { key: "ArrowDown", run: (view) => crossBlock(view, 1) },
      // PageUp/PageDown 另有语义（整屏翻页），见 pageMove
      {
        key: "PageUp",
        run: (view) => pageMove(view, false, false),
        shift: (view) => pageMove(view, false, true),
      },
      {
        key: "PageDown",
        run: (view) => pageMove(view, true, false),
        shift: (view) => pageMove(view, true, true),
      },
    ]),
  );

  /** 一次翻页走视口高度的多少（留一点重叠，跟浏览器/编辑器的习惯一致） */
  const PAGE_SCROLL_RATIO = 0.85;

  /**
   * **翻页**（PageUp / PageDown）：光标连着视口一起走一屏，落到新位置最近的那个字符上。
   *
   * 为什么不能交给 CodeMirror 默认：它的翻页是 `moveVertically(distance = 视口高)`，而
   * `moveVertically` 的扫描**跳过所有 widget**（见 `posAtCoords`）—— 写作模式的切片全是
   * widget，于是"翻一页"会直接落到内容顶部（位置 0）或文档末尾，看起来像"跳回开头"。
   * 阶段 1 的临时处置是"一次跨一块"，但那样翻页就不存在了。
   *
   * 这里的做法：把光标当前的屏幕 y 平移一屏得到目标 y，用**非精确**的 `posAtCoords`
   * 取那个点的位置（对 widget 它会返回该 widget 的 `from`/`to`，也就是那一格的边界，
   * 正好是"翻到这一块的开头"），再把光标放过去并按目标 y 做滚动锚定。
   *
   * 边界情况：到文档顶/底时目标位置不变，直接交回默认（不吞按键）。
   */
  function pageMove(view: EditorView, forward: boolean, extend: boolean): boolean {
    try {
      const covers = view.state.field(decoField).covers;
      // 没有块级渲染（源码模式 / 没编译过）→ 默认翻页是对的，别接管
      if (covers.length === 0) return false;
      const sel = view.state.selection;
      if (sel.ranges.length !== 1) return false;
      const scroller = view.scrollDOM;
      const box = scroller.getBoundingClientRect();
      if (box.height <= 0) return false;
      // 真正能滚的位移（到顶/到底时夹住；夹没了就交回默认）
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const dist = box.height * PAGE_SCROLL_RATIO;
      const shift = Math.max(
        -scroller.scrollTop,
        Math.min(maxScroll - scroller.scrollTop, forward ? dist : -dist),
      );
      if (Math.abs(shift) < 4) return false;
      const head = sel.main.head;
      const caret = view.coordsAtPos(head, 1);
      // 光标在视口里的屏幕高度：翻页后要让光标回到**同一个高度**（内容走一屏，光标不动）
      const restY = caret ? caret.top : box.top + box.height / 2;
      const x = caret ? caret.left + 1 : view.contentDOM.getBoundingClientRect().left + 2;
      // 目标 = "滚过 shift 之后会出现在光标那个屏幕高度"的内容 → 现在是屏幕上的 restY + shift
      const pos = view.posAtCoords({ x, y: restY + shift }, false);
      if (pos === null) return false;
      if (!extend && pos === head) return false; // 位置没动（到头了）：交回默认
      // 把"一屏位移"表达成滚动目标：光标回到原来的屏幕高度 = 内容正好走了一屏
      const anchor = anchorPosEffect(view, pos, restY, "center");
      view.dispatch({
        selection: extend ? EditorSelection.range(sel.main.anchor, pos) : EditorSelection.cursor(pos),
        effects: anchor ?? undefined,
      });
      return true;
    } catch (e) {
      console.error("[live-preview] 翻页失败，交回默认：", e);
      return false;
    }
  }

  function crossBlock(view: EditorView, dir: -1 | 1): boolean {
    try {
      const covers = view.state.field(decoField).covers;
      if (covers.length === 0) return false;
      const sel = view.state.selection;
      // 多光标 / 非空选区：不接管（选区扩展有自己的语义）
      if (sel.ranges.length !== 1 || !sel.main.empty) return false;
      const fallback = view.moveVertically(sel.main, dir > 0);
      const target = verticalBlockTarget(covers, sel.main.head, fallback.head, dir);
      if (target === null) return false;
      view.dispatch({
        selection: EditorSelection.cursor(target),
        scrollIntoView: true,
      });
      return true;
    } catch (e) {
      // 兜底：任何意外都交回默认行为（绝不吞按键、也不抛进事务）
      console.error("[live-preview] 跨块竖直移动失败，交回默认：", e);
      return false;
    }
  }

  /**
   * 收集「视口附近 + 尚未拿到结果」的公式渲染请求（父组件另有去重，重复调用无副作用）。
   *
   * **整体 try/catch**（与 StateField 的 collect 同级）：这个函数跑在 CodeMirror 的
   * ViewPlugin.update 里，抛异常会被 CM 记成 "CodeMirror plugin crashed" 并让这次插件更新作废。
   * 实测踩过：块表还是旧文档坐标时（文档刚缩短）`planBlockCovers` 内的 `lineAt` 抛 RangeError
   * —— 现在那条路径已经加了越界过滤，这里再兜一道，绝不让异常冒进 CM 的更新流程。
   */
  const collectRequests = (
    state: EditorState,
    visible: readonly { from: number; to: number }[],
    context: string,
  ) => {
    try {
      collectRequestsInner(state, visible, context);
    } catch (e) {
      console.error("[live-preview] 渲染请求收集失败（已跳过这一轮）：", e);
    }
  };

  const collectRequestsInner = (
    state: EditorState,
    visible: readonly { from: number; to: number }[],
    context: string,
  ) => {
    const doc = state.doc.toString();
    // 被块切片盖住的公式不用渲染（整块已经由切片呈现）：每个公式都是一次 IPC 往返，
    // 一篇有几十个公式的文档能省掉几十次。展开源码时（选区进入）才需要。
    const covered = buildBlockCovers(state, opts, doc)
      .filter((c) => !c.revealed)
      .map((c) => ({ from: c.coverFrom, to: c.coverTo }));
    const requests: MathRequest[] = [];
    for (const range of scanMathRanges(doc)) {
      if (insideCovered(range.from, range.to, covered)) continue;
      // 跨行公式：只有行间（display）会整行渲染成块级 widget，行内跨行保持源码不请求
      if (range.multiline && !range.display) continue;
      const near = visible.some(
        (v) => range.to >= v.from - PREFETCH_MARGIN && range.from <= v.to + PREFETCH_MARGIN,
      );
      if (!near) continue;
      const key = mathCacheKey(range.body, range.display, context, MATH_SIZE_PT);
      if (opts.lookup(key)) continue;
      requests.push({ key, body: range.body, display: range.display, context });
    }
    if (requests.length > 0) opts.onRequest(requests);
  };

  const requester = ViewPlugin.fromClass(
    class {
      // 构造即扫描一次：**打开文档**时（编辑器创建，没有任何 update）也要把公式渲染出来，
      // 只靠 update 的话首次打开文档会一直停在源码状态，直到用户敲第一个键（实测踩过）。
      constructor(view: EditorView) {
        if (!opts.enabled()) return;
        // 视图刚建立时视口可能尚未测量：取不到就用全文（宁可多渲染一点）
        let visible: readonly { from: number; to: number }[] = [];
        try {
            visible = view.visibleRanges;
          } catch {
            visible = [];
          }
          if (visible.length === 0) visible = [{ from: 0, to: view.state.doc.length }];
          const doc = view.state.doc.toString();
          collectRequests(view.state, visible, buildMathContext(opts.prefix(), doc));
          notifyBlocksNeeded(view.state, opts, visible, doc);
        }

        update(update: ViewUpdate) {
          if (!opts.enabled()) return;
          // 触发条件：文档/视口/选区变化，或父组件刚刷新了渲染结果（此时可能还缺别的公式，
          // 例如刚打开开关、或前缀改动导致缓存键全变）
          const refreshed = update.transactions.some((tr) =>
            tr.effects.some((e) => e.is(refreshLivePreview)),
          );
          if (!update.docChanged && !update.viewportChanged && !update.selectionSet && !refreshed) {
            return;
          }
          const doc = update.state.doc.toString();
          collectRequests(
            update.state,
            update.view.visibleRanges,
            buildMathContext(opts.prefix(), doc),
          );
          notifyBlocksNeeded(update.state, opts, update.view.visibleRanges, doc);
        }
      },
  );

  return [decoField, cropMouseSelection, blockVerticalMoves, requester, mathWidgetTheme];
}

/** 所见即所得相关样式（公式 widget + 常用标记） */
const mathWidgetTheme = EditorView.theme({
  // 块切片（写作模式的"渲染表面"）：正文列满宽、高度由 SVG 的固有比例决定 ——
  // 不写死高度，窗口宽度变化到下一次重编译之间也不会变形。line-height 归零避免
  // 行盒在 SVG 下方多出一截（与 .cm-math-block 同一个理由）。
  ".cm-block-crop": {
      display: "block",
      lineHeight: "0",
      cursor: "text",
      // 链接热区用百分比定位，需要它当定位参照
      position: "relative",
  },
  // 切片内部的链接热区（透明，悬停时给一条下划线做提示）
  ".cm-block-crop-link": {
      position: "absolute",
      cursor: "pointer",
      borderRadius: "2px",
  },
  ".cm-block-crop-link:hover": {
      backgroundColor: "rgba(128, 128, 128, 0.18)",
      textDecoration: "underline",
  },
  ".cm-block-crop:hover": {
      backgroundColor: "rgba(128, 128, 128, 0.06)",
  },
  ".cm-block-crop svg": {
      display: "block",
      width: "100%",
      height: "auto",
  },
  // 暗色：typst 产物是白底黑字（页面自带白底），整体反色后即"深色纸 + 浅色字"，
  // 与既有公式 widget 的反色策略一致（文档自带颜色会被反掉，见调研文档第三节）
  ".cm-block-crop-dark svg": {
      filter: "invert(1)",
  },

  ".cm-math-widget": {
      display: "inline-block",
      lineHeight: "0",
      cursor: "text",
      // 悬停时给一点反馈（与源码区分，但不抢眼）
      borderRadius: "2px",
  },
  ".cm-math-widget:hover": {
      backgroundColor: "rgba(128, 128, 128, 0.18)",
  },
  ".cm-math-widget svg": {
      display: "block",
      width: "100%",
      height: "100%",
  },
  // 暗色主题：typst 产物是黑字透明底，深色背景上会看不见 → 整体反色
  // （只影响黑色笔画，透明底保持不变）。暗色标记由 Editor.svelte 按主题注入
  // （不用 `&dark` 选择器：EditorView.theme 不支持该前缀，实测抛 "Unsupported selector: &dark"）。
  ".cm-math-dark svg": {
      filter: "invert(1)",
  },
  // 独占整行的行间公式：居中显示（与 typst 的独立式子一致）
  ".cm-math-block": {
      textAlign: "center",
      padding: "4px 0",
      cursor: "text",
      lineHeight: "0",
  },
  ".cm-math-block:hover": {
      backgroundColor: "rgba(128, 128, 128, 0.12)",
  },
  ".cm-math-block-box": {
      display: "inline-block",
  },
  // 代码块（``` 围栏）：与 typst 的块级 raw 观感一致（等宽 + 浅底 + 圆角）
  ".cm-raw-block": {
      padding: "6px 8px",
      backgroundColor: "rgba(128, 128, 128, 0.14)",
      borderRadius: "4px",
      cursor: "text",
  },
  ".cm-raw-block-pre": {
      margin: "0",
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: "0.92em",
      lineHeight: "1.45",
      whiteSpace: "pre",
      overflowX: "auto",
  },
  // 列表符号替换文本：与正文同宽字符宽度，避免行首缩进跳动
  ".cm-markup-replacement": {
      color: "inherit",
  },
  // 常用标记样式：标题按级别放大加粗；粗体/斜体/行内代码沿用编辑器前景色
  ".cm-markup-heading": {
      fontWeight: "700",
  },
  ".cm-markup-strong": {
      fontWeight: "700",
  },
  ".cm-markup-emph": {
      fontStyle: "italic",
  },
  // 链接文字：蓝色下划线（两种主题下都够醒目）
  ".cm-markup-link": {
      color: "#3d8bfd",
      textDecoration: "underline",
      cursor: "pointer",
  },
  ".cm-markup-raw": {
      fontFamily: "Consolas, 'Courier New', monospace",
      backgroundColor: "rgba(128, 128, 128, 0.18)",
      borderRadius: "2px",
  },
  // 标题字号：级别越高越大（1.6em → 1.06em），行高随之变化是预期内的
  ".cm-markup-heading-1": { fontSize: "1.6em", lineHeight: "1.5" },
  ".cm-markup-heading-2": { fontSize: "1.4em", lineHeight: "1.45" },
  ".cm-markup-heading-3": { fontSize: "1.25em", lineHeight: "1.4" },
  ".cm-markup-heading-4": { fontSize: "1.15em" },
  ".cm-markup-heading-5": { fontSize: "1.08em" },
  ".cm-markup-heading-6": { fontSize: "1em" },
});
