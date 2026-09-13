// Tauri 后端：窗口 + 文件读写命令 + 文件打开（关联双击/启动参数/拖放）+ 内嵌 typst 编译。
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

mod packages;
mod typst_world;

/// 待打开的 .typ 文件队列：首次启动参数 + 跨实例转发 + macOS 打开事件，
/// 前端就绪后一次性取走（避免事件早于前端监听而丢失）
struct PendingFiles(Mutex<Vec<String>>);

/// 读取文本文件（供前端"打开"使用）：绝对路径 + .typ 扩展名 + 拒绝穿越/符号链接
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    validate_typ_path(&path)?;
    let canon = fs::canonicalize(&path).map_err(|e| format!("路径无效: {e}"))?;
    // 解析符号链接后复检（防 foo.typ -> 任意文件 绕过扩展名检查）
    let canon_str = canon.to_str().ok_or("路径无效")?;
    validate_typ_path(canon_str)?;
    fs::read_to_string(canon).map_err(|e| e.to_string())
}

/// 写入文本文件（供前端"保存"使用）：支持新建，父目录必须存在，拒绝写入符号链接
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    validate_typ_path(&path)?;
    let p = Path::new(&path);
    let parent = p.parent().ok_or("路径无效")?;
    let name = p.file_name().ok_or("路径无效")?;
    let canon_parent = fs::canonicalize(parent).map_err(|e| format!("目录无效: {e}"))?;
    let final_path = canon_parent.join(name);
    // 拒绝写入符号链接（防写穿到任意目标）
    if let Ok(meta) = fs::symlink_metadata(&final_path) {
        if meta.file_type().is_symlink() {
            return Err("不允许写入符号链接".into());
        }
    }
    fs::write(final_path, content).map_err(|e| e.to_string())
}

/// 校验可写路径：绝对路径、拒绝 `..`、父目录必须存在且被 canonicalize、拒绝写入符号链接。
/// 与 write_file 的路径安全模型一致，但不限制扩展名（保存对话框已由用户选定目标）。
fn validate_write_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("仅支持绝对路径".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("不允许路径穿越".into());
    }
    let parent = p.parent().ok_or("路径无效")?;
    let name = p.file_name().ok_or("路径无效")?;
    let canon_parent = fs::canonicalize(parent).map_err(|e| format!("目录无效: {e}"))?;
    let final_path = canon_parent.join(name);
    // 拒绝写入符号链接（防写穿到任意目标）
    if let Ok(meta) = fs::symlink_metadata(&final_path) {
        if meta.file_type().is_symlink() {
            return Err("不允许写入符号链接".into());
        }
    }
    Ok(final_path)
}

/// 写入二进制文件（导出 PDF 用）：bytes 由前端以 JSON 数字数组传来
#[tauri::command]
fn write_binary(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let final_path = validate_write_path(&path)?;
    fs::write(final_path, bytes).map_err(|e| e.to_string())
}

/// 内嵌编译状态：编译互斥锁（typst 引擎进程内串行编译，避免并发 CPU 竞争与共享状态错乱）
/// + 字体目录（setup 时解析一次）。Arc/PathBuf 可克隆，便于 move 进 spawn_blocking。
struct CompileState {
    lock: std::sync::Arc<Mutex<()>>,
    fonts_dir: PathBuf,
}

/// 编译文档为每页 SVG（compile_doc）：src 为主文档源码，document_path 为磁盘路径
/// （None = 未保存，相对导入会报"需要先保存文档"）。
/// 返回 CompileOutput：成功 { ok, pages }，失败 { ok, diagnostics }，成功且带警告时附加 warnings。
/// 编译在 spawn_blocking 中执行（不阻塞 UI），内部互斥锁串行化。
/// Err 仅用于编译任务本身异常终止（正常编译失败仍走 Ok(ok:false)）。
#[tauri::command]
async fn compile_doc(
    state: tauri::State<'_, CompileState>,
    src: String,
    document_path: Option<String>,
) -> Result<typst_world::CompileOutput, String> {
    let lock = std::sync::Arc::clone(&state.lock);
    let fonts_dir = state.fonts_dir.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        typst_world::compile(src, document_path, &fonts_dir)
    })
    .await
    .unwrap_or_else(|_| typst_world::CompileOutput::internal_error("编译任务异常终止")))
}

