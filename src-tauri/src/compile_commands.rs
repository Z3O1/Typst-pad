// 编译 / 导出 / 点击定位命令：**同一条编译通道**（一把进程内互斥锁 + `spawn_blocking`）上的
// 五个命令。`CompileState` 与 `in_compile_channel` 在这里，`paths` 只提供写盘校验。
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

/// 编译通道：克隆锁与字体目录 → 构造 `FontConfig` → 在 `spawn_blocking` 里**持锁**跑 `job`。
///
/// 五个命令（`compile_doc` / `compile_blocks` / `compile_math` / `export_pdf` /
/// `list_font_families`）原来各抄一遍这五步。顺序有讲究，**别调换**：
/// `FontConfig::new` 在**拿锁之前**执行（它只做字符串/路径整理，不该占着编译通道）。
///
/// 返回 `Err(())` = 任务本身异常终止（panic / runtime 关闭）。**收口方式各命令不同**
/// （`compile_blocks` 变成 invoke 的 Err，其余折成"内部错误"结构），所以这里不替调用方
/// 决定文案与形状。
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
        job(&fonts_dir, &fonts)
    })
    .await
    .map_err(|_| ())
}

/// 编译文档为每页 SVG（compile_doc）：src 为主文档源码，document_path 为磁盘路径
/// （None = 未保存，相对导入会报"需要先保存文档"）。
/// preview_width_pt = 预览页宽（pt，可选）：给了就按它**重新排版**预览（见
/// typst_world::preview_page_setup）——预览栏多宽、纸张就多宽，正文重排、字号不变，
/// 于是预览永不出现横向滚动条；导出 PDF 走 export_pdf，**不受它影响**。
/// 返回 CompileOutput：成功 { ok, pages }，失败 { ok, diagnostics }，成功且带警告时附加 warnings。
/// 编译在 spawn_blocking 中执行（不阻塞 UI），内部互斥锁串行化。
/// Err 仅用于编译任务本身异常终止（正常编译失败仍走 Ok(ok:false)）。
#[tauri::command]
pub async fn compile_doc(
    state: tauri::State<'_, CompileState>,
    src: String,
    document_path: Option<String>,
    preview_width_pt: Option<f64>,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
) -> Result<crate::typst_world::CompileOutput, String> {
    let out = in_compile_channel(&state, font_families, font_dirs, move |fonts_dir, fonts| {
        crate::typst_world::compile_with_page_width(
            src,
            document_path,
            fonts_dir,
            fonts,
            preview_width_pt,
        )
    })
    .await
    .unwrap_or_else(|()| crate::typst_world::CompileOutput::internal_error("编译任务异常终止"));
    Ok(out)
}

/// 写作模式的块级编译（compile_blocks）：整篇编译一次，把每个源块在版面上的那一块切出来，
/// 供编辑器把"非光标所在块"显示成**真实 typst 排版**（见 docs/文档模式渲染保真-调研.md）。
///
/// 与 compile_doc 的关系：同一条编译链路（同一把命令层互斥锁 + spawn_blocking），只是产物
/// 从"每页 SVG"换成"每块 SVG + 几何"；诊断/警告结构与 compile_doc 完全一致，前端可以共用
/// 状态栏、错误计数与波浪线逻辑。
///
/// * `docOffset` = 用户文档在 `src` 里的起始字节偏移（= 前缀代码的 UTF-8 字节长度）
/// * `contentWidthPt` = 写作模式正文列宽（pt）：版心宽随编辑器列宽走
/// * `wantFrom` / `wantTo` = 只给这个字节窗口内的块渲切片（**文档坐标的字节偏移**，与返回的
///   块区间同一坐标系；null = 全渲）。
///   逐块 SVG 会各自复制字形轮廓（实测约 58 字节/源字符），所以编辑器按视口请求窗口
/// * Err 仅用于任务异常终止（正常编译失败仍走 Ok(ok:false)）
// 参数表就是前端 `invoke("compile_blocks", {…})` 的契约（前端按名字传参）：收成一个结构体
// 等于改线上协议，所以这里**刻意保留多参数**并显式豁免参数个数检查。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn compile_blocks(
    state: tauri::State<'_, CompileState>,
    src: String,
    doc_offset: usize,
    document_path: Option<String>,
    content_width_pt: f64,
    want_from: Option<usize>,
    want_to: Option<usize>,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
) -> Result<crate::block_geometry::BlocksOutput, String> {
    in_compile_channel(&state, font_families, font_dirs, move |fonts_dir, fonts| {
        crate::block_geometry::compile_blocks(
            src,
            doc_offset,
            document_path,
            fonts_dir,
            fonts,
            content_width_pt,
            want_from,
            want_to,
        )
    })
    .await
    .map_err(|()| "块级编译任务异常终止".to_string())
}

