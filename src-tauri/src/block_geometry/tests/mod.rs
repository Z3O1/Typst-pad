// 整页命中复用的最近字形算法测试；真实编译见 document_geometry 与 typst_world/tests/paged。
use super::*;
fn item(page: usize, range: Range<usize>, x0: f64, y0: f64, x1: f64, y1: f64) -> PlacedItem {
    PlacedItem::new(
        page,
        range,
        Rect::new(
            Point::new(Abs::pt(x0), Abs::pt(y0)),
            Point::new(Abs::pt(x1), Abs::pt(y1)),
        ),
        y1,
        PlacedItemKind::Text,
        Transform::identity(),
    )
}
mod hit;
