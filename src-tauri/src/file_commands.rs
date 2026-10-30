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

/// 写入二进制文件（**只新建，不覆盖既有文件**）：bytes 由前端以 JSON 数字数组传来。
///
/// 贴入图片的文件名是自动生成的（`image-<时间戳>-<序号>`），若目标已存在还静默覆盖，就会把
/// 用户原有的同名资源改掉、也让文档里已有的 `#image` 指向新内容。所以这里用 `create_new`，
/// 冲突时返回可识别的错误，由前端换名重试。
#[tauri::command]
pub fn write_binary(path: String, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::Write;
    let final_path = validate_write_path(&path)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&final_path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("{WRITE_BINARY_EXISTS}: {}", final_path.display())
            }
            _ => e.to_string(),
        })?;
    file.write_all(&bytes).map_err(|e| e.to_string())
}

/// `write_binary` 目标已存在时的错误前缀（前端据它换名重试，见 `core/file-ops.ts`）。
/// 改字面前先搜前端引用。
pub const WRITE_BINARY_EXISTS: &str = "目标文件已存在";

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 临时目录下的唯一路径（测试并行跑也不撞名）
    fn temp_target(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "typst-pad-write-binary-{}-{tag}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("建临时目录");
        dir.join("image.png")
    }

    #[test]
    fn write_binary_creates_file_with_exact_bytes() {
        let target = temp_target("create");
        let _ = fs::remove_file(&target);
        write_binary(target.to_string_lossy().into(), vec![1, 2, 3]).expect("写入新文件");
        assert_eq!(fs::read(&target).expect("读回"), vec![1, 2, 3]);
        let _ = fs::remove_file(&target);
    }

    #[test]
    fn write_binary_refuses_to_overwrite_existing_file() {
        let target = temp_target("exists");
        fs::write(&target, b"old").expect("预置旧内容");
        let err = write_binary(target.to_string_lossy().into(), vec![9]).expect_err("不覆盖");
        assert!(
            err.starts_with(WRITE_BINARY_EXISTS),
            "错误信息应可被前端识别：{err}"
        );
        assert_eq!(fs::read(&target).expect("旧内容仍在"), b"old");
        let _ = fs::remove_file(&target);
    }
}
