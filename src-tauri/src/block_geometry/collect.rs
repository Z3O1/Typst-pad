// 版面几何收集：帧遍历（字形 `Span` → 源字节区间）+ 块几何（`BlockGeom`）。
use super::*;
use std::collections::HashMap;
use typst::syntax::{LinkedNode, Span};
use unicode_segmentation::UnicodeSegmentation;

// 只属于这一轮 World/Source 的缓存；跨修订复用 Span 会映射到错误源码。
#[derive(Default)]
struct SpanRanges {
    spans: HashMap<Span, Option<Range<usize>>>,
    ink: HashMap<(u128, u16), (Abs, Abs)>,
    #[cfg(test)]
    uncached: bool,
}

impl SpanRanges {
    fn for_world(world: &dyn World) -> Self {
        let mut ranges = Self::default();
        if let Ok(source) = world.source(world.main()) {
            fn index(node: LinkedNode<'_>, ranges: &mut SpanRanges) {
                if node.span().id().is_some() {
                    ranges.spans.insert(node.span(), Some(node.range()));
                }
                for child in node.children() {
                    index(child, ranges);
                }
            }
            // Source::range 每次从语法树查找。一次遍历建立相同的节点区间，消除
            // 长文档上大量不同 Span 首次查询的二次增长；未知 Span 仍走 World。
            index(LinkedNode::new(source.root()), &mut ranges);
        }
        ranges
    }

    fn ink(&mut self, text: &typst::text::TextItem, font_size: u128, id: u16) -> (Abs, Abs) {
        #[cfg(test)]
        if self.uncached {
            return glyph_ink(text, id);
        }
        *self
            .ink
            .entry((font_size, id))
            .or_insert_with(|| glyph_ink(text, id))
    }

