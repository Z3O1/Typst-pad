// 文件读写命令 + 「待打开文件」队列（首次启动参数 / macOS 打开事件 → 前端就绪后一次性取走）。
use std::fs;
use std::path::Path;
use std::sync::Mutex;

// 这两个 trait 只被 macOS 分支的 queue_open 用到（`try_state` / `emit`），加 cfg 免掉其它平台的
// 未使用导入
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

use crate::paths::{absolutize, is_typ_file, validate_typ_path, validate_write_path};

/// 待打开的 .typ 文件队列：首次启动参数 + 跨实例转发 + macOS 打开事件，
/// 前端就绪后一次性取走（避免事件早于前端监听而丢失）
pub struct PendingFiles(Mutex<Vec<String>>);

/// 首次启动：从命令行参数解析待打开的 .typ 文件（相对路径按当前工作目录补全，
/// 快捷方式启动时 cwd 往往不是文档所在目录）。找不到就是空队列。
pub fn initial_pending_files() -> PendingFiles {
    let cwd = std::env::current_dir()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let first = std::env::args()
        .skip(1)
        .find(|a| is_typ_file(Path::new(a)))
        .map(|a| absolutize(&a, &cwd));
    PendingFiles(Mutex::new(first.into_iter().collect()))
}

/// 读取文本文件（供前端"打开"使用）：绝对路径 + .typ 扩展名 + 拒绝穿越/符号链接
#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    validate_typ_path(&path)?;
    let canon = fs::canonicalize(&path).map_err(|e| format!("路径无效: {e}"))?;
    // 解析符号链接后复检（防 foo.typ -> 任意文件 绕过扩展名检查）
    let canon_str = canon.to_str().ok_or("路径无效")?;
    validate_typ_path(canon_str)?;
    fs::read_to_string(canon).map_err(|e| e.to_string())
}

/// 写入文本文件（供前端"保存"使用）：支持新建，父目录必须存在，拒绝写入符号链接
#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
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

/// 写入二进制文件（导出 PDF 用）：bytes 由前端以 JSON 数字数组传来
#[tauri::command]
pub fn write_binary(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let final_path = validate_write_path(&path)?;
    fs::write(final_path, bytes).map_err(|e| e.to_string())
}

/// 取走待打开的 .typ 文件队列（仅一次，供前端就绪后逐个加载）
#[tauri::command]
pub fn take_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut q| std::mem::take(&mut *q))
        .unwrap_or_default()
}

/// 把 .typ 路径加入待打开队列，并实时广播给已就绪的前端
///
/// 目前只有 macOS 的 `RunEvent::Opened` 会调它（Finder「打开方式」走 Apple Events，
/// 命令行参数拿不到）；其它平台加 `#[cfg]` 是为了不留一个永远不调用的函数。
#[cfg(target_os = "macos")]
pub fn queue_open(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingFiles>() {
        if let Ok(mut q) = state.0.lock() {
            q.push(path.clone());
        }
    }
    let _ = app.emit("open-file", path);
}
