// 整页编译的交互几何。只读取已排版帧，不切片、不改变页面设置。
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use typst::layout::{Abs, Rect};

use crate::block_geometry::{pick_hit_item, PlacedItem, PlacedItemKind};

struct Snapshot {
    id: u64,
    #[cfg(test)]
    test_owner: std::thread::ThreadId,
    source_len: usize,
    items: Vec<PlacedItem>,
    // 同一页通常连续；不连续的探针也保留原顺序，用包围区间并由命中规则过滤。
    pages: HashMap<usize, std::ops::Range<usize>>,
    source_order: Vec<usize>,
    max_end: Vec<usize>,
    end_order: Vec<usize>,
    foreign_ink: Vec<(usize, Rect)>,
    formulas: Vec<PlacedItem>,
}

impl Snapshot {
    fn page_items(&self, page: usize) -> &[PlacedItem] {
        self.pages
            .get(&page)
            .map_or(&[], |range| &self.items[range.clone()])
    }
}

// 按产物编号缓存，多个窗口不会覆盖彼此的最近产物；淘汰时拒绝交互而不是借用别人的几何。
static SNAPSHOTS: Mutex<VecDeque<Snapshot>> = Mutex::new(VecDeque::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const MAX_SNAPSHOTS: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCaret {
    pub offset: usize,
    pub page: usize,
    pub x_pt: f64,
    pub y_pt: f64,
    pub height_pt: f64,
    pub rotation_deg: f64,
    // 只有点击命中携带此标记；源码光标查询不带点击意图。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_whitespace: Option<bool>,
}

pub fn store(items: Vec<PlacedItem>, source_len: usize, foreign_ink: Vec<(usize, Rect)>) -> u64 {
    let (formulas, items): (Vec<_>, Vec<_>) = items
        .into_iter()
        .partition(|item| item.kind == PlacedItemKind::Formula);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let mut pages: HashMap<usize, std::ops::Range<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        pages
            .entry(item.page)
            .and_modify(|range| range.end = index + 1)
            .or_insert(index..index + 1);
    }
    let mut source_order: Vec<_> = (0..items.len()).collect();
    source_order.sort_by_key(|&i| items[i].range.start);
    let mut end = 0;
    let max_end = source_order
        .iter()
        .map(|&i| {
            end = end.max(items[i].range.end);
            end
        })
        .collect();
    let mut end_order: Vec<_> = (0..items.len()).collect();
    end_order.sort_by_key(|&i| items[i].range.end);
    // 建索引不持全局缓存锁，避免阻塞其他窗口的命中。
    let snapshot = Snapshot {
        id,
        #[cfg(test)]
        test_owner: std::thread::current().id(),
        source_len,
        items,
        pages,
        source_order,
        max_end,
        end_order,
        foreign_ink,
        formulas,
    };
    let mut cache = SNAPSHOTS.lock().unwrap_or_else(|e| e.into_inner());
    cache.push_back(snapshot);
    #[cfg(not(test))]
    while cache.len() > MAX_SNAPSHOTS {
        cache.pop_front();
    }
    // Rust 单测并行运行：按测试线程隔离淘汰，避免其他用例的编译
    // 抢占当前用例仍需验证的快照；每个用例仍使用相同的 16 份上限。
    #[cfg(test)]
    {
        let owner = std::thread::current().id();
        while cache
            .iter()
            .filter(|snapshot| snapshot.test_owner == owner)
            .count()
            > MAX_SNAPSHOTS
        {
            let index = cache
                .iter()
                .position(|snapshot| snapshot.test_owner == owner)
                .unwrap();
            cache.remove(index);
        }
    }
    id
}

pub(crate) fn caret_for_item(item: &PlacedItem, offset: usize) -> DocumentCaret {
    let point = item.caret_at(offset);
    DocumentCaret {
        offset,
        page: item.page,
        x_pt: point.x.to_pt(),
        y_pt: point.y.to_pt(),
        height_pt: item.caret_vector.hypot().to_pt().max(1.0),
        rotation_deg: (-item.caret_vector.x.to_pt())
            .atan2(item.caret_vector.y.to_pt())
            .to_degrees(),
        is_whitespace: None,
    }
}

