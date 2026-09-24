use super::*;

// ---------------------------------------------------------------------------
// 公式级渲染（编辑器内联渲染 = 所见即所得用）
// ---------------------------------------------------------------------------

/// 公式渲染的默认文本尺寸（pt，= 14px）。
/// **字号必须与编辑器正文字号一致**，否则公式与正文大小不匹配（写作模式正文 16px = 12pt，
/// 前端会把实测字号传进来；源码模式 14px = 10.5pt）。SVG 的 pt 与编辑器 CSS 的 pt
/// 1:1，因此前端不需要任何缩放换算。
pub const MATH_TEXT_PT: f64 = 10.5;

/// 允许的公式字号范围（pt）：防止前端传入荒谬值把探针文档搞坏
const MATH_SIZE_RANGE: std::ops::RangeInclusive<f64> = 6.0..=48.0;

/// 基线探针高度（pt）：零宽盒挂在基线下 100pt（远超任何公式的下沉量），
/// 第二页页高 = 基线以上高度 + 100pt，据此反推基线位置。
const BASELINE_PROBE_PT: f64 = 100.0;

/// 公式渲染结果：svg 为「贴边 + 透明背景」的单页 SVG；
/// baseline_pt 为**基线到盒顶**的距离（前端用 vertical-align: -(height - baseline) 对齐）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MathOutput {
    pub ok: bool,
    pub svg: String,
    pub width_pt: f64,
    pub height_pt: f64,
    pub baseline_pt: f64,
    pub error: Option<String>,
    /// **可断行的片段**（只有长行内公式才有；空数组 = 只能整块渲染）。
    ///
    /// Typst 会在行内公式的运算符处折行，而浏览器把整块 SVG 当不可断的原子 → 临界行比引擎
    /// 早折一行（PKU 实测：同一段浏览器折 4 行、Typst 3 行，位置与行数两条门槛同时红）。
    /// 前端把片段依次渲染、片段之间留一个可断点，行宽就能与引擎一致。
    #[serde(default)]
    pub segments: Vec<MathSegment>,
}

/// 行内公式的一个可断行片段（坐标系与 `MathOutput` 一致）
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MathSegment {
    /// 片段源码（下一个片段以运算符开头；拼起来等于原公式）
    pub body: String,
    pub svg: String,
    pub width_pt: f64,
    pub height_pt: f64,
    pub baseline_pt: f64,
}

impl MathOutput {
    /// 渲染失败：前端据此**保持源码显示**（不显示空 widget，也不报错弹窗）
    fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            svg: String::new(),
            width_pt: 0.0,
            height_pt: 0.0,
            baseline_pt: 0.0,
            error: Some(message.into()),
            segments: Vec::new(),
        }
    }

    /// 任务异常终止（spawn_blocking panic 等），命令层使用
    pub(crate) fn internal_error(message: impl Into<String>) -> Self {
        Self::fail(message)
    }
}

