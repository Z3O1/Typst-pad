// **公式渲染请求**：视口（含预取边距）里出现未缓存的公式时，把请求攒成一批交给父组件。
//
// 从 `live-preview.ts` 的组装层拆出来。只注入 `opts`（启用开关、取缓存、交请求、取前缀）。
// 组装层交给它的时机是 `ViewPlugin.update`（文档/视口/选区变化，或父组件刚刷新过渲染结果）。
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { buildBlockCovers } from "./block-decorations";
import { insideCovered } from "./covered";
import { blockRangeFor } from "./math-decorations";
import { notifyBlocksNeeded } from "./block-decorations";
import { buildMathContext } from "../../core/math-context";
import { mathCacheKey, mathRevealDecision } from "../../core/math-ranges";
import { scanMathRanges } from "../../core/math-ranges";
import { PREFETCH_MARGIN, refreshLivePreview } from "./options";
import type { MathRequest } from "./options";
import type { LivePreviewOptions } from "./options";
import { MATH_TEXT_PT } from "../../core/typst-engine";

/** 见 `createRequester` 的说明 */
export function createRequester({ opts }: { opts: LivePreviewOptions }) {
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

  return requester;
}
