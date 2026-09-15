// 阶段 0 探针：**源块 ↔ 版面区域的几何映射**（见 `docs/文档模式渲染保真-调研.md` 第三节 / 第八节）。
//
// 要回答的问题只有一个：**整篇按写作模式的版心宽编译一次之后，能不能把每一个源块在页面上所占的
// 那一块几何（页号 + x/y + 宽高）算出来？** 这是"渲染表面 + 源码透镜"方案的唯一真风险点 ——
// 覆盖率、连续性、耗时都要先量出来，再决定要不要动前端。
//
// 本模块**不改产品行为**：只提供纯函数 + 一份统计报告，目前只被测试调用（阶段 1 再接 Tauri 命令）。
//
// 三条关键事实（逐条核对过 typst 0.15.1 源码，见调研文档 3.2 的 API 表）：
//   * **每个字形自带源位置**：`Glyph.span: (Span, u16)`（`typst-library/src/text/item.rs:109`），
//     `Span` 给源节点、`u16` 给节点内子偏移 ⇒ 字形 → 源字节区间是通的可算的；
//   * **子帧坐标要按 `pos + p.transform(group.transform)` 映射回本层**（与 typst-ide 的
//     `find_in_frame` 同构；tinymist 自己抄的那份留着 `// TODO: Handle transformation.`，
//     说明变换是真坑，所以这里显式统计"带变换的 group"有多少）；
//   * `Shape`/`Image` 带**裸 `Span`**（不是 `Option`），`Group`/`Link`/`Tag` 不带源位置；
//     **导出格式里没有任何源信息**（SVG 只有 `data-typst-label`），所以映射只能做在内存的帧上。
//
// 未做的事（阶段 1 再说，别当成已解决）：
//   * 不处理 `FiledId` 不是主文档的项（include 进来的文件）——只统计主文档；
//   * 不处理嵌套列表项的细粒度（整段 ListItem 算一个块）；
//   * 切片的 `fill` 沿用原页设置（阶段 1 要决定透明还是白底）。

use std::ops::Range;
use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use typst::layout::{Abs, Frame, FrameItem, FrameKind, Point, Rect, Size, Transform};
use typst::syntax::{SyntaxKind, SyntaxNode};
use typst::text::{BottomEdge, BottomEdgeMetric, TextEdgeBounds, TopEdge, TopEdgeMetric};
use typst::{World, WorldExt};
use typst_layout::{Page, PagedDocument};
use typst_svg::SvgOptions;

use crate::typst_world::{FontConfig, TypstWorld};

/// 一个**源块**：语法树顶层节点，或者一段连续的行内内容（= typst 的一个段落）
#[derive(Debug, Clone)]
pub struct SourceBlock {
    pub kind: &'static str,
    pub range: Range<usize>,
}

/// 帧里一项的几何 + 它对应的源字节区间（页面坐标，单位 pt）
#[derive(Debug, Clone)]
pub struct PlacedItem {
    pub page: usize,
    pub range: Range<usize>,
    pub rect: Rect,
}

/// 帧遍历的统计（用来判断"映射漏了多少"而不是只看最终覆盖率）
#[derive(Debug, Default, Clone, Copy)]
pub struct FrameStats {
    pub text_items: usize,
    pub glyphs_total: usize,
    pub glyphs_mapped: usize,
    pub groups: usize,
    pub transformed_groups: usize,
    pub clipped_groups: usize,
    pub shapes: usize,
    pub images: usize,
}

/// 这些语法树顶层节点各自**独占一个流式块**（typst 的排版也是以它们分块的）
const BLOCK_KINDS: &[SyntaxKind] = &[
    SyntaxKind::Heading,
    SyntaxKind::ListItem,
    SyntaxKind::EnumItem,
    SyntaxKind::TermItem,
];

