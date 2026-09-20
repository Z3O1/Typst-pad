// block_geometry 的单元测试（原 `mod tests`，逐字搬出，只去掉一层缩进）。
use super::*;
// 探针（`ProbeBlock` / `ProbeReport` / `probe_blocks`）由 `use super::*` 带进来 ——
// mod.rs 现在有 `pub use probe::*`（与拆分前的对外路径一致），不必再单独 `use super::probe::*`。

/// **命中几何是进程级全局的**（`HIT_CACHE` 只保留"最近一次 `compile_blocks`"的字形几何）。
/// 生产路径没问题：前端只对刚编译过的同一篇文档做命中测试，前面还有"块表必须与当前文档一致"
/// 的闸门。但**测试是并行跑的** —— 两个用例同时编译不同文档时，后者的几何会覆盖前者，
/// 命中断言就读到了别人的排版。实测：`hit_test_on_real_layout_maps_edges_to_block_bounds`
/// 单独跑绿、跑全集红（期望 `Some(0)` 拿到 `Some(2)`，正好差一个前缀的长度）。
/// 所以凡是**写**缓存（调 `compile_blocks`）或**读**缓存（调 `hit_test`）的用例都先拿这把锁，
/// 让它们串行；`pick_hit` 那种纯函数用例不受影响（自造 items）。
static HIT_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// 拿测试锁（用 `into_inner` 兜住中毒：某个用例 panic 了也要放别人过去）
fn hit_cache_guard() -> std::sync::MutexGuard<'static, ()> {
    HIT_CACHE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

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
use std::path::PathBuf;

fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

/// 造一个字形项：源区间 + 版面矩形（页面坐标）
fn item(page: usize, range: Range<usize>, x0: f64, y0: f64, x1: f64, y1: f64) -> PlacedItem {
    PlacedItem {
        page,
        range,
        rect: Rect::new(
            Point::new(Abs::pt(x0), Abs::pt(y0)),
            Point::new(Abs::pt(x1), Abs::pt(y1)),
        ),
    }
}

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

/// 真实文档样例：覆盖标题 / 段落 / 列表 / 行内与行间公式 / 围栏代码 / 表格 / 图 / 脚注 /
/// `#show` 规则 / 前缀宏 —— 阶段 0 就是拿它们量"能不能切干净"
const DOCS: &[(&str, &str)] = &[
    (
        "散文（中文 + 行内公式）",
        "= 第一章 引言\n\n\
             本文讨论 $a^2 + b^2 = c^2$ 这个恒等式，以及它在\n\
             实际排版里的表现。这里再放一个行内的 $alpha + beta$ 收尾。\n\n\
             == 小节标题\n\n\
             第二段的文字，用来观察段落之间的间距是否被正确切分出来。\n",
    ),
    (
        "列表 + 有序列表 + 行间公式",
        "= 清单\n\n\
             - 第一项\n\
             - 第二项\n\
               - 嵌套项\n\n\
             + 有序一\n\
             + 有序二\n\n\
             下面是一个行间公式：\n\n\
             $ integral_0^1 f(x) dif x = 1 $\n\n\
             公式之后的收尾段落。\n",
    ),
    (
        "代码块 + 表格 + 强调",
        "= 结构\n\n\
             正文里有 *粗体*、_斜体_ 与 `行内代码`。\n\n\
             ```rust\n\
             fn main() { println!(\"hi\"); }\n\
             ```\n\n\
             #table(\n\
               columns: 2,\n\
               [甲], [乙],\n\
               [1], [2],\n\
             )\n\n\
             表格之后的段落。\n",
    ),
    (
        "宏 / show 规则 / 脚注 / 引用",
        "#let name = \"Typst\"\n\
             #show heading: it => text(fill: rgb(\"#1d4ed8\"), it)\n\n\
             = 带宏的文档\n\n\
             这个文档用了宏 #name 和脚注#footnote[这是脚注正文，会被排到页底]。\n\n\
             = 第二个标题\n\n\
             这里不放交叉引用，只看几何是否切得干净。\n",
    ),
    (
        "长段落（观察多行与分页）",
        "= 长段落\n\n\
             #lorem(180)\n",
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

/// 供"切片几何等价"验收用的样例文档（真实产物夹具与不变量测试共用）。
/// **每条都是一行字面量**：用源码续行（`\` 换行）写会被续行的缩进带进文档文本，
/// 而 typst 把缩进 4+ 空格的段落当代码块 → 直接编译报错（实测踩过）。
const GEOMETRY_DOCS: &[(&str, &str)] = &[
    (
        "段落与标题",
        "= 第一章\n\n第一段正文，两行以上比较好，用来观察块间距是否被正确分到相邻两块。继续这一段的第二行文字。\n\n== 小节\n\n第二段正文。\n",
    ),
    (
        "列表",
        "= 清单\n\n- 第一项\n- 第二项\n  - 嵌套项\n\n+ 有序一\n+ 有序二\n\n收尾段落。\n",
    ),
    (
        "公式与代码",
        "= 公式\n\n行内 $a^2 + b^2$ 与行间：\n\n$ integral_0^1 f(x) dif x = 1 $\n\n```rust\nfn main() {}\n```\n\n代码之后的段落。\n",
    ),
];

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
        "列表与嵌套",
        "= 清单\n\n- 第一项：无序列表\n- 第二项：带嵌套\n  - 嵌套一\n  - 嵌套二\n- 第三项\n\n+ 有序一\n+ 有序二\n+ 有序三\n\n列表之后的收尾段落。\n",
    ),
    (
        "公式",
        "= 公式\n\n行内公式 $a^2 + b^2 = c^2$ 要与正文基线对齐。\n\n行间公式：\n\n$ sum_(i=1)^n i = frac(n(n+1), 2) $\n\n带下沉的 $integral_0^1 f(x) dif x$ 与下标 $a_0 = 0$ 也要完整。\n",
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

/// 生成点击探针：在每个可渲染块的裁剪带里取「横向 5 × 纵向 3」个网格点，
/// 每个点都过一遍**真实的** `hit_test`，把答案记下来当期望值。
///
/// 为什么用网格而不是"每个字形取一个点"：夹具要能在**浏览器里原样复现**，
/// 网格点是任意的 (x, y)，不依赖前端知道字形的位置；而期望值来自真实几何，
/// 端到端验的还是"点在哪儿 → 光标落在哪个字符"。
fn hit_probes(out: &BlocksOutput) -> Vec<serde_json::Value> {
    const XF: &[f64] = &[0.06, 0.3, 0.5, 0.7, 0.98];
    const YF: &[f64] = &[0.2, 0.55, 0.85];
    let mut probes = Vec::new();
    for (idx, b) in out.blocks.iter().enumerate() {
        if !b.found || b.svg.is_empty() || b.height_pt <= 0.5 {
            continue;
        }
        for &yf in YF {
            for &xf in XF {
                let x = b.x_pt + b.width_pt * xf;
                let y = b.y_pt + b.height_pt * yf;
                if let Some(offset) = hit_test(b.start, b.end, b.page, x, y, None) {
                    // 保留两位小数：浏览器侧按这个值算视口坐标，误差 < 0.01pt 不会改变命中结果
                    probes.push(serde_json::json!({
                        "b": idx,
                        "x": (x * 100.0).round() / 100.0,
                        "y": (y * 100.0).round() / 100.0,
                        "o": offset,
                    }));
                }
            }
        }
    }
    probes
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
