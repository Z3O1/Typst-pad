// 字体：打包 + 系统 + 用户目录的加载、逐 face 注册、进程内缓存、默认族注入。
use super::*;

/// 默认字体族列表（前端未指定时使用）：把「中文不再靠回退」固化下来。
///
/// 顺序即优先级（typst 按列表逐个找能覆盖该字符的字体）：
/// 1. `Libertinus Serif`——拉丁正文与数学文本的 typst 原生默认；
/// 2. `Noto Serif CJK SC`——打包自带的思源宋体（离线可用，与预览/PDF 预期一致）；
/// 3. 系统宋体兜底（`SimSun` Windows / `Songti SC` macOS / `Source Han Serif SC`）——
///    打包那份是**子集**（4382 码位，CJK 基本区缺 83%），生僻字得靠系统字体接住；
/// 4. `Microsoft YaHei` 收尾（覆盖更全，仍好过落到楷体/隶书）。
pub const DEFAULT_FONT_FAMILIES: &[&str] = &[
    "Libertinus Serif",
    "Noto Serif CJK SC",
    "SimSun",
    "Songti SC",
    "Source Han Serif SC",
    "Noto Serif SC",
    "Microsoft YaHei",
];

/// **写作模式的源码透镜要用的打包字体**（前端 `@font-face` 的名单；`src/lib/editor-font.ts`
/// 是它的镜像，`scripts/editor-fonts.test.mjs` 静态对齐两边）。
///
/// 为什么前端要拿到这几份：写作模式是"非光标块显示引擎切片 + 光标所在块展开成源码"。字号
/// （`textPt`）与行高（`par.leading`）早就跟着文档走了，**字体是最后一条腿** —— 切片是 typst 用
/// 这几个打包字体排出来的，而 webview 里的源码此前只能用系统字体栈（Windows 上落到宋体 + Times），
/// 同一段文字在两种形态里字宽与断行都不一样，光标进出块时看起来像"换了一套字"（用户报过
/// 「不要光标在哪里哪里就变大了」，那是字号；这条是同一个毛病的字体版）。
///
/// 这几份字体本来就随应用分发（`tauri.conf.json` 的 `bundle.resources` 把 `fonts/` 交给运行时），
/// 所以这里**不增加安装包体积**，只是把字节交给 webview（前端没有 fs 插件，读不到资源目录）。
pub const EDITOR_FONT_FILES: &[&str] = &[
    "LibertinusSerif-Regular.otf",
    "LibertinusSerif-Bold.otf",
    "NotoSerifCJKsc-Regular.otf",
];

/// 读一份打包字体的原始字节（给前端 `@font-face` 用）。
///
/// **只认白名单里的文件名**：这个命令的参数来自前端，绝不能让它变成"读任意文件"的口子
/// （不在 `EDITOR_FONT_FILES` 里的一律拒绝，`..` 之类自然也进不来）。
pub fn read_editor_font(fonts_dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    if !EDITOR_FONT_FILES.contains(&name) {
        return Err(format!("不认识的字体：{name}"));
    }
    let path = fonts_dir.join(name);
    std::fs::read(&path).map_err(|e| format!("读取字体失败（{}）：{e}", path.display()))
}

/// 字体配置（前端设置传入）。
#[derive(Clone, Debug)]
pub struct FontConfig {
    /// 注入进编译基础样式的默认字体族列表。
    /// - `None`（走 FontConfig::new）= DEFAULT_FONT_FAMILIES（默认：中文直接命中宋体）；
    /// - `Some(空 vec)` = **完全不注入**，交给 typst 原生默认与自动回退；
    /// - `Some(v)` = 注入 v。
    /// 文档里的 `#set text(font: ...)` 优先级始终更高（library.styles 是基础层）。
    pub families: Vec<String>,
    /// 额外字体目录（对齐 typst CLI 的 `--font-path` / `TYPST_FONT_PATHS`）：
    /// 用户在设置里添加的目录，与打包字体、系统字体一起注册进同一个 FontBook。
    pub dirs: Vec<PathBuf>,
}

impl FontConfig {
    /// 从命令参数构造：families 为 None 时用默认列表；目录项去空串。
    pub fn new(families: Option<Vec<String>>, dirs: Option<Vec<String>>) -> Self {
        Self {
            families: match families {
                None => DEFAULT_FONT_FAMILIES.iter().map(|s| s.to_string()).collect(),
                Some(v) => v,
            },
            dirs: dirs
                .unwrap_or_default()
                .into_iter()
                .filter(|d| !d.trim().is_empty())
                .map(PathBuf::from)
                .collect(),
        }
    }
}

