// 整篇编译（完整 SVG + 同轮几何）；预览重排的页设置注入见 PreviewPage。
use super::*;
use crate::block_geometry::PlacedItem;

/// A4 宽度（pt）：预览重排的默认纸型参考（原生探针与前端默认值同源）
pub(crate) const A4_WIDTH_PT: f64 = 595.28;

/// 预览重排：把预览的纸张换成给定几何（pt）。
///
/// 为什么要它（2026-09-14 首次落地，2026-10-08 按「实现写的通用一点」重做）：预览画布是一张
/// **固定版心**的页面，界面放大后它比预览栏宽，用户就得横向拖动才能看完一行（用户原话
/// 「预览模式还是有横的拖动的条」）。把预览的纸张改成"跟着预览栏走、正文按新宽度**重新排版**、
/// 字号不变"之后，预览栏永不出现横向滚动条，而且预览字号仍与编辑器一致
/// （11pt 正文 ↔ 14px 编辑区）。**代价（用户明确选择接受）：预览的换行/分页不再等于导出的 PDF。**
///
/// 与旧实现（插在编译源**最前面**）的关键区别：typst 的 `set` 规则**后写的赢**，插在最前面会被
/// 文档自己的 `#set page(paper: "a4")` 覆盖 —— 于是"文档自带纸型"的真实文档永远拿不到重排，
/// 只能退回等比缩放（这正是它被判定"不通用"的原因）。现在插在**文档自己的页面设置之后**
/// （见 [`inject_preview_page`]），自带纸型的文档也能重排。
///
/// 几何（页宽/页高/页边距）由**前端**算：纯逻辑、可单测、按文档自己的纸型等比缩放，见
/// `src/lib/core/preview-scale.ts`。这里只负责把它插进编译源，并把注入造成的偏移回映掉。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPage {
    pub width_pt: f64,
    pub height_pt: f64,
    pub margin_pt: f64,
}

impl PreviewPage {
    /// 三个数都得是有限正数（前端已按文档纸型夹过上下限，这里只防脏输入）
    fn sane(&self) -> bool {
        [self.width_pt, self.height_pt, self.margin_pt]
            .iter()
            .all(|v| v.is_finite() && *v > 0.0)
    }

    /// 注入用的源码行（**严格一行**：多行会让"注入行号回映"变成区间映射，没有必要）
    fn setup_line(&self) -> String {
        format!(
            "#set page(width: {:.2}pt, height: {:.2}pt, margin: {:.2}pt)",
            self.width_pt, self.height_pt, self.margin_pt
        )
    }
}

/// 注入造成的位置位移：编译源 ↔ 注入前的源。
///
/// 注入点在文档**中间**，所以只有它之后的偏移/行号要回映。几何项（`PlacedItem` 的源区间、
/// 字素停靠点）与主源诊断都要过这一手，前端才能继续按"前缀 + 用户文档"的线性坐标消费。
#[derive(Debug, Clone, Copy)]
pub(crate) struct OffsetMapping {
    /// 注入点（**注入前**的源字节偏移）
    offset: usize,
    /// 注入文本的字节长度
    len: usize,
}

impl OffsetMapping {
    /// 编译源字节偏移 → 注入前的源字节偏移。落进注入文本里的偏移收敛到注入点
    /// （实际只可能是引擎把诊断报在注入行上）。
    pub(crate) fn source_offset(&self, offset: usize) -> usize {
        if offset >= self.offset + self.len {
            offset - self.len
        } else if offset > self.offset {
            self.offset
        } else {
            offset
        }
    }
}

/// 注入结果：改好的编译源 + 位置回映所需的元信息
struct Injected {
    src: String,
    mapping: OffsetMapping,
}

/// 注入一行 `#set page(...)`：插在**最后一个顶层 `#set` / `#show` 节点之后**。
///
/// 为什么不是"文档开头"：`set` 规则**后写的赢**，而文档普遍把纸型写在开头
/// （`#set page(paper: "a4")`），插在它前面等于没插。`#show: 模板` 也一样 —— 模板里的
/// `set page` 在 show 规则**展开出来的内容**里，插在 show 之后仍然排在它前面，照样赢。
/// 没有这类节点（纯正文文档）就插在最前面。
///
/// 注入是否**真的生效**由前端用产物页宽复核（`isReflowApplied`）：文档把纸型写在别处
/// （嵌套块、别处 show）时注入可能被覆盖，那时老实用等比缩放，绝不硬套重排的假设。
fn inject_preview_page(src: &str, page: &PreviewPage) -> Option<Injected> {
    if !page.sane() {
        return None;
    }
    let (offset, insertion) = injection(src, &page.setup_line());
    let len = insertion.len();
    let mut injected = String::with_capacity(src.len() + len);
    injected.push_str(&src[..offset]);
    injected.push_str(&insertion);
    injected.push_str(&src[offset..]);
    Some(Injected {
        src: injected,
        mapping: OffsetMapping { offset, len },
    })
}

/// 注入点（注入前的源字节偏移）+ 要插入的文本。
///
/// 直接取语法节点末尾，不向后找换行：换行可能在块注释内部，或者同一行已出现正文。
/// 两侧换行隔开规则与原文；同行余下内容的行列通过字节映射还原。
fn injection(src: &str, line: &str) -> (usize, String) {
    let offset = injection_offset(src);
    let mut insertion = String::new();
    if offset > 0 && src.as_bytes()[offset - 1] != b'\n' {
        insertion.push('\n');
    }
    insertion.push_str(line);
    insertion.push('\n');
    (offset, insertion)
}

