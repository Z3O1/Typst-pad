use super::*;

// ---------------------------------------------------------------------------
// 点击定位（阶段 2）：把"切片上的一个点"映射回"源码里的第几个字符"
// ---------------------------------------------------------------------------

/// 上一次成功编译的字形几何缓存（**文档坐标**：已减掉注入行与编译前缀）。
///
/// 为什么不随 `compile_blocks` 一起把字形逐个返回给前端：逐块 SVG 已经约 58 字节/源字符，
/// 再让每个按键的载荷多三成代价太大；而点击只在用户真的点下去那一刻发生一次。
/// 缓存里只有"字形 → 源字节区间 + 版面矩形"，一次命中测试是线性扫一遍（微秒级）。
///
/// **陈旧是可以接受的，但"张冠李戴"不行**：前端只在"块表与当前文档一致"时才发命中测试
/// （见 +page.svelte 的 `handleCropClick`），而块表的区间正是这份几何的来源；编译失败时
/// 前端沿用旧块表，缓存里也还是上一次成功编译的几何 —— 两者同源。
/// 但**几何是进程级的，而应用支持多窗口**：另一个窗口编译一次就会把这份缓存换掉，本窗口
/// 再点击就会拿别人的排版去找最近字形（结果被钳进自己的块区间 ⇒ 点错字）。
/// 所以缓存带一个**自增编号**，随 `compile_blocks` 返回给前端、由 `block_hit_test` 带回来比对，
/// 对不上就拒绝命中（前端退回"光标落到块首"）。
static HIT_CACHE: Mutex<Option<(u64, Vec<PlacedItem>)>> = Mutex::new(None);

/// 几何编号的自增计数器（从 1 开始；0 保留给"没有几何"）
static HIT_GEOMETRY_SEQ: AtomicU64 = AtomicU64::new(1);

/// 把编译源坐标的字形几何换成**用户文档坐标**并缓存（丢弃注入行 / 前缀里的项），
/// 返回这一份几何的编号（前端拿它做后续命中测试的凭据）。
pub fn store_hit_geometry(items: Vec<PlacedItem>, doc_start: usize) -> u64 {
    let converted: Vec<PlacedItem> = items
        .into_iter()
        .filter(|i| i.range.start >= doc_start && i.range.end > doc_start)
        .map(|mut i| {
            i.range.start -= doc_start;
            i.range.end -= doc_start;
            i
        })
        .collect();
    let id = HIT_GEOMETRY_SEQ.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut guard) = HIT_CACHE.lock() {
        *guard = Some((id, converted));
    }
    id
}

/// 点到区间的距离（落在区间内为 0）—— 用来挑"最近的一行 / 行里最近的一个字"
fn gap(min: Abs, max: Abs, v: Abs) -> Abs {
    if v < min {
        min - v
    } else if v > max {
        v - max
    } else {
        Abs::zero()
    }
}

/// 命中测试（纯函数，可单测）：在 `start..end`（**用户文档字节区间**，即一个块）里，
/// 给出页 `page` 上离 `(x, y)`（**页面坐标，pt**）最近的**字形**，返回光标该落在哪个字节偏移。
///
/// 规则是"先选行、再在行里选字"的直白实现：所有候选字形按 (纵向距离, 横向距离) 取最小 ——
/// 纵向距离为 0 的就是"点在这一行的高度里"，于是横向距离自然决定选哪个字。
/// 落点在字形左半 → 光标在它之前，右半 → 在它之后；点在整行右侧空白处时，
/// 最近的必然是行末那个字，于是光标落在**行尾**（而不是块尾）——与所见即所得一致。
///
/// 返回值钳在 `start..end` 内：点击永远只影响被点的那一块。
pub fn pick_hit(
    items: &[PlacedItem],
    start: usize,
    end: usize,
    page: usize,
    x: Abs,
    y: Abs,
) -> Option<usize> {
    if end <= start {
        return None;
    }
    let mut best: Option<(&PlacedItem, Abs, Abs)> = None;
    for item in items {
        if item.page != page {
            continue;
        }
        // 半开区间相交：字形的源区间要落在块内
        if item.range.start >= end || item.range.end < start {
            continue;
        }
        let dy = gap(item.rect.min.y, item.rect.max.y, y);
        let dx = gap(item.rect.min.x, item.rect.max.x, x);
        let take = match best {
            None => true,
            // 同距时保留先遇到的（帧遍历顺序稳定 ⇒ 结果可复现）
            Some((_, bdy, bdx)) => dy < bdy || (dy == bdy && dx < bdx),
        };
        if take {
            best = Some((item, dy, dx));
        }
    }
    let (item, _, _) = best?;
    let mid = (item.rect.min.x + item.rect.max.x) / 2.0;
    let offset = if x < mid {
        item.range.start
    } else {
        item.range.end
    };
    Some(offset.clamp(start, end))
}

/// Tauri 命令的入口：`(x_pt, y_pt)` 是**页面坐标**（与 `BlockCrop` 的 x_pt/y_pt 同一坐标系）。
/// 没有缓存（还没编译过）或参数非法时返回 None，前端退回"落到块首"的老行为。
pub fn hit_test(
    start: usize,
    end: usize,
    page: usize,
    x_pt: f64,
    y_pt: f64,
    geometry_id: Option<u64>,
) -> Option<usize> {
    if !x_pt.is_finite() || !y_pt.is_finite() {
        return None;
    }
    let guard = HIT_CACHE.lock().ok()?;
    let (id, items) = guard.as_ref()?;
    // 前端给了编号就必须对上（多窗口 / 换文档后缓存被别人覆盖时拒绝命中）；
    // 没给编号（旧前端、内部探针）按老行为直接用 —— 兼容，不引入新的失败模式。
    if let Some(expected) = geometry_id {
        if expected != *id {
            return None;
        }
    }
    pick_hit(items, start, end, page, Abs::pt(x_pt), Abs::pt(y_pt))
}

pub(crate) fn merge_ranges(mut v: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    v.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}
