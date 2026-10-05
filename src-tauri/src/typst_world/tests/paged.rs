// 整篇编译：完整页面、交互几何、中文与源码展开，以及 IPC 的 JSON 键名契约。
use super::*;

/// 中文与公式由原生引擎一起编译为完整 SVG。
#[test]
fn compile_chinese_math_doc() {
    let src = r#"
= 你好，Typst
这是中文测试文档。
$ a^2 + b^2 = c^2 $
"#
    .to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "编译应成功，实际诊断: {:?}", out.diagnostics);
    assert!(!out.pages.is_empty(), "应至少有一页");
    assert!(out.pages[0].contains("<svg"), "每页应是完整 SVG");
    // 中文字体（思源宋体）与数学字体（NewCM）必须加载成功
    assert!(
        font_count() >= 7,
        "src-tauri/fonts 下 7 个字体文件应全部注册"
    );
}

#[test]
fn json_keys_are_camel_case() {
    let out = CompileOutput {
        geometry_id: None,
        ok: true,
        pages: vec!["<svg>…</svg>".to_string()],
        diagnostics: Vec::new(),
        warnings: vec![Diagnostic {
            message: "警告".to_string(),
            severity: "warning".to_string(),
            line: 2,
            column: 3,
            end_line: Some(4),
            end_column: Some(5),
            path: Some("sub/a.typ".to_string()),
        }],
    };
    let json = serde_json::to_string(&out).unwrap();
    assert!(
        json.contains("\"endLine\":4"),
        "应输出 endLine，实际: {json}"
    );
    assert!(
        json.contains("\"endColumn\":5"),
        "应输出 endColumn，实际: {json}"
    );
    assert!(
        !json.contains("end_line"),
        "不应输出 snake_case，实际: {json}"
    );
    assert!(json.contains("\"ok\":true"));
    assert!(json.contains("\"pages\""));

    // 单条诊断结构：message/severity/line/column/endLine/endColumn/path
    let pdf = PdfResult {
        ok: false,
        error: Some("失败".into()),
    };
    let json = serde_json::to_string(&pdf).unwrap();
    assert_eq!(json, r#"{"ok":false,"error":"失败"}"#);
}

fn document_mode_sample() -> String {
    r##"#set page(width: 360pt, height: 500pt, margin: 24pt)
#set text(size: 12pt)
#let banner(body) = block(fill: rgb("#eef4ff"), inset: 8pt, body)
= 完整编译结果
正文含中文与 emoji 😀，行内公式 $x^2 + y$。

$ sum_(i=1)^n i = frac(n(n+1), 2) $

#table(columns: 2, [甲], [乙], [一], [二])

#image(bytes("<svg xmlns='http://www.w3.org/2000/svg' width='80' height='40'><rect width='80' height='40' fill='orange'/></svg>"), width: 60pt)

#banner[这是宏输出]

#pagebreak()
#set page(width: 480pt, height: 300pt, margin: 30pt)
= 第二页
第二页使用不同纸型，仍由 Typst 完整呈现。
"##.to_string()
}

#[test]
fn document_mode_preserves_all_pages_and_geometry() {
    let src = document_mode_sample();
    let out = compile(src.clone(), None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "{:?}", out.diagnostics);
    assert_eq!(out.pages.len(), 2);
    assert_eq!(view_box_width(&out.pages[0]), Some(360.0));
    assert_eq!(view_box_width(&out.pages[1]), Some(480.0));
    assert!(out.pages[0].contains("<image"), "图片必须留在整页 SVG 中");
    let id = out.geometry_id.expect("完整产物必须携带自己的命中编号");
    let byte = src.find("正文含").unwrap();
    let caret = crate::document_geometry::locate(id, byte).expect("正文源码可映射到整页");
    let hit = crate::document_geometry::hit_test(id, caret.page, caret.x_pt, caret.y_pt).unwrap();
    assert_eq!(hit.offset, byte, "中文命中按 UTF-8 字节定位");
    let second = crate::document_geometry::locate(id, src.find("第二页使用").unwrap()).unwrap();
    assert_eq!(second.page, 2);
    // 另一次编译不覆盖这份产物的几何，失败也不能被误认成它。
    let other = compile(
        "另一个窗口".to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert_ne!(out.geometry_id, other.geometry_id);
    assert!(crate::document_geometry::locate(id, byte).is_some());
    let fail = compile(
        "#unknown()".to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(!fail.ok);
    assert!(fail.geometry_id.is_none());
}

// 独立沿帧树逐层变换真实字形内的点，不借用生产几何计算。
fn visible_text_points(
    world: &dyn World,
    frame: &Frame,
    groups: &[(Point, typst::layout::Transform)],
    points: &mut Vec<(usize, Point)>,
) {
    for (pos, item) in frame.items() {
        match item {
            FrameItem::Text(text) => {
                let mut x = Abs::zero();
                for glyph in &text.glyphs {
                    let advance = glyph.x_advance.at(text.size);
                    if let Some(range) = world.range(glyph.span.0) {
                        let mut point =
                            Point::new(pos.x + x + advance / 4.0, pos.y - text.size / 3.0);
                        for (offset, transform) in groups.iter().rev() {
                            point = point.transform(*transform) + *offset;
                        }
                        points.push((range.start + usize::from(glyph.span.1), point));
                    }
                    x += advance;
                }
            }
            FrameItem::Group(group) => {
                let mut nested = groups.to_vec();
                nested.push((*pos, group.transform));
                visible_text_points(world, &group.frame, &nested, points);
            }
            _ => {}
        }
    }
}

#[test]
fn document_hits_text_over_background_and_through_nested_transforms() {
    for body in [
        "#block(fill: red, inset: 8pt)[正文文字]",
        "#rotate(90deg)[正文文字]",
        "#move(dx: 30pt, dy: 30pt)[#rotate(30deg)[#scale(x: 150%, y: 80%)[正文文字]]]",
    ] {
        let source = format!("#set page(width: 240pt, height: 240pt, margin: 40pt)\n{body}");
        let world = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let first = source.find("正文").unwrap();
        let last = first + "正文文字".len();
        let expected_caret = items
            .iter()
            .find(|item| {
                item.range.start == first
                    && item.kind == crate::block_geometry::PlacedItemKind::Text
            })
            .unwrap()
            .caret_start;
        let id = crate::document_geometry::store(items, source.len(), stats.foreign_ink);
        let caret = crate::document_geometry::locate(id, first).unwrap();
        assert_eq!(caret.x_pt, expected_caret.x.to_pt(), "{body}");
        assert_eq!(caret.y_pt, expected_caret.y.to_pt(), "{body}");
        if body.contains("90deg") {
            assert!((caret.rotation_deg - 90.0).abs() < 0.001);
        }
        let mut points = Vec::new();
        visible_text_points(&world, &document.pages()[0].frame, &[], &mut points);
        let points: Vec<_> = points
            .into_iter()
            .filter(|(offset, _)| *offset >= first && *offset < last)
            .collect();
        assert_eq!(points.len(), 4, "必须实际检查四个字：{body}");
        for (offset, point) in points {
            let hit = crate::document_geometry::hit_test(id, 1, point.x.to_pt(), point.y.to_pt())
                .unwrap();
            assert_eq!(
                hit.offset, offset,
                "点击真实字形的位置必须返回该字的起点：{body}"
            );
        }
    }
}

#[test]
fn raw_source_expansion_keeps_character_spans_and_full_pages() {
    let source = "#set page(width: 240pt, height: 240pt, margin: 40pt)\n正文 ` $x^2 + y$ ` 后文\n\n```typ\n#image(\n \"a.png\",\n width: 60pt,\n)\n```";
    let out = compile(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    let world = TypstWorld::new(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    let document = typst::compile::<PagedDocument>(&world).output.unwrap();
    let mut points = Vec::new();
    visible_text_points(&world, &document.pages()[0].frame, &[], &mut points);
    for pos in [
        source.find("$x").unwrap(),
        source.find("image").unwrap(),
        source.find("width: 60").unwrap(),
    ] {
        assert!(
            crate::document_geometry::locate(id, pos).is_some(),
            "展开源码必须可逐字定位：{pos}"
        );
        let (_, point) = points.iter().find(|(offset, _)| *offset == pos).unwrap();
        let hit =
            crate::document_geometry::hit_test(id, 1, point.x.to_pt(), point.y.to_pt()).unwrap();
        assert_eq!(hit.offset, pos, "展开后的可见字符必须命中它自己的源码位置");
    }
}

/// 浏览器只消费原生整页 SVG 和命中探针，不伪造 Typst 的正文、公式、表格与图片。
#[test]
#[ignore]
fn dump_page_fixtures() {
    let original = document_mode_sample();
    let edited = original.replace("正文含中文", "修改后的正文含中文");
    let table = "#table(columns: 2, [甲], [乙], [一], [二])";
    let image_start = original.find("#image(").unwrap();
    let image_end = original[image_start..].find("\n\n").unwrap() + image_start;
    let image = &original[image_start..image_end];
    for src in [
        original.clone(),
        edited.clone(),
        original.replace("$x^2 + y$", "` $x^2 + y$ `"),
        edited.replace("$x^2 + y$", "` $x^2 + y$ `"),
        original.replace(table, &format!("` {table} `")),
        original.replace(image, &format!("` {image} `")),
    ] {
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world)
            .output
            .expect("整页夹具必须编译成功");
        let (items, _) = crate::block_geometry::collect_geometry(&world, &document);
        let carets: Vec<crate::document_geometry::DocumentCaret> = items
            .iter()
            .map(|item| crate::document_geometry::caret_for_item(item, item.range.start))
            .collect();
        let pages: Vec<String> = document.pages().iter().map(svg_for_page).collect();
        println!(
            "PAGEFIXTURE:{}",
            serde_json::json!({ "doc": src, "pages": pages, "carets": carets })
        );
    }
}
