// **文字对应证明**的反例与正常案例（真实后端，常驻）。
//
// 任务 0 要求的反例都在这里：纯文字、样式型 show rule、文字替换型 show rule、同一源码输出两次、
// 宏生成文字、来自其它源文件的可见内容；正常案例覆盖标题、强调、行内公式、标签、列表。
//
// 判据只有一条：**只有能严格证明的块才是 `verified`**。证不出来的一律 `unknown`（前端切片）。
use super::*;

const COLUMN_PT: f64 = 371.25;

/// 编译一份文档并拿到块表
fn blocks_of(doc: &str) -> BlocksOutput {
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
    out
}

/// 找到源码文本包含 `needle` 的那一块（`needle` 相对用户文档坐标）
fn block_at<'a>(out: &'a BlocksOutput, doc: &str, needle: &str) -> &'a BlockCrop {
    let at = doc
        .find(needle)
        .unwrap_or_else(|| panic!("找不到 {needle:?}"));
    out.blocks
        .iter()
        .find(|b| b.start <= at && at < b.end)
        .unwrap_or_else(|| panic!("{needle:?}（{at}）不在任何块里：{:?}", out.blocks))
}

/// 这一块的证明结论与原因码
fn proof_of<'a>(out: &'a BlocksOutput, doc: &str, needle: &str) -> &'a BlockEditProof {
    block_at(out, doc, needle)
        .edit
        .as_ref()
        .unwrap_or_else(|| panic!("{needle:?} 所在的块没有证明"))
}

/// 正常案例：这些块的文字必须**能**证明
fn assert_verified(doc: &str, needle: &str) {
    let out = blocks_of(doc);
    let proof = proof_of(&out, doc, needle);
    assert_eq!(
        proof.verdict, "verified",
        "{needle:?} 应能证明（reason={}）：{:?}",
        proof.reason, proof.source
    );
    // 证明里带的源码必须就是这一块的文本（前端靠它拦"旧结果套新文档"）
    let block = block_at(&out, doc, needle);
    assert_eq!(proof.source, &doc[block.start..block.end]);
}

/// 反例：这些块的文字必须**证不出来**
fn assert_unknown(doc: &str, needle: &str) {
    let out = blocks_of(doc);
    let block = block_at(&out, doc, needle);
    match &block.edit {
        Some(proof) => assert_eq!(
            proof.verdict, "unknown",
            "{needle:?} 不该被证明（reason={}）：{:?}",
            proof.reason, proof.source
        ),
        None => panic!("{needle:?} 所在的块应当带证明对象"),
    }
}

// ---------------------------------------------------------------------------
// 正常案例
// ---------------------------------------------------------------------------

#[test]
fn plain_text_blocks_are_verified() {
    let _hit_cache = hit_cache_guard();
    let doc = "第一段正文，普通的一句话。\n\n第二段正文，也应当能编辑。\n\n= 一级标题\n\n== 二级标题 <sec>\n";
    assert_verified(doc, "第一段正文");
    assert_verified(doc, "第二段正文");
    assert_verified(doc, "一级标题");
    // 标题带标签：`<sec>` 不画文字，但它不是"被丢掉的正文"
    assert_verified(doc, "二级标题");
}

#[test]
fn styling_only_show_rule_keeps_verification() {
    let _hit_cache = hit_cache_guard();
    // 只改样式（颜色/字体）的 show rule 不改变文字对应
    let doc = "#show heading: it => text(fill: rgb(\"#1d4ed8\"), it)\n\n#show strong: set text(weight: \"bold\")\n\n= 带样式的标题\n\n正文里有 *粗体* 与 _斜体_。\n";
    assert_verified(doc, "带样式的标题");
    assert_verified(doc, "正文里有");
}

#[test]
fn inline_math_does_not_break_verification() {
    let _hit_cache = hit_cache_guard();
    // 行内公式的字形映射到公式源码；`alpha` 这类名字不改变"块内字母数字都有字形"这条
    let doc = "正文里有一个 $a^2 + b^2 = c^2$ 恒等式。\n\n还有 $alpha + beta$ 与 $integral_0^1 f(x) dif x$。\n";
    assert_verified(doc, "正文里有一个");
    assert_verified(doc, "还有");
}

