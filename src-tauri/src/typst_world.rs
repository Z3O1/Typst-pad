//! 内嵌 Typst 编译世界：字体加载、主文档/相对 include 的磁盘解析、包（@local/@preview）
//! 解析、编译与导出（SVG/PDF）。
//!
//! 整体思路参考 typst 官方 CLI（typst-cli 的 SystemWorld），但针对编辑器场景做了简化：
//! - 字体：打包字体目录（打包后为 resource_dir/fonts，开发/测试为 `src-tauri/fonts`）
//!   与系统字体目录（见 system_font_dirs，Windows/Linux/macOS）合并加载全部 .ttf/.otf，
//!   注册进同一个 FontBook（与 typst CLI 字体集对齐，同一文档两边字体解析一致），
//!   再加上用户设置的额外字体目录（FontConfig.dirs，对齐 typst CLI 的 --font-path）；
//!   进程内缓存（cached_fonts，按「打包目录 + 额外目录」列表做 key），复用而非重读盘；
//! - 默认字体：FontConfig.families 注入 Library.styles（基础样式层）。**必须注入**：
//!   不注入时中文完全交给 typst 自动回退，而回退打分是「先看衬线标记（Libertinus Serif
//!   的 panose 全 0 → 被判无衬线，于是所有宋体都被扣分）→ 再比家族名谁短」，实测
//!   Windows 挑到楷体/隶书、Linux 挑到 Noto Sans CJK 的日文字形（2026-09-14 用 typst
//!   0.15.1 在两边 CLI 复现）。文档里的 `#set text(font: ...)` 优先级更高，照旧覆盖。
//! - 文件：主文档源码由前端传入（未保存即可编译）；相对 include 以 document_path 所在目录为
//!   根从磁盘读取（与 typst 语义一致：相对路径基于引用文件所在目录解析，根为项目目录）；
//! - 包：`@local/{name}:{version}` 从本地数据目录读取；`@preview/{name}:{version}` 从缓存
//!   目录读取，缓存 miss 时自动下载（目录规范与下载逻辑见 packages.rs，与 typst CLI 一致）；
//! - document_path 为 None（未保存文档）时，相对导入无法解析磁盘路径，编译前先预检给出
//!   "需要先保存文档" 的明确诊断（包导入不依赖文档位置，无需保存）。
//!
//! 接口契约（前端按此消费，serde rename_all = "camelCase"，多词字段为 camelCase 键名）：
//! - compile_doc -> CompileOutput { ok, pages, diagnostics, warnings }
//! - export_pdf  -> PdfResult { ok, error }
//! - Diagnostic  -> { message, severity, line, column, endLine, endColumn, path }
//!   （行列均为 1-based，CodeMirror 波浪线直接消费）

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, LinkedNode, RootedPath, Source, SyntaxKind, VirtualPath, VirtualRoot};
use typst::text::{
    BottomEdge, BottomEdgeMetric, Font, FontBook, FontFamily, FontList, TextEdgeBounds,
    TextElem, TopEdge, TopEdgeMetric,
};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst::layout::{Abs, Frame, FrameItem, Point};
use typst_layout::{Page, PagedDocument};
use typst_pdf::PdfOptions;
use typst_svg::SvgOptions;

/// 编译输出（成功：pages 为每页 SVG；失败：diagnostics 为错误列表；warnings 附加在成功分支）。
/// 空字段序列化时省略，成功分支只有 ok/pages(/warnings)，失败分支只有 ok/diagnostics，
/// 与前端契约一致。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOutput {
    pub ok: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pages: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<Diagnostic>,
}

impl CompileOutput {
    /// 内部错误（编译任务异常等）：对外表现为编译失败
    pub(crate) fn internal_error(msg: &str) -> Self {
        Self {
            ok: false,
            pages: Vec::new(),
            diagnostics: vec![Diagnostic {
                message: msg.to_string(),
                severity: "error".to_string(),
                line: 1,
                column: 1,
                end_line: None,
                end_column: None,
                path: None,
            }],
            warnings: Vec::new(),
        }
    }
}

/// PDF 导出结果（导出失败时 error 为人类可读信息）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// 单条诊断：1-based 行列，CodeMirror 波浪线直接消费。
/// serde camelCase：end_line/end_column 序列化为 endLine/endColumn，前端直接消费。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub message: String,
    /// "error" | "warning"
    pub severity: String,
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    /// 出错文件路径：主文档为 None，include 文件给出其路径
    pub path: Option<String>,
}

