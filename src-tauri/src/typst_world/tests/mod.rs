// 整页编译、字体、路径与包的真实后端测试。
use super::*;
use std::path::PathBuf;

/// 测试用字体目录：`src-tauri/fonts`（与打包资源同源，见 resolve_fonts_dir；cargo test 的
/// CWD 是 src-tauri，用 CARGO_MANIFEST_DIR 定位更稳）
fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

// 被多个分册共用的 helper（原来它们与各自的用例同在一个文件里）：
/// 从 SVG 头部取 viewBox 的宽度（pt）
fn view_box_width(svg: &str) -> Option<f64> {
    let start = svg.find("viewBox=\"")? + "viewBox=\"".len();
    let end = svg[start..].find('"')? + start;
    svg[start..end].split_whitespace().nth(2)?.parse().ok()
}

/// 字体计数辅助（供端到端测试断言）
fn font_count() -> usize {
    load_fonts(&fonts_dir()).1.len()
}

mod edit_performance;
mod fonts;
mod packages;
mod paged;
mod paths;
mod performance;
