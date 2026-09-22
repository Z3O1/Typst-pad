// **切片上的鼠标拖选**（阶段 3）：按在一张切片上拖到另一张 → 选出一段跨块源码，Ctrl+C 能复制走。
//
// 从 `live-preview.ts` 的组装层拆出来（那里原本 267 行都在讲这一件事）。它只需要两个注入：
// `opts`（要不要启用）与 `getCovers`（当前块表 —— 谁被切片盖住由调用方持有的 StateField 提供，
// 本模块不反向依赖组装层，避免循环依赖）。
//
// 行为契约（改这里之前先读）：按下时把 DOM 坐标换算成源码位置、超过阈值才算拖动、拖动期间
// **不改编辑器状态只在选区上做替换**、抬起时 dispatch 一次；`mousedown` 要 `preventDefault`
// （否则会夺走编辑区焦点，见红线 5）。
import { EditorSelection } from "@codemirror/state";
import type { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { BlockCover } from "../../core/block-plan";
import { cropPagePoint } from "../../core/block-hit";
import { anchorPosEffect } from "../scroll-anchor";
import type { LivePreviewOptions } from "./options";

/** 见 `createBlockDrag` 的说明 */
export function createBlockDrag({
  opts,
  getCovers,
}: {
  opts: LivePreviewOptions;
  getCovers: (state: EditorState) => BlockCover[];
}) {
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

  /**
   * 命中测试的三种结果（报告 T2 / A1）：
   *  - `number`：落在哪儿；
   *  - `null`：**定不了位**（后端没有几何、命中不可用）→ 调用方退回"光标落到块首"；
   *  - `"cancelled"`：这次命中在等待期间**作废**（会话换了 / 文档改了 / 几何编号变了）→
   *    调用方必须**整条取消**，**绝不能**按 `null` 那样退回块首继续提交 ——
   *    那等于"明知结果过时，还照旧把光标插到块首"，正是这条要防的事。
   */
  type HitOutcome = number | "cancelled" | null;

  /**
   * 按下会话号（报告 T2 / A1 的"动作令牌"）：每次新的切片按下 +1，**普通源码上的按下也 +1**。
   * 上一次按下可能还有一次命中测试在飞 —— 它回来时发现会话已变，就什么都不提交（见
   * `cropMouseSelection`：只在新切片会话开始时推进是不够的，那会漏掉"点切片 → 点普通源码"）。
   */
  let clickEpoch = 0;

  /** 指针位置 → 源码位置（切片走命中测试、源码行走 CM 坐标映射） */
  async function positionAtPointer(view: EditorView, x: number, y: number): Promise<HitOutcome> {
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
          if (hit === "cancelled") return "cancelled";
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
    /** 本次交互已经作废（命中结果过时）：之后一律不提交任何东西 */
    private cancelled = false;
    /** 按下那一刻的文档：拖动/命中往返期间文档变过就作废（位置都是旧坐标） */
    private readonly docAtStart: Text;
    /** 松手那次解析可能撞上"上一次解析还没回来" —— 记下"要收尾"，等这一轮跑完照样收尾 */
    private wantsFinal = false;
    private sweep: HTMLElement | null = null;
    private last: { x: number; y: number };
    private readonly start: { x: number; y: number };

    constructor(
      private readonly view: EditorView,
      private readonly cover: BlockCover,
      event: MouseEvent,
      /**
       * 这次按下的会话号（模块级 `clickEpoch` 每次按下 +1）：上一次按下的异步命中回来时，
       * 若已经又按了一次（新会话），它的提交必须作废 —— 否则用户"点 A 又点 B"会看到光标
       * 先跳到 A、再跳到 B（迟到的那次覆盖了新的）。
       */
      private readonly epoch: number,
    ) {
      this.start = { x: event.clientX, y: event.clientY };
      this.last = { ...this.start };
      this.docAtStart = view.state.doc;
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
      // 已经作废的会话不许再落选区（也不许再退回块首）：保持现状
      if (this.cancelled) return this.view.state.selection;
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
          if (pos === "cancelled") {
            // 命中作废：这次交互彻底结束，**不提交任何东西**（不能当 null 退回块首）
            this.cancelled = true;
            this.head = null;
            this.anchor = null;
            this.clearSweep();
            return;
          }
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
      if (this.cancelled) return;
      // 文档在按下之后变过（IME、异步替换、别处的编辑）：手里的位置全是旧坐标，这次作废
      if (this.view.state.doc !== this.docAtStart) return;
      // 又按了一次（新会话）：迟到的那次不许覆盖新的
      if (this.epoch !== clickEpoch) return;
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
      return getCovers(view.state);
    } catch {
      return [];
    }
  }

  /**
   * 把"按在切片上"的鼠标按下交给 `CropSelection`（见上面的长注释）。
   * 返回 null = 不是切片上的按下（或找不到那一格）→ CodeMirror 用默认的鼠标选择。
   *
   * **不是切片上的按下也要 +epoch**（PR #77 复审的第 4 条）：CodeMirror 每次按下都会问这个
   * facet（`handlers.mousedown` 里遍历 `mouseSelectionStyle`），所以这里是"编辑器里又开始了
   * 一次指针选择"的唯一收口。少了这一步就有一个真实的错序：切片 A 的命中 IPC 还在飞时，
   * 用户点了普通源码 B —— 默认选择路径不动 epoch、文档身份也没变，A 的结果回来后 `commit()`
   * 的两道检查全过，光标会**从 B 被拉回 A**。任何后续指针选择都该作废那个在途会话。
   */
  const cropMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
    try {
      // 同上：target 可能是切片里的 `<svg>`（SVGElement），别用 instanceof HTMLElement 判
      const crop = (event.target as Element | null)?.closest?.(
        ".cm-block-crop",
      ) as HTMLElement | null;
      if (!crop) {
        clickEpoch += 1; // 普通源码上的按下：作废在途的切片命中
        return null;
      }
      const cover = decoFieldCovers(view).find(
        (c) => c.block.from === Number(crop.dataset.blockFrom),
      );
      if (!cover) {
        clickEpoch += 1; // 切片 DOM 已经对不上块表（旧图）→ 同样按"不在切片上"处理
        return null;
      }
      return new CropSelection(view, cover, event, ++clickEpoch);
    } catch (e) {
      console.error("[live-preview] 切片鼠标选择接管失败，交回默认：", e);
      clickEpoch += 1; // 接管失败走的是默认选择路径，同样要作废在途的切片命中
      return null;
    }
  });

  return cropMouseSelection;
}