/// 进程内编译世界：实现 typst::World。
///
/// 一次编译构建一个实例（编译串行化由 lib.rs 的命令层互斥锁保证）。
/// 源码缓存用 Mutex 内可变性（World trait 方法只接受 &self）。
pub struct TypstWorld {
    /// 标准库（typst 0.15 需要 LazyHash 包装以支持增量编译校验）
    library: LazyHash<Library>,
    /// 字体元数据
    book: LazyHash<FontBook>,
    /// 已加载字体（Font 为引用计数，克隆廉价）
    fonts: Vec<Font>,
    /// 项目根目录（主文档所在目录；None = 文档未保存，无法解析相对导入）
    root: Option<PathBuf>,
    /// 主文档 FileId
    main_id: FileId,
    /// 主文档源码（前端传入，未保存也可编译）
    main_source: Source,
    /// include 等已解析源码的缓存（同一 FileId 不会重复读盘）
    sources: Mutex<HashMap<FileId, Source>>,
}

impl TypstWorld {
    /// 构建编译世界。
    ///
    /// - `src`：主文档源码
    /// - `document_path`：主文档磁盘路径（决定项目根目录与 include 解析；None = 未保存）
    /// - `fonts_dir`：打包字体目录（.ttf/.otf 全量加载；系统目录 + 额外目录自动合并，进程内缓存）
    /// - `font_config`：默认字体族列表（注入基础样式，中文不再走回退）与额外字体目录
    pub fn new(
        src: String,
        document_path: Option<String>,
        fonts_dir: &Path,
        font_config: &FontConfig,
    ) -> Self {
        let (book, fonts) = cached_fonts(fonts_dir, &font_config.dirs);
        let library = build_library(&font_config.families);

        // 项目根 = 主文档所在目录；主 FileId 的虚拟路径相对该根（盘符前缀被剥离）
        let (root, main_id) = match document_path {
            Some(path) => {
                let raw = PathBuf::from(path);
                let (root, main_id) = match (raw.parent(), raw.file_name()) {
                    // 规范化父目录（去 `..`/符号链接），保证虚拟化后的路径不越界
                    (Some(parent), Some(name)) => {
                        let root =
                            fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                        let abs = root.join(name);
                        match VirtualPath::virtualize(&root, &abs) {
                            Ok(vpath) => (
                                Some(root),
                                RootedPath::new(VirtualRoot::Project, vpath).intern(),
                            ),
                            Err(_) => (Some(root), Self::anonymous_main_id()),
                        }
                    }
                    _ => (None, Self::anonymous_main_id()),
                };
                (root, main_id)
            }
            None => (None, Self::anonymous_main_id()),
        };

        let main_source = Source::new(main_id, src);
        Self {
            library: LazyHash::new(library),
            book: LazyHash::new(book),
            fonts,
            root,
            main_id,
            main_source,
            sources: Mutex::new(HashMap::new()),
        }
    }

    /// 未保存文档时的虚拟主 FileId（无盘上文件对应，include 会报"需要先保存"）
    fn anonymous_main_id() -> FileId {
        RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("main.typ").expect("固定文件名必然合法"),
        )
        .intern()
    }

    /// FileId 对应的磁盘真实路径（项目根内文件按根解析；包文件经 packages.rs 解析，
    /// @preview 缓存 miss 时会在此时触发下载——source()/file() 都走这里，包内互相导入
    /// 递归成立；下载为同步调用但编译整体在 spawn_blocking 内执行，不阻塞 UI）
    fn realize(&self, id: FileId) -> FileResult<PathBuf> {
        match id.root() {
            VirtualRoot::Project => {
                let root = self.root.as_deref().ok_or_else(|| {
                    FileError::Other(Some(
                        "文档未保存，无法解析相对路径（请先保存文档）".into(),
                    ))
                })?;
                id.vpath().realize(root).map_err(Into::into)
            }
            // @local/@preview 包：目录解析 + 缓存 miss 下载（诊断复用引擎
            // PackageError：404→not found，网络失败→download failed，可区分）
            VirtualRoot::Package(spec) => crate::packages::resolve_package_path(spec, id.vpath()),
        }
    }

    /// 读取并缓存一个 .typ 源文件（主文档走 main_source，不走磁盘）
    fn read_source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main_id {
            return Ok(self.main_source.clone());
        }
        if let Some(src) = self.sources.lock().ok().and_then(|s| s.get(&id).cloned()) {
            return Ok(src);
        }
        let path = self.realize(id)?;
        let text = fs::read_to_string(&path).map_err(|e| FileError::from_io(e, &path))?;
        let source = Source::new(id, text);
        if let Ok(mut s) = self.sources.lock() {
            s.insert(id, source.clone());
        }
        Ok(source)
    }

    /// 用户可读的出错文件路径（主文档为 None，include 为磁盘路径）
    pub fn path_of(&self, id: FileId) -> Option<String> {
        if id == self.main_id {
            return None;
        }
        // 包内文件直接给虚拟路径（@preview/name:version/...），
        // 不走 realize——避免定位诊断时再次触发下载
        if let VirtualRoot::Package(spec) = id.root() {
            return Some(format!("{spec}/{}", id.vpath().get_without_slash()));
        }
        match self.realize(id) {
            Ok(path) => Some(path.to_string_lossy().to_string()),
            // 无法定位磁盘路径时退回虚拟路径，便于定位 include
            Err(_) => Some(id.vpath().get_without_slash().to_string()),
        }
    }
}