/// 注入点：最后一个顶层 `#set` / `#show` 节点末尾；没有这类节点就是 0。
fn injection_offset(src: &str) -> usize {
    let root = typst_syntax::parse(src);
    let mut end = None;
    for node in LinkedNode::new(&root).children() {
        if matches!(
            node.get().kind(),
            SyntaxKind::SetRule | SyntaxKind::ShowRule
        ) {
            end = Some(node.offset() + node.get().len());
        }
    }
    end.unwrap_or(0)
}

/// 几何项的源区间回映：`PlacedItem` 的区间与字素停靠点都是**编译源**坐标。
fn remap_geometry(items: &mut [PlacedItem], mapping: &OffsetMapping) {
    for item in items {
        let start = mapping.source_offset(item.range.start);
        let end = mapping.source_offset(item.range.end);
        item.range = start..end;
        if let Some(stops) = item.caret_stops.as_mut() {
            for stop in stops.iter_mut() {
                *stop = mapping.source_offset(*stop);
            }
        }
    }
}

/// 编译文档为每页 SVG（pages 按页序，含 <svg> 标签）。
/// 失败时返回诊断列表；成功但带警告时 warnings 附加返回。
///
/// **仅单测使用**：这个包装让单测省掉一个 `None` 实参；生产命令走增量入口，保留文档页设置。
/// 加 `#[cfg(test)]` 是为了不留一个生产侧永远不调用的 `pub fn`。
#[cfg(test)]
pub fn compile(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> CompileOutput {
    compile_with_renderer(src, document_path, fonts_dir, font_config, None, |pages| {
        (pages.iter().map(svg_for_page).collect(), Vec::new())
    })
}

/// 命令层的增量输出：known_pages 仅声明前端仍持有的对应页，不依赖服务器历史产物。
///
/// **仅单测使用**（不注入预览页宽的那条路）；生产入口见
/// [`compile_incremental_with_preview`]（`compile_doc` 调用它）。
#[cfg(test)]
pub fn compile_incremental(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    known_pages: Option<Vec<String>>,
) -> CompileOutput<Option<String>> {
    compile_incremental_with_preview(
        src,
        document_path,
        fonts_dir,
        font_config,
        known_pages,
        None,
    )
}

/// 同上，外加**预览重排**：`preview` 为 `Some` 时按给定几何重新排版预览（见 [`PreviewPage`]）。
pub fn compile_incremental_with_preview(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    known_pages: Option<Vec<String>>,
    preview: Option<PreviewPage>,
) -> CompileOutput<Option<String>> {
    compile_with_renderer(
        src,
        document_path,
        fonts_dir,
        font_config,
        preview,
        |pages| super::svg_cache::incremental_pages(pages, known_pages.as_deref()),
    )
}

fn compile_with_renderer<P>(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    preview: Option<PreviewPage>,
    render: impl FnOnce(&[Page]) -> (Vec<P>, Vec<String>),
) -> CompileOutput<P> {
    // 未保存文档时预检相对 include，给出明确诊断（编译阶段只会得到笼统的 file not found）。
    // **在注入页设置之前做**：这些诊断的行号直接来自用户文档，不该被注入的行影响。
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return CompileOutput {
                ok: false,
                pages: Vec::new(),
                page_keys: Vec::new(),
                geometry_id: None,
                diagnostics: diags,
                warnings: Vec::new(),
            };
        }
    }

    let source_len = src.len();
    let injected = preview.and_then(|page| inject_preview_page(&src, &page));
    let (compilation_source, original_lines, mapping) = match injected {
        Some(injected) => (
            injected.src,
            Some(typst::syntax::Lines::new(src)),
            Some(injected.mapping),
        ),
        None => (src, None, None),
    };
    let injected_lines = match (original_lines.as_ref(), mapping) {
        (Some(lines), Some(mapping)) => InjectedLines::inserted(lines, mapping),
        _ => InjectedLines::default(),
    };

    let world = TypstWorld::new(compilation_source, document_path, fonts_dir, font_config);
    match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(document),
            warnings,
        } => {
            let (mut items, stats) = crate::block_geometry::collect_geometry(&world, &document);
            if let Some(mapping) = &mapping {
                remap_geometry(&mut items, mapping);
            }
            let geometry_id = crate::document_geometry::store(items, source_len, stats.foreign_ink);
            let (pages, page_keys) = render(document.pages());
            CompileOutput {
                ok: true,
                pages,
                page_keys,
                geometry_id: Some(geometry_id),
                diagnostics: Vec::new(),
                warnings: collect_diagnostics(&world, warnings, injected_lines),
            }
        }
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => CompileOutput {
            ok: false,
            pages: Vec::new(),
            page_keys: Vec::new(),
            geometry_id: None,
            diagnostics: collect_diagnostics(&world, errors, injected_lines),
            warnings: Vec::new(),
        },
    }
}

/// 单页 SVG 导出
pub(crate) fn svg_for_page(page: &Page) -> String {
    super::svg_cache::cached_svg(page)
}
