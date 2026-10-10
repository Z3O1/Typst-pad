use super::*;
use crate::document_geometry::{caret_for_item, locate, selection, store};

// 长公式预览：自然宽远超卡片/页面宽（长行）、高矩阵与嵌套分式/根号。
const LONG_LINE_FORMULA: &str =
    "$x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + x_9 + x_10 + x_11 + x_12 + x_13 + x_14 + x_15 + x_16 + x_17 + x_18 + x_19 + x_20 + x_21 + x_22 + x_23 + x_24 + x_25 + x_26$";
const TALL_MATRIX_FORMULA: &str = "$mat(a_11, a_12; a_21, a_22; a_31, a_32; a_41, a_42; a_51, a_52; a_61, a_62; a_71, a_72; a_81, a_82; a_91, a_92; a_101, a_102)$";
const NESTED_FRACTION_FORMULA: &str = "$sqrt(frac(1 + x, 2 - y) + frac(3, sqrt(5)))$";
// 靠底公式：把公式源码推到页面底部，展开后气泡必须翻到源码上方（flip）。
const BOTTOM_FORMULA: &str = "$y + z$";

/// 用展开投影编译并把公式帧作为预览抽出，供长公式回归复用。
fn formula_preview_of(
    doc: &str,
    formula: &str,
) -> Option<super::super::formula_preview::FormulaPreview> {
    let from = doc.find(formula).unwrap();
    let src = projected(doc, Some((from, from + formula.len())));
    let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
    let document = typst::compile::<PagedDocument>(&world).output.unwrap();
    super::super::formula_preview::extract(&document).1
}

fn expansion_sample() -> String {
    "#set page(width: 360pt, height: 260pt, margin: 24pt)\n#set text(size: 12pt)\n正文 $a + b$ 中间 #text(fill: red)[嵌套 $c + d$ 与 #strong[粗体]] 后文。\n\n混合公式 $a + #sym.beta$。\n\n#let formula = $c + d$; 声明输出 #formula。\n\n#let helper = {\n let value = 1\n\n // 代码空白\n value\n};\n\n#block[\n多行脚本正文。\n第二行中文与 😀。\n]\n\n#pagebreak()\n第二页正文。\n".into()
}

