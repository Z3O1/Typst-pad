// 诊断转换：typst `SourceDiagnostic` → 前端 `Diagnostic`（span → 1-based 行列）。
use super::*;

/// 把 typst 的 SourceDiagnostic 转为前端诊断（span → 1-based 行列）。
/// 无法定位位置（detached span / 外部数据文件）的诊断跳过。
pub(crate) fn collect_diagnostics(
    world: &TypstWorld,
    diags: impl IntoIterator<Item = SourceDiagnostic>,
    main_line_offset: u32,
) -> Vec<Diagnostic> {
    diags
        .into_iter()
        .filter_map(|d| to_diagnostic(world, &d, main_line_offset))
        .collect()
}

/// `main_line_offset` = 编译源最前面注入的行数（预览重排的 `#set page(...)`，见
/// [`preview_page_setup`]）：**只对主源**（path 为 None）的诊断把行号减回去，
/// 这样前端"编译源行号 → 用户文档行号"的映射不需要知道注入这件事；
/// include 文件的行号本来就是那个文件自己的，不动。
pub(crate) fn to_diagnostic(
    world: &TypstWorld,
    diag: &SourceDiagnostic,
    main_line_offset: u32,
) -> Option<Diagnostic> {
    let severity = match diag.severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    };
    let id = diag.span.id()?;
    // span → 字节区间（typst 0.15 的 span 需要 Source 定位，WorldExt::range 已封装）
    let range = world.range(diag.span)?;

    // 主文档/include 源码有完整的行列信息；外部数据文件（如 csv 错误）退化为 1,1
    let (start, end) = match world.read_source(id) {
        Ok(source) => {
            let lines = source.lines();
            let start = lines.byte_to_line_column(range.start)?;
            let end = fix_span_end(lines, start, range.end);
            (start, end)
        }
        Err(_) => ((0, 0), (0, 0)),
    };

    // 出错文件路径：优先取诊断消息中 "searched at" 给出的具体文件路径
    //（缺失 include/图片的报错定位在主文档的引用处，但真正出错的是被加载的文件）；
    // 否则取诊断所在文件（主文档为 None，include 为其路径）
    let path = diag
        .message
        .rsplit_once("searched at ")
        .map(|(_, p)| p.trim_end_matches(')').to_string())
        .or_else(|| world.path_of(id));

    // 主源诊断的行号减回注入的行（include 文件的行号是它自己的，不动）
    let shift = if path.is_none() { main_line_offset } else { 0 };

    // 「越界」这类只有引擎黑话的诊断补上可操作信息（见 escape_hint）
    let message = match escape_hint(&diag.message, world.project_root()) {
        Some(hint) => format!("{} {hint}", diag.message),
        None => diag.message.to_string(),
    };

    Some(Diagnostic {
        message,
        severity: severity.to_string(),
        line: (start.0 as u32).saturating_sub(shift) + 1,
        column: start.1 as u32 + 1,
        end_line: Some((end.0 as u32).saturating_sub(shift) + 1),
        end_column: Some(end.1 as u32 + 1),
        path,
    })
}

/// 修正 span 结束位置：结束字节落在行首（整行诊断常见）时，归一到上一行行尾，
/// 避免 CodeMirror 波浪线跨到下一行。
fn fix_span_end(
    lines: &typst::syntax::Lines<String>,
    start: (usize, usize),
    end_byte: usize,
) -> (usize, usize) {
    let Some(mut end) = lines.byte_to_line_column(end_byte) else {
        return start;
    };
    if end.1 == 0 && end.0 > start.0 {
        let prev = end.0 - 1;
        if let Some(range) = lines.line_to_range(prev) {
            let text = &lines.text()[range];
            let mut cols = text.chars().count();
            if text.ends_with('\n') || text.ends_with('\r') {
                cols -= 1;
            }
            end = (prev, cols);
        }
    }
    end
}
