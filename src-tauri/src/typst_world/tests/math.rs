// 公式渲染（`compile_math`）：尺寸/基线/墨迹、上下文与前缀、多行 body、字号对齐、语法错误。
use super::*;

/// 公式渲染（compile_math）：行内公式成功，SVG 贴边且透明，
/// 尺寸与 SVG 根属性一致（前端按 pt 原样显示，契约不能漂）
#[test]
fn compile_math_inline_ok() {
    let out = compile_math(
        "x^2",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(out.ok, "行内公式应渲染成功: {:?}", out.error);
    assert!(out.svg.contains("<svg"), "产物应是 SVG");
    assert!(out.width_pt > 0.0 && out.height_pt > 0.0, "尺寸应为正");
    assert!(
        out.baseline_pt >= 0.0 && out.baseline_pt <= out.height_pt + 0.001,
        "基线应落在盒内: baseline={} height={}",
        out.baseline_pt,
        out.height_pt
    );
    // 贴边：SVG 的 width/height 与返回的 pt 尺寸一致（前端直接按 pt 显示，不再缩放）
    assert!(
        out.svg
            .contains(&format!("width=\"{:.4}pt\"", out.width_pt))
            || out.svg.contains(&format!("width=\"{}pt\"", out.width_pt)),
        "SVG 宽度应与 width_pt 一致：{} vs {}",
        out.svg.chars().take(160).collect::<String>(),
        out.width_pt
    );
    // 透明背景：不得带白色页底（否则内联进编辑器会出现白块）
    assert!(!out.svg.contains("ffffff"), "公式 SVG 不应含白色背景");
}

/// 公式渲染：行间（display 风格）公式明显高于行内风格（分式由 a/b 变为竖排）
#[test]
fn compile_math_display_taller_than_inline() {
    let inline = compile_math(
        "frac(a,b)",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    let display = compile_math(
        "frac(a,b)",
        true,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(inline.ok && display.ok);
    // 画布高度已经含"墨迹余量"（见 ink_bounds_of_frame），所以比值不再是 2 倍上下；
    // 真正要锁的是"行间分式明显比行内高"
    assert!(
        display.height_pt > inline.height_pt * 1.4,
        "行间分式应显著更高：inline={} display={}",
        inline.height_pt,
        display.height_pt
    );
    assert!(
        display.baseline_pt > inline.baseline_pt * 1.4,
        "行间分式基线以上的部分也应更高：inline={} display={}",
        inline.baseline_pt,
        display.baseline_pt
    );
}

/// 基线探针：有下沉部分的公式（积分）depth > 0；全在基线上方的公式（x^2）depth ≈ 0。
/// 这条锁住「两页探针」测得的基线（若退回 page.frame.baseline()，depth 会恒为 0）。
#[test]
fn compile_math_baseline_measures_depth() {
    let integral = compile_math(
        "integral_0^1 f(x) dif x",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(integral.ok);
    let depth = integral.height_pt - integral.baseline_pt;
    assert!(depth > 0.3, "积分应有下沉深度，实际 {depth}");

    // x^2 的墨迹全在基线上方：画布只该给字体的 descender 留一点余量（≈0.2em），
    // 不该像积分那样留出大块下沉空间
    let sup = compile_math(
        "x^2",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(sup.ok);
    let sup_depth = sup.height_pt - sup.baseline_pt;
    assert!(
        (0.0..3.0).contains(&sup_depth),
        "x^2 视觉上不下沉（只留字体 descender 余量），实际 depth={sup_depth}"
    );
    assert!(
        sup.baseline_pt > sup.height_pt * 0.6,
        "x^2 的基线应仍靠画布下方：baseline={} height={}",
        sup.baseline_pt,
        sup.height_pt
    );
}

/// **下标不许被画布裁掉**（2026-09-14 用户反馈「a_0 的下半部分没有渲染」）。
///
/// typst 允许把上下标画到**帧外**（实测 `$a_0$`：帧高 8.196pt、基线就在帧底、下标基线在 11.16pt），
/// 而我们的公式页是贴边页 —— 导出 SVG 后视口就是裁剪框，帧外的下标直接被裁掉。
/// 现在按墨迹范围撑画布（见 ink_bounds_of_frame），这条测试锁住：画布够高、且 SVG 视口与
/// 返回的 height_pt 一致（不一致就说明还有墨迹落在视口外）。
#[test]
fn compile_math_script_ink_inside_canvas() {
    let out = compile_math(
        "a_0",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        12.0,
    );
    assert!(out.ok, "公式应渲染成功: {:?}", out.error);
    // 下标基线实测在 11.16pt（数字 0 的墨迹全在它自己基线上方），画布只要超过它就是安全
    assert!(
        out.height_pt > 11.2,
        "画布要装得下下标（下标基线在 11.16pt 附近），实际 {}",
        out.height_pt
    );
    assert!(
        out.baseline_pt > 7.0 && out.baseline_pt < out.height_pt,
        "基线应落在画布内：baseline={} height={}",
        out.baseline_pt,
        out.height_pt
    );
    let vb_h = view_box_height(&out.svg).expect("SVG 应有 viewBox");
    assert!(
        (vb_h - out.height_pt).abs() < 0.01,
        "SVG 视口高 {vb_h} 应等于 height_pt {}（否则视口会裁掉墨迹）",
        out.height_pt
    );
    // 下标墨迹（基线 11.16 + 自己的 descender）也要落在视口内
    assert!(
        vb_h > 11.2,
        "视口高 {vb_h} 必须超过下标基线，否则下标会被裁"
    );
}

/// 前缀（context）参与公式编译，但公式字号恒为编辑器字号（前缀里的 text(size) 不得带偏）
#[test]
fn compile_math_context_applies_without_changing_size() {
    // 前缀定义的宏在公式里可用（#myX）
    let with_let = compile_math(
        "#myX",
        false,
        "#let myX = 42",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(with_let.ok, "前缀宏应可用: {:?}", with_let.error);
    assert!(with_let.width_pt > 0.0);

    // 前缀把正文设成 30pt：公式仍按 MATH_TEXT_PT 渲染（#set 在 30pt 之后生效）
    let plain = compile_math(
        "x",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    let with_big_prefix = compile_math(
        "x",
        false,
        "#set text(size: 30pt)",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(plain.ok && with_big_prefix.ok);
    assert!(
        (plain.width_pt - with_big_prefix.width_pt).abs() < 0.1,
        "字号应由 MATH_TEXT_PT 强制：{} vs {}",
        plain.width_pt,
        with_big_prefix.width_pt
    );
}

/// 跨行公式（行间公式多行书写）：仍能渲染成贴边 SVG（前端整行替换为块级 widget）
#[test]
fn compile_math_multiline_body() {
    let out = compile_math(
        "a + b \\ = c",
        true,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(out.ok, "跨行公式应渲染成功: {:?}", out.error);
    assert!(out.width_pt > 0.0 && out.height_pt > 0.0);
    // 行间公式的盒应明显高于单行行内公式（19pt 量级 vs 7pt 量级）
    assert!(
        out.height_pt > 12.0,
        "行间公式应更高，实际 {}",
        out.height_pt
    );
}

/// 按需运行的真实公式产物导出（浏览器端视觉验证用）：
/// `npm run fixtures:math`（= `cargo test dump_math_fixtures -- --ignored --nocapture`）
/// 每行输出 `FIXTURE:{json}`，由 scripts/browser-check 收集后注入浏览器开发模式页面，
/// 于是浏览器里渲染的是**真实 typst 产物**（真尺寸/真基线），而不是桩的假 SVG。
///
/// **三种字号各导一份**：写作模式正文默认 11pt（`DEFAULT_TEXT_PT`，文档没写
/// `#set text(size:)` 时就是这个）、写作模式文档写了 12pt、源码模式正文 14px → 10.5pt
/// （`MATH_TEXT_PT`）。桩按 (body, display, sizePt) 匹配，字号对不上就退回假 SVG
/// （实测踩过：只导 10.5 时写作模式下全对不上）。
/// **11pt 那份是 PR #60 审查之后补的**：写作模式的公式字号改成跟随文档（原来是写死的
/// 12pt），默认文档请求的就是 11pt。
#[test]
#[ignore = "按需运行：导出浏览器视觉验证用的真实公式产物"]
fn dump_math_fixtures() {
    let cases: [(&str, bool); 13] = [
        // 带下标的用例（2026-09-14 加）：用户反馈 `$a_0 = 0$` 的下标下半截被裁掉
        ("a_0", false),
        ("a_0 = 0", false),
        ("y_p + g_q", false),
        ("x^2 + y^2 = z^2", false),
        ("frac(a,b)", false),
        ("integral_0^1 f(x) dif x", false),
        ("sqrt(x^2 + y^2)", false),
        ("sum_(i=1)^n i", false),
        ("y_p + g_q", false),
        ("frac(a,b)", true),
        ("sum_(i=1)^n i", true),
        ("mat(1, 2; 3, 4)", true),
        ("a + b \\ = c", true),
    ];
    for (body, display) in cases {
        for size_pt in [crate::block_geometry::DEFAULT_TEXT_PT, 12.0, MATH_TEXT_PT] {
            let out = compile_math(
                body,
                display,
                "",
                None,
                &fonts_dir(),
                &FontConfig::default(),
                size_pt,
            );
            assert!(out.ok, "夹具公式应渲染成功: {body} / {:?}", out.error);
            let json = serde_json::json!({
                "body": body,
                "display": display,
                "sizePt": size_pt,
                "svg": out.svg,
                "widthPt": out.width_pt,
                "heightPt": out.height_pt,
                "baselinePt": out.baseline_pt,
            });
            println!("FIXTURE:{}", json);
        }
    }
}

/// 字号可传：写作模式正文 16px = 12pt，公式必须跟着放大
/// （曾经的 bug：正文 16px 而公式仍按 10.5pt 编译 → 公式比正文小一圈）
#[test]
fn compile_math_size_matches_editor_font() {
    let small = compile_math(
        "x",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    let big = compile_math(
        "x",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        12.0,
    );
    assert!(small.ok && big.ok);
    let ratio = big.width_pt / small.width_pt;
    assert!(
        (ratio - 12.0 / MATH_TEXT_PT).abs() < 0.02,
        "12pt 公式宽度应是 10.5pt 的 {} 倍，实测 {ratio}",
        12.0 / MATH_TEXT_PT
    );
    // 越界/NaN 退回默认，不 panic
    let bad = compile_math(
        "x",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        f64::NAN,
    );
    assert!(bad.ok);
    assert!((bad.width_pt - small.width_pt).abs() < 0.001);
}

/// 公式语法错误：ok=false 且带消息（前端据此保持源码显示，不显示空 widget）
#[test]
fn compile_math_syntax_error() {
    let out = compile_math(
        "frac(a",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(!out.ok, "非法公式应失败");
    assert!(out.svg.is_empty(), "失败时不应有产物");
    assert!(
        out.error.as_deref().is_some_and(|e| !e.is_empty()),
        "失败应带错误消息"
    );
}

/// 行内公式按顶层运算符切段：短公式不切，长公式切在运算符前、拼接后运算符不丢。
#[test]
fn split_inline_math_keeps_operators_and_ignores_nested() {
    assert_eq!(split_inline_math("a + b"), vec!["a + b"], "短公式不该切");

    let long = "a_1 + a_2 + a_3 + a_4 + a_5 <= b_1 + b_2 + b_3 + b_4 + b_5 = c";
    let parts = split_inline_math(long);
    assert!(parts.len() >= 2, "长公式应切成多段：{parts:?}");
    let joined = parts.join("");
    for token in ["<=", "+", "="] {
        assert!(joined.contains(token), "拼接后不应丢 {token}：{joined}");
    }
    // 每一段都以运算符开头（除第一段）
    for part in parts.iter().skip(1) {
        let head: String = part.chars().take(2).collect();
        assert!(
            ["<=", ">=", "!=", "==", "->", "<-", "<", ">", "=", "+", "-"]
                .iter()
                .any(|op| head.starts_with(op)),
            "后续片段应以运算符开头：{part:?}"
        );
    }

    // 括号里的运算符不算顶层：`sum_(i=1)^n` 的 `=` 不能被用来切
    let nested = "sum_(i=1)^n i + sum_(j=1)^m j + sum_(k=1)^p k + sum_(l=1)^q l";
    let nparts = split_inline_math(nested);
    for part in &nparts {
        assert!(
            !part.starts_with('='),
            "括号内的 `=` 不该成为断点：{part:?}"
        );
    }
}

/// 长行内公式的整块尺寸 ≈ 各片段尺寸之和（片段之间只少了运算符左侧的一点间距）。
#[test]
fn compile_math_inline_segments_match_total_width() {
    let body = "a_1 + a_2 + a_3 + a_4 + a_5 + a_6 + a_7 + a_8 + a_9 + a_10";
    let out = compile_math(
        body,
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(out.ok, "整块应渲染成功: {:?}", out.error);
    assert!(out.segments.len() >= 2, "长公式应给出片段：{}", out.segments.len());
    let sum: f64 = out.segments.iter().map(|s| s.width_pt).sum();
    assert!(
        (sum - out.width_pt).abs() < 12.0,
        "片段宽度之和 {sum} 应接近整块宽度 {}（差 {}）",
        out.width_pt,
        (sum - out.width_pt).abs()
    );
    for seg in &out.segments {
        assert!(seg.width_pt > 0.0 && seg.height_pt > 0.0, "片段尺寸应为正");
        assert!(!seg.svg.is_empty(), "片段应有 SVG");
    }

    // 短公式不产生片段（前端照旧整块渲染）
    let short = compile_math(
        "x^2",
        false,
        "",
        None,
        &fonts_dir(),
        &FontConfig::default(),
        MATH_TEXT_PT,
    );
    assert!(short.segments.is_empty(), "短公式不该分段");
}
