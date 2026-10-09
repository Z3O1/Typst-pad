use super::*;
use crate::block_geometry::{PlacedItem, PlacedItemKind};
use crate::document_geometry::{caret_for_item, hit_test, locate, selection};

fn mixed_source() -> String {
    r#"#set page(width: 360pt, height: 600pt, margin: 24pt)
#set text(size: 12pt, font: "Libertinus Serif")
= 中文标题 Heading
ASCII: a.Ag! office affine ffi fl fi.
中文与 emoji 😀👩‍💻、组合字符 é 和空格。

#text(size: 8pt)[SMALLoffice] #text(size: 28pt)[LARGEoffice]

换行测试：This paragraph contains enough words to wrap over several visual lines while its source remains on one line. The cursor must follow the actual Typst output rather than the hidden input editor.

$ sum_(i=1)^n i = frac(n(n+1), 2) $

#table(columns: 2, [表格甲], [表格乙])

#rotate(30deg, reflow: true)[TURN30office]

#rotate(90deg, reflow: true)[TURN90office]

#scale(x: 150%, y: 75%)[SCALEoffice]

#pagebreak()
#set page(width: 480pt, height: 300pt, margin: 30pt)
第二页 Second page office 😀。
"#.to_string()
}

fn fixtures() -> Vec<(&'static str, String, Vec<&'static str>)> {
    let mixed = mixed_source();
    vec![
        ("mixed", mixed.clone(), vec!["中文标题 Heading", "a.Ag! office affine ffi fl fi.", "中文与 emoji 😀👩‍💻、组合字符 é 和空格。", "SMALLoffice", "LARGEoffice", "换行测试：This paragraph", "sum_(i=1)^n", "表格甲", "TURN30office", "TURN90office", "SCALEoffice", "第二页 Second page office 😀。"]),
        ("edited", mixed.replace("ASCII: a.Ag!", "ASCII: Za.Ag!"), vec!["Za.Ag!"]),
        ("raw", "#set page(width: 360pt, height: 300pt, margin: 24pt)\n```typ\n#let x = 1\n\n    // office ffi 中文 😀 é\n$x^2 + y$\n```\n".to_string(), vec!["#let x = 1", "// office ffi 中文 😀 é", "$x^2 + y$"]),
        ("whitespace", "#set page(width: 360pt, height: 300pt, margin: 24pt)\n\n  第一段 office   \n\n\n第二段 😀\n\n".to_string(), vec!["第一段 office", "第二段 😀"]),
        ("repeated", "#set page(width: 360pt, height: 300pt, margin: 24pt)\n#let value = [REPEAToffice]\n#value\n#pagebreak()\n#value\n".to_string(), vec!["REPEAToffice"]),
        ("empty", String::new(), vec![]),
        ("blank", "#set page(width: 360pt, height: 300pt, margin: 24pt)\n#set text(size: 12pt)\nA\n\n\n\nB\n\n".into(), vec!["A", "B"]),
        ("blank-edited", "#set page(width: 360pt, height: 300pt, margin: 24pt)\n#set text(size: 12pt)\nA\n\nC\n\nB\n\n".into(), vec!["A", "C", "B"]),
        ("blank-spaces", "  \n\n    \n\n".into(), vec![]),
    ]
}

