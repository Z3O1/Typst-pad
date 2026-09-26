// **跨块竖直移动 / 翻页**：切片把非光标块换成图片之后，上下键与 PageUp/PageDown 不能按
// "一次跨一整块"走（那样一块就跳过一整段正文），要按**可见行**走、并且落到同一屏幕高度上。
//
// 从 `live-preview.ts` 的组装层拆出来。它只需要两个取数口：`getCovers`（块表由组装层的
// StateField 提供）与 `getSeparatorLines`（纯段落分隔行的行首集合，来自段距扫描）。
//
// 契约（改这里之前先读）：目标位置一律交给 `scrollIntoView`（**别自己写 scrollTop**，红线）；
// 默认没跨切片也没落到分隔行上就交回默认键位（`return false`）。
import { EditorSelection, Prec } from "@codemirror/state";
import type { EditorState, SelectionRange } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { crossesCollapsedCover, sourceVerticalTarget } from "../../core/block-plan";
import type { BlockCover } from "../../core/block-plan";
import { anchorPosEffect } from "../scroll-anchor";

/** 见 `createBlockMoves` 的说明 */
export function createBlockMoves({
  getCovers,
  getSeparatorLines,
}: {
  getCovers: (state: EditorState) => BlockCover[];
  /**
   * **纯段落分隔行的行首集合**（`paragraph-breaks` 的段距扫描结果，见 live-preview 的收集）。
   *
   * 为什么竖直移动需要它（用户 2026-09-26）：这些行在版面上只有 0~3px 高（段距由相邻块的带高
   * 承载），`moveVertically` 的半行步长会一步跨过它们 —— 而旧实现在"默认落点跳过了源码行"时
   * 反而要按源码行接管一次，于是光标被钉在这种行上：看起来"卡在两段之间"，且 Enter 的落点
   * 正好也压在这种行上（那正是"按 Enter 光标跳动"的一半来源）。
   * 现在这些行**不是停靠点**，但它们**仍是可编辑的源码行**（只是不该被 ↑/↓ 选中）。
   */
  getSeparatorLines: (state: EditorState) => ReadonlySet<number>;
}) {
  /**
   * **写作模式的竖直移动 = 可见行语义**（用户 2026-09-16 要求"和代码模式一样"，
   * 2026-09-26 追加"按可见行与可见段落移动，像 Typora 那样连续"）。
   *
   * 规则只有三条（判定全是纯函数，可单测）：
   *  1. `crossesCollapsedCover` 说"默认走法**没有**跨过未展开的切片"、且默认落点**不是**
   *     纯分隔行 → 一律**交回 CodeMirror 默认**：`moveVertically` 逐可见行扫、保留目标列 ——
   *     这就是代码模式的行为（写作模式与源码模式的差别只剩"没展开的块显示成图片"）。
   *     实测（2026-09-26）：这一步恰好也给出"目标行较短就落在它可见末端"的正确列；
   *  2. 默认落到了**纯分隔行**上 → 它不是停靠点，按可见行走到下一个停靠行（`前段\n\n后段`
   *     按一次 ↓ 直达后段；连续 Enter 建出来的**空段落**仍是停靠行，不在分隔行集合里）；
   *  3. 跨过了未展开的切片 → 默认把 widget 当空气跳过去了（可能跳一整块，也可能一路扫回
   *     文档开头），改按**可见行**走：落点在切片里就把那一块展开（"光标进入即展开"）。
   *
   * 别退回"一次跨一整块"（0.7.x 那版 `verticalBlockTarget`）：它跳过段落之间那条空行、也丢掉
   * 目标列 —— 从第二段行首按 ↑ 会落到第一段的**行尾**、从第一段行尾按 ↓ 会直接进第二段。
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
      const covers = getCovers(view.state);
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
      let pos = view.posAtCoords({ x, y: restY + (forward ? dist : -dist) }, false);
      if (pos === null) return false;
      /**
       * **翻页也不停在纯分隔行上**（同一条规则，见 `block_verticalMoves` 的说明）：翻页是按屏幕
       * 高度取位置的，正好压到块间那条零高行上时，光标会落在几乎看不见的地方。
       * 用 `sourceVerticalTarget` 从落点走到最近的停靠行（分隔行不算停靠点）。
       */
      const separators = getSeparatorLines(view.state);
      const landedOnSeparator = separators.has(view.state.doc.lineAt(pos).from);
      if (landedOnSeparator) {
        const stop = sourceVerticalTarget(
          view.state.doc,
          pos,
          forward ? 1 : -1,
          1,
          pos - view.state.doc.lineAt(pos).from,
          (from) => separators.has(from),
        );
        if (stop !== null) pos = stop;
      }
      if (!extend && pos === head) return false; // 位置没动（到头了）：交回默认
      // 把"一屏位移"表达成滚动目标：光标回到原来的屏幕高度 = 内容正好走了一屏
      const anchor = anchorPosEffect(view, pos, restY, "center");
      view.dispatch({
        selection: extend ? rangeTo(sel.main.anchor, pos, null) : cursorAt(pos, 0, null),
        effects: anchor ?? undefined,
      });
      return true;
    } catch (e) {
      console.error("[live-preview] 翻页失败，交回默认：", e);
      return false;
    }
  }

  /**
   * **把光标/选区落进一个真的 `EditorSelection` 里**。
   *
   * 坑（2026-09-26 实测）：`EditorSelection.cursor(...)` / `.range(...)` 返回的是 **`SelectionRange`**，
   * 而 `dispatch({ selection })` 只认 `EditorSelection`；传别的进去时 CodeMirror 会按
   * `EditorSelection.single(sel.anchor, sel.head)` 重建 —— **assoc 与 goalColumn 被静默丢掉**
   * （源码：`resolveTransactionInner` 的三元判断）。表现就是"目标列每跨一段就掉回行首 /
   * 连续 ↑↓ 落点不一致"。所以这里统一包一层。
   */
  function asSelection(range: SelectionRange): EditorSelection {
    return EditorSelection.create([range]);
  }
  const cursorAt = (pos: number, assoc: number, goalX: number | null) =>
    asSelection(EditorSelection.cursor(pos, assoc, undefined, goalX ?? undefined));
  const rangeTo = (anchor: number, head: number, goalX: number | null) =>
    asSelection(EditorSelection.range(anchor, head, goalX ?? undefined));

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
   * **目标行上、这一方向的那一条"可见行"矩形**（折行段落里就是第一条/最后一条视觉行）。
   *
   * 为什么要按视觉行取：段落折行时 ↑/↓ 必须落在**正确的那一行**上 —— 向下进入一个折行的
   * 目标段落要落在它的第一行，向上进入要落在它的最后一行。只用 `coordsAtPos(行首)` 会永远
   * 拿到第一行，向上时就把光标拉回了上一行（"重复落点"的一半来源）。
   *
   * 用 DOM Range 而不是 `coordsAtPos(行首)` 还有第二个理由：行首（或行内任意位置）可能落在
   * 被隐藏的标记（`= ` / `- ` 的 replace widget）里，那里的 `coordsAtPos` 给的是零宽 widget 的
   * 矩形，y 与真实文字行对不上，`posAtCoords` 于是按 above/below 兜底、把列丢掉。
   *
   * 同一视觉行要取**并集**（不是第一条矩形）：`getClientRects()` 会把行首空白、被隐藏标记留下的
   * 内联 widget 与正文各自返回一条，只拿第一条会把目标列过早夹到"行首空白"的右缘 —— 实测
   * `  - 列表项` 那一行目标列 63px 被夹到 28px（列从第 7 列掉回第 4 列）。
   *
   * 返回 null = 目标行不在 DOM 里（还在切片里没展开 / 不在视口）或环境没有布局（jsdom）。
   */
  function rowRect(
    view: EditorView,
    lineFrom: number,
    forward: boolean,
  ): { left: number; right: number; top: number; bottom: number } | null {
    try {
      const dom = view.domAtPos(lineFrom, 1);
      let el: Element | null =
        dom.node.nodeType === 3 ? dom.node.parentElement : (dom.node as Element);
      while (el && !el.classList?.contains("cm-line")) el = el.parentElement;
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0 && r.width > 0);
      if (rects.length === 0) {
        const own = el.getBoundingClientRect();
        return own.height > 0 && own.width > 0 ? own : null;
      }
      // 按"视觉行"分组：同一行的矩形**垂直重叠**（行首空白、被隐藏标记留下的内联 widget 与正文
      // 各自一条，box 高可以差好几像素），所以判据用"重叠超过较小者的 60%"，而不是比较 top。
      const rows: { top: number; bottom: number; left: number; right: number }[] = [];
      for (const r of rects) {
        const row = rows.find((x) => {
          const overlap = Math.min(x.bottom, r.bottom) - Math.max(x.top, r.top);
          const smaller = Math.min(x.bottom - x.top, r.bottom - r.top);
          return overlap > smaller * 0.6;
        });
        if (row) {
          row.top = Math.min(row.top, r.top);
          row.bottom = Math.max(row.bottom, r.bottom);
          row.left = Math.min(row.left, r.left);
          row.right = Math.max(row.right, r.right);
        } else {
          rows.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
      }
      rows.sort((a, b) => a.top - b.top);
      return forward ? rows[0] : rows[rows.length - 1];
    } catch {
      return null;
    }
  }

  /**
   * **按几何校正目标列**（`verticalMove` 的第 2 步）：在**目标行的那一条可见行**上，按横向目标列
   * 取一个位置。
   *
   * 为什么这里量得到：切片里量不到字符位置（图片里没有文本），所以第一步只能按**字符列**估；
   * 但落点那一块在**同一次事务**里已经从切片变回源码，CodeMirror 的 DOM 也是同步更新的
   * （实测：dispatch 之后立刻 `coordsAtPos` 已经是展开后的行），所以紧接着做一次布局读取就能
   * 拿到真实几何。两次 dispatch 都在同一次按键处理里同步完成，浏览器只画一帧 —— 用户只看到
   * 最终光标位置，看不到"先跳到估算位置再修正"（见 docs/development/writing-rendering.md）。
   *
   * 列按目标行的**可见范围**夹住：目标行较短时落在它的可见末端（用户要求）；
   * 返回 null = 量不到（目标行不在视口 / 环境没有布局，如 jsdom）或几何对不上（取到的位置在
   * 别的行、或不在同一条视觉行上）—— 调用方保留字符列的估算值，绝不乱挪。
   */
  function measureColumn(
    view: EditorView,
    pos: number,
    goalX: number,
    forward: boolean,
  ): number | null {
    try {
      const row = view.state.doc.lineAt(pos);
      const rect = rowRect(view, row.from, forward);
      if (!rect) return null;
      const contentLeft = view.contentDOM.getBoundingClientRect().left;
      const x = Math.min(
        Math.max(contentLeft + goalX, rect.left),
        Math.max(rect.left, rect.right - 1),
      );
      const midY = (rect.top + rect.bottom) / 2;
      const hit = view.posAtCoords({ x, y: midY });
      if (hit === null || view.state.doc.lineAt(hit).number !== row.number) return null;
      // 必须还在**同一条视觉行**上：否则就是把光标拉回了上一行（折行段落里的重复落点）
      const hitCoords = view.coordsAtPos(hit, -1);
      if (!hitCoords || Math.abs((hitCoords.top + hitCoords.bottom) / 2 - midY) > 2) return null;
      return hit;
    } catch {
      return null;
    }
  }

  /**
   * 上一次**我们自己**落下的竖直目标列（px，相对内容左缘）。
   *
   * 只为跨空行服务：块与块之间那条空源码行在写作模式里只有几个像素高（要贴 Typst 的段距，
   * 见 `markup-decorations` 的 `cm-write-parbreak`），空行上也没有文本 —— 光标的 x 恒等于 0，
   * 几何上量不出"用户其实想停在第 4 列"。实测高代/数分那种"从段落行尾 ↓ 到空行再 ↓ 到下一段"
   * 的走法会因此把列掉到 0（`writing-blocks` 的"列保留"用例就是这么红的）。
   * 只在"上一步也是我们落的、而且落点就是现在这个位置"时沿用 —— 别的一动（点击、打字、Home/End）
   * 位置就变了，那个列自然作废。
   */
  let carryGoal: { head: number; x: number } | null = null;

  /**
   * ↑/↓（含 Shift 扩选）：**默认走法落到可见行上就交回默认**，否则按可见行走一步
   * （见 `blockVerticalMoves`）。返回 false = 交给 CodeMirror 的默认绑定（永远安全：
   * 默认至少不会"什么都不做"）。
   */
  function verticalMove(view: EditorView, forward: boolean, extend: boolean): boolean {
    try {
      const covers = getCovers(view.state);
      // 没有块级渲染（源码模式 / 还没编译过）→ 默认绑定本来就是代码模式的行为
      if (covers.length === 0) return false;
      const sel = view.state.selection;
      if (sel.ranges.length !== 1) return false; // 多光标：交回默认
      const range = sel.main;
      // 非空选区（不带 Shift）在代码模式里是"收起到选区的一端"，交回默认即可（那一步不依赖几何）
      if (!range.empty && !extend) return false;
      const doc = view.state.doc;
      const head = range.head;
      const line = doc.lineAt(head);
      const separators = getSeparatorLines(view.state);
      const isSeparator = (from: number) => separators.has(from);
      const fallback = view.moveVertically(range, forward);
      /**
       * 两种情况下默认走法不能用，改按**可见行**走一步：
       *
       * 1. **默认落到了纯分隔行上**（`isSeparator`）：那不是停靠点 —— 它只有 0~3px 高（段距由
       *    相邻块的带高承载），停上去光标几乎看不见。`前段\n\n后段` 按一次 ↓ 应该直达后段。
       *    实测（2026-09-26）：块带生效时 `moveVertically` 的半行步长会落到这条零高行上
       *    （旧实现反而据此断定"默认跳过了源码行"、再按源码行接管一次，把光标钉死在这里）。
       * 2. **跨过了未展开的切片**（`crossesCollapsedCover`）：默认把 widget 当空气，
       *    可能跳一整块、也可能一路扫回文档开头（用户报过「在 `== 6` 前面按上跳回开头」）。
       *
       * 注意**不再**用"默认落点与当前行隔了不止一行"当接管判据：跨越纯分隔行正是我们想要的
       * 行为（用户 2026-09-26 明确作废了旧规则「空行也停一拍」）。行内折行（同一源码行内换视觉行）
       * 永远由 CodeMirror 逐可见行处理，不受这里影响。
       */
      const crossed = crossesCollapsedCover(covers, head, fallback.head);
      const landedOnSeparator = isSeparator(doc.lineAt(fallback.head).from);
      if (!crossed && !landedOnSeparator) return false;
      // 跨过分隔行 / 未展开的切片：按可见行走**一步**（分隔行不算停靠点，用户的空段落照停）
      const pos = sourceVerticalTarget(
        doc,
        head,
        forward ? 1 : -1,
        1,
        head - line.from,
        isSeparator,
      );
      if (pos === null || pos === head) return false;
      const goalX =
        range.goalColumn ??
        (line.length === 0 && carryGoal?.head === head ? carryGoal.x : null) ??
        goalColumnX(view, head, range.goalColumn);
      // 落在行尾（非空行）时 assoc 取 -1，否则光标会被画到下一行行首
      const row = doc.lineAt(pos);
      const assoc = row.length > 0 && pos === row.to ? -1 : 1;
      // 记住这一步的目标列：下一步若落在空行上，光标的 x 量不出它（见 carryGoal 的说明）
      carryGoal = goalX === null ? null : { head: pos, x: goalX };
      view.dispatch({
        selection: extend ? rangeTo(range.anchor, pos, goalX) : cursorAt(pos, assoc, goalX),
        scrollIntoView: true,
      });
      /**
       * 列：先用**字符列**估着落下去（切片里量不到像素位置），紧接着按真实几何校正一次 ——
       * 目标那一块在上一条 dispatch 里已经展开成源码，所以这里量得到（见 measureColumn）。
       * 量不到就保留字符列估算值。两次 dispatch 都在同一次按键里同步完成：只画一帧。
       */
      if (goalX !== null) {
        const hit = measureColumn(view, pos, goalX, forward);
        if (hit !== null && hit !== pos) {
          const target = doc.lineAt(hit);
          const hitAssoc = target.length > 0 && hit === target.to ? -1 : 1;
          carryGoal = { head: hit, x: goalX };
          view.dispatch({
            selection: extend ? rangeTo(range.anchor, hit, goalX) : cursorAt(hit, hitAssoc, goalX),
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

  return blockVerticalMoves;
}
