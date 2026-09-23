// **展开/收起时的临时占位**（报告 T4）：高公式展开成一行源码时会"缩"一下，补一点临时空白把它按住。
//
// 为什么需要：一块在"切片/渲染 box（高）"与"源码（矮）"之间切换时，**下方内容会整体上移**
// —— 光标所在位置虽然由 T1 的锚定钉住了，但视觉上"整段往上跳一截"仍然很明显
// （实测：独占单行的行间公式 49.66px → 24.2px，缩 25px；`frac(a,b)` 缩 14.6px）。
//
// **范围限制（报告 T4 明说）**：临时空白只能抑制"高渲染 → 矮源码"的收缩，**不能**消除
// 代码块 +94px / 表格 +83px 那种"源码比图高"的自然增长 —— 那种增长是真实内容，压它就得裁切
// 或嵌套滚动（两者都在报告里被明确拒绝）。所以这里只做**收缩方向**的补偿。
//
// 三条硬约束：
//  1. **上限 = 1 个编辑器可视高度**（`MAX_RESERVED_VIEWPORTS`）：超过就不补，只靠锚定。
//     否则一块超大公式（一页高分式）会在短文档里撑出半屏空白，用户会以为文档坏了；
//  2. **补的值不得超过进入时那个渲染盒的高度**：补偿是"把收缩按住"，不是"凭空加高度"；
//  3. **不累积**：这个函数是**无状态纯函数** —— 只要当前还处于"已展开 + 渲染盒更高"这个
//     状态就算一次，状态一变（收起/换块/文档换了/版心宽变了）自然归零。报告原本提的是
//     "会话对象 + 进出时挂/撤占位"，但无状态版本在**不会累积**这一点上更强（没有会话就
//     没有过期会话），而报告要求的另一条"改过内容就保持源码等新结果"已经由 T2 的
//     排版戳 + `stale` 负责。这是有意的简化，验收口径（20 次进出零累积、上限 1 屏）不变。
//
// 纯函数、可单测；装饰那一侧见 `math-decorations.ts` 的"已展开时补占位"。

/** 占位上限：1 个编辑器可视高度（超过就不补，见文件头第 1 条） */
export const MAX_RESERVED_VIEWPORTS = 1;

export interface EditReserveInput {
  /** 进入编辑前这一块的**渲染盒高度**（px）；量不到（还没渲过）给 0 */
  renderPx: number;
  /** 展开后**源码的自然高度**（px）：通常 = 源码行数 × 行高 */
  sourcePx: number;
  /** 编辑器可视高度（px）；量不到给 0（这时只按渲染盒封顶） */
  viewportPx: number;
}

export interface EditReservePlan {
  /** 要补的临时空白（px）；0 = 不需要补 */
  reservePx: number;
  /** 是否因为"超过一个可视高度"而少补了（诊断用；验收要能看见它） */
  cappedByViewport: boolean;
}

/**
 * 算这一次展开要补多少空白。**无状态**（见文件头第 3 条）：只由"渲染盒多高、源码多高、
 * 视口多高"决定，同样输入永远同样输出 —— 所以反复进出不会攒出越来越多空白。
 */
export function planEditReserve(input: EditReserveInput): EditReservePlan {
  const renderPx = Number.isFinite(input.renderPx) ? Math.max(0, input.renderPx) : 0;
  const sourcePx = Number.isFinite(input.sourcePx) ? Math.max(0, input.sourcePx) : 0;
  const viewportPx = Number.isFinite(input.viewportPx) ? Math.max(0, input.viewportPx) : 0;
  const deficit = renderPx - sourcePx;
  if (deficit <= 0) return { reservePx: 0, cappedByViewport: false };
  // 上限两条都要满足：不超过一个可视高度，也不超过进入时那个渲染盒
  const byViewport =
    viewportPx > 0 ? viewportPx * MAX_RESERVED_VIEWPORTS : Number.POSITIVE_INFINITY;
  const cap = Math.min(byViewport, renderPx);
  const reservePx = Math.min(deficit, cap);
  return { reservePx, cappedByViewport: reservePx < deficit };
}

/**
 * 一段源码在编辑器里大约占多高：**行数 × 行高**。
 * 展开后的每一行都是普通 `.cm-line`（行高一致），所以这个估计足够准；折行的长行会低估，
 * 但低估只会让占位少一点（更安全的方向）。
 */
export function sourceHeightPx(source: string, lineHeightPx: number): number {
  const lines = source.length === 0 ? 1 : source.split("\n").length;
  const lineHeight = Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 0;
  return lines * lineHeight;
}
