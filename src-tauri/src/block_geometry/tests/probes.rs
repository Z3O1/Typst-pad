// **按需跑的探针**（全部 `#[ignore]`）：导出几何/夹具/dump 给浏览器验收用，不进日常 `cargo test`。
use super::*;

/// **场景集**：写作模式要覆盖的文档形态（只用于按需导出的真实产物夹具；常驻测试不跑这些）。
/// 见 `scripts/browser-check/writing-mode-scenes.mjs`。同上有意写成单行字面量。
const SCENE_DOCS: &[(&str, &str)] = &[
    (
        "标题层级",
        "= 一级标题\n\n一级标题下的段落。\n\n== 二级标题\n\n二级标题下的段落。\n\n=== 三级标题\n\n三级标题下的段落，用来对比三级字号的梯度。\n",
    ),
    (
        "中文长段落",
        "= 长段落\n\n排版是引擎算出来的：同一段文字在不同宽度下的断行位置、行末的伸缩、标点前后的留白，都由引擎的行断算法决定，而不是浏览器说了算。这一段故意写得很长，用来观察写作模式下的切片是不是把好几行都完整切进来，以及相邻块之间的间距有没有被正确分到两块里。再补一句收尾，让这一段至少有四五行的长度，好在截图里看出断行的节奏。\n",
    ),
    (
        // 最小真实排版对照：用户复现两个段落间距过大的问题。
        "段落间距",
        "1 \n\n 1",
    ),
    (
        "列表与嵌套",
        "= 清单\n\n- 第一项：无序列表\n- 第二项：带嵌套\n  - 嵌套一\n  - 嵌套二\n- 第三项\n\n+ 有序一\n+ 有序二\n+ 有序三\n\n列表之后的收尾段落。\n",
    ),
    (
        "公式",
        "= 公式\n\n行内公式 $a^2 + b^2 = c^2$ 要与正文基线对齐。\n\n行间公式：\n\n$ sum_(i=1)^n i = frac(n(n+1), 2) $\n\n带下沉的 $integral_0^1 f(x) dif x$ 与下标 $a_0 = 0$ 也要完整。\n",
    ),
    (
        // 「少跳动」动态验收的基座（见 scripts/browser-check/writing-stability.mjs）：
        // 这一篇里的公式段落**没有 `#` / 反引号 / 注释** ⇒ 仍是纯 markup 正文，走的是
        // **公式装饰路径**（不是块切片），正是"光标进出公式时居中丢失"的发生地。
        // 每条的 body 都必须与 `dump_math_fixtures` 的用例逐字相同（`$ sum_(i=1)^n i $`
        // 这类），否则桩会退回假 SVG、量到的几何不可信。
        //
        // 块序有讲究：**四张切片必须首尾相邻**。`writing-blocks-visual.mjs` 的"切片纵向位置
        // 与真实排版一致"只比**切片之间**的相对 y；中间夹一段"可编辑正文"（它不含切片、
        // 按浏览器行高真实排版）会引入每个段落 ~19px 的偏差 —— 那是 W2（全局行高 ≈1.65 并不
        // 等于 typst 的 leading/段距）的已有缺口，不是这篇夹具要测的东西。所以正文段落放最后。
        "公式形态",
        "= 公式形态\n\n$ sum_(i=1)^n i $\n\n$ frac(a,b) $\n\n$ mat(1, 2; 3, 4) $\n\n$ a +\nb = c $\n\n行内公式 $x^2 + y^2 = z^2$ 夹在正文里。\n\n收尾段落。\n",
    ),
    (
        "代码与表格",
        "= 结构与脚注\n\n正文里有一个脚注#footnote[脚注正文会被排到页底]，这是写作模式的已知不足点。\n\n```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\n#table(\n  columns: 2,\n  [甲], [乙],\n  [1], [2],\n)\n\n表格之后的段落。\n",
    ),
    (
        "文档级设置（默认字号）",
        "= 设置对照\n\n这一段用来和下一篇对照：两篇正文完全相同，只有文档开头那条设置语句不同。\n",
    ),
    (
        "文档级设置（12pt）",
        "#set text(size: 12pt)\n\n= 设置对照\n\n这一段用来和上一篇对照：两篇正文完全相同，只有文档开头那条设置语句不同。\n",
    ),
    (
        // 带链接的段落**不能是最后一块**：最后一块是"活动块"（显示源码、没有切片），
        // 那样浏览器验收就看不到链接热区了（夹具链路里踩过）
        "链接",
        "= 链接\n\n更多内容见 #link(\"https://typst.app/docs\")[官方文档]，也可以看 #link(\"https://example.com/a\")[这个例子]。\n\n收尾段落。\n",
    ),
    (
        "混排与 emoji",
        "= 混排\n\n中文 ASCII 🚀 混在一行里：émoji 与 a_0 = 0 都要能点对位置。\n\n第二段用纯中文写长一点，用来验证整段折行之后的纵向定位是不是仍然准确。\n",
    ),
];

