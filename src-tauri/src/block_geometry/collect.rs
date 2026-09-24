// 版面几何收集：帧遍历（字形 `Span` → 源字节区间）+ 块几何（`BlockGeom`）。
use super::*;

/// 版面上的一个**链接**（页面坐标，单位 pt）：typst 的 `#link("https://…")[文字]` 会画成
/// `FrameItem::Link(目标, 尺寸)` —— 它**不带源位置**（`Span`），但带目标地址与方框，
/// 于是可以对到"点这个方框就打开这个地址"（阶段 3 的"链接可点"）。
#[derive(Debug, Clone)]
pub struct PlacedLink {
    pub page: usize,
    pub rect: Rect,
    /// 目标：只有外部 URL 会被收进来（页内 `#link(<label>)` 这类留给以后）
    pub href: String,
}

/// 帧里一项的几何 + 它对应的源字节区间（页面坐标，单位 pt）
#[derive(Debug, Clone)]
pub struct PlacedItem {
    pub page: usize,
    pub range: Range<usize>,
    pub rect: Rect,
    /// 文本项的**基线** y（页面坐标）；图形/图片取 rect 顶端。
    ///
    /// 为什么单列出来：墨迹顶（`rect.min.y`）在同一行里会被上标、分式、矩阵拉得很散
    /// （实测同一段的两行之间，行内最矮墨迹顶差 26pt，比行距还大），按墨迹顶数"占了几行"
    /// 会把同一行拆开、把相邻行并起来。基线才是"一行一条"的稳定信号。
    pub baseline_pt: f64,
}

/// 帧遍历的统计（用来判断"映射漏了多少"而不是只看最终覆盖率）
#[derive(Debug, Default, Clone)]
pub struct FrameStats {
    pub text_items: usize,
    pub glyphs_total: usize,
    pub glyphs_mapped: usize,
    pub groups: usize,
    pub transformed_groups: usize,
    pub clipped_groups: usize,
    pub shapes: usize,
    pub images: usize,
    /// 字号直方图：字号（pt ×100，取整当键）→ 该字号下的**字符数**。
    /// 用来回答"这篇文档的正文实际多大"（`document_text_pt`）—— 源码透镜要按它渲染，
    /// 否则光标一进某一块，那一块的字就比切片大一圈（用户：「不要光标在哪里哪里就变大了」）。
    pub size_weights: std::collections::BTreeMap<u32, usize>,
}
/// 遍历所有页的帧，收集"有源位置的项"的几何。
///
/// `world.range(span)` 把 `Span` 解成**编译那一份 `Source`** 上的字节区间 —— 必须用编译时的
/// world，不能拿最新文本来解旧帧（`Span` 是编译期的节点编号，文本一改编号就漂）。
pub fn collect_geometry(
    world: &dyn World,
    document: &PagedDocument,
) -> (Vec<PlacedItem>, FrameStats) {
    collect_geometry_with_links(world, document).0
}

/// 同上，但顺带把**链接**也收出来（阶段 3 的"链接可点"要用；`collect_geometry` 只是不要它的壳）
pub fn collect_geometry_with_links(
    world: &dyn World,
    document: &PagedDocument,
) -> ((Vec<PlacedItem>, FrameStats), Vec<PlacedLink>) {
    let mut items = Vec::new();
    let mut links = Vec::new();
    let mut stats = FrameStats::default();
    for (i, page) in document.pages().iter().enumerate() {
        walk_frame(
            world,
            &page.frame,
            i + 1,
            Point::zero(),
            Transform::identity(),
            &mut items,
            &mut links,
            &mut stats,
        );
    }
    ((items, stats), links)
}

