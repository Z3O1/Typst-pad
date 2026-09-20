// typst_world 的单元测试按**关注点**分文件（原先是一个 1233 行的 `tests.rs`）。
//
// 这里只放公共件（`fonts_dir`）与各分册的 `mod` 声明；用例在 `tests/<关注点>.rs` 里。
// `dump_math_fixtures`（`#[ignore]`）留在 `tests/math.rs` —— `package.json` 的 `fixtures:math`
// 按**用例名**过滤它，名字不能改。
use super::*;
use std::path::PathBuf;

/// 测试用字体目录：`src-tauri/fonts`（与打包资源同源，见 resolve_fonts_dir；cargo test 的
/// CWD 是 src-tauri，用 CARGO_MANIFEST_DIR 定位更稳）
fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

// 被多个分册共用的 helper（原来它们与各自的用例同在一个文件里）：
/// 从 SVG 头部取 viewBox 的高度
fn view_box_height(svg: &str) -> Option<f64> {
    let start = svg.find("viewBox=\"")? + "viewBox=\"".len();
    let end = svg[start..].find('"')? + start;
    svg[start..end].split_whitespace().nth(3)?.parse().ok()
}

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

mod fonts;
mod math;
mod packages;
mod paged;
mod paths;