/// 点击定位（阶段 2）：把写作模式切片上的一个点映射回**源码字节偏移**。
///
/// 输入是页面坐标（pt）：切片自己的坐标系原点是裁剪带左上角，前端用 `BlockCrop` 的
/// `x_pt` / `y_pt` / `width_pt` / `height_pt` 把 CSS 像素换算过来（见 block-hit.ts）。
/// `start` / `end` 是**用户文档字节区间**（那个块），返回值也钳在这个区间里。
///
/// 几何来自上一次成功编译的缓存（见 block_geometry 的 HIT_CACHE）：点击不需要重新编译，
/// 一次命中测试是微秒级，所以这里**不加编译互斥锁**（不占编译通道）。
/// 没有缓存 / 参数非法 → None，前端退回"光标落到块首"的老行为。
///
/// * `geometryId` = 该窗口上一次 `compile_blocks` 返回的几何编号（`BlocksOutput.geometryId`）。
///   缓存是**进程级**的，另一个窗口编译一次就会把它换掉；对不上编号就返回 None，
///   免得拿别人的排版去找最近字形（多窗口下会点错字，见 HIT_CACHE 的说明）。缺省 None =
///   不校验（旧前端 / 内部探针）。
#[tauri::command]
pub fn block_hit_test(
    start: usize,
    end: usize,
    page: usize,
    x_pt: f64,
    y_pt: f64,
    geometry_id: Option<u64>,
) -> Option<usize> {
    crate::block_geometry::hit_test(start, end, page, x_pt, y_pt, geometry_id)
}

/// 渲染单个公式为紧致 SVG（compile_math）：编辑器内联渲染（所见即所得）用。
/// body = 公式源码（不含定界 `$`），display = 是否行间（display 风格），
/// context = 编译前缀（设置里的前缀代码，与整篇编译同源，宏与字体设置生效），
/// size_pt = 公式字号（pt，缺省 10.5 = 14px）；**必须与编辑器正文字号一致**，
/// 写作模式正文 16px 时前端传 12。
/// 与 compile_doc 同走命令层互斥锁 + spawn_blocking（一次一个编译，不阻塞 UI）。
/// Err 仅用于任务本身异常终止（公式语法错误等正常失败走 Ok(ok:false, error)）。
// 同 compile_blocks：多参数就是 IPC 契约，豁免而不是包成结构体。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn compile_math(
    state: tauri::State<'_, CompileState>,
    body: String,
    display: bool,
    context: String,
    document_path: Option<String>,
    size_pt: Option<f64>,
    font_families: Option<Vec<String>>,
    font_dirs: Option<Vec<String>>,
) -> Result<crate::typst_world::MathOutput, String> {
    let out = in_compile_channel(&state, font_families, font_dirs, move |fonts_dir, fonts| {
        crate::typst_world::compile_math(
            &body,
            display,
            &context,
            document_path,
            fonts_dir,
            fonts,
            size_pt.unwrap_or(crate::typst_world::MATH_TEXT_PT),
        )
    })
    .await
    .unwrap_or_else(|()| crate::typst_world::MathOutput::internal_error("公式渲染任务异常终止"));
    Ok(out)
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
