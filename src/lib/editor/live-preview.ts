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
import { scanMathRanges } from "../core/math-ranges";
import { scanNonMarkupRegions } from "../core/typst-lex";
import { buildMathContext } from "../core/math-context";
import { revealBlocksWithDiagnostics } from "../core/block-plan";
import type { BlockCover } from "../core/block-plan";
import { dbg } from "../core/debug";
import { MATH_TEXT_PT } from "../core/typst-engine";
import { createBlockDrag } from "./live-preview/block-drag";
import {
  buildBlockCovers,
  buildBlockCropDecorations,
  buildFenceHidingDecorations,
  buildHiddenBlockDecorations,
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

  /** 当前块表（谁被切片盖住）：拖选与竖直移动两个部件共用这一个取数口。
   *  `require: false` 保住原来 `?.covers ?? []` 的兜底语义（字段不在配置里时给空表）。 */
  const getCovers = (state: EditorState): BlockCover[] =>
    state.field(decoField, false)?.covers ?? [];

  const cropMouseSelection = createBlockDrag({ opts, getCovers });
  const blockVerticalMoves = createBlockMoves({ getCovers });
  const requester = createRequester({ opts });

  return [decoField, cropMouseSelection, blockVerticalMoves, requester, mathWidgetTheme];
}
