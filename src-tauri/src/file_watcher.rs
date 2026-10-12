// 当前主文件的原生监控：只 watch 当前窗口正在编辑的 .typ 文件，
// 外部修改时向前端发送 `file-changed` 事件，由前端决定自动重读或提示用户。
//
// 设计要点：
// - 一个窗口同时只 watch 一个文件；切文件/新建/关闭时解绑旧 watch。
// - 监听文件所在的**父目录**（而不是文件本身），这样原子替换（rename 覆盖）不会漏事件。
// - 事件经 notify-debouncer-mini 去抖，150ms 内同一文件的多次事件合并为一次通知。
// - 前端读取磁盘内容后自行比对，因此自己的 save 只要内容一致就不会误报。
// - 不自动写盘；所有写操作仍走 `file_commands::write_file`。

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::paths::validate_typ_path;

use notify::RecursiveMode;
use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer};

/// 每个窗口的当前 watch：保留 debouncer 生命周期；drop 时自动停止后台线程。
/// 字段仅用于维持生命周期，显式允许 dead_code 以免误报。
#[allow(dead_code)]
struct ActiveWatch(Debouncer<RecommendedWatcher>);

/// 全局 watch 状态：窗口 label -> 活动 watch
pub struct FileWatcherState(Mutex<HashMap<String, ActiveWatch>>);

impl FileWatcherState {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

/// 前端事件 payload
#[derive(Clone, serde::Serialize)]
struct FileChangedPayload {
    path: String,
}

/// 启动对 `path` 的监控；`window_label` 用于把事件精确发到对应窗口。
/// 同一个窗口再次调用会先停止旧 watch。
#[tauri::command]
pub fn start_file_watch(
    path: String,
    window_label: String,
    app: AppHandle,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    validate_typ_path(&path)?;

    let file_path = PathBuf::from(&path);
    let parent = file_path.parent().ok_or("路径无效：没有父目录")?;
    let file_name = file_path
        .file_name()
        .ok_or("路径无效：没有文件名")?
        .to_os_string();

    // 父目录必须存在且可被 canonicalize（拒绝符号链接目录）
    let parent = std::fs::canonicalize(parent).map_err(|e| format!("目录无效: {e}"))?;

    // 先停止同窗口旧 watch
    stop_watch_for(&state, &window_label);

    let emit_path = path.clone();
    let label = window_label.clone();
    let name = file_name.clone();

    let debouncer = new_debouncer(
        Duration::from_millis(150),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events.iter().any(|e| event_matches_file(e, &name)) {
                    let _ = app.emit_to(
                        &label,
                        "file-changed",
                        FileChangedPayload {
                            path: emit_path.clone(),
                        },
                    );
                }
            }
        },
    )
    .map_err(|e| format!("启动文件监控失败: {e}"))?;

    // 错误处理：debouncer 不能Clone，这里需要可变引用；用 match 明确错误
    let mut debouncer = debouncer;
    debouncer
        .watcher()
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监控目录失败: {e}"))?;

    state
        .0
        .lock()
        .map_err(|e| format!("状态锁错误: {e}"))?
        .insert(window_label, ActiveWatch(debouncer));

    Ok(())
}

/// 停止指定窗口的监控。
#[tauri::command]
pub fn stop_file_watch(
    window_label: String,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    stop_watch_for(&state, &window_label);
    Ok(())
}

fn stop_watch_for(state: &FileWatcherState, window_label: &str) {
    if let Ok(mut map) = state.0.lock() {
        map.remove(window_label);
        // ActiveWatch 被移除即 drop debouncer，后台线程停止
    }
}

/// 判断一个去抖后事件是否与我们关心的文件同名（路径在父目录下）。
fn event_matches_file(event: &DebouncedEvent, file_name: &OsString) -> bool {
    event
        .path
        .file_name()
        .map(|n| n == file_name)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use tempfile::tempdir;

    /// 用真实临时文件证明：写入文件后 debouncer 能收到该文件的事件。
    /// 这不是 mock，实际走了 notify 的 inotify/FSEvent/ReadDirectoryChanges。
    #[test]
    fn real_file_change_is_detected() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("doc.typ");
        std::fs::write(&file_path, "hello").expect("write");

        let (tx, rx) = mpsc::channel();
        let mut debouncer = new_debouncer(
            Duration::from_millis(80),
            move |res: DebounceEventResult| {
                let _ = tx.send(res);
            },
        )
        .expect("debouncer");

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .expect("watch");

        // 等待 watcher 就绪
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file_path, "world").expect("write again");

        let res = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("should receive event");
        let events = res.expect("no error");
        assert!(
            events
                .iter()
                .any(|e| event_matches_file(e, &OsString::from("doc.typ"))),
            "expected event for doc.typ, got {:?}",
            events
        );
    }

    /// 父目录下其他文件的变更不应被当作目标文件。
    #[test]
    fn other_file_is_filtered_out() {
        let dir = tempdir().expect("tempdir");
        let target = dir.path().join("target.typ");
        let other = dir.path().join("other.txt");
        std::fs::write(&target, "a").unwrap();
        std::fs::write(&other, "b").unwrap();

        let (tx, rx) = mpsc::channel();
        let mut debouncer = new_debouncer(
            Duration::from_millis(80),
            move |res: DebounceEventResult| {
                let _ = tx.send(res);
            },
        )
        .expect("debouncer");

        debouncer
            .watcher()
            .watch(dir.path(), RecursiveMode::NonRecursive)
            .expect("watch");

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&other, "bb").unwrap();

        let res = rx.recv_timeout(Duration::from_secs(5)).expect("event");
        let events = res.expect("no error");
        assert!(
            !events
                .iter()
                .any(|e| event_matches_file(e, &OsString::from("target.typ"))),
            "target.typ should not match other.txt events"
        );
    }
}
