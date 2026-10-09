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
fn incremental_pages_keep_full_export_identity_and_fresh_geometry() {
    let source = "#set page(width: 300pt, height: 400pt)\n版本 A\n#pagebreak()\n第二页";
    let fonts = FontConfig::default();
    let first = compile_incremental(source.into(), None, &fonts_dir(), &fonts, None);
    assert!(first.ok);
    let full = compile(source.into(), None, &fonts_dir(), &fonts);
    assert_eq!(
        first.pages,
        full.pages.into_iter().map(Some).collect::<Vec<_>>()
    );
    let same = compile_incremental(
        source.into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys.clone()),
    );
    assert!(same.pages.iter().all(Option::is_none));
    assert_eq!(same.page_keys, first.page_keys);
    assert_ne!(same.geometry_id, first.geometry_id);
    let json = serde_json::to_value(&same).unwrap();
    assert_eq!(json["pages"], serde_json::json!([null, null]));
    assert_eq!(json["pageKeys"].as_array().unwrap().len(), 2);
    let changed = source.replace("版本 A", "版本 B");
    let next = compile_incremental(
        changed.clone(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys.clone()),
    );
    assert!(next.pages[0].is_some());
    assert!(next.pages[1].is_none());
    let complete = compile(changed, None, &fonts_dir(), &fonts);
    let reconstructed: Vec<_> = next
        .pages
        .iter()
        .enumerate()
        .map(|(i, page)| page.as_ref().or(first.pages[i].as_ref()).unwrap().clone())
        .collect();
    assert_eq!(reconstructed, complete.pages);
    let missing = compile_incremental(
        source.into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys[..1].to_vec()),
    );
    assert!(missing.pages[0].is_none());
    assert!(missing.pages[1].is_some());
    let reordered = compile_incremental(
        source.into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys.iter().rev().cloned().collect()),
    );
    assert!(reordered.pages.iter().all(Option::is_some));
    // 非等长输入、纸型/字体变化和增删页也必须按同位置基准重建完整产物。
    for edited in [
        source.replace("版本 A", "新增的版本 A"),
        source.replace("300pt", "480pt"),
        format!("#set text(size: 20pt)\n{source}"),
        format!("{source}\n#pagebreak()\n新增页"),
        source.split("#pagebreak()").next().unwrap().to_string(),
    ] {
        let partial = compile_incremental(
            edited.clone(),
            None,
            &fonts_dir(),
            &fonts,
            Some(first.page_keys.clone()),
        );
        assert!(partial.ok);
        let complete = compile(edited, None, &fonts_dir(), &fonts);
        let restored: Vec<_> = partial
            .pages
            .iter()
            .enumerate()
            .map(|(i, page)| {
                page.as_ref()
                    .or_else(|| first.pages.get(i).and_then(Option::as_ref))
                    .unwrap()
                    .clone()
            })
            .collect();
        assert_eq!(restored, complete.pages);
    }
    let failed = compile_incremental(
        "$unknown$".into(),
        None,
        &fonts_dir(),
        &fonts,
        Some(first.page_keys),
    );
    assert!(!failed.ok);
    assert!(failed.page_keys.is_empty());
    assert!(failed.geometry_id.is_none());
    assert!(serde_json::to_value(failed)
        .unwrap()
        .get("pageKeys")
        .is_none());
}

