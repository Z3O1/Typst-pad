// 新输入空公式的真实 raw/SVG/停靠点，供实际按键端到端使用。
use super::*;
use crate::document_geometry::{locate, store};

pub(super) fn sources() -> Vec<expansion::ExpansionSource> {
    [
        ("empty-compact-base", "$$", false),
        ("empty-compact", "$$", true),
        ("empty-padded-base", "$  $", false),
        ("empty-padded", "$  $", true),
        ("empty-multiline-base", "$\n  \n$", false),
        ("empty-multiline", "$\n  \n$", true),
        ("empty-multiline-one-space-base", "$\n \n$", false),
        ("empty-multiline-one-space", "$\n \n$", true),
        ("empty-multiline-no-space-base", "$\n\n$", false),
        ("empty-multiline-no-space", "$\n\n$", true),
        ("empty-typed-base", "$x$", false),
        ("empty-typed", "$x$", true),
        ("empty-multiline-typed-base", "$\n  x\n$", false),
        ("empty-multiline-typed", "$\n  x\n$", true),
        ("empty-end-base", "正文 $$", false),
        ("empty-end", "正文 $$", true),
        ("empty-end-typed-base", "正文 $x$", false),
        ("empty-end-typed", "正文 $x$", true),
        ("empty-line-base", "正文\n\n$$", false),
        ("empty-line", "正文\n\n$$", true),
    ]
    .into_iter()
    .map(|(name, doc, expanded)| {
        let from = doc.find('$').unwrap();
        (name, doc.to_owned(), expanded.then_some((from, doc.len())))
    })
    .collect()
}

#[test]
fn new_empty_math_has_full_raw_delimiters_and_real_carets() {
    for (name, original, range) in sources()
        .into_iter()
        .filter(|(_, _, range)| range.is_some())
    {
        let (from, to) = range.unwrap();
        let source = expansion::projected(&original, range);
        let start = expansion::visible_start(&original, from, to);
        let world = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(name);
        let (document, _) = super::super::formula_preview::extract(&document);
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let raw_text = expansion::raw_blank_placeholders(&original[from..to]);
        for (offset, ch) in raw_text
            .char_indices()
            .filter(|(_, ch)| !ch.is_whitespace() || *ch == '\u{a0}')
        {
            assert!(
                items
                    .iter()
                    .any(|item| item.range == (start + offset..start + offset + ch.len_utf8())),
                "{name}: every visible raw character must keep its real span"
            );
        }
        let id = store(items, source.len(), stats.foreign_ink);
        assert!(locate(id, start).is_some(), "{name}: opening delimiter");
        assert!(
            locate(id, start + raw_text.len() - 1).is_some(),
            "{name}: closing delimiter"
        );
        if original[from..to].trim() == "$$" {
            assert!(
                locate(id, start + 1).unwrap().x_pt > locate(id, start).unwrap().x_pt,
                "two delimiters have distinct real input stops"
            );
        }
        let mut visible = String::new();
        for page in document.pages() {
            expansion::visible_frame_text(&page.frame, &mut visible);
        }
        assert!(
            visible.contains('$'),
            "{name}: raw must actually be visible"
        );
    }
}
