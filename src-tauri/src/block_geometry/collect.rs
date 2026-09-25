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

/// 文档的**行距**（pt）：基线直方图的**自相关峰**（0.5pt 分箱，步长 8~30pt 里取重叠最多的那个）。
///
/// 为什么用全局估计而不是逐块算：多数字形落在每行的主基线上，把整份基线集合平移一个真实行距后
/// 重叠最多，分式/上下标是少数、不会赢；而逐块估计依赖行数，行数又由主峰数得出，误差会被放大
/// （实测数分周二被带成 11.5 / 21pt 两个假峰）。
///
/// 这也是浏览器验收的夹具探针用的同一个估计量 —— **两边必须同口径**，否则"引擎给的行断点"与
/// "验收认为的 Typst 行数"会对不上（`writing-pku-docs.mjs` / `.browser-check/pku-writing/`）。
pub fn line_spacing_pt(items: &[PlacedItem]) -> Option<f64> {
    let mut bins: std::collections::BTreeMap<i64, usize> = std::collections::BTreeMap::new();
    for i in items {
        *bins
            .entry((i.baseline_pt * 2.0).round() as i64)
            .or_insert(0) += 1;
    }
    if bins.len() < 3 {
        return None;
    }
    let mut best = (0i64, 0usize);
    for step in 16i64..=60 {
        let mut overlap = 0usize;
        for (b, c) in &bins {
            if bins.contains_key(&(b + step)) {
                overlap += c;
            }
        }
        if overlap > best.1 {
            best = (step, overlap);
        }
    }
    (best.1 > 0).then(|| best.0 as f64 / 2.0)
}

/// 一个块按基线聚类出来的**行结构**：`count` = 视觉行数，`breaks` = 每行（除最后一行）的源码终点。
#[derive(Debug, Clone, Default)]
pub struct BlockLines {
    /// 视觉行数（与浏览器验收的 `lineCount` 同一套聚类口径）
    pub count: usize,
    /// 每行的源码终点（升序、绝对源字节偏移，不含块尾）
    pub breaks: Vec<usize>,
}

