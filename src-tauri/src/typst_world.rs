//! 内嵌 Typst 编译世界：字体加载、主文档/相对 include 的磁盘解析、编译与导出（SVG/PDF）。
//!
//! 整体思路参考 typst 官方 CLI（typst-cli 的 SystemWorld），但针对编辑器场景做了简化：
//! - 字体：从字体目录（打包后为 resource_dir/fonts，开发/测试为仓库 static/fonts）加载全部
//!   .ttf/.otf，注册进 FontBook；
//! - 文件：主文档源码由前端传入（未保存即可编译）；相对 include 以 document_path 所在目录为
//!   根从磁盘读取（与 typst 语义一致：相对路径基于引用文件所在目录解析，根为项目目录）；
//! - document_path 为 None（未保存文档）时，相对导入无法解析磁盘路径，编译前先预检给出
//!   "需要先保存文档" 的明确诊断。
//!
//! 接口契约（前端按此消费，serde rename_all = "camelCase"，多词字段为 camelCase 键名）：
//! - compile_doc -> CompileOutput { ok, pages, diagnostics, warnings }
//! - export_pdf  -> PdfResult { ok, error }
//! - Diagnostic  -> { message, severity, line, column, endLine, endColumn, path }
//!   （行列均为 1-based，CodeMirror 波浪线直接消费）

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, LinkedNode, RootedPath, Source, SyntaxKind, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
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
    /// - `fonts_dir`：字体目录（.ttf/.otf 全量加载）
    pub fn new(src: String, document_path: Option<String>, fonts_dir: &Path) -> Self {
        let (book, fonts) = load_fonts(fonts_dir);
        let library = Library::default();

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

    /// FileId 对应的磁盘真实路径（仅项目根内文件；包/未保存场景返回错误）
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
            // 离线内嵌引擎不支持 @preview 等包下载
            VirtualRoot::Package(_) => Err(FileError::Other(Some(
                "不支持 @preview 等在线包（内嵌引擎为离线编译，请把依赖文件放到文档目录后改用相对路径导入)"
                    .into(),
            ))),
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

/// 从目录加载全部 .ttf/.otf 字体，返回 (FontBook, 字体列表)（与 FontBook 索引一一对应）。
/// 目录不存在/不可读时返回空集（不影响编译，缺字体时 typst 会给出缺字诊断）。
fn load_fonts(dir: &Path) -> (FontBook, Vec<Font>) {
    let mut book = FontBook::new();
    let mut fonts = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return (book, fonts);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // 仅加载 .ttf/.otf（大小写不敏感）
        let is_font = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("ttf") || e.eq_ignore_ascii_case("otf"));
        if !is_font {
            continue;
        }
        let Ok(data) = fs::read(&path) else { continue };
        if let Some(font) = Font::new(Bytes::new(data), 0) {
            book.push(font.info().clone());
            fonts.push(font);
        }
    }
    (book, fonts)
}

/// 解析字体目录：优先打包/构建产物 resource_dir 下的 fonts（tauri.conf.json
/// bundle.resources 复制而来），退回仓库内 static/fonts（开发模式不复制资源时的兜底，
/// 也是 cargo test 的路径）。
pub fn resolve_fonts_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        // bundle.resources 走 map 形式 `static/fonts -> fonts/` 时落在 resource_dir/fonts
        for candidate in [res.join("fonts"), res.join("static/fonts")] {
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    // 开发/测试回退：CARGO_MANIFEST_DIR = src-tauri，上一级是仓库根
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../static/fonts")
}

/// 编译文档为每页 SVG（pages 按页序，含 <svg> 标签）。
/// 失败时返回诊断列表；成功但带警告时 warnings 附加返回。
pub fn compile(src: String, document_path: Option<String>, fonts_dir: &Path) -> CompileOutput {
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

    let world = TypstWorld::new(src, document_path, fonts_dir);
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

/// 编译并导出 PDF 字节（成功返回字节，失败返回人类可读错误信息）
pub fn compile_to_pdf_bytes(
    src: String,
    document_path: Option<String>,
    fonts_dir: &Path,
) -> Result<Vec<u8>, String> {
    if document_path.is_none() {
        if let Some(diags) = check_relative_imports(&src) {
            return Err(diags.into_iter().next().map_or_else(
                || "编译失败".to_string(),
                |d| format!("{}: 行 {} 列 {}", d.message, d.line, d.column),
            ));
        }
    }

    let world = TypstWorld::new(src, document_path, fonts_dir);
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
/// 直接返回"需要先保存文档"诊断；`@preview/...` 包导入不在此列（编译期另行报"不支持包"）。
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
                // @ 开头的是包导入，交给编译期报"不支持在线包"
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

    /// 测试用字体目录：仓库根 static/fonts（cargo test 的 CWD 是 src-tauri，
    /// 用 CARGO_MANIFEST_DIR 定位更稳）
    fn fonts_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../static/fonts")
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
        let out = compile(src, None, &fonts_dir());
        assert!(out.ok, "编译应成功，实际诊断: {:?}", out.diagnostics);
        assert!(!out.pages.is_empty(), "应至少有一页");
        assert!(out.pages[0].contains("<svg"), "每页应是完整 SVG");
        // 中文字体（思源宋体）与数学字体（NewCM）必须加载成功
        assert!(font_count() >= 7, "static/fonts 下 7 个字体文件应全部注册");
    }

    /// 字体加载：static/fonts 下全部字体注册成功（数学 NewCM、中文思源宋体、Libertinus、DejaVu）
    #[test]
    fn fonts_all_registered() {
        let (book, fonts) = load_fonts(&fonts_dir());
        assert_eq!(fonts.len(), 7, "static/fonts 应有 7 个字体文件");
        // FontBook 内部键为小写族名（typst 0.15 的 contains_family 不做大小写归一化）
        for family in [
            "new computer modern math",
            "noto serif cjk sc",
            "libertinus serif",
            "dejavu sans mono",
        ] {
            assert!(book.contains_family(family), "字体族 {family} 应已注册");
        }
    }

    /// 诊断转换：语法错误文档应返回 ok=false 且行列 1-based 合理
    #[test]
    fn syntax_error_diagnostics() {
        let src = "#let = 3
hello"
            .to_string();
        let out = compile(src, None, &fonts_dir());
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
        let out = compile(src, Some(doc_path.clone()), &fonts_dir());
        assert!(out.ok, "include 应成功，实际诊断: {:?}", out.diagnostics);
        assert!(!out.pages.is_empty());

        // PDF 导出也应成功
        let pdf = compile_to_pdf_bytes(
            fs::read_to_string(dir.join("main.typ")).unwrap(),
            Some(doc_path),
            &fonts_dir(),
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
        let out = compile(src, Some(doc_path), &fonts_dir());
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
}
