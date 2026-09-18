// PDF 导出：编译后落字节（路径校验由 lib.rs 的 validate_write_path 负责）。
use super::*;

/// 编译并导出 PDF 字节（成功返回字节，失败返回人类可读错误信息）
pub fn compile_to_pdf_bytes(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> Result<Vec<u8>, String> {
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return Err(diags.into_iter().next().map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    }

    let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc),
            warnings: _,
        } => doc,
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => {
            // 导出失败时给出第一条诊断的可读信息
            // PDF 导出不做预览重排注入（偏移恒为 0）
            let first = errors
                .into_iter()
                .find_map(|d| to_diagnostic(&world, &d, 0));
            return Err(first.map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    };
    match typst_pdf::pdf(&document, &PdfOptions::default()) {
        Ok(bytes) => Ok(bytes),
        Err(errors) => {
            // PDF 导出不做预览重排注入（偏移恒为 0）
            let first = errors
                .into_iter()
                .find_map(|d| to_diagnostic(&world, &d, 0));
            Err(first.map_or_else(
                || "PDF 导出失败".to_string(),
                |d| format!("PDF 导出失败: {}: 行 {} 列 {}", d.message, d.line, d.column),
            ))
        }
    }
}
