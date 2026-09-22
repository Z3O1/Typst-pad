// 切带与切片：脚注多带连续、超大块跳过渲图、切片几何不变量、链接热区、前缀偏移。
use super::*;

/// **超大单块只回几何、不渲图**（PR #60 审查第 7 条）：窗口化是按块的，一块自己就很大时
/// （没有空行的长段落 / 2000 行围栏代码块）永远"在窗口内" ⇒ 每按键整块全渲（58 字节/源字符）。
/// 现在超过 `MAX_CROP_SOURCE_BYTES` 的块 `svg` 为空且 `skipped = true`；
/// **`found` 仍为 true**（几何照给，前端格子边界不变），但前端必须按 `skipped` 区分于"缺切片"
/// —— 否则 `found && svg === ""` 会被 `notifyBlocksNeeded` 当成缺切片、每 150ms 重编译一次。
#[test]
fn oversized_block_is_skipped_not_rendered() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25;
    // 1000 行代码 ≈ 35KB，稳稳超过 8KB 的上限；前后各留一个正常段落当对照
    let mut code = String::new();
    for i in 0..1000 {
        code.push_str(&format!("let value_{i} = compute({i}, {i});\n"));
    }
    let doc = format!("第一段正文。\n\n```rust\n{code}```\n\n最后一段正文。\n");
    let out = compile_blocks(
        doc.clone(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
    let big = out
        .blocks
        .iter()
        .find(|b| b.kind == "Raw")
        .expect("应该有那个围栏代码块");
    assert!(
        big.end - big.start > MAX_CROP_SOURCE_BYTES,
        "用例前提：这一块要真的超过上限（实际 {} 字节）",
        big.end - big.start
    );
    assert!(big.found, "几何照给（格子边界不变）");
    assert!(big.skipped, "超大块必须被标成 skipped");
    assert!(big.svg.is_empty(), "超大块不渲图");
    assert!(big.links.is_empty(), "没有图就没有链接热区");

    // 对照组：正常段落照常渲
    let para = out
        .blocks
        .iter()
        .find(|b| b.kind == "Paragraph")
        .expect("应该有段落块");
    assert!(!para.skipped, "正常大小的块不该被跳过");
    assert!(!para.svg.is_empty(), "正常大小的块要渲出图");
}

/// **脚注文档的裁剪带：一块都不许丢、也不许被压扁**（PR #60 审查的第 11 条：
/// 这条回归当年只在 `#[ignore]` 的夹具导出里出现过，没有常驻锁）。
///
/// 背景（CLAUDE.md 里那条红线的由来）：typst 允许把内容排到远处（脚注正文在页底），
/// 而块的墨迹包围盒是**并集** —— 带脚注的段落会得到一个一直伸到页底的高盒子，
/// 把后面几块的中点切带压扁：实测代码块被压到 ≤0.5pt（切片被丢弃 → 回退成源码，
/// 而它的内容又被那张超长切片又画了一遍，截图里代码块出现两次）。
/// 现在 `compile_blocks` 的第 2b 步把每块的 bottom 夹到 y 序下一个块的顶。
#[test]
fn footnote_doc_keeps_every_band_and_stays_contiguous() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25;
    let doc = "= 结构与脚注\n\n                   正文里有一个脚注#footnote[脚注正文会被排到页底]，这是写作模式的已知不足点。\n\n\n                   ```rust\nfn main() {\n    println!(\"hello\");\n}\n```\n\n                   #table(columns: 2, [甲], [乙], [1], [2])\n\n                   表格之后的段落。\n";
    let out = compile_blocks(
        doc.to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
    // ① 一块都不许丢：每块都找得到几何，而且真的有切片（空 SVG 会被前端当成"不可渲染"）
    let dropped: Vec<(usize, f64, bool)> = out
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| !b.found || b.svg.is_empty())
        .map(|(i, b)| (i, b.height_pt, b.found))
        .collect();
    assert!(
        dropped.is_empty(),
        "不该有块被丢掉（索引/带高/找到没）: {dropped:?}"
    );
    // ② 一块都不许被压扁（最小带 0.75pt）
    let squashed: Vec<(usize, f64)> = out
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.height_pt < 0.75)
        .map(|(i, b)| (i, b.height_pt))
        .collect();
    assert!(
        squashed.is_empty(),
        "裁剪带被压扁了（脚注段吞掉了后面的块？）: {squashed:?}"
    );
    // ③ **首尾相接**：同页相邻块 i 的底 == 块 i+1 的顶（"切片摞起来 == 原版式"的来源，
    //    也是夹紧生效的判据 —— 不夹紧时脚注段的底会远超下一块的顶）
    for w in out.blocks.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if a.page != b.page {
            continue;
        }
        let a_bottom = a.y_pt + a.height_pt;
        assert!(
            a_bottom <= b.y_pt + 0.01,
            "相邻切片必须首尾相接（不许重叠）：块 {} 底 {a_bottom:.2} > 块顶 {:.2}",
            a.start,
            b.y_pt
        );
        assert!(
            (a_bottom - b.y_pt).abs() < 0.51,
            "相邻切片之间不该有空隙：块 {} 底 {a_bottom:.2} vs 块顶 {:.2}",
            a.start,
            b.y_pt
        );
    }
}

