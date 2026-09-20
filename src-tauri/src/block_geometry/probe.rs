use super::*;
use crate::typst_world::offset_to_line_column;

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
    // 与 `typst_world::A4_WIDTH_PT` 同源（别再抄一遍 595.28）
    let margin = page_width_pt * (70.87 / crate::typst_world::A4_WIDTH_PT);
    let injected =
        format!("#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin:.2}pt)\n");
    let compiled_src = format!("{injected}{src}");
    let injected_len = injected.len();

    let t0 = Instant::now();
    let world = TypstWorld::new(compiled_src, document_path, fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc), ..
        } => doc,
        typst::diag::Warned {
            output: Err(errors),
            ..
        } => {
            return ProbeReport {
                ok: false,
                error: Some(format!(
                    "编译失败：{} 处错误（{}）",
                    errors.len(),
                    errors[0].message
                )),
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
        let (end_line, _) = offset_to_line_column(
            &src,
            block.range.end.saturating_sub(1).max(block.range.start),
        );
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
            w: geom
                .as_ref()
                .map(|g| g.rect.size().x.to_pt())
                .unwrap_or(0.0),
            h: geom
                .as_ref()
                .map(|g| g.rect.size().y.to_pt())
                .unwrap_or(0.0),
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
            if s < e {
                Some((s, e))
            } else {
                None
            }
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
                if s < e {
                    Some((s, e))
                } else {
                    None
                }
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
        let line_end = src[line_start..]
            .find('\n')
            .map(|i| line_start + i)
            .unwrap_or(src.len());
        if !src[line_start..line_end].trim().is_empty()
            && !covered_ranges
                .iter()
                .any(|(s, e)| *s < line_end && *e > line_start)
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
    found.sort_by(|a, b| a.pages.cmp(&b.pages).then(a.y.total_cmp(&b.y)));
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
    if !found.is_empty() && !min_gap.is_finite() {
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

fn preview_of(src: &str, range: Range<usize>) -> String {
    let s: String = src[range].chars().take(40).collect();
    s.replace('\n', "⏎")
}
