// Typst 整页 SVG 的 viewBox 使用 pt。前端只把页面等比映射到预览栏：
// 拖动窗口会持续改变页面宽度，用户缩放则在这个宽度上叠加。

/** 预览缩放输入：容器宽度、页面物理宽度与用户缩放 */
export interface PreviewScaleInput {
  /** 预览容器可用宽度（px），如 .preview-body 的 clientWidth */
  containerWidth: number;
  /** 页面物理宽度（pt），从页 SVG 的 viewBox 读取 */
  pageWidthPt: number;
  /** WebView 缩放：大于 100% 时页面可横向滚动，不抵消用户缩放。 */
  uiZoom?: number;
}

/** 界面缩放系数归一化：缺省/非法（0、负数、NaN、Infinity）一律按 1（不缩放）处理 */
export function normalizeUiZoom(uiZoom: number | undefined): number {
  return typeof uiZoom === "number" && Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1;
}

/**
 * 预览缩放系数（px/pt），画布显示宽度 = pageWidthPt × 系数。
 * 100% 时画布铺满预览栏；用户缩放继续乘在画布宽度上。
 * 容器/页宽非法（非正数）时返回 NaN，调用方跳过应用（保留 CSS 回退 width: 100%）。
 */
export function previewScale(input: PreviewScaleInput): number {
  const { containerWidth, pageWidthPt } = input;
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  return (containerWidth * normalizeUiZoom(input.uiZoom)) / pageWidthPt;
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