/// **切片几何不变量**（真实引擎产物，常驻测试）：
///  ① 每块宽度 = 正文列宽（横向切的是列不是墨迹）；
///  ② 各块高度之和 = 首块顶到底块底的纵向跨度（相邻块按中点分间距 ⇒ 摞起来不丢高度）；
///  ③ 按 y 序相邻块不重叠（能像积木一样堆叠）；
///  ④ 块区间按源码顺序递增不重叠（前端靠它切"源码透镜"的边界）。
#[test]
fn block_crop_geometry_invariants() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25;
    for (name, src) in GEOMETRY_DOCS {
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
        let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
        assert!(
            rendered.len() >= 3,
            "[{name}] 应切出多块，实际 {}",
            rendered.len()
        );

        for b in &rendered {
            assert!(
                (b.width_pt - COLUMN_PT).abs() < 0.5,
                "[{name}] 切片宽度应等于正文列宽：{} vs {COLUMN_PT}",
                b.width_pt
            );
            // **最小带高是 0.75pt**（见切带那段 `(band_bottom - band_top).max(0.75)`）——
            // 别退回 `> 0.5` 那种"几乎恒真"的断言：当年脚注把带压到 ≤0.5pt 时，切片被丢弃、
            // 正文重复渲染，而这条断言照样绿（PR #60 审查第 11 条）。
            assert!(
                b.height_pt >= 0.74,
                "[{name}] 切片带高不该低于最小带（0.75pt）：{}",
                b.height_pt
            );
        }

        // ② 高度之和 = 纵向跨度（首块顶 → 末块底）
        let mut by_y: Vec<&BlockCrop> = rendered.clone();
        // `total_cmp` 而不是 `partial_cmp().unwrap()`：NaN 会 panic 在整个编译命令里
        // （与上面 order.sort_by 同一个理由，PR #60 审查第 10 条）
        by_y.sort_by(|a, b| a.y_pt.total_cmp(&b.y_pt));
        let span = by_y.last().unwrap().y_pt + by_y.last().unwrap().height_pt - by_y[0].y_pt;
        let total: f64 = by_y.iter().map(|b| b.height_pt).sum();
        assert!(
            (total - span).abs() < 1.0,
            "[{name}] 各块高度之和 {total:.2} 应等于纵向跨度 {span:.2}（中点切带不丢高度）"
        );

        // ③ 相邻块不重叠（允许 0.5pt 的浮点误差）
        for pair in by_y.windows(2) {
            let prev_bottom = pair[0].y_pt + pair[0].height_pt;
            assert!(
                pair[1].y_pt >= prev_bottom - 0.5,
                "[{name}] 相邻块重叠了：{:?} 底 {prev_bottom:.2} → 下一块顶 {:.2}",
                pair[0].kind,
                pair[1].y_pt
            );
        }

        // ④ 源码顺序递增不重叠
        for pair in out.blocks.windows(2) {
            assert!(pair[0].end <= pair[1].start, "[{name}] 块区间应递增不重叠");
        }
    }
}

