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

/// 递归收集语法树里的 `Math` 节点（未 numberize 的树按子节点字节长度累加出区间）。
/// **定义/规则/普通代码里的公式不收集**：`#let vec(x) = $accent(#x, arrow)$` 里那个 `$...$`
/// 是宏体（`x` 是形参），既不会在正文里当公式渲染，单独编译也只会报 unknown variable。
fn pku_walk_math(node: &SyntaxNode, base: usize, out: &mut Vec<(usize, usize)>) {
    let mut cursor = base;
    for child in node.children() {
        let start = cursor;
        let end = start + child.len();
        cursor = end;
        // **Equation**（`$…$`，含定界符）才是前端 `math-ranges.ts` 扫到的东西；
        // `SyntaxKind::Math` 只是定界符里的内容，范围不含 `$` 与内侧空白，
        // 拿它当 raw 会算出与前端不同的 display/body（真实作业上量到过：行间公式被当成行内）。
        if child.kind() == SyntaxKind::Equation {
            out.push((start, end));
            continue;
        }
        if is_no_output_node(child.kind()) || child.kind() == SyntaxKind::Code {
            continue;
        }
        pku_walk_math(child, start, out);
    }
}

/// 从文档里提取可用于公式编译的顶层单行 `#let` 定义（与前端 `math-context.ts` 的
/// `extractMathDefinitions` 同口径：单行、有非空值、值里不含内容块 `[`；同名保留最后一次）。
/// 少了它，`$va_1$` 这类用文档宏的行内公式在浏览器里会退回源码，量到的排版就不是真实的。
fn pku_let_context(src: &str) -> String {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in src.lines() {
        let line = line.trim();
        if !line.starts_with("#let") || line.contains('[') {
            continue;
        }
        let rest = line["#let".len()..].trim_start();
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if name.is_empty() {
            continue;
        }
        let Some((_, value)) = line.split_once('=') else {
            continue;
        };
        if value.trim().is_empty() {
            continue;
        }
        if !map.contains_key(&name) {
            order.push(name.clone());
        }
        map.insert(name, line.to_string());
    }
    order
        .iter()
        .filter_map(|n| map.get(n).cloned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 解析 Typst 长度字面量（pt/cm/mm/in）→ pt。
fn pku_len_pt(s: &str) -> Option<f64> {
    let s = s.trim();
    for (unit, scale) in [("pt", 1.0), ("cm", 28.346_456_7), ("mm", 2.834_645_67), ("in", 72.0)] {
        if let Some(v) = s.strip_suffix(unit) {
            return v.trim().parse::<f64>().ok().map(|x| x * scale);
        }
    }
    None
}

/// 取 `#set <name>(` 到配对右括号之间的实参文本（**跳过注释行**；同一 set 出现多次取最后一次，
/// 与 Typst 的累积覆盖一致）。
fn pku_set_args(src: &str, name: &str) -> Option<String> {
    let needle = format!("#set {name}(");
    let mut last: Option<String> = None;
    let mut from = 0usize;
    while let Some(pos) = src[from..].find(&needle) {
        let start = from + pos + needle.len();
        // 前面这一行的前缀若在注释里就跳过（`// #set page(` 之类的示例不算活动规则）
        let line_start = src[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
        if src[line_start..start].trim_start().starts_with("//") {
            from = start;
            continue;
        }
        let mut depth = 1i32;
        let mut end = start;
        for (i, ch) in src[start..].char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = start + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        if depth == 0 {
            last = Some(src[start..end].to_string());
            from = end;
        } else {
            break;
        }
    }
    last
}

/// 取实参文本里 `key:` 之后的"裸值"（到逗号 / 顶层右括号为止）。**不解析嵌套括号的值**。
fn pku_arg_value(args: &str, key: &str) -> Option<String> {
    let needle = format!("{key}:");
    let mut from = 0usize;
    while let Some(pos) = args[from..].find(&needle) {
        let at = from + pos + needle.len();
        let rest = &args[at..];
        let value: String = rest
            .trim_start()
            .chars()
            .take_while(|c| *c != ',' && *c != ')' && *c != '\n')
            .collect();
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
        from = at;
    }
    None
}

/// 取 `margin: (...)` 里的 `x:`（没有括号形式时返回整段）。
fn pku_margin_x_pt(args: &str) -> Option<f64> {
    let at = args.find("margin:")? + "margin:".len();
    let rest = args[at..].trim_start();
    if let Some(inner) = rest.strip_prefix('(') {
        let inner = inner.split(')').next().unwrap_or("");
        pku_arg_value(inner, "x").and_then(|v| pku_len_pt(&v))
    } else {
        pku_len_pt(&rest.chars().take_while(|c| *c != ',' && *c != ')').collect::<String>())
    }
}

/// 文档自身页面设置带来的**真实正文列宽**（pt）。
///
/// `compile_blocks` 注入的 `#set page(width:…, height:auto, margin:…)` 会被文档后面的
/// `#set page(...)` 覆盖：只写 margin 的文档保留注入页宽但换了页边距，写 `paper: "a4"` 的
/// 则整页都换成 A4。两种情况下裁剪带的宽度字段都**不等于**文档真实列宽 —— 浏览器要按真实
/// 列宽排版，才能和夹具里的锚点/行数对账。
fn pku_true_content_pt(src: &str, injected_page_w_pt: f64, injected_margin_pt: f64) -> f64 {
    let mut page_w = injected_page_w_pt;
    let mut margin = injected_margin_pt;
    if let Some(args) = pku_set_args(src, "page") {
        if let Some(paper) = pku_arg_value(&args, "paper") {
            if paper.contains("a4") {
                page_w = 595.28;
            } else if paper.contains("a5") {
                page_w = 419.53;
            }
        }
        if let Some(w) = pku_arg_value(&args, "width").and_then(|v| pku_len_pt(&v)) {
            page_w = w;
        }
        if let Some(m) = pku_margin_x_pt(&args) {
            margin = m;
        }
    }
    (page_w - 2.0 * margin).max(60.0)
}

/// 文档自身的 `#set par(leading: …)`（em 倍数，默认 0.65 = typst 的默认行距）。
fn pku_par_leading(src: &str) -> f64 {
    pku_set_args(src, "par")
        .and_then(|args| pku_arg_value(&args, "leading"))
        .and_then(|v| v.trim().strip_suffix("em").map(|x| x.trim().to_string()))
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.65)
}

/// **PKU 真实作业验收夹具**（按需导出；消费方 `scripts/browser-check/writing-pku-docs.mjs`）。
///   `PKU_ROOT="$HOME/PKU" npm run fixtures:pku-writing`
///
/// 与 `dump_block_fixtures` 的区别：样本是**磁盘上的真实作业**（原文不复制进仓库），
/// 用**源文件实际路径**当 Typst 文档路径，于是 `#image("….pdf")` 这类相对资源能解析；
/// 并且除块带几何外还导出**可比较锚点**——每块首页首行的墨迹顶端 `anchorYpt` 与该行左缘
/// `anchorXpt`。浏览器侧把可编辑正文的首行 DOM 位置与它对账，而不是拿 `.cm-block-crop`
/// 的带顶去和字形顶端硬比（带顶是"与相邻块取中点"的结果，与首行文字不是同一个含义）。
///
/// 任何一份样本读不到 / 编译失败 / 一个几何都没有 → 断言失败（退出码非零），
/// 由 npm 包装层拒绝写出空夹具（"生成空 JSON 后报绿"是明确禁止的失败模式）。
#[test]
#[ignore = "按需运行：导出 PKU 真实作业的写作模式夹具"]
fn dump_pku_writing_fixtures() {
    // (显示名, 优先级, 相对 PKU_ROOT 的路径)——顺序即验收报告的优先级顺序
    const SAMPLES: &[(&str, &str, &str)] = &[
        ("高等代数周二 2026-09-24", "P0", "26fall/高等代数/week2-2026.9.24/1.typ"),
        ("高等代数周一 2026-09-17", "P1", "26fall/高等代数/week1-2026.9.17/1.typ"),
        ("数学分析周一 2026-09-14", "P1", "26fall/数学分析/week1-2026.9.14/1.typ"),
        ("数学分析周二 2026-09-21", "P1", "26fall/数学分析/week2-2026.9.21/1.typ"),
    ];
    let root = std::env::var("PKU_ROOT").unwrap_or_else(|_| {
        format!("{}/PKU", std::env::var("HOME").unwrap_or_default())
    });
    let requested_column_pt = std::env::var("PKU_WRITING_COLUMN_PT")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(371.25);
    // 与 `compile_blocks` 逐字一致的口径（夹紧 + 页宽反推），锚点那一趟必须用同一个版心，
    // 否则两趟排版宽度不同、行断位置都变了，锚点对不上几何。
    let content_pt = requested_column_pt.clamp(120.0, 2000.0);
    let margin_ratio = 70.87 / crate::typst_world::A4_WIDTH_PT;
    let page_width_pt = content_pt / (1.0 - 2.0 * margin_ratio);
    let margin_pt = page_width_pt * margin_ratio;

    let mut failures: Vec<String> = Vec::new();
    let mut emitted = 0usize;
    for (name, priority, rel) in SAMPLES {
        let path = Path::new(&root).join(rel);
        let abs = path.to_string_lossy().to_string();
        if !path.is_file() {
            println!("PKUERROR:{name}\t文件不存在：{abs}");
            failures.push(format!("{name}：文件不存在（{abs}）"));
            continue;
        }
        let src = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                println!("PKUERROR:{name}\t读文件失败：{abs}：{e}");
                failures.push(format!("{name}：读文件失败 {e}"));
                continue;
            }
        };
        let out = compile_blocks(
            src.clone(),
            0,
            Some(abs.clone()),
            &fonts_dir(),
            &FontConfig::default(),
            content_pt,
            None,
            None,
        );
        for d in &out.diagnostics {
            println!(
                "PKUDIAG:{name}\t[{}] 行{} 列{} {}",
                d.severity, d.line, d.column, d.message
            );
        }
        if !out.ok {
            failures.push(format!("{name}：真实编译失败（{} 条诊断）", out.diagnostics.len()));
        }

        // 锚点那一趟：同一版心、同一 document_path、同一套字体重新编译，从帧里取每块首行墨迹顶。
        let injected = format!(
            "#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin_pt:.2}pt)\n"
        );
        let doc_start = injected.len();
        let compiled = format!("{injected}{src}");
        let world = TypstWorld::new(
            compiled,
            Some(abs.clone()),
            &fonts_dir(),
            &FontConfig::default(),
        );
        let items: Vec<PlacedItem> = if let typst::diag::Warned {
            output: Ok(doc), ..
        } = typst::compile::<PagedDocument>(&world)
        {
            collect_geometry_with_links(&world, &doc).0 .0
        } else {
            Vec::new()
        };

        // 文档自身页面设置带来的真实列宽：占位切片的 viewBox 用它，浏览器把切片铺到同一列宽时
        // 高度就恰好等于 `heightPt`（几何来自真实帧，像素不是）。
        let true_content_pt = pku_true_content_pt(&src, page_width_pt, margin_pt);
        // **行距 = 基线直方图的自相关峰**：多数字形落在每行的主基线上，把整个基线集合平移
        // 一个真实行距后重叠最多；分式/上下标是少数，不会赢。这比"逐块算"稳（逐块依赖行数，
        // 行数本身由主峰数得出，误差会被 span/(n-1) 放大；实测数分周二被带成 11.5/21pt）。
        let line_spacing_pt: Option<f64> = {
            let mut bins: std::collections::BTreeMap<i64, usize> =
                std::collections::BTreeMap::new();
            for i in &items {
                *bins.entry((i.baseline_pt * 2.0).round() as i64).or_insert(0) += 1;
            }
            if bins.len() < 3 {
                None
            } else {
                let mut best = (0i64, 0usize);
                for step in 16i64..=60 {
                    let mut overlap = 0usize;
                    for (b, c) in &bins {
                        if bins.contains_key(&(b + step)) {
                            overlap += c;
                        }
                    }
                    if overlap > best.1 {
                        best = (step, overlap);
                    }
                }
                (best.1 > 0).then(|| best.0 as f64 / 2.0)
            }
        };
        let mut block_json: Vec<serde_json::Value> = Vec::with_capacity(out.blocks.len());
        let mut found_geometry = 0usize;
        // 每块首行主基线（页面坐标，pt）：段距 = 相邻普通段落的首行基线差
        let mut first_baselines: Vec<Option<f64>> = Vec::with_capacity(out.blocks.len());
        for b in &out.blocks {
            let range = (b.start + doc_start)..(b.end + doc_start);
            // 只对"确实有渲染结果"的块算锚点。无输出块（#let/#set/#show）现在 found=false，
            // 但它们的宏内容在使用处的 span 仍指回定义处 —— 不排除就会拿到跨页假锚点。
            let hit: Vec<&PlacedItem> = if b.found {
                items
                    .iter()
                    .filter(|i| i.range.start < range.end && i.range.end >= range.start)
                    .collect()
            } else {
                Vec::new()
            };
            let page = hit.iter().map(|i| i.page).min();
            let mut anchor_y: Option<f64> = None;
            let mut anchor_x: Option<f64> = None;
            let mut block_first_baseline: Option<f64> = None;
            let mut line_spans: Vec<serde_json::Value> = Vec::new();
            let mut line_tops: Vec<f64> = Vec::new();
            let mut line_count = 0usize;
            if let Some(page) = page {
                let on_page: Vec<&&PlacedItem> = hit.iter().filter(|i| i.page == page).collect();
                if !on_page.is_empty() {
                    let min_y = on_page
                        .iter()
                        .map(|i| i.rect.min.y.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    // 首行带 = y 与顶端相差不超过 1pt 的项（与 blocks.rs 的 0.5pt 去重同一量级）
                    let first: Vec<&&&PlacedItem> = on_page
                        .iter()
                        .filter(|i| i.rect.min.y.to_pt() - min_y <= 1.0)
                        .collect();
                    let min_x = first
                        .iter()
                        .map(|i| i.rect.min.x.to_pt())
                        .fold(f64::INFINITY, f64::min);
                    anchor_y = Some(min_y);
                    anchor_x = Some(min_x);
                    // 首行主基线（计数最多的基线）：段距按相邻普通段落的首行基线差量。
                    let mut first_bins: std::collections::BTreeMap<i64, usize> =
                        std::collections::BTreeMap::new();
                    for i in on_page
                        .iter()
                        .filter(|i| i.rect.min.y.to_pt() - min_y <= 1.0)
                    {
                        *first_bins
                            .entry((i.baseline_pt * 2.0).round() as i64)
                            .or_insert(0) += 1;
                    }
                    block_first_baseline = first_bins
                        .iter()
                        .max_by_key(|(_, c)| **c)
                        .map(|(k, _)| *k as f64 / 2.0);
                    let mut ys: Vec<f64> = on_page
                        .iter()
                        .map(|i| (i.rect.min.y.to_pt() * 2.0).round() / 2.0)
                        .collect();
                    ys.sort_by(|a, b| a.total_cmp(b));
                    ys.dedup();
                    line_tops = ys;
                    // **行数 = 主基线聚类**：阈值为实测行距的 0.75 倍（上下标/分式把基线拉开
                    // 约 ±5~8pt，行距 15~18pt，0.75 倍能分开"行"与"行内偏移"）。量不到行距时
                    // 退回"基线上有个字形就算一行"。
                    let mut bs: Vec<f64> = on_page.iter().map(|i| i.baseline_pt).collect();
                    bs.sort_by(|a, b| a.total_cmp(b));
                    let threshold = line_spacing_pt.map(|sp| sp * 0.75).unwrap_or(0.0);
                    if !bs.is_empty() {
                        line_count = 1;
                        let mut last = bs[0];
                        for v in bs.iter().skip(1) {
                            if *v - last > threshold {
                                line_count += 1;
                                last = *v;
                            }
                        }
                    }
                    // 逐行拆：按同一阈值把字形分到各行，记录源区间与右缘
                    {
                        let mut sorted: Vec<&&PlacedItem> = on_page.clone();
                        sorted.sort_by(|a, b| a.baseline_pt.total_cmp(&b.baseline_pt));
                        let mut cur: Vec<&&PlacedItem> = Vec::new();
                        let flush = |cur: &mut Vec<&&PlacedItem>,
                                         spans: &mut Vec<serde_json::Value>| {
                            if cur.is_empty() {
                                return;
                            }
                            let start = cur.iter().map(|i| i.range.start).min().unwrap();
                            let end = cur.iter().map(|i| i.range.end).max().unwrap();
                            let x1 = cur
                                .iter()
                                .map(|i| i.rect.max.x.to_pt())
                                .fold(f64::NEG_INFINITY, f64::max);
                            let y = cur
                                .iter()
                                .map(|i| i.rect.min.y.to_pt())
                                .fold(f64::INFINITY, f64::min);
                            spans.push(serde_json::json!({
                                "start": start.saturating_sub(doc_start),
                                "end": end.saturating_sub(doc_start),
                                "x1Pt": (x1 * 10.0).round() / 10.0,
                                "yPt": (y * 10.0).round() / 10.0,
                            }));
                            cur.clear();
                        };
                        let mut spans: Vec<serde_json::Value> = Vec::new();
                        let mut last_b: Option<f64> = None;
                        for i in sorted {
                            if let Some(lb) = last_b {
                                if i.baseline_pt - lb > threshold {
                                    flush(&mut cur, &mut spans);
                                }
                            }
                            last_b = Some(i.baseline_pt);
                            cur.push(i);
                        }
                        flush(&mut cur, &mut spans);
                        line_spans = spans;
                    }
                }
            }
            if b.found && anchor_y.is_some() {
                found_geometry += 1;
            }
            block_json.push(serde_json::json!({
                "start": b.start,
                "end": b.end,
                "kind": b.kind,
                "found": b.found,
                "skipped": b.skipped,
                "pages": b.pages,
                "page": b.page,
                "xPt": b.x_pt,
                "yPt": b.y_pt,
                "widthPt": b.width_pt,
                "heightPt": b.height_pt,
                "bands": b.bands,
                "anchorYpt": anchor_y,
                "anchorXpt": anchor_x,
                // 首行**主基线**（页面坐标）：比"墨迹顶端"更适合与浏览器对账 ——
                // 两者对同一行文字的含义一致，不受行高（半 leading）与首字形高低影响。
                "anchorBaselinePt": block_first_baseline,
                // **逐行的源区间与右缘**（诊断折行差异用）：按基线聚类成行，每行给
                // `start/end`（文档字节，取自该行字形）与 `x1Pt`（该行最右墨迹）。
                // 浏览器侧用 `visualLineAt` 数出视觉行与断点，与这里逐行比，能指出"从哪个字开始折行不同"。
                "lineSpans": line_spans,
                "lineTopsPt": line_tops,
                "lineCount": line_count,
                // **等比例占位切片**（不是真渲染像素）：真 SVG 在图片/公式密集的作业里单份 5MB+，
                // 注入浏览器会卡死；而这一套要验的是**几何**（带高、锚点、行数），带高由 viewBox
                // 的宽高比决定，占位就足够。真实 SVG 的像素几何由 `writing-blocks-visual.mjs` 覆盖。
                "svg": if b.found && !b.skipped && b.height_pt > 0.5 {
                    format!(
                        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {true_content_pt:.2} {:.2}\"></svg>",
                        b.height_pt
                    )
                } else {
                    String::new()
                },
            }));
            first_baselines.push(block_first_baseline);
        }
        // **段距**：相邻两个普通段落（源码之间恰好一条空白行）首行主基线的差。
        // 编辑器里两段之间的距离由"上一个段落的行盒 + 空白行"表示，所以空白行目标高度
        // = 段距 − 真实行距（行高跟文档走之后必须一起改，否则每条段落分隔会短一截）。
        let par_gap_pt: Option<f64> = {
            let mut samples: Vec<f64> = Vec::new();
            for i in 0..out.blocks.len().saturating_sub(1) {
                let (a, c) = (&out.blocks[i], &out.blocks[i + 1]);
                if a.kind != "Paragraph" || c.kind != "Paragraph" {
                    continue;
                }
                let between = src.get(a.end..c.start).unwrap_or("");
                if between.matches('\n').count() != 2 || !between.trim().is_empty() {
                    continue;
                }
                if let (Some(x), Some(y)) = (first_baselines[i], first_baselines[i + 1]) {
                    let d = y - x;
                    if (12.0..=40.0).contains(&d) {
                        samples.push(d);
                    }
                }
            }
            if samples.len() < 3 {
                None
            } else {
                // 取 **20% 分位**而不是中位数：首行带分式/矩阵时"主基线"会被拉偏，只会把差拉**大**，
                // 不会拉小；真实段距是最小的那批（实测数分周二中位数被带成 30pt、下沿 20.5pt）。
                samples.sort_by(|a, b| a.total_cmp(b));
                let idx = ((samples.len() as f64 * 0.2) as usize).min(samples.len() - 1);
                Some((samples[idx] * 2.0).round() / 2.0)
            }
        };
        if !out.ok || found_geometry == 0 {
            failures.push(format!(
                "{name}：没有可用几何（ok={}，有锚点块 {}）",
                out.ok, found_geometry
            ));
        }
        // **公式夹具**：可编辑正文里的行内公式由 `compile_math` 渲染成 widget，其高度会影响
        // 段落行高。桩没有真产物就退回假 SVG（高度写死 7.2pt），量到的行高就不是引擎的 ——
        // 所以这里把文档里每个公式按**同一份文档宏上下文**真编译一份，供浏览器注入。
        let context = pku_let_context(&src);
        let mut math_nodes: Vec<(usize, usize)> = Vec::new();
        pku_walk_math(&typst_syntax::parse(&src), 0, &mut math_nodes);
        let mut seen: std::collections::BTreeSet<(String, bool)> = std::collections::BTreeSet::new();
        let mut math_json: Vec<serde_json::Value> = Vec::new();
        let mut math_failed = 0usize;
        for (start, end) in math_nodes {
            let raw = &src[start..end];
            let inner = raw.strip_prefix('$').unwrap_or(raw);
            let inner = inner.strip_suffix('$').unwrap_or(inner);
            let display = inner.chars().next().is_some_and(char::is_whitespace)
                && inner.chars().last().is_some_and(char::is_whitespace)
                && !inner.trim().is_empty();
            // 与前端 `math-ranges.ts` 逐字一致：行间公式取 trim 后的 body，**行内公式取原样的
            // `raw`（首尾空格也算 body 的一部分）**。差一个空格，桩就命中不到真产物、退回假 SVG，
            // 行内公式宽度失真 → 正文断行位置全变（真实作业上实测过）。
            let body = if display { inner.trim() } else { inner };
            if body.trim().is_empty() {
                continue;
            }
            let key = (body.to_string(), display);
            if !seen.insert(key.clone()) {
                continue;
            }
            let m = crate::typst_world::compile_math(
                &key.0,
                key.1,
                &context,
                Some(abs.clone()),
                &fonts_dir(),
                &FontConfig::default(),
                out.text_pt,
            );
            if !m.ok {
                math_failed += 1;
                println!(
                    "PKUMATHERR:{name}\t{} :: {}",
                    key.0.replace('\n', "\\n"),
                    m.error.unwrap_or_default()
                );
                continue;
            }
            math_json.push(serde_json::json!({
                "body": key.0,
                "display": key.1,
                "sizePt": out.text_pt,
                "svg": m.svg,
                "widthPt": m.width_pt,
                "heightPt": m.height_pt,
                "baselinePt": m.baseline_pt,
                // 长行内公式的可断行片段（前端据此在运算符处折行，见 split_inline_math）
                "segments": m.segments,
            }));
        }
        // 诊断：Typst 在**真实文档里**的 CJK 前进宽度（相邻同基线字形的 x 差 / 字符数）。
        // 编辑器的补偿是按"1em"补的，这个数才是引擎的实际值 —— 两者不一致就说明补偿模型错了。
        {
            let mut samples: Vec<f64> = Vec::new();
            let mut punct_samples: Vec<(String, f64)> = Vec::new();
            let mut sorted: Vec<&PlacedItem> = items.iter().filter(|i| i.page == 1).collect();
            sorted.sort_by(|a, b| {
                a.rect
                    .min
                    .y
                    .to_pt()
                    .total_cmp(&b.rect.min.y.to_pt())
                    .then(a.rect.min.x.to_pt().total_cmp(&b.rect.min.x.to_pt()))
            });
            for w in sorted.windows(2) {
                let (a, b) = (w[0], w[1]);
                if (a.rect.min.y.to_pt() - b.rect.min.y.to_pt()).abs() > 0.5 {
                    continue;
                }
                if a.range.end != b.range.start {
                    continue;
                }
                // items 的 range 是**注入后文档**的坐标，要减掉前缀才是原文
                let (s0, e0) = (
                    a.range.start.saturating_sub(doc_start),
                    a.range.end.saturating_sub(doc_start),
                );
                if e0 > src.len() || s0 >= e0 {
                    continue;
                }
                let text = &src[s0..e0];
                let n = text.chars().count();
                if n == 0 {
                    continue;
                }
                let is_han = text.chars().all(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
                let is_punct = text.chars().all(|c| {
                    ('\u{3000}'..='\u{303f}').contains(&c) || ('\u{ff00}'..='\u{ff65}').contains(&c)
                });
                let is_latin = text.chars().all(|c| c.is_ascii_alphanumeric());
                if !is_han && !is_punct && !is_latin {
                    continue;
                }
                let dx = b.rect.min.x.to_pt() - a.rect.min.x.to_pt();
                if dx > 0.5 && dx < 40.0 {
                    let kind = if is_han {
                        "han"
                    } else if is_punct {
                        "punct"
                    } else {
                        "latin"
                    };
                    punct_samples.push((kind.to_string(), dx / n as f64));
                    samples.push(dx / n as f64);
                }
            }
            samples.sort_by(|a, b| a.total_cmp(b));
            if !samples.is_empty() {
                let median = samples[samples.len() / 2];
                let cls_median = |kind: &str| -> Option<(usize, f64)> {
                    let mut v: Vec<f64> = punct_samples
                        .iter()
                        .filter(|(k, _)| k == kind)
                        .map(|(_, x)| *x)
                        .collect();
                    if v.is_empty() {
                        return None;
                    }
                    v.sort_by(|a, b| a.total_cmp(b));
                    Some((v.len(), v[v.len() / 2]))
                };
                println!(
                    "PKUCJKADV:{name}\t中位={median:.3}pt 样本={}（字号 {}pt → 比率 {:.4}）han={:?} punct={:?} latin={:?}",
                    samples.len(),
                    out.text_pt,
                    median / out.text_pt,
                    cls_median("han"),
                    cls_median("punct"),
                    cls_median("latin")
                );
            }
        }

        let json = serde_json::json!({
            "name": name,
            "priority": priority,
            "relPath": rel,
            "absPath": abs,
            // 浏览器要按**文档真实列宽**排版（文档自带的 #set page 会覆盖注入页设置）
            "contentWidthPt": true_content_pt,
            "injectedContentPt": content_pt,
            "parLeading": pku_par_leading(&src),
            "lineSpacingPt": line_spacing_pt,
            "parGapPt": par_gap_pt,
            "ownPage": pku_set_args(&src, "page").is_some(),
            "pageWidthPt": out.page_width_pt,
            "textPt": out.text_pt,
            "ok": out.ok,
            "pages": out.pages,
            "diagnostics": out.diagnostics,
            "warnings": out.warnings,
            "blocks": block_json,
            "math": math_json,
            "domMathCount": seen.len(),
            "failedMath": math_failed,
            "doc": src,
        });
        println!(
            "PKUSUMMARY:{name}\tok={}\tpages={:?}\t块={}\t有几何={}\t公式={}\t公式失败={}\t诊断={}\t源码字节={}",
            out.ok,
            out.pages,
            out.blocks.len(),
            found_geometry,
            seen.len(),
            math_failed,
            out.diagnostics.len(),
            src.len()
        );
        println!("PKUFIXTURE:{json}");
        emitted += 1;
    }
    // ---- 编辑回放夹具（P0）：Enter / 输入 / Backspace / Undo 的确定状态 ----
    //
    // 浏览器桩只在"文档全文与夹具逐字相同"时返回真实块几何；编辑态没有对应夹具就会静默退回
    // 假切片。所以每个回放状态都要有**真实编译**的夹具（`PKUREPLAY:`），由 npm 包装层收集。
    {
        let path = Path::new(&root).join(SAMPLES[0].2);
        match std::fs::read_to_string(&path) {
            Ok(src) => {
                let abs = path.to_string_lossy().to_string();
                let true_content_pt = pku_true_content_pt(&src, page_width_pt, margin_pt);
                let anchor = source_blocks(&src)
                    .into_iter()
                    .find(|b| {
                        b.kind == "Paragraph"
                            && !src[b.range.clone()].contains('\n')
                            && b.range.end.saturating_sub(b.range.start) > 20
                    })
                    .map(|b| b.range.end);
                if let Some(pos) = anchor {
                    if src.as_bytes().get(pos) != Some(&b'\n') {
                        failures.push("编辑回放：锚点不在行尾换行符上".to_string());
                    } else {
                        let char_len = src[..pos]
                            .chars()
                            .next_back()
                            .map(|c| c.len_utf8())
                            .unwrap_or(0);
                        let enter_doc = format!("{}{}{}", &src[..pos], "\n", &src[pos..]);
                        let type_doc = format!("{}{}{}", &src[..pos], "测试", &src[pos..]);
                        let back_doc = if char_len > 0 {
                            format!("{}{}", &src[..pos - char_len], &src[pos..])
                        } else {
                            src.clone()
                        };
                        let state_json = |name: &str, doc: &str| -> serde_json::Value {
                            let out = compile_blocks(
                                doc.to_string(),
                                0,
                                Some(abs.clone()),
                                &fonts_dir(),
                                &FontConfig::default(),
                                content_pt,
                                None,
                                None,
                            );
                            let injected = format!(
                                "#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin_pt:.2}pt)\n"
                            );
                            let doc_start = injected.len();
                            let world = TypstWorld::new(
                                format!("{injected}{doc}"),
                                Some(abs.clone()),
                                &fonts_dir(),
                                &FontConfig::default(),
                            );
                            let items: Vec<PlacedItem> = if let typst::diag::Warned {
                                output: Ok(d), ..
                            } = typst::compile::<PagedDocument>(&world)
                            {
                                collect_geometry_with_links(&world, &d).0 .0
                            } else {
                                Vec::new()
                            };
                            let mut arr: Vec<serde_json::Value> = Vec::new();
                            for b in &out.blocks {
                                let range = (b.start + doc_start)..(b.end + doc_start);
                                let hit: Vec<&PlacedItem> = if b.found {
                                    items
                                        .iter()
                                        .filter(|i| {
                                            i.range.start < range.end && i.range.end >= range.start
                                        })
                                        .collect()
                                } else {
                                    Vec::new()
                                };
                                let page = hit.iter().map(|i| i.page).min();
                                let mut anchor_y: Option<f64> = None;
                                let mut anchor_baseline: Option<f64> = None;
                                if let Some(pg) = page {
                                    let on_page: Vec<&&PlacedItem> =
                                        hit.iter().filter(|i| i.page == pg).collect();
                                    if !on_page.is_empty() {
                                        let min_y = on_page
                                            .iter()
                                            .map(|i| i.rect.min.y.to_pt())
                                            .fold(f64::INFINITY, f64::min);
                                        anchor_y = Some(min_y);
                                        let mut bins: std::collections::BTreeMap<i64, usize> =
                                            std::collections::BTreeMap::new();
                                        for i in on_page
                                            .iter()
                                            .filter(|i| i.rect.min.y.to_pt() - min_y <= 1.0)
                                        {
                                            *bins.entry((i.baseline_pt * 2.0).round() as i64)
                                                .or_insert(0) += 1;
                                        }
                                        anchor_baseline = bins
                                            .iter()
                                            .max_by_key(|(_, c)| **c)
                                            .map(|(k, _)| *k as f64 / 2.0);
                                    }
                                }
                                arr.push(serde_json::json!({
                                    "start": b.start,
                                    "end": b.end,
                                    "kind": b.kind,
                                    "found": b.found,
                                    "skipped": b.skipped,
                                    "pages": b.pages,
                                    "page": b.page,
                                    "xPt": b.x_pt,
                                    "yPt": b.y_pt,
                                    "widthPt": b.width_pt,
                                    "heightPt": b.height_pt,
                                    "bands": b.bands,
                                    "anchorYpt": anchor_y,
                                    "anchorBaselinePt": anchor_baseline,
                                    "svg": if b.found && !b.skipped && b.height_pt > 0.5 {
                                        format!(
                                            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {true_content_pt:.2} {:.2}\"></svg>",
                                            b.height_pt
                                        )
                                    } else {
                                        String::new()
                                    },
                                }));
                            }
                            serde_json::json!({
                                "name": name,
                                "doc": doc,
                                "contentWidthPt": true_content_pt,
                                "pageWidthPt": out.page_width_pt,
                                "textPt": out.text_pt,
                                "ok": out.ok,
                                "pages": out.pages,
                                "diagnostics": out.diagnostics,
                                "blocks": arr,
                                "replay": true,
                            })
                        };
                        for (key, name, doc) in [
                            ("A", "原始", &src),
                            ("B", "Enter 分段", &enter_doc),
                            ("C", "输入两字", &type_doc),
                            ("D", "Backspace", &back_doc),
                        ] {
                            let json = state_json(name, doc);
                            println!("PKUREPLAY:{}", serde_json::json!({ "key": key, "fixture": json }));
                        }
                        println!("PKUREPLAYANCHOR:{}", pos);

                        // ---- 含单 LF 的段落（报告里的"第 76–77 行"那一类：编辑器走切片）----
                        // 聚焦要把它揭示成源码、Enter 分段、Shift+Enter 写 `\` + 换行，三种状态各要夹具。
                        let multiline_anchor = source_blocks(&src)
                            .into_iter()
                            .find(|b| {
                                let text = &src[b.range.clone()];
                                // **要纯正文**：`#set page(` 这类多行代码块也是 Paragraph、也含单个 LF，
                                // 但往代码里插 `\` 会直接编译失败（实测 "the character `\` is not valid in code"）。
                                // 要"行尾在正文里"的段落：以 `#` 开头的（`#set page(`、`#table(`）整块是代码，
                                // 往里插 `\` 会编译失败；公式里的 `#{…}` 插值不影响行尾是正文。
                                b.kind == "Paragraph"
                                    && text.contains('\n')
                                    && !text.contains("\n\n")
                                    && !text.trim_start().starts_with('#')
                                    && !text.trim_start().starts_with('=')
                                    && !text.contains('`')
                                    && !text.contains("//")
                                    && !text.contains("/*")
                                    && b.range.end.saturating_sub(b.range.start) > 20
                            })
                            .map(|b| b.range.end);
                        match multiline_anchor {
                            Some(ml_pos) => {
                                if src.as_bytes().get(ml_pos) != Some(&b'\n') {
                                    failures.push("编辑回放：单 LF 段落锚点不在换行符上".to_string());
                                } else {
                                    // Enter：复用行尾换行再插一个 → 净增 1 个字符（与单行锚点同一套规则）
                                    let ml_enter = format!("{}{}{}", &src[..ml_pos], "\n", &src[ml_pos..]);
                                    // Enter 的**两种**合法结果都要有夹具：光标正好压在换行字符上时复用那个换行
                                    // （净增 1），否则在光标处插入两个换行（净增 2）。CodeMirror 的行边界语义在这
                                    // 两种情况间切换，前端两种都可能走到，夹具两套都备着。
                                    // Shift+Enter：复用行尾换行 → `\` + 换行（净增 1）；否则插入 `\` + 换行（净增 2）
                                    let ml_soft =
                                        format!("{}\\{}", &src[..ml_pos], &src[ml_pos..]);
                                    // M 与 A 是同一篇原文（不必重复导出）；P/T 那两种"插入"变体在当前
                                    // 断言里用不到（Enter/Shift+Enter 走语义断言），也不导出——夹具越小，
                                    // 一次性注入越不容易把浏览器拖死。
                                    for (key, name, doc) in [
                                        ("N", "单LF段落 Enter 复用换行", &ml_enter),
                                        ("S", "单LF段落 Shift+Enter 复用换行", &ml_soft),
                                    ] {
                                        let json = state_json(name, doc);
                                        println!(
                                            "PKUREPLAY:{}",
                                            serde_json::json!({ "key": key, "fixture": json })
                                        );
                                    }
                                    println!("PKUREPLAYANCHOR2:{}", ml_pos);
                                }
                            }
                            None => failures.push("编辑回放：找不到含单 LF 的段落".to_string()),
                        }
                    }
                } else {
                    failures.push("编辑回放：找不到合适的单行段落锚点".to_string());
                }
            }
            Err(e) => failures.push(format!("编辑回放：读不到 P0：{e}")),
        }
    }
    assert!(
        failures.is_empty(),
        "PKU 夹具导出失败（不允许产出空/残缺夹具）：{failures:#?}"
    );
    assert_eq!(emitted, SAMPLES.len(), "样本数与预期不符");
    println!("PKUCOUNT:{}", SAMPLES.len());
}

#[test]
fn tmp_leading_probe() {
    for (label, src) in [
        ("default", format!("\n\n{}", "字".repeat(90))),
        ("leading0.9", format!("#set par(leading: 0.9em)\n\n{}", "字".repeat(90))),
        ("leading1.5", format!("#set par(leading: 1.5em)\n\n{}", "字".repeat(90))),
    ] {
        let injected = "#set page(width: 487.30pt, height: auto, margin: 58.02pt)\n";
        let world = TypstWorld::new(format!("{injected}{src}"), None, &fonts_dir(), &FontConfig::default());
        let doc = match typst::compile::<PagedDocument>(&world) {
            typst::diag::Warned { output: Ok(d), .. } => d,
            _ => { println!("TMPL {label}: 编译失败"); continue; }
        };
        let (items, _) = collect_geometry(&world, &doc);
        let mut bins: std::collections::BTreeMap<i64, usize> = std::collections::BTreeMap::new();
        for i in &items {
            if i.rect.min.y.to_pt() > 50.0 { *bins.entry((i.baseline_pt * 2.0).round() as i64).or_insert(0) += 1; }
        }
        let mut counts: Vec<(f64, usize)> = bins.iter().map(|(k, c)| (*k as f64 / 2.0, *c)).collect();
        counts.sort_by(|a, b| a.0.total_cmp(&b.0));
        println!("TMPL {label}: 基线分箱 {}（前 12 个按值）: {:?}", counts.len(), &counts[..counts.len().min(12)]);
    }
}
