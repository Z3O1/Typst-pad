// 编译 / 导出 / 点击定位命令。`CompileState` 与 `in_compile_channel` 在这里，`paths` 只提供写盘校验。
//
// `compile_doc` / `export_pdf` 通过互斥锁与 spawn_blocking 串行编译；
// 整页命中、光标和选区查询只读已有几何，不占编译通道。
use std::fs;
use std::path::Path;

use crate::paths::validate_write_path;

/// 内嵌编译状态：编译互斥锁（typst 引擎进程内串行编译，避免并发 CPU 竞争与共享状态错乱）
/// + 字体目录（setup 时解析一次）。Arc/PathBuf 可克隆，便于 move 进 spawn_blocking。
pub struct CompileState {
    pub lock: std::sync::Arc<std::sync::Mutex<()>>,
    pub fonts_dir: std::path::PathBuf,
}

impl CompileState {
    pub fn new(fonts_dir: std::path::PathBuf) -> Self {
        Self {
            lock: std::sync::Arc::new(std::sync::Mutex::new(())),
            fonts_dir,
        }
    }
}

/// 与 Typst CLI watch 一致，任务结束后清理超过 10 轮未命中的 comemo 历史。
/// 返回产物自己持有数据；清理不作废 SVG 或交互几何，也不改变显式导出。
pub(crate) fn with_compiler_cache<T>(job: impl FnOnce() -> T) -> T {
    let output = job();
    typst::comemo::evict(10);
    output
}

/// 编译通道：克隆锁与字体目录 → 构造 `FontConfig` → 在 `spawn_blocking` 里**持锁**跑 `job`。
///
/// `FontConfig::new` 在拿锁之前执行，只整理字体配置。
/// 返回 `Err(())` 表示任务异常终止；调用方按自己的结果类型报告失败。
pub(crate) async fn in_compile_channel<T, F>(
    state: &CompileState,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
    job: F,
) -> Result<T, ()>
where
    T: Send + 'static,
    F: FnOnce(&Path, &crate::typst_world::FontConfig) -> T + Send + 'static,
{
    let lock = std::sync::Arc::clone(&state.lock);
    let fonts_dir = state.fonts_dir.clone();
    let fonts = crate::typst_world::FontConfig::new(font_families, font_dirs);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        with_compiler_cache(|| job(&fonts_dir, &fonts))
    })
    .await
    .map_err(|_| ())
}

/// 编译文档为每页 SVG（compile_doc）：src 为主文档源码，document_path 为磁盘路径
/// （None = 未保存，相对导入会报"需要先保存文档"）。
/// `preview_page` 为 `Some` 时按该几何**重新排版预览**（纸张跟着预览栏走、不出现横向滚动条，
/// 见 `typst_world::PreviewPage`）；几何由前端算（`src/lib/core/preview-scale.ts`）。
/// 成功携带 pages/pageKeys，已持有同位置指纹的页为 null；无 knownPages 时全量返回。
/// 失败返回 diagnostics，成功且带警告时附加 warnings。
/// 编译在 spawn_blocking 中执行（不阻塞 UI），内部互斥锁串行化。
/// Err 仅用于编译任务本身异常终止（正常编译失败仍走 Ok(ok:false)）。
#[tauri::command]
pub async fn compile_doc(
    state: tauri::State<'_, CompileState>,
    src: String,
    document_path: Option<String>,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
    known_pages: Option<Vec<String>>,
    preview_page: Option<crate::typst_world::PreviewPage>,
) -> Result<crate::typst_world::CompileOutput<Option<String>>, String> {
    let out = in_compile_channel(&state, font_families, font_dirs, move |fonts_dir, fonts| {
        crate::typst_world::compile_incremental_with_preview(
            src,
            document_path,
            fonts_dir,
            fonts,
            known_pages,
            preview_page,
        )
    })
    .await
    .unwrap_or_else(|()| crate::typst_world::CompileOutput::internal_error("编译任务异常终止"));
    Ok(out)
}

/// 整页点击定位，编号必须来自该页的 compile_doc 产物。
#[tauri::command]
pub fn document_hit_test(
    geometry_id: u64,
    page: usize,
    x_pt: f64,
    y_pt: f64,
) -> Option<crate::document_geometry::DocumentCaret> {
    crate::document_geometry::hit_test(geometry_id, page, x_pt, y_pt)
}

/// 源码选区对应的整页高亮；只读取该编译快照，不触发排版。
#[tauri::command]
pub fn document_selection(
    geometry_id: u64,
    from: usize,
    to: usize,
) -> Vec<crate::document_geometry::DocumentSelectionQuad> {
    crate::document_geometry::selection(geometry_id, from, to)
}

/// 源码光标对应的页面位置。没有可映射输出时返回 None。
#[tauri::command]
pub fn document_cursor(
    geometry_id: u64,
    offset: usize,
) -> Option<crate::document_geometry::DocumentCaret> {
    crate::document_geometry::locate(geometry_id, offset)
}

/// 编译并导出 PDF 到 target_path（export_pdf）：
/// 路径安全校验复用 validate_write_path（不限制扩展名、拒绝符号链接、拒绝 `..` 穿越）。
/// Err 仅用于导出任务本身异常终止（编译失败/写入失败仍走 Ok(ok:false, error)）。
#[tauri::command]
pub async fn export_pdf(
    state: tauri::State<'_, CompileState>,
    src: String,
    document_path: Option<String>,
    target_path: String,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
) -> Result<crate::typst_world::PdfResult, String> {
    let final_path = match validate_write_path(&target_path) {
        Ok(p) => p,
        Err(e) => {
            return Ok(crate::typst_world::PdfResult {
                ok: false,
                error: Some(e),
            })
        }
    };
    let out = in_compile_channel(&state, font_families, font_dirs, move |fonts_dir, fonts| {
        match crate::typst_world::compile_to_pdf_bytes(src, document_path, fonts_dir, fonts) {
            Ok(bytes) => match fs::write(&final_path, bytes) {
                Ok(()) => crate::typst_world::PdfResult {
                    ok: true,
                    error: None,
                },
                Err(e) => crate::typst_world::PdfResult {
                    ok: false,
                    error: Some(format!("写入文件失败: {e}")),
                },
            },
            Err(e) => crate::typst_world::PdfResult {
                ok: false,
                error: Some(e),
            },
        }
    })
    .await
    .unwrap_or_else(|()| crate::typst_world::PdfResult {
        ok: false,
        error: Some("导出任务异常终止".into()),
    });
    Ok(out)
}
