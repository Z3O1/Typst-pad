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
use std::sync::Mutex;
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

/// 这些节点**只有独占整行时**才自成一块（`#let` / `#show` / `#table(...)` 这类代码表达式）。
const LINE_ONLY_KINDS: &[SyntaxKind] = &[SyntaxKind::Code];

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

        // 公式与 raw 的自成块判据**跟 typst 的语义走，不能看"是否独占整行"**（实测被真实文档咬过）：
        //   * 公式：`$x$`（定界符内侧无空白）是**行内**的 —— 哪怕它独占整行，也仍属于同一个段落，
        //     于是几个连续的 `$x$` 会被 typst 连排成一行；按"独占整行"切成多块会让这些块的带
        //     互相重叠（实测：5 个公式的帧项全在同一个 y 带里交错，DOM 顺序与页面顺序对不上，
        //     看起来就是"公式挤成一团"）。只有 `$ x $`（内侧有空白）才是行间公式，才打断段落。
        //   * raw：`` `code` `` 是行内的，只有 ```` ``` ```` 围栏才是块。
        let own_block = BLOCK_KINDS.contains(&kind)
            || (kind == SyntaxKind::Equation && is_display_equation(src, &range))
            || (kind == SyntaxKind::Raw && is_fenced_raw(src, &range))
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

/// 行间公式判据（与 typst 一致、也与前端 math-ranges 的判定一致）：
/// **定界符内侧两侧都有空白** 的 `$ x $` 才是行间/块级公式；`$x$` 是行内公式。
fn is_display_equation(src: &str, range: &Range<usize>) -> bool {
    let text = &src[range.clone()];
    let mut chars = text.chars();
    if chars.next() != Some('$') {
        return false;
    }
    let inner: String = text.chars().rev().skip(1).collect::<String>().chars().rev().collect();
    let inner = inner.trim_start_matches('$');
    match (inner.chars().next(), inner.chars().last()) {
        (Some(first), Some(last)) => first.is_whitespace() && last.is_whitespace() && inner.trim().len() > 0,
        _ => false,
    }
}

/// 块级 raw 判据：必须是以 ```` ``` ```` 开头的围栏（`` `x` `` 是行内 raw）。
fn is_fenced_raw(src: &str, range: &Range<usize>) -> bool {
    src[range.clone()].trim_start().starts_with("```")
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
// 写作模式的块级渲染（阶段 1）：整篇编译一次 → 每个源块切一块 SVG 给编辑器内联显示
// ---------------------------------------------------------------------------

/// 页面默认页边距比例（70.87pt / 595.28pt，即 A4 默认页边距）。与 `typst_world::preview_page_setup`
/// 同源：正文列宽 = 页宽 × (1 - 2×比例)，因此反推页宽 = 列宽 / (1 - 2×比例)。
const PAGE_MARGIN_RATIO: f64 = 70.87 / 595.28;

/// 一个源块的渲染产物（前端直接消费：serde camelCase）。
///
/// `start`/`end` 是**用户文档坐标的字节偏移**（不含编译前缀）—— Rust 侧已经减掉了
/// `doc_offset`，前端只需把字节偏移换算成 CodeMirror 的 UTF-16 位置（见 block-offsets.ts）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCrop {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    /// 是否有渲染结果（`#let` / `#show` / 纯注释行没有 → 前端保持源码显示）
    pub found: bool,
    /// 内容分布在几页（单张长页正常为 1；>1 = 文档自己分页了，此时只切首页那部分）
    pub pages: usize,
    /// 切片所在页（1-based）。点击定位要把"页面坐标"告诉 Rust 侧的命中测试
    pub page: usize,
    /// 裁剪带的左缘（pt）= 页边距。切片自己的坐标系原点在带的左上角，
    /// 所以页面坐标 = (x_pt + 切片内相对 x, y_pt + 切片内相对 y)
    pub x_pt: f64,
    /// 裁剪带在页面上的纵向范围（pt），仅调试/核查用
    pub y_pt: f64,
    /// 裁剪带宽度（pt）= 正文列宽；高度（pt）含与相邻块的半个间距，
    /// **所以各块按源码顺序摞起来高度总和 == 排版里的纵向总高度**
    pub width_pt: f64,
    pub height_pt: f64,
    /// 占了几行（行带数），调试用
    pub bands: usize,
    /// 该块的 SVG（空串 = 没有渲染结果，前端保持源码显示）
    pub svg: String,
}

/// `compile_blocks` 的产物。字段与 `CompileOutput` 保持同构（诊断/警告同一套结构），
/// 前端因此在写作模式与源码模式之间可以共用状态栏、错误计数、波浪线逻辑。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocksOutput {
    pub ok: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<BlockCrop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
    pub page_width_pt: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<crate::typst_world::Diagnostic>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<crate::typst_world::Diagnostic>,
}

impl BlocksOutput {
    fn fail(
        diagnostics: Vec<crate::typst_world::Diagnostic>,
        page_width_pt: f64,
    ) -> Self {
        Self { ok: false, blocks: Vec::new(), pages: None, page_width_pt, diagnostics, warnings: Vec::new() }
    }
}

