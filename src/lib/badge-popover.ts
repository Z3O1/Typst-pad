// 状态栏两个计数徽标（错误 / 警告）的浮层状态机（从 +page.svelte 原样搬出来，行为零改动）。
//
// 红线：**两个徽标共用一份状态、行为只写一遍**（用户 2026-09-18 反馈：「点击警告 / 关闭警告的
// 行为应该和错误是一样的」——当时警告侧少了 Esc、点外部关闭、点条目跳转即关、视口收边四条）。
// 别再退回 `showErrors` + `showWarnings` 两套状态：那正是"警告侧只有一半行为"的来源。

import { hasErrorToShow } from "./error-list";

export type BadgeKind = "errors" | "warnings";
/** "none" = 两个浮层都关着；同一时刻只会开一个 */
export type BadgePopoverState = "none" | BadgeKind;

/** 视口收边结果（打开瞬间算一次）：transform 平移量 + 可选限宽 */
export interface PopoverClamp {
  translateX: number;
  translateY: number;
  maxWidth: number;
}

/** 点徽标 / Enter：开这个、并顺手把另一个关掉（两个徽标共用一份状态 ⇒ 一次只开一个） */
export function nextBadgePopover(
  current: BadgePopoverState,
  kind: BadgeKind,
): BadgePopoverState {
  return current === kind ? "none" : kind;
}

/** 错误浮层是否可见（开着 + 确实有内容）。有内容才让浮层存在：空浮层（只有标题）没意义 */
export function errorPopoverVisible(
  state: BadgePopoverState,
  errorCount: number,
  lastNonPosError: string | null,
): boolean {
  return state === "errors" && hasErrorToShow(errorCount, lastNonPosError);
}

/** 警告浮层是否可见（同上）：警告只要有条数就算有内容 */
export function warningPopoverVisible(state: BadgePopoverState, warningCount: number): boolean {
  return state === "warnings" && warningCount > 0;
}

/** 两个浮层共用的收边内联样式（打开瞬间由页面的 $effect 算一次） */
export function badgePopoverStyle(clamp: PopoverClamp): string {
  const { translateX, translateY, maxWidth } = clamp;
  return `transform: translate(${translateX}px, ${translateY}px);${
    maxWidth > 0 ? `max-width:${maxWidth}px` : ""
  }`;
}