/// 写作模式的块级渲染：区块要切得出来、宽度等于正文列宽、高度之和 ≈ 版心高度
#[test]
fn writing_mode_block_crops_are_sane() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25; // = 495px（写作模式常见正文列宽）
    let src = "= 标题\n\n第一段正文，写得长一点以便观察断行与段落间距。\n\n- 列表项一\n- 列表项二\n\n$ integral_0^1 f(x) dif x $\n\n结尾段落。\n";
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
    assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
    assert!(out.pages == Some(1), "page(height: auto) 应为单张长页");

    let rendered: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.svg.is_empty()).collect();
    assert!(
        rendered.len() >= 5,
        "标题/段落/列表项/公式/结尾段都应渲染出切片，实际 {} 个（共 {} 块）",
        rendered.len(),
        out.blocks.len()
    );
    for b in &rendered {
        assert!(
            b.svg.contains("<svg"),
            "切片应是 SVG：{}",
            &b.svg[..b.svg.len().min(60)]
        );
        assert!(
            (b.width_pt - COLUMN_PT).abs() < 0.5,
            "切片宽度应等于正文列宽 {}，实际 {}",
            COLUMN_PT,
            b.width_pt
        );
        assert!(b.height_pt > 0.5, "切片高度应为正：{}", b.height_pt);
        assert!(b.found && b.pages == 1);
    }
    // 块区间按源码顺序递增且不重叠（前端要靠它切"源码透镜"的边界）
    for pair in out.blocks.windows(2) {
        assert!(pair[0].end <= pair[1].start, "块区间应递增不重叠");
    }
    // 纵向总高度 = 首块顶到末块底（带间中点切分不丢高度）
    let total: f64 = rendered.iter().map(|b| b.height_pt).sum();
    let span = rendered.last().unwrap().y_pt + rendered.last().unwrap().height_pt
        - rendered.first().unwrap().y_pt;
    assert!(
        (total - span).abs() < 1.0,
        "各块高度之和 {total} 应等于首末块的纵向跨度 {span}"
    );
}

/// **链接热区**（阶段 3"链接可点"）：`#link("url")[文字]` 画出来的方框要被收进那一块，
/// 坐标是"带内相对 pt"、href 原样；页内目标与非 http(s)/mailto 协议不收。
#[test]
fn block_crops_carry_link_hotspots() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25;
    let doc = "看这里：\n\n更多内容见 #link(\"https://typst.app/docs\")[官方文档]，也可以点 #link(\"https://example.com/a\")[这个例子]。\n\n- 列表里的 #link(\"mailto:a@b.c\")[邮件] 也要能点。\n";
    let out = compile_blocks(
        doc.to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
    let with_links: Vec<&BlockCrop> = out.blocks.iter().filter(|b| !b.links.is_empty()).collect();
    assert_eq!(
        with_links.len(),
        2,
        "段落与列表各自带链接：{:?}",
        with_links.len()
    );

    let hrefs: Vec<&str> = out
        .blocks
        .iter()
        .flat_map(|b| b.links.iter().map(|l| l.href.as_str()))
        .collect();
    assert_eq!(
        hrefs,
        vec![
            "https://typst.app/docs",
            "https://example.com/a",
            "mailto:a@b.c"
        ],
        "三个链接都要在，且按出现顺序"
    );

    for block in &with_links {
        assert!(block.height_pt > 0.5 && !block.svg.is_empty());
        for link in &block.links {
            // 热区必须落在这一块的带内（换算成"带内相对 pt"没算错），且尺寸为正
            assert!(
                link.width_pt > 1.0 && link.height_pt > 1.0,
                "热区尺寸应为正：{:?}",
                link
            );
            assert!(
                link.x_pt >= -0.5 && link.x_pt + link.width_pt <= block.width_pt + 0.5,
                "热区横向应在带内：{:?}（带宽 {}）",
                link,
                block.width_pt
            );
            assert!(
                link.y_pt >= -0.5 && link.y_pt + link.height_pt <= block.height_pt + 0.5,
                "热区纵向应在带内：{:?}（带高 {}）",
                link,
                block.height_pt
            );
        }
    }

    // 没有链接的文档 → 一个热区也没有（不能凭空造）
    let plain = compile_blocks(
        "= 标题\n\n普通一段。\n".to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(plain.ok);
    assert!(
        plain.blocks.iter().all(|b| b.links.is_empty()),
        "没有链接就不该有热区"
    );

    // 页内目标（`#link(<label>)`）不当作外部 URL：热区为空（映射回源码位置属后续工作）
    let internal = compile_blocks(
        "= 标题 <sec>\n\n见 #link(<sec>)[第一节]。\n".to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(internal.ok, "编译应成功：{:?}", internal.diagnostics);
    assert!(
        internal.blocks.iter().all(|b| b.links.is_empty()),
        "页内跳转暂时不收：{:?}",
        internal.blocks.iter().map(|b| &b.links).collect::<Vec<_>>()
    );
}
