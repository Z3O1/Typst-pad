// 整页帧遍历：字形 Span → 主源字节区间与可见几何。
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
    /// 同一行的上下标、分式墨迹顶不同，基线用于判定行归属。
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

/// 非主源的可见墨迹不能映射为主文档字符，用于整页命中排除。
#[derive(Debug, Default)]
pub struct FrameStats {
    pub foreign_ink: Vec<(usize, Rect)>,
}
/// 遍历所有页的帧，收集"有源位置的项"的几何。
///
/// `world.range(span)` 把 `Span` 解成**编译那一份 `Source`** 上的字节区间 —— 必须用编译时的
/// world，不能拿最新文本来解旧帧（`Span` 是编译期的节点编号，文本一改编号就漂）。
#[cfg(test)]
pub fn collect_geometry(
    world: &dyn World,
    document: &PagedDocument,
) -> (Vec<PlacedItem>, FrameStats) {
    collect_with_lookups(world, document, SpanRanges::for_world(world))
}

/// 整页只收集主源项与外源墨迹，链接直接由完整 SVG 承载。
pub(crate) fn collect_document_geometry(
    world: &dyn World,
    document: &PagedDocument,
) -> (Vec<PlacedItem>, Vec<(usize, Rect)>) {
    let (items, stats) = collect_with_lookups(world, document, SpanRanges::for_world(world));
    (items, stats.foreign_ink)
}

fn collect_with_lookups(
    world: &dyn World,
    document: &PagedDocument,
    mut ranges: SpanRanges,
) -> (Vec<PlacedItem>, FrameStats) {
    let mut items = Vec::new();
    let mut stats = FrameStats::default();
    let main_id = world.main();
    for (i, page) in document.pages().iter().enumerate() {
        walk_frame(
            world,
            main_id,
            &page.frame,
            i + 1,
            Transform::identity(),
            true,
            None,
            &mut items,
            &mut stats,
            &mut ranges,
        );
    }
    (items, stats)
}

