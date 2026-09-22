// 装饰用的 **widget 类**：把排版结果（SVG）塞进编辑器时用的 DOM 包装。
//
// 契约：凡是会解析/插入外部产物（SVG、innerHTML）的 `toDOM` 都必须 try/catch 到
// `fallbackTextDom`，**绝不把异常抛回 CodeMirror 的渲染流程** —— 抛进去会中断这次视图更新，
// 表现为"编辑区卡死、打字全没反应"（见 CLAUDE.md 红线 3）。
// `TextWidget` 例外且不需要兜底：它只 `createElement` + `textContent`（纯文本节点，无解析步骤），
// 而 `fallbackTextDom` 本身也是这两个动作 —— 给它加兜底等于用同一件事兜自己。
import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { MathRender } from "../../core/typst-engine";
import type { Block, BlockCover } from "../../core/block-plan";
import type { MathRange } from "../../core/math-ranges";
import { revealSourceAt } from "./reveal";

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
export class TextWidget extends WidgetType {
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
export class MathWidget extends WidgetType {
  constructor(
    private readonly render: MathRender,
    private readonly range: MathRange,
    private readonly dark: boolean,
    /**
     * 选区**完整盖住**了这个公式（用户要求「选中整个公式请不要展开」）：保持渲染外观，
     * 用一层淡色底表示"它被选中了"（与块切片的 .cm-block-crop-selected 同一套做法）。
     */
    private readonly selected = false,
  ) {
    super();
  }

  /** 同一公式区间且渲染结果一致时复用 DOM（否则 CM6 会因对象不等而重建） */
  eq(other: MathWidget): boolean {
    return (
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.render.svg === this.render.svg &&
      other.dark === this.dark &&
      other.selected === this.selected
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      const wrap = document.createElement("span");
      const classes = ["cm-math-widget"];
      if (this.dark) classes.push("cm-math-dark");
      if (this.selected) classes.push("cm-math-selected");
      wrap.className = classes.join(" ");
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
      // 点击 widget：光标落到公式源码起点 → 选区进入该区间 → 装饰撤掉，源码展开。
      // 选区与"钉在鼠标点高度"的滚动目标必须**同一个事务**（见 reveal.ts 的说明）。
      // 行内公式是单行 widget，第一行就是用户点的那一行，所以不传 widgetTop（总是可钉）。
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        revealSourceAt(view, this.range.from, e.clientY, { button: e.button });
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
export class CodeBlockWidget extends WidgetType {
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
        // 与 MathWidget 同一套：选区 + 滚动目标放同一个事务。**但围栏代码块往往是几十行的高块**：
        // 只有点在它的第一行上才钉，不然"把首行钉到鼠标处"会让页面向上滚整个块（见 reveal.ts）
        revealSourceAt(view, this.range.from, e.clientY, {
          button: e.button,
          widgetTop: block.getBoundingClientRect().top,
        });
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
export class BlockCropWidget extends WidgetType {
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
      other.cover.selected === this.cover.selected &&
      other.dark === this.dark
    );
  }

  toDOM(_view: EditorView): HTMLElement {
    try {
      const wrap = document.createElement("div");
      const classes = ["cm-block-crop"];
      if (this.dark) classes.push("cm-block-crop-dark");
      // 整块被选中时保持切片外观，用一层淡色表示"选中了"（见 block-plan 的 selected 说明）
      if (this.cover.selected) classes.push("cm-block-crop-selected");
      wrap.className = classes.join(" ");
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
      // 选中色**必须铺在 SVG 之上**（见 .cm-block-crop-selected 的注释）：切片的 SVG 自带
      // 不透明的白纸底，只给容器加背景色是**看不见**的 —— 只在相邻切片的缝隙里漏出一两条细蓝线，
      // 看起来像整页被画上了网格（用户截图「太丑了」就是这么来的）。
      if (this.cover.selected) {
        const tint = document.createElement("div");
        tint.className = "cm-block-crop-tint";
        wrap.appendChild(tint);
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
      a.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        // **必须 preventDefault**：不拦的话浏览器会把这个 mousedown 当成"聚焦到链接"，
        // 编辑区随之失焦 —— 用户点完链接回来打字时**一个字都打不进去**
        // （Windows WebView2 / Chromium 上都这样；点链接是"打开外部"语义，不该夺走编辑焦点）。
        // 链接本身仍然可点：打开动作在下面的 click 里走 onOpenLink。
        e.preventDefault();
      });
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
 * 独占整行的行间公式（display）用**块级 widget**：整行替换成居中显示的排版结果，
 * 与 typst 把 `$ ... $` 排成独立居中式子的行为一致（行内 widget 只能贴着文字基线放，
 * 视觉上不像"独立成行的公式"）。
 *
 * CodeMirror 约束：块级装饰 / 跨行替换**不能来自 ViewPlugin**（会抛
 * "Block decorations may not be specified via plugins"），但来自 StateField 的装饰集可以
 * ——本扩展正是 StateField 提供（见 collect）。
 */
export class MathBlockWidget extends WidgetType {
  constructor(
    private readonly render: MathRender,
    private readonly range: MathRange,
    private readonly dark: boolean,
    /** 整行公式被选区完整盖住（见 MathWidget 的说明） */
    private readonly selected = false,
    /**
     * **行内呈现**（单行行间公式用）：widget 落在 `.cm-line` 里、由所在行居中，
     * 而不是做"整行 block 替换"。理由见 buildMathDecorations 里的那段说明
     * （block widget 是 contenteditable=false 的顶层元素，被选区盖住时打字会插到下一行）。
     */
    private readonly inline = false,
  ) {
    super();
  }

  eq(other: MathBlockWidget): boolean {
    return (
      other.range.from === this.range.from &&
      other.range.to === this.range.to &&
      other.render.svg === this.render.svg &&
      other.dark === this.dark &&
      other.selected === this.selected &&
      other.inline === this.inline
    );
  }

  toDOM(view: EditorView): HTMLElement {
    try {
      // 显式标成 HTMLElement：`createElement(a ? "span" : "div")` 的联合类型会让
      // addEventListener 的重载解析退化成 Event，拿不到 `clientY`（svelte-check 报错）
      const block: HTMLElement = document.createElement(this.inline ? "span" : "div");
      const classes = ["cm-math-block"];
      if (this.inline) classes.push("cm-math-block-inline");
      if (this.dark) classes.push("cm-math-dark");
      if (this.selected) classes.push("cm-math-selected");
      block.className = classes.join(" ");
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
        // 单行形态（inline）第一行就是点中的那一行；跨行形态与围栏代码块一样是高块 —— 由
        // `widgetTop` 交给 reveal.ts 判定（见那边的 shouldPin）
        revealSourceAt(view, this.range.from, e.clientY, {
          button: e.button,
          widgetTop: block.getBoundingClientRect().top,
        });
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
