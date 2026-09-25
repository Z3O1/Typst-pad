// 源块划分：typst 语义（空行分段 / `=` 标题 / 列表项 / 围栏各自成块）+ 失败形状（`blocks` 键必须在）。
use super::*;

/// **编译失败时 `blocks` 键也必须在**（PR #60 审查抓到的真机 bug 的锁）。
///
/// 前端用"`blocks` 是不是数组"区分「后端没实现这个命令」与「这次编译失败」；
/// 早先 `blocks` 带 `skip_serializing_if = "Vec::is_empty"`，而 `fail()` 正是把它置空 ⇒
/// 失败 JSON 里根本没有这个键 ⇒ 真机上**任何 typst 错误**都被读成"后端不支持"、
/// 退回整页预览路径（切片不撤、错误块不展开）。浏览器验收抓不到，因为**桩自己补了
/// `blocks: []`**；所以这条断言要钉在 Rust 侧的序列化形状上。
#[test]
fn failure_output_always_carries_blocks_key() {
    let diag = crate::typst_world::Diagnostic {
        message: "boom".into(),
        severity: "error".into(),
        line: 1,
        column: 1,
        end_line: Some(1),
        end_column: Some(2),
        path: None,
    };
    let json = serde_json::to_string(&BlocksOutput::fail(vec![diag], 420.0)).unwrap();
    assert!(
        json.contains(r#""blocks":[]"#),
        "编译失败也要发 blocks 键（空数组），否则前端会当成「后端不支持」: {json}"
    );
    assert!(json.contains(r#""ok":false"#), "失败标志要在: {json}");
    // 成功路径同理（空文档 / 全是无输出块的文档 → 块表就是空的）
    let empty_ok = BlocksOutput {
        ok: true,
        blocks: Vec::new(),
        pages: Some(1),
        page_width_pt: 420.0,
        text_pt: DEFAULT_TEXT_PT,
        geometry_id: 7,
        diagnostics: Vec::new(),
        warnings: Vec::new(),
    };
    let json = serde_json::to_string(&empty_ok).unwrap();
    assert!(json.contains(r#""blocks":[]"#), "空块表也要发键: {json}");
}

/// **分块判据必须跟 typst 语义走**（真实文档咬过一次：`$x$` 是行内公式，哪怕独占整行也
/// 不打断段落 —— 按"独占整行"把它当块，会让连续几个 `$x$` 的带互相重叠，看起来"公式挤成一团"）。
#[test]
fn block_partition_matches_typst_semantics() {
    let blocks = |src: &str| {
        source_blocks(src)
            .into_iter()
            .map(|b| (b.kind, src[b.range].to_string()))
            .collect::<Vec<_>>()
    };

    // ① `$x$`（内侧无空白）= 行内公式：独占整行也留在段落里 → 连排的三个公式是**一块**
    let inline = "设 $a=1$\n$b=2$\n$c=3$\n";
    let got = blocks(inline);
    assert_eq!(got.len(), 1, "行内公式不该把段落切开：{got:?}");
    assert_eq!(got[0].0, "Paragraph");

    // ② `$ x $`（内侧有空白）= 行间公式：自成一块（独占整行）
    let display = "前文。\n\n$ a + b = c $\n\n后文。\n";
    let got = blocks(display);
    assert!(
        got.iter()
            .any(|(k, t)| *k == "Equation" && t.contains("a + b")),
        "行间公式应自成一块：{got:?}"
    );
    assert_eq!(
        got.iter().filter(|(k, _)| *k == "Paragraph").count(),
        2,
        "前后各有段落"
    );

    // ③ 行内 raw（单反引号）不是块；围栏 raw 是块
    let raw = "正文里有 `code` 一段。\n\n```rust\nfn main() {}\n```\n\n后文。\n";
    let got = blocks(raw);
    assert_eq!(
        got.iter().filter(|(k, _)| *k == "Raw").count(),
        1,
        "只有围栏算块：{got:?}"
    );
    assert!(
        got.iter().any(|(k, t)| *k == "Raw" && t.starts_with("```")),
        "块级 raw 应该是那段围栏：{got:?}"
    );

    // ④ 行间公式写在行中间也自成一块（typst 会打断段落）
    let mid = "前文 $ a + b $ 后文。\n";
    let got = blocks(mid);
    assert!(
        got.iter().any(|(k, _)| *k == "Equation"),
        "行中间的行间公式也应自成一块：{got:?}"
    );
}

/// 单个源码换行仍是同一段，空白行才分段；多留空行不应产生空的可见段落。
/// 这是写作模式里 `1\n\n1` 多出空行问题的后端边界。
#[test]
fn paragraph_partition_distinguishes_soft_source_newline_from_blank_line() {
    for (src, expected_paragraphs) in [
        ("1\n1", 1),
        ("1\n\n1", 2),
        ("1\n \n1", 2),
        ("1\n\n\n1", 2),
        ("\n\n1\n\n", 1),
    ] {
        let paragraphs = source_blocks(src)
            .into_iter()
            .filter(|block| block.kind == "Paragraph")
            .count();
        assert_eq!(
            paragraphs, expected_paragraphs,
            "段落划分与 Typst 换行语义不符: {src:?}"
        );
    }
}

/// 前缀代码（设置里的编译前缀）不进块区间：返回的偏移应是**用户文档坐标**
#[test]
fn writing_mode_blocks_ignore_prefix_offset() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    let prefix = "#set text(size: 12pt)\n";
    let doc = "= 标题\n\n正文。\n";
    let src = format!("{prefix}{doc}");
    let out = compile_blocks(
        src,
        prefix.len(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        371.25,
        None,
        None,
    );
    assert!(out.ok);
    // 第一个块（标题）应从文档的第 0 字节开始，而不是前缀之后
    let first = out.blocks.first().expect("应有块");
    assert_eq!(first.start, 0, "块偏移应是文档坐标（已减掉前缀）");
    assert!(first.end <= doc.len(), "块区间不应超出文档长度");
    assert!(!first.svg.is_empty(), "标题应渲染出切片");
}
