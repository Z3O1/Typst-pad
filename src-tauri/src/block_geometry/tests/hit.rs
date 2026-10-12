// 点击定位与命中几何：`pick_hit` 纯函数、真实排版下的边界命中、多窗口几何编号校验。
use super::*;

// 块命中缓存是进程级单份；这些测试串行写入，避免互相替换快照。
static HIT_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn store_hit_geometry_translates_ligature_stops_with_ranges() {
    let _guard = HIT_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let mut mismatches = Vec::new();
    for doc_start in [0, 100] {
        let mut ligature = item(1, doc_start..doc_start + 3, 0.0, 10.0, 30.0, 20.0);
        ligature.caret_stops = Some(
            (doc_start..=doc_start + 3)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        let id = store_hit_geometry(vec![ligature], doc_start);
        for offset in 0..=3 {
            let hit = hit_test(0, 3, 1, offset as f64 * 10.0, 15.0, Some(id));
            eprintln!("SYNTHETIC doc_start={doc_start} expected={offset} actual={hit:?}");
            if hit != Some(offset) {
                mismatches.push((doc_start, offset, hit));
            }
        }
        let replacement = store_hit_geometry(Vec::new(), doc_start);
        assert_ne!(id, replacement);
        assert_eq!(hit_test(0, 3, 1, 10.0, 15.0, Some(id)), None);
    }
    assert!(mismatches.is_empty(), "{mismatches:?}");
}

#[test]
fn compile_blocks_ligature_hits_use_user_document_bytes() {
    let _guard = HIT_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let fonts_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
    let font_config = FontConfig::default();
    let doc = "#set text(font: \"Libertinus Serif\")\noffice 中文 plain\n";
    let mut mismatches = Vec::new();
    for prefix in ["", "#let prefix = [前缀😀]\n"] {
        let src = format!("{prefix}{doc}");
        let output = compile_blocks(
            src.clone(),
            prefix.len(),
            None,
            &fonts_dir,
            &font_config,
            371.25,
            None,
            None,
        );
        assert!(output.ok, "{:?}", output.diagnostics);
        assert!(output.geometry_id > 0);

        // 与块编译同尺寸的真实帧作物理坐标 oracle；不使用缓存里的字节坐标推导期望值。
        let margin_pt = output.page_width_pt * (70.87 / crate::typst_world::A4_WIDTH_PT);
        let injected = format!(
            "#set page(width: {:.2}pt, height: auto, margin: {margin_pt:.2}pt)\n",
            output.page_width_pt
        );
        let doc_start = injected.len() + prefix.len();
        let world = TypstWorld::new(format!("{injected}{src}"), None, &fonts_dir, &font_config);
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (items, _) = collect_geometry(&world, &document);
        let word_start = doc.find("office").unwrap();
        let word_end = word_start + "office".len();
        let block = output
            .blocks
            .iter()
            .find(|block| block.start <= word_start && block.end >= word_end)
            .expect("office 必须有真实块几何");
        assert!(block.found && !block.svg.is_empty());
        let ligature = items
            .iter()
            .find(|item| {
                item.range.start >= doc_start + word_start
                    && item.range.end <= doc_start + word_end
                    && item.caret_stops.is_some()
            })
            .expect("Libertinus Serif 必须形成 office 连字");
        let stops = ligature.caret_stops.as_ref().unwrap();
        assert!(stops.len() >= 3);
        for (index, &absolute) in stops.iter().enumerate() {
            let point = ligature.caret_start
                + (ligature.caret_end - ligature.caret_start)
                    * (index as f64 / (stops.len() - 1) as f64)
                + ligature.caret_vector / 2.0;
            let expected = absolute - doc_start;
            let hit = hit_test(
                block.start,
                block.end,
                ligature.page,
                point.x.to_pt(),
                point.y.to_pt(),
                Some(output.geometry_id),
            );
            eprintln!(
                "COMPILE_BLOCKS doc_offset={} absolute={absolute} expected={expected} actual={hit:?}",
                prefix.len()
            );
            if hit != Some(expected) {
                mismatches.push((prefix.len(), expected, hit));
            }
        }

        // 普通拉丁字形与 CJK 仍按完整 UTF-8 字节区间命中左右端点。
        for text in ["中文", "plain"] {
            let start = doc_start + doc.find(text).unwrap();
            let end = start + text.len();
            let glyphs: Vec<_> = items
                .iter()
                .filter(|item| item.range.start >= start && item.range.end <= end)
                .collect();
            assert!(!glyphs.is_empty());
            for glyph in glyphs {
                assert!(glyph.caret_stops.is_none());
                for (point, absolute) in [
                    (glyph.caret_start, glyph.range.start),
                    (glyph.caret_end, glyph.range.end),
                ] {
                    let point = point + glyph.caret_vector / 2.0;
                    assert_eq!(
                        hit_test(
                            glyph.range.start - doc_start,
                            glyph.range.end - doc_start,
                            glyph.page,
                            point.x.to_pt(),
                            point.y.to_pt(),
                            Some(output.geometry_id),
                        ),
                        Some(absolute - doc_start)
                    );
                }
            }
        }
        assert_eq!(
            hit_test(
                block.start,
                block.end,
                1,
                f64::NAN,
                0.0,
                Some(output.geometry_id)
            ),
            None
        );
        let replacement = store_hit_geometry(Vec::new(), doc_start);
        assert_ne!(replacement, output.geometry_id);
        assert_eq!(
            hit_test(
                block.start,
                block.end,
                1,
                block.x_pt,
                block.y_pt,
                Some(output.geometry_id)
            ),
            None
        );
    }
    assert!(mismatches.is_empty(), "{mismatches:?}");
}

/// **命中测试的纯逻辑**（合成几何，不依赖编译）：
/// 横向按字形的左右半决定"光标在字前还是字后"，点的位置落在行外时先选最近的行。
#[test]
fn pick_hit_chooses_the_clicked_glyph() {
    // 一行三个 CJK 字（各 3 字节）：0..3 / 3..6 / 6..9，x = 0..10 / 10..20 / 20..30
    // 第二行：9..12 / 12..15，y = 30..40
    let items = vec![
        item(1, 0..3, 0.0, 10.0, 10.0, 20.0),
        item(1, 3..6, 10.0, 10.0, 20.0, 20.0),
        item(1, 6..9, 20.0, 10.0, 30.0, 20.0),
        item(1, 9..12, 0.0, 30.0, 10.0, 40.0),
        item(1, 12..15, 10.0, 30.0, 20.0, 40.0),
        // 别的页 / 别的块：都不该被选中
        item(2, 0..3, 0.0, 10.0, 10.0, 20.0),
        item(1, 100..103, 0.0, 10.0, 10.0, 20.0),
    ];
    let hit = |x: f64, y: f64| pick_hit(&items, 0, 15, 1, Abs::pt(x), Abs::pt(y));
    // 第一行：左半 → 字前，右半 → 字后
    assert_eq!(hit(2.0, 15.0), Some(0), "第一个字左半 → 偏移 0");
    assert_eq!(
        hit(8.0, 15.0),
        Some(3),
        "第一个字右半 → 偏移 3（第二个字之前）"
    );
    assert_eq!(hit(25.0, 15.0), Some(9), "第三个字右半 → 偏移 9（= 行尾）");
    // 行外：右侧空白 → 行尾；左侧空白 → 行首
    assert_eq!(hit(200.0, 15.0), Some(9), "点在这一行右边很远 → 行尾");
    assert_eq!(hit(-50.0, 15.0), Some(0), "点在这一行左边很远 → 行首");
    // 第二行（y 决定选哪一行）
    assert_eq!(hit(2.0, 35.0), Some(9), "第二行行首");
    assert_eq!(hit(15.0, 35.0), Some(15), "第二行第二个字");
    // 块之外的项不参与：第二个块的区间不许被点出来
    assert_eq!(
        pick_hit(&items, 0, 9, 1, Abs::pt(2.0), Abs::pt(15.0)),
        Some(0)
    );
    let outside = pick_hit(&items, 1000, 1003, 1, Abs::pt(2.0), Abs::pt(15.0));
    assert_eq!(outside, None, "块区间外没有任何字形 → None");
    assert_eq!(
        pick_hit(&items, 0, 15, 9, Abs::pt(2.0), Abs::pt(15.0)),
        None,
        "没有这一页 → None"
    );
}
