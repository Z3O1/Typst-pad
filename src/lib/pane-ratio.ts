// 分栏比例纯逻辑（**Ctrl+Shift+滚轮** 调整源代码模式右侧预览区的宽度）。
//
// 为什么不直接改像素宽度而是存"比例"：窗口大小会变，存比例才能在窗口缩放 / 分栏切换后
// 仍然保持"预览区占多少"这个意图；像素宽度一旦窗口变小就可能把编辑区挤没。
// 比例 = **预览区**占分栏容器的宽度份额（0.25 ~ 0.75），编辑区拿剩下的。

/** 默认 50/50 */
export const PANE_RATIO_DEFAULT = 0.5;
/** 下限：预览再窄也看得见（编辑区永远 ≥ 25%） */
export const PANE_RATIO_MIN = 0.25;
/** 上限：编辑区再窄也写得下（预览区永远 ≤ 75%） */
export const PANE_RATIO_MAX = 0.75;
/** 鼠标滚轮一档的比例变化（2 个百分点） */
export const PANE_RATIO_STEP = 0.02;

/** 归一化后的比例（非法值回落到默认值，超界收敛到上下限） */
export function clampPaneRatio(
  ratio: number | null | undefined,
  min: number = PANE_RATIO_MIN,
  max: number = PANE_RATIO_MAX,
): number {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return PANE_RATIO_DEFAULT;
  return Math.min(max, Math.max(min, ratio));
}

/**
 * 一次滚轮事件该走几档（0.2 ~ 3）。
 * 三种 deltaMode 的"一格"差别很大，分开处理：
 * - 行模式（deltaMode=1）：一格算一档；
 * - 页模式（deltaMode=2）：直接给 3 档（翻页本来就是大动作）；
 * - 像素模式（deltaMode=0）：Chromium/WebView2 鼠标一格 ≈ 100，按此折算取整（≥ 50 才算整档，
 *   免得 60/120 这类值给出半档的怪手感）；< 50 视为触摸板的小步长，按比例给，下限 0.2 档
 *   —— 触摸板会连发很小的 delta，若每个事件都算满一档，手指一划预览区就会窜到底。
 */
function wheelMagnitude(deltaY: number, deltaMode: number): number {
  const abs = Math.abs(deltaY);
  if (deltaMode === 1) return Math.min(3, Math.max(1, abs));
  if (deltaMode === 2) return 3;
  if (abs >= 50) return Math.min(3, Math.max(1, Math.round(abs / 100)));
  return Math.max(0.2, abs / 100);
}

/**
 * 下一档比例：**滚轮向上 = 预览区变宽**（向上"放大"预览，与大多数分栏拖动方向一致）。
 * deltaY 为 0 / 非法时原样返回（不动）。
 */
export function nextPaneRatio(
  current: number | null | undefined,
  deltaY: number,
  deltaMode = 0,
  step: number = PANE_RATIO_STEP,
): number {
  const base = clampPaneRatio(current);
  if (typeof deltaY !== "number" || !Number.isFinite(deltaY) || deltaY === 0) return base;
  const direction = deltaY < 0 ? 1 : -1;
  return clampPaneRatio(base + direction * wheelMagnitude(deltaY, deltaMode) * step);
}

/** 比例 → 整数百分比（状态栏文案与菜单标签用） */
export function paneRatioPercent(ratio: number | null | undefined): number {
  return Math.round(clampPaneRatio(ratio) * 100);
}

/**
 * 预览栏的内联样式：`flex: 0 0 N%`（固定基准宽度，编辑区的 `flex: 1` 拿剩下的）。
 * 用 flex-basis 而不是 width，是为了让两个 pane 的 flex 布局规则保持一致。
 */
export function paneRatioFlexStyle(ratio: number | null | undefined): string {
  return `flex: 0 0 ${paneRatioPercent(ratio)}%`;
}
