import type { DocumentCaret } from "../core/typst-engine";

/** 仅滚动真实光标越界的轴；不会为保持插入点而改变页面尺寸或排版。 */
export function caretScrollDelta(
  position: { left: number; top: number; height: number; rotation: number },
  viewport: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const angle = (position.rotation * Math.PI) / 180;
  const endX = position.left - Math.sin(angle) * position.height;
  const endY = position.top + Math.cos(angle) * position.height;
  const axis = (start: number, end: number, min: number, size: number) => {
    if (size <= 0) return 0;
    const margin = Math.min(24, size / 4);
    let low = Math.min(start, end),
      high = Math.max(start, end);
    if (high - low > size - 2 * margin) low = high = start;
    return low < min + margin
      ? low - min - margin
      : high > min + size - margin
        ? high - min - size + margin
        : 0;
  };
  return {
    x: axis(position.left, endX, viewport.left, viewport.width),
    y: axis(position.top, endY, viewport.top, viewport.height),
  };
}

/** 先缩放光标方向向量，再求 CSS 高度/角度，避免旋转与非等比尺寸测量互相抵消。 */
export function projectDocumentCaret(
  caret: DocumentCaret,
  rect: { left: number; top: number; width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): { left: number; top: number; height: number; rotation: number } | null {
  if (
    ![
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      box.x,
      box.y,
      box.width,
      box.height,
      caret.xPt,
      caret.yPt,
      caret.heightPt,
      caret.rotationDeg ?? 0,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    caret.heightPt <= 0
  )
    return null;
  const scaleX = rect.width / box.width,
    scaleY = rect.height / box.height;
  const angle = ((caret.rotationDeg ?? 0) * Math.PI) / 180;
  const dx = -Math.sin(angle) * caret.heightPt * scaleX;
  const dy = Math.cos(angle) * caret.heightPt * scaleY;
  return {
    left: rect.left + (caret.xPt - box.x) * scaleX,
    top: rect.top + (caret.yPt - box.y) * scaleY,
    height: Math.max(2, Math.hypot(dx, dy)),
    rotation: (Math.atan2(-dx, dy) * 180) / Math.PI,
  };
}