#[test]
fn simple_list_items_are_verified() {
    let _hit_cache = hit_cache_guard();
    let doc = "- 第一项\n- 第二项\n\n+ 有序一\n+ 有序二\n";
    assert_verified(doc, "第一项");
    assert_verified(doc, "第二项");
    assert_verified(doc, "有序一");
}

// ---------------------------------------------------------------------------
// 反例
// ---------------------------------------------------------------------------

#[test]
fn text_replacing_show_rule_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 文字替换：源码里的"苹果"被画成"香蕉"，直接编辑会把香蕉换回去
    let doc = "#show \"苹果\": \"香蕉\"\n\n这里本来写着苹果两个字。\n\n下一段不受影响。\n";
    assert_unknown(doc, "这里本来写着");
    // 只改样式的那条规则不影响别段
    assert_verified(doc, "下一段不受影响");
}

#[test]
fn macro_generated_text_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 宏在使用处展开：字形 span 指回定义处，块内 `#name` 的字母没有字形
    let doc = "#let name = \"Typst\"\n\n这个文档用了宏 #name 排版。\n";
    assert_unknown(doc, "这个文档用了宏");
}

#[test]
fn duplicated_output_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 同一份源码输出两次：字形区间会重复，阅读顺序里无法保持严格递增
    let doc = "#show: it => it + it\n\n同一段源码会被画两遍。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "同一段源码");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(
        proof.verdict, "unknown",
        "重复输出必须证不出来（reason={}）",
        proof.reason
    );
}

#[test]
fn placed_content_does_not_get_a_false_verified_via_replacement() {
    let _hit_cache = hit_cache_guard();
    // `#place` 会让裁剪带按并集膨胀（内容仍在带内），所以**后端可能给出 verified**；
    // 真正的闸门是前端白名单：`#place(...)` 是 code 区域 ⇒ 决策判 complex ⇒ 切片。
    // 这里只钉住"后端不会因为 `#place` 而把**别处**的文字算进来"：挪走的文字被换掉时仍证不出来。
    let doc = "#show place: it => [换掉的内容]\n\n正文开头。#place(top + left, dx: 200pt)[飘走的内容]后面还有字。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "正文开头");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(
        proof.verdict, "unknown",
        "被换掉的 #place 内容必须证不出来（reason={}）",
        proof.reason
    );
}

#[test]
fn footnote_body_out_of_band_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 脚注正文被排到页底：它的 span 在这一块里，但墨迹不在带里
    let doc = "正文里有一个脚注#footnote[脚注正文会被排到页底]。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "正文里有一个脚注");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(
        proof.verdict, "unknown",
        "脚注正文出带必须证不出来（reason={}）",
        proof.reason
    );
}

#[test]
fn no_output_blocks_have_no_proof() {
    let _hit_cache = hit_cache_guard();
    let doc = "#set text(size: 11pt)\n\n正文段落。\n";
    let out = blocks_of(doc);
    let rule = out
        .blocks
        .iter()
        .find(|b| b.kind == "Code")
        .expect("应有 #set 块");
    assert!(!rule.found, "#set 没有几何");
    assert!(rule.edit.is_none(), "没有几何的块不该带证明");
}

// ---------------------------------------------------------------------------
// 来自其它源文件的可见内容
// ---------------------------------------------------------------------------