impl World for TypstWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main_id
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.read_source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main_id {
            return Ok(Bytes::from_string(self.main_source.text().to_owned()));
        }
        let path = self.realize(id)?;
        let data = fs::read(&path).map_err(|e| FileError::from_io(e, &path))?;
        Ok(Bytes::new(data))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    /// 当前 UTC 日期（`datetime.today()` 用）。本地时区偏移未实现，统一按 UTC 返回，
    /// 与 `offset` 参数无关——编辑器场景可接受，留待后续完善。
    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        let days = secs.div_euclid(86_400);
        let (year, month, day) = civil_from_days(days);
        let hour = (secs.rem_euclid(86_400) / 3_600) as u8;
        let minute = (secs.rem_euclid(3_600) / 60) as u8;
        let second = secs.rem_euclid(60) as u8;
        Datetime::from_ymd_hms(year, month, day, hour, minute, second)
    }
}

/// Howard Hinnant 的 civil_from_days 算法：Unix 纪元天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i32, u8, u8) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    (if m <= 2 { (y + 1) as i32 } else { y as i32 }, m, d)
}

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
fn build_library(families: &[String]) -> Library {
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
fn load_fonts(dir: &Path) -> (FontBook, Vec<Font>) {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    load_fonts_from_dir(dir, &mut book, &mut fonts);
    (book, fonts)
}

/// 打包字体目录 + 系统字体目录合并加载，全部注册进同一个 FontBook。
/// 与 typst CLI 字体集对齐：CLI 默认加载系统全部字体，typst-pad 此前只加载打包的
/// 7 个字体，同一文档在两边的字体解析结果可能不一致。目录不存在/不可读时静默跳过。
/// `extra_dirs` 是用户在设置里添加的额外字体目录（同样静默跳过不存在的）。
fn load_fonts_with_system(bundled_dir: &Path, extra_dirs: &[PathBuf]) -> (FontBook, Vec<Font>) {
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
fn load_fonts_from_dir(dir: &Path, book: &mut FontBook, fonts: &mut Vec<Font>) {
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
fn cached_fonts(fonts_dir: &Path, extra_dirs: &[PathBuf]) -> (FontBook, Vec<Font>) {
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

/// A4 尺寸（pt）：预览重排按它的比例缩放页宽/页高/边距
const A4_WIDTH_PT: f64 = 595.28;
const A4_HEIGHT_PT: f64 = 841.89;
/// 预览重排的边距比例：A4 的默认边距（2.5cm ≈ 70.87pt）占页宽的比例，按同比例缩放
const PREVIEW_MARGIN_RATIO: f64 = 70.87 / A4_WIDTH_PT;
/// 预览页宽的允许范围（pt）：太窄会把正文挤成一列碎字，超过 A4 没有意义（前端也会夹）
const PREVIEW_PAGE_MIN_PT: f64 = 180.0;

/// 预览重排用的页设置语句（typst 源码，**一行**）。
///
/// 为什么要它：预览画布是一张**固定版心**的页面（A4），界面放大后它比预览栏宽，
/// 用户就得横向拖动才能看完一行（2026-09-14 反馈「预览模式还是有横的拖动的条」）。
/// 这一行把预览的纸张改成"和预览栏一样宽、字号不变"——正文**按新宽度重新排版**，
/// 于是画布正好铺满预览栏、永不出现横向滚动条，而且预览字号仍与编辑器一致。
/// 代价：预览的换行/分页不再等于导出的 PDF（用户明确选择接受）。
///
/// 注意它放在编译源的**最前面**：文档自己写 `#set page(...)`（后写的赢）就会覆盖它，
/// 那时预览退回旧的"按栏宽等比缩放"路径——前端用返回 SVG 的实际页宽判断是否生效。
fn preview_page_setup(width_pt: f64) -> Option<String> {
    if !width_pt.is_finite() {
        return None;
    }
    let width = width_pt.clamp(PREVIEW_PAGE_MIN_PT, A4_WIDTH_PT);
    let height = width * A4_HEIGHT_PT / A4_WIDTH_PT;
    let margin = width * PREVIEW_MARGIN_RATIO;
    Some(format!(
        "#set page(width: {width:.2}pt, height: {height:.2}pt, margin: {margin:.2}pt)"
    ))
}

/// 编译文档为每页 SVG（pages 按页序，含 <svg> 标签）。
/// 失败时返回诊断列表；成功但带警告时 warnings 附加返回。
pub fn compile(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> CompileOutput {
    compile_with_page_width(src, document_path, fonts_dir, font_config, None)
}

/// 同 [`compile`]，但可以指定**预览页宽**（pt）：`Some(w)` 时在编译源最前面注入一行
/// [`preview_page_setup`]，让预览按预览栏宽度重新排版（见那里的说明）。
/// 主源诊断的行号会**减回**注入的那一行，所以前端的位置映射逻辑完全不用改；
/// include 文件（path 非空）的诊断行号不动。
pub fn compile_with_page_width(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    preview_width_pt: Option<f64>,
) -> CompileOutput {
    // 未保存文档时预检相对 include，给出明确诊断（编译阶段只会得到笼统的 file not found）。
    // **在注入页设置之前做**：这些诊断的行号直接来自用户文档，不该被注入的行影响。
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return CompileOutput {
                ok: false,
                pages: Vec::new(),
                diagnostics: diags,
                warnings: Vec::new(),
            };
        }
    }

    let injected = preview_width_pt.and_then(preview_page_setup);
    let main_line_offset = if injected.is_some() { 1 } else { 0 };
    let src = match injected {
        Some(setup) => format!("{setup}\n{src}"),
        None => src,
    };

    let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
    match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(document),
            warnings,
        } => {
            let pages = document.pages().iter().map(svg_for_page).collect();
            CompileOutput {
                ok: true,
                pages,
                diagnostics: Vec::new(),
                warnings: collect_diagnostics(&world, warnings.into_iter(), main_line_offset),
            }
        }
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => CompileOutput {
            ok: false,
            pages: Vec::new(),
            diagnostics: collect_diagnostics(&world, errors.into_iter(), main_line_offset),
            warnings: Vec::new(),
        },
    }
}

/// 单页 SVG 导出
fn svg_for_page(page: &Page) -> String {
    typst_svg::svg(page, &SvgOptions::default())
}

// ---------------------------------------------------------------------------
// 公式级渲染（编辑器内联渲染 = 所见即所得用）
// ---------------------------------------------------------------------------

/// 公式渲染的默认文本尺寸（pt，= 14px）。
/// **字号必须与编辑器正文字号一致**，否则公式与正文大小不匹配（写作模式正文 16px = 12pt，
/// 前端会把实测字号传进来；源码模式 14px = 10.5pt）。SVG 的 pt 与编辑器 CSS 的 pt
/// 1:1，因此前端不需要任何缩放换算。
pub const MATH_TEXT_PT: f64 = 10.5;

/// 允许的公式字号范围（pt）：防止前端传入荒谬值把探针文档搞坏
const MATH_SIZE_RANGE: std::ops::RangeInclusive<f64> = 6.0..=48.0;

/// 基线探针高度（pt）：零宽盒挂在基线下 100pt（远超任何公式的下沉量），
/// 第二页页高 = 基线以上高度 + 100pt，据此反推基线位置。
const BASELINE_PROBE_PT: f64 = 100.0;

/// 公式渲染结果：svg 为「贴边 + 透明背景」的单页 SVG；
/// baseline_pt 为**基线到盒顶**的距离（前端用 vertical-align: -(height - baseline) 对齐）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MathOutput {
    pub ok: bool,
    pub svg: String,
    pub width_pt: f64,
    pub height_pt: f64,
    pub baseline_pt: f64,
    pub error: Option<String>,
}