/// 递归遍历帧。坐标映射与 typst-ide 的 `find_in_frame` 同构：
/// 子帧里的点 `p` 在本层的位置 = `pos + p.transform(group.transform)`。
#[allow(clippy::too_many_arguments)]
fn walk_frame(
    world: &dyn World,
    frame: &Frame,
    page: usize,
    offset: Point,
    ts: Transform,
    out: &mut Vec<PlacedItem>,
    links: &mut Vec<PlacedLink>,
    stats: &mut FrameStats,
) {
    for (pos, item) in frame.items() {
        // 该项原点在本层坐标系里的页面坐标（ts 是"本帧内容相对页面"的变换，顶层为 identity）
        let origin = Point::new(offset.x + pos.x, offset.y + pos.y).transform(ts);
        match item {
            FrameItem::Text(text) => {
                stats.text_items += 1;
                stats.glyphs_total += text.glyphs.len();
                // 按字符数给字号投票（正文量最大，标题/代码只是少数）
                let key = (text.size.to_pt() * 100.0).round().max(0.0) as u32;
                *stats.size_weights.entry(key).or_insert(0) += text.text.chars().count().max(1);
                let mut x = Abs::zero();
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let mapped = glyph_range(world, text, glyph);
                    if let Some(range) = mapped {
                        let (up, down) = glyph_ink(text, glyph.id);
                        let rect = Rect::new(
                            Point::new(origin.x + x, origin.y - up),
                            Point::new(origin.x + x + advance, origin.y + down),
                        );
                        out.push(PlacedItem {
                            page,
                            range,
                            rect,
                            baseline_pt: origin.y.to_pt(),
                        });
                        stats.glyphs_mapped += 1;
                    }
                    x += advance;
                }
            }
            FrameItem::Group(group) => {
                stats.groups += 1;
                let identity = group.transform == Transform::identity();
                if !identity {
                    stats.transformed_groups += 1;
                }
                if group.clip.is_some() {
                    stats.clipped_groups += 1;
                }
                walk_frame(
                    world,
                    &group.frame,
                    page,
                    origin,
                    group.transform,
                    out,
                    links,
                    stats,
                );
            }
            FrameItem::Shape(shape, span) => {
                stats.shapes += 1;
                if let Some(range) = world.range(*span) {
                    let bb = shape.bbox(true);
                    let rect = Rect::new(
                        Point::new(origin.x + bb.min.x, origin.y + bb.min.y),
                        Point::new(origin.x + bb.max.x, origin.y + bb.max.y),
                    );
                    out.push(PlacedItem {
                        page,
                        range,
                        rect,
                        baseline_pt: rect.min.y.to_pt(),
                    });
                }
            }
            FrameItem::Image(_, size, span) => {
                stats.images += 1;
                if let Some(range) = world.range(*span) {
                    let rect = Rect::new(origin, Point::new(origin.x + size.x, origin.y + size.y));
                    out.push(PlacedItem {
                        page,
                        range,
                        rect,
                        baseline_pt: origin.y.to_pt(),
                    });
                }
            }
            FrameItem::Link(dest, size) => {
                // 链接没有源位置，但有目标与方框：收下来给"切片上可点"用
                if let Some(href) = link_href(dest) {
                    links.push(PlacedLink {
                        page,
                        rect: Rect::from_pos_size(origin, *size),
                        href,
                    });
                }
            }
            // Tag 有 Location 但没有 Span（元素级定位另走 introspector，阶段 1 再说）
            FrameItem::Tag(_) => {}
        }
    }
}

/// 链接目标 → 可点的 URL（页内跳转 / 位置型目标暂时不收：那要映射回源码位置，属后续工作）
fn link_href(dest: &typst::model::Destination) -> Option<String> {
    match dest {
        typst::model::Destination::Url(url) => {
            let url = url.as_str();
            // 只收"能交给系统浏览器打开"的协议，避免把 `javascript:` 这类东西放进 DOM
            let ok = url.starts_with("http://")
                || url.starts_with("https://")
                || url.starts_with("mailto:");
            ok.then(|| url.to_string())
        }
        _ => None,
    }
}