/// 单个公式 → 紧致 SVG + 尺寸与基线（编辑器内联渲染用）。
///
/// **两页探针法**（一次编译同时拿到盒与基线）：typst 的 Page 帧不带基线
/// （`page.frame.baseline()` 实测返回盒底，has_baseline=false），所以自己造参考：
///   第 1 页：`#box($公式$)`          → 页尺寸 = 公式紧致盒（宽 W，高 H = ascent + depth）
///   第 2 页：同一内容 + 一个挂在基线下 `BASELINE_PROBE_PT` 的零宽盒
///            → 页高 = ascent + PROBE，于是 ascent = H2 - PROBE，depth = H - ascent
/// 外层 `#box(...)` 不可省：行间（display 风格）公式不加盒时，第 2 页的探针会另起一段，
/// 段落堆叠会把基线关系算错（实测 ascent 由 11.75pt 变成 31.67pt）。
///
/// context 为编译前缀（用户设置里的前缀代码），与整篇编译同源：`#set font(..)`、
/// `#let` 宏等对公式同样生效；公式字号由本函数**随后强制**为 MATH_TEXT_PT，
/// 保证编辑器内公式与编辑器正文字号一致（前缀里的 `#set text(size:)` 不会带偏公式）。
/// document_path 语义与 compile 一致（相对 include 的解析根；None = 未保存文档）。
fn compile_math_once(
    body: &str,
    display: bool,
    context: &str,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    size_pt: f64,
) -> MathOutput {
    // 夹取到合理范围（NaN/越界都退回默认），保证探针文档始终可编译
    let size_pt = if size_pt.is_finite() && MATH_SIZE_RANGE.contains(&size_pt) {
        size_pt
    } else {
        MATH_TEXT_PT
    };
    // 行内 `$x$`；行间 `$ x $`（首尾空格让 typst 按 display 风格排版）
    let math = if display {
        format!("$ {body} $")
    } else {
        format!("${body}$")
    };
    let src = math_probe_source(context, &math, size_pt, None);

    let world = TypstWorld::new(src, document_path.clone(), fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc), ..
        } => doc,
        typst::diag::Warned {
            output: Err(errors),
            ..
        } => {
            // 诊断位置属于内部探针文档（含前缀偏移），对用户无意义，只回消息
            let first = errors
                .into_iter()
                .next()
                .map(|d| d.message.to_string())
                .unwrap_or_else(|| "公式编译失败".to_string());
            return MathOutput::fail(first);
        }
    };

    let pages = document.pages();
    if pages.len() < 2 {
        return MathOutput::fail("公式渲染失败：探针文档未产生两页");
    }
    let size = pages[0].frame.size();
    let width_pt = size.x.to_pt();
    let frame_height_pt = size.y.to_pt();
    let probe_height_pt = pages[1].frame.size().y.to_pt();
    // 夹取到 [0, H]：探针盒比公式本身矮时（理论上不会）也不会给出越界基线
    let ascent_pt = (probe_height_pt - BASELINE_PROBE_PT).clamp(0.0, frame_height_pt);

    // 墨迹可能画到帧外（见 ink_bounds_of_frame）：SVG 视口按帧尺寸裁剪，下标就会缺一截。
    let ink = ink_bounds_of_frame(&pages[0].frame);
    let pad_top_pt = (-ink.top.to_pt()).max(0.0);
    let height_pt = ink.bottom.to_pt().max(frame_height_pt) + pad_top_pt;

    // 只有真的溢出时才走第二遍：给页面显式尺寸 + 顶部内边距，让内容整体落在画布内。
    // （不给尺寸就还是贴边页，帧外的东西照样被裁；顶部内边距是因为上标方向也会溢出去）
    let overflows = pad_top_pt > 0.01 || height_pt > frame_height_pt + 0.01;
    let svg = if overflows {
        let src = math_probe_source(
            context,
            &math,
            size_pt,
            Some((width_pt, height_pt, pad_top_pt, ascent_pt)),
        );
        let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
        match typst::compile::<PagedDocument>(&world) {
            typst::diag::Warned {
                output: Ok(doc), ..
            } => svg_for_page(&doc.pages()[0]),
            // 第二遍只是"把画布撑大"，失败了就用第一遍的产物（少一截总比什么都没有强）
            typst::diag::Warned { output: Err(_), .. } => svg_for_page(&pages[0]),
        }
    } else {
        svg_for_page(&pages[0])
    };

    MathOutput {
        ok: true,
        svg,
        width_pt,
        height_pt,
        baseline_pt: (ascent_pt + pad_top_pt).clamp(0.0, height_pt),
        error: None,
        segments: Vec::new(),
    }
}

/// 顶层运算符（Typst 行内公式可以在这些位置折行）——按长到短匹配前缀。
const BREAK_OPERATORS: &[&str] = &["<=", ">=", "!=", "==", "->", "<-", "<", ">", "=", "+", "-"];

/// 把**行内**公式按顶层运算符切成可断行的片段（切在运算符**之前**）。
///
/// 只在够长的公式上切（`MIN_SEGMENT_CHARS`），否则会为短公式白跑好几次编译。
/// 括号 / 方括号 / 花括号里的运算符不算顶层（`sum_(i=1)^n` 的 `=` 不会被切）。
pub fn split_inline_math(body: &str) -> Vec<String> {
    /// 单个片段的最少源码字符数：太短的片段攒在一起再切
    const MIN_SEGMENT_CHARS: usize = 20;
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let chars: Vec<char> = body.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
        if depth == 0 && !current.trim().is_empty() && current.chars().count() >= MIN_SEGMENT_CHARS
        {
            let rest: String = chars[i..].iter().collect();
            if let Some(op) = BREAK_OPERATORS.iter().find(|op| rest.starts_with(**op)) {
                // 片段以运算符开头；`current` 末尾的空格留给下一段，避免丢间距
                parts.push(current.trim_end().to_string());
                current = String::new();
                let _ = op;
            }
        }
        current.push(ch);
        i += 1;
    }
    if !current.trim().is_empty() {
        parts.push(current.trim_end().to_string());
    }
    parts.retain(|p| !p.trim().is_empty());
    parts
}