fn hit_for_item(item: &PlacedItem, offset: usize, is_whitespace: bool) -> DocumentCaret {
    let mut caret = caret_for_item(item, offset);
    caret.is_whitespace = Some(is_whitespace);
    caret
}

fn text_in_rect(snapshot: &Snapshot, page: usize, rect: Rect) -> impl Iterator<Item = &PlacedItem> {
    snapshot.page_items(page).iter().filter(move |candidate| {
        candidate.page == page
            && candidate.kind == PlacedItemKind::Text
            && candidate.range.start < snapshot.source_len
            && candidate.range.end > 0
            && candidate.rect.min.x >= rect.min.x
            && candidate.rect.max.x <= rect.max.x
            && candidate.rect.min.y >= rect.min.y
            && candidate.rect.max.y <= rect.max.y
    })
}

fn axis_gap(min: Abs, max: Abs, value: Abs) -> f64 {
    (min - value).max(value - max).max(Abs::zero()).to_pt()
}

fn horizontal_text(item: &PlacedItem) -> bool {
    item.kind == PlacedItemKind::Text
        && (item.caret_end.y - item.caret_start.y).to_pt().abs() < 0.001
        && item.caret_vector.x.to_pt().abs() < 0.001
}

fn same_text_row(a: &PlacedItem, b: &PlacedItem) -> bool {
    horizontal_text(a)
        && horizontal_text(b)
        && ((a.baseline_pt - b.baseline_pt).abs() < 0.5
            || (a.rect.min.y < b.rect.max.y && a.rect.max.y > b.rect.min.y))
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
    // 字形没有源码（合成符号、分式线）或点中公式内部留白时，仍按真实公式帧展开。
    if let Some(formula) = snapshot
        .formulas
        .iter()
        .filter(|f| {
            f.page == page
                && x >= f.rect.min.x
                && x <= f.rect.max.x
                && y >= f.rect.min.y
                && y <= f.rect.max.y
        })
        .min_by_key(|f| f.range.len())
    {
        let (item, offset) = pick_hit_item(
            snapshot.page_items(page),
            formula.range.start,
            formula.range.end,
            page,
            x,
            y,
        )
        .unwrap_or((formula, formula.range.start + 1));
        return Some(hit_for_item(
            item,
            offset.clamp(
                formula.range.start + 1,
                formula
                    .range
                    .end
                    .saturating_sub(1)
                    .max(formula.range.start + 1),
            ),
            false,
        ));
    }
    let (mut item, mut offset) = pick_hit_item(
        snapshot.page_items(page),
        0,
        snapshot.source_len,
        page,
        x,
        y,
    )?;
    // 带填充的文字块在字外仍能命中背景 Shape；应按它包围的正文定位，
    // 不能把背景空白误当作点击宏定义。独立图形/图片仍保留直接命中行为。
    if item.kind == PlacedItemKind::Shape {
        let background = item.rect;
        let text = text_in_rect(snapshot, page, background).min_by(|a, b| {
            axis_gap(a.rect.min.y, a.rect.max.y, y)
                .total_cmp(&axis_gap(b.rect.min.y, b.rect.max.y, y))
                .then_with(|| {
                    axis_gap(a.rect.min.x, a.rect.max.x, x).total_cmp(&axis_gap(
                        b.rect.min.x,
                        b.rect.max.x,
                        x,
                    ))
                })
                .then_with(|| a.range.len().cmp(&b.range.len()))
        });
        if let Some(text) = text {
            (item, offset) = pick_hit_item(
                std::slice::from_ref(text),
                0,
                snapshot.source_len,
                page,
                x,
                y,
            )?;
        }
    }
    if x >= item.rect.min.x && x <= item.rect.max.x && y >= item.rect.min.y && y <= item.rect.max.y
    {
        return Some(hit_for_item(item, offset, false));
    }
    // 空白先选行，再在该行选横向位置，避免行侧点击被高字/上标吸走。
    // 页首/尾空白仍落到首/尾行边界，不生成空格，也不借用另一页的输出。
    let candidates = || {
        snapshot.page_items(page).iter().filter(|item| {
            item.page == page && item.range.start < snapshot.source_len && item.range.end > 0
        })
    };
    let input_rect = item.hit_rect();
    let edge = if y >= input_rect.min.y && y <= input_rect.max.y {
        None
    } else {
        let top = candidates().min_by(|a, b| {
            a.hit_rect()
                .min
                .y
                .to_pt()
                .total_cmp(&b.hit_rect().min.y.to_pt())
        })?;
        let bottom = candidates().max_by(|a, b| {
            a.hit_rect()
                .max
                .y
                .to_pt()
                .total_cmp(&b.hit_rect().max.y.to_pt())
        })?;
        if y < top.hit_rect().min.y {
            Some((top, false))
        } else if y > bottom.hit_rect().max.y {
            Some((bottom, true))
        } else {
            None
        }
    };
    let (seed, at_end) = edge.map_or((item, None), |(seed, end)| (seed, Some(end)));
    // 页首尾也忽略正文背景的声明 span，保持光标落在实际显示的内容里。
    let seed = if seed.kind == PlacedItemKind::Shape && at_end.is_some() {
        text_in_rect(snapshot, page, seed.rect)
            .min_by(|a, b| {
                if at_end == Some(true) {
                    b.rect.max.y.to_pt().total_cmp(&a.rect.max.y.to_pt())
                } else {
                    a.rect.min.y.to_pt().total_cmp(&b.rect.min.y.to_pt())
                }
            })
            .unwrap_or(seed)
    } else {
        seed
    };
    let horizontal_gap = |item: &PlacedItem| axis_gap(item.rect.min.x, item.rect.max.x, x);
    item = candidates()
        .filter(|candidate| std::ptr::eq(*candidate, seed) || same_text_row(seed, candidate))
        .min_by(|a, b| {
            match at_end {
                Some(true) => b.rect.max.x.to_pt().total_cmp(&a.rect.max.x.to_pt()),
                Some(false) => a.rect.min.x.to_pt().total_cmp(&b.rect.min.x.to_pt()),
                None => horizontal_gap(a).total_cmp(&horizontal_gap(b)),
            }
            .then_with(|| a.range.len().cmp(&b.range.len()))
        })?;
    offset = match at_end {
        Some(true) => item.range.end.min(snapshot.source_len),
        Some(false) => item.range.start,
        None => {
            pick_hit_item(
                std::slice::from_ref(item),
                0,
                snapshot.source_len,
                page,
                x,
                y,
            )?
            .1
        }
    };
    Some(hit_for_item(item, offset, true))
}

