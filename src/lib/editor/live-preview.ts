// 所见即所得（编辑器内联渲染）的 CodeMirror 6 扩展**组装层**。
//
// 形态与 Typora / Obsidian Live Preview 一致：
//   * 非选中的公式区间 → 用 `Decoration.replace` 换成**渲染结果 widget**（Rust 侧编出的 SVG）；
//   * 光标或选区进入该区间 → 不挂 widget，源码自然露出，可直接编辑；
//   * 渲染失败 / 还没渲染好 → 保持源码显示（不显示空 widget，也不报错弹窗）。
//
// 这个文件现在只做三件事：**建装饰字段**（`collect` + `decoField`）、**给出块表取数口**
// （`getCovers`）、**把六个部件拼成一个 Extension**。具体部件都在 `./live-preview/` 下：
//   options（公共接口）/ widgets / markup·math·block-decorations / covered / theme /
//   block-drag（拖选）/ block-moves（竖直移动与翻页）/ requests（渲染请求）
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { scanDocument } from "./live-preview/doc-scan";
import { revealBlocksWithDiagnostics } from "../core/block-plan";
import type { BlockCover } from "../core/block-plan";
import { dbg } from "../core/debug";
import { MATH_TEXT_PT } from "../core/typst-engine";
import { createBlockDrag } from "./live-preview/block-drag";
import {
  buildBlockBandFitDecorations,
  buildBlockCovers,
  buildBlockCropDecorations,
  buildEngineBreakDecorations,
  buildFenceHidingDecorations,
  buildHiddenBlockDecorations,
  blockBandFit,
} from "./live-preview/block-decorations";
import { createBlockMoves } from "./live-preview/block-moves";
import { insideCovered } from "./live-preview/covered";
import { buildMarkupDecorations } from "./live-preview/markup-decorations";
import { blockRangeFor, buildMathDecorations } from "./live-preview/math-decorations";
import { refreshLivePreview } from "./live-preview/options";
import type { LivePreviewOptions } from "./live-preview/options";
import { createRequester } from "./live-preview/requests";
import { mathWidgetTheme } from "./live-preview/theme";

// 公共面原样再导出：外部（Editor.svelte / +page.svelte / 单测）的 import 路径不变
export { refreshLivePreview } from "./live-preview/options";
export { docScanStats, resetDocScanCache } from "./live-preview/doc-scan";
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
      // 扫描结果走**文档扫描缓存**（`doc-scan.ts`）：docChanged / 选区变化 / 刷新三种事务
      // 都要重建装饰，而只有第一种真的改了文档 —— 身份判据（CM 的 Text 对象）让后两种
      // 直接复用，纯选区移动不再全文重扫（报告 T3 / P1）。
      // 编译上下文与缓存键也来自同一次快照（扩展内算，见 prefix 选项的说明）。
      const scan = scanDocument(state, opts.prefix());
      const doc = scan.docString;
      const opaque = scan.opaque;
      const math = scan.math;
      const context = scan.context;
      // 块级切片（写作模式）：先算"哪些格子要被切片盖住"，再让公式/标记装饰避开它们
      const covers = buildBlockCovers(state, opts, doc, opaque);
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
      /**
       * 位置 → 所在块（格子首尾相接且按 `coverFrom` 升序 ⇒ 二分）。
       * 只给列表标记用：引擎给了 `listMarker` 的列表项按真实符号与正文偏移画
       * （见 ListMarkerWidget 的说明）。
       */
      const blockAt = (pos: number) => {
        let lo = 0;
        let hi = covers.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const c = covers[mid];
          if (pos < c.coverFrom) hi = mid;
          else if (pos >= c.coverTo) lo = mid + 1;
          else return c.block;
        }
        return null;
      };
      /**
       * 列表标记只在**块的第一行**用引擎值：`block.listMarker` 说的是这一块第一个条目的标记，
       * 而嵌套/多源码行块的后续行各有自己的标记与缩进 —— 拿外层标记去画内层行会错位。
       * 那些块本来就被判为切片/源码，后续行退回扫描器的近似符号（旧行为）。
       */
      const listMarkerAt = (pos: number) => {
        const block = blockAt(pos);
        if (!block || !block.listMarker) return null;
        return pos <= state.doc.lineAt(block.from).to ? block.listMarker : null;
      };
      // **块级带高盒**（见 block-decorations 的 buildBlockBandFitDecorations）：整篇可编辑正文都能
      // 拿到带高与首行主基线时才启用。要求"每一个可编辑正文块都有几何"是刻意的 —— 半套规则
      // （一部分块撑到带高、一部分按自然行盒）比不启用更差：后者只是漂移，前者会错位。
      // 量不出字体度量（jsdom / 老后端 / 源码模式）或块表过期时一律不启用，行为与从前一致。
      const bandMetrics = opts.writeFontMetrics?.() ?? null;
      const revealedText = covers.filter((c) => c.revealed && !c.noOutput);
      const bandBoxes =
        bandMetrics != null &&
        revealedText.length > 0 &&
        revealedText.every((c) => blockBandFit(c.block, bandMetrics) != null);
      const all = [
        ...buildBlockCropDecorations(state, doc, covers, opts),
        ...buildHiddenBlockDecorations(state, covers),
        ...buildFenceHidingDecorations(state, covers),
        ...(bandBoxes ? buildBlockBandFitDecorations(state, covers, bandMetrics) : []),
        // 引擎给的折行断点（见 buildEngineBreakDecorations）：段落折几行由 Typst 决定，不再是
        // 浏览器的贪心折行。块表过期（沿用旧坐标）时 lineBreaks 已在 remap 里清空，不会折错。
        ...buildEngineBreakDecorations(state, covers, opaque, math),
        ...buildMathDecorations(state, opts, math, context, covered),
        ...buildMarkupDecorations(state, scan, covered, bandBoxes, listMarkerAt),
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

  /** 当前块表（谁被切片盖住）：拖选与竖直移动两个部件共用这一个取数口。
   *  `require: false` 保住原来 `?.covers ?? []` 的兜底语义（字段不在配置里时给空表）。 */
  const getCovers = (state: EditorState): BlockCover[] =>
    state.field(decoField, false)?.covers ?? [];

  const cropMouseSelection = createBlockDrag({ opts, getCovers });
  const blockVerticalMoves = createBlockMoves({ getCovers });
  const requester = createRequester({ opts });

  return [decoField, cropMouseSelection, blockVerticalMoves, requester, mathWidgetTheme];
}
