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
// 两条纪律：
//  1. **选区与滚动目标必须在同一个事务里**。分两次 `dispatch` 会出现"先跳一下再修正"，
//     而且第二次会被 CodeMirror 自己的 measure 覆盖（见 scroll-anchor.ts 的实测说明）；
//  2. `preventDefault` 不在这里做 —— 它属于各自的事件语义（链接热区的 mousedown 只
//     preventDefault、不移动光标，见 widgets.ts 的 addLinkHotspots）。
import type { EditorView } from "@codemirror/view";
import { anchorPosEffect } from "../scroll-anchor";

/**
 * 把 `pos` 变成当前选区，并在同一事务里要求 CodeMirror 把这一行钉在鼠标点的高度上。
 *
 * `clientY` 传鼠标事件的 `clientY`（视口坐标）：`anchorPosEffect` 内部按"行盒中心落在该
 * 高度"换算成它自己的 yMargin。拿不到滚动容器（视图未挂载）时只落选区 —— 不比改之前差。
 *
 * `pos` 会先夹进当前文档：widget 是**可复用**的 DOM，文档在两次渲染之间被改动时，
 * 旧区间可能已经越界（越界的 dispatch 会抛 RangeError，把这次点击整条打断）。
 */
export function revealSourceAt(view: EditorView, pos: number, clientY: number): void {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
  const pin = anchorPosEffect(view, clamped, clientY, "center");
  view.dispatch(
    pin ? { selection: { anchor: clamped }, effects: pin } : { selection: { anchor: clamped } },
  );
}