/// 字形 → 源字节区间。
///
/// `Span` 给节点范围、`u16` 给节点内子偏移（`start = 节点起点 + 子偏移`，与 typst-ide 对
/// `Text`/`MathText` 节点的处理一致）；字形的**字节长度**从 text item 的纯文本里取
/// （`glyph.range()` 是它在 item 文本里的字节区间；连字/多字节字符都可能 >1 字节）。
/// 结果钳在节点范围内 —— 字形来自哪个节点由 `Span` 决定，越界会把别处的源码也算进来。
fn glyph_range(
    world: &dyn World,
    text: &typst::text::TextItem,
    glyph: &typst::text::Glyph,
) -> Option<Range<usize>> {
    let base = world.range(glyph.span.0)?;
    let start = (base.start + usize::from(glyph.span.1)).min(base.end);
    // 取不到这一段的字符串时用"这个字符的 UTF-8 长度"兜底，**不是写死 1**：
    // 写死 1 会把 CJK（3 字节）/ emoji（4 字节）切在半截上，落点就会落在字符中间
    // （PR #60 审查的第 10 条）。
    let len = text
        .text
        .get(glyph.range())
        .map(|s| s.len())
        .or_else(|| {
            text.text
                .get(start..)
                .and_then(|s| s.chars().next())
                .map(char::len_utf8)
        })
        .unwrap_or(1);
    let end = (start + len).min(base.end);
    Some(start..end.max(start))
}

/// 单个字形的墨迹：返回 **(基线上方高度, 基线下沉深度)**，两个都是正值。
///
/// `Font::edges` 的正常路径返回的就是这两个正量（top = `bbox.y_max`，bottom = `-bbox.y_min`），
/// 但**没有字形包围盒时它返回的是带符号值**（`-ascender`, `|descender|`），直接拿去做
/// `original.y ± v` 会得到一个上下颠倒的矩形（实测踩过：块高出现负数）。
/// 所以这里统一规范化成"两个正值"，再统一按 `y - up .. y + down` 组装。
fn glyph_ink(text: &typst::text::TextItem, id: u16) -> (Abs, Abs) {
    let (top, bottom) = text.font.edges(
        TopEdge::Metric(TopEdgeMetric::Bounds),
        BottomEdge::Metric(BottomEdgeMetric::Bounds),
        text.size,
        TextEdgeBounds::Glyph(id),
    );
    if top <= Abs::zero() && bottom <= Abs::zero() {
        // 没有字形包围盒（空格、零宽字符等）：退回字体度量
        let m = text.font.metrics();
        (m.ascender.at(text.size), m.descender.at(text.size).abs())
    } else {
        (top.abs(), bottom.abs())
    }
}

/// 一个源块算出来的几何
#[derive(Debug, Clone, Copy)]
pub struct BlockGeom {
    /// 渲染结果所在的首页（跨页的块只按首页算矩形，`pages` 会 > 1）
    pub page: usize,
    /// 该块的内容分布在几页上（>1 = 被分页切开，单张长页时正常为 1）
    pub pages: usize,
    pub rect: Rect,
    /// 占了几行（y 去重后的"行带"数）
    pub bands: usize,
    pub items: usize,
}

/// 块内**首行主基线**（页面坐标 pt）：取首行墨迹带（与最小墨迹顶相差 ≤1pt）里基线的众数。
///
/// 写作模式"可编辑块按带高占位"除了高度，还要知道首行基线在带内的偏移；浏览器侧对应量法见
/// `scripts/browser-check/writing-pku-docs.mjs`（行盒顶 + 半 leading + 字体 ascent）。
pub fn first_line_baseline(items: &[PlacedItem], range: Range<usize>, page: usize) -> Option<f64> {
    let mut min_y = f64::INFINITY;
    for i in items
        .iter()
        .filter(|i| i.page == page && i.range.start < range.end && i.range.end >= range.start)
    {
        min_y = min_y.min(i.rect.min.y.to_pt());
    }
    if !min_y.is_finite() {
        return None;
    }
    let mut bins: std::collections::BTreeMap<i64, usize> = std::collections::BTreeMap::new();
    for i in items.iter().filter(|i| {
        i.page == page
            && i.range.start < range.end
            && i.range.end >= range.start
            && i.rect.min.y.to_pt() - min_y <= 1.0
    }) {
        *bins
            .entry((i.baseline_pt * 2.0).round() as i64)
            .or_insert(0) += 1;
    }
    bins.iter()
        .max_by_key(|(_, c)| **c)
        .map(|(k, _)| *k as f64 / 2.0)
}