    fn get(&mut self, world: &dyn World, span: Span) -> Option<Range<usize>> {
        #[cfg(test)]
        if self.uncached {
            return world.range(span);
        }
        self.spans
            .entry(span)
            .or_insert_with(|| world.range(span))
            .clone()
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PlacedItemKind {
    Text,
    Image,
    Shape,
    Formula,
}

/// 帧里一项的几何 + 它对应的源字节区间（页面坐标，单位 pt）
#[derive(Debug, Clone)]
pub struct PlacedItem {
    pub page: usize,
    pub range: Range<usize>,
    pub rect: Rect,
    pub kind: PlacedItemKind,
    /// 字前、字后的光标顶端与方向，保留旋转/缩放后的输入轴。
    pub caret_start: Point,
    pub caret_end: Point,
    pub caret_vector: Point,
    /// 仅多字素连字保留内部停靠点；普通字形不额外分配。
    pub caret_stops: Option<Box<[usize]>>,
    /// 文本项的**基线** y（页面坐标）；图形/图片取 rect 顶端。
    ///
    /// 为什么单列出来：墨迹顶（`rect.min.y`）在同一行里会被上标、分式、矩阵拉得很散
    /// （实测同一段的两行之间，行内最矮墨迹顶差 26pt，比行距还大），按墨迹顶数"占了几行"
    /// 会把同一行拆开、把相邻行并起来。基线才是"一行一条"的稳定信号。
    pub baseline_pt: f64,
}

impl PlacedItem {
    pub fn new(
        page: usize,
        range: Range<usize>,
        local: Rect,
        baseline_pt: f64,
        kind: PlacedItemKind,
        transform: Transform,
    ) -> Self {
        let caret_start = local.min.transform(transform);
        let caret_end = Point::new(local.max.x, local.min.y).transform(transform);
        let caret_vector = Point::new(local.min.x, local.max.y).transform(transform) - caret_start;
        Self {
            page,
            range,
            rect: transformed_rect(local, transform),
            kind,
            caret_start,
            caret_end,
            caret_vector,
            caret_stops: None,
            baseline_pt: Point::new(local.min.x, Abs::pt(baseline_pt))
                .transform(transform)
                .y
                .to_pt(),
        }
    }

    fn text_caret(
        mut self,
        text: &typst::text::TextItem,
        glyph: &typst::text::Glyph,
        x: Abs,
        transform: Transform,
    ) -> Self {
        // 光标使用字体度量，墨迹 rect 仍供几何证明/背景判定使用。
        // 不能用句号、逗号或小写字母的 bbox 当作输入行高。
        let metrics = text.font.metrics();
        let top = -metrics.ascender.at(text.size);
        let bottom = metrics.descender.at(text.size).abs();
        self.caret_start = Point::new(x, top).transform(transform);
        self.caret_end = Point::new(x + glyph.x_advance.at(text.size), top).transform(transform);
        self.caret_vector = Point::new(x, bottom).transform(transform) - self.caret_start;
        if let Some(visible) = text
            .text
            .get(glyph.range())
            .filter(|s| s.len() == self.range.len())
        {
            let mut graphemes = visible.grapheme_indices(true);
            graphemes.next();
            if let Some((second, _)) = graphemes.next() {
                let mut stops = vec![self.range.start, self.range.start + second];
                stops.extend(graphemes.map(|(i, _)| self.range.start + i));
                stops.push(self.range.end);
                self.caret_stops = Some(stops.into_boxed_slice());
            }
        }
        self
    }

    pub fn caret_at(&self, offset: usize) -> Point {
        if offset <= self.range.start {
            return self.caret_start;
        }
        if offset >= self.range.end {
            return self.caret_end;
        }
        let Some(stops) = &self.caret_stops else {
            return self.caret_end;
        };
        let index = stops
            .partition_point(|&stop| stop <= offset)
            .saturating_sub(1);
        self.caret_start
            + (self.caret_end - self.caret_start) * (index as f64 / (stops.len() - 1) as f64)
    }

    pub fn hit_rect(&self) -> Rect {
        if self.kind != PlacedItemKind::Text {
            return self.rect;
        }
        let points = [
            self.caret_start,
            self.caret_end,
            self.caret_start + self.caret_vector,
            self.caret_end + self.caret_vector,
        ];
        let min = points
            .iter()
            .fold(points[0], |p, q| Point::new(p.x.min(q.x), p.y.min(q.y)));
        let max = points
            .iter()
            .fold(points[0], |p, q| Point::new(p.x.max(q.x), p.y.max(q.y)));
        Rect::new(min, max)
    }
}

pub(crate) fn transformed_rect(rect: Rect, transform: Transform) -> Rect {
    if transform.kx == typst::layout::Ratio::zero() && transform.ky == typst::layout::Ratio::zero()
    {
        // 平移/轴对齐缩放只需两个角；负缩放同样保留 min/max 规范化。
        let a = rect.min.transform(transform);
        let b = rect.max.transform(transform);
        return Rect::new(
            Point::new(a.x.min(b.x), a.y.min(b.y)),
            Point::new(a.x.max(b.x), a.y.max(b.y)),
        );
    }
    let corners = [
        rect.min,
        Point::new(rect.max.x, rect.min.y),
        rect.max,
        Point::new(rect.min.x, rect.max.y),
    ]
    .map(|point| point.transform(transform));
    let mut min = corners[0];
    let mut max = corners[0];
    for corner in &corners[1..] {
        min.x = min.x.min(corner.x);
        min.y = min.y.min(corner.y);
        max.x = max.x.max(corner.x);
        max.y = max.y.max(corner.y);
    }
    Rect::new(min, max)
}

/// 一项目**typst 自己合成**的字形（`span` 为 `None`）：列表符号 `•` / `1.`、`dif` 的 "d" 这类。
///
/// 它们不是主文档的字形（没有可映射的源码区间），也不是别的文件的东西 —— 是 typst 排版时
/// 现造的。文字对应证明把它们当成"块内合成件"（既不算外来墨迹，也不参与覆盖）；
/// **列表符号**则要原样取出来交给前端：符号、缩进、编号必须与 typst 一致，前端那套
/// "按缩进计数"的近似不能冒充自定义编号/起始值。
#[derive(Debug, Clone)]
pub struct DetachedInk {
    pub page: usize,
    pub rect: Rect,
    pub baseline_pt: f64,
    /// 这个字形画出来的字符（`text.text[glyph.range()]`；空串的合成件不收）
    pub text: String,
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
    /// **不属于主文档、或 span 解析不出来的墨迹**（页号 + 页面坐标矩形）。
    ///
    /// 为什么单列：`items` 只收"主文档里能解出字节区间的项"，而 `#include` 进来的文件
    /// （span 落在别的 `FileId` 上）与解析不出区间的项**照样画在页面上**。文字对应证明要能
    /// 判断"这一块的带里有没有外来的墨迹"（任务 1 的反例：来自其它源文件的可见内容），
    /// 所以这些项不能丢，只是不能当成"这一块的源码"。
    ///
    /// 另：字形 span 落在**别的文件**上时，`world.range` 给出的是那个文件里的字节偏移，
    /// 与主文档坐标毫无关系 —— 早先的遍历把它当主文档偏移收进 `items`，会污染块几何与命中。
    pub foreign_ink: Vec<(usize, Rect)>,
    /// **typst 合成的字形**（见 `DetachedInk`）：列表符号等
    pub detached_ink: Vec<DetachedInk>,
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
    collect_with_lookups(world, document, SpanRanges::for_world(world))
}

fn collect_with_lookups(
    world: &dyn World,
    document: &PagedDocument,
    mut ranges: SpanRanges,
) -> ((Vec<PlacedItem>, FrameStats), Vec<PlacedLink>) {
    let mut items = Vec::new();
    let mut links = Vec::new();
    let mut stats = FrameStats::default();
    let main_id = world.main();
    for (i, page) in document.pages().iter().enumerate() {
        walk_frame(
            world,
            main_id,
            &page.frame,
            i + 1,
            Transform::identity(),
            &mut items,
            &mut links,
            &mut stats,
            &mut ranges,
        );
    }
    ((items, stats), links)
}

/// 递归遍历帧。坐标映射与 typst-ide 的 `find_in_frame` 同构：
/// 子帧里的点 `p` 在本层的位置 = `pos + p.transform(group.transform)`。
///
/// `main_id` = 主文档的 `FileId`：**只有 span 属于主文档的项才进 `items`**（块几何、折行、
/// 命中都建立在"主文档字节偏移"上）；属于别的文件（`#include`）或解析不出区间的项进
/// `stats.foreign_ink`，供文字对应证明判断"带内有没有外来墨迹"。
#[allow(clippy::too_many_arguments)]
fn walk_frame(
    world: &dyn World,
    main_id: typst::syntax::FileId,
    frame: &Frame,
    page: usize,
    ts: Transform,
    out: &mut Vec<PlacedItem>,
    links: &mut Vec<PlacedLink>,
    stats: &mut FrameStats,
    ranges: &mut SpanRanges,
) {
    let mut equation: Option<(Range<usize>, typst::introspection::Location, Option<Rect>)> = None;
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Tag(typst::introspection::Tag::Start(elem, _))
                if elem.elem().name() == "equation" && elem.span().id() == Some(main_id) =>
            {
                if let Some(range) = world.range(elem.span()) {
                    equation = Some((range, elem.location().unwrap(), None));
                }
            }
            FrameItem::Tag(typst::introspection::Tag::End(location, _, _))
                if equation.as_ref().is_some_and(|(_, loc, _)| loc == location) =>
            {
                if let Some((range, _, Some(rect))) = equation.take() {
                    out.push(PlacedItem::new(
                        page,
                        range,
                        rect,
                        0.0,
                        PlacedItemKind::Formula,
                        Transform::identity(),
                    ));
                }
            }
            _ => {}
        }
        let before = out.len();
        // 与 typst-svg 同序：父变换 → 项平移 → 子组变换。
        let item_ts = ts.pre_concat(Transform::translate(pos.x, pos.y));
        let origin = Point::zero().transform(item_ts);
        match item {
            FrameItem::Text(text) => {
                stats.text_items += 1;
                stats.glyphs_total += text.glyphs.len();
                // 按字符数给字号投票（正文量最大，标题/代码只是少数）
                let key = (text.size.to_pt() * 100.0).round().max(0.0) as u32;
                *stats.size_weights.entry(key).or_insert(0) += text.text.chars().count().max(1);
                let mut x = Abs::zero();
                let font_size = typst::utils::hash128(&(&text.font, text.size));
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let (up, down) = ranges.ink(text, font_size, glyph.id);
                    let local = Rect::new(Point::new(x, -up), Point::new(x + advance, down));
                    // 只有**主文档**的字形才算这一块的几何：别的文件（include）里写下的
                    // 区间是那个文件的坐标，混进来就是错位。
                    //
                    // 三类要分开（实测）：① span 属于主文档且能解出区间 → 这一块的字形；
                    // ② span 属于**别的文件** → 真外源（计入 `foreign_ink`，文字证明要拦它）；
                    // ③ span 是 `None`（typst 自己合成的：列表符号 `•`/`1.`、`dif` 的 "d" 这类）
                    //    → 既不是主文档也不是别的文件，是这一块内容的合成件，**不算外来**。
                    match glyph.span.0.id() {
                        // 主文档的 span 却解不出区间：不多见，也不算外源
                        Some(id) if id == main_id => {
                            if let Some(range) = glyph_range(world, text, glyph, ranges) {
                                out.push(
                                    PlacedItem::new(
                                        page,
                                        range,
                                        local,
                                        0.0,
                                        PlacedItemKind::Text,
                                        item_ts,
                                    )
                                    .text_caret(text, glyph, x, item_ts),
                                );
                                stats.glyphs_mapped += 1;
                            }
                        }
                        Some(_) => stats
                            .foreign_ink
                            .push((page, transformed_rect(local, item_ts))),
                        None => {
                            // typst 合成的字形：列表符号要用它的可见文字，别的只是占位
                            if let Some(visible) = text.text.get(glyph.range()) {
                                if !visible.is_empty() {
                                    stats.detached_ink.push(DetachedInk {
                                        page,
                                        rect: transformed_rect(local, item_ts),
                                        baseline_pt: origin.y.to_pt(),
                                        text: visible.to_string(),
                                    });
                                }
                            }
                        }
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
                    main_id,
                    &group.frame,
                    page,
                    item_ts.pre_concat(group.transform),
                    out,
                    links,
                    stats,
                    ranges,
                );
            }
            FrameItem::Shape(shape, span) => {
                stats.shapes += 1;
                let bb = shape.bbox(true);
                let rect = transformed_rect(bb, item_ts);
                match span.id() {
                    Some(id) if id == main_id => {
                        if let Some(range) = ranges.get(world, *span) {
                            out.push(PlacedItem::new(
                                page,
                                range,
                                bb,
                                bb.min.y.to_pt(),
                                PlacedItemKind::Shape,
                                item_ts,
                            ));
                        }
                    }
                    // 别的文件画的东西：算外来墨迹（`None` = typst 合成件，不算）
                    Some(_) => stats.foreign_ink.push((page, rect)),
                    None => {}
                }
            }
            FrameItem::Image(_, size, span) => {
                stats.images += 1;
                let local = Rect::from_pos_size(Point::zero(), *size);
                let rect = transformed_rect(local, item_ts);
                match span.id() {
                    Some(id) if id == main_id => {
                        if let Some(range) = ranges.get(world, *span) {
                            out.push(PlacedItem::new(
                                page,
                                range,
                                local,
                                0.0,
                                PlacedItemKind::Image,
                                item_ts,
                            ));
                        }
                    }
                    Some(_) => stats.foreign_ink.push((page, rect)),
                    None => {}
                }
            }
            FrameItem::Link(dest, size) => {
                // 链接没有源位置，但有目标与方框：收下来给"切片上可点"用
                if let Some(href) = link_href(dest) {
                    links.push(PlacedLink {
                        page,
                        rect: transformed_rect(Rect::from_pos_size(Point::zero(), *size), item_ts),
                        href,
                    });
                }
            }
            // Tag 有 Location 但没有 Span（元素级定位另走 introspector，阶段 1 再说）
            FrameItem::Tag(_) => {}
        }
        if let Some((_, _, bounds)) = &mut equation {
            for item in &out[before..] {
                *bounds = Some(match *bounds {
                    Some(rect) => Rect::new(
                        Point::new(
                            rect.min.x.min(item.rect.min.x),
                            rect.min.y.min(item.rect.min.y),
                        ),
                        Point::new(
                            rect.max.x.max(item.rect.max.x),
                            rect.max.y.max(item.rect.max.y),
                        ),
                    ),
                    None => item.rect,
                });
            }
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
    ranges: &mut SpanRanges,
) -> Option<Range<usize>> {
    let base = ranges.get(world, glyph.span.0)?;
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
pub(crate) fn glyph_ink(text: &typst::text::TextItem, id: u16) -> (Abs, Abs) {
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

#[cfg(test)]
mod lookup_tests {
    use super::*;

    #[test]
    fn axis_aligned_bounds_match_four_corner_reference_including_mirrors() {
        use typst::layout::Ratio;
        let rect = Rect::new(
            Point::new(Abs::pt(-3.5), Abs::pt(2.75)),
            Point::new(Abs::pt(8.25), Abs::pt(19.5)),
        );
        for sx in [-2.0, -0.25, 0.0, 0.5, 1.0, 3.0] {
            for sy in [-2.0, 0.0, 0.5, 1.0] {
                for (kx, ky) in [(0.0, 0.0), (0.7, 0.0), (0.0, -0.5), (0.7, -0.5)] {
                    let ts = Transform {
                        sx: Ratio::new(sx),
                        sy: Ratio::new(sy),
                        kx: Ratio::new(kx),
                        ky: Ratio::new(ky),
                        tx: Abs::pt(20.5),
                        ty: Abs::pt(-15.75),
                    };
                    let points = [
                        rect.min,
                        Point::new(rect.max.x, rect.min.y),
                        rect.max,
                        Point::new(rect.min.x, rect.max.y),
                    ]
                    .map(|p| p.transform(ts));
                    let mut min = points[0];
                    let mut max = points[0];
                    for p in &points[1..] {
                        min.x = min.x.min(p.x);
                        min.y = min.y.min(p.y);
                        max.x = max.x.max(p.x);
                        max.y = max.y.max(p.y);
                    }
                    assert_eq!(transformed_rect(rect, ts), Rect::new(min, max));
                }
            }
        }
    }

    #[test]
    fn cached_geometry_matches_world_ranges_and_font_metrics_across_revisions() {
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        for body in ["中文 office 😀 é", "改后的中文 office 😀 é"] {
            let src = format!("#set page(width: 300pt, height: 400pt)\n{body} $x^2 + y$\n\n- 列表\n\n#block(fill: yellow, inset: 5pt)[小字 #text(size: 8pt)[重复]]\n#rotate(20deg)[旋转]\n#scale(x: 120%)[缩放]\n#link(\"https://typst.app\")[链接]\n#pagebreak()\n#table(columns: 2, [甲], [乙])");
            let world = TypstWorld::new(src, None, &fonts, &FontConfig::default());
            let document = typst::compile::<PagedDocument>(&world).output.unwrap();
            let lookup = SpanRanges::for_world(&world);
            for (&span, range) in &lookup.spans {
                assert_eq!(*range, world.range(span), "Span 索引必须与 World 相同");
            }
            let cached = collect_with_lookups(&world, &document, lookup);
            let original = collect_with_lookups(
                &world,
                &document,
                SpanRanges {
                    uncached: true,
                    ..SpanRanges::default()
                },
            );
            assert_eq!(format!("{cached:?}"), format!("{original:?}"));
        }
    }
}