type ExpansionSource = (&'static str, String, Option<(usize, usize)>);

fn expansion_sources() -> Vec<ExpansionSource> {
    let base = expansion_sample();
    let edited = base.replace("$a + b$", "$a + b + z$");
    let block_edited = base.replace("多行脚本正文。", "多行脚本正文。续");
    let display = base.replace("$a + b$", "$ \na + b\n $");
    let number = base.replace("$a + b$", "$998244353$");
    let fraction = base.replace("$a + b$", "$frac(1, sqrt(2))$");
    let counter_expression = "#context { c.step(); [SEEN] }";
    let counter = format!("{base}\n#let c = counter(\"preview-once\")\n{counter_expression}\n#context [COUNT: #c.get().first()]\n");
    let hidden = format!("#show raw: it => []\n{base}\n普通 raw `USER-RAW`。\n");
    let replaced = format!("#show raw: it => [USER-REPLACED]\n{base}\n普通 raw `USER-RAW`。\n");
    let long_line = base.replace("$a + b$", LONG_LINE_FORMULA);
    let tall_matrix = base.replace("$a + b$", TALL_MATRIX_FORMULA);
    let nested_fraction = base.replace("$a + b$", NESTED_FRACTION_FORMULA);
    let bottom = "#set page(width: 360pt, height: 260pt, margin: 24pt)\n#set text(size: 12pt)\n#v(160pt)\n正文 $y + z$ 结束。\n\n#pagebreak()\n第二页。".to_string();
    [
        ("base", base.clone(), None),
        ("math", base.clone(), Some("$a + b$")),
        ("number-base", number.clone(), None),
        ("number", number, Some("$998244353$")),
        ("fraction-base", fraction.clone(), None),
        ("fraction", fraction, Some("$frac(1, sqrt(2))$")),
        ("display-base", display.clone(), None),
        ("display-math", display, Some("$ \na + b\n $")),
        ("counter-base", counter.clone(), None),
        ("counter", counter, Some(counter_expression)),
        ("raw-hidden-base", hidden.clone(), None),
        ("raw-hidden-math", hidden, Some("$a + b$")),
        ("raw-replaced-base", replaced.clone(), None),
        ("raw-replaced-math", replaced, Some("$a + b$")),
        ("math-deleted", base.replace("$a + b$", ""), None),
        ("edited-base", edited.clone(), None),
        ("math-edited", edited, Some("$a + b + z$")),
        ("nested-math", base.clone(), Some("$c + d$")),
        (
            "outer",
            base.clone(),
            Some("#text(fill: red)[嵌套 $c + d$ 与 #strong[粗体]]"),
        ),
        ("strong", base.clone(), Some("#strong[粗体]")),
        ("embedded-math", base.clone(), Some("$a + #sym.beta$")),
        (
            "math-declaration",
            base.clone(),
            Some("#let formula = $c + d$;"),
        ),
        (
            "code-block",
            base.clone(),
            Some("#let helper = {\n let value = 1\n\n // 代码空白\n value\n};"),
        ),
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
        ("long-line-base", long_line.clone(), None),
        ("long-line", long_line, Some(LONG_LINE_FORMULA)),
        ("tall-matrix-base", tall_matrix.clone(), None),
        ("tall-matrix", tall_matrix, Some(TALL_MATRIX_FORMULA)),
        ("nested-fraction-base", nested_fraction.clone(), None),
        (
            "nested-fraction",
            nested_fraction,
            Some(NESTED_FRACTION_FORMULA),
        ),
        ("bottom-formula-base", bottom.clone(), None),
        ("bottom-formula", bottom, Some(BOTTOM_FORMULA)),
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
    let raw = if expanded_block(text) {
        format!("```\n{text}\n```")
    } else {
        format!("` {text} `")
    };
    let declaration = declaration_prefix(text);
    let raw = styled_raw_kind(&raw, text.starts_with('$') && text.ends_with('$'));
    let preview = expansion_preview(text, expanded_block(text), true);
    format!("{}{declaration}{raw}{preview}{}", &doc[..from], &doc[to..])
}

fn expanded_block(text: &str) -> bool {
    text.contains('\n') || (text.starts_with("$ ") && text.ends_with(" $"))
}

pub(super) fn declaration_prefix(text: &str) -> String {
    if ["#let ", "#set ", "#show ", "#import "]
        .iter()
        .any(|prefix| text.starts_with(prefix))
    {
        format!("{text}\n")
    } else {
        String::new()
    }
}

fn preview_start(doc: &str, from: usize, to: usize) -> usize {
    let text = &doc[from..to];
    visible_start(doc, from, to)
        + text.len()
        + if expanded_block(text) { 4 } else { 2 }
        + expansion_style()["tail"].as_str().unwrap().len()
        + expansion_style()[if expanded_block(text) {
            "previewBlockHead"
        } else {
            "previewInlineHead"
        }]
        .as_str()
        .unwrap()
        .len()
}

fn visible_start(doc: &str, from: usize, to: usize) -> usize {
    let text = &doc[from..to];
    from + declaration_prefix(text).len()
        + expansion_style()[if text.starts_with('$') && text.ends_with('$') {
            "formulaHead"
        } else {
            "head"
        }]
        .as_str()
        .unwrap()
        .len()
        + if expanded_block(text) { 4 } else { 2 }
}

#[test]
fn cursor_expansion_preserves_full_output_and_raw_character_locations() {
    for (name, doc, range) in expansion_sources() {
        let src = projected(&doc, range);
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(name);
        let (document, formula_preview) = super::super::formula_preview::extract(&document);
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
            let start = visible_start(&doc, from, to);
            assert_eq!(
                formula_preview.is_some(),
                text.starts_with('$'),
                "只有公式有预览：{name}"
            );
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

fn visible_frame_text(frame: &Frame, output: &mut String) {
    for (_, item) in frame.items() {
        match item {
            FrameItem::Text(text) => output.push_str(&text.text),
            FrameItem::Group(group) => visible_frame_text(&group.frame, output),
            _ => {}
        }
    }
}

#[test]
fn formula_center_clicks_include_fraction_bars_and_numeric_tokens() {
    for formula in ["$998244353$", "$frac(1, sqrt(2))$", "$a + b$"] {
        let world = TypstWorld::new(
            format!("前文 {formula} 后文"),
            None,
            &fonts_dir(),
            &FontConfig::default(),
        );
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let region = items
            .iter()
            .find(|item| item.kind == crate::block_geometry::PlacedItemKind::Formula)
            .expect("公式区域必须来自真实布局")
            .clone();
        let id = store(
            items,
            world.source(world.main()).unwrap().text().len(),
            stats.foreign_ink,
        );
        let hit = crate::document_geometry::hit_test(
            id,
            region.page,
            (region.rect.min.x + region.rect.max.x).to_pt() / 2.0,
            (region.rect.min.y + region.rect.max.y).to_pt() / 2.0,
        )
        .unwrap();
        assert_eq!(hit.is_whitespace, Some(false), "公式内部不是段落空白");
        assert!(hit.offset > region.range.start && hit.offset < region.range.end);
    }
}

#[test]
fn floating_formula_preview_does_not_move_document_content() {
    let raw = styled_raw_kind("` $998244353$ `", true);
    let base = format!("正文 {raw} 后文");
    let expanded = format!(
        "正文 {raw}{} 后文",
        expansion_preview("$998244353$", false, true)
    );
    let after_a = base.find("后文").unwrap();
    let after_b = expanded.find("后文").unwrap();
    let a = compile(base, None, &fonts_dir(), &FontConfig::default());
    let b = compile(expanded, None, &fonts_dir(), &FontConfig::default());
    assert!(a.ok && b.ok);
    let a_caret = locate(a.geometry_id.unwrap(), after_a).unwrap();
    let b_caret = locate(b.geometry_id.unwrap(), after_b).unwrap();
    assert_eq!(
        (a_caret.page, a_caret.x_pt, a_caret.y_pt),
        (b_caret.page, b_caret.x_pt, b_caret.y_pt),
        "浮动预览不能移动正文"
    );
    assert!(b.formula_preview.is_some());
}

#[test]
fn long_formula_preview_keeps_full_natural_frame() {
    // 页面正文宽 = 360 - 2×24 = 312pt；长行预览自然宽远超它，证明未被页面折行截断。
    let long_line = format!("前文 {LONG_LINE_FORMULA} 后文");
    let preview = formula_preview_of(&long_line, LONG_LINE_FORMULA).expect("长行公式有预览");
    assert!(
        preview.width_pt > 400.0,
        "长行预览不应被页面宽度截断：{}",
        preview.width_pt
    );

    // 高矩阵：多行高度远超单行，证明完整帧（含全部行）而非只取首行。
    let matrix = format!("前文 {TALL_MATRIX_FORMULA} 后文");
    let preview = formula_preview_of(&matrix, TALL_MATRIX_FORMULA).expect("矩阵公式有预览");
    assert!(
        preview.height_pt > 60.0,
        "高矩阵预览应含多行：{}",
        preview.height_pt
    );

    // 嵌套分式/根号：高度超过单行正文字高，分式线与根号都来自同次完整帧。
    let fraction = format!("前文 {NESTED_FRACTION_FORMULA} 后文");
    let preview = formula_preview_of(&fraction, NESTED_FRACTION_FORMULA).expect("嵌套分式有预览");
    assert!(
        preview.height_pt > 15.0,
        "分式/根号预览应高于单行：{}",
        preview.height_pt
    );
}

#[test]
fn source_preview_executes_expression_side_effects_exactly_once() {
    for (setup, expression, after) in [
        ("#let x = 0", "#(x = x + 1)", "RESULT:#x"),
        (
            "#let c = counter(\"once\")",
            "#context { c.step(); [SEEN] }",
            "#context [RESULT:#c.get().first()]",
        ),
    ] {
        let original = format!("{setup}\n{expression}\n{after}");
        let from = original.find(expression).unwrap();
        let src = projected(&original, Some((from, from + expression.len())));
        let world = TypstWorld::new(src, None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let mut visible = String::new();
        for page in document.pages() {
            visible_frame_text(&page.frame, &mut visible);
        }
        assert!(
            visible.contains("RESULT:1"),
            "预览不应丢失或重复原表达式副作用：{visible}"
        );
    }
}

#[test]
fn nested_error_raw_recovers_only_the_markup_child() {
    let source = "BEFORE #block[CONTENT #missing()] AFTER";
    let world = TypstWorld::new(source.into(), None, &fonts_dir(), &FontConfig::default());
    assert!(typst::compile::<PagedDocument>(&world).output.is_err());

    let recovered = "BEFORE #block[CONTENT ` #missing() `] AFTER";
    let world = TypstWorld::new(recovered.into(), None, &fonts_dir(), &FontConfig::default());
    let document = typst::compile::<PagedDocument>(&world).output.unwrap();
    let mut visible = String::new();
    for page in document.pages() {
        visible_frame_text(&page.frame, &mut visible);
    }
    assert!(
        visible.contains("CONTENT"),
        "normal parent content remains rendered"
    );
    assert!(
        visible.contains("#missing()"),
        "only the failing child is raw"
    );
    assert!(
        !visible.contains("#block"),
        "normal outer call is not expanded"
    );
    assert!(visible.contains("BEFORE") && visible.contains("AFTER"));

    let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
    let id = store(items, recovered.len(), stats.foreign_ink);
    let start = recovered.find("#missing()").unwrap();
    for offset in start..start + "#missing()".len() {
        assert!(
            locate(id, offset).is_some(),
            "recovered child remains editable: {offset}"
        );
    }
}

#[test]
fn changed_read_dependency_can_fail_original_while_raw_expansion_still_renders() {
    let temp = std::env::temp_dir().join(format!(
        "typst-pad-expansion-dependency-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&temp).unwrap();
    let path = Some(temp.join("main.typ").to_string_lossy().into_owned());
    let expression = "#assert(read(\"value.txt\") == \"valid\")";
    let source = format!("BEFORE {expression} AFTER");
    // 错误回退只显示 raw，不执行失败的表达式或预览；对应前端 preserveDeclaration:false。
    let raw = format!("BEFORE {} AFTER", styled_raw(&format!("` {expression} `")));
    let compile = |input: &str| {
        let world = TypstWorld::new(
            input.into(),
            path.clone(),
            &fonts_dir(),
            &FontConfig::default(),
        );
        typst::compile::<PagedDocument>(&world).output
    };
    fs::write(temp.join("value.txt"), "valid").unwrap();
    assert!(compile(&source).is_ok());
    assert!(compile(&raw).is_ok());
    fs::write(temp.join("value.txt"), "changed").unwrap();
    let errors = compile(&source).unwrap_err();
    assert!(
        errors
            .iter()
            .any(|error| error.message.contains("assertion failed")),
        "unchanged main source must report the new dependency failure: {errors:?}"
    );
    let projected = compile(&raw).unwrap();
    let mut visible = String::new();
    for page in projected.pages() {
        visible_frame_text(&page.frame, &mut visible);
    }
    assert!(visible.contains("BEFORE") && visible.contains("AFTER"));
    assert!(visible.contains(expression), "raw is still editable source");
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn styled_source_lines_wrap_at_spaces_with_original_caret_locations() {
    let line = "parameter_name: value ".repeat(24);
    let text = format!("#block[\n{line}\n]");
    let source = format!(
        "#set page(width: 240pt, height: 260pt, margin: 24pt)\n{}",
        styled_raw(&format!("```\n{text}\n```"))
    );
    let world = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
    let document = typst::compile::<PagedDocument>(&world).output.unwrap();
    let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
    let start = source.find(&line).unwrap();
    let on_line: Vec<_> = items
        .iter()
        .filter(|item| item.range.start >= start && item.range.end <= start + line.len())
        .collect();
    let rows: HashSet<_> = on_line
        .iter()
        .map(|item| (item.page, item.baseline_pt.to_bits()))
        .collect();
    assert!(rows.len() > 1, "展开行应由 Typst 按实际段宽自然折行");
    assert!(
        on_line.iter().all(|item| item.rect.max.x.to_pt() <= 216.01),
        "有空格断点的长行不应溢出正文宽度"
    );
    let id = store(items, source.len(), stats.foreign_ink);
    for (offset, _) in line.char_indices().filter(|(_, ch)| !ch.is_whitespace()) {
        assert!(
            locate(id, start + offset).is_some(),
            "折行后仍须保留原始字符停靠点：{offset}"
        );
    }
}

#[test]
fn expansion_panel_has_readable_type_spacing_and_cross_page_carets() {
    fn check_type(frame: &Frame) {
        for (_, item) in frame.items() {
            match item {
                FrameItem::Text(text) => {
                    assert_eq!(text.size.to_pt(), 11.0, "展开字号不继承用户正文");
                    assert!(
                        matches!(
                            text.font.info().family.as_str(),
                            "DejaVu Sans Mono" | "Noto Serif CJK SC"
                        ),
                        "展开使用固定字体：{}",
                        text.font.info().family
                    );
                }
                FrameItem::Group(group) => check_type(&group.frame),
                _ => {}
            }
        }
    }
    for formula in [false, true] {
        let line = if formula {
            "a + b + c"
        } else {
            "// 源码 source"
        };
        let text = format!(
            "{}\n{}{}",
            if formula { "$" } else { "#block[" },
            format!("{line}\n").repeat(24),
            if formula { "$" } else { "]" }
        );
        let source = format!(
            "#set page(width: 240pt, height: 180pt, margin: 24pt)\n#set text(size: 40pt)\n{}",
            styled_raw_kind(&format!("```\n{text}\n```"), formula)
        );
        let world = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        assert!(document.pages().len() > 1, "面板必须可跨页");
        for page in document.pages() {
            check_type(&page.frame);
        }
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let start = source.find(&text).unwrap();
        let end = start + text.len();
        let visible: Vec<_> = items
            .iter()
            .filter(|item| item.range.start >= start && item.range.end <= end)
            .collect();
        assert!(
            visible
                .iter()
                .all(|item| item.rect.min.x.to_pt() >= 32.9 && item.rect.max.x.to_pt() <= 207.1),
            "字形保留面板左右内距"
        );
        let mut rows: Vec<_> = visible
            .iter()
            .map(|item| (item.page, item.baseline_pt))
            .collect();
        rows.sort_by(|a, b| a.partial_cmp(b).unwrap());
        rows.dedup();
        for pair in rows.windows(2).filter(|pair| pair[0].0 == pair[1].0) {
            let gap = pair[1].1 - pair[0].1;
            assert!((15.0..19.0).contains(&gap), "真实行距应舒展但不松散：{gap}");
        }
        let id = store(items, source.len(), stats.foreign_ink);
        for (offset, ch) in text.char_indices().filter(|(_, ch)| !ch.is_whitespace()) {
            let caret = locate(id, start + offset).expect("跨页面板每个原始字符必须可停靠");
            assert!(
                (10.0..14.0).contains(&caret.height_pt),
                "可读光标高度：{ch}"
            );
        }
        let first = locate(id, start).unwrap();
        let last = locate(id, end - 1).unwrap();
        assert!(last.page > first.page, "首行与末行使用各自页面的真实几何");
    }
}

#[test]
fn expansion_is_scoped_away_from_user_show_raw_rules() {
    for rule in [
        "it => []",
        "it => [USER-REPLACED]",
        "it => box(fill: red, it)",
        "set text(size: 40pt, fill: red, weight: 700, style: \"italic\", tracking: 2pt)",
    ] {
        let original =
            format!("#set text(size: 12pt)\n#show raw: {rule}\n正文 $a + b$ 后文 `USER-RAW`。");
        let from = original.find("$a").unwrap();
        let to = original[from..].find("$ 后文").unwrap() + from + 1;
        let src = projected(&original, Some((from, to)));
        let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &FontConfig::default());
        let document = typst::compile::<PagedDocument>(&world).output.expect(rule);
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let id = store(items, src.len(), stats.foreign_ink);
        let start = visible_start(&original, from, to);
        for (offset, ch) in original[from..to]
            .char_indices()
            .filter(|(_, ch)| !ch.is_whitespace())
        {
            let caret = locate(id, start + offset).expect("用户 raw 规则不能隐藏展开源码字形");
            assert!(
                caret.height_pt < 15.0,
                "局部字号不应被用户 raw 样式覆盖：{rule}:{ch}"
            );
        }
        if rule == "it => []" || rule == "it => [USER-REPLACED]" {
            assert!(
                locate(id, src.find("USER-RAW").unwrap()).is_none(),
                "局部规则不能泄漏到用户 raw"
            );
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
        let (document, formula_preview) = super::super::formula_preview::extract(&document);
        let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
        let carets: Vec<_> = items
            .iter()
            .map(|item| caret_for_item(item, item.range.start))
            .collect();
        let formula_points: Vec<_> = items
            .iter()
            .filter(|item| item.kind == crate::block_geometry::PlacedItemKind::Formula)
            .map(|item| {
                (
                    item.page,
                    (item.rect.min.x + item.rect.max.x).to_pt() / 2.0,
                    (item.rect.min.y + item.rect.max.y).to_pt() / 2.0,
                )
            })
            .collect();
        let id = store(items, src.len(), stats.foreign_ink);
        let formula_hits: Vec<_> = formula_points.into_iter().map(|(page,x_pt,y_pt)| serde_json::json!({ "page":page, "xPt":x_pt, "yPt":y_pt, "caret":crate::document_geometry::hit_test(id,page,x_pt,y_pt).unwrap() })).collect();
        let queries: Vec<_> = src
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(src.len()))
            .map(|offset| serde_json::json!({ "offset": offset, "caret": locate(id, offset) }))
            .collect();
        let range = range.map(|(from, to)| serde_json::json!({ "from": original[..from].encode_utf16().count(), "to": original[..to].encode_utf16().count(), "renderedFrom": src[..visible_start(&original, from, to)].encode_utf16().count(), "previewFrom": if original[from..to].starts_with('$') { Some(src[..preview_start(&original, from, to)].encode_utf16().count()) } else { None } }));
        let pages: Vec<_> = document.pages().iter().map(svg_for_page).collect();
        let mut visible_text = String::new();
        for page in document.pages() {
            visible_frame_text(&page.frame, &mut visible_text);
        }
        println!(
            "EXPANSIONFIXTURE:{}",
            serde_json::json!({ "name": name, "doc": src, "original": original, "range": range, "pages": pages, "visibleText": visible_text, "formulaPreview": formula_preview, "formulaHits": formula_hits, "carets": carets, "cursorQueries": queries, "selectionQuads": selection(id, 0, src.len()) })
        );
    }
}
