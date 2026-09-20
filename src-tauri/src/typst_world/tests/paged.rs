// 整篇编译：预览页宽重排、诊断行号口径、中文文档、以及 `CompileOutput` 的 JSON 键名契约。
use super::super::*;
use super::*;

/// 预览重排（2026-09-14 用户要求「预览不要横向滚动条」）：
/// 给定页宽时产物页宽应等于它（越界夹到 180..=A4），并且**正文真的重排了**
/// ——同一段文字在窄页上会排到更多页；不传页宽时仍是文档自己的 A4。
#[test]
fn compile_with_page_width_reflows_preview() {
    let body = "中文测试内容，用于验证按栏宽重新排版。".repeat(120);
    let src = format!("= 标题\n\n{body}\n");

    let wide = compile_with_page_width(
        src.clone(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
    );
    assert!(wide.ok, "A4 编译应成功: {:?}", wide.diagnostics);
    let wide_pt = view_box_width(&wide.pages[0]).expect("应有 viewBox");
    assert!(
        (wide_pt - A4_WIDTH_PT).abs() < 1.0,
        "不传页宽时应是文档默认的 A4（实测 {wide_pt}pt）"
    );

    let narrow = compile_with_page_width(
        src.clone(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        Some(300.0),
    );
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
    let plain = compile_with_page_width(
        src.clone(),
        None,
        &fonts_dir(),
        &FontConfig::default(),
        None,
    );
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
    assert!(
        font_count() >= 7,
        "src-tauri/fonts 下 7 个字体文件应全部注册"
    );
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