/// 阶段 0 主探针：把上面每篇文档跑一遍并打印统计 + 逐块表格。
/// 运行：`cargo test --manifest-path src-tauri/Cargo.toml dump_block_geometry -- --ignored --nocapture`
#[test]
#[ignore = "按需运行：阶段 0 的覆盖率/耗时探针"]
fn dump_block_geometry() {
    // 写作模式的版心宽：编辑器正文列宽去掉左右留白后的常见值（A4 的 0.83 左右）
    for (name, src) in DOCS {
        let report = probe_blocks(
            src.to_string(),
            None,
            &fonts_dir(),
            &FontConfig::default(),
            495.0, // ≈ A4 宽 595pt 去掉页边距
        );
        assert!(report.ok, "{name} 应编译成功: {:?}", report.error);
        println!(
            "\n=== {name} ===\n页数 {} / 块 {}/{} 有几何 / 正文覆盖 {:.1}%（{}/{} 字符；字节 {}/{}）/ 行序单调 {} / \
                 相邻空隙 {:.2}..{:.2}pt（重叠 {} 处）\n编译 {:.1}ms / 整页渲染 {:.1}ms / 逐块切片合计 {:.1}ms（产物 {} 字节）\n\
                 字形 {}/{} 已映射（text item {}，带变换 group {}，带 clip group {}，shape {}，image {}）\n未覆盖行：{:?}",
            report.pages,
            report.blocks_found,
            report.blocks_total,
            report.coverage_ratio * 100.0,
            report.covered_chars,
            report.content_chars,
            report.covered_bytes,
            report.src_bytes,
            report.y_monotonic,
            report.min_gap_pt,
            report.max_gap_pt,
            report.negative_gaps,
            report.compile_ms,
            report.full_page_render_ms,
            report.crop_render_ms_total,
            report.crop_bytes_total,
            report.glyphs_mapped,
            report.glyphs_total,
            report.text_items,
            report.transformed_groups,
            report.clipped_groups,
            report.shapes,
            report.images,
            report.uncovered_lines,
        );
        for b in &report.blocks {
            println!(
                "  {:>3}-{:<3} {:<9} {:>4}项 {:>5}px{:>6}  {:>6.1},{:>6.1} {:>5.1}×{:<5.1} 带{} 行 {} 切片{:.2}ms  {}{}",
                b.line,
                b.end_line,
                b.kind,
                b.items,
                if b.found { "找到" } else { "缺" },
                b.pages,
                b.x,
                b.y,
                b.w,
                b.h,
                b.bands,
                b.start,
                b.render_ms,
                if b.preview.is_empty() { "（空）" } else { &b.preview },
                if b.found { "" } else { "   ← 没有渲染结果" },
            );
        }
        // 机器可读部分（便于后续比对/回归）
        println!("PROBE:{}", serde_json::to_string(&report).unwrap());
    }
}

