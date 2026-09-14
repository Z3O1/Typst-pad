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
   * 为什么它与「容器宽度」必须一起看：界面缩放走 webview `setZoom`，它把 CSS 视口一起缩小 ——
   * 预览栏的 CSS 宽度也从 505 变成 331。若直接拿这个**已缩小**的宽度去算「铺满」，画布就跟着
   * 缩回原样，而引擎再放大一次恰好抵消：**缩放对编辑区有效（字号是 CSS px，被引擎放大）、
   * 对预览无效**——用户两次反馈「预览框大小还是没变」「预览框里面的字的大小还是没变」，
   * 实测 1040px 窗口下 100%→150% 画布的**物理尺寸比只有 0.983**（等于没变）。
   * 传进来的 containerWidth 是缩放**之后**量到的，所以这里先还原成缩放前的宽度再算：
   * 画布的 CSS 宽度保持在 100% 时的值，由引擎把它**真正放大**（1.5 档就大 1.5 倍）。
   * 附带好处：每一档缩放下预览字号都与编辑区字号一致（11pt 正文 ↔ 14px 编辑区）。
   *
   * **代价（2026-09-14 反复确认过两轮，最终以"预览要跟着缩放变大"为准）**：页面是**固定版心**
   * 的排版结果，放大到超过预览栏宽度时，预览栏会出现**横向滚动条**（页面的一部分要先横向滚过去）。
   * 中间试过"永远只用实测栏宽、画布恒 ≤ 栏宽"的一版（满足"不要横向拖动"），但那等于**界面缩放
   * 完全不影响预览**，被用户否掉：「预览框大小还是没变」。两者对固定版心的页面只能二选一 ——
   * 想两者兼得只能按栏宽**重新排版**（预览就不再是"整页分页对照"了，没做）。
   * 调用方的配套要求见 +page.svelte 的 `.preview-paper { margin-inline: auto }`：溢出时居中会把
   * 左缘顶到滚动区之外（scrollLeft 不能为负 → 那部分永远看不到），auto 外边距在负剩余空间下
   * 会退化成 0，从而"装得下就居中、装不下就左对齐"。
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

// ---------------------------------------------------------------------------
// 预览**按栏宽重新排版**（2026-09-14，用户反馈「预览模式还是有横的拖动的条」）
//
// 上面那套（previewScale/previewCanvasWidth）是"保留固定版心（A4）、按缩放放大画布"：
// 放大到超过预览栏宽就必然出现横向滚动条（固定版心 + 放大 = 几何必然，实测 210% 缩放下
// 要横滚 ~250px）。用户选定的是**重排**：预览的纸张宽度跟着预览栏走，正文按新宽度重新排版、
// 字号不变 → 预览栏永不出现横向滚动条，而且预览字号仍与编辑器一致。
// 代价（用户知情并接受）：预览的换行/分页不再等于导出的 PDF。
//
// 分工：真正"重排"发生在 Rust 侧（编译源最前面注入 `#set page(width: …)`，见
// typst_world::preview_page_setup）；这里只负责**把栏宽换算成页宽**、以及算画布宽度。
// 上面那套仍然保留：文档自己写了 `#set page(...)` 时注入会被覆盖，那时退回等比缩放。
// ---------------------------------------------------------------------------

/** 预览重排的页宽下限（pt）：与 Rust 侧 PREVIEW_PAGE_MIN_PT 对齐（太窄正文会挤成碎字） */
export const PREVIEW_PAGE_MIN_PT = 180;

/** 预览重排的页宽上限（pt）= A4 宽：再宽行就过长；与 Rust 侧上限一致 */
export const PREVIEW_PAGE_MAX_PT = 595.28;

/**
 * 预览栏可用宽度（CSS px）→ 重排要用的**页宽（pt）**。
 *
 * 换算依据：重排后画布按 1:1 铺满预览栏，于是 px/pt = containerWidth / pageWidthPt；
 * 要让正文（按 typst 默认 11pt 估计，与 naturalScale 同一锚点）渲染成 EDITOR_FONT_PX 像素，
 * 就需要 pageWidthPt = containerWidth × 11 / 14。容器不可测（隐藏 / 宽度 0）时返回 NaN。
 */
export function previewPageWidthPt(containerWidth: number): number {
  if (!(containerWidth > 0)) return NaN;
  const raw = (containerWidth * TYPST_DEFAULT_TEXT_PT) / EDITOR_FONT_PX;
  return Math.min(Math.max(raw, PREVIEW_PAGE_MIN_PT), PREVIEW_PAGE_MAX_PT);
}

/**
 * 重排模式下的画布宽度（px）：**恒 ≤ 容器宽**——这就是"永不出现横向滚动条"的保证。
 * 页宽被上下限夹住时画布不再 1:1 铺满：栏太窄时仍按栏宽（字号略小），太宽时停在自然尺寸
 * 并居中（`.preview-paper` 的 `margin-inline: auto`）。
 */
export function reflowCanvasWidth(containerWidth: number, pageWidthPt: number): number {
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  return Math.min(containerWidth, (pageWidthPt * EDITOR_FONT_PX) / TYPST_DEFAULT_TEXT_PT);
}

/**
 * 重排是否**真的生效**：产物页宽应等于请求页宽。
 * 文档自己写了 `#set page(...)`（后写的赢）时会覆盖注入的页设置，产物仍是它自己的纸型
 * —— 那就退回等比缩放路径（可能横滚），绝不硬套重排的假设。
 */
export function isReflowApplied(actualPageWidthPt: number, requestedPageWidthPt: number): boolean {
  if (!Number.isFinite(actualPageWidthPt) || !Number.isFinite(requestedPageWidthPt)) return false;
  return Math.abs(actualPageWidthPt - requestedPageWidthPt) <= 1;
}
