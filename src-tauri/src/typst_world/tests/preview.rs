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

/// 同行正文、跨行注释与 show 规则后必须在合法语法边界插入，不能把注入吞进注释或放在正文之后。
#[test]
fn preview_reflow_inserts_at_rule_boundary() {
    for src in [
        "#set page(paper: \"a4\"); 同行正文😀",
        "#set page(paper: \"a4\") /* 跨行\n注释 */\n正文😀",
        "#show heading: set text(size: 14pt);\n= 中文标题\n正文😀",
        "前文😀\n#set page(paper: \"a4\"); 后文中文",
        "#show: doc => { set page(width: 480pt, height: 640pt); doc }\n中文😀",
    ] {
        let out = compile_incremental_with_preview(
            src.into(),
            None,
            &fonts_dir(),
            &FontConfig::default(),
            None,
            Some(preview(320.0)),
        );
        assert!(out.ok, "{src}: {:?}", out.diagnostics);
        assert!(
            (widths(&out.pages).last().unwrap() - 320.0).abs() <= 1.0,
            "{src}: {:?}",
            widths(&out.pages)
        );
    }
}

#[test]
fn preview_reflow_preserves_inline_and_multibyte_diagnostics() {
    for src in [
        "#set page(paper: \"a4\"); 中文😀 #unknown()",
        "#set page(paper: \"a4\") /* 跨行\n注释 */\n中文😀 #unknown()",
        "前缀😀 #unknown()\n#set page(paper: \"a4\")\n正文",
        "#set page(\n  paper: \"a4\",\n)\n中文😀 #unknown()",
    ] {
        let fonts = FontConfig::default();
        let original =
            compile_incremental_with_preview(src.into(), None, &fonts_dir(), &fonts, None, None);
        let projected = compile_incremental_with_preview(
            src.into(),
            None,
            &fonts_dir(),
            &fonts,
            None,
            Some(preview(320.0)),
        );
        assert!(!original.ok && !projected.ok, "应保留原文错误：{src}");
        assert_eq!(
            serde_json::to_value(original.diagnostics).unwrap(),
            serde_json::to_value(projected.diagnostics).unwrap(),
            "{src}"
        );
    }
}

