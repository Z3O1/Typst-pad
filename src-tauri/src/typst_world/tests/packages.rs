// 包系统端到端：`@local` 读取、`@preview` 缓存命中/下载、404 与网络失败的区分（全用临时目录）。
use super::super::*;
use super::*;

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
    let _guard = crate::packages::ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root =
        std::env::temp_dir().join(format!("typst-pad-test-{}-pkg-local", std::process::id()));
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
            (
                "typst.toml",
                "[package]\nname = \"mypkg\"\nversion = \"1.0.0\"\nentrypoint = \"lib.typ\"\n",
            ),
            ("lib.typ", "#let hello = [来自本地包的问候]\n"),
        ],
    );

    let src = "#import \"@local/mypkg:1.0.0\": hello\n\n#hello\n".to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(
        out.ok,
        "@local 导入应编译成功，实际诊断: {:?}",
        out.diagnostics
    );
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
    let _guard = crate::packages::ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root =
        std::env::temp_dir().join(format!("typst-pad-test-{}-pkg-preview", std::process::id()));
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
            (
                "typst.toml",
                "[package]\nname = \"pkg\"\nversion = \"0.2.0\"\nentrypoint = \"lib.typ\"\n",
            ),
            ("lib.typ", "#let v = 42\n"),
        ],
    );

    let src = "#import \"@preview/pkg:0.2.0\": v\n\n#v\n".to_string();
    let out = compile(src, None, &fonts_dir(), &FontConfig::default());
    assert!(
        out.ok,
        "@preview 缓存命中应编译成功，实际诊断: {:?}",
        out.diagnostics
    );
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
    let _guard = crate::packages::ENV_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let root =
        std::env::temp_dir().join(format!("typst-pad-test-{}-pkg-missing", std::process::id()));
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