/// **字形 span 不属于主文档时不能当成主文档的字形**（回归：早先的遍历把 include 进来的
/// 文件里的字节偏移当主文档坐标，污染块几何与命中）。
#[test]
fn foreign_file_glyphs_are_not_attributed_to_main_doc() {
    let _hit_cache = hit_cache_guard();
    let dir = std::env::temp_dir().join(format!("typst-pad-include-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let part = dir.join("part.typ");
    let main = dir.join("main.typ");
    std::fs::write(&part, "被 include 进来的整段文字。\n").expect("写 part.typ");
    let src = "#include \"part.typ\"\n\n主文档自己的段落。\n";
    std::fs::write(&main, src).expect("写 main.typ");

    let world = TypstWorld::new(
        src.to_string(),
        Some(main.to_string_lossy().to_string()),
        &fonts_dir(),
        &FontConfig::default(),
    );
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc), ..
        } => doc,
        typst::diag::Warned { output: Err(e), .. } => {
            panic!("编译应成功：{e:?}");
        }
    };
    let ((items, stats), _) = collect_geometry_with_links(&world, &document);
    // ① 主文档的字形区间不能越过主文档长度（早先会拿到 part.typ 里的偏移）
    let main_len = src.len();
    for item in &items {
        assert!(
            item.range.end <= main_len,
            "字形区间越出主文档：{:?}（主文档 {main_len} 字节）",
            item.range
        );
    }
    // ② include 的内容确实画了东西，且被记为"外来墨迹"
    assert!(
        !stats.foreign_ink.is_empty(),
        "include 进来的内容必须被记成外来墨迹"
    );

    // ③ 块证明：include 那一块证不出来（它自己的字形为空），主文档段落照常能证明
    let out = compile_blocks(
        src.to_string(),
        0,
        Some(main.to_string_lossy().to_string()),
        &fonts_dir(),
        &FontConfig::default(),
        COLUMN_PT,
        None,
        None,
    );
    assert!(out.ok, "编译应成功：{:?}", out.diagnostics);
    let include_block = out
        .blocks
        .iter()
        .find(|b| &src[b.start..b.end] == "#include \"part.typ\"")
        .expect("应有 include 块");
    // include 行自己没有主文档字形（内容来自别的文件）⇒ 没有几何、没有证明对象；
    // 关键是**绝不能是 verified**。
    assert_ne!(
        include_block.edit.as_ref().map(|p| p.verdict.as_str()),
        Some("verified"),
        "include 块不该被证明"
    );
    let para = block_at(&out, src, "主文档自己的段落");
    assert_eq!(
        para.edit.as_ref().map(|p| p.verdict.as_str()),
        Some("verified"),
        "主文档自己的段落应能证明（reason={:?}）",
        para.edit.as_ref().map(|p| &p.reason)
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 列表标记（任务 2）：符号 / 缩进 / 编号都取自引擎
// ---------------------------------------------------------------------------

/// 取列表项的标记（源码文本包含 `needle` 的那一块）
fn marker_of(out: &BlocksOutput, doc: &str, needle: &str) -> ListMarkerProof {
    block_at(out, doc, needle)
        .list_marker
        .clone()
        .unwrap_or_else(|| panic!("{needle:?} 应当是带标记的列表项"))
}

#[test]
fn list_markers_come_from_typst() {
    let _hit_cache = hit_cache_guard();
    // 无序列表：默认圆点；正文起点在符号右侧（`marker_width + body_indent`）
    let doc = "- 第一项\n- 第二项\n\n+ 有序一\n+ 有序二\n";
    let out = blocks_of(doc);
    let bullet = marker_of(&out, doc, "第一项");
    assert_eq!(bullet.text, "•", "无序列表的符号应取自引擎");
    assert!(
        bullet.body_offset_pt > 3.0 && bullet.body_offset_pt < 24.0,
        "正文起点偏移应在合理范围：{}",
        bullet.body_offset_pt
    );
    assert!(
        bullet.marker_x_pt.abs() < 0.5,
        "圆点本身画在列左缘：{}",
        bullet.marker_x_pt
    );
    // 有序列表：序号由引擎给（前端的"按缩进计数"近似在这里只当兜底）
    let one = marker_of(&out, doc, "有序一");
    assert_eq!(one.text, "1.");
    assert_eq!(marker_of(&out, doc, "有序二").text, "2.");
    // 单数字列表的标记盒宽 = 标记宽 ⇒ 序号正好从列左缘开始
    assert!(
        one.marker_x_pt.abs() < 0.5 && one.marker_x_pt < one.body_offset_pt,
        "序号起点 {} 应在列左缘（正文起点 {}）",
        one.marker_x_pt,
        one.body_offset_pt
    );
    // 默认 `marker-align: end`：有两位数序号时标记盒更宽 ⇒ `9.` 右对齐、起点离列左缘一段距离
    let wide = "#set enum(start: 9)\n\n+ 九\n+ 十\n";
    let out_wide = blocks_of(wide);
    let nine = marker_of(&out_wide, wide, "九");
    assert_eq!(nine.text, "9.");
    assert_eq!(marker_of(&out_wide, wide, "十").text, "10.");
    assert!(
        nine.marker_x_pt > 0.5 && nine.marker_x_pt < nine.body_offset_pt,
        "右对齐的 `9.` 起点 {} 应落在 (0, {}) 内",
        nine.marker_x_pt,
        nine.body_offset_pt
    );
}

#[test]
fn custom_numbering_and_start_use_engine_values() {
    let _hit_cache = hit_cache_guard();
    // 自定义编号：前端无法靠计数推出来
    let doc = "#set enum(numbering: \"a)\")\n\n+ 甲\n+ 乙\n";
    let out = blocks_of(doc);
    assert_eq!(marker_of(&out, doc, "甲").text, "a)");
    assert_eq!(marker_of(&out, doc, "乙").text, "b)");

    // 起始值：编号不从 1 开始
    let doc2 = "#set enum(start: 3)\n\n+ 丙\n+ 丁\n";
    let out2 = blocks_of(doc2);
    assert_eq!(marker_of(&out2, doc2, "丙").text, "3.");
    assert_eq!(marker_of(&out2, doc2, "丁").text, "4.");

    // 自定义**符号内容**（`#set list(marker: [--])`）：标记字形是定义处的 content value，
    // span 指回 `#set` 行 ⇒ 不是"合成的标记字形"，取不到引擎值。这时**必须返回 None**
    // （前端据此切片），绝不能拿前端的近似画一个假的 `•`。
    let doc3 = "#set list(marker: [--])\n\n- 戊\n";
    let out3 = blocks_of(doc3);
    assert!(
        block_at(&out3, doc3, "戊").list_marker.is_none(),
        "取不到引擎标记时必须返回 None，让前端切片"
    );
}

#[test]
fn nested_list_is_one_multiline_block() {
    let _hit_cache = hit_cache_guard();
    // 嵌套列表在 typst 语法树里是**同一个 ListItem 节点**（子列表是它的子节点），
    // 于是它是一块多源码行的块 —— 前端的单源码行判据会把它整块切片（嵌套列表不开放）。
    let doc = "- 外层\n  - 内层\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "内层");
    assert!(
        doc[block.start..block.end].contains('\n'),
        "嵌套列表应当是含换行的同一块：{:?}",
        &doc[block.start..block.end]
    );
    assert!(
        doc[block.start..block.end].contains("外层"),
        "内层与外层在同一块里"
    );
}

// ---------------------------------------------------------------------------
// 简单函数白名单（任务 4）：`#strong[文字]` / `#emph[文字]`
// ---------------------------------------------------------------------------

#[test]
fn whitelisted_inline_functions_are_verified() {
    let _hit_cache = hit_cache_guard();
    // 调用语法（`#strong[` 与 `]`）不画成文字，但**正文**必须逐字对上
    let doc = "正文 #strong[加粗的字] 与 #emph[斜体的字] 收尾。\n";
    let out = blocks_of(doc);
    let proof = proof_of(&out, doc, "正文");
    assert_eq!(
        proof.verdict, "verified",
        "白名单函数的正文应能证明（reason={}）",
        proof.reason
    );
}

#[test]
fn whitelisted_function_replaced_by_show_rule_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 内容被 show rule 换掉：替换文字的字形落在块外 ⇒ 必须证不出来
    let doc = "#show strong: it => [换掉的文字]\n\n正文 #strong[原本的字] 收尾。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "正文");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(
        proof.verdict, "unknown",
        "内容被换掉的 #strong 必须证不出来（reason={}）",
        proof.reason
    );
}

