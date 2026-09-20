// 编译入口：预览页宽重排（`preview_page_setup`）与整篇编译（SVG 输出）。
use super::*;

/// A4 尺寸（pt）：预览重排按它的比例缩放页宽/页高/边距
pub(crate) const A4_WIDTH_PT: f64 = 595.28;
const A4_HEIGHT_PT: f64 = 841.89;
/// 预览重排的边距比例：A4 的默认边距（2.5cm ≈ 70.87pt）占页宽的比例，按同比例缩放
const PREVIEW_MARGIN_RATIO: f64 = 70.87 / A4_WIDTH_PT;
/// 预览页宽的允许范围（pt）：太窄会把正文挤成一列碎字，超过 A4 没有意义（前端也会夹）
pub(crate) const PREVIEW_PAGE_MIN_PT: f64 = 180.0;

/// 预览重排用的页设置语句（typst 源码，**一行**）。
///
/// 为什么要它：预览画布是一张**固定版心**的页面（A4），界面放大后它比预览栏宽，
/// 用户就得横向拖动才能看完一行（2026-09-14 反馈「预览模式还是有横的拖动的条」）。
/// 这一行把预览的纸张改成"和预览栏一样宽、字号不变"——正文**按新宽度重新排版**，
/// 于是画布正好铺满预览栏、永不出现横向滚动条，而且预览字号仍与编辑器一致。
/// 代价：预览的换行/分页不再等于导出的 PDF（用户明确选择接受）。
///
/// 注意它放在编译源的**最前面**：文档自己写 `#set page(...)`（后写的赢）就会覆盖它，
/// 那时预览退回旧的"按栏宽等比缩放"路径——前端用返回 SVG 的实际页宽判断是否生效。
fn preview_page_setup(width_pt: f64) -> Option<String> {
    if !width_pt.is_finite() {
        return None;
    }
    let width = width_pt.clamp(PREVIEW_PAGE_MIN_PT, A4_WIDTH_PT);
    let height = width * A4_HEIGHT_PT / A4_WIDTH_PT;
    let margin = width * PREVIEW_MARGIN_RATIO;
    Some(format!(
        "#set page(width: {width:.2}pt, height: {height:.2}pt, margin: {margin:.2}pt)"
    ))
}

/// 编译文档为每页 SVG（pages 按页序，含 <svg> 标签）。
/// 失败时返回诊断列表；成功但带警告时 warnings 附加返回。
///
/// **仅单测使用**：生产路径一律带预览页宽，这个包装只是让单测省掉一个 `None` 实参；
/// 加 `#[cfg(test)]` 是为了不留一个生产侧永远不调用的 `pub fn`。
#[cfg(test)]
pub fn compile(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> CompileOutput {
    compile_with_page_width(src, document_path, fonts_dir, font_config, None)
}

/// 同上，但可以指定**预览页宽**（pt）：`Some(w)` 时在编译源最前面注入一行
/// [`preview_page_setup`]，让预览按预览栏宽度重新排版（见那里的说明）。
/// 主源诊断的行号会**减回**注入的那一行，所以前端的位置映射逻辑完全不用改；
/// include 文件（path 非空）的诊断行号不动。
pub fn compile_with_page_width(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    preview_width_pt: Option<f64>,
) -> CompileOutput {
    // 未保存文档时预检相对 include，给出明确诊断（编译阶段只会得到笼统的 file not found）。
    // **在注入页设置之前做**：这些诊断的行号直接来自用户文档，不该被注入的行影响。
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return CompileOutput {
                ok: false,
                pages: Vec::new(),
                diagnostics: diags,
                warnings: Vec::new(),
            };
        }
    }

    let injected = preview_width_pt.and_then(preview_page_setup);
    let main_line_offset = if injected.is_some() { 1 } else { 0 };
    let src = match injected {
        Some(setup) => format!("{setup}\n{src}"),
        None => src,
    };

    let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
    match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(document),
            warnings,
        } => {
            let pages = document.pages().iter().map(svg_for_page).collect();
            CompileOutput {
                ok: true,
                pages,
                diagnostics: Vec::new(),
                warnings: collect_diagnostics(&world, warnings, main_line_offset),
            }
        }
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => CompileOutput {
            ok: false,
            pages: Vec::new(),
            diagnostics: collect_diagnostics(&world, errors, main_line_offset),
            warnings: Vec::new(),
        },
    }
}

/// 单页 SVG 导出
pub(crate) fn svg_for_page(page: &Page) -> String {
    typst_svg::svg(page, &SvgOptions::default())
}