/// 递归遍历帧。坐标映射与 typst-ide 的 `find_in_frame` 同构：
/// 子帧里的点 `p` 在本层的位置 = `pos + p.transform(group.transform)`。
///
/// 只有主源 Span 进入 `items`；外源项进入 `foreign_ink`，不冒充主源坐标。
#[allow(clippy::too_many_arguments)]
fn walk_frame(
    world: &dyn World,
    main_id: typst::syntax::FileId,
    frame: &Frame,
    page: usize,
    ts: Transform,
    soft_clip_is_translation: bool,
    clip: Option<Rect>,
    out: &mut Vec<PlacedItem>,
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
        match item {
            FrameItem::Text(text) => {
                if clip.is_some()
                    && text_ink_bounds(text)
                        .is_some_and(|bb| outside_clip(transformed_rect(bb, item_ts), clip))
                {
                    continue;
                }
                let mut x = Abs::zero();
                let font_size = typst::utils::hash128(&(&text.font, text.size));
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    let (up, down) = ranges.ink(text, font_size, glyph.id);
                    let local = Rect::new(Point::new(x, -up), Point::new(x + advance, down));
                    // 主源字形映射到文档偏移；外源墨迹单列；无 Span 的合成件不当作字符。
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
                            }
                        }
                        Some(_) => stats
                            .foreign_ink
                            .push((page, transformed_rect(local, item_ts))),
                        None => {}
                    }
                    x += advance;
                }
            }
            FrameItem::Group(group) => {
                let child_ts = item_ts.pre_concat(group.transform);
                // typst-svg 在 Hard 组输出完整 transform 并重置内部状态；Soft
                // 组的 clip 只使用最近 Hard 坐标系中的平移，不应用线性变换。
                // 只有这段 Soft 链全为平移时，child_ts 才能正确映射 clip。
                // 无法证明一致时不收紧祖先边界，避免剔除仍可见的 cover 图片。
                let child_soft_clip_is_translation = group.frame.kind() == FrameKind::Hard
                    || (soft_clip_is_translation
                        && group.transform
                            == Transform::translate(group.transform.tx, group.transform.ty));
                let child_clip = group.clip.as_ref().map_or(clip, |curve| {
                    if !child_soft_clip_is_translation {
                        return clip;
                    }
                    let bounds = transformed_rect(curve.bbox(None), child_ts);
                    if !finite_rect(bounds) {
                        return clip;
                    }
                    Some(match clip {
                        Some(parent) => {
                            Rect::new(parent.min.max(bounds.min), parent.max.min(bounds.max))
                        }
                        None => bounds,
                    })
                });
                walk_frame(
                    world,
                    main_id,
                    &group.frame,
                    page,
                    child_ts,
                    child_soft_clip_is_translation,
                    child_clip,
                    out,
                    stats,
                    ranges,
                );
            }
            FrameItem::Shape(shape, span) => {
                let bb = shape.bbox(true);
                let rect = transformed_rect(bb, item_ts);
                if outside_clip(rect, clip) {
                    continue;
                }
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
                let local = Rect::from_pos_size(Point::zero(), *size);
                let rect = transformed_rect(local, item_ts);
                if outside_clip(rect, clip) {
                    continue;
                }
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
            FrameItem::Link(_, _) => {}
            // 公式标签已在上方归并；其他标签不参与字符命中。
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

fn finite_rect(rect: Rect) -> bool {
    [rect.min.x, rect.min.y, rect.max.x, rect.max.y]
        .iter()
        .all(|v| v.to_pt().is_finite())
}

// 只证明完全在有效裁剪包围盒之外；不判断任意曲线内部，也不收缩部分可见项。
fn outside_clip(rect: Rect, clip: Option<Rect>) -> bool {
    clip.is_some_and(|clip| {
        finite_rect(rect)
            && (clip.min.x > clip.max.x
                || clip.min.y > clip.max.y
                || rect.max.x < clip.min.x
                || rect.min.x > clip.max.x
                || rect.max.y < clip.min.y
                || rect.min.y > clip.max.y)
    })
}

fn text_ink_bounds(text: &typst::text::TextItem) -> Option<Rect> {
    let tables = text.font.ttf().tables();
    // TextItem::bbox 包含字号、字形偏移/垂直 advance 和斜体 overhang，
    // 不是 advance box。整段排除避免为逐字形 bbox 克隆 TextItem/分配。
    // 彩色/位图/SVG 字形与描边不能由 outline bbox 保守界定，保留它们。
    if text.stroke.is_some()
        || tables.colr.is_some()
        || tables.svg.is_some()
        || tables.sbix.is_some()
        || tables.cbdt.is_some()
        || tables.ebdt.is_some()
        || tables.bdat.is_some()
    {
        return None;
    }
    let bb = text.bbox();
    finite_rect(bb).then_some(bb)
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

#[cfg(test)]
mod lookup_tests {
    use super::*;
    use typst::layout::Size;

    #[test]
    fn scaled_cover_image_inside_nested_clips_keeps_visible_geometry() {
        let image = r#"#image(bytes("<svg xmlns='http://www.w3.org/2000/svg' width='200' height='20'><rect width='200' height='20' fill='red'/></svg>"), format: "svg", width: 20pt, height: 20pt, fit: "cover")"#;
        let dir = std::env::temp_dir().join(format!("typst-cover-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cover.typ"), image).unwrap();
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        let mut old_visible = None;
        for outer_affine in [false, true] {
            for imported in [false, true] {
                for (dx, visible) in [(-10, true), (-30, false)] {
                    let body = if imported {
                        "#include \"cover.typ\""
                    } else {
                        image
                    };
                    let body = format!("#box(width: 20pt, height: 20pt, clip: true)[#box(width: 20pt, height: 20pt, clip: true)[#move(dx: {dx}pt)[#scale(x: 10%, y: 100%, origin: top + left)[{body}]]]]");
                    let body = if outer_affine {
                        format!("#rotate(25deg, origin: top + left)[#scale(x: 150%, y: 75%, origin: top + left)[{body}]]")
                    } else {
                        body
                    };
                    let source =
                        format!("#set page(width: 300pt, height: 300pt, margin: 0pt)\n{body}");
                    let path = Some(dir.join("main.typ").to_string_lossy().into_owned());
                    let world = TypstWorld::new(
                        source.clone(),
                        path.clone(),
                        &fonts,
                        &FontConfig::default(),
                    );
                    let document = typst::compile::<PagedDocument>(&world).output.unwrap();
                    let svg =
                        typst_svg::svg(&document.pages()[0], &typst_svg::SvgOptions::default());
                    if !outer_affine && visible {
                        // SVG's image occupies [-19, 1] × [0, 20], its Soft clip
                        // [-10, 10] × [0, 20], and both Hard clips [0, 20]².
                        // Their intersection has positive area: [0, 1] × [0, 20].
                        assert!(svg.contains("<image transform=\"matrix(0.1 0 0 1 -19 0)\""));
                        assert!(svg.contains("d=\"M -10 0h 20v 20h -20Z \""));
                        assert!(svg.contains("d=\"M 0 0h 20v 20h -20Z \""));
                        assert_eq!(svg.matches("clip-path=").count(), 3);
                    }
                    let (items, foreign) = collect_document_geometry(&world, &document);
                    assert_eq!(
                        items
                            .iter()
                            .filter(|item| item.kind == PlacedItemKind::Image)
                            .count(),
                        usize::from(visible && !imported)
                    );
                    assert_eq!(foreign.len(), usize::from(visible && imported));
                    if !imported {
                        let output = crate::typst_world::compile(
                            source.clone(),
                            path,
                            &fonts,
                            &FontConfig::default(),
                        );
                        assert!(output.ok);
                        assert_eq!(output.pages, vec![svg]);
                        let from = source.find("#image").unwrap();
                        let id = output.geometry_id.unwrap();
                        assert_eq!(
                            !crate::document_geometry::selection(id, from, from + image.len())
                                .is_empty(),
                            visible
                        );
                        if let Some((old_id, old_from)) = old_visible {
                            assert!(
                                !crate::document_geometry::selection(
                                    old_id,
                                    old_from,
                                    old_from + image.len()
                                )
                                .is_empty(),
                                "later compilation must not alter the visible snapshot"
                            );
                        }
                        if visible {
                            old_visible = Some((id, from));
                        }
                    }
                }
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clipped_italic_ink_overhang_is_not_culled_using_advance_bounds() {
        fn find_italic(frame: &Frame) -> Option<typst::text::TextItem> {
            frame.items().find_map(|(_, item)| match item {
                FrameItem::Text(text) if text.glyphs.len() == 1 => Some(text.clone()),
                FrameItem::Group(group) => find_italic(&group.frame),
                _ => None,
            })
        }
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        let world = TypstWorld::new(
            "#set text(size: 40pt)\n$italic(j)$".into(),
            None,
            &fonts,
            &FontConfig::default(),
        );
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let text = find_italic(&document.pages()[0].frame).unwrap();
        let bb = text_ink_bounds(&text).unwrap();
        let right_overhang = bb.max.x - text.width();
        let left_overhang = -bb.min.x;
        assert!(
            right_overhang > Abs::zero() || left_overhang > Abs::zero(),
            "bundled math italic j must overhang its advance: {bb:?}, width={:?}",
            text.width()
        );
        let x = if right_overhang > Abs::zero() {
            -text.width() - right_overhang / 2.0
        } else {
            Abs::pt(20.0) + left_overhang / 2.0
        };
        let mut frame = Frame::soft(Size::new(Abs::pt(20.0), Abs::pt(60.0)));
        frame.push(Point::new(x, Abs::pt(40.0)), FrameItem::Text(text));
        let local_clip = Rect::from_pos_size(Point::zero(), frame.size());
        for ts in [
            Transform::identity(),
            Transform {
                sx: typst::layout::Ratio::new(1.5),
                sy: typst::layout::Ratio::new(0.75),
                kx: typst::layout::Ratio::new(0.3),
                ky: typst::layout::Ratio::new(-0.2),
                tx: Abs::pt(35.0),
                ty: Abs::pt(20.0),
            },
        ] {
            let mut items = Vec::new();
            walk_frame(
                &world,
                world.main(),
                &frame,
                1,
                ts,
                true,
                Some(transformed_rect(local_clip, ts)),
                &mut items,
                &mut FrameStats::default(),
                &mut SpanRanges::for_world(&world),
            );
            assert!(
                !items.is_empty(),
                "visible overhang must survive even when the advance box is wholly outside"
            );
        }
    }

    #[test]
    fn document_collection_clips_foreign_ink_across_edits() {
        let dir = std::env::temp_dir().join(format!("typst-collector-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("body.typ"), "外源 office").unwrap();
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        for body in ["中文 office 😀 é", "改后的中文 office 😀 é"] {
            let source = format!("#set page(width: 300pt, height: 400pt)\n{body}\n- #link(\"https://typst.app\")[列表]\n$frac(x^2, y)$\n#include \"body.typ\"\n#box(width: 20pt, height: 20pt, clip: true)[#move(dx: 100pt)[#include \"body.typ\"]]\n#rotate(25deg)[旋转]\n#image(bytes(\"<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10'/></svg>\"), format: \"svg\")\n#pagebreak()\n#table(columns: 2, [甲], [乙])");
            let document_path = Some(dir.join("main.typ").to_string_lossy().into_owned());
            let world = TypstWorld::new(
                source.clone(),
                document_path.clone(),
                &fonts,
                &FontConfig::default(),
            );
            let document = typst::compile::<PagedDocument>(&world).output.unwrap();
            let (items, foreign) = collect_document_geometry(&world, &document);
            assert!(!items.is_empty());
            assert!(!foreign.is_empty());
            let unclipped_world = TypstWorld::new(
                source.replace("clip: true", "clip: false"),
                document_path,
                &fonts,
                &FontConfig::default(),
            );
            let unclipped_document = typst::compile::<PagedDocument>(&unclipped_world)
                .output
                .unwrap();
            let (_, unclipped_foreign) =
                collect_document_geometry(&unclipped_world, &unclipped_document);
            assert!(
                unclipped_foreign.len() > foreign.len(),
                "fully hidden included text must not contribute foreign ink"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

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
