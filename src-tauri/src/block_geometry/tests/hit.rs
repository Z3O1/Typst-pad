// 点击定位与命中几何：`pick_hit` 纯函数、真实排版下的边界命中、多窗口几何编号校验。
use super::*;

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

/// **几何编号对不上就拒绝命中**（PR #60 审查的第 4 条：多窗口串味）。
///
/// `HIT_CACHE` 是**进程级**的，而应用支持多窗口：窗口 A 编译完、窗口 B 又编译一次之后，
/// A 再点击就会拿 B 的排版几何去找最近字形 —— 结果被钳进 A 的块区间，**点错字而不报错**。
/// 所以 `compile_blocks` 返回几何编号、`block_hit_test` 带回来比对：对不上 → None
/// （前端退回"光标落到块首"）。不带编号（旧前端 / 内部探针）仍按老行为直接用。
#[test]
fn hit_test_refuses_geometry_owned_by_another_compile() {
    let _hit_cache = hit_cache_guard();
    const COLUMN_PT: f64 = 371.25;
    // 另一个"窗口"的字体目录/配置与主用例一致，只有文档不同
    let other = compile_blocks(
        "另一篇文档。\n".to_string(),
        0,
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(other.ok, "编译应成功：{:?}", other.diagnostics);
    assert!(other.geometry_id > 0, "成功编译要发一个非零几何编号");

    let doc = "甲乙丙丁戊己庚辛\n";
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
    let b = &out.blocks[0];
    let (x, y) = (b.x_pt + 0.5, b.y_pt + b.height_pt * 0.5);

    // 自己的编号 → 命中（几何确实是这一轮的）
    assert_eq!(
        hit_test(b.start, b.end, b.page, x, y, Some(out.geometry_id)),
        Some(b.start),
        "编号对得上就该命中"
    );
    // 别人的编号 → 拒绝（这一时期缓存里是"另一篇文档"的排版）
    assert_eq!(
        hit_test(b.start, b.end, b.page, x, y, Some(other.geometry_id)),
        None,
        "编号对不上必须拒绝命中（多窗口下会点错字）"
    );
    // 旧前端不带编号：兼容旧行为
    assert_eq!(
        hit_test(b.start, b.end, b.page, x, y, None),
        Some(b.start),
        "不带编号时不校验（旧前端 / 探针）"
    );
}

/// **真实引擎几何 + 真实字节偏移**：单行块的左缘 → 块首，右缘 → 块尾（含 CJK 3 字节）。
#[test]
fn hit_test_on_real_layout_maps_edges_to_block_bounds() {
    let _hit_cache = hit_cache_guard(); // 命中几何是全局的，见上面的说明
    const COLUMN_PT: f64 = 371.25;
    // 一行的短段落（不折行）+ 一个会折成好几行的长段落
    let doc = "甲乙丙丁戊己庚辛\n\n这是一段很长的中文正文，它会在版心宽度里折成好几行，用来验证纵向的命中判定：点的位置越往下，落在源码里的字符就应该越靠后，而横向的点则决定光标落在字的哪一侧。收尾。\n";
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
    let single = &out.blocks[0];
    let para = &out.blocks[1];
    assert!(single.found && para.found);

    // 单行块：横向两端必定落在块首 / 块尾（y 取带里任意高度都行 —— 同一行的字形纵向距离相同）
    let y = single.y_pt + single.height_pt * 0.5;
    let left = hit_test(
        single.start,
        single.end,
        single.page,
        single.x_pt + 0.5,
        y,
        None,
    );
    let right = hit_test(
        single.start,
        single.end,
        single.page,
        single.x_pt + single.width_pt - 0.5,
        y,
        None,
    );
    assert_eq!(left, Some(single.start), "左缘 → 块首");
    assert_eq!(right, Some(single.end), "右缘 → 块尾（= 该行行尾）");

    // 多行块：越往下，偏移越大（纵向判定真的在看 y）
    let x = para.x_pt + 4.0;
    let top = hit_test(
        para.start,
        para.end,
        para.page,
        x,
        para.y_pt + para.height_pt * 0.12,
        None,
    )
    .expect("上部的点应该命中");
    let bottom = hit_test(
        para.start,
        para.end,
        para.page,
        x,
        para.y_pt + para.height_pt * 0.88,
        None,
    )
    .expect("下部的点应该命中");
    assert!(
        top >= para.start && bottom <= para.end,
        "结果必须钳在块区间内：{top}/{bottom} vs {}..{}",
        para.start,
        para.end
    );
    assert!(
        bottom > top + 10,
        "越往下偏移越大（上 {top} / 下 {bottom}，块 {}..{}）",
        para.start,
        para.end
    );

    // 前缀偏移：块的区间是**文档坐标**，命中结果也必须是（不会把前缀的字节算进来）
    let prefix = "#set text(size: 12pt)\n";
    let src = format!("{prefix}{doc}");
    let out2 = compile_blocks(
        src,
        prefix.len(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(out2.ok);
    assert_eq!(out2.blocks[0].start, 0, "块区间是文档坐标");
    let y2 = out2.blocks[0].y_pt + out2.blocks[0].height_pt * 0.5;
    let hit2 = hit_test(
        out2.blocks[0].start,
        out2.blocks[0].end,
        out2.blocks[0].page,
        out2.blocks[0].x_pt + 0.5,
        y2,
        None,
    );
    assert_eq!(hit2, Some(0), "带前缀时命中结果仍是文档坐标");
}

/// 简单文档上跑一次几何映射：标题、段落、公式都应能定位到。
///
/// 覆盖率阈值定在 0.6 而不是 1.0：**标记语法字符本身不产生字形**（标题的 `=`、公式的 `$`、
/// 上标的 `^`、粗体的 `*`、行内代码的反引号…），所以短文档里它们的占比很高。
#[test]
fn geometry_finds_typical_blocks() {
    let src = "= 标题\n\n正文一段，后面还有一句普通的中文句子用来拉高正文比例。\n\n$ x^2 $\n";
    let report = probe_blocks(
        src.to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        495.0,
    );
    assert!(report.ok, "应编译成功: {:?}", report.error);
    assert_eq!(report.pages, 1, "page(height: auto) 应为单张长页");
    assert!(
        report.blocks_found >= 3,
        "标题/正文/公式都应找到几何：{}/{}",
        report.blocks_found,
        report.blocks_total
    );
    assert!(
        report.glyphs_mapped > 0 && report.glyphs_mapped * 10 >= report.glyphs_total * 9,
        "九成以上字形应能映射回源码：{}/{}",
        report.glyphs_mapped,
        report.glyphs_total
    );
    assert!(
        report.coverage_ratio > 0.6,
        "正文覆盖率过低：{:.2}（{}/{}）",
        report.coverage_ratio,
        report.covered_chars,
        report.content_chars
    );
}