/// 块内**每一行的源码终点**（升序，**不含最后一行的块尾**；绝对源字节偏移）。
///
/// 用途：让浏览器按 Typst 的断点折行 —— 前端在这些位置插一个 `display: block; height: 0`
/// 的行内 widget 就能强制换行，断点落在 `$…$` 之类原子区间里的项由前端丢弃
/// （见 docs/development/writing-rendering.md 的"折行"一节）。
///
/// 判据是**基线聚类**：同一行的上下标/分式会把基线拉开约 0.35em，而 Typst 的行距通常 ≥1em，
/// 取 0.75em 当阈值能把"行内偏移"与"行"分开（与 `lineCount` 同一套口径）。一行里取最大的
/// `range.end` 当终点。
///
/// **这是"提示"而不是"真值"**（实测四份作业 327 个块里 27 个与 `lineCount - 1` 不一致）：
/// 行内矩阵/多重分式的子基线能超过 0.75em（把一行拆开），同一个 `$…$` 里多个字形也可能共用一个
/// 源区间（取 max + dedup 之后条数变少）。所以前端消费时必须自己校验：严格递增、不落在
/// `$…$`/raw 之类的原子区间里、且与这一块的视觉行数自洽 —— 不自洽就整块不用断点。
pub fn line_break_offsets(
    items: &[PlacedItem],
    range: Range<usize>,
    page: usize,
    text_pt: f64,
) -> Vec<usize> {
    let mut hit: Vec<&PlacedItem> = items
        .iter()
        .filter(|i| i.page == page && i.range.start < range.end && i.range.end >= range.start)
        .collect();
    if hit.len() < 2 {
        return Vec::new();
    }
    hit.sort_by(|a, b| a.baseline_pt.total_cmp(&b.baseline_pt));
    let threshold = (text_pt * 0.75).max(0.5);
    let mut offsets: Vec<usize> = Vec::new();
    let mut line_start = 0usize;
    for i in 1..=hit.len() {
        let boundary = i == hit.len() || hit[i].baseline_pt - hit[i - 1].baseline_pt > threshold;
        if boundary {
            if let Some(end) = hit[line_start..i].iter().map(|it| it.range.end).max() {
                offsets.push(end);
            }
            line_start = i;
        }
    }
    // 最后一项是块尾（不需要断点）；再去掉越界、重复与不递增的项
    offsets.pop();
    offsets.retain(|o| *o > range.start && *o < range.end);
    offsets.dedup();
    offsets
}

/// 给定源字节区间，算出它在版面上的**外接矩形**（None = 该区间没有任何渲染结果）
pub fn geometry_for_range(items: &[PlacedItem], range: Range<usize>) -> Option<BlockGeom> {
    if range.is_empty() {
        return None;
    }
    let hit: Vec<&PlacedItem> = items
        .iter()
        .filter(|i| i.range.start < range.end && i.range.end >= range.start)
        .collect();
    if hit.is_empty() {
        return None;
    }
    let page = hit.iter().map(|i| i.page).min().unwrap();
    let mut pages: Vec<usize> = hit.iter().map(|i| i.page).collect();
    pages.sort_unstable();
    pages.dedup();

    // 矩形只按首页的项算：跨页时把两页的坐标并在一起没有意义
    let on_first: Vec<&&PlacedItem> = hit.iter().filter(|i| i.page == page).collect();
    let mut min = on_first[0].rect.min;
    let mut max = on_first[0].rect.max;
    for item in &on_first {
        min.x = min.x.min(item.rect.min.x);
        min.y = min.y.min(item.rect.min.y);
        max.x = max.x.max(item.rect.max.x);
        max.y = max.y.max(item.rect.max.y);
    }
    // 行带数：把 y 值去重（取整到 0.5pt）当作"这个块占了几行"
    let mut ys: Vec<i64> = on_first
        .iter()
        .map(|i| (i.rect.min.y.to_pt() * 2.0).round() as i64)
        .collect();
    ys.sort_unstable();
    ys.dedup();
    Some(BlockGeom {
        page,
        pages: pages.len(),
        rect: Rect::new(min, max),
        bands: ys.len(),
        items: hit.len(),
    })
}