/// 单个公式 → 紧致 SVG + 尺寸与基线；长行内公式额外给出**可断行片段**（`segments`）。
///
/// 片段是"同一公式按顶层运算符切开、各自编译"的结果：前端依次渲染、片段之间留一个可断点，
/// 浏览器就能像 Typst 一样在运算符处折行（见 `MathOutput::segments` 的说明）。
pub fn compile_math(
    body: &str,
    display: bool,
    context: &str,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    size_pt: f64,
) -> MathOutput {
    let mut out = compile_math_once(
        body,
        display,
        context,
        document_path.clone(),
        fonts_dir,
        font_config,
        size_pt,
    );
    if out.ok && !display {
        let parts = split_inline_math(body);
        if parts.len() > 1 {
            let mut segments = Vec::with_capacity(parts.len());
            let mut all_ok = true;
            for part in parts {
                let one = compile_math_once(
                    &part,
                    false,
                    context,
                    document_path.clone(),
                    fonts_dir,
                    font_config,
                    size_pt,
                );
                if !one.ok {
                    all_ok = false;
                    break;
                }
                segments.push(MathSegment {
                    body: part,
                    svg: one.svg,
                    width_pt: one.width_pt,
                    height_pt: one.height_pt,
                    baseline_pt: one.baseline_pt,
                });
            }
            // 有片段编不出来就整体不分段（宁可整块渲染，也不要半截公式）
            if all_ok {
                out.segments = segments;
            }
        }
    }
    out
}

/// 公式探针文档的源码（两遍编译共用）。
///
/// 形态：第一页 = 公式本身（`width/height: auto` + `margin: 0` + `fill: none` → 贴边透明页，
/// SVG 即公式本身）；第二页 = 公式 + 一个挂在基线下 100pt 的零宽盒（用来反推 ascent）。
///
/// `padded` 有值时改用**显式页面尺寸**并给内容加顶部内边距（用于"墨迹画到帧外"的补救，
/// 见 `ink_bounds_of_frame`）：`(page_width, page_height, pad_top, ascent)`。
fn math_probe_source(
    context: &str,
    math: &str,
    size_pt: f64,
    padded: Option<(f64, f64, f64, f64)>,
) -> String {
    let mut src = String::with_capacity(context.len() + math.len() * 2 + 320);
    if !context.is_empty() {
        src.push_str(context);
        if !context.ends_with('\n') {
            src.push('\n');
        }
    }
    match padded {
        None => {
            src.push_str("#set page(width: auto, height: auto, margin: 0pt, fill: none)\n");
            src.push_str(&format!("#set text(size: {size_pt}pt)\n"));
            src.push_str(&format!(
                "#box({math})\n#pagebreak()\n#box({math})#box(width: 0pt, height: {BASELINE_PROBE_PT}pt, baseline: {BASELINE_PROBE_PT}pt)"
            ));
        }
        Some((page_w, page_h, pad_top, ascent)) => {
            // 第一页：显式尺寸 + 顶部内边距（内容整体下移 pad_top，墨迹才落在画布内）
            src.push_str("#set page(margin: 0pt, fill: none)\n");
            src.push_str(&format!("#set text(size: {size_pt}pt)\n"));
            src.push_str(&format!(
                "#set page(width: {page_w}pt, height: {page_h}pt)\n"
            ));
            // 注意：进了 pad(...) 的**代码模式**后子里不能再写 `#box(...)`（会报
            // "the character `#` is not valid in code"），用内容块 `[ ... ]` 回到 markup 模式
            src.push_str(&format!("#pad(top: {pad_top}pt)[#box({math})]\n"));
            // 第二页：探针页保持"自动高度"，高度 = pad_top + ascent + 100
            src.push_str("#set page(width: auto, height: auto)\n");
            src.push_str(&format!(
                "#pagebreak()\n#pad(top: {pad_top}pt)[#box({math})#box(width: 0pt, height: {BASELINE_PROBE_PT}pt, baseline: {BASELINE_PROBE_PT}pt)]"
            ));
            let _ = ascent; // 显式页高已经覆盖了探针页，这里只需保持同一基线
        }
    }
    src
}