/// 写作模式的块级编译：**整篇编译一次**（与预览同一条链路），把每个源块在版面上的那一块
/// 切出来单独渲成 SVG。
///
/// * `src` —— 编译源（可能含设置里的前缀代码，与 `compile_doc` 的约定一致）
/// * `doc_offset` —— 用户文档在 `src` 里的起始**字节**偏移（= 前缀字符串的 UTF-8 字节长度）；
///   返回的块区间都相对它，前端拿到就是 CodeMirror 可直接用的文档坐标
/// * `content_width_pt` —— 写作模式正文列宽（pt）：版心宽随编辑器列宽走，正文在这个宽度下重排
/// * `want_from` / `want_to` —— **只给这个字节窗口内的块渲切片**（**用户文档字节偏移**，
///   与返回的块区间同一坐标系；None = 全渲）。
///   实测（`dump_long_doc_blocks`）：逐块 SVG 会各自复制一份字形轮廓，约 **58 字节/源字符**
///   —— 2 万字符的文档全渲一次要 11.7MB、debug 下 3.7s，**每按键一次**。所以编辑器只请求
///   视口附近的那一段，窗口外的块照旧返回几何（`found`/`height_pt`），但 `svg` 为空，
///   由前端用上一轮的结果按"块文本相同"沿用（见 block-plan 的 carryOverCrops）。
///
/// 失败与 `compile_doc` 同样返回结构化诊断（行号口径一致：注入的 `#set page` 行已减掉，
/// 但**前缀行仍在**，与现有 `mapCompiledPosToDoc` 的假设一致）。
pub fn compile_blocks(
    src: String,
    doc_offset: usize,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    content_width_pt: f64,
    want_from: Option<usize>,
    want_to: Option<usize>,
) -> BlocksOutput {
    let content_width_pt = if content_width_pt.is_finite() {
        content_width_pt.clamp(120.0, 2000.0)
    } else {
        371.25 // 兜底 = 495px 正文列宽
    };
    // 页宽反推：正文列宽 = 页宽 ×(1 - 2×页边距比例)
    let page_width_pt = content_width_pt / (1.0 - 2.0 * PAGE_MARGIN_RATIO);
    let margin_pt = page_width_pt * PAGE_MARGIN_RATIO;
    let injected = format!(
        "#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin_pt:.2}pt)\n"
    );
    let compiled_src = format!("{injected}{src}");
    // 编译源里的"用户文档起点"：注入行 + 前缀
    let doc_start = injected.len() + doc_offset;

    let world = TypstWorld::new(compiled_src, document_path, fonts_dir, font_config);
    // `main_line_offset = 1`：注入的 `#set page(...)` 占了一行，主源诊断的行号要减回去
    // （与 compile_with_page_width 同一口径；前缀行仍留在行号里，由前端 mapCompiledPosToDoc 处理）
    let (document, raw_warnings) = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned { output: Ok(doc), warnings } => (doc, warnings),
        typst::diag::Warned { output: Err(errors), .. } => {
            let diags = crate::typst_world::collect_diagnostics(&world, errors, 1);
            return BlocksOutput::fail(diags, page_width_pt);
        }
    };
    let warnings = crate::typst_world::collect_diagnostics(&world, raw_warnings, 1);

    // 块划分只看用户文档那一段（前缀不属于编辑器里的内容）
    let Some(doc_text) = src.get(doc_offset..) else {
        return BlocksOutput::fail(Vec::new(), page_width_pt);
    };
    let blocks = source_blocks(doc_text);
    let (items, _stats) = collect_geometry(&world, &document);

    // 1) 每个块的几何（编译源坐标 = 文档坐标 + doc_start）
    struct Found {
        idx: usize,
        page: usize,
        top: f64,
        bottom: f64,
        pages: usize,
        bands: usize,
        left: f64,
    }
    let mut geoms: Vec<Option<Found>> = Vec::with_capacity(blocks.len());
    for (idx, block) in blocks.iter().enumerate() {
        let injected_range = (block.range.start + doc_start)..(block.range.end + doc_start);
        geoms.push(geometry_for_range(&items, injected_range).map(|g| Found {
            idx,
            page: g.page,
            top: g.rect.min.y.to_pt(),
            bottom: g.rect.max.y.to_pt(),
            pages: g.pages,
            bands: g.bands,
            left: g.rect.min.x.to_pt(),
        }));
    }

    // 2) 按 (页, y) 排序后，用相邻块的"中点"切带：相邻两块各自分到一半间距，
    //    于是各块高度之和 = 排版里的纵向总高度，按顺序摞起来就还原版式。
    let mut order: Vec<usize> = (0..geoms.len()).filter(|i| geoms[*i].is_some()).collect();
    order.sort_by(|a, b| {
        let (ga, gb) = (geoms[*a].as_ref().unwrap(), geoms[*b].as_ref().unwrap());
        (ga.page, ga.top).partial_cmp(&(gb.page, gb.top)).unwrap()
    });

    // 2b) **越界夹紧**：块自己的纵向区间不许越过它在 y 序里的下一个块的顶。
    //
    // 为什么需要：typst 允许把内容排到远处（脚注正文在页底、`#place` 的内容在别处），而块的
    // 墨迹包围盒是**并集** —— 带脚注的段落因此会得到一个一直伸到页底的高盒子，把后面几块的
    // 中点切带全压扁：实测代码块被压到 ≤0.5pt（切片被丢弃 → 回退成源码/旧 widget），
    // 而它的内容又被脚注段那张超长切片吞进去又画了一遍（截图里代码块出现两次）。
    // 夹紧后各块的带仍首尾相接，且不会有哪一块被压没。
    for pos in 0..order.len() {
        let idx = order[pos];
        let next_same_page = order
            .get(pos + 1)
            .and_then(|n| geoms[*n].as_ref())
            .filter(|n| n.page == geoms[idx].as_ref().unwrap().page)
            .map(|n| n.top);
        let cur = geoms[idx].as_mut().unwrap();
        let limit = next_same_page.unwrap_or(f64::INFINITY);
        if cur.bottom > limit - 0.25 {
            cur.bottom = (limit - 0.25).max(cur.top + 0.5);
        }
        if cur.bottom <= cur.top {
            cur.bottom = cur.top + 0.5;
        }
    }

    let mut crops: Vec<Option<BlockCrop>> = Vec::with_capacity(blocks.len());
    crops.resize_with(blocks.len(), || None);
    for (pos, idx) in order.iter().enumerate() {
        let g = geoms[*idx].as_ref().unwrap();
        let prev = if pos > 0 { geoms[order[pos - 1]].as_ref() } else { None };
        let next = if pos + 1 < order.len() { geoms[order[pos + 1]].as_ref() } else { None };
        // 相邻块必须同页才能取中点（跨页之间没有"间距"可言）
        let band_top = match prev.filter(|p| p.page == g.page) {
            Some(p) => (p.bottom + g.top) / 2.0,
            None => g.top,
        };
        let band_bottom = match next.filter(|n| n.page == g.page) {
            Some(n) => (g.bottom + n.top) / 2.0,
            None => g.bottom,
        };
        let band_top = band_top.max(0.0);
        // 带高退化（极端文档）时留一条最小带，而不是把这块丢掉 —— 丢掉会让前端把它当成
        // "不可渲染"，回退到源码/旧 widget，看起来就是"这块没渲染"
        let height = (band_bottom - band_top).max(0.75);
        // 横向切**正文列**（不是墨迹外接盒）：列表缩进、居中公式、段首缩进都在列内，
        // 按墨迹切会把它们挤掉。
        let rect = Rect::new(
            Point::new(Abs::pt(margin_pt), Abs::pt(band_top)),
            Point::new(Abs::pt(page_width_pt - margin_pt), Abs::pt(band_top + height)),
        );
        // 只渲"窗口内"的块：窗口外的块只回几何（前端沿用上一轮切片或先显示源码）
        // 窗口与返回的块区间**同一坐标系**（用户文档字节偏移，不含注入行与前缀）
        let in_window = match (want_from, want_to) {
            (Some(from), Some(to)) => {
                let s = blocks[*idx].range.start;
                let e = blocks[*idx].range.end;
                s < to && e >= from
            }
            _ => true,
        };
        let svg = if in_window {
            match document.pages().get(g.page.saturating_sub(1)) {
                Some(page) => render_crop(page, rect),
                None => String::new(),
            }
        } else {
            String::new()
        };
        crops[*idx] = Some(BlockCrop {
            start: blocks[*idx].range.start,
            end: blocks[*idx].range.end,
            kind: blocks[*idx].kind.to_string(),
            found: true,
            pages: g.pages,
            page: g.page,
            x_pt: rect.min.x.to_pt(),
            y_pt: band_top,
            width_pt: rect.size().x.to_pt(),
            height_pt: height,
            bands: g.bands,
            svg,
        });
    }

    // 3) 没有几何的块也返回（前端要拿它的区间做"源码透镜"的边界，不能凭空漏掉）
    let mut out: Vec<BlockCrop> = Vec::with_capacity(blocks.len());
    for (idx, block) in blocks.iter().enumerate() {
        out.push(crops[idx].take().unwrap_or(BlockCrop {
            start: block.range.start,
            end: block.range.end,
            kind: block.kind.to_string(),
            found: false,
            pages: 0,
            page: 0,
            x_pt: 0.0,
            y_pt: 0.0,
            width_pt: content_width_pt,
            height_pt: 0.0,
            bands: 0,
            svg: String::new(),
        }));
    }

    // 字形几何进缓存，供"点击 → 精确字符"的命中测试用（见 HIT_CACHE）。
    // 放在最后：前面的几何计算都借用了 items，这里把所有权交出去，不再多一份拷贝。
    store_hit_geometry(items, doc_start);

    BlocksOutput {
        ok: true,
        blocks: out,
        pages: Some(document.pages().len()),
        page_width_pt,
        diagnostics: Vec::new(),
        warnings,
    }
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

