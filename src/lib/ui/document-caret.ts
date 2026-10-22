import type { DocumentCaret } from "../core/typst-engine";

export interface DocumentCaretAnchor {
  left: number;
  top: number;
  height: number;
  rotation: number;
}
export type CaretFallbackReason = "pending" | "unmapped" | "unavailable";
export type CaretPresentationKind = "exact" | "composing" | "offscreen" | CaretFallbackReason;
export interface CaretViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface CaretPresentation {
  scope: number;
  anchor: DocumentCaretAnchor;
  kind: CaretPresentationKind;
}

function visibleAnchor(anchor: DocumentCaretAnchor, viewport: CaretViewport): boolean {
  const angle = (anchor.rotation * Math.PI) / 180;
  const x = anchor.left - Math.sin(angle) * anchor.height;
  const y = anchor.top + Math.cos(angle) * anchor.height;
  return (
    Math.min(x, anchor.left) >= viewport.left &&
    Math.max(x, anchor.left) <= viewport.left + viewport.width - 2 &&
    Math.min(y, anchor.top) >= viewport.top &&
    Math.max(y, anchor.top) <= viewport.top + viewport.height
  );
}

/** 反馈只保留物理锚点，不借用旧源码偏移；无锚点或视口变化时用视区内的明确兜底。 */
function feedbackAnchor(
  anchor: DocumentCaretAnchor | null,
  viewport: CaretViewport,
): DocumentCaretAnchor {
  if (anchor && visibleAnchor(anchor, viewport)) return anchor;
  const margin = Math.min(12, viewport.width / 4, viewport.height / 4);
  const height = Math.min(anchor?.height ?? 18, viewport.height - margin * 2);
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  return {
    left: clamp(
      anchor?.left ?? viewport.left + 24,
      viewport.left + margin,
      viewport.left + viewport.width - margin - 2,
    ),
    top: clamp(
      anchor?.top ?? viewport.top + 24,
      viewport.top + margin,
      viewport.top + viewport.height - margin - height,
    ),
    height,
    rotation: 0,
  };
}

/** 所有编辑路径共用的显示状态机；只在失焦、选区、离开模式/会话时清除，不依赖编译期限。 */
export function createDocumentCaretFeedback() {
  let scope = -1;
  let last: DocumentCaretAnchor | null = null;
  let frozen: DocumentCaretAnchor | null = null;
  let wasComposing = false;
  return {
    resolve(input: {
      scope: number;
      active: boolean;
      composing: boolean;
      exact: DocumentCaretAnchor | null;
      reason: CaretFallbackReason;
      viewport: CaretViewport;
    }): CaretPresentation | null {
      if (scope !== input.scope || !input.active) {
        scope = input.scope;
        last = frozen = null;
        wasComposing = false;
      }
      const { viewport } = input;
      if (
        !input.active ||
        !Object.values(viewport).every(Number.isFinite) ||
        viewport.width <= 2 ||
        viewport.height <= 2
      )
        return null;
      let kind: CaretPresentationKind;
      let anchor: DocumentCaretAnchor;
      if (input.composing) {
        if (!wasComposing) frozen = last ?? input.exact;
        anchor = feedbackAnchor(frozen, viewport);
        frozen = anchor;
        kind = "composing";
      } else if (input.exact && visibleAnchor(input.exact, viewport)) {
        anchor = input.exact;
        kind = "exact";
      } else {
        anchor = feedbackAnchor(input.exact ?? last, viewport);
        kind = input.exact ? "offscreen" : input.reason;
      }
      last = anchor;
      wasComposing = input.composing;
      return { scope, anchor, kind };
    },
  };
}

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