impl Default for FontConfig {
    /// 默认配置 = 注入 DEFAULT_FONT_FAMILIES。
    fn default() -> Self {
        Self::new(None, None)
    }
}

/// 构造标准库：把默认字体族列表注入 `Library.styles`（基础样式层）。
///
/// typst-eval 的入口是 `StyleChain::new(&library.styles).chain(&target)`——库样式在**外层**、
/// 文档样式在内层，查找内层先命中，所以文档里的 `#set text(font: ...)` 照旧覆盖这里
/// （与原生 typst 的「用户设置 > 默认设置」一致）。列表为空则完全不注入。
pub(crate) fn build_library(families: &[String]) -> Library {
    let mut library = Library::default();
    if !families.is_empty() {
        let list = FontList(families.iter().map(|f| FontFamily::new(f)).collect());
        library.styles.set(TextElem::font, list);
    }
    library
}

/// 从单个目录加载全部 .ttf/.otf 字体（含子目录递归），返回 (FontBook, 字体列表)
/// （与 FontBook 索引一一对应）。目录不存在/不可读时返回空集（不影响编译，
/// 缺字体时 typst 会给出缺字诊断）。
pub(crate) fn load_fonts(dir: &Path) -> (FontBook, Vec<Font>) {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    load_fonts_from_dir(dir, &mut book, &mut fonts);
    (book, fonts)
}

/// 打包字体目录 + 系统字体目录合并加载，全部注册进同一个 FontBook。
/// 与 typst CLI 字体集对齐：CLI 默认加载系统全部字体，typst-pad 此前只加载打包的
/// 7 个字体，同一文档在两边的字体解析结果可能不一致。目录不存在/不可读时静默跳过。
/// `extra_dirs` 是用户在设置里添加的额外字体目录（同样静默跳过不存在的）。
pub(crate) fn load_fonts_with_system(bundled_dir: &Path, extra_dirs: &[PathBuf]) -> (FontBook, Vec<Font>) {
    let (mut book, mut fonts) = load_fonts(bundled_dir);
    for dir in system_font_dirs() {
        load_fonts_from_dir(&dir, &mut book, &mut fonts);
    }
    for dir in extra_dirs {
        load_fonts_from_dir(dir, &mut book, &mut fonts);
    }
    (book, fonts)
}

/// 递归收集目录（含子目录）下全部字体文件并注册进 book/fonts。
/// 目录不存在/不可读时静默跳过；符号链接目录不递归（防环，与 list_dir_typ 约定一致），
/// broken symlink 跳过。
pub(crate) fn load_fonts_from_dir(dir: &Path, book: &mut FontBook, fonts: &mut Vec<Font>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // metadata 跟随符号链接：broken symlink 会 Err 而跳过
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.is_dir() {
            // 符号链接目录一律不递归（防环）
            let is_symlink = fs::symlink_metadata(&path)
                .is_ok_and(|sm| sm.file_type().is_symlink());
            if is_symlink {
                continue;
            }
            load_fonts_from_dir(&path, book, fonts);
        } else if meta.is_file() {
            register_font_file(&path, book, fonts);
        }
    }
}

/// 读取并注册单个字体文件：`.ttf` / `.otf` / **`.ttc` / `.otc`**（大小写不敏感），
/// 读盘/解析失败静默跳过。
///
/// **集合（collection）里的每个 face 都要注册**（2026-09-14 用户报「字体列表和 `typst fonts`
/// 不一样」）：Windows 上 SimSun / NSimSun（`simsun.ttc`）、Microsoft YaHei / Microsoft YaHei UI
/// （`msyh.ttc`）、微软正黑体（`msjh.ttc`）、细明体（`mingliu.ttc`）**全都是 .ttc 集合**，而
/// `typst fonts` 走 fontdb、会把集合里每个 face 都列出来。旧代码只收 `.ttf/.otf` **且只取
/// face 0**，于是这些字体在应用里压根不存在 —— 连 `DEFAULT_FONT_FAMILIES` 里的 "SimSun" /
/// "Microsoft YaHei" 都永远命中不了（用户改了字体没反应，root 就在这里）。
/// `Font::iter` 是 typst 自己的集合遍历（内部走 `ttf_parser::fonts_in_collection`），
/// 普通单 face 字体也会走到它、行为不变；同一个 `Bytes` 是 Arc 语义，多 face 只共享一份数据。
fn register_font_file(path: &Path, book: &mut FontBook, fonts: &mut Vec<Font>) {
    let is_font = path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
        ["ttf", "otf", "ttc", "otc"]
            .iter()
            .any(|ext| e.eq_ignore_ascii_case(ext))
    });
    if !is_font {
        return;
    }
    let Ok(data) = fs::read(path) else { return };
    for font in Font::iter(Bytes::new(data)) {
        book.push(font.info().clone());
        fonts.push(font);
    }
}

