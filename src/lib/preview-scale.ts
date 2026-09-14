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
}

/** 字号对齐的自然缩放系数（px/pt）：使 Typst 默认字号（11pt）渲染为 targetFontPx 像素 */
export function naturalScale(targetFontPx: number): number {
  return targetFontPx / (TYPST_DEFAULT_TEXT_PT * PT_TO_PX);
}

/**
 * 预览缩放系数（px/pt），画布显示宽度 = pageWidthPt × 系数：
 * - 容器足够宽：取自然系数——预览默认字号对齐输入区，字号恒定不随窗口放大；
 * - 容器比自然尺寸窄：取铺满系数（containerWidth / pageWidthPt）——画布等比缩小，
 *   文本按比例变小但不变形（等宽显示），不出现横向滚动条。
 * 容器/页宽非法（非正数）时返回 NaN，调用方跳过应用（保留 CSS 回退 width: 100%）。
 *
 * **不许把界面缩放（uiZoom）乘进 containerWidth**（2026-09-14 用户明确要求，试过一版又撤回）：
 * 预览是**固定版心**的排版结果，塞不进栏宽时只能横向滚动 —— 于是"永不横向拖动"与
 * "预览跟着界面缩放变大"二选一（用户选了前者：`预览模式和文档模式的内容不应该有横向拖动，
 * 而是自动换行，Alt+Z 只对代码起效`）。乘了 uiZoom 之后画布会超出栏宽，实测 250% 缩放下
 * 预览栏横向溢出 166px，正是用户不要的样子。所以拟合**永远以实测栏宽为准**（画布宽度
 * 恒 ≤ 栏宽，见 preview-scale.test.ts 的"永不横向溢出"用例）。
 */
export function previewScale(input: PreviewScaleInput): number {
  const { containerWidth, pageWidthPt } = input;
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  const natural = naturalScale(input.targetFontPx ?? EDITOR_FONT_PX);
  return Math.min(containerWidth / pageWidthPt, natural);
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