#[test]
fn replaced_non_whitelisted_code_content_is_unknown() {
    let _hit_cache = hit_cache_guard();
    // 后端的豁免只针对**调用语法**（`#` + `FuncCall` 的名字与括号）；内容块照常逐字检查。
    // 所以"是否开放"完全由前端白名单决定，后端不会因为 `#box[...]` 就放行被换掉的内容。
    let doc = "#show box: it => [换掉]\n\n正文 #box[原本] 收尾。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "正文");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(
        proof.verdict, "unknown",
        "内容被换掉的行内代码必须证不出来（reason={}）",
        proof.reason
    );
}

// ---------------------------------------------------------------------------
// 行内原子（任务 3）：引用 / 标签不阻塞整块资格；脚注保持切片
// ---------------------------------------------------------------------------

#[test]
fn references_and_labels_do_not_block_verification() {
    let _hit_cache = hit_cache_guard();
    // 标签不画文字、引用画成编号：两者都是原子，正文块照常能证明
    // 标题默认不编号，引用标题会报错 —— 加一条编号规则让引用成立
    let doc =
        "#set heading(numbering: \"1.\")\n\n= 标题 <sec>\n\n见 @sec[p.~7] 一节，后面还有 @sec。\n";
    let out = blocks_of(doc);
    let heading = proof_of(&out, doc, "标题");
    assert_eq!(
        heading.verdict, "verified",
        "带标签的标题应能证明（reason={}）",
        heading.reason
    );
    let proof = proof_of(&out, doc, "见 @sec");
    assert_eq!(
        proof.verdict, "verified",
        "带引用/标签的正文应能证明（reason={}）",
        proof.reason
    );
}

