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
use typst::text::{Font, FontBook, FontFamily, FontList, TextElem};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
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

/// 递归收集目录（含子目录）下全部 .ttf/.otf 并注册进 book/fonts。
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

/// 读取并注册单个字体文件：仅 .ttf/.otf（大小写不敏感），读盘/解析失败静默跳过。
fn register_font_file(path: &Path, book: &mut FontBook, fonts: &mut Vec<Font>) {
    let is_font = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf"));
    if !is_font {
        return;
    }
    let Ok(data) = fs::read(path) else { return };
    if let Some(font) = Font::new(Bytes::new(data), 0) {
        book.push(font.info().clone());
        fonts.push(font);
    }
}

/// 系统字体目录候选（与 typst CLI 默认加载范围对齐），按平台返回：
/// - Windows：`%WINDIR%\Fonts`（WINDIR 环境变量缺失时回退 `C:\Windows\Fonts`）
/// - Linux：`/usr/share/fonts`、`/usr/local/share/fonts`、用户字体目录
///   （`$XDG_DATA_HOME/fonts`，未设置时 `$HOME/.local/share/fonts`）
/// - macOS：`/System/Library/Fonts`、`/Library/Fonts`、`~/Library/Fonts`
/// 目录可能不存在/不可读，由调用方（load_fonts_with_system）静默跳过。
fn system_font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        dirs.push(PathBuf::from(windir).join("Fonts"));
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

/// 编译文档为每页 SVG（pages 按页序，含 <svg> 标签）。
/// 失败时返回诊断列表；成功但带警告时 warnings 附加返回。
pub fn compile(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
) -> CompileOutput {
    // 未保存文档时预检相对 include，给出明确诊断（编译阶段只会得到笼统的 file not found）
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
                warnings: collect_diagnostics(&world, warnings.into_iter()),
            }
        }
        typst::diag::Warned {
            output: Err(errors),
            warnings: _,
        } => CompileOutput {
            ok: false,
            pages: Vec::new(),
            diagnostics: collect_diagnostics(&world, errors.into_iter()),
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
    let mut src = String::with_capacity(context.len() + math.len() * 2 + 256);
    if !context.is_empty() {
        src.push_str(context);
        if !context.ends_with('\n') {
            src.push('\n');
        }
    }
    // 贴边（width/height: auto, margin: 0）+ 透明背景（fill: none）→ SVG 即公式本身
    src.push_str("#set page(width: auto, height: auto, margin: 0pt, fill: none)\n");
    src.push_str(&format!("#set text(size: {size_pt}pt)\n"));
    src.push_str(&format!(
        "#box({math})\n#pagebreak()\n#box({math})#box(width: 0pt, height: {BASELINE_PROBE_PT}pt, baseline: {BASELINE_PROBE_PT}pt)"
    ));

    let world = TypstWorld::new(src, document_path, fonts_dir, font_config);
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
    let height_pt = size.y.to_pt();
    let probe_height_pt = pages[1].frame.size().y.to_pt();
    // 夹取到 [0, H]：探针盒比公式本身矮时（理论上不会）也不会给出越界基线
    let baseline_pt = (probe_height_pt - BASELINE_PROBE_PT).clamp(0.0, height_pt);

    MathOutput {
        ok: true,
        svg: svg_for_page(&pages[0]),
        width_pt,
        height_pt,
        baseline_pt,
        error: None,
    }
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
            let first = errors.into_iter().find_map(|d| to_diagnostic(&world, &d));
            return Err(first.map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    };
    match typst_pdf::pdf(&document, &PdfOptions::default()) {
        Ok(bytes) => Ok(bytes),
        Err(errors) => {
            let first = errors.into_iter().find_map(|d| to_diagnostic(&world, &d));
            Err(first.map_or_else(
                || "PDF 导出失败".to_string(),
                |d| format!("PDF 导出失败: {}: 行 {} 列 {}", d.message, d.line, d.column),
            ))
        }
    }
}

/// 把 typst 的 SourceDiagnostic 转为前端诊断（span → 1-based 行列）。
/// 无法定位位置（detached span / 外部数据文件）的诊断跳过。
fn collect_diagnostics(
    world: &TypstWorld,
    diags: impl IntoIterator<Item = SourceDiagnostic>,
) -> Vec<Diagnostic> {
    diags
        .into_iter()
        .filter_map(|d| to_diagnostic(world, &d))
        .collect()
}

fn to_diagnostic(world: &TypstWorld, diag: &SourceDiagnostic) -> Option<Diagnostic> {
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

    Some(Diagnostic {
        message: diag.message.to_string(),
        severity: severity.to_string(),
        line: start.0 as u32 + 1,
        column: start.1 as u32 + 1,
        end_line: Some(end.0 as u32 + 1),
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
        assert!(
            display.height_pt > inline.height_pt * 2.0,
            "行间分式应显著更高：inline={} display={}",
            inline.height_pt,
            display.height_pt
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

        let sup = compile_math("x^2", false, "", None, &fonts_dir(), &FontConfig::default(), MATH_TEXT_PT);
        assert!(sup.ok);
        let sup_depth = sup.height_pt - sup.baseline_pt;
        assert!(
            sup_depth.abs() < 0.05,
            "x^2 视觉上不下沉，实际 depth={sup_depth}"
        );
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
        let cases: [(&str, bool); 10] = [
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
