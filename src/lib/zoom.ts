// 界面缩放纯逻辑（**Ctrl+滚轮** 放大/缩小整个界面）。
//
// 为什么是"缩放"而不是"改分栏宽度"：用户的原话是「字太小看不清」——要的是字变大，
// 不是让某一栏变宽。这里给出的是 **webview 缩放系数**（Tauri `setZoom`，等价于浏览器 Ctrl+滚轮
// 缩放）：CSS 像素不变、由引擎等比放大渲染，所以 CodeMirror 的行高测量、SVG 预览的尺寸计算
// 全都继续正确（换 CSS `zoom` 就会让 getBoundingClientRect 与设置值的单位错位，CM6 会算错行高）。
//
// 纯函数放这里以便单测：档距 / 方向 / 上下限收敛 / 浮点圆整 / 数值格式化。

/** 100%：不缩放 */
export const ZOOM_DEFAULT = 1;
/** 下限 50%：再小就没法用了 */
export const ZOOM_MIN = 0.5;
/** 上限 250%：再大基本没有意义（页面也很少用到） */
export const ZOOM_MAX = 2.5;
/** 一档 10%（鼠标滚轮一格 / 菜单点一次） */
export const ZOOM_STEP = 0.1;

/**
 * 收敛缩放系数：非法值回落 100%，超界收敛到上下限，并**按一档圆整**。
 * 圆整是必需的：0.1 累加会出现 1.2000000000000002 这种值，它会原样写进存档、
 * 也会出现在状态栏文案里（"缩放 120.00000000000001%"）。
 */
export function clampZoom(zoom: number | null | undefined): number {
  if (typeof zoom !== "number" || !Number.isFinite(zoom)) return ZOOM_DEFAULT;
  const stepped = Math.round(zoom / ZOOM_STEP) * ZOOM_STEP;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
  return Number(clamped.toFixed(2));
}

/** 缩放系数 → 整数百分比（状态栏文案 / 菜单标签用） */
export function zoomPercent(zoom: number | null | undefined): number {
  return Math.round(clampZoom(zoom) * 100);
}

/** 缩放系数 → 展示文案（如 "120%"） */
export function zoomLabel(zoom: number | null | undefined): string {
  return `${zoomPercent(zoom)}%`;
}

/**
 * 一次滚轮事件相当于几档（0.2 ~ 3，可带符号：正 = 放大）。
 *
 * 两个真机坑都在这里处理：
 * 1. **位移量要同时看 deltaY 与 deltaX**：按着 Shift 滚轮时 Chromium 把纵向滚动转成横向
 *    （`deltaY = 0`、`deltaX` 有值），只读 deltaY 会"按了没反应"（实测踩过）。
 * 2. **三种 deltaMode 的"一格"差别很大**：像素模式（鼠标一格 ≈ 100）按此折算并在 < 50 时
 *    视为触摸板小步长（下限 0.2 档，否则触摸板一划就窜到顶）；行模式一格算一档；页模式给 3 档。
 */
export function wheelZoomSteps(deltaY: number, deltaX = 0, deltaMode = 0): number {
  const y = Number.isFinite(deltaY) ? deltaY : 0;
  const effective = y !== 0 ? y : Number.isFinite(deltaX) ? deltaX : 0;
  if (effective === 0) return 0;

  const abs = Math.abs(effective);
  let notches: number;
  if (deltaMode === 1) notches = Math.min(3, Math.max(1, abs));
  else if (deltaMode === 2) notches = 3;
  else if (abs >= 50) notches = Math.min(3, Math.max(1, Math.round(abs / 100)));
  else notches = Math.max(0.2, abs / 100);

  // 滚轮向上（deltaY < 0）= 放大
  return (effective < 0 ? 1 : -1) * notches;
}

/** 滚轮 → 新的缩放系数（已收敛、已圆整） */
export function nextZoom(
  current: number | null | undefined,
  deltaY: number,
  deltaX = 0,
  deltaMode = 0,
): number {
  const steps = wheelZoomSteps(deltaY, deltaX, deltaMode);
  return clampZoom(clampZoom(current) + steps * ZOOM_STEP);
}

/** 放大 N 档（菜单项用） */
export function zoomIn(current: number | null | undefined, times = 1): number {
  return clampZoom(clampZoom(current) + times * ZOOM_STEP);
}

/** 缩小 N 档（菜单项用） */
export function zoomOut(current: number | null | undefined, times = 1): number {
  return clampZoom(clampZoom(current) - times * ZOOM_STEP);
}
