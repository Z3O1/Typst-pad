// 预览画布缩放：SVG 产物以 pt 为物理单位（typst-svg 输出 viewBox="0 0 W H"，
// W/H 即页面物理尺寸，单位 pt），CSS 中 1pt = 4/3px（96dpi：1in = 96px = 72pt）。
// 目标：画布等比缩放显示（等宽、文本不拉伸变形），预览默认字号对齐输入区字号
// （Editor.svelte 的 .cm-editor font-size: 14px）——
// - 窗口拉宽时画布停在自然尺寸不再放大，字号恒定；
// - 窗口变窄时画布等比缩小铺满容器宽度，文本按比例变小但不变形。
// 独立模块以便单元测试（纯函数，不依赖 DOM）。

/** CSS 单位换算：1pt = 4/3px（96dpi，1in = 96px = 72pt） */
export const PT_TO_PX = 4 / 3;

/** Typst 默认正文字号（pt）——预览「默认字号」的锚点 */
export const TYPST_DEFAULT_TEXT_PT = 11;

/** 输入区基准字号（px）：与 src/lib/Editor.svelte 的 .cm-editor font-size 保持一致 */
export const EDITOR_FONT_PX = 14;

/** 预览缩放输入：容器宽度、页面物理宽度、期望的预览默认字号 */
export interface PreviewScaleInput {
  /** 预览容器可用宽度（px），如 .preview-body 的 clientWidth */
  containerWidth: number;
  /** 页面物理宽度（pt），从页 SVG 的 viewBox 读取 */
  pageWidthPt: number;
  /** 期望的预览默认字号（px），默认对齐输入区字号 */
  targetFontPx?: number;
  /**
   * 界面缩放（Ctrl+滚轮，见 zoom.ts）：**必填才算对**，缺省按 1 处理。
   *
   * 为什么它与「容器宽度」必须一起看（2026-09-14 用户反馈「代码模式预览框的缩放还是无效」
   * 「变了但立刻弹回原样」，实测复现：1040px 窗口下 100%→150% 画布物理尺寸比 0.983）：
   * 界面缩放走 webview `setZoom`，它把 CSS 视口一起缩小 —— 预览栏的 CSS 宽度也从 505 变成 331。
   * 若直接拿这个**已缩小**的宽度去算「铺满」，画布就跟着缩回原样，而引擎再放大一次恰好抵消：
   * 缩放对编辑区有效（字号是 CSS px，被引擎放大）、对预览无效。传进来的 containerWidth
   * 是缩放**之后**量到的，所以这里要先还原成缩放前的宽度再算，画布的 CSS 宽度才会保持在
   * 100% 时的值、由引擎把它变大（超出栏宽就横向滚动）。
   * 附带好处：这样每一档缩放下预览字号都仍与编辑区字号一致（11pt 正文 ↔ 14px 编辑区）。
   */
  uiZoom?: number;
}

/** 字号对齐的自然缩放系数（px/pt）：使 Typst 默认字号（11pt）渲染为 targetFontPx 像素 */
export function naturalScale(targetFontPx: number): number {
  return targetFontPx / (TYPST_DEFAULT_TEXT_PT * PT_TO_PX);
}

/** 界面缩放系数归一化：缺省/非法（0、负数、NaN、Infinity）一律按 1（不缩放）处理 */
export function normalizeUiZoom(uiZoom: number | undefined): number {
  return typeof uiZoom === "number" && Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1;
}

/**
 * 预览缩放系数（px/pt），画布显示宽度 = pageWidthPt × 系数：
 * - 容器足够宽：取自然系数——预览默认字号对齐输入区，字号恒定不随窗口放大；
 * - 容器比自然尺寸窄：取铺满系数（containerWidth / pageWidthPt）——画布等比缩小，
 *   文本按比例变小但不变形（等宽显示），不出现横向滚动条。
 * 容器/页宽非法（非正数）时返回 NaN，调用方跳过应用（保留 CSS 回退 width: 100%）。
 */
export function previewScale(input: PreviewScaleInput): number {
  const { containerWidth, pageWidthPt } = input;
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  // 容器宽度是**缩放后**量到的 CSS 宽度（见 PreviewScaleInput.uiZoom 的长注释）：
  // 还原成缩放前的宽度，"铺满"才是相对于缩放前的栏宽，引擎再放大才不会被抵消。
  const unzoomedWidth = containerWidth * normalizeUiZoom(input.uiZoom);
  const natural = naturalScale(input.targetFontPx ?? EDITOR_FONT_PX);
  return Math.min(unzoomedWidth / pageWidthPt, natural);
}

/** 画布显示宽度（px）：页宽 × 缩放系数；测量失败返回 NaN */
export function previewCanvasWidth(input: PreviewScaleInput): number {
  const scale = previewScale(input);
  return Number.isNaN(scale) ? NaN : input.pageWidthPt * scale;
}

/** 从 SVG viewBox 解析页面物理宽度（pt）："0 0 W H" → W（逗号/空格分隔均可） */
export function viewBoxWidthPt(viewBox: string): number {
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return NaN;
  const width = Number(parts[2]);
  return Number.isFinite(width) && width > 0 ? width : NaN;
}