/// 这些节点**只有独占整行时**才自成一块：行内 `$x$`、行内 `` `code` `` 必须留在段落里
/// （否则一个段落会被切成三段，块级 widget 会把段落截断 —— 实测踩到过）。
const LINE_ONLY_KINDS: &[SyntaxKind] = &[SyntaxKind::Raw, SyntaxKind::Equation, SyntaxKind::Code];

/// 按**语法树顶层节点**切分源块。
///
/// 规则（保守优先，宁可把两块合一块，也不要把一块拆错）：
///   1. `Parbreak`（空行）结束当前段落；
///   2. `BLOCK_KINDS` 里的节点独占一块（标题 / 列表项 / 围栏代码 / 行间公式）；
///   3. 独占整行的 `#...` 代码表达式（`#let` / `#set` / `#show` / `#figure(...)` / `#table(...)`）
///      也独占一块 —— 判据是"该节点之前的字节在所在行里全是空白"；
///   4. 其余（`Text` / `Strong` / `Emph` / 行内公式 / 行内代码 / `Space` …）累加成一个段落块。
pub fn source_blocks(src: &str) -> Vec<SourceBlock> {
    let root: SyntaxNode = typst_syntax::parse(src);
    let mut out: Vec<SourceBlock> = Vec::new();
    // 当前段落块的范围（None = 还没有开始）
    let mut para: Option<Range<usize>> = None;
    // 子节点字节偏移的累加游标（见下面循环里的说明）
    let mut cursor = 0usize;

    let close_para = |para: &mut Option<Range<usize>>, out: &mut Vec<SourceBlock>| {
        if let Some(r) = para.take() {
            if r.end > r.start {
                out.push(SourceBlock { kind: "Paragraph", range: r });
            }
        }
    };

    for node in root.children() {
        // `typst_syntax::parse` 的树是**未 numberize** 的（span 要等 `Source::new` 才编上号），
        // 所以字节区间按"子节点字节长度依次累加"重建 —— `SyntaxNode::len()` 就是节点在源文本里的
        // 字节长度，且解析树的子节点连续覆盖父节点（trivia 也在树里）。
        let start = cursor;
        let end = start + node.len();
        cursor = end;
        let range = start..end;
        if range.is_empty() {
            continue;
        }
        let kind = node.kind();

        // 空行 / 注释 / 空白：不算块内容，但空行要断开段落
        if matches!(kind, SyntaxKind::Parbreak) {
            close_para(&mut para, &mut out);
            continue;
        }
        if matches!(
            kind,
            SyntaxKind::Space | SyntaxKind::LineComment | SyntaxKind::BlockComment
        ) {
            continue;
        }

        let own_block = BLOCK_KINDS.contains(&kind)
            || (LINE_ONLY_KINDS.contains(&kind) && is_alone_on_line(src, range.start, range.end));

        if own_block {
            close_para(&mut para, &mut out);
            out.push(SourceBlock { kind: kind_name(kind), range });
            continue;
        }

        para = match para {
            Some(r) => Some(r.start..r.end.max(range.end)),
            None => Some(range.start..range.end),
        };
    }
    close_para(&mut para, &mut out);
    out
}

/// 该字节区间是否"独占整行"（前一行的残余与本行的后续都只有空白）
fn is_alone_on_line(src: &str, start: usize, end: usize) -> bool {
    let line_start = src[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = src[end..].find('\n').map(|i| end + i).unwrap_or(src.len());
    src[line_start..start].trim().is_empty() && src[end..line_end].trim().is_empty()
}

fn kind_name(kind: SyntaxKind) -> &'static str {
    match kind {
        SyntaxKind::Heading => "Heading",
        SyntaxKind::ListItem => "ListItem",
        SyntaxKind::EnumItem => "EnumItem",
        SyntaxKind::TermItem => "TermItem",
        SyntaxKind::Raw => "Raw",
        SyntaxKind::Equation => "Equation",
        SyntaxKind::Code => "Code",
        _ => "Other",
    }
}