#[test]
fn preview_reflow_preserves_external_and_main_file_diagnostic_coordinates() {
    let dir = std::env::temp_dir().join(format!("typst-pad-preview-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("dep.typ"), "中文😀\n#unknown()\n").unwrap();
    let path = Some(dir.join("main.typ").to_string_lossy().into_owned());
    for src in [
        "#set page(paper: \"a4\")\n\n#include \"dep.typ\"",
        "#set page(paper: \"a4\")\n\n#image(\"missing.svg\")",
    ] {
        let fonts = FontConfig::default();
        let original = compile_incremental_with_preview(
            src.into(),
            path.clone(),
            &fonts_dir(),
            &fonts,
            None,
            None,
        );
        let projected = compile_incremental_with_preview(
            src.into(),
            path.clone(),
            &fonts_dir(),
            &fonts,
            None,
            Some(preview(320.0)),
        );
        assert!(!original.ok && !projected.ok);
        assert_eq!(
            serde_json::to_value(original.diagnostics).unwrap(),
            serde_json::to_value(projected.diagnostics).unwrap(),
            "{src}"
        );
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn preview_reflow_allows_nested_paper_override_for_frontend_fallback() {
    let src = "#{ set page(width: 480pt, height: 640pt); [中文😀] }";
    let out = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
        Some(preview(320.0)),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    assert!(widths(&out.pages).iter().all(|w| (*w - 480.0).abs() < 1.0));
    let offset = src.find("中文").unwrap();
    assert_eq!(
        locate(out.geometry_id.unwrap(), offset).unwrap().offset,
        offset
    );
}

#[test]
fn preview_reflow_keeps_prefix_and_body_geometry() {
    let src = "前缀中文😀\n#set page(paper: \"a4\")\n正文中文😀\n#set text(fill: blue)\n尾文😀";
    let out = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
        Some(preview(320.0)),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    for text in ["前缀", "正文", "尾文"] {
        let offset = src.find(text).unwrap();
        assert_eq!(locate(id, offset).unwrap().offset, offset, "{text}");
    }
}

#[test]
fn preview_reflow_cache_roundtrips_do_not_change_pdf_paper() {
    let src = "#set page(width: 480pt, height: 640pt)\n中文😀 $x^2$";
    let fonts = FontConfig::default();
    let original_pdf = compile_to_pdf_bytes(src.into(), None, &fonts_dir(), &fonts).unwrap();
    let first = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &fonts,
        None,
        Some(preview(320.0)),
    );
    let repeated = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys),
        Some(preview(320.0)),
    );
    assert!(first.ok && repeated.ok);
    assert!(
        repeated.pages.iter().all(Option::is_none),
        "相同投影必须兼容增量页引用"
    );
    assert_ne!(first.geometry_id, repeated.geometry_id);
    let natural = compile_incremental_with_preview(
        src.into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(repeated.page_keys),
        None,
    );
    assert!(
        natural.ok
            && widths(&natural.pages)
                .iter()
                .all(|w| (*w - 480.0).abs() < 1.0)
    );
    let pdf = compile_to_pdf_bytes(src.into(), None, &fonts_dir(), &fonts).unwrap();
    assert_eq!(pdf, original_pdf, "预览投影不得改变随后导出的原文 PDF");
}

fn retained_paper_source() -> String {
    "#set page(width: 480pt, height: 960pt, margin: 20pt)\n自然纸型正文".into()
}

#[test]
fn whole_body_raw_does_not_preserve_original_natural_paper() {
    let source = retained_paper_source();
    let original = compile(source.clone(), None, &fonts_dir(), &FontConfig::default());
    let raw = compile(
        format!("```\n{source}\n```"),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(original.ok && raw.ok);
    assert_eq!(view_box_width(&original.pages[0]), Some(480.0));
    assert!(original.pages[0].contains("viewBox=\"0 0 480 960\""));
    assert!((view_box_width(&raw.pages[0]).unwrap() - 595.28).abs() < 0.01);
    assert!(
        raw.pages[0].contains("841.889"),
        "整正文raw使用默认A4，而非原文480×960"
    );
}

/// 原文与保留整正文raw分开导出，连同真实预览注入产物供浏览器核对；不以桩正则推断纸型。
#[test]
#[ignore]
fn dump_page_fixtures_preview_paper() {
    let source = retained_paper_source();
    let small = source.replace("480pt, height: 960pt", "240pt, height: 320pt");
    let broken = format!("```typ\n{source}");
    let diagnostics =
        compile(broken.clone(), None, &fonts_dir(), &FontConfig::default()).diagnostics;
    assert!(!diagnostics.is_empty());
    let recovered = format!("````\n{broken}\n````");
    let default_page = compile("正文".into(), None, &fonts_dir(), &FontConfig::default());
    let a4_width = view_box_width(&default_page.pages[0]).unwrap();
    let width = 400.0 * 11.0 / 14.0;
    // 前端整正文回退/编辑锁都用隔离样式（与展开同一份 document-expansion-style.json），
    // 夹具照实生成同样的 raw，否则 SVG 与前端不一致；页面声明仍在 raw 内不执行。
    for (name, doc) in [
        ("original", source.clone()),
        (
            "retained",
            styled_raw_kind(&format!("```\n{source}\n```"), false),
        ),
        ("recovered", styled_raw_kind(&recovered, false)),
        ("small-original", small.clone()),
        (
            "small-retained",
            styled_raw_kind(&format!("```\n{small}\n```"), false),
        ),
    ] {
        for preview in [
            None,
            Some(PreviewPage {
                width_pt: width,
                height_pt: width * 2.0,
                margin_pt: 70.87 * width / 480.0,
            }),
            Some(PreviewPage {
                width_pt: width,
                height_pt: width * 841.8897637795276 / a4_width,
                margin_pt: 70.87 * width / a4_width,
            }),
        ] {
            let out = compile_incremental_with_preview(
                doc.clone(),
                None,
                &fonts_dir(),
                &FontConfig::default(),
                None,
                preview,
            );
            assert!(out.ok, "{name}: {:?}", out.diagnostics);
            let id = out.geometry_id.unwrap();
            let carets: Vec<_> = doc
                .char_indices()
                .filter_map(|(at, _)| locate(id, at))
                .collect();
            assert!(!carets.is_empty());
            let pages: Vec<_> = out.pages.into_iter().map(Option::unwrap).collect();
            let preview_json = preview.map(|p| serde_json::json!({"widthPt":p.width_pt,"heightPt":p.height_pt,"marginPt":p.margin_pt}));
            println!(
                "PAPERFIXTURE:{}",
                serde_json::json!({
                    "name":name, "doc":doc, "pages":pages, "carets":carets, "previewPage":preview_json,
                    "brokenDoc":if name == "recovered" {Some(&broken)} else {None},
                    "diagnostics":if name == "recovered" {Some(&diagnostics)} else {None},
                })
            );
        }
    }
}

/// 紧凑文档预览仍由 Typst 完整编译；夹具只覆盖预览，不改变源文档/PDF。
#[test]
#[ignore]
fn dump_page_fixtures_zoom_margins() {
    let body = "紧凑预览中文与 English，公式 $x^2$。\n\n"
        .repeat(32)
        .trim_end()
        .to_owned();
    let before = format!("#set page(margin: 70.87pt)\n{body}");
    let fonts = FontConfig::default();
    let original_pdf = compile_to_pdf_bytes(body.clone(), None, &fonts_dir(), &fonts).unwrap();
    for (name, doc, page_widths) in [
        ("before", before, vec![None, Some(620.0 * 11.0 / 14.0)]),
        (
            "compact",
            body.clone(),
            vec![
                None,
                Some(595.2755905511812),
                Some(400.0 * 11.0 / 14.0),
                Some(620.0 * 11.0 / 14.0),
                Some(180.0),
            ],
        ),
    ] {
        for width in page_widths {
            for margin in if width.is_some() && name == "before" {
                vec![70.87]
            } else if width.is_some() {
                vec![24.0, 70.87]
            } else {
                vec![24.0]
            } {
                let preview = width.map(|width_pt| PreviewPage {
                    width_pt,
                    height_pt: width_pt * 841.8897637795276 / 595.2755905511812,
                    margin_pt: margin * width_pt / 595.2755905511812,
                });
                let out = compile_incremental_with_preview(
                    doc.clone(),
                    None,
                    &fonts_dir(),
                    &fonts,
                    None,
                    preview,
                );
                assert!(out.ok, "{name}: {:?}", out.diagnostics);
                if let Some(preview) = preview {
                    assert!(widths(&out.pages)
                        .iter()
                        .all(|width| (width - preview.width_pt).abs() < 0.01));
                }
                let id = out.geometry_id.unwrap();
                let carets: Vec<_> = doc
                    .char_indices()
                    .filter_map(|(at, _)| locate(id, at))
                    .collect();
                assert!(!carets.is_empty());
                let pages: Vec<_> = out.pages.into_iter().map(Option::unwrap).collect();
                let preview_json = preview.map(|p| serde_json::json!({"widthPt":p.width_pt,"heightPt":p.height_pt,"marginPt":p.margin_pt}));
                println!(
                    "ZOOMFIXTURE:{}",
                    serde_json::json!({"name":name,"doc":doc,"pages":pages,"carets":carets,"previewPage":preview_json})
                );
            }
        }
    }
    assert_eq!(
        compile_to_pdf_bytes(body, None, &fonts_dir(), &fonts).unwrap(),
        original_pdf
    );
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
