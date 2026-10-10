// 诊断转换：typst `SourceDiagnostic` → 前端 `Diagnostic`（span → 1-based 行列）。
use super::*;

/// 切片的行首注入与预览的中途字节注入共用诊断转换；后者还原同行后缀的列号。
#[derive(Clone, Copy, Default)]
pub(crate) struct InjectedLines<'a> {
    at_line: u32,
    insertion: Option<(&'a typst::syntax::Lines<String>, OffsetMapping)>,
}

impl<'a> InjectedLines<'a> {
    pub(crate) fn inserted(
        lines: &'a typst::syntax::Lines<String>,
        mapping: OffsetMapping,
    ) -> Self {
        Self {
            at_line: 0,
            insertion: Some((lines, mapping)),
        }
    }

    /// 注入在编译源最前面（`compile_blocks` 的切片路径：它的注入行永远在开头）
    pub(crate) fn front() -> Self {
        Self {
            at_line: 1,
            insertion: None,
        }
    }

    /// 编译源行号（1-based）→ 注入前的源行号
    pub(crate) fn to_source_line(self, line: u32) -> u32 {
        if self.at_line > 0 && line > self.at_line {
            line - 1
        } else {
            line
        }
    }
}

/// 把 typst 的 SourceDiagnostic 转为前端诊断（span → 1-based 行列）。
/// 无法定位位置（detached span / 外部数据文件）的诊断跳过。
pub(crate) fn collect_diagnostics(
    world: &TypstWorld,
    diags: impl IntoIterator<Item = SourceDiagnostic>,
    injected: InjectedLines<'_>,
) -> Vec<Diagnostic> {
    diags
        .into_iter()
        .filter_map(|d| to_diagnostic(world, &d, injected))
        .collect()
}

/// 按 span 的文件身份映射主源行列；消息中 searched-at 的路径不改变坐标所属源文件。
/// include 文件使用自己的行列，不受主源注入影响。
pub(crate) fn to_diagnostic(
    world: &TypstWorld,
    diag: &SourceDiagnostic,
    injected: InjectedLines<'_>,
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
            if id == world.main() {
                if let Some((lines, mapping)) = injected.insertion {
                    let start = lines.byte_to_line_column(mapping.source_offset(range.start))?;
                    let end = fix_span_end(lines, start, mapping.source_offset(range.end));
                    (start, end)
                } else {
                    let lines = source.lines();
                    let start = lines.byte_to_line_column(range.start)?;
                    (start, fix_span_end(lines, start, range.end))
                }
            } else {
                let lines = source.lines();
                let start = lines.byte_to_line_column(range.start)?;
                (start, fix_span_end(lines, start, range.end))
            }
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
    let lines = if id == world.main() {
        injected
    } else {
        InjectedLines::default()
    };

    // 「越界」这类只有引擎黑话的诊断补上可操作信息（见 escape_hint）
    let message = match escape_hint(&diag.message, world.project_root()) {
        Some(hint) => format!("{} {hint}", diag.message),
        None => diag.message.to_string(),
    };

    Some(Diagnostic {
        message,
        severity: severity.to_string(),
        line: lines.to_source_line(start.0 as u32 + 1),
        column: start.1 as u32 + 1,
        end_line: Some(lines.to_source_line(end.0 as u32 + 1)),
        end_column: Some(end.1 as u32 + 1),
        path,
    })
}

/// 修正 span 结束位置：结束字节落在行首（整行诊断常见）时，归一到上一行行尾，
/// 避免 CodeMirror 波浪线跨到下一行。
fn fix_span_end<T: AsRef<str>>(
    lines: &typst::syntax::Lines<T>,
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
