// 可复现的分段性能探针；忽略测试不作为 CI 时间阈值门禁。
use super::*;
use std::time::Instant;

#[test]
#[ignore]
fn document_performance() {
    let sizes = std::env::var("PERF_PAGES").unwrap_or_else(|_| "1,10,50,100".into());
    for count in sizes.split(',').map(|n| n.parse::<usize>().unwrap()) {
        let mut source = String::from("#set page(width: 595pt, height: 842pt, margin: 40pt)\n");
        for page in 0..count {
            if page > 0 {
                source.push_str("#pagebreak()\n");
            }
            source.push_str("版本 A\n\n");
            for _ in 0..14 {
                source.push_str(
                    "中文排版性能 English office $x^2 + y^2 = z^2$。重复正文与字形。\n\n",
                );
            }
            source.push_str("#table(columns: 3, [甲], [乙], [丙], [1], [2], [3])\n");
        }
        let fonts = FontConfig::default();
        let mut known: Option<Vec<String>> = None;
        let mut held: Vec<String> = Vec::new();
        for round in 0..4 {
            let src = source.replacen("版本 A", &format!("版本 {round}"), 1);
            let start = Instant::now();
            let world = TypstWorld::new(src.clone(), None, &fonts_dir(), &fonts);
            let world_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let document = typst::compile::<PagedDocument>(&world).output.unwrap();
            let compile_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
            let geometry_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let delta =
                super::super::svg_cache::incremental_pages(document.pages(), known.as_deref());
            let delta_svg_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let delta_json = serde_json::to_string(&delta).unwrap();
            let delta_json_ms = start.elapsed().as_secs_f64() * 1000.0;
            let sent = delta.0.iter().filter(|page| page.is_some()).count();
            let restored: Vec<_> = delta
                .0
                .iter()
                .enumerate()
                .map(|(i, page)| page.clone().unwrap_or_else(|| held[i].clone()))
                .collect();
            known = Some(delta.1);
            let start = Instant::now();
            let pages: Vec<_> = document.pages().iter().map(svg_for_page).collect();
            let svg_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let json = serde_json::to_string(&pages).unwrap();
            let json_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(restored, pages);
            held = restored;
            let start = Instant::now();
            let id = crate::document_geometry::store(items, src.len(), stats.foreign_ink);
            let store_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            for _ in 0..100 {
                std::hint::black_box(crate::document_geometry::hit_test(id, count, 60.0, 80.0));
            }
            let hit_us = start.elapsed().as_secs_f64() * 1_000_000.0 / 100.0;
            println!("DOCPERF pages={} round={round} world_ms={world_ms:.2} compile_ms={compile_ms:.2} geometry_ms={geometry_ms:.2} svg_ms={svg_ms:.2} store_ms={store_ms:.2} hit_us={hit_us:.2} svg_bytes={} json_ms={json_ms:.2} json_bytes={} delta_svg_ms={delta_svg_ms:.2} delta_json_ms={delta_json_ms:.2} delta_bytes={} sent_pages={sent}", document.pages().len(), pages.iter().map(String::len).sum::<usize>(), json.len(), delta_json.len());
        }
    }
}
