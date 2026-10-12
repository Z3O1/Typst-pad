// 每个调用窗口只监控当前主文件；监控父目录以覆盖原子 rename 替换。
// 本模块只发事件，不写盘。正文比较与是否重读由前端负责。
use std::collections::HashMap;
#[cfg(test)]
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{Emitter, Window};

use crate::paths::{validate_typ_path, validate_write_path};

struct ActiveWatch {
    enabled: Arc<AtomicBool>,
    // 持有到 drop；后台回调不访问状态锁。
    _debouncer: Debouncer<RecommendedWatcher>,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.enabled.store(false, Ordering::SeqCst);
    }
}

struct WatchSlot {
    token: u64,
    watch: Option<ActiveWatch>,
}

pub struct FileWatcherState {
    watches: Mutex<HashMap<String, WatchSlot>>,
    next_token: AtomicU64,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            watches: Mutex::new(HashMap::new()),
            next_token: AtomicU64::new(1),
        }
    }

    fn start_for(
        &self,
        label: &str,
        path: &str,
        emit: impl Fn(String) + Send + 'static,
    ) -> Result<(), String> {
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        let old = self
            .watches
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.to_owned(), WatchSlot { token, watch: None });
        // 不持锁创建 watcher 或 join 被替换的线程。
        drop(old);
        let watch = create_watch(path, emit)?;
        let mut watches = self.watches.lock().map_err(|e| e.to_string())?;
        if let Some(slot) = watches.get_mut(label).filter(|slot| slot.token == token) {
            slot.watch = Some(watch);
        } else {
            drop(watches);
            drop(watch); // start 期间 stop/销毁/另一 start 已作废本次请求
        }
        Ok(())
    }

    pub fn stop_for(&self, label: &str) {
        let old = self
            .watches
            .lock()
            .ok()
            .and_then(|mut map| map.remove(label));
        drop(old);
    }
}

fn create_watch(path: &str, emit: impl Fn(String) + Send + 'static) -> Result<ActiveWatch, String> {
    validate_typ_path(path)?;
    // 与文件读写复用同一校验：父目录 canonicalize 会跟随链接，并非拒绝链接目录。
    // 最终目标拒绝写盘符号链接，且读取复检扩展名和实际读权限；不增加文件访问旁路。
    let target = validate_write_path(path)?;
    crate::file_commands::read_file(path.to_owned())?;
    let parent = target.parent().ok_or("路径无效：没有父目录")?;
    let emit_path = path.to_owned();
    let enabled = Arc::new(AtomicBool::new(true));
    let callback_enabled = enabled.clone();
    let watched_target = target.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(150),
        move |res: DebounceEventResult| {
            if callback_enabled.load(Ordering::SeqCst)
                && res.is_ok_and(|events| events.iter().any(|e| e.path == watched_target))
            {
                emit(emit_path.clone());
            }
        },
    )
    .map_err(|e| format!("启动文件监控失败: {e}"))?;
    debouncer
        .watcher()
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("监控目录失败: {e}"))?;
    Ok(ActiveWatch {
        enabled,
        _debouncer: debouncer,
    })
}

#[derive(Clone, serde::Serialize)]
struct FileChangedPayload {
    path: String,
}

/// 目标窗口由 Tauri 注入，前端不能指定其他窗口 label。
#[tauri::command]
pub fn start_file_watch(
    path: String,
    window: Window,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), String> {
    let label = window.label().to_owned();
    let target = label.clone();
    state.start_for(&label, &path, move |path| {
        let _ = window.emit_to(&target, "file-changed", FileChangedPayload { path });
    })
}

#[tauri::command]
pub fn stop_file_watch(window: Window, state: tauri::State<'_, FileWatcherState>) {
    state.stop_for(window.label());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{self, Receiver};
    use tempfile::tempdir;

    fn start(state: &FileWatcherState, label: &str, path: &Path) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        state
            .start_for(label, path.to_str().unwrap(), move |p| {
                let _ = tx.send(p);
            })
            .unwrap();
        rx
    }

    fn changed(rx: &Receiver<String>, path: &Path) {
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            path.to_str().unwrap()
        );
        // 同一轮可能产生多个去抖通知，下一轮不消费前一轮的通知。
        while rx.recv_timeout(Duration::from_millis(350)).is_ok() {}
    }

    #[test]
    fn state_emits_same_length_writes_and_atomic_replacement_then_continues() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("doc.typ");
        std::fs::write(&file, "hello").unwrap();
        let state = FileWatcherState::new();
        let rx = start(&state, "main", &file);
        std::fs::write(&file, "world").unwrap();
        changed(&rx, &file);
        let replacement = dir.path().join("swap.typ");
        std::fs::write(&replacement, "atomic").unwrap();
        std::fs::rename(&replacement, &file).unwrap();
        changed(&rx, &file);
        std::fs::write(&file, "after replacement").unwrap();
        changed(&rx, &file);
    }

    #[test]
    fn state_filters_other_files_and_isolates_windows_and_stop() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.typ");
        let b = dir.path().join("b.typ");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let state = FileWatcherState::new();
        let rx_a = start(&state, "main", &a);
        let rx_b = start(&state, "secondary", &b);
        std::fs::write(&a, "changed-a").unwrap();
        changed(&rx_a, &a);
        assert!(rx_b.recv_timeout(Duration::from_millis(400)).is_err());
        state.stop_for("main");
        assert!(!state.watches.lock().unwrap().contains_key("main"));
        std::fs::write(&a, "stopped").unwrap();
        assert!(rx_a.recv_timeout(Duration::from_millis(400)).is_err());
        std::fs::write(&b, "changed-b").unwrap();
        changed(&rx_b, &b);
        drop(state);
        std::fs::write(&b, "dropped").unwrap();
        assert!(rx_b.recv_timeout(Duration::from_millis(400)).is_err());
    }

    #[test]
    fn replacing_window_watch_stops_old_target() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.typ");
        let b = dir.path().join("b.typ");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let state = FileWatcherState::new();
        let old = start(&state, "main", &a);
        let new = start(&state, "main", &b);
        std::fs::write(&a, "old").unwrap();
        assert!(old.recv_timeout(Duration::from_millis(400)).is_err());
        assert!(new.recv_timeout(Duration::from_millis(400)).is_err());
        std::fs::write(&b, "new").unwrap();
        changed(&new, &b);
    }

    #[test]
    fn rejects_illegal_and_unreadable_paths() {
        let dir = tempdir().unwrap();
        let state = FileWatcherState::new();
        for path in [
            "relative.typ".to_owned(),
            dir.path().join("../escape.typ").display().to_string(),
            dir.path().join("not.txt").display().to_string(),
            dir.path().join("missing.typ").display().to_string(),
        ] {
            assert!(state.start_for("main", &path, |_| {}).is_err(), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_file_symlink_without_changing_path_security() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("doc.typ");
        let link = dir.path().join("link.typ");
        std::fs::write(&file, "content").unwrap();
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert!(FileWatcherState::new()
            .start_for("main", link.to_str().unwrap(), |_| {})
            .is_err());
    }
}
