// 错误列表 Popover 视口收边的纯逻辑模块：给定实测布局矩形与视口尺寸，计算平移/限宽调整。
// 与 DOM 解耦（矩形以参数注入），便于单元测试；实际测量与样式应用在 +page.svelte。
// 不复用 context-menu-utils 的 computeMenuPosition：菜单是「按鼠标坐标定位」的
// fixed 元素，直接算出 left/top 落点；Popover 是 right:0 锚定徽标的绝对定位元素，
// 只需在锚定基础上算位移增量，且存在「整层宽于视口可用空间」时需限宽的独立分支，
// 强行泛化会改动既有导出签名并波及菜单定位语义。

/** Popover 实测布局矩形（DOMRect 的结构子集，测试可直接传普通对象） */
export interface ClampRect {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
}

/** 视口尺寸 */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Popover 视口收边结果：
 * - translateX / translateY：叠加在元素上的平移量（px，向右/向下为正）；
 * - maxWidth：建议限宽（px），0 表示不限（保持 CSS 默认宽 520px）。
 */
export interface PopoverClampResult {
  translateX: number;
  translateY: number;
  maxWidth: number;
}

/**
 * 计算 Popover 打开后的视口收边（纯函数，供单测）。
 *
 * 水平策略：平移优先——Popover 是 right:0 锚定的绝对定位元素，transform 平移
 * 只改变视觉位置、不破坏锚定关系，CSS 默认宽 520px 得以保留；
 * 仅当 Popover 本身比视口可用宽度（vw − 2·margin）还宽（极小窗口，平移无法
 * 同时满足左右 margin）时，才叠加 max-width 限宽——right:0 锚定下限宽后
 * 左缘 = rect.right − 限宽值，把左缘平移到 margin 即可使右缘自然落在
 * vw − margin 内，两侧 margin 同时满足。
 *
 * 垂直策略：Popover 向上展开（bottom: calc(100% + 8px)），正常窗口不会越界；
 * 顶部越界（异常/极小窗口）时向下平移到 margin，不翻转展开方向（保持简单）。
 */
export function clampPopoverRect(
  rect: ClampRect,
  viewport: ViewportSize,
  margin = 8,
): PopoverClampResult {
  const { width: vw } = viewport;
  let translateX = 0;
  let translateY = 0;
  let maxWidth = 0;

  const availWidth = Math.max(0, vw - 2 * margin);
  if (rect.width > availWidth) {
    // 整层宽于视口可用空间：限宽 + 平移双保险
    maxWidth = availWidth;
    translateX = margin - (rect.right - maxWidth); // 左缘对齐 margin，右缘随之落在 vw − margin 内
  } else {
    if (rect.left < margin) translateX = margin - rect.left;
    // 宽 ≤ 可用空间时左右越界互斥（width = right − left），两个 if 可独立判断
    if (rect.right > vw - margin) translateX = vw - margin - rect.right;
  }

  if (rect.top < margin) translateY = margin - rect.top;

  return { translateX, translateY, maxWidth };
}