// ---------------------------------------------------------------------------
// 点击定位（阶段 2）：把"切片上的一个点"映射回"源码里的第几个字符"
// ---------------------------------------------------------------------------

/// 上一次成功编译的字形几何缓存（**文档坐标**：已减掉注入行与编译前缀）。
///
/// 为什么不随 `compile_blocks` 一起把字形逐个返回给前端：逐块 SVG 已经约 58 字节/源字符，
/// 再让每个按键的载荷多三成代价太大；而点击只在用户真的点下去那一刻发生一次。
/// 缓存里只有"字形 → 源字节区间 + 版面矩形"，一次命中测试是线性扫一遍（微秒级）。
///
/// **陈旧是可接受的**：前端只在"块表与当前文档一致"时才发命中测试（见 +page.svelte 的
/// `handleCropClick`），而块表的区间正是这份几何的来源；编译失败时前端沿用旧块表，
/// 缓存里也还是上一次成功编译的几何 —— 两者同源。
static HIT_CACHE: Mutex<Option<Vec<PlacedItem>>> = Mutex::new(None);

/// 把编译源坐标的字形几何换成**用户文档坐标**并缓存（丢弃注入行 / 前缀里的项）。
pub fn store_hit_geometry(items: Vec<PlacedItem>, doc_start: usize) {
    let converted: Vec<PlacedItem> = items
        .into_iter()
        .filter(|i| i.range.start >= doc_start && i.range.end > doc_start)
        .map(|mut i| {
            i.range.start -= doc_start;
            i.range.end -= doc_start;
            i
        })
        .collect();
    if let Ok(mut guard) = HIT_CACHE.lock() {
        *guard = Some(converted);
    }
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
    let offset = if x < mid { item.range.start } else { item.range.end };
    Some(offset.clamp(start, end))
}

