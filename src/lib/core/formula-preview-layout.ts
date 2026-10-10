// 浮动公式预览的纯布局模型：输入锚点/视口/公式物理尺寸，输出卡片尺寸、位置、箭头与滚动。
// 不碰 DOM，与 preview-scale 一样用纯函数计算，便于单测覆盖长行、高矩阵、贴边与窄栏场景。
//
// 原则（对应 docs/development/writing-rendering.md 的浮动预览契约）：
// - 短公式按页面缩放的物理尺寸展示，不无谓拉满；
// - 长/高公式先缩到可见区（保持比例、仍可读），再超出可读下限时只在卡片内滚动；
// - 卡片整体不越出预览可见区、不撑出横向滚动条；
// - 优先放锚点下方，放不下翻到上方；箭头始终指回源码锚点。

/** 卡片内边距（px）：水平与垂直一致 */
export const FORMULA_PREVIEW_PADDING = 10;
/** 卡片边框（px）：模型把 border-box 宽高与 CSS 对齐，箭头不占盒内空间 */
export const FORMULA_PREVIEW_BORDER = 1;
/** 箭头高度（px）：绘制在卡片盒外、gap 内，因此不计入 height；必须小于 EDGE_MARGIN */
export const FORMULA_PREVIEW_ARROW = 8;
/** 卡片距预览可见区边缘的最小留白（px）：大于 ARROW，保证盒外箭头不越出可见区 */
export const FORMULA_PREVIEW_EDGE_MARGIN = 12;
/** 锚点（源码范围）与卡片之间的空隙（px）：盒外箭头（8px）落在这个间隙里 */
export const FORMULA_PREVIEW_GAP = 9;
/** 相对页面缩放的最小可读比例：低于它就不再缩小，改为卡片内横向滚动 */
export const FORMULA_PREVIEW_MIN_READABLE = 0.6;
/** 卡片内容区最小宽度（px）：窄公式不塌成一根线 */
export const FORMULA_PREVIEW_MIN_CONTENT_WIDTH = 36;

/** 矩形（任意一致坐标系） */
export interface FormulaPreviewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FormulaPreviewLayoutInput {
  /** 公式物理宽度（pt），来自 Rust FormulaPreview */
  widthPt: number;
  /** 公式物理高度（pt） */
  heightPt: number;
  /** 页面显示缩放（px/pt）：页面 host 矩形宽度 / 页面 box 宽度 */
  scale: number;
  /** 源码锚点包围盒（与 viewport 同一坐标系） */
  anchor: FormulaPreviewRect;
  /** 预览可见区（与 anchor 同一坐标系） */
  viewport: FormulaPreviewRect;
  /** 原生滚动条占位（px）：一次测量缓存，overlay 平台为 0 */
  scrollbar?: { width: number; height: number };
}

export interface FormulaPreviewLayout {
  /** 卡片整体 left（与输入坐标系一致） */
  left: number;
  /** 卡片整体 top */
  top: number;
  /** 卡片整体宽度（含内边距与边框，箭头在盒外） */
  width: number;
  /** 卡片整体高度（含内边距与边框，箭头在盒外） */
  height: number;
  /** 内容（SVG）渲染宽度：保持公式比例，可能大于可见窗口 */
  contentWidth: number;
  /** 内容（SVG）渲染高度 */
  contentHeight: number;
  /** 内容可见窗口宽度（滚动容器 clientWidth） */
  viewWidth: number;
  /** 内容可见窗口高度（滚动容器 clientHeight） */
  viewHeight: number;
  /** 滚动容器 CSS 宽度（viewWidth + 纵滚滚动条占位） */
  containerWidth: number;
  /** 滚动容器 CSS 高度（viewHeight + 横滚滚动条占位） */
  containerHeight: number;
  /** 箭头相对卡片左边界的偏移（px） */
  arrowOffset: number;
  /** 卡片是否翻到锚点上方（箭头在底部指向下方） */
  flipped: boolean;
  /** 内容宽度是否超出可见窗口（需要卡片内横向滚动） */
  scrollX: boolean;
  /** 内容高度是否超出可见窗口（需要卡片内纵向滚动） */
  scrollY: boolean;
}

/**
 * 计算浮动公式预览卡片布局。输入非法（非正物理尺寸/缩放/视口）返回 null，调用方跳过绘制。
 */
