// 外部文档只读编辑探针：仅修改内存副本，不写源文件、PDF 或夹具。
use super::*;
use std::time::Instant;

fn text_anchor(source: &Source) -> usize {
    fn find(node: LinkedNode<'_>) -> Option<usize> {
        if node.kind() == SyntaxKind::Text && node.len() >= 9 {
            return Some(node.offset());
        }
        node.children().find_map(find)
    }
    find(LinkedNode::new(source.root())).expect("样本需要可插入的正文 Text 节点")
}

#[test]
#[ignore]
fn document_edit_performance() {
    let files = std::env::var_os("PERF_FILES").expect("PERF_FILES 必须指定只读样本文档路径列表");
    let rounds: usize = std::env::var("PERF_ROUNDS")
        .unwrap_or_else(|_| "12".into())
        .parse()
        .unwrap();
    assert!(rounds >= 7, "至少覆盖输入、删除、段落与撤销");
    let variety = std::env::var_os("PERF_VARIETY").is_some();
    for path in std::env::split_paths(&files) {
        let path = fs::canonicalize(path).unwrap();
        let bytes = fs::read(&path).unwrap();
        let original = String::from_utf8(bytes.clone()).unwrap();
        let file = path.to_string_lossy().to_string();
        let fonts = FontConfig::default();
        let initial = TypstWorld::new(original.clone(), Some(file.clone()), &fonts_dir(), &fonts);
        let anchor = text_anchor(&initial.source(initial.main()).unwrap());
        let mut source = original.clone();
        let mut known: Option<Vec<String>> = None;
        let mut held: Vec<String> = Vec::new();
        for round in 0..rounds {
            let edit = match round {
                0 => "initial",
                1..=3 => {
                    source.insert(anchor, '测');
                    "insert"
                }
                4 => {
                    source.replace_range(anchor..anchor + "测".len(), "");
                    "delete"
                }
                5 => {
                    source.insert_str(anchor, "\n\n测试段落\n\n");
                    "paragraph"
                }
                6 => {
                    source = original.clone();
                    "undo"
                }
                _ if variety => {
                    source = original.clone();
                    source.insert_str(anchor, &format!("测试{round}"));
                    "unique"
                }
                _ if round % 2 == 1 => {
                    source.insert(anchor, '测');
                    "insert"
                }
                _ => {
                    source.replace_range(anchor..anchor + "测".len(), "");
                    "delete"
                }
            };
            let start = Instant::now();
            let world = TypstWorld::new(source.clone(), Some(file.clone()), &fonts_dir(), &fonts);
            let world_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let result = typst::compile::<PagedDocument>(&world);
            let warnings = result.warnings.len();
            let document = result.output.unwrap_or_else(|errors| {
                panic!("样本或内存编辑不能编译：{file}，{} 条诊断", errors.len())
            });
            let compile_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let (items, stats) = crate::block_geometry::collect_geometry(&world, &document);
            let geometry_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let (pages, keys) =
                super::super::svg_cache::incremental_pages(document.pages(), known.as_deref());
            let svg_ms = start.elapsed().as_secs_f64() * 1000.0;
            let sent = pages.iter().filter(|page| page.is_some()).count();
            let start = Instant::now();
            let json = serde_json::to_string(&(&pages, &keys)).unwrap();
            let json_ms = start.elapsed().as_secs_f64() * 1000.0;
            let restored: Vec<_> = pages
                .iter()
                .enumerate()
                .map(|(i, page)| page.clone().unwrap_or_else(|| held[i].clone()))
                .collect();
            // 独立原始 SVG 导出作为 oracle，不让缓存自己证明自己。成本不计入产品分段。
            for (page, restored) in document.pages().iter().zip(&restored) {
                assert_eq!(
                    *restored,
                    typst_svg::svg(page, &SvgOptions::default()),
                    "增量产物必须与直接 SVG 导出一致"
                );
            }
            let start = Instant::now();
            let id = crate::document_geometry::store(items, source.len(), stats.foreign_ink);
            let store_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_ne!(id, 0);
            let start = Instant::now();
            crate::compile_commands::with_compiler_cache(|| ());
            let eviction_ms = start.elapsed().as_secs_f64() * 1000.0;
            let total_ms =
                world_ms + compile_ms + geometry_ms + svg_ms + json_ms + store_ms + eviction_ms;
            println!("EDITPERF file={} round={round} edit={edit} pages={} world_ms={world_ms:.2} compile_ms={compile_ms:.2} geometry_ms={geometry_ms:.2} svg_ms={svg_ms:.2} json_ms={json_ms:.2} store_ms={store_ms:.2} eviction_ms={eviction_ms:.2} total_ms={total_ms:.2} sent_pages={sent} payload_bytes={} warnings={warnings}", path.display(), document.pages().len(), json.len());
            let changed = restored
                .iter()
                .enumerate()
                .filter(|(i, page)| held.get(*i) != Some(*page))
                .count();
            println!(
                "EDITVISUAL file={} round={round} sent_pages={sent} changed_pages={changed}",
                path.display()
            );
            let rss = fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|status| {
                    status.lines().find_map(|line| {
                        line.strip_prefix("VmRSS:").and_then(|value| {
                            value.split_whitespace().next()?.parse::<usize>().ok()
                        })
                    })
                });
            println!(
                "EDITMEM round={round} rss_kib={}",
                rss.map_or_else(|| "na".into(), |value| value.to_string())
            );
            known = Some(keys);
            held = restored;
        }
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "只读样本在探针运行期间发生变化；本测试不写源文件"
        );
    }
}