/// 帧内容的墨迹纵向范围（相对帧左上角，y 向下）。
///
/// **为什么需要它**：typst 允许把内容画到帧**外面**，帧尺寸只反映"排版尺寸"。数学排版里的
/// 上下标就是这种情形——实测（typst 0.15.1）`$a_0$` 的帧高只有 8.196pt（= 基准字母的 ascent，
/// 基线正好落在帧底边），而下标 `0` 的基线在 **11.16pt**，比帧底还低 2.96pt。平时看不出来
/// （正文页够大、帧不裁剪），但我们的公式页是 `height: auto` 的**贴边页**，导出成 SVG 后
/// **视口就是裁剪框** —— 下标被裁掉，用户看到的就是「a_0 的下半部分没有渲染」。
///
/// 这里递归把帧内容的墨迹范围算出来（group 按自己的仿射变换映射、文本按字体的
/// ascender/descender、图形/图片/链接按各自尺寸），供公式导出把画布撑够。
#[derive(Debug, Clone, Copy)]
struct InkBounds {
    top: Abs,
    bottom: Abs,
}

fn ink_bounds_of_frame(frame: &Frame) -> InkBounds {
    let mut top = Abs::zero();
    let mut bottom = Abs::zero();
    for (pos, item) in frame.items() {
        let (item_top, item_bottom) = item_ink_bounds(item);
        // 子项的坐标在 group 内部，group 的 transform 已在递归里映射过，这里加外层偏移
        let t = pos.y + item_top;
        let b = pos.y + item_bottom;
        if t < top {
            top = t;
        }
        if b > bottom {
            bottom = b;
        }
    }
    InkBounds { top, bottom }
}

/// 单个帧项的墨迹纵向范围（相对该项自己的原点，y 向下、基线为 0）
fn item_ink_bounds(item: &FrameItem) -> (Abs, Abs) {
    match item {
        FrameItem::Text(t) => {
            // 用**字形包围盒**而不是字体度量：度量的 descender 是"排版值"，实测比真实墨迹还浅
            // ——`sqrt(x^2 + y^2)` 里 Libertinus 的 `y` 尾巴比 descender 低约 1pt，用度量会再裁一次。
            let mut up = Abs::zero();
            let mut down = Abs::zero();
            for glyph in &t.glyphs {
                let (top, bottom) = t.font.edges(
                    TopEdge::Metric(TopEdgeMetric::Bounds),
                    BottomEdge::Metric(BottomEdgeMetric::Bounds),
                    t.size,
                    TextEdgeBounds::Glyph(glyph.id),
                );
                if top > up {
                    up = top;
                }
                if bottom > down {
                    down = bottom;
                }
            }
            if up <= Abs::zero() && down <= Abs::zero() {
                // 字体没提供字形包围盒（极少数）：退回字体度量。宁可多留白，也不裁字。
                let m = t.font.metrics();
                (-m.ascender.at(t.size), m.descender.at(t.size).abs())
            } else {
                (-up, down)
            }
        }
        FrameItem::Group(g) => {
            let inner = ink_bounds_of_frame(&g.frame);
            // 子帧的上下边经 group 变换映射回本层（变换可能含 y 翻转，所以取两者较大值）
            let a = Point::new(Abs::zero(), inner.top).transform(g.transform);
            let b = Point::new(Abs::zero(), inner.bottom).transform(g.transform);
            (a.y.min(b.y), a.y.max(b.y))
        }
        FrameItem::Image(_, size, _) | FrameItem::Link(_, size) => (Abs::zero(), size.y),
        FrameItem::Shape(s, _) => {
            // 图形（根号、分数线等）的墨迹就是它自己的包围盒；坐标相对该项原点
            // （y 向下为正，min.y 可能为负 → 会往基线以上长）
            let bb = s.bbox(true);
            (bb.min.y, bb.max.y)
        }
        FrameItem::Tag(_) => (Abs::zero(), Abs::zero()),
    }
}
