// 编译世界：`World` 实现（主文档 / 相对 include / 包解析）+ 输出与诊断类型。
use super::*;

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
    ///
    /// **None 时整个键都不发**（前端按「`path` 缺失/空 ⇒ 主源，要画波浪线」消费，见
    /// `diagnostics-utils.ts` 的 squiggleRanges）。曾经发 `"path":null`，而前端那条判据
    /// 只认 `undefined`/`""` ⇒ `null` 被判成"非主源文件"跳过，**桌面版从 0.4.0 起编译错误
    /// 一直不画波浪线**（浏览器验收用的是不发该字段的桩，所以没人发现，2026-09-18 才查出来）。
    #[serde(skip_serializing_if = "Option::is_none")]
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

        // 项目根 = 文档所在目录（再按文档实际引用到的相对路径往上放宽，见
        // resolve_project_root）；主 FileId 的虚拟路径相对该根（盘符前缀被剥离）
        let (root, main_id) = match document_path {
            Some(path) => {
                // canonicalize 父目录（去 `..`/符号链接），保证虚拟化后的路径不越界；
                // 解析不出（没父目录/没文件名）时当作未保存文档处理
                match resolve_project_root(&src, &path) {
                    Some(ProjectRoot { root, main_file }) => {
                        match VirtualPath::virtualize(&root, &main_file) {
                            Ok(vpath) => (
                                Some(root),
                                RootedPath::new(VirtualRoot::Project, vpath).intern(),
                            ),
                            // 理论上不会发生（放宽只取文档目录的祖先）；兜底成匿名主文档
                            Err(_) => (Some(root), Self::anonymous_main_id()),
                        }
                    }
                    None => (None, Self::anonymous_main_id()),
                }
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
    pub(crate) fn read_source(&self, id: FileId) -> FileResult<Source> {
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

    /// 本次编译用的项目根（未保存文档为 None）：只用于把越界诊断讲清楚（见 escape_hint）
    pub fn project_root(&self) -> Option<&Path> {
        self.root.as_deref()
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