fn laid_out(source: &str) -> (PagedDocument, Vec<PlacedItem>, u64) {
    let world = TypstWorld::new(
        source.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    let document = typst::compile::<PagedDocument>(&world)
        .output
        .expect("光标夹具必须由真实 Typst 编译成功");
    let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
    let id = crate::document_geometry::store(items.clone(), source.len(), stats.foreign_ink);
    (document, items, id)
}

#[test]
fn text_cursor_height_is_not_the_ink_of_punctuation_or_lowercase_letters() {
    let source = mixed_source();
    let (_, items, _) = laid_out(&source);
    let start = source.find("a.Ag!").unwrap();
    let end = start + "a.Ag! office affine ffi fl fi.".len();
    let row: Vec<_> = items
        .iter()
        .filter(|item| {
            item.kind == PlacedItemKind::Text && item.range.start >= start && item.range.end <= end
        })
        .collect();
    assert!(row.len() > 10);
    let first = row[0];
    for item in row {
        assert!((item.caret_start.y - first.caret_start.y).to_pt().abs() < 0.001);
        assert!(
            (item.caret_vector.hypot() - first.caret_vector.hypot())
                .to_pt()
                .abs()
                < 0.001
        );
    }
    assert!(first.caret_vector.hypot().to_pt() > 10.0);
}

#[test]
fn ligature_cursor_hit_and_partial_selection_use_grapheme_stops() {
    let source = mixed_source();
    let (_, items, id) = laid_out(&source);
    let start = source.find("office affine").unwrap();
    let item = items
        .iter()
        .find(|item| {
            item.range.start >= start
                && item.range.end <= start + "office affine".len()
                && item.caret_stops.is_some()
        })
        .expect("测试字体应形成至少一个多字符连字");
    let stops = item.caret_stops.as_ref().unwrap();
    assert!(stops.len() >= 3);
    for (i, &offset) in stops.iter().enumerate() {
        let expected = item.caret_start
            + (item.caret_end - item.caret_start) * (i as f64 / (stops.len() - 1) as f64);
        let cursor = locate(id, offset).unwrap();
        assert!((cursor.x_pt - expected.x.to_pt()).abs() < 0.001);
        let center = expected + item.caret_vector / 2.0;
        assert_eq!(
            hit_test(id, item.page, center.x.to_pt(), center.y.to_pt())
                .unwrap()
                .offset,
            offset
        );
    }
    let quads = selection(id, stops[0], stops[1]);
    let quad = quads
        .iter()
        .find(|quad| quad.from == stops[0] && quad.to == stops[1])
        .unwrap();
    let width = (quad.points[1][0] - quad.points[0][0]).abs();
    assert!(width > 0.0 && width < (item.caret_end.x - item.caret_start.x).to_pt().abs());
}

#[test]
fn punctuation_is_clickable_throughout_its_input_line_height() {
    let source = mixed_source();
    let (_, items, id) = laid_out(&source);
    let offset = source.find("a.Ag!").unwrap() + 1;
    let item = items
        .iter()
        .find(|item| item.range.start == offset)
        .unwrap();
    let point =
        item.caret_start + (item.caret_end - item.caret_start) * 0.2 + item.caret_vector * 0.2;
    assert_eq!(
        hit_test(id, item.page, point.x.to_pt(), point.y.to_pt())
            .unwrap()
            .offset,
        offset
    );
}

#[test]
fn raw_unicode_and_transformed_cursor_stops_stay_inside_their_output() {
    for (name, source, parts) in fixtures()
        .into_iter()
        .filter(|(name, _, _)| matches!(*name, "raw" | "mixed"))
    {
        let (_, _, id) = laid_out(&source);
        for part in parts {
            let start = source.find(part).unwrap();
            let mut mapped = 0;
            for (relative, character) in part.char_indices() {
                // 组合字符的内部位置不是独立字素停靠点。
                if character == '\u{301}' {
                    continue;
                }
                if let Some(cursor) = locate(id, start + relative) {
                    mapped += 1;
                    assert!(cursor.x_pt.is_finite() && cursor.y_pt.is_finite());
                    assert!(
                        cursor.height_pt > 0.0 && cursor.rotation_deg.is_finite(),
                        "{name}:{part}"
                    );
                }
            }
            assert!(
                mapped > 0,
                "不能用没有实际光标几何的片段验收：{name}:{part}"
            );
        }
    }
}

// 与前端空段投影逐字比对的真实产物；不在浏览器桩里模拟空段排版。
fn cursor_fixture_source(name: &str, source: &str) -> String {
    match name {
        "empty" => "\u{a0}".into(),
        "whitespace" | "blank-edited" => format!("{source}\u{a0}"),
        "blank" => format!("{}\u{a0}", source.replace("\n\n\n\n", "\n\n\u{a0}\n\n")),
        "blank-spaces" => "  \u{a0}\n\n    \u{a0}\n\n\u{a0}".into(),
        _ => source.into(),
    }
}

#[test]
fn blank_paragraph_placeholders_have_real_typst_carets_and_click_targets() {
    for (name, original, _) in fixtures()
        .into_iter()
        .filter(|(name, _, _)| matches!(*name, "empty" | "blank" | "blank-spaces"))
    {
        let source = cursor_fixture_source(name, &original);
        let (_, items, id) = laid_out(&source);
        let mut previous_y = None;
        for (offset, _) in source.char_indices().filter(|(_, ch)| *ch == '\u{a0}') {
            let caret = locate(id, offset).expect("空段占位保留原生字形光标");
            assert!(caret.height_pt > 5.0, "{name}");
            assert!(caret.x_pt.is_finite() && caret.y_pt.is_finite());
            if let Some(y) = previous_y {
                assert!(caret.y_pt > y, "连续空段必须各自占用一行");
            }
            previous_y = Some(caret.y_pt);
            let hit = hit_test(
                id,
                caret.page,
                caret.x_pt + 8.0,
                caret.y_pt + caret.height_pt / 2.0,
            )
            .expect("空段旁的空白可点击");
            assert!(hit.offset == offset || hit.offset == offset + '\u{a0}'.len_utf8());
            assert!((hit.y_pt - caret.y_pt).abs() < 0.001);
        }
        assert!(!items.is_empty(), "{name}");
    }
}

#[test]
#[ignore]
fn dump_page_fixtures_cursor_rendering() {
    for (name, original, parts) in fixtures() {
        let source = cursor_fixture_source(name, &original);
        let (document, items, id) = laid_out(&source);
        let carets: Vec<_> = items
            .iter()
            .map(|item| caret_for_item(item, item.range.start))
            .collect();
        let cursor_queries: Vec<_> = source
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(source.len()))
            .map(|offset| serde_json::json!({ "offset": offset, "caret": locate(id, offset) }))
            .collect();
        let whitespace_hits: Vec<_> =
            if matches!(name, "repeated" | "empty" | "blank" | "blank-spaces") {
                let repeated_end = source
                    .find("REPEAToffice")
                    .map(|start| start + "REPEAToffice".len());
                items
                    .iter()
                    .filter(|item| {
                        repeated_end.map_or_else(
                            || source.get(item.range.clone()) == Some("\u{a0}"),
                            |end| item.range.end == end,
                        )
                    })
                    .map(|item| {
                        let x = item.caret_end.x.to_pt() + 8.0;
                        let y = (item.caret_start + item.caret_vector / 2.0).y.to_pt();
                        let caret = hit_test(id, item.page, x, y).expect("重复输出旁的空白可命中");
                        assert_eq!(caret.is_whitespace, Some(true));
                        serde_json::json!({ "page": item.page, "xPt": x, "yPt": y, "caret": caret })
                    })
                    .collect()
            } else {
                vec![]
            };
        let pages: Vec<_> = document.pages().iter().map(svg_for_page).collect();
        let original_pages: Option<Vec<_>> = (source != original).then(|| {
            let (document, _, _) = laid_out(&original);
            document.pages().iter().map(svg_for_page).collect()
        });
        println!(
            "CURSORFIXTURE:{}",
            serde_json::json!({ "name": name, "doc": original, "source": source, "pages": pages, "originalPages": original_pages, "carets": carets, "cursorQueries": cursor_queries, "parts": parts, "selectionQuads": selection(id, 0, source.len()), "whitespaceHits": whitespace_hits })
        );
    }
}
