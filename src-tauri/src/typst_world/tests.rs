// typst_world 的单元测试（原 `mod tests`，逐字搬出，只去掉一层缩进）。
use super::*;

/// 测试用字体目录：`src-tauri/fonts`（与打包资源同源，见 resolve_fonts_dir；cargo test 的
/// CWD 是 src-tauri，用 CARGO_MANIFEST_DIR 定位更稳）
fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

/// 写作模式的源码透镜要用的打包字体：白名单里的文件**必须真在仓库里**（改名/换字体时这条会红，
/// 否则前端只会静默退回系统字体，谁也不知道），且白名单外的名字一律拒绝。
#[test]
fn editor_font_files_exist_and_are_whitelisted() {
    let dir = fonts_dir();
    for name in EDITOR_FONT_FILES {
        let path = dir.join(name);
        assert!(path.is_file(), "缺打包字体：{}", path.display());
        let bytes = read_editor_font(&dir, name).unwrap_or_else(|e| panic!("{name} 读不到：{e}"));
        assert!(
            bytes.len() > 100_000,
            "{name} 只有 {} 字节，不像一份真字体",
            bytes.len()
        );
    }
    // 白名单之外（含路径穿越、系统文件）一律拒绝
    for bad in ["../Cargo.toml", "Cargo.toml", "", "/etc/passwd"] {
        assert!(
            read_editor_font(&dir, bad).is_err(),
            "白名单外的名字必须拒绝：{bad:?}"
        );
    }
}