impl MathOutput {
    /// 渲染失败：前端据此**保持源码显示**（不显示空 widget，也不报错弹窗）
    fn fail(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            svg: String::new(),
            width_pt: 0.0,
            height_pt: 0.0,
            baseline_pt: 0.0,
            error: Some(message.into()),
        }
    }

    /// 任务异常终止（spawn_blocking panic 等），命令层使用
    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::fail(message)
    }
}

/// 单个公式 → 紧致 SVG + 尺寸与基线（编辑器内联渲染用）。
///
/// **两页探针法**（一次编译同时拿到盒与基线）：typst 的 Page 帧不带基线
/// （`page.frame.baseline()` 实测返回盒底，has_baseline=false），所以自己造参考：
///   第 1 页：`#box($公式$)`          → 页尺寸 = 公式紧致盒（宽 W，高 H = ascent + depth）
///   第 2 页：同一内容 + 一个挂在基线下 `BASELINE_PROBE_PT` 的零宽盒
///            → 页高 = ascent + PROBE，于是 ascent = H2 - PROBE，depth = H - ascent
/// 外层 `#box(...)` 不可省：行间（display 风格）公式不加盒时，第 2 页的探针会另起一段，
/// 段落堆叠会把基线关系算错（实测 ascent 由 11.75pt 变成 31.67pt）。
///
/// context 为编译前缀（用户设置里的前缀代码），与整篇编译同源：`#set font(..)`、
/// `#let` 宏等对公式同样生效；公式字号由本函数**随后强制**为 MATH_TEXT_PT，
/// 保证编辑器内公式与编辑器正文字号一致（前缀里的 `#set text(size:)` 不会带偏公式）。
/// document_path 语义与 compile 一致（相对 include 的解析根；None = 未保存文档）。
pub fn compile_math(
    body: &str,
    display: bool,
    context: &str,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    size_pt: f64,
) -> MathOutput {
    // 夹取到合理范围（NaN/越界都退回默认），保证探针文档始终可编译
    let size_pt = if size_pt.is_finite() && MATH_SIZE_RANGE.contains(&size_pt) {
        size_pt
    } else {
        MATH_TEXT_PT
    };
    // 行内 `$x$`；行间 `$ x $`（首尾空格让 typst 按 display 风格排版）
    let math = if display {
        format!("$ {body} $")
    } else {
        format!("${body}$")
    };
    let src = math_probe_source(context, &math, size_pt, None);

    let world = TypstWorld::new(src, document_path.clone(), fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc), ..
        } => doc,
        typst::diag::Warned {
            output: Err(errors), ..
        } => {
            // 诊断位置属于内部探针文档（含前缀偏移），对用户无意义，只回消息
            let first = errors
                .into_iter()
                .next()
                .map(|d| d.message.to_string())
                .unwrap_or_else(|| "公式编译失败".to_string());
            return MathOutput::fail(first);
        }
    };

    let pages = document.pages();
    if pages.len() < 2 {
        return MathOutput::fail("公式渲染失败：探针文档未产生两页");
    }
    let size = pages[0].frame.size();
    let width_pt = size.x.to_pt();
    let frame_height_pt = size.y.to_pt();
    let probe_height_pt = pages[1].frame.size().y.to_pt();
    // 夹取到 [0, H]：探针盒比公式本身矮时（理论上不会）也不会给出越界基线
    let ascent_pt = (probe_height_pt - BASELINE_PROBE_PT).clamp(0.0, frame_height_pt);

    // 墨迹可能画到帧外（见 ink_bounds_of_frame）：SVG 视口按帧尺寸裁剪，下标就会缺一截。
    let ink = ink_bounds_of_frame(&pages[0].frame);
    let pad_top_pt = (-ink.top.to_pt()).max(0.0);
    let height_pt = ink.bottom.to_pt().max(frame_height_pt) + pad_top_pt;

    // 只有真的溢出时才走第二遍：给页面显式尺寸 + 顶部内边距，让内容整体落在画布内。
    // （不给尺寸就还是贴边页，帧外的东西照样被裁；顶部内边距是因为上标方向也会溢出去）
    let overflows = pad_top_pt > 0.01 || height_pt > frame_height_pt + 0.01;
    let svg = if overflows {
        let src = math_probe_source(
            context,
            &math,
            size_pt,
            Some((width_pt, height_pt, pad_top_pt, ascent_pt)),
        );
        let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
        match typst::compile::<PagedDocument>(&world) {
            typst::diag::Warned {
                output: Ok(doc), ..
            } => {
                svg_for_page(&doc.pages()[0])
            }
            // 第二遍只是"把画布撑大"，失败了就用第一遍的产物（少一截总比什么都没有强）
            typst::diag::Warned { output: Err(_), .. } => svg_for_page(&pages[0]),
        }
    } else {
        svg_for_page(&pages[0])
    };

    MathOutput {
        ok: true,
        svg,
        width_pt,
        height_pt,
        baseline_pt: (ascent_pt + pad_top_pt).clamp(0.0, height_pt),
        error: None,
    }
}

