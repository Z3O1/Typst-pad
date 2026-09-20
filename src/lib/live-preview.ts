// 所见即所得（编辑器内联渲染）的 CodeMirror 6 扩展。
//
// 形态与 Typora / Obsidian Live Preview 一致：
//   * 非选中的公式区间 → 用 `Decoration.replace` 换成**渲染结果 widget**（Rust 侧编出的 SVG）；
//   * 光标或选区进入该区间 → 不挂 widget，源码自然露出，可直接编辑；
//   * 渲染失败 / 还没渲染好 → 保持源码显示（不显示空 widget，也不报错弹窗）。
//
// 装饰（Decoration）机制与既有的诊断波浪线同源（见 Editor.svelte 的 diagnosticsCompartment），
// 只是装饰类型由 `mark` 换成 `replace({ widget })`。
import { Decoration, EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { EditorSelection, Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import {
  mathCacheKey,
  mathRevealDecision,
  scanMathRanges,
  selectionTouchesRange,
} from "./math-ranges";
import { scanNonMarkupRegions } from "./typst-lex";
import { buildMathContext } from "./math-context";
import {
  applyBlockSelection,
  crossesCollapsedCover,
  planBlockCovers,
  revealBlocksWithDiagnostics,
  sourceVerticalTarget,
} from "./block-plan";
import type { BlockCover } from "./block-plan";
import { cropPagePoint } from "./block-hit";
import { anchorPosEffect } from "./scroll-anchor";
import { dbg } from "./debug";
import { MATH_TEXT_PT } from "./typst-engine";
// 拆出去的模块（本文件只做**组装**：把 StateField / 拖选 / 竖直移动 / 请求插件拼成一个 Extension）
import {
  buildBlockCovers,
  buildBlockCropDecorations,
  buildFenceHidingDecorations,
  buildHiddenBlockDecorations,
  insideCovered,
  notifyBlocksNeeded,
} from "./live-preview/block-decorations";
import { buildMarkupDecorations } from "./live-preview/markup-decorations";
import { blockRangeFor, buildMathDecorations } from "./live-preview/math-decorations";
import { PREFETCH_MARGIN, refreshLivePreview } from "./live-preview/options";
import type { LivePreviewOptions, MathRequest } from "./live-preview/options";
import { mathWidgetTheme } from "./live-preview/theme";

// 公共面原样再导出：外部（Editor.svelte / +page.svelte / 单测）的 import 路径不变
export { refreshLivePreview } from "./live-preview/options";
export type { LivePreviewOptions, MathRequest } from "./live-preview/options";

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
        ...buildHiddenBlockDecorations(state, covers),
        ...buildFenceHidingDecorations(state, covers),
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
      const point = cover
        ? cropPagePoint(crop.getBoundingClientRect(), { x, y }, cover.block)
        : null;
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
    /**
     * **Shift 扩选的固定端**（null = 本次按下不是扩选）。
     *
     * CM 的默认鼠标选择里 Shift+点击 = "从原选区（空选区时是光标）扩到点处"，而这里过去
     * 一律 `EditorSelection.single(anchor, head)`：锚点是**按下那一刻解析出来的位置**，
     * 于是 Shift+点击 / Shift+拖选切片不但没有扩选，反而把原选区**收掉**了
     * （PR #60 审查的第 6 条；验收当时只覆盖了 Shift+方向键）。
     */
    private readonly extendFrom: number | null;
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
      // 与 CM 默认选择同一口径：扩选的固定端是"原选区的锚点"，原选区为空时就是光标
      // （那种情况下 anchor == head，等于从光标处扩起）。
      const current = view.state.selection.main;
      this.extendFrom = event.shiftKey ? (current.empty ? current.head : current.anchor) : null;
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
      if (
        !this.moved &&
        Math.hypot(event.clientX - this.start.x, event.clientY - this.start.y) > DRAG_THRESHOLD_PX
      ) {
        this.moved = true;
      }
      void this.track(event.type === "mouseup");
      const current = this.view.state.selection.main;
      const anchor =
        extend && !current.empty ? current.anchor : (this.anchor ?? this.cover.block.from);
      /**
       * 拖动中：**保持不动**（等松手再落真选区，见 onUp / commit）。
       * 这里返回"当前选区"而不是锚点光标：返回光标会让 CM 立刻把光标放到这一块里 →
       * 那一块当场展开成源码 → 版式变 → 指针底下的内容跟着变（拖选会"倒着走"，
       * 见 CLAUDE.md 那条红线）。返回当前选区时 CM 的比较会判定"没变化"，一次事务都不发。
       */
      if (this.moved) return this.view.state.selection;
      // 注意用 `single` 而不是 `range`：`EditorSelection.range()` 返回的是 **SelectionRange**
      // （没有 ranges/main，CM 的 MouseSelection 会拿它当 EditorSelection 用 → 读 undefined 崩掉）
      // 扩选：固定端是 extendFrom（= 原选区那一端），活动端跟着指针 —— 与 CM 默认一致
      const from = this.extendFrom ?? anchor;
      return EditorSelection.single(from, this.head ?? from);
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
      if (this.head === null) return;
      // 扩选时锚点来自原选区，按下那一刻解析出来的位置不作数（见 extendFrom 的说明）；
      // 非扩选且没拖动过 = 普通单击 → 光标落在点处。
      const from = this.extendFrom ?? this.anchor;
      if (from === null) return;
      this.clearSweep();
      const selection =
        this.moved || this.extendFrom !== null
          ? EditorSelection.single(from, this.head)
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
      const crop = (event.target as Element | null)?.closest?.(
        ".cm-block-crop",
      ) as HTMLElement | null;
      if (!crop) return null;
      const cover = decoFieldCovers(view).find(
        (c) => c.block.from === Number(crop.dataset.blockFrom),
      );
      return cover ? new CropSelection(view, cover, event) : null;
    } catch (e) {
      console.error("[live-preview] 切片鼠标选择接管失败，交回默认：", e);
      return null;
    }
  });

  /**
   * **写作模式的竖直移动 = 代码模式的语义**（用户 2026-09-16：「我希望光标移动和代码模式的光标移动一样」）。
   *
   * 规则只有两条（判定全是纯函数，可单测）：
   *  1. `crossesCollapsedCover` 说"默认走法**没有**跨过未展开的切片" → 一律**交回 CodeMirror 默认**：
   *     `moveVertically` 逐可见行扫、保留目标列、空行也停 —— 那就是代码模式的行为（写作模式与
   *     源码模式的差别只剩"没展开的块显示成图片"，移动规则本身不该有差别）；
   *  2. 跨过了 → 默认把 widget 当空气跳过去了（可能跳一整块，也可能一路扫回文档开头），
   *     改按**源码行**走：一次一行、列保留；落点在切片里就把那一块展开（"光标进入即展开"）。
   *
   * 别退回"一次跨一整块"（0.7.x 那版 `verticalBlockTarget`）：它跳过段落之间那条空行、也丢掉
   * 目标列 —— 从第二段行首按 ↑ 会落到第一段的**行尾**、从第一段行尾按 ↓ 会直接进第二段，
   * 都与代码模式不一样（用户就是这么发现的）。
   *
   * Shift 变体（扩选）过去**没接管**，于是走到 CM 默认的 `selectLineDown` —— 那个同样会跳过所有
   * 切片（选中范围会突然跨过一整块）。现在与不带 Shift 的走法完全同源。
   */
  const blockVerticalMoves = Prec.high(
    keymap.of([
      {
        key: "ArrowUp",
        run: (view) => verticalMove(view, false, false),
        shift: (view) => verticalMove(view, false, true),
      },
      {
        key: "ArrowDown",
        run: (view) => verticalMove(view, true, false),
        shift: (view) => verticalMove(view, true, true),
      },
      // PageUp/PageDown 另有语义（走一屏、光标留在原来的屏幕高度），见 pageMove
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

  /**
   * 一次翻页的距离：与 CodeMirror 自己的 `pageInfo` 同源（`clientHeight - 5`，且不小于一行高）。
   * 别再回到"视口高度 × 0.85"那种留重叠的经验值 —— 那与代码模式差一截（同样的道理：翻页距离
   * 也是光标移动的一部分，用户要的是"和代码模式一样"）。
   */
  const PAGE_HEIGHT_MARGIN = 5;

  /**
   * **翻页**（PageUp / PageDown）：光标连着视口一起走一屏，落到新位置最近的那个字符上。
   *
   * 为什么不能交给 CodeMirror 默认：它的翻页是 `moveVertically(distance = 一屏高)`，而
   * `moveVertically` 的扫描**跳过所有 widget**（见 `posAtCoords`）—— 写作模式的切片全是
   * widget，于是"翻一页"会直接落到内容顶部（位置 0）或文档末尾，看起来像"跳回开头"。
   * 阶段 1 的临时处置是"一次跨一块"，但那样翻页就不存在了。
   *
   * 这里的做法与 CodeMirror 的 `cursorByPage` 是同一件事：把光标当前的屏幕 y 平移一屏得到目标 y，
   * 用**非精确**的 `posAtCoords` 取那个点的位置（对 widget 它会返回该 widget 的 `from`/`to`，
   * 也就是那一格的边界，正好是"翻到这一块的开头"），再把光标放过去、并**按目标 y 做滚动锚定**
   * ——光标因此停在原来的屏幕高度（CM 的 `cursorByPage` 用 `scrollIntoView(…, {yMargin})` 干同一件事）。
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
      /**
       * 位移**不按"还剩多少滚动余量"去夹**：那样在"已经滚到底但光标还在上面"时会把位移夹成 0，
       * 于是把按键交回默认 —— 而默认的翻页同样跳过所有切片（又回到"一下跳到文档末尾"那个问题）。
       * 正确地照代码模式做：光标朝那个方向走一屏（走过头由 `posAtCoords` 夹到文档首尾），
       * 滚动交给下面的锚定去跟（CM 的 `cursorByPage` 也是"先移一屏、再 scrollIntoView 钉回原位"）。
       */
      const dist = Math.max(view.defaultLineHeight, scroller.clientHeight - PAGE_HEIGHT_MARGIN);
      const head = sel.main.head;
      const caret = view.coordsAtPos(head, 1);
      // 光标在视口里的屏幕高度：翻页后要让光标回到**同一个高度**（内容走一屏，光标不动）
      const restY = caret ? caret.top : box.top + box.height / 2;
      const x = caret ? caret.left + 1 : view.contentDOM.getBoundingClientRect().left + 2;
      // 目标 = "滚过一屏之后会出现在光标那个屏幕高度"的内容 → 现在是屏幕上的 restY ± 一屏
      const pos = view.posAtCoords({ x, y: restY + (forward ? dist : -dist) }, false);
      if (pos === null) return false;
      if (!extend && pos === head) return false; // 位置没动（到头了）：交回默认
      // 把"一屏位移"表达成滚动目标：光标回到原来的屏幕高度 = 内容正好走了一屏
      const anchor = anchorPosEffect(view, pos, restY, "center");
      view.dispatch({
        selection: extend
          ? EditorSelection.range(sel.main.anchor, pos)
          : EditorSelection.cursor(pos),
        effects: anchor ?? undefined,
      });
      return true;
    } catch (e) {
      console.error("[live-preview] 翻页失败，交回默认：", e);
      return false;
    }
  }

  /**
   * 光标当前的**横向目标列**（px，相对内容左缘）。
   *
   * `goalColumn` 优先：CodeMirror 自己会把它挂在 `moveVertically` 的返回值上（跨行走时列不会丢），
   * 我们接管的那一步也要照抄它，否则"空了行的列"会退回 0 —— 实测场景：光标在第一段行尾（第 4 列）
   * → ↓ 停在空行（列 0）→ 再 ↓ 应该仍在**第 4 列**（代码模式如此），只看当前行的话会落到第 0 列。
   */
  function goalColumnX(
    view: EditorView,
    head: number,
    goalColumn: number | null | undefined,
  ): number | null {
    if (goalColumn != null) return goalColumn;
    try {
      const coords = view.coordsAtPos(head);
      if (!coords) return null;
      return coords.left - view.contentDOM.getBoundingClientRect().left;
    } catch {
      return null;
    }
  }

  /**
   * **按几何校正目标列**（`verticalMove` 的第 2 步）：在**目标行**上按横向目标列取一个位置。
   *
   * 为什么这里量得到：切片里量不到字符位置（图片里没有文本），所以第一步只能按**字符列**估；
   * 但落点那一块在**同一次事务**里已经从切片变回源码，CodeMirror 的 DOM 也是同步更新的
   * （实测：dispatch 之后立刻 `coordsAtPos` 已经是展开后的行），所以紧接着做一次布局读取就能
   * 拿到真实几何 —— "目标行的中线 + 光标原本的横向列"取到的位置，就是代码模式会落到的那一列。
   * 一次同步布局读取换来"列与代码模式完全一致"，比"先估、下一帧再修"（会看到光标跳一下）划算。
   *
   * 返回 null = 量不到（目标行不在视口 / 环境没有布局，如 jsdom）或几何过期（取到的位置在别的行上）
   * —— 调用方保留字符列的估算值，绝不乱挪。
   */
  function measureColumn(view: EditorView, pos: number, goalX: number): number | null {
    try {
      const row = view.state.doc.lineAt(pos);
      const coords = view.coordsAtPos(row.from);
      if (!coords) return null;
      const x = view.contentDOM.getBoundingClientRect().left + goalX;
      const hit = view.posAtCoords({ x, y: (coords.top + coords.bottom) / 2 });
      if (hit === null || view.state.doc.lineAt(hit).number !== row.number) return null;
      return hit;
    } catch {
      return null;
    }
  }

  /**
   * ↑/↓（含 Shift 扩选）：**默认没跨切片就交回默认**，跨了才按源码行走一步（见 `blockVerticalMoves`）。
   * 返回 false = 交给 CodeMirror 的默认绑定（永远安全：默认至少不会"什么都不做"）。
   */
  function verticalMove(view: EditorView, forward: boolean, extend: boolean): boolean {
    try {
      const covers = view.state.field(decoField).covers;
      // 没有块级渲染（源码模式 / 还没编译过）→ 默认绑定本来就是代码模式的行为
      if (covers.length === 0) return false;
      const sel = view.state.selection;
      if (sel.ranges.length !== 1) return false; // 多光标：交回默认
      const range = sel.main;
      // 非空选区（不带 Shift）在代码模式里是"收起到选区的一端"，交回默认即可（那一步不依赖几何）
      if (!range.empty && !extend) return false;
      const doc = view.state.doc;
      const head = range.head;
      const fallback = view.moveVertically(range, forward);
      // 默认走法没跨过任何未展开的切片 → 它本身就是代码模式的行为，一个字节都别改
      if (!crossesCollapsedCover(covers, head, fallback.head)) return false;
      // 跨过了切片：按源码行走**一行**（空行也停、列保留、落点所在块会因此展开）
      const line = doc.lineAt(head);
      const pos = sourceVerticalTarget(doc, head, forward ? 1 : -1, 1, head - line.from);
      if (pos === null || pos === head) return false;
      const goalX = goalColumnX(view, head, range.goalColumn);
      // 落在行尾（非空行）时 assoc 取 -1，否则光标会被画到下一行行首
      const row = doc.lineAt(pos);
      const assoc = row.length > 0 && pos === row.to ? -1 : 1;
      view.dispatch({
        selection: extend
          ? EditorSelection.range(range.anchor, pos, goalX ?? undefined)
          : EditorSelection.cursor(pos, assoc, undefined, goalX ?? undefined),
        scrollIntoView: true,
      });
      /**
       * 列：先用**字符列**估着落下去（切片里量不到像素位置），紧接着按真实几何校正一次 ——
       * 目标那一块在上一条 dispatch 里已经展开成源码，所以这里量得到（见 measureColumn）。
       * 量不到就保留字符列估算值。
       */
      if (goalX !== null) {
        const hit = measureColumn(view, pos, goalX);
        if (hit !== null && hit !== pos) {
          const target = doc.lineAt(hit);
          const hitAssoc = target.length > 0 && hit === target.to ? -1 : 1;
          view.dispatch({
            selection: extend
              ? EditorSelection.range(range.anchor, hit, goalX)
              : EditorSelection.cursor(hit, hitAssoc, undefined, goalX),
          });
        }
      }
      return true;
    } catch (e) {
      // 兜底：任何意外都交回默认行为（绝不吞按键、也不抛进事务）
      console.error("[live-preview] 竖直移动失败，交回默认：", e);
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
    // 光标/选区所在的公式**不请求渲染**：它此刻是源码形态（装饰里也跳过了），
    // 请求它等于"每敲一个字编译一次公式"——实测在公式里打 12 个字符就是 12 次 compile_math，
    // 而它和整篇编译共用一把锁（用户反馈「输入手感很差（公式）」）。光标离开后
    // selectionSet 会再跑一遍收集，那时才真正去渲。
    const selections = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
    for (const range of scanMathRanges(doc)) {
      // 展开成源码的那些不请求（见上）。**选区完整盖住公式时不展开**，所以那时照样要渲 ——
      // 否则"选中一个还没渲过的公式"会一直停在源码（与 buildMathDecorations 的判定同源，
      // 连"装饰实际盖住的区间"这个细节也必须一致，见那边的注释）。
      const block = blockRangeFor(state.doc, range);
      const asBlockWidget = block !== null && range.multiline;
      const decorated = block ?? { from: range.from, to: range.to };
      if (mathRevealDecision(decorated, selections, { inlinePresentation: !asBlockWidget }).reveal)
        continue;
      if (insideCovered(range.from, range.to, covered)) continue;
      // 跨行公式：只有行间（display）会整行渲染成块级 widget，行内跨行保持源码不请求
      if (range.multiline && !range.display) continue;
      const near = visible.some(
        (v) => range.to >= v.from - PREFETCH_MARGIN && range.from <= v.to + PREFETCH_MARGIN,
      );
      if (!near) continue;
      const sizePt = opts.mathSizePt?.() ?? MATH_TEXT_PT;
      const key = mathCacheKey(range.body, range.display, context, sizePt);
      if (opts.lookup(key)) continue;
      requests.push({ key, body: range.body, display: range.display, context, sizePt });
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
        notifyBlocksNeeded(opts, visible);
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
        notifyBlocksNeeded(opts, update.view.visibleRanges);
      }
    },
  );

  return [decoField, cropMouseSelection, blockVerticalMoves, requester, mathWidgetTheme];
}