/// 块内**每一行的源码终点**（升序，**不含最后一行的块尾**；绝对源字节偏移）。
///
/// 用途：让浏览器按 Typst 的断点折行 —— 前端在这些位置放一个"强制换行"的装饰，段落折成几行
/// 就不再取决于浏览器的贪心断行（见 docs/development/writing-rendering.md 的"折行"一节）。
///
/// 判据是**基线聚类**：同一行的上下标/分式会把基线拉开好几 pt，而 Typst 的行距通常 ≥15pt，
/// 取行距的 0.75 倍当阈值能把"行内偏移"与"行"分开；聚类之后再**合并主基线相距 < 半个行距的
/// 相邻簇**（分子/分母那种矮丘不是新的一行，见下面 `merged` 一段的实测说明）。断点取"上一行
/// 最右终点"与"下一行最左起点"里**后者更小才用后者**（理由见下面的行内注释）。
///
/// **聚类必须是"与上一个行边界比"而不是"与前一个字形比"**（2026-09-25 修正，这是"提示不准"
/// 的真正原因）：数学密集的段落里，同一行内的上下标基线铺得很开（相邻字形差 5~10pt），
/// 按"相邻差 > 阈值"聚类会把整块并成一行 —— 实测数分周二 L154 的 6 行被并成 1 行、L48 的 5 行
/// 被并成 2 行，于是"引擎说 2 行、验收说 5 行"，前端就算照做也强制不出正确的断点。
/// 与验收的 `lineCount` 同口径之后，`count` 与 `breaks.len() + 1` 对所有块一致。
///
/// 仍然是**提示而非真值**：行内矩阵/多重分式的子基线可能超过阈值（把一行切多），同一个 `$…$`
/// 里多个字形也可能共用一个源区间（把一行切少）。正常情形下 `count == breaks.len() + 1`；
/// 前端消费时必须自己校验：`count` 与断点条数自洽、断点严格递增、不落在 `$…$`/raw 之类的
/// 原子区间里 —— 不自洽就整块不用。
pub fn block_lines(
    items: &[PlacedItem],
    range: Range<usize>,
    page: usize,
    line_spacing: Option<f64>,
) -> BlockLines {
    let mut hit: Vec<&PlacedItem> = items
        .iter()
        .filter(|i| i.page == page && i.range.start < range.end && i.range.end >= range.start)
        .collect();
    if hit.is_empty() {
        return BlockLines::default();
    }
    hit.sort_by(|a, b| a.baseline_pt.total_cmp(&b.baseline_pt));
    // 阈值与验收的 `lineCount` 完全相同：行距的 0.75 倍；量不到行距时不聚类（任何基线差都算新行）
    let threshold = line_spacing.map(|sp| sp * 0.75).unwrap_or(0.0);
    // 聚类之后还要**合并"主基线挨得太近"的相邻簇**（见下面的说明），所以先算出每簇的
    // 主基线（承载字形最多的那条基线）与簇内字形数。
    struct Cluster {
        start: usize,
        end: usize,
        mode: f64,
        mode_glyphs: usize,
    }
    let cluster_of = |from: usize, to: usize| -> Cluster {
        let mut bins: std::collections::BTreeMap<i64, (f64, usize)> =
            std::collections::BTreeMap::new();
        for it in &hit[from..to] {
            let e = bins
                .entry((it.baseline_pt * 2.0).round() as i64)
                .or_insert((it.baseline_pt, 0));
            e.1 += 1;
        }
        // 字形最多的那条基线；并列时取最小的那条（保证确定性）
        let (_, (mode, mode_glyphs)) = bins
            .iter()
            .max_by(|a, b| a.1 .1.cmp(&b.1 .1).then(b.0.cmp(a.0)))
            .unwrap();
        Cluster {
            start: from,
            end: to,
            mode: *mode,
            mode_glyphs: *mode_glyphs,
        }
    };
    let mut clusters: Vec<Cluster> = Vec::new();
    let mut line_start = 0usize;
    let mut last_boundary = hit[0].baseline_pt;
    for i in 1..=hit.len() {
        let boundary = i == hit.len() || hit[i].baseline_pt - last_boundary > threshold;
        if boundary {
            clusters.push(cluster_of(line_start, i));
            if i < hit.len() {
                last_boundary = hit[i].baseline_pt;
            }
            line_start = i;
        }
    }
    // **合并"主基线挨得太近"的相邻簇**（2026-09-25 实测，这是"折行数与 Typst 不符"的最后一块拼图）。
    //
    // 为什么需要：分式的分子/分母、上下标各有自己的基线，**累计聚类**会把它们与前一行分开 ——
    // 判据是"与前一个行边界差 > 0.75 行距"，而一条矮丘离上一行越远就越容易被判成新行。
    // 实测数分周二 L54/L72 本来只有 **1 行**（主基线上 17 / 39 个字形，其余都是 1~2 个字形的
    // 分子分母），却被数成 2 行；L154 的 5 行被数成 6 行、L48 的 4 行被数成 5 行 —— 于是
    // 前端去"强制折出"一个并不存在的换行（或整块退回贪心），验收当然对不上。
    //
    // 判据：相邻两簇的**主基线**相距 < 半个行距时合并。真实的行距是整份行距（15~18pt），
    // 行内偏移不可能超过半个行距 —— 实测 L122/L154 的真实行主基线正好相隔 15.5pt（不合并），
    // 而 L54/L72 的假行主基线只相隔 4pt（合并）。四份作业 210 个可编辑块里，这条规则只改动
    // 了那 4 个块，且改完之后浏览器量与引擎量 **209/210 一致**（剩下的 1 块是"Typst 在行内公式
    // 内部折行"，浏览器折不了原子 widget，见文档的"折行"一节）。
    if let Some(spacing) = line_spacing {
        let mut merged: Vec<Cluster> = Vec::with_capacity(clusters.len());
        for c in clusters {
            match merged.last_mut() {
                Some(prev) if (c.mode - prev.mode).abs() < spacing * 0.5 => {
                    prev.end = c.end;
                    if c.mode_glyphs > prev.mode_glyphs {
                        prev.mode = c.mode;
                        prev.mode_glyphs = c.mode_glyphs;
                    }
                }
                _ => merged.push(c),
            }
        }
        clusters = merged;
    }
    // 逐行取源码区间：`(min_start, max_end)`
    let ranges: Vec<(usize, usize)> = clusters
        .iter()
        .map(|c| {
            let cl = &hit[c.start..c.end];
            (
                cl.iter().map(|it| it.range.start).min().unwrap(),
                cl.iter().map(|it| it.range.end).max().unwrap(),
            )
        })
        .collect();
    let lines = clusters.len();
    // 每个断点取"上一行最右源码终点"，只有在它越出块尾时才退回"下一行最左源码起点"里较小的那个。
    //
    // **主口径必须是 `range.end` 的最大值**（2026-09-25 实测反面教材）：行内公式 `$…$` 的每一个
    // 字形都映射到**整条公式**的源区间，于是一条跨两行的公式会让**下一行**的"最左起点"退回到
    // 上一行里 —— 拿它当断点就等于把这条公式及其后的内容整段往下推，一行变两行、再连锁
    // （实测高代周二因此从 1 块不一致涨到 19 块，L128 的 5 行折成 9 行）。
    //
    // 越界才回退的理由：公式的源区间也可能**一直伸到块尾**（公式是块里最后一样东西），此时
    // `range.end` 会给上一行也塞一个块尾 —— 那个断点会被"必须落在块内"的过滤丢掉，整块退回
    // 浏览器折行。退回"下一行最左起点"至少能把这一行切开，且位置必在块内。
    let mut offsets: Vec<usize> = Vec::new();
    for i in 0..ranges.len().saturating_sub(1) {
        let end_of_line = ranges[i].1;
        let start_of_next = ranges[i + 1].0;
        let mut candidate = if end_of_line > range.start && end_of_line < range.end {
            end_of_line
        } else {
            start_of_next
        };
        if let Some(last) = offsets.last() {
            if *last >= candidate {
                candidate = *last + 1;
            }
        }
        if candidate > range.start && candidate < range.end {
            offsets.push(candidate);
        }
    }
    BlockLines {
        count: lines,
        breaks: offsets,
    }
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
