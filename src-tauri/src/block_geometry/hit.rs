use super::*;

/// 点到区间的距离（落在区间内为 0）。
fn gap(min: Abs, max: Abs, v: Abs) -> Abs {
    if v < min {
        min - v
    } else if v > max {
        v - max
    } else {
        Abs::zero()
    }
}

/// 先按纵向距离选行，再按横向距离选字；返回项及 UTF-8 光标偏移。
/// 同距时优先文字和较小源区间，保持帧遍历顺序。
pub fn pick_hit_item(
    items: &[PlacedItem],
    start: usize,
    end: usize,
    page: usize,
    x: Abs,
    y: Abs,
) -> Option<(&PlacedItem, usize)> {
    if end <= start {
        return None;
    }
    let mut best: Option<(&PlacedItem, Abs, Abs)> = None;
    for item in items {
        if item.page != page {
            continue;
        }
        if item.range.start >= end || item.range.end < start {
            continue;
        }
        // 字形墨迹之外、同一输入行内也应命中该字符（尤其是标点）。
        let rect = item.hit_rect();
        let dy = gap(rect.min.y, rect.max.y, y);
        let dx = gap(rect.min.x, rect.max.x, x);
        let take = match best {
            None => true,
            Some((previous, bdy, bdx)) => {
                (dy, dx, item.kind, item.range.len())
                    < (bdy, bdx, previous.kind, previous.range.len())
            }
        };
        if take {
            best = Some((item, dy, dx));
        }
    }
    let (item, _, _) = best?;
    let axis = item.caret_end - item.caret_start;
    let point = Point::new(x, y) - (item.caret_start + item.caret_vector / 2.0);
    let projection = point.x.to_pt() * axis.x.to_pt() + point.y.to_pt() * axis.y.to_pt();
    let length_squared = axis.x.to_pt().powi(2) + axis.y.to_pt().powi(2);
    let offset = if let Some(stops) = &item.caret_stops {
        let ratio = if length_squared > 0.0 {
            (projection / length_squared).clamp(0.0, 1.0)
        } else {
            0.0
        };
        stops[(ratio * (stops.len() - 1) as f64).round() as usize]
    } else if projection < length_squared / 2.0 {
        item.range.start
    } else {
        item.range.end
    };
    Some((item, offset.clamp(start, end)))
}