export function layoutFormulaPreview(
  input: FormulaPreviewLayoutInput,
): FormulaPreviewLayout | null {
  const { widthPt, heightPt, scale, anchor, viewport, scrollbar } = input;
  if (![widthPt, heightPt, scale].every((v) => Number.isFinite(v) && v > 0)) return null;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  const sbWidth = Number.isFinite(scrollbar?.width) && scrollbar!.width > 0 ? scrollbar!.width : 0;
  const sbHeight =
    Number.isFinite(scrollbar?.height) && scrollbar!.height > 0 ? scrollbar!.height : 0;

  const naturalW = widthPt * scale;
  const naturalH = heightPt * scale;
  const availW = Math.max(
    FORMULA_PREVIEW_MIN_CONTENT_WIDTH,
    viewportWidth -
      2 * (FORMULA_PREVIEW_EDGE_MARGIN + FORMULA_PREVIEW_PADDING + FORMULA_PREVIEW_BORDER),
  );
  const availH =
    viewportHeight -
    2 * (FORMULA_PREVIEW_EDGE_MARGIN + FORMULA_PREVIEW_PADDING + FORMULA_PREVIEW_BORDER);
  if (availW <= 0 || availH <= 0) return null;

  // 宽度：自然尺寸 → 缩到可见区（仍可读）→ 保住可读下限并横向滚动。
  const minReadableW = naturalW * FORMULA_PREVIEW_MIN_READABLE;
  let contentWidth = naturalW;
  let scrollX = false;
  if (naturalW > availW) {
    if (availW >= minReadableW) {
      contentWidth = availW;
    } else {
      contentWidth = minReadableW;
      scrollX = true;
    }
  }
  const contentHeight = contentWidth * (heightPt / widthPt);
  const viewWidth = Math.min(contentWidth, availW);
  const viewHeight = Math.min(contentHeight, availH);
  const scrollY = contentHeight > availH;

  // 滚动容器要为原生滚动条留出占位：横滚时内容层要高出一个横向滚动条，纵滚时宽出一个纵向
  // 滚动条，这样 clientWidth/clientHeight 才等于可见窗口，短高/窄宽内容不会被滚动条吃光。
  const containerWidth = viewWidth + (scrollY ? sbWidth : 0);
  const containerHeight = viewHeight + (scrollX ? sbHeight : 0);

  // 卡片是 border-box：宽高 = 滚动容器 + 2×(内边距 + 边框)。箭头在盒外，不占这里。
  const width = containerWidth + 2 * (FORMULA_PREVIEW_PADDING + FORMULA_PREVIEW_BORDER);
  const height = containerHeight + 2 * (FORMULA_PREVIEW_PADDING + FORMULA_PREVIEW_BORDER);

  // 水平：卡片中心默认对齐锚点中心；贴边时整卡平移，箭头仍指回锚点。
  const anchorCenterX = (anchor.left + anchor.right) / 2;
  const minLeft = viewport.left + FORMULA_PREVIEW_EDGE_MARGIN;
  const maxLeft = viewport.left + viewportWidth - FORMULA_PREVIEW_EDGE_MARGIN - width;
  const left = Math.max(minLeft, Math.min(anchorCenterX - width / 2, maxLeft));
  const arrowOffset = Math.max(
    FORMULA_PREVIEW_MIN_CONTENT_WIDTH / 2,
    Math.min(anchorCenterX - left, width - FORMULA_PREVIEW_MIN_CONTENT_WIDTH / 2),
  );

  // 垂直：优先锚点下方；放不下翻到上方；上下都放不下时贴下方并夹在可见区内。
  const minTop = viewport.top + FORMULA_PREVIEW_EDGE_MARGIN;
  const maxTop = viewport.top + viewportHeight - FORMULA_PREVIEW_EDGE_MARGIN - height;
  const belowTop = anchor.bottom + FORMULA_PREVIEW_GAP;
  const aboveTop = anchor.top - FORMULA_PREVIEW_GAP - height;
  let top: number;
  let flipped = false;
  if (belowTop + height <= viewport.top + viewportHeight - FORMULA_PREVIEW_EDGE_MARGIN) {
    top = belowTop;
  } else if (aboveTop >= minTop) {
    top = aboveTop;
    flipped = true;
  } else {
    top = Math.max(minTop, Math.min(belowTop, maxTop));
    flipped = top + height / 2 < (anchor.top + anchor.bottom) / 2;
  }

  return {
    left,
    top,
    width,
    height,
    contentWidth,
    contentHeight,
    viewWidth,
    viewHeight,
    containerWidth,
    containerHeight,
    arrowOffset,
    flipped,
    scrollX,
    scrollY,
  };
}