/// 公式探针文档的源码（两遍编译共用）。
///
/// 形态：第一页 = 公式本身（`width/height: auto` + `margin: 0` + `fill: none` → 贴边透明页，
/// SVG 即公式本身）；第二页 = 公式 + 一个挂在基线下 100pt 的零宽盒（用来反推 ascent）。
///
/// `padded` 有值时改用**显式页面尺寸**并给内容加顶部内边距（用于"墨迹画到帧外"的补救，
/// 见 `ink_bounds_of_frame`）：`(page_width, page_height, pad_top, ascent)`。
fn math_probe_source(
    context: &str,
    math: &str,
    size_pt: f64,
    padded: Option<(f64, f64, f64, f64)>,
) -> String {
    let mut src = String::with_capacity(context.len() + math.len() * 2 + 320);
    if !context.is_empty() {
        src.push_str(context);
        if !context.ends_with('\n') {
            src.push('\n');
        }
    }
    match padded {
        None => {
            src.push_str("#set page(width: auto, height: auto, margin: 0pt, fill: none)\n");
            src.push_str(&format!("#set text(size: {size_pt}pt)\n"));
            src.push_str(&format!(
                "#box({math})\n#pagebreak()\n#box({math})#box(width: 0pt, height: {BASELINE_PROBE_PT}pt, baseline: {BASELINE_PROBE_PT}pt)"
            ));
        }
        Some((page_w, page_h, pad_top, ascent)) => {
            // 第一页：显式尺寸 + 顶部内边距（内容整体下移 pad_top，墨迹才落在画布内）
            src.push_str("#set page(margin: 0pt, fill: none)\n");
            src.push_str(&format!("#set text(size: {size_pt}pt)\n"));
            src.push_str(&format!("#set page(width: {page_w}pt, height: {page_h}pt)\n"));
            // 注意：进了 pad(...) 的**代码模式**后子里不能再写 `#box(...)`（会报
            // "the character `#` is not valid in code"），用内容块 `[ ... ]` 回到 markup 模式
            src.push_str(&format!("#pad(top: {pad_top}pt)[#box({math})]\n"));
            // 第二页：探针页保持"自动高度"，高度 = pad_top + ascent + 100
            src.push_str("#set page(width: auto, height: auto)\n");
            src.push_str(&format!(
                "#pagebreak()\n#pad(top: {pad_top}pt)[#box({math})#box(width: 0pt, height: {BASELINE_PROBE_PT}pt, baseline: {BASELINE_PROBE_PT}pt)]"
            ));
            let _ = ascent; // 显式页高已经覆盖了探针页，这里只需保持同一基线
        }
    }
    src
}

