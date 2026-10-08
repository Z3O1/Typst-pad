// 预览重排（PreviewPage）：注入必须赢过文档自己的页面设置，且不能让诊断行号或几何偏移漂移。
use super::*;
use crate::document_geometry::locate;

/// 按 A4 比例缩出来的预览几何（前端 `previewPageGeometry` 的输出形状）
fn preview(width_pt: f64) -> PreviewPage {
    PreviewPage {
        width_pt,
        height_pt: width_pt * 841.89 / 595.28,
        margin_pt: width_pt * 70.87 / 595.28,
    }
}

fn widths(pages: &[Option<String>]) -> Vec<f64> {
    pages
        .iter()
        .flatten()
        .filter_map(|svg| view_box_width(svg))
        .collect()
}

/// 自带纸型的文档也要能重排：注入点必须在 `#set page(paper: "a4")` **之后**。
/// 旧实现插在最前面（typst 后写的赢 → 被覆盖），于是真实文档永远退回等比缩放。
#[test]
fn preview_reflow_wins_over_document_paper_setup() {
    let src = format!(
        "#set page(paper: \"a4\")\n\n{}\n",
        "重排测试正文。".repeat(400)
    );
    let fonts = FontConfig::default();
    let reflowed = compile_incremental_with_preview(
        src.clone(),
        None,
        &fonts_dir(),
        &fonts,
        None,
        Some(preview(320.0)),
    );
    assert!(reflowed.ok, "编译应成功：{:?}", reflowed.diagnostics);
    let actual = widths(&reflowed.pages);
    assert!(!actual.is_empty(), "应至少一页");
    assert!(
        actual.iter().all(|w| (w - 320.0).abs() <= 1.0),
        "注入必须赢过文档自带的纸型，实际页宽 {actual:?}"
    );

    // 重排确实**重新排版**了：窄页装得下的字更少 → 页数变多
    let untouched = compile_incremental_with_preview(src, None, &fonts_dir(), &fonts, None, None);
    assert!(
        widths(&untouched.pages)
            .iter()
            .all(|w| (w - 595.28).abs() <= 1.0),
        "不注入时应保持文档自己的 A4"
    );
    assert!(
        reflowed.pages.len() > untouched.pages.len(),
        "窄页应产生更多页（重排的直接证据）：{} vs {}",
        reflowed.pages.len(),
        untouched.pages.len()
    );
}

/// 没有自带纸型的文档：注入在最前面，同样生效。
#[test]
fn preview_reflow_applies_without_document_page_setup() {
    let src = format!("{}\n", "纯正文重排测试。".repeat(200));
    let out = compile_incremental_with_preview(
        src,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
        Some(preview(360.0)),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let actual = widths(&out.pages);
    assert!(
        !actual.is_empty() && actual.iter().all(|w| (w - 360.0).abs() <= 1.0),
        "实际页宽 {actual:?}"
    );
}

/// 注入行在源中间，只有它**之后**的诊断行号要减 1。
#[test]
fn preview_reflow_keeps_main_source_diagnostic_lines() {
    let src = "#set page(paper: \"a4\")\n// 注释\n\n#unknown_function()\n";
    let out = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
        Some(preview(320.0)),
    );
    assert!(!out.ok, "未知函数应编译失败");
    let diagnostic = out.diagnostics.first().expect("应给出诊断");
    assert_eq!(
        diagnostic.line, 4,
        "诊断应报在用户文档的第 4 行：{:?}",
        out.diagnostics
    );
}

/// 几何偏移回映：`document_hit_test` / `document_cursor` 消费的是"前缀 + 用户文档"坐标，
/// 注入造成的位移必须在落地前抹掉 —— 否则文档偏移会查到别的字形或查不到。
#[test]
fn preview_reflow_maps_geometry_offsets_back_to_document() {
    let src = format!("#set page(paper: \"a4\")\n\n{}\n", "定位标记字".repeat(200));
    let expected = src.find("定位标记字").expect("文档里应有标记文字");
    let fonts = FontConfig::default();
    let reflowed = compile_incremental_with_preview(
        src.clone(),
        None,
        &fonts_dir(),
        &fonts,
        None,
        Some(preview(320.0)),
    );
    assert!(reflowed.ok, "{:?}", reflowed.diagnostics);
    let caret = locate(reflowed.geometry_id.expect("应带几何编号"), expected)
        .expect("重排后也必须能用文档偏移定位");
    assert_eq!(caret.offset, expected);
    assert!(caret.page >= 1);

    let untouched = compile_incremental_with_preview(src, None, &fonts_dir(), &fonts, None, None);
    assert!(locate(untouched.geometry_id.expect("应带几何编号"), expected).is_some());
}

/// 脏输入不注入（不因为一个坏数字把编译弄挂）
#[test]
fn preview_reflow_ignores_invalid_geometry() {
    let src = "正文".to_string();
    for bad in [
        PreviewPage {
            width_pt: 0.0,
            height_pt: 10.0,
            margin_pt: 1.0,
        },
        PreviewPage {
            width_pt: 100.0,
            height_pt: f64::NAN,
            margin_pt: 1.0,
        },
        PreviewPage {
            width_pt: 100.0,
            height_pt: 10.0,
            margin_pt: -1.0,
        },
    ] {
        let out = compile_incremental_with_preview(
            src.clone(),
            None,
            &fonts_dir(),
            &FontConfig::default(),
            None,
            Some(bad),
        );
        assert!(out.ok, "{:?}", out.diagnostics);
        assert!(
            widths(&out.pages).iter().all(|w| (w - 595.28).abs() <= 1.0),
            "非法几何不得注入：{bad:?}"
        );
    }
}
