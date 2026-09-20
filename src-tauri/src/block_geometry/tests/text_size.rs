// 文档正文字号：按字符数取众数 + 上下限收敛。
use super::super::*;
use super::*;

/// **正文正字号要夹在合理区间里**（PR #60 审查第 7 条的附带项）。
/// 这个值会变成编辑区正文字号（`--write-doc-px = textPt × 4/3`），不夹的话
/// 文档写个 `#set text(size: 400pt)` 就把编辑区撑成"一行一个字"。
#[test]
fn document_text_pt_is_clamped() {
    let mut stats = FrameStats::default();
    // 投票投出一个离谱的大字号
    stats.size_weights.insert(40_000, 99);
    assert_eq!(document_text_pt(&stats), MAX_TEXT_PT);
    // 以及一个离谱的小字号
    let mut tiny = FrameStats::default();
    tiny.size_weights.insert(100, 99);
    assert_eq!(document_text_pt(&tiny), MIN_TEXT_PT);
    // 正常字号原样通过（11pt 是 typst 默认）
    let mut normal = FrameStats::default();
    normal.size_weights.insert(1_100, 99);
    assert!((document_text_pt(&normal) - 11.0).abs() < 1e-9);
}

/// **源码透镜的字号基准 = 文档正文实际字号**（用户：「不要光标在哪里哪里就变大了」）：
/// 取帧里各字号的**字符数众数** —— 默认文档应当是 11pt，`#set text(size: 12pt)` 的文档 12pt，
/// 标题（更大）与代码块（等宽、字号可能不同）都不能把基准带跑。
#[test]
fn document_text_size_follows_the_document() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    let cases: [(&str, f64); 3] = [
        ("正文一段。再来一句，字符数要够多。\n\n= 标题\n\n又一段正文。\n", 11.0),
        (
            "#set text(size: 12pt)\n\n正文一段。再来一句，字符数要够多。\n\n= 标题\n\n又一段正文。\n",
            12.0,
        ),
        // 只有图形、没有文本（空文档）：回落到 typst 默认 11pt
        ("", 11.0),
    ];
    for (src, want) in cases {
        let out = compile_blocks(
            src.to_string(),
            0,
            None,
            &fonts_dir(),
            &FontConfig::default(),
            371.25,
            None,
            None,
        );
        assert!(out.ok, "编译应当成功：{src:?}");
        assert!(
            (out.text_pt - want).abs() < 0.01,
            "文档正文实际字号应当是 {want}pt，实际 {}（src={src:?}）",
            out.text_pt
        );
    }
}