#[test]
fn json_keys_are_camel_case() {
    let out = CompileOutput {
        geometry_id: None,
        formula_preview: None,
        ok: true,
        pages: vec!["<svg>…</svg>".to_string()],
        page_keys: Vec::new(),
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
#link("https://typst.app")[页面链接]

第二页使用不同纸型，仍由 Typst 完整呈现。
"##.to_string()
}

#[test]
fn document_selection_tracks_unicode_and_cross_page_output() {
    let src = document_mode_sample();
    let out = compile(src.clone(), None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    let from = src.find("正文含").unwrap();
    let emoji = src.find('😀').unwrap();
    let first = crate::document_geometry::selection(id, from, emoji + '😀'.len_utf8());
    assert!(!first.is_empty());
    assert!(first.iter().all(|quad| quad.page == 1
        && quad.to > from
        && quad.from <= emoji
        && quad.points.iter().flatten().all(|value| value.is_finite())));
    assert!(first.iter().any(|quad| quad.from == emoji));
    let to = src.find("第二页使用").unwrap() + "第二页".len();
    let all = crate::document_geometry::selection(id, from, to);
    assert!(all.iter().any(|quad| quad.page == 1));
    assert!(all.iter().any(|quad| quad.page == 2));
    assert_eq!(all, crate::document_geometry::selection(id, to, from));
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

#[test]
fn document_whitespace_uses_real_line_edges_and_stays_on_the_clicked_page() {
    let source =
        "#set page(width: 240pt, height: 240pt, margin: 40pt)\n甲乙\n\n丙丁\n#pagebreak()\n戊己";
    let out = compile(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    for (page, first, last) in [(1, "甲乙", "丙丁"), (2, "戊己", "戊己")] {
        let first_offset = source.find(first).unwrap();
        let last_offset = source.find(last).unwrap() + last.len();
        for x in [-100.0, 500.0] {
            assert_eq!(
                crate::document_geometry::hit_test(id, page, x, -100.0)
                    .unwrap()
                    .offset,
                first_offset
            );
            assert_eq!(
                crate::document_geometry::hit_test(id, page, x, 500.0)
                    .unwrap()
                    .offset,
                last_offset
            );
        }
        let caret = crate::document_geometry::locate(id, first_offset).unwrap();
        let y = caret.y_pt + caret.height_pt / 2.0;
        let left = crate::document_geometry::hit_test(id, page, -100.0, y).unwrap();
        let right = crate::document_geometry::hit_test(id, page, 500.0, y).unwrap();
        assert_eq!(left.offset, first_offset);
        assert_eq!(right.offset, first_offset + first.len());
        assert_eq!(right.page, page);
    }
}

#[test]
fn document_whitespace_page_edges_include_raised_and_lowered_inline_text() {
    for body in ["甲#super[乙]丙", "甲#sub[乙]丙"] {
        let source = format!("#set page(width: 240pt, height: 240pt, margin: 40pt)\n{body}");
        let out = compile(source.clone(), None, &fonts_dir(), &FontConfig::default());
        assert!(out.ok, "{:?}", out.diagnostics);
        let id = out.geometry_id.unwrap();
        assert_eq!(
            crate::document_geometry::hit_test(id, 1, 500.0, 0.0)
                .unwrap()
                .offset,
            source.find("甲").unwrap(),
            "上方空白必须落到整行行首：{body}"
        );
        assert_eq!(
            crate::document_geometry::hit_test(id, 1, 0.0, 500.0)
                .unwrap()
                .offset,
            source.find("丙").unwrap() + "丙".len(),
            "下方空白必须落到整行行尾：{body}"
        );
    }
}

#[test]
fn document_side_whitespace_stays_at_the_line_end_with_mixed_font_sizes() {
    let source = "#set page(width: 240pt, height: 240pt, margin: 40pt)\n#text(size: 30pt)[甲]乙";
    let out = compile(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    let big = crate::document_geometry::locate(id, source.find("甲").unwrap()).unwrap();
    let last = source.find("乙").unwrap() + "乙".len();
    for y in [big.y_pt + 1.0, big.y_pt + big.height_pt / 2.0] {
        let hit = crate::document_geometry::hit_test(id, 1, 500.0, y).unwrap();
        assert_eq!(hit.offset, last, "同行的小字不能因墨迹较低而被略过");
        assert_eq!(hit.is_whitespace, Some(true));
    }
}

#[test]
fn document_whitespace_over_text_background_does_not_hit_the_macro_definition() {
    let source = "#set page(width: 240pt, height: 240pt, margin: 40pt)\n#let banner(body) = block(fill: red, inset: 8pt, body)\n#banner[甲乙]";
    let out = compile(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(out.ok, "{:?}", out.diagnostics);
    let id = out.geometry_id.unwrap();
    let last = source.find("乙").unwrap();
    let caret = crate::document_geometry::locate(id, last + "乙".len()).unwrap();
    let hit = crate::document_geometry::hit_test(
        id,
        1,
        caret.x_pt + 4.0,
        caret.y_pt + caret.height_pt / 2.0,
    )
    .unwrap();
    assert_eq!(hit.offset, last + "乙".len());
    assert_eq!(hit.is_whitespace, Some(true));
    assert_eq!(
        crate::document_geometry::hit_test(id, 1, 500.0, 0.0)
            .unwrap()
            .offset,
        source.find("甲").unwrap(),
        "文字背景不能把页首空白定位到宏定义"
    );
    assert_eq!(
        crate::document_geometry::hit_test(id, 1, 0.0, 500.0)
            .unwrap()
            .offset,
        last + "乙".len(),
        "文字背景不能把页尾空白定位到宏定义"
    );
    let rect = compile(
        "#set page(margin: 40pt)\n#rect(width: 30pt, height: 30pt, fill: red)".to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(rect.ok, "{:?}", rect.diagnostics);
    let direct =
        crate::document_geometry::hit_test(rect.geometry_id.unwrap(), 1, 50.0, 50.0).unwrap();
    assert_eq!(
        direct.is_whitespace,
        Some(false),
        "独立图形仍可直接点击展开"
    );
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

#[test]
fn document_error_source_projections_compile() {
    for (broken, projected) in [
        ("前文 $unknown$ 后文", "前文 ` $unknown$ ` 后文"),
        (
            "前文 #block[内容 #missing()] 后文",
            "前文 ` #block[内容 #missing()] ` 后文",
        ),
        (
            "#let x = unknown\n正文 #x",
            "` #let x = unknown `\n正文 ` #x `",
        ),
        ("正文 $ x^", "` 正文 $ x^ `"),
        ("```typ\n", "````typ\n```typ\n\n````"),
        (
            "#table(\n columns: missing,\n [甲],\n)\n正文",
            "```typ\n#table(\n columns: missing,\n [甲],\n)\n```\n正文",
        ),
    ] {
        let failure = compile(broken.into(), None, &fonts_dir(), &FontConfig::default());
        assert!(!failure.ok, "原文必须确实出错：{broken}");
        let recovered = compile(projected.into(), None, &fonts_dir(), &FontConfig::default());
        assert!(
            recovered.ok,
            "源码回退必须可排版：{:?}",
            recovered.diagnostics
        );
        assert!(recovered.geometry_id.is_some(), "回退源码仍需可交互");
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
    let broken = original.replace("$x^2 + y$", "$unknown$");
    let recovery_diagnostics =
        compile(broken.clone(), None, &fonts_dir(), &FontConfig::default()).diagnostics;
    assert!(!recovery_diagnostics.is_empty());
    let recovered = broken.replace("$unknown$", "` $unknown$ `");
    let broken_preview = style_raw_ranges(&recovered, true);
    let preview_diagnostics = compile(
        broken_preview.clone(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    )
    .diagnostics;
    assert!(!preview_diagnostics.is_empty());
    for src in [
        original.clone(),
        edited.clone(),
        original.replace("$x^2 + y$", "` $x^2 + y$ `"),
        edited.replace("$x^2 + y$", "` $x^2 + y$ `"),
        original.replace(table, &format!("` {table} `")),
        original.replace(image, &format!("` {image} `")),
        original.replace(
            "第二页使用不同纸型，仍由 Typst 完整呈现。",
            "第二页使用不同纸型，仍由 Typst 完整呈现。续",
        ),
        recovered.clone(),
    ] {
        let is_recovery = src == recovered;
        let src = style_raw_ranges(&src, !is_recovery);
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world)
            .output
            .expect("整页夹具必须编译成功");
        let (document, formula_preview) = super::super::formula_preview::extract(&document);
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let carets: Vec<crate::document_geometry::DocumentCaret> = items
            .iter()
            .map(|item| crate::document_geometry::caret_for_item(item, item.range.start))
            .collect();
        let macro_side = src.find("这是宏输出").and_then(|start| {
            let end = start + src[start..].find(']')?;
            let last = start + src[start..end].char_indices().last()?.0;
            let item = items.iter().find(|item| item.range.start == last)?;
            Some((
                item.page,
                item.rect.max.x.to_pt() + 8.0,
                (item.rect.min.y.to_pt() + item.rect.max.y.to_pt()) / 2.0,
            ))
        });
        let id = crate::document_geometry::store(items, src.len(), stats.foreign_ink);
        let mut whitespace_hits: Vec<_> = document
            .pages()
            .iter()
            .enumerate()
            .flat_map(|(index, page)| {
                let width = page.frame.width().to_pt();
                let height = page.frame.height().to_pt();
                [(width + 12.0, 1.0), (width / 2.0, 1.0), (1.0, height - 1.0)]
                    .into_iter()
                    .map(move |(x, y)| {
                        serde_json::json!({
                            "page": index + 1, "xPt": x, "yPt": y,
                            "caret": crate::document_geometry::hit_test(id, index + 1, x, y)
                        })
                    })
            })
            .collect();
        if let Some((page, x, y)) = macro_side {
            let caret = crate::document_geometry::hit_test(id, page, x, y).unwrap();
            assert_eq!(caret.is_whitespace, Some(true));
            whitespace_hits.push(serde_json::json!({
                "name": "macro-side", "page": page, "xPt": x, "yPt": y, "caret": caret
            }));
        }
        let pages: Vec<String> = document.pages().iter().map(svg_for_page).collect();
        println!(
            "PAGEFIXTURE:{}",
            serde_json::json!({ "doc": src, "pages": pages, "formulaPreview": formula_preview, "carets": carets,
                "selectionQuads": crate::document_geometry::selection(id, 0, src.len()),
                "whitespaceHits": whitespace_hits,
                "brokenDoc": if is_recovery { Some(&broken) } else { None },
                "diagnostics": if is_recovery { Some(&recovery_diagnostics) } else { None },
                "brokenPreviewDoc": if is_recovery { Some(&broken_preview) } else { None },
                "previewDiagnostics": if is_recovery { Some(&preview_diagnostics) } else { None },
            })
        );
    }
}
