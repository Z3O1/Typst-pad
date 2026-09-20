// 写作模式的**点击定位**（阶段 2）：切片上的一个点 → 页面坐标（pt）→（Rust 侧命中测试）→
// 源码字节偏移 → CodeMirror 位置。
//
// 为什么坐标要这么绕：切片是一张 SVG 图片，DOM 里**没有**任何字符位置；能回答"这个点对应哪个
// 字符"的只有排版引擎的帧（每个字形自带 `Span` + 自己的矩形，见 src-tauri/src/block_geometry/
// collect.rs 的 `walk_frame`）。所以链路是：
//
//   ① 切片自己：`BlockCrop` 给了裁剪带在页面上的位置与尺寸（`x_pt` / `y_pt` / `width_pt` /
//      `height_pt`），而 SVG 的坐标系原点就是裁剪带的左上角、画布就是带的尺寸 ⇒
//      "切片里的相对位置"与"带内的 pt 偏移"是**线性对应**的；
//   ② 浏览器侧的换算只看 DOM 实测矩形（`getBoundingClientRect`），不假设任何缩放比例
//      （列宽、界面缩放、窗口尺寸都不参与）；
//   ③ Rust 侧 `block_hit_test` 在**页面坐标**里找最近的字形，返回文档字节偏移；
//   ④ 字节 → UTF-16 位置由 block-offsets 负责（CJK 3 字节 / emoji 4 字节，直接当位置用会错位）。
//
// 本模块只做 ① 与"把往返结果钳回块内"这两件纯事，可单测。

/** 裁剪带在页面上的几何 + 它覆盖的源码区间（`Block` 结构上满足它） */
export interface CropGeometry {
  /** 切片所在页（1-based，与 Rust 侧同一口径） */
  page: number;
  /** 裁剪带左缘 / 上缘（pt，页面坐标） */
  xPt: number;
  yPt: number;
  /** 裁剪带尺寸（pt）—— 也是 SVG 的 viewBox 尺寸 */
  widthPt: number;
  heightPt: number;
  /** 该块的源码范围（CodeMirror 位置） */
  from: number;
  to: number;
}

/** 切片在视口里的矩形（`getBoundingClientRect` 的子集） */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 命中测试的入参（页面坐标，pt） */
export interface HitPoint {
  page: number;
  xPt: number;
  yPt: number;
}

/** 该块的**字节**范围（Rust 侧命中测试的坐标系，注意不是 CodeMirror 位置） */
export interface ByteRange {
  /** 块首字节偏移 */
  fromByte: number;
  /** 块尾字节偏移（独占） */
  toByte: number;
}

/**
 * 视口坐标的一次点击 → **页面坐标**（pt）。
 *
 * 换算全用 DOM 实测的矩形：`fx = (clientX - rect.left) / rect.width`，
 * 再乘回裁剪带自己的 pt 宽度。这样"切片被显示成多宽"（列宽、界面缩放、暗色反色）
 * 都不影响结果，也不需要前端知道页边距是多少。
 *
 * 退化情形返回 null（调用方退回"光标落到块首"的老行为）：矩形没有面积（还没布局完）、
 * 带尺寸非正、坐标非有限数、点在矩形外（拖动越界）。
 */
export function cropPagePoint(
  rect: CropRect,
  client: { x: number; y: number },
  crop: CropGeometry,
): HitPoint | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(crop.widthPt > 0) || !(crop.heightPt > 0)) return null;
  const fx = (client.x - rect.left) / rect.width;
  const fy = (client.y - rect.top) / rect.height;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  // 点在矩形外（按下后拖出去）：夹回边界，等价于"点在这一侧"
  const cx = Math.min(1, Math.max(0, fx));
  const cy = Math.min(1, Math.max(0, fy));
  return {
    page: crop.page,
    xPt: crop.xPt + crop.widthPt * cx,
    yPt: crop.yPt + crop.heightPt * cy,
  };
}

/**
 * 命中结果钳回被点的那个块（防御性：Rust 侧已经钳过一遍，这里再钳一次是因为
 * 缓存里的几何与当前块表**可能不是同一次编译**，偏移漂出块外时宁可退回块内）。
 *
 * 单位是**字节偏移**（与 `block_hit_test` 的出入参一致）。传入 null / 非法值 → null
 * （调用方退回"光标落到块首"的老行为）。
 */
export function clampHitOffset(offset: number | null | undefined, block: ByteRange): number | null {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return null;
  const value = Math.round(offset);
  if (value < block.fromByte) return block.fromByte;
  if (value > block.toByte) return block.toByte;
  return value;
}