/// 大文档开销探针（只打印，不作断言）：`--ignored --nocapture` 按需跑。
#[test]
#[ignore = "按需运行：长文档下的块级渲染开销（窗口化的实测数据）"]
fn dump_long_doc_blocks() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    for paragraphs in [20usize, 60, 120, 200] {
        let mut src = String::from("= 长文档\n\n");
        for i in 0..paragraphs {
            src.push_str(&format!(
                "第 {i} 段正文，用来观察块级渲染在大文档下的开销。这一段里放一个行内公式 $a_{i} + b_{i} = c_{i}$，\n                     再补一句普通中文，让每个段落都有两三行。\n\n"
            ));
        }
        let t = Instant::now();
        let out = compile_blocks(
            src.clone(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            371.25,
            None,
            None,
        );
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert!(out.ok, "编译应成功: {:?}", out.diagnostics);
        let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
        let bytes: usize = rendered.iter().map(|b| b.svg.len()).sum();
        // 同一份文档再来一次"只渲中间窗口"，对比量级
        let t2 = Instant::now();
        let win = compile_blocks(
            src.clone(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            371.25,
            Some(src.len() / 2),
            Some(src.len() / 2 + 4000),
        );
        let win_ms = t2.elapsed().as_secs_f64() * 1000.0;
        let win_bytes: usize = win.blocks.iter().map(|b| b.svg.len()).sum();
        println!(
            "LONGDOC: 段落 {paragraphs} / 字符 {} / 块 {}（渲染 {}）/ 全渲 {:.1}KB {:.1}ms ←→ 窗口化 {}KB {:.1}ms",
            src.chars().count(),
            out.blocks.len(),
            rendered.len(),
            bytes as f64 / 1024.0,
            ms,
            win_bytes as f64 / 1024.0,
            win_ms
        );
        // 对照：整页渲一次有多大（＝源码模式预览每按键都要传的量级）
        let world = TypstWorld::new(
            format!("#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n{src}"),
            None,
            &fonts_dir(),
            &FontConfig::default(),
        );
        if let typst::diag::Warned {
            output: Ok(doc), ..
        } = typst::compile::<PagedDocument>(&world)
        {
            let page_bytes: usize = doc
                .pages()
                .iter()
                .map(|p| typst_svg::svg(p, &SvgOptions::default()).len())
                .sum();
            println!(
                "LONGDOC-PAGE: 同一文档整页 SVG {:.1}KB",
                page_bytes as f64 / 1024.0
            );
        }
    }
}

/// **真实文档体检**：读 `.browser-check/real-scene.typ`（用户给的真实文档）→ 编译 → 打印诊断与块表，
/// 并输出一条 `BLOCKFIXTURE`（给浏览器验收渲染截图用）。
/// 用法：先把文档存到该路径，再
/// `cargo test --manifest-path src-tauri/Cargo.toml dump_real_doc_fixture -- --ignored --nocapture`
#[test]
#[ignore = "按需运行：真实文档的块级渲染体检"]
fn dump_real_doc_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.browser-check/real-scene.typ");
    let Ok(src) = std::fs::read_to_string(&path) else {
        println!("REALDOC: 读不到 {}（先把文档存到那里）", path.display());
        return;
    };
    const COLUMN_PT: f64 = 371.25;
    let out = compile_blocks(
        src.clone(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    println!(
        "REALDOC: ok={} 页数={:?} 块={} 诊断={} 源字符={}",
        out.ok,
        out.pages,
        out.blocks.len(),
        out.diagnostics.len(),
        src.chars().count()
    );
    for d in &out.diagnostics {
        println!(
            "REALDOC-DIAG: [{}] 行{} 列{} {}",
            d.severity, d.line, d.column, d.message
        );
    }
    for b in &out.blocks {
        println!(
            "REALDOC-BLOCK: {:<10} [{:>4},{:>4}) y={:>6.1} h={:>6.1} found={:<5} svg={}KB",
            b.kind,
            b.start,
            b.end,
            b.y_pt,
            b.height_pt,
            b.found,
            b.svg.len() / 1024
        );
    }
    // 把 == 5 那一段（y 480..540）的帧项按 y 排出来：判断"公式挤在一起"是 typst 自己的
    // 排版，还是块切片的锅（切片只能读帧、不可能挪动内容 —— 这条输出就是证据）
    {
        let injected = "#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n";
        let world = TypstWorld::new(
            format!("{injected}{src}"),
            None,
            &fonts_dir(),
            &FontConfig::default(),
        );
        if let typst::diag::Warned {
            output: Ok(doc), ..
        } = typst::compile::<PagedDocument>(&world)
        {
            let (items, _) = collect_geometry(&world, &doc);
            let doc_start = injected.len();
            let mut in_region: Vec<(f64, usize, usize)> = items
                .iter()
                .filter(|i| i.rect.min.y.to_pt() > 480.0 && i.rect.min.y.to_pt() < 540.0)
                .map(|i| {
                    (
                        i.rect.min.y.to_pt(),
                        i.range.start.saturating_sub(doc_start),
                        i.range.end.saturating_sub(doc_start),
                    )
                })
                .collect();
            in_region.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            println!(
                "REALDOC-REGION: y 480..540 的帧项 {} 个（y, 文档区间）",
                in_region.len()
            );
            for (y, a, b) in in_region.iter().take(40) {
                println!("  y={y:>6.1} 文档 [{a},{b})");
            }
        }
    }
    if out.ok {
        println!(
            "BLOCKFIXTURE:{}",
            serde_json::json!({
                "name": "真实文档（数学作业）",
                "doc": src,
                "contentWidthPt": COLUMN_PT,
                "pageWidthPt": out.page_width_pt,
                "blocks": out.blocks,
            })
        );
    }
}

/// 临时诊断：场景文档里每个块匹配到的帧项数量与源区间（排查"某些块 found=false"）。
#[test]
#[ignore = "按需运行：块 ↔ 帧项的匹配诊断"]
fn dump_scene_item_matching() {
    const COLUMN_PT: f64 = 371.25;
    for (name, src) in SCENE_DOCS {
        let injected = "#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n";
        let compiled = format!("{injected}{src}");
        let doc_start = injected.len();
        let world = TypstWorld::new(compiled, None, &fonts_dir(), &FontConfig::default());
        let typst::diag::Warned {
            output: Ok(doc), ..
        } = typst::compile::<PagedDocument>(&world)
        else {
            println!("SCENE[{name}] 编译失败");
            continue;
        };
        let (items, _) = collect_geometry(&world, &doc);
        println!("\nSCENE[{name}] 帧项 {} 个", items.len());
        for b in source_blocks(src) {
            let range = (b.range.start + doc_start)..(b.range.end + doc_start);
            let hit = items
                .iter()
                .filter(|i| i.range.start < range.end && i.range.end >= range.start)
                .count();
            let first = items
                .iter()
                .find(|i| i.range.start < range.end && i.range.end >= range.start);
            println!(
                "  {} [{}..{}) 项 {} 首个项区间 {:?}（文档坐标 {:?}..{:?}）",
                b.kind,
                b.range.start,
                b.range.end,
                hit,
                first.map(|i| (i.range.start, i.range.end)),
                first.map(|i| i.range.start.saturating_sub(doc_start)),
                first.map(|i| i.range.end.saturating_sub(doc_start)),
            );
        }
    }
}

/// 「切片几何等价」验收用的**真实产物夹具**（按需导出，浏览器端注入）：
///   `npm run fixtures:blocks`
/// 每条 = 一篇文档 + 编译用的正文列宽 + 每块的区间/几何/SVG。浏览器侧会把同一篇文档
/// 打进编辑器（桩按文档原文命中夹具，给真实产物），再断言"摞起来 == 原版式"。
#[test]
#[ignore = "按需运行：导出块级切片的真实产物夹具（场景集）"]
fn dump_block_fixtures() {
    const COLUMN_PT: f64 = 371.25;
    for (name, src) in SCENE_DOCS {
        let out = compile_blocks(
            src.to_string(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            COLUMN_PT,
            None,
            None,
        );
        assert!(out.ok, "[{name}] 编译应成功：{:?}", out.diagnostics);
        let probes = hit_probes(&out);
        let json = serde_json::json!({
            "name": name,
            "doc": src,
            "contentWidthPt": COLUMN_PT,
            "pageWidthPt": out.page_width_pt,
            "blocks": out.blocks,
            // 点击定位的探针：每块在带内取网格点，记录**真实几何上 Rust 给出的字节偏移**。
            // 浏览器验收照这些点原样点下去，断言光标落到的字符与这里记的一致
            // （见 scripts/browser-check/writing-blocks-hit.mjs）。
            "hitProbes": probes,
        });
        println!("BLOCKFIXTURE:{}", json);
    }
}
