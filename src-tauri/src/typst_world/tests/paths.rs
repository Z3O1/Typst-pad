// 路径与诊断口径：相对 include/import、项目根放宽、缺文件提示、未保存文档预检、主源不发 `path`。
use super::super::*;
use super::*;

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
    let out = compile(
        src,
        Some(doc_path.clone()),
        &fonts_dir(),
        &FontConfig::default(),
    );
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
    let dir = std::env::temp_dir().join(format!("typst-pad-test-{}-missing", std::process::id()));
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
    let dir = std::env::temp_dir().join(format!("typst-pad-test-{}-imp-same", std::process::id()));
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
    let base = std::env::temp_dir().join(format!("typst-pad-test-{}-imp-up", std::process::id()));
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
    let base = std::env::temp_dir().join(format!("typst-pad-test-{}-root", std::process::id()));
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

    let nested =
        resolve_project_root("#import \"sub/head.typ\": hi\n", &doc_s).expect("能解析出根");
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
    let base = std::env::temp_dir().join(format!("typst-pad-test-{}-imp-gone", std::process::id()));
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
        out.diagnostics
            .iter()
            .all(|d| !d.message.contains("escape")),
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
    assert!(
        json.contains(r#""path":"sub/a.typ""#),
        "子文件诊断要带 path: {json}"
    );

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
