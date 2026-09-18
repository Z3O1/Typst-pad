// 版面矩形工具与「切一块渲成 SVG」的底层实现（crops 与 probe 共用）。
use super::*;

/// 把一个矩形区域从页里切出来单独渲成 SVG（阶段 1 的渲染路径原型）。
///
/// 做法：克隆原页（`Page: Clone`，字段全 pub）→ 把顶层项整体平移到以 `rect.min` 为原点 →
/// 帧尺寸设为矩形尺寸 → `typst_svg::svg` 导出。**视口即裁剪框**（与公式页同一原理，
/// 见 `typst_world/math.rs` 的 `ink_bounds_of_frame` 注释）。
pub(crate) fn render_crop(page: &Page, rect: Rect) -> String {
    let size = rect.size();
    let mut frame = Frame::new(size, FrameKind::Hard);
    // 只压入与切片相交的项：整页项全压会让 SVG 渲染器遍历整页内容，实测"逐块切片合计"
    // 反而比"整页渲一次"贵一个数量级（8 块 100ms vs 整页 17.6ms）。留 2pt 余量，
    // 因为 typst 允许把内容画到帧外（见 typst_world/math.rs 的 ink_bounds_of_frame）。
    let padded = Rect::new(
        Point::new(rect.min.x - Abs::pt(2.0), rect.min.y - Abs::pt(2.0)),
        Point::new(rect.max.x + Abs::pt(2.0), rect.max.y + Abs::pt(2.0)),
    );
    for (pos, item) in page.frame.items() {
        let shifted = Point::new(pos.x - rect.min.x, pos.y - rect.min.y);
        if !rects_intersect(item_box(*pos, item), padded) {
            continue;
        }
        frame.push(shifted, item.clone());
    }
    let mut cropped = page.clone();
    cropped.frame = frame;
    typst_svg::svg(&cropped, &SvgOptions::default())
}

/// 帧项的**近似**外接盒（本层坐标）：只用于"要不要把这一项压进切片"的粗筛，
/// 因此对 group 用它的帧尺寸而不去递归算墨迹（真正的几何由 `walk_frame` 负责）。
fn item_box(pos: Point, item: &FrameItem) -> Rect {
    match item {
        FrameItem::Text(t) => Rect::from_pos_size(
            Point::new(pos.x, pos.y - t.size),
            Size::new(t.width(), t.size),
        ),
        FrameItem::Shape(s, _) => {
            let bb = s.bbox(true);
            Rect::new(
                Point::new(pos.x + bb.min.x, pos.y + bb.min.y),
                Point::new(pos.x + bb.max.x, pos.y + bb.max.y),
            )
        }
        FrameItem::Image(_, size, _) | FrameItem::Link(_, size) => Rect::from_pos_size(pos, *size),
        FrameItem::Group(g) => Rect::from_pos_size(pos, g.frame.size()),
        FrameItem::Tag(_) => Rect::from_pos_size(pos, Size::zero()),
    }
}

pub(crate) fn rects_intersect(a: Rect, b: Rect) -> bool {
    a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y
}

