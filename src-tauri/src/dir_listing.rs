// 目录列举（`list_dir_typ`）：递归找 `.typ`，供前端「导入/浏览」用。
use std::fs;
use std::path::{Component, Path};

use crate::paths::is_typ_file;

/// 列出目录下所有 .typ 文件（递归，供导入/浏览使用）：
/// 返回 canonicalize 后的绝对路径；跳过隐藏条目；符号链接目录不递归（防环），
/// broken symlink 跳过；深度 ≤ 8、最多收集 500 个（超出静默停止）。
#[tauri::command]
pub fn list_dir_typ(dir: String) -> Result<Vec<String>, String> {
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
