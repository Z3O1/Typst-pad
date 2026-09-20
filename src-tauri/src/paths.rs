// 路径安全与 `.typ` 判定：文件读写、目录列举、PDF 导出共用的**唯一**校验入口。
//
// 写盘只有一条路（前端 `handleSave` → `saveTypFile` → `write_file`），所以这里是最后的闸门：
// 绝对路径、拒绝 `..` 穿越、父目录必须存在且 canonicalize、拒绝写符号链接、扩展名大小写不敏感。
// **别在别处再抄一份**（CLAUDE.md「文件/安全」：`validate_typ_path` / `validate_write_path` 不许绕过）。
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 校验可写路径：绝对路径、拒绝 `..`、父目录必须存在且被 canonicalize、拒绝写入符号链接。
/// 与 write_file 的路径安全模型一致，但不限制扩展名（保存对话框已由用户选定目标）。
pub fn validate_write_path(path: &str) -> Result<PathBuf, String> {
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

/// 相对路径（如快捷方式的工作目录启动）拼成绝对路径
pub fn absolutize(path: &str, cwd: &str) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        PathBuf::from(cwd).join(p).to_string_lossy().to_string()
    }
}

/// 校验 .typ 路径：必须绝对路径、扩展名 .typ（大小写不敏感）、拒绝 `..` 穿越
pub fn validate_typ_path(path: &str) -> Result<(), String> {
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

pub fn is_typ_file(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("typ"))
}
