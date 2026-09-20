// 视口窗口化：窗口限流与载荷上界（长文档不能一次全渲）。
use super::super::*;
use super::*;

/// 窗口化：窗口内的块有切片，窗口外的块只有几何（`found` 为 true、svg 为空）
#[test]
fn writing_mode_window_limits_crops() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    let src = "= 标题\n\n第一段。\n\n第二段。\n\n第三段。\n";
    let out_all = compile_blocks(
        src.to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        371.25,
        None,
        None,
    );
    assert!(out_all.ok);
    let all_svgs = out_all.blocks.iter().filter(|b| !b.svg.is_empty()).count();
    assert!(all_svgs >= 3, "全渲时应有多个切片，实际 {all_svgs}");

    // 窗口只覆盖文档最前面几个字节 → 只有第一个块出切片
    let out_win = compile_blocks(
        src.to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        371.25,
        Some(0),
        Some(3),
    );
    assert!(out_win.ok);
    let win_svgs = out_win.blocks.iter().filter(|b| !b.svg.is_empty()).count();
    assert!(
        win_svgs < all_svgs,
        "窗口化应减少切片数量：{win_svgs} vs {all_svgs}"
    );
    assert!(win_svgs >= 1, "窗口内的块仍要出切片");
    // 窗口外的块仍要回几何（前端要靠它判断"这块能渲染，只是还没渲"）
    assert!(out_win.blocks.iter().filter(|b| b.found).count() >= 3);
}

/// **窗口化回归网**：窗口外的块不许出 SVG（否则长文档每按键要传十几 MB）。
///
/// 断言用**产物字节数与块数**（确定性），不用耗时（机器/构建不同会飘）——
/// 耗时只在下面 `dump_long_doc_blocks` 里按需打印。
#[test]
fn windowing_keeps_payload_bounded() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    let mut src = String::from("= 长文档\n\n");
    for i in 0..160 {
        src.push_str(&format!(
            "第 {i} 段正文，用来把文档撑长，观察窗口化是否真的把产物压住了。这一段里放一个行内公式 $a_{i} + b_{i}$，\n                 再补一句普通中文，让每个段落都有两三行。\n\n"
        ));
    }
    let column = 371.25;
    // 全渲（对照）：这是**不许**出现在按键路径上的量级
    let all = compile_blocks(
        src.clone(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        column,
        None,
        None,
    );
    assert!(all.ok, "{:?}", all.diagnostics);
    let all_blocks = all.blocks.iter().filter(|b| !b.svg.is_empty()).count();
    let all_bytes: usize = all.blocks.iter().map(|b| b.svg.len()).sum();
    assert!(all_blocks > 100, "对照用例应有大量块，实际 {all_blocks}");

    // 窗口化：只给中间 4000 个字节（模拟视口窗口）
    let win = compile_blocks(
        src.clone(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        column,
        Some(8000),
        Some(12000),
    );
    assert!(win.ok, "{:?}", win.diagnostics);
    let win_blocks = win.blocks.iter().filter(|b| !b.svg.is_empty()).count();
    let win_bytes: usize = win.blocks.iter().map(|b| b.svg.len()).sum();
    assert!(
        win_blocks * 20 < all_blocks * 3,
        "窗口内的块数应远少于全渲：{win_blocks} vs {all_blocks}"
    );
    assert!(
        win_bytes * 10 < all_bytes * 2,
        "窗口化产物应压到全渲的 20% 以下：{win_bytes} vs {all_bytes} 字节"
    );
    // 窗口外的块仍要回几何（前端靠它判断"这块能渲染，只是还没渲"）
    assert_eq!(
        win.blocks.iter().filter(|b| b.found).count(),
        all.blocks.iter().filter(|b| b.found).count(),
        "窗口化不该丢掉任何块的几何"
    );
    println!(
        "WINDOWING: 全渲 {all_blocks} 块 / {}KB，窗口内 {win_blocks} 块 / {}KB",
        all_bytes / 1024,
        win_bytes / 1024
    );
}