/// 帧内容的墨迹纵向范围（相对帧左上角，y 向下）。
///
/// **为什么需要它**：typst 允许把内容画到帧**外面**，帧尺寸只反映"排版尺寸"。数学排版里的
/// 上下标就是这种情形——实测（typst 0.15.1）`$a_0$` 的帧高只有 8.196pt（= 基准字母的 ascent，
/// 基线正好落在帧底边），而下标 `0` 的基线在 **11.16pt**，比帧底还低 2.96pt。平时看不出来
/// （正文页够大、帧不裁剪），但我们的公式页是 `height: auto` 的**贴边页**，导出成 SVG 后
/// **视口就是裁剪框** —— 下标被裁掉，用户看到的就是「a_0 的下半部分没有渲染」。
///
/// 这里递归把帧内容的墨迹范围算出来（group 按自己的仿射变换映射、文本按字体的
/// ascender/descender、图形/图片/链接按各自尺寸），供公式导出把画布撑够。
#[derive(Debug, Clone, Copy)]
struct InkBounds {
    top: Abs,
    bottom: Abs,
}

fn ink_bounds_of_frame(frame: &Frame) -> InkBounds {
    let mut top = Abs::zero();
    let mut bottom = Abs::zero();
    for (pos, item) in frame.items() {
        let (item_top, item_bottom) = item_ink_bounds(item);
        // 子项的坐标在 group 内部，group 的 transform 已在递归里映射过，这里加外层偏移
        let t = pos.y + item_top;
        let b = pos.y + item_bottom;
        if t < top {
            top = t;
        }
        if b > bottom {
            bottom = b;
        }
    }
    InkBounds { top, bottom }
}

/// 单个帧项的墨迹纵向范围（相对该项自己的原点，y 向下、基线为 0）
fn item_ink_bounds(item: &FrameItem) -> (Abs, Abs) {
    match item {
        FrameItem::Text(t) => {
            // 用**字形包围盒**而不是字体度量：度量的 descender 是"排版值"，实测比真实墨迹还浅
            // ——`sqrt(x^2 + y^2)` 里 Libertinus 的 `y` 尾巴比 descender 低约 1pt，用度量会再裁一次。
            let mut up = Abs::zero();
            let mut down = Abs::zero();
            for glyph in &t.glyphs {
                let (top, bottom) = t.font.edges(
                    TopEdge::Metric(TopEdgeMetric::Bounds),
                    BottomEdge::Metric(BottomEdgeMetric::Bounds),
                    t.size,
                    TextEdgeBounds::Glyph(glyph.id),
                );
                if top > up {
                    up = top;
                }
                if bottom > down {
                    down = bottom;
                }
            }
            if up <= Abs::zero() && down <= Abs::zero() {
                // 字体没提供字形包围盒（极少数）：退回字体度量。宁可多留白，也不裁字。
                let m = t.font.metrics();
                (-m.ascender.at(t.size), m.descender.at(t.size).abs())
            } else {
                (-up, down)
            }
        }
        FrameItem::Group(g) => {
            let inner = ink_bounds_of_frame(&g.frame);
            // 子帧的上下边经 group 变换映射回本层（变换可能含 y 翻转，所以取两者较大值）
            let a = Point::new(Abs::zero(), inner.top).transform(g.transform);
            let b = Point::new(Abs::zero(), inner.bottom).transform(g.transform);
            (a.y.min(b.y), a.y.max(b.y))
        }
        FrameItem::Image(_, size, _) | FrameItem::Link(_, size) => (Abs::zero(), size.y),
        FrameItem::Shape(s, _) => {
            // 图形（根号、分数线等）的墨迹就是它自己的包围盒；坐标相对该项原点
            // （y 向下为正，min.y 可能为负 → 会往基线以上长）
            let bb = s.bbox(true);
            (bb.min.y, bb.max.y)
        }
        FrameItem::Tag(_) => (Abs::zero(), Abs::zero()),
    }
}

