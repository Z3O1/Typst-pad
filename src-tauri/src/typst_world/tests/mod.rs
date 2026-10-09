// 整页编译、字体、路径与包的真实后端测试。
use super::*;
use std::path::PathBuf;

/// 测试用字体目录：`src-tauri/fonts`（与打包资源同源，见 resolve_fonts_dir；cargo test 的
/// CWD 是 src-tauri，用 CARGO_MANIFEST_DIR 定位更稳）
fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

// 与前端同源的显示样式，夹具只用真实 Typst 输出，不在浏览器桩中模拟样式。
fn expansion_style() -> &'static serde_json::Value {
    static STYLE: OnceLock<serde_json::Value> = OnceLock::new();
    STYLE.get_or_init(|| {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/lib/core/document-expansion-style.json"
        )))
        .unwrap()
    })
}

fn styled_raw(raw: &str) -> String {
    styled_raw_kind(raw, false)
}

fn styled_raw_kind(raw: &str, formula: bool) -> String {
    format!(
        "{}{raw}{}",
        expansion_style()[if formula { "formulaHead" } else { "head" }]
            .as_str()
            .unwrap(),
        expansion_style()["tail"].as_str().unwrap()
    )
}

fn expansion_preview(text: &str, block: bool, available: bool) -> String {
    if !available || !expansion::declaration_prefix(text).is_empty() {
        return String::new();
    }
    let formula = text.starts_with('$') && text.ends_with('$');
    let style = expansion_style();
    let head = if !formula {
        "outputHead"
    } else if block {
        "previewBlockHead"
    } else {
        "previewInlineHead"
    };
    let body = text;
    format!(
        "{}{body}{}",
        style[head].as_str().unwrap(),
        style[if formula { "previewTail" } else { "outputTail" }]
            .as_str()
            .unwrap()
    )
}

fn style_raw_ranges(source: &str, preview_available: bool) -> String {
    fn collect(
        node: &typst::syntax::SyntaxNode,
        from: usize,
        ranges: &mut Vec<std::ops::Range<usize>>,
    ) {
        if node.kind() == SyntaxKind::Raw {
            ranges.push(from..from + node.len());
        } else {
            let mut cursor = from;
            for child in node.children() {
                collect(child, cursor, ranges);
                cursor += child.len();
            }
        }
    }
    let mut ranges = Vec::new();
    collect(&typst::syntax::parse(source), 0, &mut ranges);
    let mut output = String::new();
    let mut end = 0;
    for range in ranges {
        output.push_str(&source[end..range.start]);
        let raw = &source[range.clone()];
        let body = raw.trim_matches('`');
        let block = body.starts_with('\n');
        let text = &body[1..body.len() - 1];
        output.push_str(&styled_raw_kind(
            raw,
            text.starts_with('$') && text.ends_with('$'),
        ));
        output.push_str(&expansion_preview(text, block, preview_available));
        end = range.end;
    }
    output.push_str(&source[end..]);
    output
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

mod cursor;
mod edit_performance;
mod expansion;
mod fonts;
mod packages;
mod paged;
mod paths;
mod performance;
