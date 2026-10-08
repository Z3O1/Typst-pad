use super::*;
use crate::document_geometry::{caret_for_item, locate, selection, store};

fn expansion_sample() -> String {
    "#set page(width: 360pt, height: 260pt, margin: 24pt)\n#set text(size: 12pt)\n正文 $a + b$ 中间 #text(fill: red)[嵌套 $c + d$ 与 #strong[粗体]] 后文。\n\n#block[\n多行脚本正文。\n第二行中文与 😀。\n]\n\n#pagebreak()\n第二页正文。\n".into()
}

type ExpansionSource = (&'static str, String, Option<(usize, usize)>);

fn expansion_sources() -> Vec<ExpansionSource> {
    let base = expansion_sample();
    let edited = base.replace("$a + b$", "$a + b + z$");
    let block_edited = base.replace("多行脚本正文。", "多行脚本正文。续");
    [
        ("base", base.clone(), None),
        ("math", base.clone(), Some("$a + b$")),
        ("edited-base", edited.clone(), None),
        ("math-edited", edited, Some("$a + b + z$")),
        ("nested-math", base.clone(), Some("$c + d$")),
        (
            "outer",
            base.clone(),
            Some("#text(fill: red)[嵌套 $c + d$ 与 #strong[粗体]]"),
        ),
        ("strong", base.clone(), Some("#strong[粗体]")),
        (
            "block",
            base.clone(),
            Some("#block[\n多行脚本正文。\n第二行中文与 😀。\n]"),
        ),
        (
            "block-edited",
            block_edited,
            Some("#block[\n多行脚本正文。续\n第二行中文与 😀。\n]"),
        ),
    ]
    .into_iter()
    .map(|(name, doc, text)| {
        let range = text.map(|text| {
            let from = doc.find(text).unwrap();
            (from, from + text.len())
        });
        (name, doc, range)
    })
    .collect()
}

fn projected(doc: &str, range: Option<(usize, usize)>) -> String {
    let Some((from, to)) = range else {
        return doc.into();
    };
    let text = &doc[from..to];
    let raw = if text.contains('\n') {
        format!("```\n{text}\n```")
    } else {
        format!("` {text} `")
    };
    format!("{}{raw}{}", &doc[..from], &doc[to..])
}

#[test]
fn cursor_expansion_preserves_full_output_and_raw_character_locations() {
    for (name, doc, range) in expansion_sources() {
        let src = projected(&doc, range);
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(name);
        assert!(document.pages().len() >= 2, "{name}");
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let carets: Vec<_> = items
            .iter()
            .map(|item| caret_for_item(item, item.range.start))
            .collect();
        assert!(carets.iter().all(|caret| caret.height_pt > 0.0), "{name}");
        let id = store(items, src.len(), stats.foreign_ink);
        if let Some((from, to)) = range {
            let text = &doc[from..to];
            let start = src.find(text).unwrap();
            // raw 中的中文/emoji 和多行都必须有真实源码光标，不能只成功导出一张页图。
            for (offset, ch) in text.char_indices().filter(|(_, ch)| !ch.is_whitespace()) {
                assert!(
                    locate(id, start + offset).is_some(),
                    "{name}: {ch} at {offset}"
                );
            }
        }
    }
}

#[test]
#[ignore]
fn dump_page_fixtures_expansion() {
    for (name, original, range) in expansion_sources() {
        let src = projected(&original, range);
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(name);
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let carets: Vec<_> = items
            .iter()
            .map(|item| caret_for_item(item, item.range.start))
            .collect();
        let id = store(items, src.len(), stats.foreign_ink);
        let queries: Vec<_> = src
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(src.len()))
            .map(|offset| serde_json::json!({ "offset": offset, "caret": locate(id, offset) }))
            .collect();
        let range = range.map(|(from, to)| serde_json::json!({ "from": original[..from].encode_utf16().count(), "to": original[..to].encode_utf16().count() }));
        let pages: Vec<_> = document.pages().iter().map(svg_for_page).collect();
        println!(
            "EXPANSIONFIXTURE:{}",
            serde_json::json!({ "name": name, "doc": src, "original": original, "range": range, "pages": pages, "carets": carets, "cursorQueries": queries, "selectionQuads": selection(id, 0, src.len()) })
        );
    }
}
