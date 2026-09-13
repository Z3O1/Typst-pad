// 所见即所得（编辑器内联渲染）的 CodeMirror 6 扩展。
//
// 形态与 Typora / Obsidian Live Preview 一致：
//   * 非选中的公式区间 → 用 `Decoration.replace` 换成**渲染结果 widget**（Rust 侧编出的 SVG）；
//   * 光标或选区进入该区间 → 不挂 widget，源码自然露出，可直接编辑；
//   * 渲染失败 / 还没渲染好 → 保持源码显示（不显示空 widget，也不报错弹窗）。
//
// 装饰（Decoration）机制与既有的诊断波浪线同源（见 Editor.svelte 的 diagnosticsCompartment），
// 只是装饰类型由 `mark` 换成 `replace({ widget })`。
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range, Text } from "@codemirror/state";
import { mathCacheKey, scanMathRanges, selectionTouchesRange } from "./math-ranges";
import type { MathRange } from "./math-ranges";
import { scanMarkupDecorations } from "./markup-ranges";
import type { MarkupKind } from "./markup-ranges";
import { scanNonMarkupRegions } from "./typst-lex";
import type { Region } from "./typst-lex";
import { buildMathContext } from "./math-context";
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
): Range<Decoration>[] {
  const doc = state.doc.toString();
  const marks = scanMarkupDecorations(doc, scan);
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decorations: Range<Decoration>[] = [];
  for (const item of marks) {
    // 块级结构（代码块）：整段替换为 widget；光标/选区进入即整段回到源码
    if (item.block) {
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
    // 选区进入整个构造（含标记）→ 露出标记符号，便于编辑源码
    const reveal = selectionTouchesRange({ from, to }, selections);
    // 标题额外带级别类（字号按级别递增，见 livePreviewTheme）
    const cls =
      item.kind === "heading"
        ? `${MARKUP_CLASS.heading} cm-markup-heading-${item.level ?? 1}`
        : MARKUP_CLASS[item.kind];
    decorations.push(
      Decoration.mark({ class: cls }).range(item.content.from, item.content.to),
    );
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

/** 依据「文档 + 选区 + 渲染缓存」算出公式 widget 装饰集 */
function buildMathDecorations(
  state: EditorState,
  opts: LivePreviewOptions,
  ranges: MathRange[],
  context: string,
): Range<Decoration>[] {
  if (!opts.enabled()) return [];
  const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const decorations: Range<Decoration>[] = [];
  for (const range of ranges) {
    // 光标 / 选区进入 → 展开源码（含块级：光标落在公式内即整行回到源码）
    if (selectionTouchesRange(range, selections)) continue;
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
  const collect = (state: EditorState): DecorationSet => {
    try {
        if (!opts.enabled()) return Decoration.none;
        // 一次重建里 lexer 只跑一遍：区域扫描结果同时喂给公式与标记两条扫描
        // （此前两条路径各自再扫一遍，40k 字符文档实测每次按键 ~14ms，合并后约 1/3）
        const doc = state.doc.toString();
        const opaque = scanNonMarkupRegions(doc);
        const math = scanMathRanges(doc, opaque);
        // 编译上下文与缓存键必须来自**同一次**文档快照（扩展内算，见 prefix 选项的说明）
        const context = buildMathContext(opts.prefix(), doc);
        const all = [
          ...buildMathDecorations(state, opts, math, context),
          ...buildMarkupDecorations(state, { opaque, math }),
        ];
        if (all.length === 0) return Decoration.none;
        // sort=true：两个来源的装饰按位置统一排序（CodeMirror 要求有序）
        return Decoration.set(all, true);
    } catch (e) {
      console.error("[live-preview] 装饰重建失败，已退化为源码显示：", e);
      return Decoration.none;
    }
  };

  const decoField = StateField.define<DecorationSet>({
    create: (state) => collect(state),
    update(deco, tr) {
      const refreshed = tr.effects.some((e) => e.is(refreshLivePreview));
      if (tr.docChanged || tr.selection || refreshed) {
        return collect(tr.state);
      }
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  /** 收集「视口附近 + 尚未拿到结果」的公式渲染请求（父组件另有去重，重复调用无副作用） */
  const collectRequests = (
    state: EditorState,
    visible: readonly { from: number; to: number }[],
    context: string,
  ) => {
    const doc = state.doc.toString();
    const requests: MathRequest[] = [];
    for (const range of scanMathRanges(doc)) {
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
        }
      },
  );

  return [decoField, requester, mathWidgetTheme];
}

/** 所见即所得相关样式（公式 widget + 常用标记） */
const mathWidgetTheme = EditorView.theme({
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