/// 把公式 SVG 的视口（`viewBox` 与 width/height）撑到给定尺寸，**内容坐标不动**。
/// 只用于"墨迹比页框大"的情形（见 `ink_bounds_of_frame`）：内容锚在左上角，画布变高即可。
fn grow_svg_viewport(svg: &str, width_pt: f64, height_pt: f64) -> String {
    let fmt = |v: f64| {
        let s = format!("{v:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    let mut out = svg.to_string();
    let Some(start) = out.find("<svg ") else { return out };
    let Some(tag_end_rel) = out[start..].find('>') else { return out };
    let tag_end = start + tag_end_rel;
    let tag = out[start..tag_end].to_string();
    let mut new_tag = tag.clone();
    for (attr, value) in [
        ("viewBox", format!("0 0 {} {}", fmt(width_pt), fmt(height_pt))),
        ("width", format!("{}pt", fmt(width_pt))),
        ("height", format!("{}pt", fmt(height_pt))),
    ] {
        let needle = format!("{attr}=\"");
        if let Some(i) = new_tag.find(&needle) {
            let val_start = i + needle.len();
            if let Some(rel_end) = new_tag[val_start..].find('"') {
                let val_end = val_start + rel_end;
                new_tag.replace_range(val_start..val_end, &value);
            }
        }
    }
    out.replace_range(start..tag_end, &new_tag);
    out
}

/// 编译并导出 PDF 字节（成功返回字节，失败返回人类可读错误信息）
pub fn compile_to_pdf_bytes(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> Result<Vec<u8>, String> {
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return Err(diags.into_iter().next().map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    }

    let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
    let document = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc),
            warnings: _,
        } => doc,
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => {
            // 导出失败时给出第一条诊断的可读信息
            // PDF 导出不做预览重排注入（偏移恒为 0）
            let first = errors
                .into_iter()
                .find_map(|d| to_diagnostic(&world, &d, 0));
            return Err(first.map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    };
    match typst_pdf::pdf(&document, &PdfOptions::default()) {
        Ok(bytes) => Ok(bytes),
        Err(errors) => {
            // PDF 导出不做预览重排注入（偏移恒为 0）
            let first = errors
                .into_iter()
                .find_map(|d| to_diagnostic(&world, &d, 0));
            Err(first.map_or_else(
                || "PDF 导出失败".to_string(),
                |d| format!("PDF 导出失败: {}: 行 {} 列 {}", d.message, d.line, d.column),
            ))
        }
    }
}

/// 把 typst 的 SourceDiagnostic 转为前端诊断（span → 1-based 行列）。
/// 无法定位位置（detached span / 外部数据文件）的诊断跳过。
pub(crate) fn collect_diagnostics(
    world: &TypstWorld,
    diags: impl IntoIterator<Item = SourceDiagnostic>,
    main_line_offset: u32,
) -> Vec<Diagnostic> {
    diags
        .into_iter()
        .filter_map(|d| to_diagnostic(world, &d, main_line_offset))
        .collect()
}

/// `main_line_offset` = 编译源最前面注入的行数（预览重排的 `#set page(...)`，见
/// [`preview_page_setup`]）：**只对主源**（path 为 None）的诊断把行号减回去，
/// 这样前端"编译源行号 → 用户文档行号"的映射不需要知道注入这件事；
/// include 文件的行号本来就是那个文件自己的，不动。
fn to_diagnostic(
    world: &TypstWorld,
    diag: &SourceDiagnostic,
    main_line_offset: u32,
) -> Option<Diagnostic> {
    let severity = match diag.severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
    };
    let id = diag.span.id()?;
    // span → 字节区间（typst 0.15 的 span 需要 Source 定位，WorldExt::range 已封装）
    let range = world.range(diag.span)?;

    // 主文档/include 源码有完整的行列信息；外部数据文件（如 csv 错误）退化为 1,1
    let (start, end) = match world.read_source(id) {
        Ok(source) => {
            let lines = source.lines();
            let start = lines.byte_to_line_column(range.start)?;
            let end = fix_span_end(lines, start, range.end);
            (start, end)
        }
        Err(_) => ((0, 0), (0, 0)),
    };

    // 出错文件路径：优先取诊断消息中 "searched at" 给出的具体文件路径
    //（缺失 include/图片的报错定位在主文档的引用处，但真正出错的是被加载的文件）；
    // 否则取诊断所在文件（主文档为 None，include 为其路径）
    let path = diag
        .message
        .rsplit_once("searched at ")
        .map(|(_, p)| p.trim_end_matches(')').to_string())
        .or_else(|| world.path_of(id));

    // 主源诊断的行号减回注入的行（include 文件的行号是它自己的，不动）
    let shift = if path.is_none() { main_line_offset } else { 0 };

    Some(Diagnostic {
        message: diag.message.to_string(),
        severity: severity.to_string(),
        line: (start.0 as u32).saturating_sub(shift) + 1,
        column: start.1 as u32 + 1,
        end_line: Some((end.0 as u32).saturating_sub(shift) + 1),
        end_column: Some(end.1 as u32 + 1),
        path,
    })
}

/// 修正 span 结束位置：结束字节落在行首（整行诊断常见）时，归一到上一行行尾，
/// 避免 CodeMirror 波浪线跨到下一行。
fn fix_span_end(
    lines: &typst::syntax::Lines<String>,
    start: (usize, usize),
    end_byte: usize,
) -> (usize, usize) {
    let Some(mut end) = lines.byte_to_line_column(end_byte) else {
        return start;
    };
    if end.1 == 0 && end.0 > start.0 {
        let prev = end.0 - 1;
        if let Some(range) = lines.line_to_range(prev) {
            let text = &lines.text()[range];
            let mut cols = text.chars().count();
            if text.ends_with('\n') || text.ends_with('\r') {
                cols -= 1;
            }
            end = (prev, cols);
        }
    }
    end
}

/// 未保存文档时预检相对 include：`#include "x.typ"`（含 `/` 绝对虚拟路径）无法解析，
/// 直接返回"需要先保存文档"诊断；`@` 开头的包导入不依赖文档位置，编译期经包解析
/// （packages.rs）正常处理，无需保存文档，故保持跳过。
fn check_relative_imports(src: &str) -> Option<Vec<Diagnostic>> {
    let root = typst_syntax::parse(src);
    let mut diags = Vec::new();
    // LinkedNode 自带字节偏移（SyntaxNode 不公开 offset），用于定位 include 的行列
    let mut stack: Vec<LinkedNode> = vec![LinkedNode::new(&root)];
    while let Some(node) = stack.pop() {
        if node.get().kind() == SyntaxKind::ModuleInclude {
            // include 的路径参数：子树中第一个字符串字面量
            let mut path: Option<String> = None;
            let mut inner: Vec<LinkedNode> = node.children().collect();
            while let Some(child) = inner.pop() {
                if child.get().kind() == SyntaxKind::Str {
                    if let Some(v) = child.get().cast::<typst::syntax::ast::Str>() {
                        path = Some(v.get().to_string());
                    }
                    break;
                }
                inner.extend(child.children());
            }
            if let Some(path) = path {
                // 以 / 开头的虚拟绝对路径也要项目根，同样需要已保存文档；
                // @ 开头的是包导入（@local/@preview），不依赖文档位置，交给编译期处理
                if !path.starts_with('@') {
                    let (line, column) = offset_to_line_column(src, node.offset());
                    diags.push(Diagnostic {
                        message: "相对导入需要先保存文档（include 的文件路径基于文档所在目录解析，请先保存后重试）".to_string(),
                        severity: "error".to_string(),
                        line,
                        column,
                        end_line: None,
                        end_column: None,
                        path: None,
                    });
                }
            }
        }
        stack.extend(node.children());
    }
    if diags.is_empty() {
        None
    } else {
        Some(diags)
    }
}

/// 字节偏移 → (1-based 行, 1-based 列)
fn offset_to_line_column(text: &str, offset: usize) -> (u32, u32) {
    let prefix = &text[..offset.min(text.len())];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() as u32 + 1;
    let column = prefix
        .rsplit_once('\n')
        .map_or(prefix.chars().count(), |(_, tail)| tail.chars().count()) as u32
        + 1;
    (line, column)
}

#[cfg(test)]
mod tests {
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
    /// **两种字号各导一份**：前端写作模式正文 16px → 12pt（MATH_SIZE_PT），
    /// 源码模式正文 14px → 10.5pt（MATH_TEXT_PT）；桩按 (body, display, sizePt) 匹配，
    /// 字号对不上就会退回假 SVG（实测踩过：只导 10.5 时写作模式下全对不上）。
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
            for size_pt in [12.0, MATH_TEXT_PT] {
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
}