/// 遍历所有页的帧，收集"有源位置的项"的几何。
///
/// `world.range(span)` 把 `Span` 解成**编译那一份 `Source`** 上的字节区间 —— 必须用编译时的
/// world，不能拿最新文本来解旧帧（`Span` 是编译期的节点编号，文本一改编号就漂）。
pub fn collect_geometry(world: &dyn World, document: &PagedDocument) -> (Vec<PlacedItem>, FrameStats) {
    let mut items = Vec::new();
    let mut stats = FrameStats::default();
    for (i, page) in document.pages().iter().enumerate() {
        walk_frame(world, &page.frame, i + 1, Point::zero(), Transform::identity(), &mut items, &mut stats);
    }
    (items, stats)
}

/// 递归遍历帧。坐标映射与 typst-ide 的 `find_in_frame` 同构：
/// 子帧里的点 `p` 在本层的位置 = `pos + p.transform(group.transform)`。
fn walk_frame(
    world: &dyn World,
    frame: &Frame,
    page: usize,
    offset: Point,
    ts: Transform,
    out: &mut Vec<PlacedItem>,
    stats: &mut FrameStats,
) {
    for (pos, item) in frame.items() {
        // 该项原点在本层坐标系里的页面坐标（ts 是"本帧内容相对页面"的变换，顶层为 identity）
        let origin = Point::new(
            offset.x + pos.x,
            offset.y + pos.y,
        ).transform(ts);
        match item {
            FrameItem::Text(text) => {
                stats.text_items += 1;
                stats.glyphs_total += text.glyphs.len();
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
                        out.push(PlacedItem { page, range, rect });
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
                walk_frame(world, &group.frame, page, origin, group.transform, out, stats);
            }
            FrameItem::Shape(shape, span) => {
                stats.shapes += 1;
                if let Some(range) = world.range(*span) {
                    let bb = shape.bbox(true);
                    let rect = Rect::new(
                        Point::new(origin.x + bb.min.x, origin.y + bb.min.y),
                        Point::new(origin.x + bb.max.x, origin.y + bb.max.y),
                    );
                    out.push(PlacedItem { page, range, rect });
                }
            }
            FrameItem::Image(_, size, span) => {
                stats.images += 1;
                if let Some(range) = world.range(*span) {
                    let rect = Rect::new(origin, Point::new(origin.x + size.x, origin.y + size.y));
                    out.push(PlacedItem { page, range, rect });
                }
            }
            // Link 没有源位置；Tag 有 Location 但没有 Span（元素级定位另走 introspector，阶段 1 再说）
            FrameItem::Link(_, _) | FrameItem::Tag(_) => {}
        }
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
    let len = text
        .text
        .get(glyph.range())
        .map(|s| s.len())
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

// ---------------------------------------------------------------------------
// 探针：一批真实文档跑一遍，把"能不能切"变成数字
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBlock {
    pub kind: String,
    pub line: u32,
    pub end_line: u32,
    pub start: usize,
    pub end: usize,
    pub preview: String,
    pub items: usize,
    pub found: bool,
    pub pages: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub bands: usize,
    pub render_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub ok: bool,
    pub error: Option<String>,
    pub pages: usize,
    pub page_width_pt: f64,
    pub compile_ms: f64,
    pub blocks_total: usize,
    pub blocks_found: usize,
    /// 字节口径（含换行/空格，仅供参照）
    pub src_bytes: usize,
    pub covered_bytes: usize,
    /// **字符口径**：非空白字符里，有多少被渲染项覆盖 —— 这才是"有没有漏渲染"的判据
    pub content_chars: usize,
    pub covered_chars: usize,
    pub coverage_ratio: f64,
    /// 完全没被渲染的字节所在行（代码块标题行、空行、`#set` 行等，属正常；用来核对有没有漏渲染）
    pub uncovered_lines: Vec<u32>,
    /// 块按 y 序排列后是否单调不减（不单调 = 有内容被排到别处，例如脚注落到页底）
    pub y_monotonic: bool,
    /// 相邻块之间的纵向空隙（pt）：正=空隙，负=重叠
    pub min_gap_pt: f64,
    pub max_gap_pt: f64,
    pub negative_gaps: usize,
    pub text_items: usize,
    pub glyphs_total: usize,
    pub glyphs_mapped: usize,
    pub transformed_groups: usize,
    pub clipped_groups: usize,
    pub shapes: usize,
    pub images: usize,
    /// 整页渲一次 vs 逐块切片的耗时对比（切片方案的性能上限）
    pub full_page_render_ms: f64,
    pub crop_render_ms_total: f64,
    /// 逐块切片产物的字节总数（判断"一块一渲"的 IPC/DOM 开销）
    pub crop_bytes_total: usize,
    pub blocks: Vec<ProbeBlock>,
}

/// 按写作模式的形态编译（版心宽 + `page(height: auto)` 单张长页），然后跑一遍探针。
///
/// **不改产品行为**：这条链路与 `compile_with_page_width`（源码模式预览）分开，
/// 阶段 1 才会接进编辑器。
pub fn probe_blocks(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    page_width_pt: f64,
) -> ProbeReport {
    // 与预览同一套版心参数：A4 宽度下的默认页边距按比例缩放，页高随内容（单张长页，无分页）
    let margin = page_width_pt * (70.87 / 595.28);
    let injected = format!(
        "#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin:.2}pt)\n"
    );
    let compiled_src = format!("{injected}{src}");
    let injected_len = injected.len();

    let t0 = Instant::now();
    let world = TypstWorld::new(compiled_src, document_path, fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned { output: Ok(doc), .. } => doc,
        typst::diag::Warned { output: Err(errors), .. } => {
            return ProbeReport {
                ok: false,
                error: Some(format!("编译失败：{} 处错误（{}）", errors.len(), errors[0].message)),
                pages: 0,
                page_width_pt,
                compile_ms: t0.elapsed().as_secs_f64() * 1000.0,
                blocks_total: 0,
                blocks_found: 0,
                src_bytes: src.len(),
                covered_bytes: 0,
                content_chars: 0,
                covered_chars: 0,
                coverage_ratio: 0.0,
                uncovered_lines: Vec::new(),
                y_monotonic: true,
                min_gap_pt: 0.0,
                max_gap_pt: 0.0,
                negative_gaps: 0,
                text_items: 0,
                glyphs_total: 0,
                glyphs_mapped: 0,
                transformed_groups: 0,
                clipped_groups: 0,
                shapes: 0,
                images: 0,
                full_page_render_ms: 0.0,
                crop_render_ms_total: 0.0,
                crop_bytes_total: 0,
                blocks: Vec::new(),
            };
        }
    };
    let compile_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // 整页渲一次（对照组）
    let t_page = Instant::now();
    for page in document.pages() {
        let _ = typst_svg::svg(page, &SvgOptions::default());
    }
    let full_page_render_ms = t_page.elapsed().as_secs_f64() * 1000.0;

    let blocks = source_blocks(&src);
    let (items, stats) = collect_geometry(&world, &document);

    let mut out_blocks: Vec<ProbeBlock> = Vec::with_capacity(blocks.len());
    let mut crop_ms_total = 0.0;
    let mut crop_bytes_total = 0usize;
    for block in &blocks {
        // 编译源比用户文档多了一行注入，匹配时把块的区间平移到编译源坐标系
        let injected_range = (block.range.start + injected_len)..(block.range.end + injected_len);
        let geom = geometry_for_range(&items, injected_range);
        let (line, _) = offset_to_line_column(&src, block.range.start);
        let (end_line, _) = offset_to_line_column(&src, block.range.end.saturating_sub(1).max(block.range.start));
        let mut render_ms = 0.0;
        if let Some(g) = &geom {
            if let Some(page) = document.pages().get(g.page.saturating_sub(1)) {
                let t = Instant::now();
                let svg = render_crop(page, g.rect);
                render_ms = t.elapsed().as_secs_f64() * 1000.0;
                crop_ms_total += render_ms;
                crop_bytes_total += svg.len();
            }
        }
        out_blocks.push(ProbeBlock {
            kind: block.kind.to_string(),
            line,
            end_line,
            start: block.range.start,
            end: block.range.end,
            preview: preview_of(&src, block.range.clone()),
            items: geom.as_ref().map(|g| g.items).unwrap_or(0),
            found: geom.is_some(),
            pages: geom.as_ref().map(|g| g.pages).unwrap_or(0),
            x: geom.as_ref().map(|g| g.rect.min.x.to_pt()).unwrap_or(0.0),
            y: geom.as_ref().map(|g| g.rect.min.y.to_pt()).unwrap_or(0.0),
            w: geom.as_ref().map(|g| g.rect.size().x.to_pt()).unwrap_or(0.0),
            h: geom.as_ref().map(|g| g.rect.size().y.to_pt()).unwrap_or(0.0),
            bands: geom.as_ref().map(|g| g.bands).unwrap_or(0),
            render_ms,
        });
    }

    // 覆盖字节：把项的源区间（减回注入偏移）裁到用户文档范围内后求并集
    let mut intervals: Vec<(usize, usize)> = items
        .iter()
        .filter_map(|i| {
            let s = i.range.start.saturating_sub(injected_len);
            let e = i.range.end.saturating_sub(injected_len).min(src.len());
            if s < e { Some((s, e)) } else { None }
        })
        .collect();
    intervals.sort_unstable();
    let mut covered = 0usize;
    let mut cur: Option<(usize, usize)> = None;
    let mut uncovered_lines: Vec<u32> = Vec::new();
    for (s, e) in intervals {
        match cur {
            Some((cs, ce)) if s <= ce => cur = Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                covered += ce - cs;
                cur = Some((s, e));
            }
            None => cur = Some((s, e)),
        }
    }
    if let Some((cs, ce)) = cur {
        covered += ce - cs;
    }
    // 未被覆盖的行（按行统计，只报前 40 行，避免报告过长）
    let mut line_start = 0usize;
    let mut line_no = 1u32;
    let covered_ranges = merge_ranges(
        items
            .iter()
            .filter_map(|i| {
                let s = i.range.start.saturating_sub(injected_len);
                let e = i.range.end.saturating_sub(injected_len).min(src.len());
                if s < e { Some((s, e)) } else { None }
            })
            .collect(),
    );
    // 字符口径：非空白字符中有多少被覆盖（换行/空格不算"该渲染的内容"）
    let mut content_chars = 0usize;
    let mut covered_chars = 0usize;
    for (i, c) in src.char_indices() {
        if c.is_whitespace() {
            continue;
        }
        content_chars += 1;
        if covered_ranges.iter().any(|(s, e)| *s <= i && i < *e) {
            covered_chars += 1;
        }
    }

    while line_start <= src.len() {
        let line_end = src[line_start..].find('\n').map(|i| line_start + i).unwrap_or(src.len());
        if !src[line_start..line_end].trim().is_empty()
            && !covered_ranges.iter().any(|(s, e)| *s < line_end && *e > line_start)
            && uncovered_lines.len() < 40
        {
            uncovered_lines.push(line_no);
        }
        if line_end >= src.len() {
            break;
        }
        line_start = line_end + 1;
        line_no += 1;
    }

    // 连续性：只对"找得到几何"的块按 (page, y) 排序后看相邻块之间的空隙
    let mut found: Vec<&ProbeBlock> = out_blocks.iter().filter(|b| b.found).collect();
    found.sort_by(|a, b| (a.pages, a.y).partial_cmp(&(b.pages, b.y)).unwrap());
    let mut min_gap = f64::INFINITY;
    let mut max_gap = f64::NEG_INFINITY;
    let mut negative = 0usize;
    let mut monotonic = true;
    let mut prev_bottom: Option<f64> = None;
    for b in &found {
        if let Some(pb) = prev_bottom {
            let gap = b.y - pb;
            min_gap = min_gap.min(gap);
            max_gap = max_gap.max(gap);
            if gap < -0.01 {
                negative += 1;
                monotonic = false;
            }
        }
        prev_bottom = Some(b.y + b.h);
    }
    if !found.is_empty() && min_gap.is_finite() == false {
        min_gap = 0.0;
    }
    if max_gap == f64::NEG_INFINITY {
        max_gap = 0.0;
    }

    ProbeReport {
        ok: true,
        error: None,
        pages: document.pages().len(),
        page_width_pt,
        compile_ms,
        blocks_total: out_blocks.len(),
        blocks_found: out_blocks.iter().filter(|b| b.found).count(),
        src_bytes: src.len(),
        covered_bytes: covered,
        content_chars,
        covered_chars,
        coverage_ratio: covered_chars as f64 / content_chars.max(1) as f64,
        uncovered_lines,
        y_monotonic: monotonic,
        min_gap_pt: min_gap,
        max_gap_pt: max_gap,
        negative_gaps: negative,
        text_items: stats.text_items,
        glyphs_total: stats.glyphs_total,
        glyphs_mapped: stats.glyphs_mapped,
        transformed_groups: stats.transformed_groups,
        clipped_groups: stats.clipped_groups,
        shapes: stats.shapes,
        images: stats.images,
        full_page_render_ms,
        crop_render_ms_total: crop_ms_total,
        crop_bytes_total,
        blocks: out_blocks,
    }
}

/// 把一个矩形区域从页里切出来单独渲成 SVG（阶段 1 的渲染路径原型）。
///
/// 做法：克隆原页（`Page: Clone`，字段全 pub）→ 把顶层项整体平移到以 `rect.min` 为原点 →
/// 帧尺寸设为矩形尺寸 → `typst_svg::svg` 导出。**视口即裁剪框**（与公式页同一原理，
/// 见 `typst_world.rs` 的 `ink_bounds_of_frame` 注释）。
fn render_crop(page: &Page, rect: Rect) -> String {
    let size = rect.size();
    let mut frame = Frame::new(size, FrameKind::Hard);
    // 只压入与切片相交的项：整页项全压会让 SVG 渲染器遍历整页内容，实测"逐块切片合计"
    // 反而比"整页渲一次"贵一个数量级（8 块 100ms vs 整页 17.6ms）。留 2pt 余量，
    // 因为 typst 允许把内容画到帧外（见 typst_world.rs 的 ink_bounds_of_frame）。
    let padded = Rect::new(
        Point::new(rect.min.x - Abs::pt(2.0), rect.min.y - Abs::pt(2.0)),
        Point::new(rect.max.x + Abs::pt(2.0), rect.max.y + Abs::pt(2.0)),
    );
    for (pos, item) in page.frame.items() {
        let shifted = Point::new(pos.x - rect.min.x, pos.y - rect.min.y);
        if !rects_intersect(item_box(*pos, item), padded) {
            continue;
        }
        frame.push(shifted, item.clone());
    }
    let mut cropped = page.clone();
    cropped.frame = frame;
    typst_svg::svg(&cropped, &SvgOptions::default())
}

/// 帧项的**近似**外接盒（本层坐标）：只用于"要不要把这一项压进切片"的粗筛，
/// 因此对 group 用它的帧尺寸而不去递归算墨迹（真正的几何由 `walk_frame` 负责）。
fn item_box(pos: Point, item: &FrameItem) -> Rect {
    match item {
        FrameItem::Text(t) => Rect::from_pos_size(
            Point::new(pos.x, pos.y - t.size),
            Size::new(t.width(), t.size),
        ),
        FrameItem::Shape(s, _) => {
            let bb = s.bbox(true);
            Rect::new(
                Point::new(pos.x + bb.min.x, pos.y + bb.min.y),
                Point::new(pos.x + bb.max.x, pos.y + bb.max.y),
            )
        }
        FrameItem::Image(_, size, _) | FrameItem::Link(_, size) => Rect::from_pos_size(pos, *size),
        FrameItem::Group(g) => Rect::from_pos_size(pos, g.frame.size()),
        FrameItem::Tag(_) => Rect::from_pos_size(pos, Size::zero()),
    }
}

fn rects_intersect(a: Rect, b: Rect) -> bool {
    a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y
}

fn merge_ranges(mut v: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
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

fn preview_of(src: &str, range: Range<usize>) -> String {
    let s: String = src[range].chars().take(40).collect();
    s.replace('\n', "⏎")
}

/// 字节偏移 → (行号, 列号)，1-based（与 `typst_world::offset_to_line_column` 同语义）。
/// 偏移落在多字节字符中间时**向下取到字符边界**（块区间来自语法树，末字节可能是 CJK 的后半截）。
fn offset_to_line_column(text: &str, offset: usize) -> (u32, u32) {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    let mut line = 1u32;
    let mut line_start = 0usize;
    for (i, c) in text[..offset].char_indices() {
        if c == '\n' {
            line += 1;
            line_start = i + 1;
        }
    }
    (line, (offset - line_start) as u32 + 1)
}

/// 切割用不到的尺寸类型再导出一次，避免外部（阶段 1 的命令层）重复 import
pub type CropSize = Size;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fonts_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
    }

    /// 真实文档样例：覆盖标题 / 段落 / 列表 / 行内与行间公式 / 围栏代码 / 表格 / 图 / 脚注 /
    /// `#show` 规则 / 前缀宏 —— 阶段 0 就是拿它们量"能不能切干净"
    const DOCS: &[(&str, &str)] = &[
        (
            "散文（中文 + 行内公式）",
            "= 第一章 引言\n\n\
             本文讨论 $a^2 + b^2 = c^2$ 这个恒等式，以及它在\n\
             实际排版里的表现。这里再放一个行内的 $alpha + beta$ 收尾。\n\n\
             == 小节标题\n\n\
             第二段的文字，用来观察段落之间的间距是否被正确切分出来。\n",
        ),
        (
            "列表 + 有序列表 + 行间公式",
            "= 清单\n\n\
             - 第一项\n\
             - 第二项\n\
               - 嵌套项\n\n\
             + 有序一\n\
             + 有序二\n\n\
             下面是一个行间公式：\n\n\
             $ integral_0^1 f(x) dif x = 1 $\n\n\
             公式之后的收尾段落。\n",
        ),
        (
            "代码块 + 表格 + 强调",
            "= 结构\n\n\
             正文里有 *粗体*、_斜体_ 与 `行内代码`。\n\n\
             ```rust\n\
             fn main() { println!(\"hi\"); }\n\
             ```\n\n\
             #table(\n\
               columns: 2,\n\
               [甲], [乙],\n\
               [1], [2],\n\
             )\n\n\
             表格之后的段落。\n",
        ),
        (
            "宏 / show 规则 / 脚注 / 引用",
            "#let name = \"Typst\"\n\
             #show heading: it => text(fill: rgb(\"#1d4ed8\"), it)\n\n\
             = 带宏的文档\n\n\
             这个文档用了宏 #name 和脚注#footnote[这是脚注正文，会被排到页底]。\n\n\
             = 第二个标题\n\n\
             这里不放交叉引用，只看几何是否切得干净。\n",
        ),
        (
            "长段落（观察多行与分页）",
            "= 长段落\n\n\
             #lorem(180)\n",
        ),
    ];

    /// 阶段 0 主探针：把上面每篇文档跑一遍并打印统计 + 逐块表格。
    /// 运行：`cargo test --manifest-path src-tauri/Cargo.toml dump_block_geometry -- --ignored --nocapture`
    #[test]
    #[ignore = "按需运行：阶段 0 的覆盖率/耗时探针"]
    fn dump_block_geometry() {
        // 写作模式的版心宽：编辑器正文列宽去掉左右留白后的常见值（A4 的 0.83 左右）
        for (name, src) in DOCS {
            let report = probe_blocks(
                src.to_string(),
                None,
                &fonts_dir(),
                &FontConfig::default(),
                495.0, // ≈ A4 宽 595pt 去掉页边距
            );
            assert!(report.ok, "{name} 应编译成功: {:?}", report.error);
            println!(
                "\n=== {name} ===\n页数 {} / 块 {}/{} 有几何 / 正文覆盖 {:.1}%（{}/{} 字符；字节 {}/{}）/ 行序单调 {} / \
                 相邻空隙 {:.2}..{:.2}pt（重叠 {} 处）\n编译 {:.1}ms / 整页渲染 {:.1}ms / 逐块切片合计 {:.1}ms（产物 {} 字节）\n\
                 字形 {}/{} 已映射（text item {}，带变换 group {}，带 clip group {}，shape {}，image {}）\n未覆盖行：{:?}",
                report.pages,
                report.blocks_found,
                report.blocks_total,
                report.coverage_ratio * 100.0,
                report.covered_chars,
                report.content_chars,
                report.covered_bytes,
                report.src_bytes,
                report.y_monotonic,
                report.min_gap_pt,
                report.max_gap_pt,
                report.negative_gaps,
                report.compile_ms,
                report.full_page_render_ms,
                report.crop_render_ms_total,
                report.crop_bytes_total,
                report.glyphs_mapped,
                report.glyphs_total,
                report.text_items,
                report.transformed_groups,
                report.clipped_groups,
                report.shapes,
                report.images,
                report.uncovered_lines,
            );
            for b in &report.blocks {
                println!(
                    "  {:>3}-{:<3} {:<9} {:>4}项 {:>5}px{:>6}  {:>6.1},{:>6.1} {:>5.1}×{:<5.1} 带{} 行 {} 切片{:.2}ms  {}{}",
                    b.line,
                    b.end_line,
                    b.kind,
                    b.items,
                    if b.found { "找到" } else { "缺" },
                    b.pages,
                    b.x,
                    b.y,
                    b.w,
                    b.h,
                    b.bands,
                    b.start,
                    b.render_ms,
                    if b.preview.is_empty() { "（空）" } else { &b.preview },
                    if b.found { "" } else { "   ← 没有渲染结果" },
                );
            }
            // 机器可读部分（便于后续比对/回归）
            println!("PROBE:{}", serde_json::to_string(&report).unwrap());
        }
    }

    /// 简单文档上跑一次几何映射：标题、段落、公式都应能定位到。
    ///
    /// 覆盖率阈值定在 0.6 而不是 1.0：**标记语法字符本身不产生字形**（标题的 `=`、公式的 `$`、
    /// 上标的 `^`、粗体的 `*`、行内代码的反引号…），所以短文档里它们的占比很高。
    #[test]
    fn geometry_finds_typical_blocks() {
        let src = "= 标题\n\n正文一段，后面还有一句普通的中文句子用来拉高正文比例。\n\n$ x^2 $\n";
        let report = probe_blocks(src.to_string(), None, &fonts_dir(), &FontConfig::default(), 495.0);
        assert!(report.ok, "应编译成功: {:?}", report.error);
        assert_eq!(report.pages, 1, "page(height: auto) 应为单张长页");
        assert!(
            report.blocks_found >= 3,
            "标题/正文/公式都应找到几何：{}/{}",
            report.blocks_found,
            report.blocks_total
        );
        assert!(
            report.glyphs_mapped > 0 && report.glyphs_mapped * 10 >= report.glyphs_total * 9,
            "九成以上字形应能映射回源码：{}/{}",
            report.glyphs_mapped,
            report.glyphs_total
        );
        assert!(
            report.coverage_ratio > 0.6,
            "正文覆盖率过低：{:.2}（{}/{}）",
            report.coverage_ratio,
            report.covered_chars,
            report.content_chars
        );
    }
}
