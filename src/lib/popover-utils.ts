// 状态栏徽标 Popover 的视口收边纯逻辑：给定实测布局矩形与视口尺寸，计算平移/限宽调整。
// 与 DOM 解耦（矩形以参数注入），便于单元测试；实际测量与样式应用在 +page.svelte。
// **两个徽标（编译错误 / 编译警告）共用这一套**：浮层元素都是 `left: 0` 锚定在各自 wrap 上的
// 绝对定位块，打开瞬间各测一次（同一时刻只会开一个，见 +page.svelte 的 openBadgePopover）。
// 不复用 context-menu-utils 的 computeMenuPosition：菜单是「按鼠标坐标定位」的
// fixed 元素，直接算出 left/top 落点；Popover 是锚定徽标的绝对定位元素，
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
 * 水平策略：平移优先——transform 平移只改变视觉位置、不破坏锚定关系，
 * CSS 默认宽 520px 得以保留；仅当 Popover 本身比视口可用宽度
 * （vw − 2·margin）还宽时，才叠加 max-width 限宽。
 * 注：限宽分支里的位移量是按**右缘锚定**推出来的（`margin − (rect.right − maxWidth)`），
 * 而锚点早已改成 `left: 0`，两者只在 `rect.width == maxWidth` 时等价 —— 但 CSS 给浮层压了
 * `max-width: 90vw`，这一支实际只在视口宽 < 160px 时才会进入（0.9vw > vw − 16），
 * 那种窗口下差几像素没有意义，故保持原样；真要改就两个徽标一起改，别只改一侧。
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