/// 渲染单个公式为紧致 SVG（compile_math）：编辑器内联渲染（所见即所得）用。
/// body = 公式源码（不含定界 `$`），display = 是否行间（display 风格），
/// context = 编译前缀（设置里的前缀代码，与整篇编译同源，宏与字体设置生效），
/// size_pt = 公式字号（pt，缺省 10.5 = 14px）；**必须与编辑器正文字号一致**，
/// 写作模式正文 16px 时前端传 12。
/// 与 compile_doc 同走命令层互斥锁 + spawn_blocking（一次一个编译，不阻塞 UI）。
/// Err 仅用于任务本身异常终止（公式语法错误等正常失败走 Ok(ok:false, error)）。
#[tauri::command]
async fn compile_math(
    state: tauri::State<'_, CompileState>,
    body: String,
    display: bool,
    context: String,
    document_path: Option<String>,
    size_pt: Option<f64>,
) -> Result<typst_world::MathOutput, String> {
    let lock = std::sync::Arc::clone(&state.lock);
    let fonts_dir = state.fonts_dir.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        typst_world::compile_math(
            &body,
            display,
            &context,
            document_path,
            &fonts_dir,
            size_pt.unwrap_or(typst_world::MATH_TEXT_PT),
        )
    })
    .await
    .unwrap_or_else(|_| typst_world::MathOutput::internal_error("公式渲染任务异常终止")))
}

/// 编译并导出 PDF 到 target_path（export_pdf）：
/// 路径安全校验复用 validate_write_path（不限制扩展名、拒绝符号链接、拒绝 `..` 穿越）。
/// Err 仅用于导出任务本身异常终止（编译失败/写入失败仍走 Ok(ok:false, error)）。
#[tauri::command]
async fn export_pdf(
    state: tauri::State<'_, CompileState>,
    src: String,
    document_path: Option<String>,
    target_path: String,
) -> Result<typst_world::PdfResult, String> {
    let final_path = match validate_write_path(&target_path) {
        Ok(p) => p,
        Err(e) => {
            return Ok(typst_world::PdfResult {
                ok: false,
                error: Some(e),
            })
        }
    };
    let lock = std::sync::Arc::clone(&state.lock);
    let fonts_dir = state.fonts_dir.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        match typst_world::compile_to_pdf_bytes(src, document_path, &fonts_dir) {
            Ok(bytes) => match fs::write(&final_path, bytes) {
                Ok(()) => typst_world::PdfResult {
                    ok: true,
                    error: None,
                },
                Err(e) => typst_world::PdfResult {
                    ok: false,
                    error: Some(format!("写入文件失败: {e}")),
                },
            },
            Err(e) => typst_world::PdfResult {
                ok: false,
                error: Some(e),
            },
        }
    })
    .await
    .unwrap_or_else(|_| typst_world::PdfResult {
        ok: false,
        error: Some("导出任务异常终止".into()),
    }))
}

/// 取走待打开的 .typ 文件队列（仅一次，供前端就绪后逐个加载）
#[tauri::command]
fn take_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// 命令行 --debug 开关（调试日志来源之一，仅桌面构建生效）：setup 解析命令行后存入，
/// 前端经 get_debug_flag 命令异步查询
struct CliDebugFlag(bool);

/// 查询命令行 --debug 开关（支持 `--debug` 与 `--debug=1` 两种写法，其余值宽松视为未开启）
#[tauri::command]
fn get_debug_flag(state: tauri::State<'_, CliDebugFlag>) -> bool {
    state.0
}

/// 把 .typ 路径加入待打开队列，并实时广播给已就绪的前端
fn queue_open(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingFiles>() {
        if let Ok(mut q) = state.0.lock() {
            q.push(path.clone());
        }
    }
    let _ = app.emit("open-file", path);
}

/// 相对路径（如快捷方式的工作目录启动）拼成绝对路径
fn absolutize(path: &str, cwd: &str) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        PathBuf::from(cwd).join(p).to_string_lossy().to_string()
    }
}

