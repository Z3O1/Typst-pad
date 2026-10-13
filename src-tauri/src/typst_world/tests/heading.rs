// 标题显示投影：真实字符来源、正文隔离与 heading/嵌套表达式语义。
use super::*;
use crate::document_geometry::{locate, store};

const HEADING: &str = "== 中文标题 #context { c.step(); [ONCE] } $x^2$ #strong[粗体]";

pub(super) fn sources() -> Vec<expansion::ExpansionSource> {
    let base = format!("#set page(width: 360pt, height: 260pt, margin: 24pt)\n#set text(size: 12pt)\n#set heading(numbering: \"1.\")\n#let c = counter(\"heading-once\")\n正文前。\n\n{HEADING}\n后正文 FOLLOW。\n\n= Next\n#context [COUNT: #c.get().first(); HEADINGS: #query(heading).len(); LEVELS: #counter(heading).get()]\n#pagebreak()\n第二页正文。\n");
    let edited_heading = HEADING.replace("中文标题", "中文标题续");
    let edited = base.replace(HEADING, &edited_heading);
    let empty = base.replace(HEADING, "=== ");
    let nested = base.replace(HEADING, &format!("#block[\n{HEADING}\n嵌套后文。\n]"));
    let mixed = cursor::mixed_source();
    [
        ("heading-base", base.clone(), None),
        ("heading", base, Some(HEADING)),
        ("heading-edited-base", edited.clone(), None),
        ("heading-edited", edited, Some(edited_heading.as_str())),
        ("heading-empty-base", empty.clone(), None),
        ("heading-empty", empty, Some("=== ")),
        ("heading-nested-base", nested.clone(), None),
        ("heading-nested", nested, Some(HEADING)),
        ("cursor-heading", mixed, Some("= 中文标题 Heading")),
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

#[test]
fn heading_projection_has_exact_level_and_body_carets_without_following_style_leaks() {
    for (name, original, range) in sources()
        .into_iter()
        .filter(|(_, _, range)| range.is_some())
    {
        let (from, to) = range.unwrap();
        let source = expansion::projected(&original, range);
        let start = expansion::visible_start(&original, from, to);
        let world = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(name);
        let (document, preview) = super::super::formula_preview::extract(&document);
        assert!(preview.is_none(), "标题不是公式气泡：{name}");
        let original_world =
            TypstWorld::new(original.clone(), None, &fonts_dir(), &FontConfig::default());
        let original_document = typst::compile::<PagedDocument>(&original_world)
            .output
            .expect(name);
        assert_eq!(
            document.pages()[0].frame.size(),
            original_document.pages()[0].frame.size(),
            "标题展开不污染自然纸型：{name}"
        );
        fn raw_type(frame: &Frame, world: &TypstWorld, from: usize, to: usize) {
            for (_, item) in frame.items() {
                match item {
                    FrameItem::Text(text)
                        if text.glyphs.iter().any(|glyph| {
                            world.range(glyph.span.0).is_some_and(|range| {
                                let offset = range.start + usize::from(glyph.span.1);
                                offset >= from && offset < to
                            })
                        }) =>
                    {
                        assert_eq!(text.size.to_pt(), 11.0);
                        assert!(matches!(
                            text.font.info().family.as_str(),
                            "DejaVu Sans Mono" | "Noto Serif CJK SC"
                        ));
                    }
                    FrameItem::Group(group) => raw_type(&group.frame, world, from, to),
                    _ => {}
                }
            }
        }
        for page in document.pages() {
            raw_type(&page.frame, &world, start, start + to - from);
        }
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        for (offset, ch) in original[from..to]
            .char_indices()
            .filter(|(_, ch)| !ch.is_whitespace())
        {
            assert!(
                items
                    .iter()
                    .any(|item| item.range == (start + offset..start + offset + ch.len_utf8())),
                "{name}: {ch} at {offset} 必须保留真实逐字符 span"
            );
        }
        let id = store(items, source.len(), stats.foreign_ink);
        let mut previous = None;
        for (offset, _) in original[from..to]
            .char_indices()
            .filter(|(_, ch)| !ch.is_whitespace())
        {
            let caret = locate(id, start + offset).unwrap();
            if let Some((page, y, x)) = previous {
                assert!(
                    caret.page > page || caret.y_pt > y || caret.x_pt > x,
                    "{name}: caret order"
                );
            }
            previous = Some((caret.page, caret.y_pt, caret.x_pt));
        }
        let following = if name == "cursor-heading" {
            "ASCII:"
        } else if name == "heading-nested" {
            "嵌套后文"
        } else {
            "后正文"
        };
        let follow_offset = source.rfind(following).unwrap();
        fn sizes(frame: &Frame, needle: &str, out: &mut Vec<f64>) {
            for (_, item) in frame.items() {
                match item {
                    FrameItem::Text(text) if text.text.contains(needle) => {
                        out.push(text.size.to_pt())
                    }
                    FrameItem::Group(group) => sizes(&group.frame, needle, out),
                    _ => {}
                }
            }
        }
        let mut raw_sizes = Vec::new();
        let mut follow_sizes = Vec::new();
        for page in document.pages() {
            sizes(&page.frame, "=", &mut raw_sizes);
            sizes(&page.frame, following, &mut follow_sizes);
        }
        assert!(
            raw_sizes.iter().any(|size| (*size - 11.0).abs() < 0.01),
            "标题 raw 使用 11pt：{name}"
        );
        assert!(
            !follow_sizes.is_empty() && follow_sizes.iter().all(|size| (*size - 12.0).abs() < 0.01),
            "后文不残留标题大字号：{name}"
        );
        let follow_caret = locate(id, follow_offset).unwrap();
        let raw_caret = locate(id, start).unwrap();
        assert!(
            follow_caret.page > raw_caret.page || follow_caret.y_pt > raw_caret.y_pt,
            "标题不能与后文黏连：{name}"
        );
    }
}

#[test]
fn heading_projection_preserves_numbering_query_outline_and_nested_effect_once() {
    let (_, original, range) = sources()
        .into_iter()
        .find(|(name, _, _)| *name == "heading")
        .unwrap();
    for source in [original.clone(), expansion::projected(&original, range)] {
        let world = TypstWorld::new(source, None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (document, _) = super::super::formula_preview::extract(&document);
        let mut text = String::new();
        for page in document.pages() {
            expansion::visible_frame_text(&page.frame, &mut text);
        }
        assert!(text.contains("COUNT: 1"), "嵌套副作用只执行一次：{text}");
        assert!(
            text.contains("HEADINGS: 2"),
            "隐藏标题仍参与 query/outline：{text}"
        );
        assert!(
            text.replace(' ', "").contains("1.Next"),
            "后续 heading 编号继续：{text}"
        );
    }
    let original = "#set page(width: 360pt, height: 600pt, margin: 24pt)\n#set heading(numbering: \"1.\")\n#outline()\n= First\nBody.\n== Second\nBody.";
    let from = original.find("= First").unwrap();
    let projected = expansion::projected(original, Some((from, from + "= First".len())));
    for source in [original.to_owned(), projected] {
        let world = TypstWorld::new(source, None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (document, _) = super::super::formula_preview::extract(&document);
        let mut text = String::new();
        for page in document.pages() {
            expansion::visible_frame_text(&page.frame, &mut text);
        }
        assert!(
            text.replace(' ', "").contains("1.First"),
            "outline 保留标题条目和编号：{text}"
        );
        assert!(
            text.replace(' ', "").contains("1.1.Second"),
            "outline 保留层级：{text}"
        );
    }
}