/// Tauri 命令的入口：`(x_pt, y_pt)` 是**页面坐标**（与 `BlockCrop` 的 x_pt/y_pt 同一坐标系）。
/// 没有缓存（还没编译过）或参数非法时返回 None，前端退回"落到块首"的老行为。
pub fn hit_test(start: usize, end: usize, page: usize, x_pt: f64, y_pt: f64) -> Option<usize> {
    if !x_pt.is_finite() || !y_pt.is_finite() {
        return None;
    }
    let guard = HIT_CACHE.lock().ok()?;
    let items = guard.as_ref()?;
    pick_hit(items, start, end, page, Abs::pt(x_pt), Abs::pt(y_pt))
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

    /// 造一个字形项：源区间 + 版面矩形（页面坐标）
    fn item(page: usize, range: Range<usize>, x0: f64, y0: f64, x1: f64, y1: f64) -> PlacedItem {
        PlacedItem {
            page,
            range,
            rect: Rect::new(
                Point::new(Abs::pt(x0), Abs::pt(y0)),
                Point::new(Abs::pt(x1), Abs::pt(y1)),
            ),
        }
    }

    /// **命中测试的纯逻辑**（合成几何，不依赖编译）：
    /// 横向按字形的左右半决定"光标在字前还是字后"，点的位置落在行外时先选最近的行。
    #[test]
    fn pick_hit_chooses_the_clicked_glyph() {
        // 一行三个 CJK 字（各 3 字节）：0..3 / 3..6 / 6..9，x = 0..10 / 10..20 / 20..30
        // 第二行：9..12 / 12..15，y = 30..40
        let items = vec![
            item(1, 0..3, 0.0, 10.0, 10.0, 20.0),
            item(1, 3..6, 10.0, 10.0, 20.0, 20.0),
            item(1, 6..9, 20.0, 10.0, 30.0, 20.0),
            item(1, 9..12, 0.0, 30.0, 10.0, 40.0),
            item(1, 12..15, 10.0, 30.0, 20.0, 40.0),
            // 别的页 / 别的块：都不该被选中
            item(2, 0..3, 0.0, 10.0, 10.0, 20.0),
            item(1, 100..103, 0.0, 10.0, 10.0, 20.0),
        ];
        let hit = |x: f64, y: f64| pick_hit(&items, 0, 15, 1, Abs::pt(x), Abs::pt(y));
        // 第一行：左半 → 字前，右半 → 字后
        assert_eq!(hit(2.0, 15.0), Some(0), "第一个字左半 → 偏移 0");
        assert_eq!(hit(8.0, 15.0), Some(3), "第一个字右半 → 偏移 3（第二个字之前）");
        assert_eq!(hit(25.0, 15.0), Some(9), "第三个字右半 → 偏移 9（= 行尾）");
        // 行外：右侧空白 → 行尾；左侧空白 → 行首
        assert_eq!(hit(200.0, 15.0), Some(9), "点在这一行右边很远 → 行尾");
        assert_eq!(hit(-50.0, 15.0), Some(0), "点在这一行左边很远 → 行首");
        // 第二行（y 决定选哪一行）
        assert_eq!(hit(2.0, 35.0), Some(9), "第二行行首");
        assert_eq!(hit(15.0, 35.0), Some(15), "第二行第二个字");
        // 块之外的项不参与：第二个块的区间不许被点出来
        assert_eq!(
            pick_hit(&items, 0, 9, 1, Abs::pt(2.0), Abs::pt(15.0)),
            Some(0)
        );
        let outside = pick_hit(&items, 1000, 1003, 1, Abs::pt(2.0), Abs::pt(15.0));
        assert_eq!(outside, None, "块区间外没有任何字形 → None");
        assert_eq!(
            pick_hit(&items, 0, 15, 9, Abs::pt(2.0), Abs::pt(15.0)),
            None,
            "没有这一页 → None"
        );
    }

    /// **真实引擎几何 + 真实字节偏移**：单行块的左缘 → 块首，右缘 → 块尾（含 CJK 3 字节）。
    #[test]
    fn hit_test_on_real_layout_maps_edges_to_block_bounds() {
        const COLUMN_PT: f64 = 371.25;
        // 一行的短段落（不折行）+ 一个会折成好几行的长段落
        let doc = "甲乙丙丁戊己庚辛\n\n这是一段很长的中文正文，它会在版心宽度里折成好几行，用来验证纵向的命中判定：点的位置越往下，落在源码里的字符就应该越靠后，而横向的点则决定光标落在字的哪一侧。收尾。\n";
        let out = compile_blocks(
            doc.to_string(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            COLUMN_PT,
            None,
            None,
        );
        assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
        let single = &out.blocks[0];
        let para = &out.blocks[1];
        assert!(single.found && para.found);

        // 单行块：横向两端必定落在块首 / 块尾（y 取带里任意高度都行 —— 同一行的字形纵向距离相同）
        let y = single.y_pt + single.height_pt * 0.5;
        let left = hit_test(single.start, single.end, single.page, single.x_pt + 0.5, y);
        let right = hit_test(
            single.start,
            single.end,
            single.page,
            single.x_pt + single.width_pt - 0.5,
            y,
        );
        assert_eq!(left, Some(single.start), "左缘 → 块首");
        assert_eq!(right, Some(single.end), "右缘 → 块尾（= 该行行尾）");

        // 多行块：越往下，偏移越大（纵向判定真的在看 y）
        let x = para.x_pt + 4.0;
        let top = hit_test(
            para.start,
            para.end,
            para.page,
            x,
            para.y_pt + para.height_pt * 0.12,
        )
        .expect("上部的点应该命中");
        let bottom = hit_test(
            para.start,
            para.end,
            para.page,
            x,
            para.y_pt + para.height_pt * 0.88,
        )
        .expect("下部的点应该命中");
        assert!(
            top >= para.start && bottom <= para.end,
            "结果必须钳在块区间内：{top}/{bottom} vs {}..{}",
            para.start,
            para.end
        );
        assert!(
            bottom > top + 10,
            "越往下偏移越大（上 {top} / 下 {bottom}，块 {}..{}）",
            para.start,
            para.end
        );

        // 前缀偏移：块的区间是**文档坐标**，命中结果也必须是（不会把前缀的字节算进来）
        let prefix = "#set text(size: 12pt)\n";
        let src = format!("{prefix}{doc}");
        let out2 = compile_blocks(
            src,
            prefix.len(),
            None,
            &fonts_dir(),
            &FontConfig::default(),
            COLUMN_PT,
            None,
            None,
        );
        assert!(out2.ok);
        assert_eq!(out2.blocks[0].start, 0, "块区间是文档坐标");
        let y2 = out2.blocks[0].y_pt + out2.blocks[0].height_pt * 0.5;
        let hit2 = hit_test(
            out2.blocks[0].start,
            out2.blocks[0].end,
            out2.blocks[0].page,
            out2.blocks[0].x_pt + 0.5,
            y2,
        );
        assert_eq!(hit2, Some(0), "带前缀时命中结果仍是文档坐标");
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

    /// 窗口化：窗口内的块有切片，窗口外的块只有几何（`found` 为 true、svg 为空）
    #[test]
    fn writing_mode_window_limits_crops() {
        let src = "= 标题\n\n第一段。\n\n第二段。\n\n第三段。\n";
        let out_all = compile_blocks(
            src.to_string(), 0, None, &fonts_dir(), &FontConfig::default(), 371.25, None, None,
        );
        assert!(out_all.ok);
        let all_svgs = out_all.blocks.iter().filter(|b| !b.svg.is_empty()).count();
        assert!(all_svgs >= 3, "全渲时应有多个切片，实际 {all_svgs}");

        // 窗口只覆盖文档最前面几个字节 → 只有第一个块出切片
        let out_win = compile_blocks(
            src.to_string(), 0, None, &fonts_dir(), &FontConfig::default(), 371.25, Some(0), Some(3),
        );
        assert!(out_win.ok);
        let win_svgs = out_win.blocks.iter().filter(|b| !b.svg.is_empty()).count();
        assert!(win_svgs < all_svgs, "窗口化应减少切片数量：{win_svgs} vs {all_svgs}");
        assert!(win_svgs >= 1, "窗口内的块仍要出切片");
        // 窗口外的块仍要回几何（前端要靠它判断"这块能渲染，只是还没渲"）
        assert!(out_win.blocks.iter().filter(|b| b.found).count() >= 3);
    }

    /// **窗口化回归网**：窗口外的块不许出 SVG（否则长文档每按键要传十几 MB）。
    ///
    /// 断言用**产物字节数与块数**（确定性），不用耗时（机器/构建不同会飘）——
    /// 耗时只在下面 `dump_long_doc_blocks` 里按需打印。
    #[test]
    fn windowing_keeps_payload_bounded() {
        let mut src = String::from("= 长文档\n\n");
        for i in 0..160 {
            src.push_str(&format!(
                "第 {i} 段正文，用来把文档撑长，观察窗口化是否真的把产物压住了。这一段里放一个行内公式 $a_{i} + b_{i}$，\n                 再补一句普通中文，让每个段落都有两三行。\n\n"
            ));
        }
        let column = 371.25;
        // 全渲（对照）：这是**不许**出现在按键路径上的量级
        let all = compile_blocks(src.clone(), 0, None, &fonts_dir(), &FontConfig::default(), column, None, None);
        assert!(all.ok, "{:?}", all.diagnostics);
        let all_blocks = all.blocks.iter().filter(|b| !b.svg.is_empty()).count();
        let all_bytes: usize = all.blocks.iter().map(|b| b.svg.len()).sum();
        assert!(all_blocks > 100, "对照用例应有大量块，实际 {all_blocks}");

        // 窗口化：只给中间 4000 个字节（模拟视口窗口）
        let win = compile_blocks(
            src.clone(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            column,
            Some(8000),
            Some(12000),
        );
        assert!(win.ok, "{:?}", win.diagnostics);
        let win_blocks = win.blocks.iter().filter(|b| !b.svg.is_empty()).count();
        let win_bytes: usize = win.blocks.iter().map(|b| b.svg.len()).sum();
        assert!(
            win_blocks * 20 < all_blocks * 3,
            "窗口内的块数应远少于全渲：{win_blocks} vs {all_blocks}"
        );
        assert!(
            win_bytes * 10 < all_bytes * 2,
            "窗口化产物应压到全渲的 20% 以下：{win_bytes} vs {all_bytes} 字节"
        );
        // 窗口外的块仍要回几何（前端靠它判断"这块能渲染，只是还没渲"）
        assert_eq!(
            win.blocks.iter().filter(|b| b.found).count(),
            all.blocks.iter().filter(|b| b.found).count(),
            "窗口化不该丢掉任何块的几何"
        );
        println!(
            "WINDOWING: 全渲 {all_blocks} 块 / {}KB，窗口内 {win_blocks} 块 / {}KB",
            all_bytes / 1024,
            win_bytes / 1024
        );
    }

    /// 大文档开销探针（只打印，不作断言）：`--ignored --nocapture` 按需跑。
    #[test]
    #[ignore = "按需运行：长文档下的块级渲染开销（窗口化的实测数据）"]
    fn dump_long_doc_blocks() {
        for paragraphs in [20usize, 60, 120, 200] {
            let mut src = String::from("= 长文档\n\n");
            for i in 0..paragraphs {
                src.push_str(&format!(
                    "第 {i} 段正文，用来观察块级渲染在大文档下的开销。这一段里放一个行内公式 $a_{i} + b_{i} = c_{i}$，\n                     再补一句普通中文，让每个段落都有两三行。\n\n"
                ));
            }
            let t = Instant::now();
            let out = compile_blocks(src.clone(), 0, None, &fonts_dir(), &FontConfig::default(), 371.25, None, None);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            assert!(out.ok, "编译应成功: {:?}", out.diagnostics);
            let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
            let bytes: usize = rendered.iter().map(|b| b.svg.len()).sum();
            // 同一份文档再来一次"只渲中间窗口"，对比量级
            let t2 = Instant::now();
            let win = compile_blocks(
                src.clone(),
                0,
                None,
                &fonts_dir(),
                &FontConfig::default(),
                371.25,
                Some(src.len() / 2),
                Some(src.len() / 2 + 4000),
            );
            let win_ms = t2.elapsed().as_secs_f64() * 1000.0;
            let win_bytes: usize = win.blocks.iter().map(|b| b.svg.len()).sum();
            println!(
                "LONGDOC: 段落 {paragraphs} / 字符 {} / 块 {}（渲染 {}）/ 全渲 {:.1}KB {:.1}ms ←→ 窗口化 {}KB {:.1}ms",
                src.chars().count(),
                out.blocks.len(),
                rendered.len(),
                bytes as f64 / 1024.0,
                ms,
                win_bytes as f64 / 1024.0,
                win_ms
            );
            // 对照：整页渲一次有多大（＝源码模式预览每按键都要传的量级）
            let world = TypstWorld::new(
                format!("#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n{src}"),
                None,
                &fonts_dir(),
                &FontConfig::default(),
            );
            if let typst::diag::Warned { output: Ok(doc), .. } = typst::compile::<PagedDocument>(&world) {
                let page_bytes: usize = doc
                    .pages()
                    .iter()
                    .map(|p| typst_svg::svg(p, &SvgOptions::default()).len())
                    .sum();
                println!("LONGDOC-PAGE: 同一文档整页 SVG {:.1}KB", page_bytes as f64 / 1024.0);
            }
        }
    }

    /// 供"切片几何等价"验收用的样例文档（真实产物夹具与不变量测试共用）。
    /// **每条都是一行字面量**：用源码续行（`\` 换行）写会被续行的缩进带进文档文本，
    /// 而 typst 把缩进 4+ 空格的段落当代码块 → 直接编译报错（实测踩过）。
    const GEOMETRY_DOCS: &[(&str, &str)] = &[
        (
            "段落与标题",
            "= 第一章\n\n第一段正文，两行以上比较好，用来观察块间距是否被正确分到相邻两块。继续这一段的第二行文字。\n\n== 小节\n\n第二段正文。\n",
        ),
        (
            "列表",
            "= 清单\n\n- 第一项\n- 第二项\n  - 嵌套项\n\n+ 有序一\n+ 有序二\n\n收尾段落。\n",
        ),
        (
            "公式与代码",
            "= 公式\n\n行内 $a^2 + b^2$ 与行间：\n\n$ integral_0^1 f(x) dif x = 1 $\n\n```rust\nfn main() {}\n```\n\n代码之后的段落。\n",
        ),
    ];

    /// **场景集**：写作模式要覆盖的文档形态（只用于按需导出的真实产物夹具；常驻测试不跑这些）。
    /// 见 `scripts/browser-check/writing-mode-scenes.mjs`。同上有意写成单行字面量。
    const SCENE_DOCS: &[(&str, &str)] = &[
        (
            "标题层级",
            "= 一级标题\n\n一级标题下的段落。\n\n== 二级标题\n\n二级标题下的段落。\n\n=== 三级标题\n\n三级标题下的段落，用来对比三级字号的梯度。\n",
        ),
        (
            "中文长段落",
            "= 长段落\n\n排版是引擎算出来的：同一段文字在不同宽度下的断行位置、行末的伸缩、标点前后的留白，都由引擎的行断算法决定，而不是浏览器说了算。这一段故意写得很长，用来观察写作模式下的切片是不是把好几行都完整切进来，以及相邻块之间的间距有没有被正确分到两块里。再补一句收尾，让这一段至少有四五行的长度，好在截图里看出断行的节奏。\n",
        ),
        (
            "列表与嵌套",
            "= 清单\n\n- 第一项：无序列表\n- 第二项：带嵌套\n  - 嵌套一\n  - 嵌套二\n- 第三项\n\n+ 有序一\n+ 有序二\n+ 有序三\n\n列表之后的收尾段落。\n",
        ),
        (
            "公式",
            "= 公式\n\n行内公式 $a^2 + b^2 = c^2$ 要与正文基线对齐。\n\n行间公式：\n\n$ sum_(i=1)^n i = frac(n(n+1), 2) $\n\n带下沉的 $integral_0^1 f(x) dif x$ 与下标 $a_0 = 0$ 也要完整。\n",
        ),
        (
            "代码与表格",
            "= 结构与脚注\n\n正文里有一个脚注#footnote[脚注正文会被排到页底]，这是写作模式的已知不足点。\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\n#table(\n  columns: 2,\n  [甲], [乙],\n  [1], [2],\n)\n\n表格之后的段落。\n",
        ),
        (
            "文档级设置（默认字号）",
            "= 设置对照\n\n这一段用来和下一篇对照：两篇正文完全相同，只有文档开头那条设置语句不同。\n",
        ),
        (
            "文档级设置（12pt）",
            "#set text(size: 12pt)\n\n= 设置对照\n\n这一段用来和上一篇对照：两篇正文完全相同，只有文档开头那条设置语句不同。\n",
        ),
        (
            "混排与 emoji",
            "= 混排\n\n中文 ASCII 🚀 混在一行里：émoji 与 a_0 = 0 都要能点对位置。\n\n第二段用纯中文写长一点，用来验证整段折行之后的纵向定位是不是仍然准确。\n",
        ),
    ];

    /// **分块判据必须跟 typst 语义走**（真实文档咬过一次：`$x$` 是行内公式，哪怕独占整行也
    /// 不打断段落 —— 按"独占整行"把它当块，会让连续几个 `$x$` 的带互相重叠，看起来"公式挤成一团"）。
    #[test]
    fn block_partition_matches_typst_semantics() {
        let blocks = |src: &str| {
            source_blocks(src)
                .into_iter()
                .map(|b| (b.kind, src[b.range].to_string()))
                .collect::<Vec<_>>()
        };

        // ① `$x$`（内侧无空白）= 行内公式：独占整行也留在段落里 → 连排的三个公式是**一块**
        let inline = "设 $a=1$\n$b=2$\n$c=3$\n";
        let got = blocks(inline);
        assert_eq!(got.len(), 1, "行内公式不该把段落切开：{got:?}");
        assert_eq!(got[0].0, "Paragraph");

        // ② `$ x $`（内侧有空白）= 行间公式：自成一块（独占整行）
        let display = "前文。\n\n$ a + b = c $\n\n后文。\n";
        let got = blocks(display);
        assert!(
            got.iter().any(|(k, t)| *k == "Equation" && t.contains("a + b")),
            "行间公式应自成一块：{got:?}"
        );
        assert_eq!(got.iter().filter(|(k, _)| *k == "Paragraph").count(), 2, "前后各有段落");

        // ③ 行内 raw（单反引号）不是块；围栏 raw 是块
        let raw = "正文里有 `code` 一段。\n\n```rust\nfn main() {}\n```\n\n后文。\n";
        let got = blocks(raw);
        assert_eq!(got.iter().filter(|(k, _)| *k == "Raw").count(), 1, "只有围栏算块：{got:?}");
        assert!(
            got.iter().any(|(k, t)| *k == "Raw" && t.starts_with("```")),
            "块级 raw 应该是那段围栏：{got:?}"
        );

        // ④ 行间公式写在行中间也自成一块（typst 会打断段落）
        let mid = "前文 $ a + b $ 后文。\n";
        let got = blocks(mid);
        assert!(
            got.iter().any(|(k, _)| *k == "Equation"),
            "行中间的行间公式也应自成一块：{got:?}"
        );
    }

    /// **切片几何不变量**（真实引擎产物，常驻测试）：
    ///  ① 每块宽度 = 正文列宽（横向切的是列不是墨迹）；
    ///  ② 各块高度之和 = 首块顶到底块底的纵向跨度（相邻块按中点分间距 ⇒ 摞起来不丢高度）；
    ///  ③ 按 y 序相邻块不重叠（能像积木一样堆叠）；
    ///  ④ 块区间按源码顺序递增不重叠（前端靠它切"源码透镜"的边界）。
    #[test]
    fn block_crop_geometry_invariants() {
        const COLUMN_PT: f64 = 371.25;
        for (name, src) in GEOMETRY_DOCS {
            let out = compile_blocks(
                src.to_string(),
                0,
                None,
                &fonts_dir(),
                &FontConfig::default(),
                COLUMN_PT,
                None,
                None,
            );
            assert!(out.ok, "[{name}] 编译应成功：{:?}", out.diagnostics);
            let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
            assert!(rendered.len() >= 3, "[{name}] 应切出多块，实际 {}", rendered.len());

            for b in &rendered {
                assert!(
                    (b.width_pt - COLUMN_PT).abs() < 0.5,
                    "[{name}] 切片宽度应等于正文列宽：{} vs {COLUMN_PT}",
                    b.width_pt
                );
                assert!(b.height_pt > 0.5, "[{name}] 切片高度应为正：{}", b.height_pt);
            }

            // ② 高度之和 = 纵向跨度（首块顶 → 末块底）
            let mut by_y: Vec<&BlockCrop> = rendered.clone();
            by_y.sort_by(|a, b| a.y_pt.partial_cmp(&b.y_pt).unwrap());
            let span = by_y.last().unwrap().y_pt + by_y.last().unwrap().height_pt - by_y[0].y_pt;
            let total: f64 = by_y.iter().map(|b| b.height_pt).sum();
            assert!(
                (total - span).abs() < 1.0,
                "[{name}] 各块高度之和 {total:.2} 应等于纵向跨度 {span:.2}（中点切带不丢高度）"
            );

            // ③ 相邻块不重叠（允许 0.5pt 的浮点误差）
            for pair in by_y.windows(2) {
                let prev_bottom = pair[0].y_pt + pair[0].height_pt;
                assert!(
                    pair[1].y_pt >= prev_bottom - 0.5,
                    "[{name}] 相邻块重叠了：{:?} 底 {prev_bottom:.2} → 下一块顶 {:.2}",
                    pair[0].kind,
                    pair[1].y_pt
                );
            }

            // ④ 源码顺序递增不重叠
            for pair in out.blocks.windows(2) {
                assert!(pair[0].end <= pair[1].start, "[{name}] 块区间应递增不重叠");
            }
        }
    }

    /// **真实文档体检**：读 `.browser-check/real-scene.typ`（用户给的真实文档）→ 编译 → 打印诊断与块表，
    /// 并输出一条 `BLOCKFIXTURE`（给浏览器验收渲染截图用）。
    /// 用法：先把文档存到该路径，再
    /// `cargo test --manifest-path src-tauri/Cargo.toml dump_real_doc_fixture -- --ignored --nocapture`
    #[test]
    #[ignore = "按需运行：真实文档的块级渲染体检"]
    fn dump_real_doc_fixture() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.browser-check/real-scene.typ");
        let Ok(src) = std::fs::read_to_string(&path) else {
            println!("REALDOC: 读不到 {}（先把文档存到那里）", path.display());
            return;
        };
        const COLUMN_PT: f64 = 371.25;
        let out = compile_blocks(
            src.clone(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            COLUMN_PT,
            None,
            None,
        );
        println!(
            "REALDOC: ok={} 页数={:?} 块={} 诊断={} 源字符={}",
            out.ok,
            out.pages,
            out.blocks.len(),
            out.diagnostics.len(),
            src.chars().count()
        );
        for d in &out.diagnostics {
            println!("REALDOC-DIAG: [{}] 行{} 列{} {}", d.severity, d.line, d.column, d.message);
        }
        for b in &out.blocks {
            println!(
                "REALDOC-BLOCK: {:<10} [{:>4},{:>4}) y={:>6.1} h={:>6.1} found={:<5} svg={}KB",
                b.kind,
                b.start,
                b.end,
                b.y_pt,
                b.height_pt,
                b.found,
                b.svg.len() / 1024
            );
        }
        // 把 == 5 那一段（y 480..540）的帧项按 y 排出来：判断"公式挤在一起"是 typst 自己的
        // 排版，还是块切片的锅（切片只能读帧、不可能挪动内容 —— 这条输出就是证据）
        {
            let injected = "#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n";
            let world = TypstWorld::new(
                format!("{injected}{src}"),
                None,
                &fonts_dir(),
                &FontConfig::default(),
            );
            if let typst::diag::Warned { output: Ok(doc), .. } = typst::compile::<PagedDocument>(&world) {
                let (items, _) = collect_geometry(&world, &doc);
                let doc_start = injected.len();
                let mut in_region: Vec<(f64, usize, usize)> = items
                    .iter()
                    .filter(|i| i.rect.min.y.to_pt() > 480.0 && i.rect.min.y.to_pt() < 540.0)
                    .map(|i| (i.rect.min.y.to_pt(), i.range.start.saturating_sub(doc_start), i.range.end.saturating_sub(doc_start)))
                    .collect();
                in_region.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
                println!("REALDOC-REGION: y 480..540 的帧项 {} 个（y, 文档区间）", in_region.len());
                for (y, a, b) in in_region.iter().take(40) {
                    println!("  y={y:>6.1} 文档 [{a},{b})");
                }
            }
        }
        if out.ok {
            println!(
                "BLOCKFIXTURE:{}",
                serde_json::json!({
                    "name": "真实文档（数学作业）",
                    "doc": src,
                    "contentWidthPt": COLUMN_PT,
                    "pageWidthPt": out.page_width_pt,
                    "blocks": out.blocks,
                })
            );
        }
    }

    /// 临时诊断：场景文档里每个块匹配到的帧项数量与源区间（排查"某些块 found=false"）。
    #[test]
    #[ignore = "按需运行：块 ↔ 帧项的匹配诊断"]
    fn dump_scene_item_matching() {
        const COLUMN_PT: f64 = 371.25;
        for (name, src) in SCENE_DOCS {
            let injected = "#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n";
            let compiled = format!("{injected}{src}");
            let doc_start = injected.len();
            let world = TypstWorld::new(compiled, None, &fonts_dir(), &FontConfig::default());
            let typst::diag::Warned { output: Ok(doc), .. } = typst::compile::<PagedDocument>(&world) else {
                println!("SCENE[{name}] 编译失败");
                continue;
            };
            let (items, _) = collect_geometry(&world, &doc);
            println!("\nSCENE[{name}] 帧项 {} 个", items.len());
            for b in source_blocks(src) {
                let range = (b.range.start + doc_start)..(b.range.end + doc_start);
                let hit = items.iter().filter(|i| i.range.start < range.end && i.range.end >= range.start).count();
                let first = items.iter().find(|i| i.range.start < range.end && i.range.end >= range.start);
                println!(
                    "  {} [{}..{}) 项 {} 首个项区间 {:?}（文档坐标 {:?}..{:?}）",
                    b.kind,
                    b.range.start,
                    b.range.end,
                    hit,
                    first.map(|i| (i.range.start, i.range.end)),
                    first.map(|i| i.range.start.saturating_sub(doc_start)),
                    first.map(|i| i.range.end.saturating_sub(doc_start)),
                );
            }
        }
    }

    /// 「切片几何等价」验收用的**真实产物夹具**（按需导出，浏览器端注入）：
    ///   `npm run fixtures:blocks`
    /// 每条 = 一篇文档 + 编译用的正文列宽 + 每块的区间/几何/SVG。浏览器侧会把同一篇文档
    /// 打进编辑器（桩按文档原文命中夹具，给真实产物），再断言"摞起来 == 原版式"。
    #[test]
    #[ignore = "按需运行：导出块级切片的真实产物夹具（场景集）"]
    fn dump_block_fixtures() {
        const COLUMN_PT: f64 = 371.25;
        for (name, src) in SCENE_DOCS {
            let out = compile_blocks(
                src.to_string(),
                0,
                None,
                &fonts_dir(),
                &FontConfig::default(),
                COLUMN_PT,
                None,
                None,
            );
            assert!(out.ok, "[{name}] 编译应成功：{:?}", out.diagnostics);
            let probes = hit_probes(&out);
            let json = serde_json::json!({
                "name": name,
                "doc": src,
                "contentWidthPt": COLUMN_PT,
                "pageWidthPt": out.page_width_pt,
                "blocks": out.blocks,
                // 点击定位的探针：每块在带内取网格点，记录**真实几何上 Rust 给出的字节偏移**。
                // 浏览器验收照这些点原样点下去，断言光标落到的字符与这里记的一致
                // （见 scripts/browser-check/writing-blocks-hit.mjs）。
                "hitProbes": probes,
            });
            println!("BLOCKFIXTURE:{}", json);
        }
    }

    /// 生成点击探针：在每个可渲染块的裁剪带里取「横向 5 × 纵向 3」个网格点，
    /// 每个点都过一遍**真实的** `hit_test`，把答案记下来当期望值。
    ///
    /// 为什么用网格而不是"每个字形取一个点"：夹具要能在**浏览器里原样复现**，
    /// 网格点是任意的 (x, y)，不依赖前端知道字形的位置；而期望值来自真实几何，
    /// 端到端验的还是"点在哪儿 → 光标落在哪个字符"。
    fn hit_probes(out: &BlocksOutput) -> Vec<serde_json::Value> {
        const XF: &[f64] = &[0.06, 0.3, 0.5, 0.7, 0.98];
        const YF: &[f64] = &[0.2, 0.55, 0.85];
        let mut probes = Vec::new();
        for (idx, b) in out.blocks.iter().enumerate() {
            if !b.found || b.svg.is_empty() || b.height_pt <= 0.5 {
                continue;
            }
            for &yf in YF {
                for &xf in XF {
                    let x = b.x_pt + b.width_pt * xf;
                    let y = b.y_pt + b.height_pt * yf;
                    if let Some(offset) = hit_test(b.start, b.end, b.page, x, y) {
                        // 保留两位小数：浏览器侧按这个值算视口坐标，误差 < 0.01pt 不会改变命中结果
                        probes.push(serde_json::json!({
                            "b": idx,
                            "x": (x * 100.0).round() / 100.0,
                            "y": (y * 100.0).round() / 100.0,
                            "o": offset,
                        }));
                    }
                }
            }
        }
        probes
    }

    /// 写作模式的块级渲染：区块要切得出来、宽度等于正文列宽、高度之和 ≈ 版心高度
    #[test]
    fn writing_mode_block_crops_are_sane() {
        const COLUMN_PT: f64 = 371.25; // = 495px（写作模式常见正文列宽）
        let src = "= 标题\n\n第一段正文，写得长一点以便观察断行与段落间距。\n\n- 列表项一\n- 列表项二\n\n$ integral_0^1 f(x) dif x $\n\n结尾段落。\n";
        let out = compile_blocks(src.to_string(), 0, None, &fonts_dir(), &FontConfig::default(), COLUMN_PT, None, None);
        assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
        assert!(out.pages == Some(1), "page(height: auto) 应为单张长页");

        let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
        assert!(
            rendered.len() >= 5,
            "标题/段落/列表项/公式/结尾段都应渲染出切片，实际 {} 个（共 {} 块）",
            rendered.len(),
            out.blocks.len()
        );
        for b in &rendered {
            assert!(b.svg.contains("<svg"), "切片应是 SVG：{}", &b.svg[..b.svg.len().min(60)]);
            assert!(
                (b.width_pt - COLUMN_PT).abs() < 0.5,
                "切片宽度应等于正文列宽 {}，实际 {}",
                COLUMN_PT,
                b.width_pt
            );
            assert!(b.height_pt > 0.5, "切片高度应为正：{}", b.height_pt);
            assert!(b.found && b.pages == 1);
        }
        // 块区间按源码顺序递增且不重叠（前端要靠它切"源码透镜"的边界）
        for pair in out.blocks.windows(2) {
            assert!(pair[0].end <= pair[1].start, "块区间应递增不重叠");
        }
        // 纵向总高度 = 首块顶到末块底（带间中点切分不丢高度）
        let total: f64 = rendered.iter().map(|b| b.height_pt).sum();
        let span = rendered.last().unwrap().y_pt + rendered.last().unwrap().height_pt
            - rendered.first().unwrap().y_pt;
        assert!(
            (total - span).abs() < 1.0,
            "各块高度之和 {total} 应等于首末块的纵向跨度 {span}"
        );
    }

    /// 前缀代码（设置里的编译前缀）不进块区间：返回的偏移应是**用户文档坐标**
    #[test]
    fn writing_mode_blocks_ignore_prefix_offset() {
        let prefix = "#set text(size: 12pt)\n";
        let doc = "= 标题\n\n正文。\n";
        let src = format!("{prefix}{doc}");
        let out = compile_blocks(
            src,
            prefix.len(),
            None,
            &fonts_dir(),
            &FontConfig::default(),
            371.25,
            None,
            None,
        );
        assert!(out.ok);
        // 第一个块（标题）应从文档的第 0 字节开始，而不是前缀之后
        let first = out.blocks.first().expect("应有块");
        assert_eq!(first.start, 0, "块偏移应是文档坐标（已减掉前缀）");
        assert!(first.end <= doc.len(), "块区间不应超出文档长度");
        assert!(!first.svg.is_empty(), "标题应渲染出切片");
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