/// 校验 .typ 路径：必须绝对路径、扩展名 .typ（大小写不敏感）、拒绝 `..` 穿越
fn validate_typ_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("仅支持绝对路径".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("不允许路径穿越".into());
    }
    if !is_typ_file(p) {
        return Err("仅支持 .typ 文件".into());
    }
    Ok(())
}

fn is_typ_file(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("typ"))
}

/// 列出目录下所有 .typ 文件（递归，供导入/浏览使用）：
/// 返回 canonicalize 后的绝对路径；跳过隐藏条目；符号链接目录不递归（防环），
/// broken symlink 跳过；深度 ≤ 8、最多收集 500 个（超出静默停止）。
#[tauri::command]
fn list_dir_typ(dir: String) -> Result<Vec<String>, String> {
    let p = Path::new(&dir);
    if !p.is_absolute() {
        return Err("仅支持绝对路径".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("不允许路径穿越".into());
    }
    let canon = fs::canonicalize(p).map_err(|e| format!("目录无效: {e}"))?;
    if !canon.is_dir() {
        return Err("仅支持目录".into());
    }
    let mut out = Vec::new();
    walk_typ_dir(&canon, 0, &mut out);
    Ok(out)
}

/// 递归收集 .typ 文件；深度 > 8 或收集 ≥ 500 时停止（静默）
fn walk_typ_dir(dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 8 || out.len() >= 500 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 500 {
            break;
        }
        let path = entry.path();
        // 跳过隐藏条目（名字以 `.` 开头）
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // metadata 跟随符号链接：broken symlink 会 Err 而跳过
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.is_file() {
            if is_typ_file(&path) {
                if let Some(s) = fs::canonicalize(&path)
                    .ok()
                    .and_then(|c| c.to_str().map(String::from))
                {
                    out.push(s);
                }
            }
        } else if meta.is_dir() {
            // 符号链接目录一律不递归（防环）
            match fs::symlink_metadata(&path) {
                Ok(sm) if sm.file_type().is_symlink() => continue,
                _ => {}
            }
            walk_typ_dir(&path, depth + 1, out);
        }
    }
}

/// 禁用 WebView2 浏览器加速键（如 Ctrl+R 整页刷新）：
/// WebView2 中加速键在 web 内容之前处理，页面 JS 的 preventDefault 无法拦截，
/// 必须在此禁用，让 Ctrl+R 等快捷键完全交由前端处理
struct DisableBrowserAccelerators;

impl tauri::plugin::Plugin<tauri::Wry> for DisableBrowserAccelerators {
    fn name(&self) -> &'static str {
        "disable-browser-accelerators"
    }

    fn webview_created(&mut self, webview: tauri::Webview<tauri::Wry>) {
        // 打点：webview 初始化完成（此处仅原生 webview 就绪，页面 HTML/JS 尚未加载）
        #[cfg(debug_assertions)]
        startup_timing::set_webview_created();
        #[cfg(target_os = "windows")]
        {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows_core::Interface;
            // 闭包要求 Send + 'static：只借用入参、不捕获外部可变状态
            let _ = webview.with_webview(|pw| {
                let core = unsafe { pw.controller().CoreWebView2() }.ok();
                if let Some(core) = core {
                    let settings = unsafe { core.Settings() }.ok();
                    if let Some(s3) = settings.and_then(|s| s.cast::<ICoreWebView2Settings3>().ok())
                    {
                        let _ = unsafe { s3.SetAreBrowserAcceleratorKeysEnabled(false) };
                    }
                }
            });
        }
        #[cfg(not(target_os = "windows"))]
        let _ = webview;
    }
}

/// 启动时序打点（仅 debug 构建编译，release 零输出零开销）：记录 Rust 壳
/// 「窗口创建 → webview 就绪 → 前端加载完成」各阶段相对 setup 入口的耗时。
/// 与前端 [startup] 打点（startup-timing.ts，无条件输出）配合，补全 #43 未实测的 Rust 段；
/// 输出 [startup] rust phase:<name> t:<ms>，与前端同前缀便于统一抓取过滤。
#[cfg(debug_assertions)]
mod startup_timing {
    use std::sync::OnceLock;
    use std::time::Instant;

