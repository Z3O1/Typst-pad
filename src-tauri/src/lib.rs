// Tauri 后端：窗口 + 文件读写命令。
use std::fs;
use std::path::{Component, Path};

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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