/// 编译源码选区对应的真实帧四边形，保留旋转、缩放和重复宏输出。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSelectionQuad {
    pub from: usize,
    pub to: usize,
    pub page: usize,
    pub points: [[f64; 2]; 4],
}

pub fn selection(id: u64, from: usize, to: usize) -> Vec<DocumentSelectionQuad> {
    let Ok(cache) = SNAPSHOTS.lock() else {
        return vec![];
    };
    let Some(snapshot) = cache.iter().find(|s| s.id == id) else {
        return vec![];
    };
    let (from, to) = (from.min(to), from.max(to));
    if from == to || to > snapshot.source_len {
        return vec![];
    }
    let upper = snapshot
        .source_order
        .partition_point(|&i| snapshot.items[i].range.start < to);
    let lower = snapshot.max_end[..upper].partition_point(|&end| end <= from);
    snapshot.source_order[lower..upper]
        .iter()
        .map(|&i| &snapshot.items[i])
        .filter(|item| item.range.end > from && item.range.start < item.range.end)
        // 正文的背景不能盖住整个块；独立图形和图片仍可选择。
        .filter(|item| {
            item.kind != PlacedItemKind::Shape
                || text_in_rect(snapshot, item.page, item.rect)
                    .next()
                    .is_none()
        })
        .map(|item| {
            let from = from.max(item.range.start);
            let to = to.min(item.range.end);
            // 只有连字存在可分割的内部输出；图片、图形和单字素仍是原子选区。
            let (start, end) = if item.caret_stops.is_some() {
                (item.caret_at(from), item.caret_at(to))
            } else {
                (item.caret_start, item.caret_end)
            };
            let corners = [
                start,
                end,
                end + item.caret_vector,
                start + item.caret_vector,
            ];
            DocumentSelectionQuad {
                from,
                to,
                page: item.page,
                points: corners.map(|point| [point.x.to_pt(), point.y.to_pt()]),
            }
        })
        .collect()
}

