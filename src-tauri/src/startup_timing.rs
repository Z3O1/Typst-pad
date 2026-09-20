// 启动时序打点（仅 debug 构建编译，release 零输出零开销）：记录 Rust 壳
// 「窗口创建 → webview 就绪 → 前端加载完成」各阶段相对 setup 入口的耗时。
// 与前端 [startup] 打点（startup-timing.ts，无条件输出）配合，补全 #43 未实测的 Rust 段；
// 输出 [startup] rust phase:<name> t:<ms>，与前端同前缀便于统一抓取过滤。
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
