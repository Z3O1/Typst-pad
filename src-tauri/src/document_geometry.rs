// 整页编译的交互几何。只读取已排版帧，不切片、不改变页面设置。
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use typst::layout::{Abs, Rect};

use crate::block_geometry::{pick_hit_item, PlacedItem};

struct Snapshot {
    id: u64,
    source_len: usize,
    items: Vec<PlacedItem>,
    foreign_ink: Vec<(usize, Rect)>,
}

// 按产物编号缓存，多个窗口不会覆盖彼此的最近产物；淘汰时拒绝交互而不是借用别人的几何。
static SNAPSHOTS: Mutex<VecDeque<Snapshot>> = Mutex::new(VecDeque::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_SNAPSHOTS: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCaret {
    pub offset: usize,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
    pub height_pt: f64,
    pub rotation_deg: f64,
}

pub fn store(items: Vec<PlacedItem>, source_len: usize, foreign_ink: Vec<(usize, Rect)>) -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut cache = SNAPSHOTS.lock().unwrap_or_else(|e| e.into_inner());
    cache.push_back(Snapshot {
        id,
        source_len,
        items,
        foreign_ink,
    });
    while cache.len() > MAX_SNAPSHOTS {
        cache.pop_front();
    }
    id
}

pub(crate) fn caret_for_item(item: &PlacedItem, offset: usize) -> DocumentCaret {
    let point = if offset <= item.range.start {
        item.caret_start
    } else {
        item.caret_end
    };
    DocumentCaret {
        offset,
        page: item.page,
        x_pt: point.x.to_pt(),
        y_pt: point.y.to_pt(),
        height_pt: item.caret_vector.hypot().to_pt().max(1.0),
        rotation_deg: (-item.caret_vector.x.to_pt())
            .atan2(item.caret_vector.y.to_pt())
            .to_degrees(),
    }
}

pub fn hit_test(id: u64, page: usize, x_pt: f64, y_pt: f64) -> Option<DocumentCaret> {
    if id == 0 || page == 0 || !x_pt.is_finite() || !y_pt.is_finite() {
        return None;
    }
    let cache = SNAPSHOTS.lock().ok()?;
    let snapshot = cache.iter().find(|s| s.id == id)?;
    let x = Abs::pt(x_pt);
    let y = Abs::pt(y_pt);
    // include 的偏移属于另一个文件；不能把外部输出误定位到附近的主文档文字。
    if snapshot.foreign_ink.iter().any(|(p, rect)| {
        *p == page && x >= rect.min.x && x <= rect.max.x && y >= rect.min.y && y <= rect.max.y
    }) {
        return None;
    }
    let (mut item, mut offset) =
        pick_hit_item(&snapshot.items, 0, snapshot.source_len, page, x, y)?;
    if y >= item.rect.min.y && y <= item.rect.max.y {
        return Some(caret_for_item(item, offset));
    }
    // 正文上/下方空白定位到本页视觉首/尾，不让点击的横坐标把光标放到行中。
    // 行间与行侧空白继续复用逐字几何；不生成空格，也不借用另一页的输出。
    let candidates = || {
        snapshot.items.iter().filter(|item| {
            item.page == page && item.range.start < snapshot.source_len && item.range.end > 0
        })
    };
    let top = candidates().min_by(|a, b| a.rect.min.y.to_pt().total_cmp(&b.rect.min.y.to_pt()))?;
    let bottom =
        candidates().max_by(|a, b| a.rect.max.y.to_pt().total_cmp(&b.rect.max.y.to_pt()))?;
    let edge = if y < top.rect.min.y {
        Some((top, false))
    } else if y > bottom.rect.max.y {
        Some((bottom, true))
    } else {
        None
    };
    if let Some((seed, at_end)) = edge {
        // 墨迹高低不同、上标/下标都会改变单字的纵向极值。先找首/尾墨迹，
        // 再在同一水平文字行中选择横向边界；非文字与旋转项保留自身的真实几何。
        let horizontal_text = |item: &PlacedItem| {
            item.kind == crate::block_geometry::PlacedItemKind::Text
                && (item.caret_end.y - item.caret_start.y).to_pt().abs() < 0.001
                && item.caret_vector.x.to_pt().abs() < 0.001
        };
        item = candidates()
            .filter(|candidate| {
                std::ptr::eq(*candidate, seed)
                    || (horizontal_text(seed)
                        && horizontal_text(candidate)
                        && ((candidate.baseline_pt - seed.baseline_pt).abs() < 0.5
                            || (candidate.rect.min.y < seed.rect.max.y
                                && candidate.rect.max.y > seed.rect.min.y)))
            })
            .min_by(|a, b| {
                if at_end {
                    b.rect.max.x.to_pt().total_cmp(&a.rect.max.x.to_pt())
                } else {
                    a.rect.min.x.to_pt().total_cmp(&b.rect.min.x.to_pt())
                }
                .then_with(|| a.range.len().cmp(&b.range.len()))
            })?;
        offset = if at_end {
            item.range.end.min(snapshot.source_len)
        } else {
            item.range.start
        };
    }
    Some(caret_for_item(item, offset))
}