#[test]
fn footnote_paragraph_stays_unverifiable() {
    let _hit_cache = hit_cache_guard();
    // 脚注正文被排到页底（与对应源块不在同一个带里）⇒ 整块切片，绝不直接编辑
    let doc = "正文里有脚注#footnote[页底文字]。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "正文里有脚注");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(proof.verdict, "unknown", "reason={}", proof.reason);
}

// ---------------------------------------------------------------------------
// 真实作业暴露的两个误判（PKU 回归）：宏字形指回定义处、公式内部合法的同源字形
// ---------------------------------------------------------------------------

#[test]
fn macro_glyph_pointing_at_definition_is_not_foreign_intrusion() {
    let _hit_cache = hit_cache_guard();
    // `#let` 的 content value 在使用处的字形 span 指回定义处 —— 不能算"别的块的墨迹"。
    // 实测 PKU 高代周二 18 个正文段落因此被误判成切片。
    let doc = "#let vv = $x$\n\n正文里的 $vv + 1$ 公式仍然能证明。\n";
    let out = blocks_of(doc);
    let proof = proof_of(&out, doc, "正文里的");
    assert_eq!(
        proof.verdict, "verified",
        "宏字形指回定义处不该被当外来墨迹（reason={}）",
        proof.reason
    );
}

#[test]
fn repeated_math_source_ranges_are_not_duplicate_output() {
    let _hit_cache = hit_cache_guard();
    // 公式内部多个字形共用同一个源区间是 typst 的正常排版（实测 PKU 45 块因此被误判成
    // "同一段输出两次"）。真正的重复输出重复的是**正文文字**，仍然会被 duplicate 抓到。
    let doc = "正文里 $1/2$ 与 $frac(a, b)$ 与 $macron(q)$ 都是正常公式。\n";
    let out = blocks_of(doc);
    let proof = proof_of(&out, doc, "正文里");
    assert_eq!(
        proof.verdict, "verified",
        "公式内部的同源字形不该被当重复输出（reason={}）",
        proof.reason
    );
}

#[test]
fn real_duplicate_output_is_still_unknown_after_the_relaxation() {
    let _hit_cache = hit_cache_guard();
    // 放宽之后必须仍然拦住真正的重复输出（正文文字被画两遍）
    let doc = "#show: it => it + it\n\n同一段正文文字会被画两遍。\n";
    let out = blocks_of(doc);
    let block = block_at(&out, doc, "同一段正文");
    let proof = block.edit.as_ref().expect("应当带证明对象");
    assert_eq!(proof.verdict, "unknown", "reason={}", proof.reason);
}