// 分离磁盘依赖的读取、解析与摘要成本；与编辑探针使用相同本地样本。
#[test]
#[ignore]
fn dependency_source_performance() {
    let files = std::env::var_os("PERF_FILES").expect("PERF_FILES 指定只读样本路径列表");
    for path in std::env::split_paths(&files) {
        let path = fs::canonicalize(path).unwrap();
        let dependency = path.parent().unwrap().join("body.typ");
        let original = fs::read(&dependency).unwrap();
        let id =
            RootedPath::new(VirtualRoot::Project, VirtualPath::new("body.typ").unwrap()).intern();
        for round in 0..4 {
            let world = TypstWorld::new(
                fs::read_to_string(&path).unwrap(),
                Some(path.to_string_lossy().into()),
                &fonts_dir(),
                &FontConfig::default(),
            );
            let start = Instant::now();
            let text = fs::read_to_string(&dependency).unwrap();
            let disk_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let fresh = Source::new(id, text);
            std::hint::black_box(typst::utils::hash128(&fresh));
            let fresh_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let source = world.source(id).unwrap();
            std::hint::black_box(typst::utils::hash128(&source));
            let validated_ms = start.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(source.text().as_bytes(), original);
            println!("DEPSOURCEPERF file={} round={round} disk_ms={disk_ms:.3} fresh_ms={fresh_ms:.3} validated_ms={validated_ms:.3} bytes={}", path.display(), original.len());
        }
        assert_eq!(fs::read(dependency).unwrap(), original);
    }
}

#[test]
#[ignore]
fn world_component_performance() {
    let files = std::env::var_os("PERF_FILES").expect("PERF_FILES 指定只读样本路径列表");
    let fonts = FontConfig::default();
    for path in std::env::split_paths(&files) {
        let path = fs::canonicalize(path).unwrap();
        let src = fs::read_to_string(&path).unwrap();
        let _warm = TypstWorld::new(
            src.clone(),
            Some(path.to_string_lossy().into()),
            &fonts_dir(),
            &fonts,
        );
        for round in 0..3 {
            let start = Instant::now();
            let _fonts = cached_fonts(&fonts_dir(), &fonts.dirs);
            let font_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let _library = build_library(&fonts.families);
            let library_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let _root = resolve_project_root(&src, &path.to_string_lossy());
            let root_ms = start.elapsed().as_secs_f64() * 1000.0;
            let start = Instant::now();
            let _source = super::super::source_cache::cached_main_source(
                src.clone(),
                path.parent(),
                _warm.main(),
            );
            let source_ms = start.elapsed().as_secs_f64() * 1000.0;
            println!("WORLDPERF file={} round={round} fonts_ms={font_ms:.2} library_ms={library_ms:.2} root_ms={root_ms:.2} source_ms={source_ms:.2}", path.display());
        }
    }
}