/// 系统字体目录候选（与 typst CLI 默认加载范围对齐），按平台返回：
/// - Windows：`%WINDIR%\Fonts`（WINDIR 环境变量缺失时回退 `C:\Windows\Fonts`）
///   **加上「仅为我安装」的 `%LOCALAPPDATA%\Microsoft\Windows\Fonts`** —— 用户从网上装的
///   字体默认落在这里（fontdb / `typst fonts` 也会读它，只读 WINDIR 就会漏掉一批）
/// - Linux：`/usr/share/fonts`、`/usr/local/share/fonts`、`~/.fonts`（旧约定）、用户字体目录
///   （`$XDG_DATA_HOME/fonts`，未设置时 `$HOME/.local/share/fonts`）
/// - macOS：`/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`
/// 目录可能不存在/不可读，由调用方（load_fonts_with_system）静默跳过。
fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        dirs.push(PathBuf::from(windir).join("Fonts"));
        // 「仅为我安装」（用户级）的字体目录：不存在时加载侧静默跳过
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(
                PathBuf::from(local)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Fonts"),
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/System/Library/Fonts"));
        dirs.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join("Library/Fonts"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/share/fonts"));
        dirs.push(PathBuf::from("/usr/local/share/fonts"));
        // 旧约定的用户字体目录（fontdb 也会扫）
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".fonts"));
        }
        // XDG 优先：$XDG_DATA_HOME/fonts；未设置时退回 $HOME/.local/share/fonts
        match std::env::var("XDG_DATA_HOME").ok().filter(|s| !s.is_empty()) {
            Some(xdg) => dirs.push(PathBuf::from(xdg).join("fonts")),
            None => {
                if let Some(home) = std::env::var_os("HOME") {
                    dirs.push(PathBuf::from(home).join(".local/share/fonts"));
                }
            }
        }
    }
    dirs
}

/// 进程级字体缓存：按「打包目录 + 额外字体目录」列表做 key。
/// 字体集合在一个进程内是静态的（打包/系统目录不变），但用户可以在设置里增删额外字体
/// 目录，所以缓存必须按目录列表区分；Font 为 Arc 引用计数，FontBook 克隆廉价。
/// 前端每次按键都会触发编译，若每次重读几百个系统字体文件将严重拖慢输入。
static FONT_CACHE: OnceLock<Mutex<HashMap<Vec<PathBuf>, Arc<(FontBook, Vec<Font>)>>>> =
    OnceLock::new();

/// 获取字体集：命中缓存返回克隆，未命中则从打包目录 + 系统目录 + 额外目录全量加载。
pub(crate) fn cached_fonts(fonts_dir: &Path, extra_dirs: &[PathBuf]) -> (FontBook, Vec<Font>) {
    let mut key = Vec::with_capacity(extra_dirs.len() + 1);
    key.push(fonts_dir.to_path_buf());
    key.extend(extra_dirs.iter().cloned());
    let cache = FONT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    let entry = guard
        .entry(key)
        .or_insert_with(|| Arc::new(load_fonts_with_system(fonts_dir, extra_dirs)));
    (**entry).clone()
}

/// 列出 FontBook 里的字体族名（排序去重）——设置里「中文字体」下拉的数据源。
/// 选项取自真实注册的字体，用户不可能写出一个不存在的族名（写错的后果是 typst 只发
/// warning 就静默回退到楷体，见模块文档）。
pub fn list_font_families(fonts_dir: &Path, extra_dirs: &[PathBuf]) -> Vec<String> {
    let (book, _) = cached_fonts(fonts_dir, extra_dirs);
    let mut names: Vec<String> = book.families().map(|(family, _)| family.to_string()).collect();
    names.sort_unstable();
    names.dedup();
    names
}

/// 解析字体目录：优先打包/构建产物 resource_dir 下的 fonts（tauri.conf.json
/// bundle.resources 的 `"fonts": "fonts/"` 映射而来），退回仓库内 `src-tauri/fonts`
/// （开发模式不复制资源时的兜底，也是 cargo test 的路径）。
/// 字体目录**不放在前端静态目录**（曾经的 `static/fonts`）：那会被 SvelteKit 整份拷进前端
/// 产物（`build/fonts/`），而前端从不引用它（无 @font-face），安装包里凭空多一份 5.7MB。
pub fn resolve_fonts_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        // bundle.resources 走 map 形式 `fonts -> fonts/` 时落在 resource_dir/fonts
        let candidate = res.join("fonts");
        if candidate.is_dir() {
            return candidate;
        }
    }
    // 开发/测试回退：CARGO_MANIFEST_DIR = src-tauri，字体育其同目录
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}
