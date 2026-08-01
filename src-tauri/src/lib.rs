// Tauri 后端：窗口 + 文件读写命令 + 文件打开（关联双击/启动参数/拖放）。
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Manager};

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

/// 取走待打开的 .typ 文件队列（仅一次，供前端就绪后逐个加载）
#[tauri::command]
fn take_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state.0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 单实例：应用已运行时再次打开（如双击 .typ 关联文件），把路径转发给首个实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(arg) = argv.into_iter().find(|a| is_typ_file(Path::new(a))) {
                queue_open(app, absolutize(&arg, &cwd));
            }
        }))
        .setup(|app| {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            take_pending_files
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
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