pub fn locate(id: u64, offset: usize) -> Option<DocumentCaret> {
    let cache = SNAPSHOTS.lock().ok()?;
    let snapshot = cache.iter().find(|s| s.id == id)?;
    if offset > snapshot.source_len {
        return None;
    }
    let item = snapshot
        .items
        .iter()
        .filter(|item| offset >= item.range.start && offset < item.range.end)
        .min_by_key(|item| (item.kind, item.range.len()))
        .or_else(|| {
            snapshot
                .items
                .iter()
                .rev()
                .filter(|item| offset == item.range.end)
                .min_by_key(|item| (item.kind, item.range.len()))
        })?;
    Some(caret_for_item(item, offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst::layout::{Point, Rect};
    fn item(page: usize, from: usize, to: usize) -> PlacedItem {
        PlacedItem::new(
            page,
            from..to,
            Rect::new(
                Point::new(Abs::pt(20.0), Abs::pt(30.0)),
                Point::new(Abs::pt(30.0), Abs::pt(42.0)),
            ),
            40.0,
            crate::block_geometry::PlacedItemKind::Text,
            typst::layout::Transform::identity(),
        )
    }
    #[test]
    fn whitespace_hits_line_edges_and_page_visual_edges_without_changing_source() {
        let make = |from, to, x, y| {
            PlacedItem::new(
                1,
                from..to,
                Rect::new(
                    Point::new(Abs::pt(x), Abs::pt(y)),
                    Point::new(Abs::pt(x + 10.0), Abs::pt(y + 12.0)),
                ),
                y + 10.0,
                crate::block_geometry::PlacedItemKind::Text,
                typst::layout::Transform::identity(),
            )
        };
        // 打乱收集顺序，视觉首尾不能依赖源码顺序或点击的横坐标。
        let id = store(
            vec![
                make(6, 9, 30.0, 60.0),
                make(3, 6, 30.0, 30.0),
                make(9, 12, 40.0, 60.0),
                make(0, 3, 20.0, 30.0),
            ],
            12,
            vec![],
        );
        for (x, y, offset) in [
            (0.0, 35.0, 0),    // 左侧空白 → 此行行首
            (200.0, 35.0, 6),  // 右侧空白 → 此行行尾（不是文档尾）
            (0.0, 65.0, 6),    // 第二行行首
            (200.0, 65.0, 12), // 第二行行尾
            (200.0, 0.0, 0),   // 上方空白 → 首字符之前
            (0.0, 200.0, 12),  // 下方空白 → 末字符之后
            (200.0, 45.0, 6),  // 行间空白靠近上一行
            (0.0, 55.0, 6),    // 行间空白靠近下一行
        ] {
            let hit = hit_test(id, 1, x, y).unwrap();
            assert_eq!(hit.offset, offset, "({x}, {y})");
            assert_eq!(hit.page, 1);
            assert_eq!(hit.height_pt, 12.0);
        }
        assert!(hit_test(id, 2, 20.0, 30.0).is_none());
        let empty = store(vec![], 0, vec![]);
        assert!(hit_test(empty, 1, 200.0, 200.0).is_none());
        assert!(locate(empty, 0).is_none());
    }

    #[test]
    fn full_page_hit_and_cursor_keep_compilation_identity() {
        let first = store(vec![item(2, 3, 6)], 9, vec![]);
        let second = store(vec![item(1, 0, 1)], 1, vec![]);
        assert_ne!(first, second);
        let hit = hit_test(first, 2, 29.0, 35.0).unwrap();
        assert_eq!(hit.offset, 6);
        assert_eq!(hit.page, 2);
        assert_eq!(hit.x_pt, 30.0);
        assert_eq!(locate(first, 3).unwrap().x_pt, 20.0);
        assert!(hit_test(first, 1, 20.0, 35.0).is_none());
        assert!(locate(second, 6).is_none());
        assert!(hit_test(first, 2, f64::NAN, 35.0).is_none());
        assert!(hit_test(0, 2, 20.0, 35.0).is_none());
        let foreign = item(2, 0, 1).rect;
        let included = store(vec![item(2, 3, 6)], 9, vec![(2, foreign)]);
        assert!(hit_test(included, 2, 29.0, 35.0).is_none());
    }
}
