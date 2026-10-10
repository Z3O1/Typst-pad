// 预览画布：typst 的整页 SVG 以 pt 为物理单位（viewBox="0 0 W H"，W/H 就是纸型的物理尺寸）。
// 前端只决定"页面显示多大"，编译结果本身不改写。两条路径：
//
// 1. **重排（[`previewPage`]）**：把预览的纸张换成"跟着预览栏走"的几何，正文由 typst
//    按新宽度重新排版、字号不变 —— 画布正好铺满预览栏，永不出现横向滚动条，而且预览字号
//    始终与编辑器一致（11pt 正文 ↔ 14px 编辑区）。代价（用户明确接受）：预览的换行/分页
//    不再等于导出的 PDF。几何在这里算，注入由 Rust 侧完成（见 typst_world::PreviewPage）。
// 2. **兜底（[`previewScale`]）**：重排不适用或没生效时等比缩放整页 —— 画布恒 ≤ 栏宽
//    （永不横向滚动），字号不超过编辑区（自然尺寸就停住，居中显示）。
//
// 为什么不是"一直铺满栏宽"（2026-09-30 的旧行为）：固定版心的页面放大后会超出栏宽，
// 用户就得横向拖动才能看全一行（「预览模式还是有横的拖动的条」）；而铺满又会把正文缩得
// 比代码小（用户：「文字预览文字大一点，应该默认和代码文件差不多大」）。两条诉求对固定
// 版心页面几何上互斥，用户选定的是重排那条路（2026-10-08：「直接把纸张大小改小，且不滚动，
// 可以接受排版变化」）。
//
// 独立模块以便单元测试（纯函数，不依赖 DOM）。

import { parser } from "codemirror-lang-typst/lezer";

/** Typst 默认正文字号（pt）——重排页宽与兜底字号的换算锚点 */
export const TYPST_DEFAULT_TEXT_PT = 11;

/** 输入区基准字号（px）：与 src/lib/editor/Editor.svelte 的 .cm-editor font-size 保持一致 */
export const EDITOR_FONT_PX = 14;

/** Typst 默认页边距（pt）＝2.5cm：文档自己的页边距拿不到，重排按同比例缩放它 */
export const TYPST_DEFAULT_MARGIN_PT = 70.87;

/** 文档模式默认纸型的临时紧凑页边距；不作用于明确页面布局或导出。 */
export const DOCUMENT_PREVIEW_MARGIN_PT = 24;

/** 预览重排的页宽下限（pt）：再窄正文会被边距挤成碎字 */
export const PREVIEW_PAGE_MIN_PT = 180;

/** Typst 默认纸型（pt，A4）：还没编译过、拿不到文档纸型时的兜底 */
export const DEFAULT_PAPER: PaperShape = { widthPt: 595.28, heightPt: 841.89 };

/** 文档自己的纸型（pt）：重排按它等比缩放页高与页边距，换 A5/自定义纸型也能跟着走 */
export interface PaperShape {
  widthPt: number;
  heightPt: number;
}

/** 重排要用的页面几何（pt）：与 Rust 侧 `PreviewPage` 一一对应 */
export interface PreviewPage {
  widthPt: number;
  heightPt: number;
  marginPt: number;
}

/** 预览缩放输入：容器可用宽度与页面物理宽度 */
export interface PreviewScaleInput {
  /** 预览容器可用宽度（px），如 .preview-body 的 clientWidth */
  containerWidth: number;
  /** 页面物理宽度（pt），从页 SVG 的 viewBox 读取 */
  pageWidthPt: number;
}

/** 自然字号系数（px/pt）：让 typst 默认正文（11pt）渲成编辑区字号（14px） */
export function naturalScale(targetFontPx: number = EDITOR_FONT_PX): number {
  return targetFontPx / TYPST_DEFAULT_TEXT_PT;
}

/**
 * 兜底路径的缩放系数（px/pt）：`min(铺满系数, 自然系数)`。
 * - 铺满系数 = 栏宽/页宽 —— 画布不会比栏宽宽（**永不横向滚动**）；
 * - 自然系数 —— 字号不超过编辑区，页宽不够时宁可小一号也不横滚。
 * 容器/页宽非法（非正数）时返回 NaN，调用方跳过应用（保留 CSS 回退 width: 100%）。
 */
export function previewScale(input: PreviewScaleInput): number {
  const { containerWidth, pageWidthPt } = input;
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  return Math.min(containerWidth / pageWidthPt, naturalScale());
}

/** 兜底路径的画布显示宽度（px）：页宽 × 系数；测量失败返回 NaN */
export function previewCanvasWidth(input: PreviewScaleInput): number {
  const scale = previewScale(input);
  if (Number.isNaN(scale)) return NaN;
  // 取较小值而不是直接 `页宽 × (栏宽/页宽)`：后者的浮点尾巴能做出 1e-13 的“溢出”
  return Math.min(input.containerWidth, input.pageWidthPt * scale);
}

