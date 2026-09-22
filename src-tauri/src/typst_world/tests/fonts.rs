// 字体：打包字体白名单与族名、FontBook 注册、正文字体族注入、集合字体（TTC）多 face、额外目录。
use super::*;

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
        &FontConfig {
            families: Vec::new(),
            dirs: Vec::new(),
        },
    );
    let fallback = compile(
        body.to_string(),
        None,
        &dir,
        &FontConfig {
            families: Vec::new(),
            dirs: Vec::new(),
        },
    );
    assert!(
        injected.ok && explicit.ok && fallback.ok,
        "三个文档都应编译成功"
    );
    assert_eq!(
        injected.pages, explicit.pages,
        "注入默认字体族应与文档里显式 #set text(font:) 等价"
    );
    assert_ne!(
        injected.pages, fallback.pages,
        "不注入时应走回退，结果不应与注入相同"
    );
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
        let off =
            u32::from_be_bytes([font[rec + 8], font[rec + 9], font[rec + 10], font[rec + 11]]);
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
    assert_eq!(
        fonts.len(),
        2,
        "集合里的两个 face 都应注册（旧代码只会注册 0 个）"
    );
    assert!(
        book.contains_family("libertinus serif"),
        "集合里的字体族应进 FontBook"
    );
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
    assert_eq!(
        broken_fonts.len(),
        0,
        "坏集合头应静默跳过，不 panic 也不误注册"
    );

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
        assert!(
            families.iter().any(|f| f == want),
            "字体族列表应包含 {want}"
        );
    }
}

/// 额外字体目录不存在时静默跳过：用户在设置里写错路径不该让编译挂掉。
#[test]
fn missing_extra_font_dir_is_ignored() {
    let bogus = std::env::temp_dir().join("typst-pad-no-such-fonts-dir");
    let cfg = FontConfig {
        families: Vec::new(),
        dirs: vec![bogus],
    };
    let out = compile("中文可编译\n".to_string(), None, &fonts_dir(), &cfg);
    assert!(out.ok, "额外字体目录不存在时仍应正常编译");
}
