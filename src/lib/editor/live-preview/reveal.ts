// widget 上"点一下就回到源码"的**统一入口**（报告 T1 / V2）。
//
// 背景：三个 widget（行内公式 `MathWidget`、行间公式 `MathBlockWidget`、围栏代码块
// `CodeBlockWidget`）各自挂了一个 mousedown，都只 `dispatch({ selection })` 就完事 ——
// 选区确实进了源码，但**滚动目标没表达**。于是"点哪儿、字就落在哪儿"只成立一半：
// 块切片（`BlockCropWidget`）走的是 CodeMirror 的 `mouseSelectionStyle`，那条路早就在
// **同一个事务**里给了 `anchorPosEffect`（见 block-drag.ts），而这三个 widget 没有。
// 实测（scripts/browser-check/writing-stability.mjs）：点击单行行间公式后，光标行盒中心
// 偏离鼠标点 10~11px；同一篇文档里点块切片只有 3.5~4px。
//
// 三条纪律：
//  1. **选区与滚动目标必须在同一个事务里**。分两次 `dispatch` 会出现"先跳一下再修正"，
//     而且第二次会被 CodeMirror 自己的 measure 覆盖（见 scroll-anchor.ts 的实测说明）；
//  2. `preventDefault` 不在这里做 —— 它属于各自的事件语义（链接热区的 mousedown 只
//     preventDefault、不移动光标，见 widgets.ts 的 addLinkHotspots）；
//  3. **高块 widget 不能照搬"把首行钉到鼠标处"**（见 `shouldPin` 的说明）。
import type { EditorView } from "@codemirror/view";
import { anchorPosEffect } from "../scroll-anchor";

export interface RevealAnchorOptions {
  /** 被点 widget 的顶边（`getBoundingClientRect().top`）：用来判断"点的是不是它的第一行" */
  widgetTop?: number;
  /** 鼠标键（`MouseEvent.button`）：只有左键才钉（右键/中键不该动视图） */
  button?: number;
}

/**
 * 这一次点击该不该要滚动目标。
 *
 * **高块 widget（几十行的围栏代码、跨行行间公式）是例外**：选区只能落在块首（没有命中测试，
 * 点不出"块内第几行"），而把**块首那一行**钉到鼠标处，等价于让视图向上滚整个块的高度
 *（`y:"start"` 是绝对定位：`scrollTop = 行内容 y − yMargin`）——算式为负时被浏览器夹到 0，
 * 用户看到的是**点一下代码块，页面直接跳到文档顶部**（实测构造：文首正文 + 30 行代码块，
 * 下滚 100px 后点块的中下部）。所以只有"点在第一行上"时才钉；点在中间/下部时退回"只落选区"，
 * 视图交给 CodeMirror 自己的锚定（与改这一版之前一样稳）。
 *
 * 单行 widget（行内公式、独占单行的行间公式）没有这个问题：它们的首行就是用户点的那一行。
 */
function shouldPin(view: EditorView, clientY: number, opts: RevealAnchorOptions): boolean {
  if (opts.button !== undefined && opts.button !== 0) return false;
  if (opts.widgetTop === undefined) return true;
  const lineHeight = view.defaultLineHeight > 0 ? view.defaultLineHeight : 24;
  return clientY - opts.widgetTop <= lineHeight * 1.5;
}

/**
 * 把 `pos` 变成当前选区，并在同一事务里要求 CodeMirror 把这一行钉在鼠标点的高度上。
 *
 * `clientY` 传鼠标事件的 `clientY`（视口坐标）：`anchorPosEffect` 内部按"行盒中心落在该
 * 高度"换算成它自己的 yMargin。拿不到滚动容器（视图未挂载）时只落选区 —— 不比改之前差。
 *
 * `pos` 会先夹进当前文档：widget 是**可复用**的 DOM，文档在两次渲染之间被改动时，
 * 旧区间可能已经越界（越界的 dispatch 会抛 RangeError，把这次点击整条打断）。
 */
export function revealSourceAt(
  view: EditorView,
  pos: number,
  clientY: number,
  opts: RevealAnchorOptions = {},
): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  const pin = shouldPin(view, clientY, opts)
    ? anchorPosEffect(view, clamped, clientY, "center")
    : null;
  view.dispatch(
    pin ? { selection: { anchor: clamped }, effects: pin } : { selection: { anchor: clamped } },
  );
}