/**
 * 预览栏可用宽度（CSS px）→ 重排页面几何（pt）；普通策略不需要缩窄时返回null，
 * 紧凑策略在宽栏也返回自然纸型及临时边距，以便Typst完整编译。
 *
 * 换算依据：重排后画布按 1:1 铺满预览栏（`px/pt = pane/width`），于是
 * `widthPt = pane × 11/14` 时正文正好渲成 14px。页高与页边距按文档**自己的纸型**
 * 等比缩放（不是写死 A4），所以 A5/自定义纸型的预览形状也正确。
 *
 * 只缩窄、从不加宽（`widthPt ≤ shape.widthPt`）：预览栏比自然尺寸宽时不需要重排
 * （走兜底路径，页面停在自然尺寸居中），否则会把版心拉成一行几百字。
 */
export function previewPage(
  paneWidthPx: number,
  shape: PaperShape = DEFAULT_PAPER,
  compact = false,
): PreviewPage | null {
  if (!(paneWidthPx > 0)) return null;
  const paper = shape.widthPt > 0 && shape.heightPt > 0 ? shape : DEFAULT_PAPER;
  const wanted = (paneWidthPx * TYPST_DEFAULT_TEXT_PT) / EDITOR_FONT_PX;
  if (wanted >= paper.widthPt && !compact) return null;
  const widthPt = Math.min(
    paper.widthPt,
    Math.max(wanted, Math.min(PREVIEW_PAGE_MIN_PT, paper.widthPt)),
  );
  const factor = widthPt / paper.widthPt;
  return {
    widthPt,
    heightPt: paper.heightPt * factor,
    marginPt: (compact ? DOCUMENT_PREVIEW_MARGIN_PT : TYPST_DEFAULT_MARGIN_PT) * factor,
  };
}

/** 明确布局（包括导入的潜在页面规则）保持原来的页面策略，不猜测用户版心。 */
export function usesDefaultPageLayout(source: string, shape: PaperShape): boolean {
  if (
    Math.abs(shape.widthPt - DEFAULT_PAPER.widthPt) >= 1 ||
    Math.abs(shape.heightPt - DEFAULT_PAPER.heightPt) >= 1
  )
    return false;
  let explicit = false;
  parser.parse(source).iterate({
    enter(node) {
      if (
        node.name === "Import" ||
        node.name === "Include" ||
        (node.name === "Ident" && /^(page|eval)$/.test(source.slice(node.from, node.to)))
      )
        explicit = true;
    },
  });
  return !explicit;
}

/**
 * 重排生效时的画布宽度（px）：**恒 ≤ 容器宽**——"永不出现横向滚动条"的保证。
 * 页宽被下限夹住时不再 1:1 铺满（栏太窄，字号只能跟着小）；正常情况就是栏宽。
 */
export function reflowCanvasWidth(containerWidth: number, pageWidthPt: number): number {
  if (!(containerWidth > 0) || !(pageWidthPt > 0)) return NaN;
  return Math.min(containerWidth, pageWidthPt * naturalScale());
}

/**
 * 重排是否**真的生效**：产物页宽应等于请求页宽。
 * 文档把页面设置写在别处（嵌套块、别处的 `#show`）时注入会被覆盖，产物仍是它自己的纸型
 * —— 那就退回兜底路径，绝不硬套重排的假设。
 */
export function isReflowApplied(actualPageWidthPt: number, requestedPageWidthPt: number): boolean {
  if (!Number.isFinite(actualPageWidthPt) || !Number.isFinite(requestedPageWidthPt)) return false;
  return Math.abs(actualPageWidthPt - requestedPageWidthPt) <= 1;
}

/** 从指定编译产物取最宽页纸型；调用方必须保证这是无注入、未投影的原文产物。 */
export function paperShapeFromPages(pages: string[]): PaperShape | null {
  let widest: PaperShape | null = null;
  for (const page of pages) {
    const viewBox = page.match(/\bviewBox="([^"]+)"/)?.[1];
    const shape = viewBox ? viewBoxSizePt(viewBox) : null;
    if (!shape) return null;
    if (!widest || shape.widthPt > widest.widthPt) widest = shape;
  }
  return widest;
}

/** 从 SVG viewBox 解析页面物理尺寸（pt）："0 0 W H" → {W, H}；解析失败返回 null */
export function viewBoxSizePt(viewBox: string): PaperShape | null {
  const parts = viewBox.trim().split(/[\s,]+/);
  if (parts.length !== 4) return null;
  const widthPt = Number(parts[2]);
  const heightPt = Number(parts[3]);
  if (!Number.isFinite(widthPt) || widthPt <= 0 || !Number.isFinite(heightPt) || heightPt <= 0)
    return null;
  return { widthPt, heightPt };
}
