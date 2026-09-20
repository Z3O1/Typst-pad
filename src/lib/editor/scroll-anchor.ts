// 写作模式的**滚动锚定**（阶段 2）：内容高度变了之后，把"用户正在看的那一行"留在原来的屏幕高度。
//
// 背景：写作模式里，一块在"切片（图片，真排版的高度）"与"源码（编辑器行高）"之间反复切换 ——
// 加上窗口化补渲（滚动到没渲过的区域 → 去抖 150ms 后重编译 → 那几块从源码变成切片）、
// 公式结果到货、编译失败后块表重排，**光标或视口附近**的内容高度随时会变。
//
// **不要自己写 `scrollDOM.scrollTop = …`**（第一版就是那么写的，实测被 CodeMirror 的
// measure 循环覆盖掉）：CM 自己也有滚动锚定（measure 里的 anchor diff），它会在我们的写之后
// 再改一次 scrollTop（实测：我们设了 1771，它又拉回 1680 —— 两次修正叠加，反而偏了 91px）。
// 正确做法是**把"光标该落在屏幕哪个高度"表达成它自己的滚动目标**：
// `EditorView.scrollIntoView(pos, { y: "start", yMargin })`（yMargin = 光标**行盒顶部**距
// 滚动容器顶部的像素）—— 这样它会在同一个测量循环里、按最终布局一次算准，并且自动重设它自己的
// 锚点（`scrollAnchorHeight = -1`），不会再叠加第二次修正。
// 见 @codemirror/view 的 ViewState.scrollIntoView / scrollRectIntoView 与 measure 循环。
import { EditorSelection } from "@codemirror/state";
import type { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorView as View } from "@codemirror/view";

/** "钉住"的两种参照：行盒顶部 / 行盒中心（点击定位用中心更接近"字还在鼠标底下"） */
export type AnchorMode = "top" | "center";

/**
 * 算出 `scrollIntoView` 的 yMargin（纯函数，可单测）：让光标所在行的**顶部**落在
 * 距滚动容器顶部 `yMargin` 像素处，等价于"行盒中心落在 `targetClientY`"（mode = "center"）。
 *
 * 夹在 `[0, 视口高 - 1]` 内：负数或超出视口的余量没有意义（CM 自己也会夹，
 * 但夹在这里便于断言与排查）。视口高度不可测时返回 0（= 顶到最上面，最保守）。
 */
export function anchorYMargin(
  targetClientY: number,
  scrollerTop: number,
  scrollerHeight: number,
  lineHeight: number,
  mode: AnchorMode = "top",
): number {
  if (!Number.isFinite(targetClientY) || !Number.isFinite(scrollerTop)) return 0;
  const half = mode === "center" && Number.isFinite(lineHeight) ? lineHeight / 2 : 0;
  const raw = targetClientY - scrollerTop - half;
  const max = Number.isFinite(scrollerHeight) && scrollerHeight > 0 ? scrollerHeight - 1 : 0;
  return Math.max(0, Math.min(max, raw));
}

/**
 * "把 `pos` 钉在屏幕的某个高度"的滚动目标（放进 `view.dispatch({ effects })` 里，
 * **与选区变更同一个事务**：这样 CM 的测量循环一次算准，不会出现"先跳一下再修正"）。
 *
 * 拿不到滚动容器（视图未挂载）时返回 null，调用方照常只落选区。
 */
export function anchorPosEffect(
  view: View,
  pos: number,
  targetClientY: number,
  mode: AnchorMode = "top",
): StateEffect<unknown> | null {
  try {
    const scroller = view.scrollDOM;
    const box = scroller.getBoundingClientRect();
    const yMargin = anchorYMargin(targetClientY, box.top, box.height, view.defaultLineHeight, mode);
    return EditorView.scrollIntoView(EditorSelection.cursor(pos), { y: "start", yMargin });
  } catch {
    return null;
  }
}
