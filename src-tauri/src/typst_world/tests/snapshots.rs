// 主源快照、依赖更新与旧几何隔离，使用自建临时目录，不涉及外部样本写入。
use super::*;

#[test]
fn retained_world_and_geometry_survive_other_revisions_and_cache_eviction() {
    let original = "#set page(width: 220pt, height: 240pt)\n中文😀 $x^2$\n第二段";
    let first = TypstWorld::new(original.into(), None, &fonts_dir(), &FontConfig::default());
    let doc = typst::compile::<PagedDocument>(&first).output.unwrap();
    let (items, stats) = crate::block_geometry::collect_geometry(&first, &doc);
    let offset = original.find('中').unwrap();
    let id = crate::document_geometry::store(items, original.len(), stats.foreign_ink);
    let before = crate::document_geometry::locate(id, offset).unwrap();
    for source in [
        format!("// 前置😀注释\n{original}"),
        "#let =\n中文".into(),
        original.into(),
    ] {
        let second = TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        assert_eq!(second.source(second.main()).unwrap().text(), source);
        assert_eq!(first.source(first.main()).unwrap().text(), original);
        typst::comemo::evict(0);
        let after = crate::document_geometry::locate(id, offset).unwrap();
        assert_eq!(
            (after.page, after.x_pt, after.y_pt, after.offset),
            (before.page, before.x_pt, before.y_pt, before.offset)
        );
    }
    assert!(!typst_svg::svg(&doc.pages()[0], &SvgOptions::default()).is_empty());
}

#[test]
fn main_snapshot_reuse_does_not_cache_dependencies_or_cross_project_roots() {
    let temp = std::env::temp_dir().join(format!(
        "typst-pad-snapshot-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let a = temp.join("a");
    let b = temp.join("b");
    fs::create_dir_all(&a).unwrap();
    fs::create_dir_all(&b).unwrap();
    let source = "#include \"dep.typ\"\n#read(\"value.txt\")";
    fs::write(a.join("dep.typ"), "甲 $x^2$").unwrap();
    fs::write(b.join("dep.typ"), "乙 $y^2$").unwrap();
    fs::write(a.join("value.txt"), "alpha").unwrap();
    fs::write(b.join("value.txt"), "beta").unwrap();
    let compile_at = |dir: &Path| {
        let world = TypstWorld::new(
            source.into(),
            Some(dir.join("main.typ").to_string_lossy().into()),
            &fonts_dir(),
            &FontConfig::default(),
        );
        let doc = typst::compile::<PagedDocument>(&world).output.unwrap();
        doc.pages()
            .iter()
            .map(|page| typst_svg::svg(page, &SvgOptions::default()))
            .collect::<Vec<_>>()
    };
    let first = compile_at(&a);
    assert_ne!(first, compile_at(&b));
    assert_eq!(first, compile_at(&a));
    fs::write(a.join("dep.typ"), "丙 $z^2$").unwrap();
    assert_ne!(first, compile_at(&a));
    let second = compile_at(&a);
    fs::write(a.join("value.txt"), "gamma").unwrap();
    assert_ne!(second, compile_at(&a));
    fs::remove_dir_all(temp).unwrap();
}

#[test]
fn incremental_ast_matches_fresh_compile_and_error_positions() {
    let base = "#set page(width: 240pt, height: 300pt)\n#let square(x) = x*x\n= 标题\n中文😀 $square(2)$\n#pagebreak()\n尾页 $x^2$";
    for source in [
        base.to_string(),
        base.replace("中文", "中文测😀"),
        base.replace("中文", "新段落\n\n中文"),
        base.replace("square(2)", "unknown(2)"),
        base.replace("= 标题", "// 注释😀\n= 标题"),
        base.to_string(),
    ] {
        let incremental =
            TypstWorld::new(source.clone(), None, &fonts_dir(), &FontConfig::default());
        let mut fresh = TypstWorld::new(source, None, &fonts_dir(), &FontConfig::default());
        fresh.reset_main_source_for_test();
        let a = typst::compile::<PagedDocument>(&incremental).output;
        let b = typst::compile::<PagedDocument>(&fresh).output;
        match (a, b) {
            (Ok(a), Ok(b)) => assert_eq!(
                a.pages()
                    .iter()
                    .map(|page| typst_svg::svg(page, &SvgOptions::default()))
                    .collect::<Vec<_>>(),
                b.pages()
                    .iter()
                    .map(|page| typst_svg::svg(page, &SvgOptions::default()))
                    .collect::<Vec<_>>()
            ),
            (Err(a), Err(b)) => {
                let a = collect_diagnostics(&incremental, a, 0);
                let b = collect_diagnostics(&fresh, b, 0);
                assert_eq!(
                    serde_json::to_value(a).unwrap(),
                    serde_json::to_value(b).unwrap()
                );
            }
            _ => panic!("增量解析与完整解析的编译状态不一致"),
        }
    }
}

#[test]
fn shared_library_preserves_family_order_and_user_overrides() {
    let families = vec!["Libertinus Serif".into(), "Noto Serif CJK SC".into()];
    let shared = build_library(&families);
    assert!(Arc::ptr_eq(&shared, &build_library(&families)));
    let reverse = build_library(&families.into_iter().rev().collect::<Vec<_>>());
    assert_ne!(
        typst::utils::hash128(&shared),
        typst::utils::hash128(&reverse)
    );
    let source = "#set text(font: \"Libertinus Serif\")\nLatin $x^2$";
    let config = FontConfig::new(Some(vec!["DejaVu Sans".into()]), None);
    let first = TypstWorld::new(source.into(), None, &fonts_dir(), &FontConfig::default());
    let second = TypstWorld::new(source.into(), None, &fonts_dir(), &config);
    assert!(std::ptr::eq(first.book(), second.book()));
    let a = typst::compile::<PagedDocument>(&first).output.unwrap();
    let b = typst::compile::<PagedDocument>(&second).output.unwrap();
    assert_eq!(
        typst_svg::svg(&a.pages()[0], &SvgOptions::default()),
        typst_svg::svg(&b.pages()[0], &SvgOptions::default())
    );
}