    /// setup() 钩子入口时刻：Rust 壳初始化起点（窗口创建前的准备阶段）
    static SETUP_ENTRY: OnceLock<Instant> = OnceLock::new();
    /// DisableBrowserAccelerators.webview_created 时刻：webview 初始化完成（页面尚未加载）
    static WEBVIEW_CREATED: OnceLock<Instant> = OnceLock::new();
    /// RunEvent::Ready 时刻：前端页面加载完成（事件循环首次迭代）
    static READY: OnceLock<Instant> = OnceLock::new();

    pub fn set_setup_entry() {
        let _ = SETUP_ENTRY.set(Instant::now());
    }

    pub fn set_webview_created() {
        let _ = WEBVIEW_CREATED.set(Instant::now());
    }

    /// 记录 Ready 并输出各阶段相对 setup 入口的耗时
    /// （多窗口场景下以首次到达为准：OnceLock 只接受第一个值）
    pub fn set_ready_and_report() {
        let _ = READY.set(Instant::now());
        let Some(t0) = SETUP_ENTRY.get() else { return };
        let ms = |name: &str, t: Option<&Instant>| {
            if let Some(t) = t {
                eprintln!(
                    "[startup] rust phase:{name} t:{:.1}",
                    t.duration_since(*t0).as_secs_f64() * 1000.0
                );
            }
        };
        ms("webview-created", WEBVIEW_CREATED.get());
        ms("ready", READY.get());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // 窗口大小/位置/最大化状态记忆（tauri-plugin-window-state）：关闭时保存、启动时恢复
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 禁用浏览器加速键（Ctrl+R 不再触发整页刷新），放在 opener 之后注册
        .plugin(DisableBrowserAccelerators)
        .plugin(tauri_plugin_dialog::init())
        // 自动更新（tauri-plugin-updater）：检查更新 / 下载 / 安装新版本。
        // 端点与签名公钥在 tauri.conf.json 的 plugins.updater（前端权限见 capabilities/default.json
        // 的 updater:default）；更新包的签名校验在 Rust 侧完成，前端拿不到也改不了公钥。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 注意：不使用 single-instance——每次启动都打开独立实例/新窗口
        .setup(|app| {
            // 打点：setup 入口（窗口创建阶段起点）
            #[cfg(debug_assertions)]
            startup_timing::set_setup_entry();
            // --debug 命令行开关（调试日志来源之一，仅桌面构建生效）：支持 --debug 与
            // --debug=1 两种写法，其余值宽松视为未开启；前端经 get_debug_flag 命令查询
            let cli_debug = std::env::args().any(|a| a == "--debug" || a == "--debug=1");
            app.manage(CliDebugFlag(cli_debug));
            // 首次启动：从命令行参数解析待打开的 .typ 文件
            let initial = std::env::args()
                .skip(1)
                .find(|a| is_typ_file(Path::new(a)))
                .map(|a| {
                    let cwd = std::env::current_dir()
                        .map(|d| d.to_string_lossy().to_string())
                        .unwrap_or_default();
                    absolutize(&a, &cwd)
                });
            app.manage(PendingFiles(Mutex::new(initial.into_iter().collect())));
            // 内嵌编译状态：字体目录（打包后为 resource_dir/fonts，开发回退 src-tauri/fonts）
            app.manage(CompileState {
                lock: std::sync::Arc::new(Mutex::new(())),
                fonts_dir: typst_world::resolve_fonts_dir(app.handle()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            take_pending_files,
            write_binary,
            list_dir_typ,
            get_debug_flag,
            compile_doc,
            compile_math,
            export_pdf
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // 打点：前端页面加载完成（RunEvent::Ready = 事件循环首次迭代）；
        // 以引用匹配避免消耗 event（后续 macOS 分支仍需要它）
        #[cfg(debug_assertions)]
        if let tauri::RunEvent::Ready = &event {
            startup_timing::set_ready_and_report();
        }
        // macOS：Finder"打开方式"通过 Apple Events 传路径（命令行参数拿不到）
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            if let Some(path) = urls
                .first()
                .and_then(|u| u.to_file_path().ok())
                .filter(|p| is_typ_file(p))
                .map(|p| p.to_string_lossy().to_string())
            {
                queue_open(app, path);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