/// 公式渲染（compile_math）：行内公式成功，SVG 贴边且透明，
/// 尺寸与 SVG 根属性一致（前端按 pt 原样显示，契约不能漂）
#[test]
fn compile_math_inline_ok() {
    let out = compile_math("x^2", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
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
        out.svg.contains(&format!("width=\"{:.4}pt\"", out.width_pt))
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
    let inline = compile_math("frac(a,b)", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    let display = compile_math("frac(a,b)", true, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
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
    let integral = compile_math("integral_0^1 f(x) dif x", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    assert!(integral.ok);
    let depth = integral.height_pt - integral.baseline_pt;
    assert!(depth > 0.3, "积分应有下沉深度，实际 {depth}");

    // x^2 的墨迹全在基线上方：画布只该给字体的 descender 留一点余量（≈0.2em），
    // 不该像积分那样留出大块下沉空间
    let sup = compile_math("x^2", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    assert!(sup.ok);
    let sup_depth = sup.height_pt - sup.baseline_pt;
    assert!(
        sup_depth >= 0.0 && sup_depth < 3.0,
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
    let out = compile_math("a_0", false, "", None, &fonts_dir(), &FontConfig::default(), 12.0);
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
    assert!(vb_h > 11.2, "视口高 {vb_h} 必须超过下标基线，否则下标会被裁");
}

/// 从 SVG 头部取 viewBox 的高度
fn view_box_height(svg: &str) -> Option<f64> {
    let start = svg.find("viewBox=\"")? + "viewBox=\"".len();
    let end = svg[start..].find('"')? + start;
    svg[start..end].split_whitespace().nth(3)?.parse().ok()
}

/// 从 SVG 头部取 viewBox 的宽度（pt）
fn view_box_width(svg: &str) -> Option<f64> {
    let start = svg.find("viewBox=\"")? + "viewBox=\"".len();
    let end = svg[start..].find('"')? + start;
    svg[start..end].split_whitespace().nth(2)?.parse().ok()
}

/// 预览重排（2026-09-14 用户要求「预览不要横向滚动条」）：
/// 给定页宽时产物页宽应等于它（越界夹到 180..=A4），并且**正文真的重排了**
/// ——同一段文字在窄页上会排到更多页；不传页宽时仍是文档自己的 A4。
#[test]
fn compile_with_page_width_reflows_preview() {
    let body = "中文测试内容，用于验证按栏宽重新排版。".repeat(120);
    let src = format!("= 标题\n\n{body}\n");

    let wide = compile_with_page_width(src.clone(), None, &fonts_dir(), &FontConfig::default(), None);
    assert!(wide.ok, "A4 编译应成功: {:?}", wide.diagnostics);
    let wide_pt = view_box_width(&wide.pages[0]).expect("应有 viewBox");
    assert!(
        (wide_pt - A4_WIDTH_PT).abs() < 1.0,
        "不传页宽时应是文档默认的 A4（实测 {wide_pt}pt）"
    );

    let narrow =
        compile_with_page_width(src.clone(), None, &fonts_dir(), &FontConfig::default(), Some(300.0));
    assert!(narrow.ok, "窄页编译应成功: {:?}", narrow.diagnostics);
    let narrow_pt = view_box_width(&narrow.pages[0]).expect("应有 viewBox");
    assert!(
        (narrow_pt - 300.0).abs() < 1.0,
        "页宽应等于请求值（实测 {narrow_pt}pt）"
    );
    assert!(
        narrow.pages.len() > wide.pages.len(),
        "重排应当发生：窄页页数应多于 A4（窄 {} vs A4 {}）",
        narrow.pages.len(),
        wide.pages.len()
    );

    // 越界请求要被夹住（前端也会夹，这里保证后端不信任上游）
    let tiny = compile_with_page_width(src, None, &fonts_dir(), &FontConfig::default(), Some(10.0));
    let tiny_pt = view_box_width(&tiny.pages[0]).expect("应有 viewBox");
    assert!(
        (tiny_pt - PREVIEW_PAGE_MIN_PT).abs() < 1.0,
        "过窄的请求应夹到下限（实测 {tiny_pt}pt）"
    );
}

/// 注入的页设置**不能**让诊断行号漂移：错误在第 2 行，注入一行后报的仍是第 2 行
/// （前端"编译源行号 → 用户文档行号"的映射完全不知道有注入这件事）。
#[test]
fn compile_with_page_width_keeps_diagnostic_lines() {
    let src = "= 标题\n#不存在的函数()\n".to_string();
    let plain = compile_with_page_width(src.clone(), None, &fonts_dir(), &FontConfig::default(), None);
    let with_setup =
        compile_with_page_width(src, None, &fonts_dir(), &FontConfig::default(), Some(300.0));
    assert!(!plain.ok && !with_setup.ok, "两者都应编译失败");
    assert_eq!(
        plain.diagnostics[0].line, 2,
        "不注入时错误在第 2 行（实测 {:?}）",
        plain.diagnostics[0]
    );
    assert_eq!(
        with_setup.diagnostics[0].line, 2,
        "注入页设置后错误行号不得漂移（实测 {:?}）",
        with_setup.diagnostics[0]
    );
    assert!(with_setup.pages.is_empty(), "失败时不该有页面产物");
}

/// 前缀（context）参与公式编译，但公式字号恒为编辑器字号（前缀里的 text(size) 不得带偏）
#[test]
fn compile_math_context_applies_without_changing_size() {
    // 前缀定义的宏在公式里可用（#myX）
    let with_let = compile_math("#myX", false, "#let myX = 42", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    assert!(with_let.ok, "前缀宏应可用: {:?}", with_let.error);
    assert!(with_let.width_pt > 0.0);

    // 前缀把正文设成 30pt：公式仍按 MATH_TEXT_PT 渲染（#set 在 30pt 之后生效）
    let plain = compile_math("x", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    let with_big_prefix = compile_math("x", false, "#set text(size: 30pt)", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
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
    let out = compile_math("a + b \\ = c", true, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    assert!(out.ok, "跨行公式应渲染成功: {:?}", out.error);
    assert!(out.width_pt > 0.0 && out.height_pt > 0.0);
    // 行间公式的盒应明显高于单行行内公式（19pt 量级 vs 7pt 量级）
    assert!(out.height_pt > 12.0, "行间公式应更高，实际 {}", out.height_pt);
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
            let out = compile_math(body, display, "", None, &fonts_dir(), &FontConfig::default(), size_pt);
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
    let small = compile_math("x", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    let big = compile_math("x", false, "", None, &fonts_dir(), &FontConfig::default(), 12.0);
    assert!(small.ok && big.ok);
    let ratio = big.width_pt / small.width_pt;
    assert!(
        (ratio - 12.0 / MATH_TEXT_PT).abs() < 0.02,
        "12pt 公式宽度应是 10.5pt 的 {} 倍，实测 {ratio}",
        12.0 / MATH_TEXT_PT
    );
    // 越界/NaN 退回默认，不 panic
    let bad = compile_math("x", false, "", None, &fonts_dir(), &FontConfig::default(), f64::NAN);
    assert!(bad.ok);
    assert!((bad.width_pt - small.width_pt).abs() < 0.001);
}

/// 公式语法错误：ok=false 且带消息（前端据此保持源码显示，不显示空 widget）
#[test]
fn compile_math_syntax_error() {
    let out = compile_math("frac(a", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
    assert!(!out.ok, "非法公式应失败");
    assert!(out.svg.is_empty(), "失败时不应有产物");
    assert!(
        out.error.as_deref().is_some_and(|e| !e.is_empty()),
        "失败应带错误消息"
    );
}


/// 端到端：中文 + 数学公式文档编译成功，pages 非空且每页含 <svg>
#[test]
fn compile_chinese_math_doc() {
    let src = r#"
= 你好，Typst
这是中文测试文档。
$ a^2 + b^2 = c^2 $
"#
    .to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "编译应成功，实际诊断: {:?}", out.diagnostics);
    assert!(!out.pages.is_empty(), "应至少有一页");
    assert!(out.pages[0].contains("<svg"), "每页应是完整 SVG");
    // 中文字体（思源宋体）与数学字体（NewCM）必须加载成功
    assert!(font_count() >= 7, "src-tauri/fonts 下 7 个字体文件应全部注册");
}

/// 字体加载：`src-tauri/fonts` 下 7 个打包字体全部注册成功（数学 NewCM、中文思源宋体、
/// Libertinus、DejaVu）；合并系统字体目录后这些族仍应存在。
/// 总字体数随系统字体变化（Windows 系统字体目录有数百个文件），不断言具体值。
#[test]
fn fonts_all_registered() {
    // 打包目录单独加载：7 个字体文件全部注册
    let (book, fonts) = load_fonts(&fonts_dir());
    assert_eq!(fonts.len(), 7, "src-tauri/fonts 应有 7 个字体文件");
    assert_bundled_families_registered(&book);

    // 合并加载（打包 + 系统字体目录）：打包族仍在，字体数不少于打包数量
    let (merged_book, merged_fonts) = load_fonts_with_system(&fonts_dir(), &[]);
    assert_bundled_families_registered(&merged_book);
    assert!(
        merged_fonts.len() >= fonts.len(),
        "合并系统字体后字体数不应少于打包数量，实际 {}",
        merged_fonts.len()
    );
}

/// 打包字体族名断言（FontBook 内部键为小写族名，typst 0.15 的 contains_family 不做大小写归一化）
fn assert_bundled_families_registered(book: &FontBook) {
    for family in [
        "new computer modern math",
        "noto serif cjk sc",
        "libertinus serif",
        "dejavu sans mono",
    ] {
        assert!(book.contains_family(family), "字体族 {family} 应已注册");
    }
}

/// 字体加载容错：系统字体目录缺省（不存在）时静默跳过——返回空集不 panic，
/// 编译不受影响；打包目录与系统目录走同一容错路径。
#[test]
fn fonts_missing_dir_silently_skipped() {
    let missing = std::env::temp_dir().join(format!(
        "typst-pad-test-{}-no-such-fonts",
        std::process::id()
    ));
    // 单个不存在目录：返回空集，不 panic
    let (book, fonts) = load_fonts(&missing);
    assert!(fonts.is_empty(), "不存在的目录应返回空字体集");
    assert!(!book.contains_family("noto serif cjk sc"));

    // 合并路径（打包目录 + 不存在的系统目录）：不存在的目录静默跳过，打包族保留
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    load_fonts_from_dir(&fonts_dir(), &mut book, &mut fonts);
    assert_eq!(fonts.len(), 7);
    load_fonts_from_dir(&missing, &mut book, &mut fonts);
    assert_eq!(fonts.len(), 7, "不存在的目录不应新增任何字体");
    assert_bundled_families_registered(&book);
}

/// 诊断转换：语法错误文档应返回 ok=false 且行列 1-based 合理
#[test]
fn syntax_error_diagnostics() {
    let src = "#let = 3
hello"
        .to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(!out.ok);
    assert!(!out.diagnostics.is_empty(), "应有诊断");
    let d = &out.diagnostics[0];
    assert_eq!(d.severity, "error");
    assert!(d.line >= 1, "行号应为 1-based，实际 {}", d.line);
    assert!(d.column >= 1, "列号应为 1-based，实际 {}", d.column);
    assert!(d.end_line.is_some(), "应给出结束位置");
}

/// 相对 include：同目录子文档 include 成功
#[test]
fn relative_include_ok() {
    // 测试用临时目录：main.typ include 同目录的 chapter.typ
    let dir = std::env::temp_dir().join(format!("typst-pad-test-{}-ok", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("chapter.typ"),
        "第一章内容
",
    )
    .unwrap();
    fs::write(
        dir.join("main.typ"),
        "#include \"chapter.typ\"
主文档
",
    )
    .unwrap();

    let src = fs::read_to_string(dir.join("main.typ")).unwrap();
    let doc_path = dir.join("main.typ").to_string_lossy().to_string();
    let out = compile(src, Some(doc_path.clone()), &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "include 应成功，实际诊断: {:?}", out.diagnostics);
    assert!(!out.pages.is_empty());

    // PDF 导出也应成功
    let pdf = compile_to_pdf_bytes(
        fs::read_to_string(dir.join("main.typ")).unwrap(),
        Some(doc_path),
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(pdf.is_ok(), "PDF 导出应成功: {:?}", pdf.err());
    assert!(!pdf.unwrap().is_empty(), "PDF 字节不应为空");

    let _ = fs::remove_dir_all(&dir);
}

/// 相对 include：不存在的文件报错且诊断带 path（include 文件路径）
#[test]
fn relative_include_missing_file() {
    let dir =
        std::env::temp_dir().join(format!("typst-pad-test-{}-missing", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("main.typ"),
        "#include \"no-such.typ\"
",
    )
    .unwrap();

    let src = fs::read_to_string(dir.join("main.typ")).unwrap();
    let doc_path = dir.join("main.typ").to_string_lossy().to_string();
    let out = compile(src, Some(doc_path), &fonts_dir(), &FontConfig::default());
    assert!(!out.ok);
    let d = out
        .diagnostics
        .iter()
        .find(|d| d.path.as_deref().is_some_and(|p| p.contains("no-such.typ")))
        .expect("诊断应带 include 文件路径");
    assert!(d.line >= 1 && d.column >= 1);
    let _ = fs::remove_dir_all(&dir);
}

/// 相对 #import：同目录子模块（`#import "t.typ": hello` + `#hello`）。
/// 顺带补上一个长期空白：此前**一条本地相对 import 的单测都没有**（只有 include
/// 与 @preview/@local 包），所以 import 这条分支坏了也没人拦。
#[test]
fn relative_import_same_dir_ok() {
    let dir =
        std::env::temp_dir().join(format!("typst-pad-test-{}-imp-same", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("t.typ"), "#let hello() = [来自子模块]\n").unwrap();
    fs::write(
        dir.join("main.typ"),
        "#import \"t.typ\": hello

#hello()
",
    )
    .unwrap();

    let src = fs::read_to_string(dir.join("main.typ")).unwrap();
    let doc_path = dir.join("main.typ").to_string_lossy().to_string();
    let out = compile(src, Some(doc_path), &fonts_dir(), &FontConfig::default());
    assert!(
        out.ok,
        "同目录 import 应成功，实际诊断: {:?}",
        out.diagnostics
    );
    assert!(!out.pages.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

/// 相对 #import：**上一层目录**里的模板 —— 本次回归的核心。
///
/// 用户报「还是没法 #import 别的文件」，原话场景是
/// `Typst/2026.6.3-随机化和近似算法/…….typ` 里的 `#import "../touying/z.typ": *`。
/// typst 的 `..` 是按**虚拟路径**判越界的：项目根若还钉在文档目录，`..` 一弹就
/// 报 `path "…" would escape the project root`（见 resolve_project_root）。
///
/// 这里连模板**自己**的跨目录引用一起验（`touying/z.typ` → `../shared/util.typ`）：
/// 根得放宽到能一次容纳两层引用。
#[test]
fn relative_import_parent_dir_ok() {
    let base =
        std::env::temp_dir().join(format!("typst-pad-test-{}-imp-up", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let docs = base.join("2026.6.3-随机化和近似算法");
    let lib = base.join("touying");
    let shared = base.join("shared");
    fs::create_dir_all(&docs).unwrap();
    fs::create_dir_all(&lib).unwrap();
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("util.typ"), "#let two() = [嵌套引用]\n").unwrap();
    fs::write(
        lib.join("z.typ"),
        "#import \"../shared/util.typ\": two

#let hi(x) = [模板: #x / #two()]
",
    )
    .unwrap();
    fs::write(
        docs.join("main.typ"),
        "#import \"../touying/z.typ\": hi

#hi(1)
",
    )
    .unwrap();

    let src = fs::read_to_string(docs.join("main.typ")).unwrap();
    let doc_path = docs.join("main.typ").to_string_lossy().to_string();
    let out = compile(src, Some(doc_path), &fonts_dir(), &FontConfig::default());
    assert!(
        out.ok,
        "引用上一层目录的 import 应成功，实际诊断: {:?}",
        out.diagnostics
    );
    assert!(!out.pages.is_empty());
    let _ = fs::remove_dir_all(&base);
}

/// `needed_levels` 与 typst 的路径归一化同构（`Segments::push_component`）：
/// `Normal` 压栈、`..` 弹栈，弹不动的次数就是"根要比引用文件目录高几层"
#[test]
fn needed_levels_matches_typst_semantics() {
    assert_eq!(needed_levels("t.typ"), 0);
    assert_eq!(needed_levels("./t.typ"), 0);
    assert_eq!(needed_levels("sub/t.typ"), 0);
    assert_eq!(needed_levels("sub/../t.typ"), 0);
    assert_eq!(needed_levels("../t.typ"), 1);
    assert_eq!(needed_levels("../touying/z.typ"), 1);
    assert_eq!(needed_levels("../../t.typ"), 2);
    assert_eq!(needed_levels("sub/../../t.typ"), 1);
    // typst 只按 `/` 切分（反斜杠是非法字符，那种路径根本编不过）
    assert_eq!(needed_levels("..\\t.typ"), 0);
}

/// 项目根放宽规则（纯函数，本次改动的核心逻辑）：
/// ① 同目录引用**不许**无谓放宽；② 引用上一层目录 ⇒ 放宽到公共祖先；
/// ③ 被引用文件**自己**还往上走时也要算进去 —— 只按"目标文件的公共祖先"算是错的，
/// 必须按 `..` 的层数算（否则 `base/notes` 里的 `sub/head.typ` 写 `../../x` 仍会越界）。
#[test]
fn project_root_widening_rules() {
    let base =
        std::env::temp_dir().join(format!("typst-pad-test-{}-root", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let notes = base.join("notes");
    let sub = notes.join("sub");
    let lib = base.join("touying");
    fs::create_dir_all(&sub).unwrap();
    fs::create_dir_all(&lib).unwrap();
    fs::write(lib.join("z.typ"), "#let hi() = [模板]\n").unwrap();
    // 被引用文件自己的引用要往上两层：根不放宽到 base 就会越界
    fs::write(
        sub.join("head.typ"),
        "#import \"../../touying/z.typ\": hi

#hi()
",
    )
    .unwrap();
    let doc = notes.join("main.typ");
    let doc_s = doc.to_string_lossy().to_string();
    // 临时目录本身可能是符号链接（macOS 的 /var → /private/var），两边都 canonicalize
    let canon_base = fs::canonicalize(&base).unwrap();
    let canon_notes = fs::canonicalize(&notes).unwrap();

    let same = resolve_project_root("#import \"t.typ\": a\n", &doc_s).expect("能解析出根");
    assert_eq!(same.root, canon_notes, "同目录引用不该放宽项目根");
    assert_eq!(same.main_file, canon_notes.join("main.typ"));

    let up =
        resolve_project_root("#import \"../touying/z.typ\": hi\n", &doc_s).expect("能解析出根");
    assert_eq!(up.root, canon_base, "引用上一层目录应放宽到公共祖先");

    let nested = resolve_project_root("#import \"sub/head.typ\": hi\n", &doc_s)
        .expect("能解析出根");
    assert_eq!(
        nested.root, canon_base,
        "被引用文件自己的 `../../` 也要落在根内（要递归看它引用了什么）"
    );

    let _ = fs::remove_dir_all(&base);
}

/// 目标文件不存在（名字写错 / 还没建）时：报"找不到"，**不再**报越界 ——
/// 放宽是纯词法的，所以"文档目录之外"本身不再构成错误。
#[test]
fn relative_import_missing_target_reports_not_found() {
    let base =
        std::env::temp_dir().join(format!("typst-pad-test-{}-imp-gone", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let docs = base.join("week2");
    fs::create_dir_all(&docs).unwrap();
    fs::write(
        docs.join("main.typ"),
        "#import \"../weekly-template/不存在.typ\": hi

#hi(1)
",
    )
    .unwrap();

    let src = fs::read_to_string(docs.join("main.typ")).unwrap();
    let doc_path = docs.join("main.typ").to_string_lossy().to_string();
    let out = compile(src, Some(doc_path), &fonts_dir(), &FontConfig::default());
    assert!(!out.ok, "目标不存在当然编译失败");
    assert!(
        out.diagnostics.iter().all(|d| !d.message.contains("escape")),
        "不该再报越界（放宽是纯词法的），实际: {:?}",
        out.diagnostics
    );
    let _ = fs::remove_dir_all(&base);
}

/// 越界诊断的补充说明（纯函数）：把当前项目根与"跨卷是硬限制"讲清楚
#[test]
fn escape_hint_explains_project_root() {
    let msg = "path `\"../z.typ\"` would escape the project root";
    let hint = escape_hint(msg, Some(Path::new("/proj/docs"))).expect("越界要给提示");
    assert!(hint.contains("/proj/docs"), "要说清当前项目根: {hint}");
    assert!(hint.contains("跨卷"), "要讲清跨卷是硬限制: {hint}");
    assert!(
        escape_hint("其它错误", Some(Path::new("/proj"))).is_none(),
        "别的错误不该被加料"
    );
    assert!(
        escape_hint(msg, None).unwrap().contains("未保存"),
        "没有根时要说清是未保存"
    );
}

/// 未保存文档 + 相对 #import：同样给出"需要先保存文档"（此前只认 #include，
/// `#import` 会掉进引擎那句笼统的 failed to load file）
#[test]
fn unsaved_relative_import_precheck() {
    let out = compile(
        "#import \"chapter.typ\": x

#x
"
        .to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(!out.ok);
    let d = out
        .diagnostics
        .iter()
        .find(|d| d.message.contains("保存"))
        .expect("应有\"需要先保存文档\"诊断");
    assert_eq!(d.line, 1, "import 在第 1 行");
    assert!(d.column >= 1);
}

/// 契约：主文档的诊断**不带** `path` 键，子文件（include/import）的才带。
///
/// 前端按「`path` 缺失/空 ⇒ 主源，要画波浪线」消费（`squiggleRanges`）。曾经发
/// `"path":null` 而前端只认 `undefined`/`""` ⇒ 主源错误全被判成"非主源文件"跳过，
/// 桌面版从 0.4.0 起**编译错误一条波浪线都不画**（浏览器验收的桩不发该字段，抓不到）。
#[test]
fn diagnostic_path_key_omitted_for_main_source() {
    let main = Diagnostic {
        message: "m".into(),
        severity: "error".into(),
        line: 1,
        column: 1,
        end_line: Some(1),
        end_column: Some(2),
        path: None,
    };
    let json = serde_json::to_string(&main).unwrap();
    assert!(!json.contains("path"), "主源诊断不该发 path 键: {json}");

    let other = Diagnostic {
        path: Some("sub/a.typ".into()),
        ..main
    };
    let json = serde_json::to_string(&other).unwrap();
    assert!(json.contains(r#""path":"sub/a.typ""#), "子文件诊断要带 path: {json}");

    // 真实编译结果（主源语法错误）整包 JSON 里也不该出现 path
    let out = compile(
        "#let = 3
hello"
            .to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(!out.ok);
    let json = serde_json::to_string(&out).unwrap();
    assert!(!json.contains("path"), "整包输出不该有 path: {json}");
}

/// 未保存文档 + 相对 include：给出"需要先保存文档"明确诊断
#[test]
fn unsaved_relative_include() {
    let out = compile(
        "#include \"chapter.typ\"
"
        .to_string(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
    );
    assert!(!out.ok);
    let d = out
        .diagnostics
        .iter()
        .find(|d| d.message.contains("保存"))
        .expect("应有\"需要先保存文档\"诊断");
    assert_eq!(d.line, 1, "include 在第 1 行");
    assert!(d.column >= 1);
}

/// 序列化契约：JSON 键名必须是 camelCase（endLine/endColumn），前端按此消费
/// 默认字体族注入：注入后应与「文档里显式 #set text(font:)」完全等价，
/// 且与不注入（走 typst 自动回退）结果不同——回退会挑到楷体/隶书（Windows）或
/// Noto Sans CJK 的日文字形（Linux），中文排版不可控。
#[test]
fn default_font_families_apply() {
    let dir = fonts_dir();
    let body = "中文测试 汉字永\n";
    let injected = compile(
        body.to_string(),
        None,
        &dir,
        &FontConfig {
            families: vec!["Noto Serif CJK SC".to_string()],
            dirs: Vec::new(),
        },
    );
    let explicit = compile(
        format!("#set text(font: \"Noto Serif CJK SC\")\n{body}"),
        None,
        &dir,
        &FontConfig { families: Vec::new(), dirs: Vec::new() },
    );
    let fallback = compile(
        body.to_string(),
        None,
        &dir,
        &FontConfig { families: Vec::new(), dirs: Vec::new() },
    );
    assert!(injected.ok && explicit.ok && fallback.ok, "三个文档都应编译成功");
    assert_eq!(
        injected.pages, explicit.pages,
        "注入默认字体族应与文档里显式 #set text(font:) 等价"
    );
    assert_ne!(injected.pages, fallback.pages, "不注入时应走回退，结果不应与注入相同");
}

/// 把单 face 的 sfnt 包成 `faces` 个 face 的 **.ttc 集合**（测试用）。
///
/// 集合头：`ttcf` + version + numFonts + 每个 face 的偏移（都指向同一份表目录）；
/// **表记录里的偏移必须加上基准值**——ttf-parser 把表偏移当"从整个文件开头算"
/// （见 `RawFace::table`），真实 .ttc 也是这么约定的，所以复制的这份要平移。
fn wrap_as_ttc(sfnt: &[u8], faces: usize) -> Vec<u8> {
    let base = 12 + 4 * faces;
    let mut out = Vec::with_capacity(base + sfnt.len());
    out.extend_from_slice(b"ttcf");
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    out.extend_from_slice(&(faces as u32).to_be_bytes());
    for _ in 0..faces {
        out.extend_from_slice(&(base as u32).to_be_bytes());
    }
    let mut font = sfnt.to_vec();
    let num_tables = u16::from_be_bytes([font[4], font[5]]) as usize;
    for i in 0..num_tables {
        let rec = 12 + i * 16; // tag(4) + checksum(4) + offset(4) + length(4)
        let off = u32::from_be_bytes([font[rec + 8], font[rec + 9], font[rec + 10], font[rec + 11]]);
        let shifted = (off + base as u32).to_be_bytes();
        font[rec + 8..rec + 12].copy_from_slice(&shifted);
    }
    out.extend_from_slice(&font);
    out
}

/// 字体集合（.ttc/.otc）：**每个 face 都要注册**，且 .ttc 扩展名要被收进来。
/// 回归背景（2026-09-14 用户报「字体列表和 `typst fonts` 不一样」）：旧代码只收
/// .ttf/.otf 且只取 face 0，而 Windows 的 SimSun / 微软雅黑 / 微软正黑体 全是 .ttc 集合 ——
/// 这些字体在应用里根本不存在，`DEFAULT_FONT_FAMILIES` 里的 "SimSun" 永远命中不了。
#[test]
fn font_collection_registers_every_face() {
    let single = fs::read(fonts_dir().join("LibertinusSerif-Regular.otf")).unwrap();
    let dir = std::env::temp_dir().join(format!("typst-pad-test-ttc-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // ① 两个 face 的集合：应注册出 2 个字体、同一个族
    fs::write(dir.join("pair.ttc"), wrap_as_ttc(&single, 2)).unwrap();
    let (book, fonts) = load_fonts(&dir);
    assert_eq!(fonts.len(), 2, "集合里的两个 face 都应注册（旧代码只会注册 0 个）");
    assert!(book.contains_family("libertinus serif"), "集合里的字体族应进 FontBook");
    // 下拉列表（用户看到的那份）也要有它
    let families = list_font_families(&dir, &[]);
    assert!(
        families.iter().any(|f| f == "Libertinus Serif"),
        ".ttc 里的字体族应出现在列表里: {families:?}"
    );

    // ② 假集合头（numFonts 与实际不符）不该被当成多 face：坏文件静默跳过
    let mut broken = wrap_as_ttc(&single, 2);
    broken[8..12].copy_from_slice(&9999u32.to_be_bytes());
    let broken_dir = dir.join("broken");
    fs::create_dir_all(&broken_dir).unwrap();
    fs::write(broken_dir.join("broken.ttc"), broken).unwrap();
    let (_, broken_fonts) = load_fonts(&broken_dir);
    assert_eq!(broken_fonts.len(), 0, "坏集合头应静默跳过，不 panic 也不误注册");

    // ③ 非字体扩展名仍然不收（防把 .txt 读进来）
    fs::write(dir.join("readme.txt"), &single).unwrap();
    let (_, only_pair) = load_fonts(&dir);
    assert_eq!(only_pair.len(), 2, "只有 .ttc 被注册，readme.txt 不算字体");

    let _ = fs::remove_dir_all(&dir);
}

/// 字体族列表（设置里的下拉数据源）：包含打包字体与系统字体。
#[test]
fn font_families_listing_includes_bundled() {
    let families = list_font_families(&fonts_dir(), &[]);
    for want in [
        "Noto Serif CJK SC",
        "Libertinus Serif",
        "DejaVu Sans Mono",
        "New Computer Modern Math",
    ] {
        assert!(families.iter().any(|f| f == want), "字体族列表应包含 {want}");
    }
}

/// 额外字体目录不存在时静默跳过：用户在设置里写错路径不该让编译挂掉。
#[test]
fn missing_extra_font_dir_is_ignored() {
    let bogus = std::env::temp_dir().join("typst-pad-no-such-fonts-dir");
    let cfg = FontConfig { families: Vec::new(), dirs: vec![bogus] };
    let out = compile("中文可编译\n".to_string(), None, &fonts_dir(), &cfg);
    assert!(out.ok, "额外字体目录不存在时仍应正常编译");
}

#[test]
fn json_keys_are_camel_case() {
    let out = CompileOutput {
        ok: true,
        pages: vec!["<svg>…</svg>".to_string()],
        diagnostics: Vec::new(),
        warnings: vec![Diagnostic {
            message: "警告".to_string(),
            severity: "warning".to_string(),
            line: 2,
            column: 3,
            end_line: Some(4),
            end_column: Some(5),
            path: Some("sub/a.typ".to_string()),
        }],
    };
    let json = serde_json::to_string(&out).unwrap();
    assert!(
        json.contains("\"endLine\":4"),
        "应输出 endLine，实际: {json}"
    );
    assert!(
        json.contains("\"endColumn\":5"),
        "应输出 endColumn，实际: {json}"
    );
    assert!(
        !json.contains("end_line"),
        "不应输出 snake_case，实际: {json}"
    );
    assert!(json.contains("\"ok\":true"));
    assert!(json.contains("\"pages\""));

    // 单条诊断结构：message/severity/line/column/endLine/endColumn/path
    let pdf = PdfResult {
        ok: false,
        error: Some("失败".into()),
    };
    let json = serde_json::to_string(&pdf).unwrap();
    assert_eq!(json, r#"{"ok":false,"error":"失败"}"#);
}

/// 字体计数辅助（供端到端测试断言）
fn font_count() -> usize {
    load_fonts(&fonts_dir()).1.len()
}

/// 构造临时包目录（在 root 下 {namespace}/{name}/{version}/...）
fn make_pkg(root: &std::path::Path, ns: &str, name: &str, version: &str, files: &[(&str, &str)]) {
    let dir = root.join(ns).join(name).join(version);
    for (rel, content) in files {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
}

/// 端到端 @local：未保存文档也能导入本地包（TYPST_PACKAGE_PATH 注入临时目录，不触用户目录）
#[test]
fn package_import_local_end_to_end() {
    let _guard = crate::packages::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let root = std::env::temp_dir()
        .join(format!("typst-pad-test-{}-pkg-local", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    std::env::set_var("TYPST_PACKAGE_PATH", &root);
    std::env::remove_var("TYPST_PACKAGE_CACHE_PATH");
    make_pkg(
        &root,
        "local",
        "mypkg",
        "1.0.0",
        &[
            ("typst.toml", "[package]\nname = \"mypkg\"\nversion = \"1.0.0\"\nentrypoint = \"lib.typ\"\n"),
            ("lib.typ", "#let hello = [来自本地包的问候]\n"),
        ],
    );

    let src = "#import \"@local/mypkg:1.0.0\": hello\n\n#hello\n".to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "@local 导入应编译成功，实际诊断: {:?}", out.diagnostics);
    // SVG 文本按字形渲染（<use> 引用字形路径），8 个汉字对应 8 个字形
    assert!(
        out.pages[0].matches("<use").count() >= 8,
        "包内内容应渲染进页面（字形数），实际 {}",
        out.pages[0].matches("<use").count()
    );
    std::env::remove_var("TYPST_PACKAGE_PATH");
    let _ = fs::remove_dir_all(&root);
}

/// 端到端 @preview：缓存命中（预置伪造包目录）即可离线编译，不发网络请求
#[test]
fn package_import_preview_cache_end_to_end() {
    let _guard = crate::packages::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let root = std::env::temp_dir()
        .join(format!("typst-pad-test-{}-pkg-preview", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    std::env::remove_var("TYPST_PACKAGE_PATH");
    std::env::set_var("TYPST_PACKAGE_CACHE_PATH", &root);
    make_pkg(
        &root,
        "preview",
        "pkg",
        "0.2.0",
        &[
            ("typst.toml", "[package]\nname = \"pkg\"\nversion = \"0.2.0\"\nentrypoint = \"lib.typ\"\n"),
            ("lib.typ", "#let v = 42\n"),
        ],
    );

    let src = "#import \"@preview/pkg:0.2.0\": v\n\n#v\n".to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(out.ok, "@preview 缓存命中应编译成功，实际诊断: {:?}", out.diagnostics);
    // SVG 文本按字形渲染：数字 42 对应 2 个字形
    assert!(
        out.pages[0].matches("<use").count() >= 2,
        "包内变量应渲染进页面（字形数），实际 {}",
        out.pages[0].matches("<use").count()
    );
    std::env::remove_var("TYPST_PACKAGE_CACHE_PATH");
    let _ = fs::remove_dir_all(&root);
}

/// 端到端诊断：@local 包不存在时给出"package not found"诊断（编译失败路径，用户可读）
#[test]
fn package_import_missing_reports_diagnostic() {
    let _guard = crate::packages::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let root = std::env::temp_dir()
        .join(format!("typst-pad-test-{}-pkg-missing", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    // 空目录：@local 必然 miss（@local 不下载，不发网络请求）
    std::env::set_var("TYPST_PACKAGE_PATH", &root);
    std::env::set_var("TYPST_PACKAGE_CACHE_PATH", &root);

    let src = "#import \"@local/ghost:1.0.0\": x\n".to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(!out.ok, "不存在的包应编译失败");
    let d = out
        .diagnostics
        .iter()
        .find(|d| d.message.contains("package not found"))
        .expect("应有 package not found 诊断");
    assert!(d.line >= 1 && d.column >= 1, "诊断应定位到导入处");
    std::env::remove_var("TYPST_PACKAGE_PATH");
    std::env::remove_var("TYPST_PACKAGE_CACHE_PATH");
    let _ = fs::remove_dir_all(&root);
}