pub fn locate(id: u64, offset: usize) -> Option<DocumentCaret> {
    let cache = SNAPSHOTS.lock().ok()?;
    let snapshot = cache.iter().find(|s| s.id == id)?;
    locate_in_snapshot(snapshot, offset)
}

fn locate_in_snapshot(snapshot: &Snapshot, offset: usize) -> Option<DocumentCaret> {
    if offset > snapshot.source_len {
        return None;
    }
    let upper = snapshot
        .source_order
        .partition_point(|&i| snapshot.items[i].range.start <= offset);
    let lower = snapshot.max_end[..upper].partition_point(|&end| end <= offset);
    let index = snapshot.source_order[lower..upper]
        .iter()
        .copied()
        .filter(|&i| offset < snapshot.items[i].range.end)
        // 保留原来同类同范围时的帧遍历优先序。
        .min_by_key(|&i| (snapshot.items[i].kind, snapshot.items[i].range.len(), i))
        .or_else(|| {
            let lower = snapshot
                .end_order
                .partition_point(|&i| snapshot.items[i].range.end < offset);
            let upper = snapshot
                .end_order
                .partition_point(|&i| snapshot.items[i].range.end <= offset);
            snapshot.end_order[lower..upper]
                .iter()
                .copied()
                .min_by_key(|&i| {
                    (
                        snapshot.items[i].kind,
                        snapshot.items[i].range.len(),
                        std::cmp::Reverse(i),
                    )
                })
        })?;
    Some(caret_for_item(&snapshot.items[index], offset))
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
    fn selection_is_half_open_reversible_and_keeps_repeated_output() {
        let id = store(
            vec![item(1, 0, 3), item(1, 3, 6), item(2, 3, 6), item(2, 6, 9)],
            9,
            vec![],
        );
        let selected = selection(id, 3, 6);
        assert_eq!(selected.len(), 2);
        assert_eq!(
            selected.iter().map(|quad| quad.page).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(selection(id, 6, 3), selected);
        assert!(selection(id, 3, 3).is_empty());
        assert!(selection(id, 0, 10).is_empty());
        assert!(selection(0, 0, 9).is_empty());
        let other = store(vec![], 9, vec![]);
        assert!(selection(other, 0, 9).is_empty());
        assert_eq!(selection(id, 0, 9).len(), 4);
    }

    #[test]
    fn selection_uses_transformed_corners_not_axis_aligned_bounds() {
        let mut placed = item(2, 0, 3);
        placed.caret_start = Point::new(Abs::pt(40.0), Abs::pt(20.0));
        placed.caret_end = Point::new(Abs::pt(40.0), Abs::pt(30.0));
        placed.caret_vector = Point::new(Abs::pt(-12.0), Abs::zero());
        let id = store(vec![placed], 3, vec![]);
        assert_eq!(
            selection(id, 0, 3)[0].points,
            [[40.0, 20.0], [40.0, 30.0], [28.0, 30.0], [28.0, 20.0]]
        );
    }

    #[test]
    fn selection_ignores_text_background_but_keeps_images_and_standalone_shapes() {
        let mut background = item(1, 0, 9);
        background.kind = PlacedItemKind::Shape;
        let mut image = item(2, 3, 6);
        image.kind = PlacedItemKind::Image;
        let mut shape = item(2, 6, 9);
        shape.kind = PlacedItemKind::Shape;
        let id = store(vec![background, item(1, 0, 3), image, shape], 9, vec![]);
        let selected = selection(id, 0, 9);
        assert_eq!(selected.len(), 3);
        assert_eq!(
            selected
                .iter()
                .map(|quad| (quad.from, quad.to))
                .collect::<Vec<_>>(),
            vec![(0, 3), (3, 6), (6, 9)]
        );
        for (from, to) in [(4, 5), (7, 8)] {
            let atomic = selection(id, from, to);
            assert_eq!(atomic.len(), 1);
            assert_eq!(atomic[0].points[1][0] - atomic[0].points[0][0], 10.0);
        }
    }

    #[test]
    fn source_index_preserves_linear_lookup_and_duplicate_output_priority() {
        let mut items = Vec::new();
        for i in (0..80).rev() {
            let mut placed = item(i % 3 + 1, i * 3, i * 3 + 6);
            if i % 7 == 0 {
                placed.kind = PlacedItemKind::Shape;
                placed.range = 0..240;
            }
            items.push(placed.clone());
            items.push(placed);
        }
        items.push(item(4, 240, 240)); // 无长度区间只能参与 end 回退。
        let id = store(items, 240, vec![]);
        let cache = SNAPSHOTS.lock().unwrap();
        let snapshot = cache.iter().find(|s| s.id == id).unwrap();
        for offset in 0..=241 {
            let original = (offset <= snapshot.source_len)
                .then(|| {
                    snapshot
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
                        })
                        .map(|item| caret_for_item(item, offset))
                })
                .flatten();
            assert_eq!(
                locate_in_snapshot(snapshot, offset),
                original,
                "offset={offset}"
            );
        }
        for page in 1..=4 {
            let indexed: Vec<_> = snapshot
                .page_items(page)
                .iter()
                .filter(|i| i.page == page)
                .collect();
            let original: Vec<_> = snapshot.items.iter().filter(|i| i.page == page).collect();
            assert_eq!(format!("{indexed:?}"), format!("{original:?}"));
        }
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
    fn side_whitespace_chooses_horizontal_position_within_a_mixed_height_line() {
        let make = |from, to, x, top, bottom| {
            PlacedItem::new(
                1,
                from..to,
                Rect::new(
                    Point::new(Abs::pt(x), Abs::pt(top)),
                    Point::new(Abs::pt(x + 10.0), Abs::pt(bottom)),
                ),
                45.0,
                crate::block_geometry::PlacedItemKind::Text,
                typst::layout::Transform::identity(),
            )
        };
        let id = store(
            vec![make(0, 3, 20.0, 30.0, 50.0), make(3, 6, 30.0, 39.0, 42.0)],
            6,
            vec![],
        );
        for y in [31.0, 40.0, 49.0] {
            let left = hit_test(id, 1, 0.0, y).unwrap();
            let right = hit_test(id, 1, 200.0, y).unwrap();
            assert_eq!(left.offset, 0);
            assert_eq!(right.offset, 6, "行尾不能被高字吸走：{y}");
            assert_eq!(right.is_whitespace, Some(true));
        }
        let direct = hit_test(id, 1, 31.0, 40.0).unwrap();
        assert_eq!(direct.offset, 3);
        assert_eq!(direct.is_whitespace, Some(false));
        assert_eq!(locate(id, 3).unwrap().is_whitespace, None);
        let serialized = serde_json::to_value(hit_test(id, 1, 200.0, 31.0).unwrap()).unwrap();
        assert_eq!(serialized["isWhitespace"], true);
        assert!(serde_json::to_value(locate(id, 3).unwrap())
            .unwrap()
            .get("isWhitespace")
            .is_none());
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
