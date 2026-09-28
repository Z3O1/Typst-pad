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
    let (item, offset) = pick_hit_item(&snapshot.items, 0, snapshot.source_len, page, x, y)?;
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
