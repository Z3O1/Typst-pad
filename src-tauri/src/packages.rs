//! 包系统：@local 本地包读取 + @preview 在线包自动下载缓存。
//!
//! 目录规范与 typst CLI（typst-kit 0.15）严格一致：
//! - @local   数据目录：{data_dir}/typst/packages/local/{name}/{version}/
//! - @preview 缓存目录：{cache_dir}/typst/packages/preview/{name}/{version}/
//!   data_dir：Windows %APPDATA%、Linux $XDG_DATA_HOME（缺省 ~/.local/share）、
//!   macOS ~/Library/Application Support；
//!   cache_dir：Windows %LOCALAPPDATA%、Linux $XDG_CACHE_HOME（缺省 ~/.cache）、
//!   macOS ~/Library/Caches。
//! - 环境变量覆盖（与 CLI 同款，兼作单测注入点）：`TYPST_PACKAGE_PATH` 覆盖数据根、
//!   `TYPST_PACKAGE_CACHE_PATH` 覆盖缓存根（值为包根目录，含 namespace 层）。
//! - 数据目录优先于缓存目录（同名包先查数据侧，与 CLI 的 obtain 顺序一致）。
//!
//! @preview 缓存 miss 时同步下载 `https://packages.typst.org/preview/{name}-{version}.tar.gz`
//! 并解压进缓存（编译在 spawn_blocking 内执行，不阻塞 UI）。包内互相 `#import` 时，
//! source()/file() 都会再次走包解析 → 递归触发下载，无需额外实现。
//!
//! 错误语义复用引擎诊断（FileError::Package(PackageError)，typst 原生渲染）：
//! - HTTP 404       → PackageError::NotFound       → "package not found"
//! - 网络不可用/超时 → PackageError::NetworkFailed   → "failed to download package"
//! - 解压失败/包损坏 → PackageError::MalformedArchive → "failed to decompress package"
//!
//! 安全：解压目标限定在缓存目录内——条目路径预检拒绝 `..`/绝对路径/盘符前缀（防路径穿越），
//! 且 tar 的 Entry::unpack_in 内部再校验一次（canonicalize 不得越界），双保险。

use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use typst::diag::{FileError, FileResult, PackageError};
use typst::syntax::package::PackageSpec;
use typst::syntax::VirtualPath;

/// 下载结果：404 与网络失败分开（诊断需可区分"没这个包"和"没网"）。
enum FetchError {
    /// HTTP 404：包/版本不存在
    NotFound,
    /// 网络不可用（连接失败/超时/DNS/服务器错误等）
    Network(String),
}

/// 生产下载 HTTP 客户端：30s 全局超时（防慢网/挂死网络卡住编译）+ 128MB 体积上限。
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .into()
});

/// 包内文件 → 磁盘路径（typst CLI 同款目录规范；@preview 缓存 miss 时下载）。
/// 目录根从环境解析（TYPST_PACKAGE_PATH / TYPST_PACKAGE_CACHE_PATH 可覆盖）。
pub fn resolve_package_path(spec: &PackageSpec, vpath: &VirtualPath) -> FileResult<PathBuf> {
    resolve_package_path_in(
        spec,
        vpath,
        &packages_data_root(),
        &packages_cache_root(),
        fetch_from_packages_org,
    )
}

/// 核心解析：目录与下载函数显式注入（测试用，避免触碰真实用户目录与真实网络）。
fn resolve_package_path_in(
    spec: &PackageSpec,
    vpath: &VirtualPath,
    data_root: &Path,
    cache_root: &Path,
    mut fetch: impl FnMut(&str) -> Result<Vec<u8>, FetchError>,
) -> FileResult<PathBuf> {
    let ns = spec.namespace.as_str();
    let package_dir = |root: &Path| {
        root.join(ns)
            .join(spec.name.as_str())
            .join(spec.version.to_string())
    };

    // 数据目录优先于缓存目录（与 CLI 的 obtain 顺序一致）
    let data_dir = package_dir(data_root);
    if data_dir.is_dir() {
        return realize_in(&data_dir, vpath);
    }
    let cache_dir = package_dir(cache_root);
    if cache_dir.is_dir() {
        return realize_in(&cache_dir, vpath);
    }

    // 仅 @preview 支持在线下载；其余命名空间缺失（如 @local 未安装）直接报未找到
    if ns == "preview" {
        download_and_extract(spec, &cache_dir, &mut fetch)?;
        return realize_in(&cache_dir, vpath);
    }
    Err(FileError::Package(PackageError::NotFound(spec.clone())))
}

/// 包数据根目录（含 namespace 层）：TYPST_PACKAGE_PATH 直接覆盖（与 CLI 同款语义）
fn packages_data_root() -> PathBuf {
    std::env::var_os("TYPST_PACKAGE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_dir()
                .map(|d| d.join("typst/packages"))
                .unwrap_or_else(|| PathBuf::from("typst/packages"))
        })
}

/// 包缓存根目录（含 namespace 层）：TYPST_PACKAGE_CACHE_PATH 直接覆盖
fn packages_cache_root() -> PathBuf {
    std::env::var_os("TYPST_PACKAGE_CACHE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::cache_dir()
                .map(|d| d.join("typst/packages"))
                .unwrap_or_else(|| PathBuf::from("typst/packages"))
        })
}

/// 虚拟路径 → 包目录内磁盘路径（typst 虚拟路径已规范化，仅正常组件）
fn realize_in(package_dir: &Path, vpath: &VirtualPath) -> FileResult<PathBuf> {
    vpath.realize(package_dir).map_err(FileError::from)
}

/// 下载并解压 @preview 包到缓存目录：下载 → 临时目录解压 → 原子重命名，
/// 避免半成品/损坏包污染缓存。解压目标限定在缓存目录内（见模块级安全说明）。
fn download_and_extract(
    spec: &PackageSpec,
    cache_dir: &Path,
    fetch: &mut impl FnMut(&str) -> Result<Vec<u8>, FetchError>,
) -> FileResult<()> {
    // 下载 URL 与 typst CLI 一致：https://packages.typst.org/{namespace}/{name}-{version}.tar.gz
    let url = format!(
        "https://packages.typst.org/{}/{}-{}.tar.gz",
        spec.namespace, spec.name, spec.version
    );
    let bytes = match fetch(&url) {
        Ok(bytes) => bytes,
        Err(FetchError::NotFound) => {
            return Err(FileError::Package(PackageError::NotFound(spec.clone())))
        }
        Err(FetchError::Network(msg)) => {
            return Err(FileError::Package(PackageError::NetworkFailed(Some(
                msg.into(),
            ))))
        }
    };

    // 临时目录与最终目标同父目录（同文件系统，重命名原子）；
    // pid 后缀防多实例冲突，编译互斥串行 + 先清理残留，无并发覆盖风险
    let base = cache_dir
        .parent()
        .ok_or_else(|| FileError::Package(PackageError::Other(Some("包缓存目录无效".into()))))?;
    fs::create_dir_all(base).map_err(write_err)?;
    let tmp = base.join(format!(".tmp-{}-{}", spec.version, std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(write_err)?;

    let result = extract_safely(&bytes, &tmp);
    if let Err(err) = result {
        let _ = fs::remove_dir_all(&tmp);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp, cache_dir) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(write_err(err));
    }
    Ok(())
}

/// 单遍解压：先校验条目路径（拒绝 `..`/绝对路径/盘符前缀，防路径穿越），
/// 再用 Entry::unpack_in 落地（其内部跳过 `..` 并对目标 canonicalize 校验不越界，双保险）。
fn extract_safely(bytes: &[u8], dst: &Path) -> FileResult<()> {
    let gz = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    let entries = archive.entries().map_err(malformed_err)?;
    for entry in entries {
        let mut entry = entry.map_err(malformed_err)?;
        let path = entry.path().map_err(malformed_err)?;
        if path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(malformed_msg(format!(
                "包归档包含不安全路径 {}",
                path.display()
            )));
        }
        entry.unpack_in(dst).map_err(malformed_err)?;
    }
    Ok(())
}

/// 生产下载实现：ureq 轻量 HTTP；仅 404 视为"包不存在"，其余错误归网络不可用
fn fetch_from_packages_org(url: &str) -> Result<Vec<u8>, FetchError> {
    let mut resp = AGENT.get(url).call().map_err(|err| match err {
        // 4xx/5xx 默认转 Error::StatusCode；只有 404 视为"包不存在"
        ureq::Error::StatusCode(404) => FetchError::NotFound,
        ureq::Error::StatusCode(code) => FetchError::Network(format!("HTTP {code}")),
        other => FetchError::Network(other.to_string()),
    })?;
    let mut bytes = Vec::new();
    resp.body_mut()
        .with_config()
        .limit(128 * 1024 * 1024)
        .reader()
        .read_to_end(&mut bytes)
        .map_err(|e| FetchError::Network(format!("读取下载内容失败: {e}")))?;
    Ok(bytes)
}

/// 归档解析/解压失败 → MalformedArchive 诊断
fn malformed_err(err: std::io::Error) -> FileError {
    FileError::Package(PackageError::MalformedArchive(Some(err.to_string().into())))
}

/// 内容异常（如路径穿越）→ MalformedArchive 诊断
fn malformed_msg(msg: String) -> FileError {
    FileError::Package(PackageError::MalformedArchive(Some(msg.into())))
}

/// 缓存目录写入失败 → Other 诊断
fn write_err(err: std::io::Error) -> FileError {
    FileError::Package(PackageError::Other(Some(
        format!("无法写入包缓存: {err}").into(),
    )))
}

/// 包相关环境变量（TYPST_PACKAGE_PATH / TYPST_PACKAGE_CACHE_PATH）互斥锁：
/// 测试进程内跨模块并行，凡读写这两个环境变量的测试必须持锁串行（typst_world 端到端测试共用）。
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::str::FromStr;

    /// 测试目录（数据根/缓存根分离），tag 保证各测试互不冲突
    struct Dirs {
        data: PathBuf,
        cache: PathBuf,
    }

    impl Dirs {
        fn temp(tag: &str) -> Self {
            let root = std::env::temp_dir()
                .join(format!("typst-pad-pkg-test-{}-{tag}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self {
                data: root.join("data"),
                cache: root.join("cache"),
            }
        }
    }

    /// 解析包规范（@namespace/name:version）
    fn spec(s: &str) -> PackageSpec {
        PackageSpec::from_str(s).unwrap()
    }

    fn vpath(s: &str) -> VirtualPath {
        VirtualPath::new(s).unwrap()
    }

    /// 在 root 下伪造包目录 {namespace}/{name}/{version}/...
    fn make_package(root: &Path, ns: &str, name: &str, version: &str, files: &[(&str, &str)]) {
        let dir = root.join(ns).join(name).join(version);
        for (rel, content) in files {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    /// 在内存中构造包 tar.gz（与 packages.typst.org 一致：无顶层目录，typst.toml 在根）
    fn make_tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_buf = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder.append_data(&mut header, name, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&tar_buf).unwrap();
        gz.finish().unwrap()
    }

    /// 手工构造单个条目的 tar 字节（含结束块）：tar::Builder 拒绝 `..` 路径，
    /// 路径穿越测试只能裸构造（UStar 头，普通文件条目）
    fn raw_tar_entry(name: &str, data: &[u8]) -> Vec<u8> {
        let mut block = [0u8; 512];
        let name_bytes = name.as_bytes();
        block[..name_bytes.len()].copy_from_slice(name_bytes);
        block[100..108].copy_from_slice(b"0000644\x00"); // mode
        block[108..116].copy_from_slice(b"0000000\x00"); // uid
        block[116..124].copy_from_slice(b"0000000\x00"); // gid
        block[124..136].copy_from_slice(format!("{:011o}\x00", data.len()).as_bytes()); // size
        block[136..148].copy_from_slice(b"00000000000\x00"); // mtime
        block[148..156].fill(b' '); // checksum 占位（空格）
        block[156] = b'0'; // typeflag：普通文件
        block[257..263].copy_from_slice(b"ustar\x00"); // magic
        block[263..265].copy_from_slice(b"00"); // version
        let sum: u32 = block.iter().map(|&b| b as u32).sum();
        block[148..156].copy_from_slice(format!("{:06o}\x00 ", sum).as_bytes());
        let mut out = block.to_vec();
        out.extend_from_slice(data);
        while out.len() % 512 != 0 {
            out.push(0);
        }
        out.extend_from_slice(&[0u8; 512]); // 结束块
        out
    }

    /// 环境变量覆盖与缺省根（持 ENV_LOCK）
    #[test]
    fn env_override_and_default_roots() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join("typst-pad-env-test");
        std::env::set_var("TYPST_PACKAGE_PATH", &tmp);
        std::env::set_var("TYPST_PACKAGE_CACHE_PATH", &tmp);
        assert_eq!(packages_data_root(), tmp);
        assert_eq!(packages_cache_root(), tmp);
        std::env::remove_var("TYPST_PACKAGE_PATH");
        std::env::remove_var("TYPST_PACKAGE_CACHE_PATH");
        let data = packages_data_root();
        let cache = packages_cache_root();
        assert!(
            data.ends_with("typst/packages"),
            "缺省数据根应为 {{data_dir}}/typst/packages，实际 {}",
            data.display()
        );
        assert!(
            cache.ends_with("typst/packages"),
            "缺省缓存根应为 {{cache_dir}}/typst/packages，实际 {}",
            cache.display()
        );
        assert!(
            data != cache,
            "数据根与缓存根应指向不同目录（APPDATA vs LOCALAPPDATA 等）"
        );
    }

    /// @local 命中：直接读数据目录，不触发下载
    #[test]
    fn local_package_resolves_within_data_dir() {
        let dirs = Dirs::temp("local");
        make_package(
            &dirs.data,
            "local",
            "mypkg",
            "1.0.0",
            &[
                ("typst.toml", "[package]\nname = \"mypkg\"\n"),
                ("lib.typ", "#let hello = [你好]\n"),
            ],
        );
        let path = resolve_package_path_in(
            &spec("@local/mypkg:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| panic!("@local 命中不应发起下载"),
        )
        .expect("@local 应解析成功");
        assert_eq!(path, dirs.data.join("local/mypkg/1.0.0/lib.typ"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "#let hello = [你好]\n",
            "包内文件应可正常读取"
        );
    }

    /// @local 未安装：NotFound 诊断
    #[test]
    fn local_missing_reports_not_found() {
        let dirs = Dirs::temp("local-missing");
        let err = resolve_package_path_in(
            &spec("@local/nope:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| panic!("@local 不应下载"),
        )
        .expect_err("@local 未安装应报错");
        match err {
            FileError::Package(PackageError::NotFound(_)) => {}
            other => panic!("应为 NotFound 诊断，实际 {other:?}"),
        }
        assert!(
            err.to_string().contains("package not found"),
            "消息应可读，实际 {}",
            err
        );
    }

    /// @preview 缓存命中：直接读缓存目录，不触发下载
    #[test]
    fn preview_cache_hit_no_download() {
        let dirs = Dirs::temp("preview-hit");
        make_package(
            &dirs.cache,
            "preview",
            "pkg",
            "0.2.0",
            &[
                ("typst.toml", "[package]\nname = \"pkg\"\n"),
                ("lib.typ", "#let v = 42\n"),
            ],
        );
        let path = resolve_package_path_in(
            &spec("@preview/pkg:0.2.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| panic!("缓存命中不应发起下载"),
        )
        .expect("@preview 缓存命中应成功");
        assert_eq!(path, dirs.cache.join("preview/pkg/0.2.0/lib.typ"));
    }

    /// @preview 缓存 miss：下载（URL 格式正确）→ 解压 → 落缓存；再次解析为命中不再下载
    #[test]
    fn preview_miss_downloads_and_caches() {
        let dirs = Dirs::temp("preview-miss");
        let tarball = make_tarball(&[
            (
                "typst.toml",
                b"[package]\nname = \"pkg\"\nversion = \"0.2.0\"\n",
            ),
            ("lib.typ", b"#let v = 42\n"),
            ("src/helper.typ", b"#let helper = [h]\n"),
        ]);
        let calls = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let calls_for_fetch = std::rc::Rc::clone(&calls);
        let mut fetch = move |url: &str| {
            calls_for_fetch.borrow_mut().push(url.to_string());
            Ok(tarball.clone())
        };

        let path = resolve_package_path_in(
            &spec("@preview/pkg:0.2.0"),
            &vpath("src/helper.typ"),
            &dirs.data,
            &dirs.cache,
            &mut fetch,
        )
        .expect("缓存 miss 下载应成功");
        assert_eq!(
            calls.borrow().as_slice(),
            &["https://packages.typst.org/preview/pkg-0.2.0.tar.gz"]
        );
        assert_eq!(path, dirs.cache.join("preview/pkg/0.2.0/src/helper.typ"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "#let helper = [h]\n",
            "解压后的包内文件应可读取"
        );
        // 无残留临时目录
        let leftovers: Vec<_> = fs::read_dir(dirs.cache.join("preview/pkg"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留临时目录: {leftovers:?}");

        // 再次解析：缓存命中，不再下载
        let _ = resolve_package_path_in(
            &spec("@preview/pkg:0.2.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            &mut fetch,
        )
        .expect("二次解析应命中缓存");
        assert_eq!(calls.borrow().len(), 1, "缓存命中后不应再次下载");
    }

    /// 404：NotFound 诊断（"没这个包"）
    #[test]
    fn preview_404_is_not_found() {
        let dirs = Dirs::temp("404");
        let err = resolve_package_path_in(
            &spec("@preview/ghost:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| Err(FetchError::NotFound),
        )
        .expect_err("404 应报错");
        let msg = err.to_string();
        match &err {
            FileError::Package(PackageError::NotFound(s)) => {
                assert_eq!(s.to_string(), "@preview/ghost:1.0.0")
            }
            other => panic!("应为 NotFound 诊断，实际 {other:?}"),
        }
        assert!(msg.contains("package not found"));
    }

    /// 网络失败：NetworkFailed 诊断（"没网"），与 404 可区分
    #[test]
    fn preview_network_error_distinct_from_404() {
        let dirs = Dirs::temp("network");
        let err = resolve_package_path_in(
            &spec("@preview/foo:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| Err(FetchError::Network("连接超时".into())),
        )
        .expect_err("网络失败应报错");
        let msg = err.to_string();
        match &err {
            FileError::Package(PackageError::NetworkFailed(Some(detail))) => {
                assert!(detail.contains("连接超时"))
            }
            other => panic!("应为 NetworkFailed 诊断，实际 {other:?}"),
        }
        assert!(msg.contains("failed to download package"));
        assert!(
            !msg.contains("package not found"),
            "网络失败与包不存在必须可区分，实际 {msg}"
        );
    }

    /// 数据目录优先于缓存目录（同名同版本包两边都有）
    #[test]
    fn data_root_precedes_cache_root() {
        let dirs = Dirs::temp("precedence");
        make_package(
            &dirs.data,
            "preview",
            "dup",
            "1.0.0",
            &[("lib.typ", "#let from = [data]\n")],
        );
        make_package(
            &dirs.cache,
            "preview",
            "dup",
            "1.0.0",
            &[("lib.typ", "#let from = [cache]\n")],
        );
        let path = resolve_package_path_in(
            &spec("@preview/dup:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| panic!("双目录命中不应下载"),
        )
        .expect("应解析成功");
        assert!(
            path.starts_with(&dirs.data),
            "数据目录应优先，实际 {}",
            path.display()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "#let from = [data]\n");
    }

    /// 未知命名空间：NotFound，且不发起下载
    #[test]
    fn unknown_namespace_reports_not_found() {
        let dirs = Dirs::temp("unknown-ns");
        let err = resolve_package_path_in(
            &spec("@weird/foo:1.0.0"),
            &vpath("lib.typ"),
            &dirs.data,
            &dirs.cache,
            |_| panic!("未知命名空间不应下载"),
        )
        .expect_err("未知命名空间应报错");
        match err {
            FileError::Package(PackageError::NotFound(_)) => {}
            other => panic!("应为 NotFound 诊断，实际 {other:?}"),
        }
    }

    /// 路径穿越防御：`..` 与绝对路径条目 → MalformedArchive，且不落盘缓存外
    #[test]
    fn extract_rejects_path_traversal() {
        // 注意：label 只用于测试目录命名，不能含路径成分（否则目录名被解释为路径）
        for (entry_name, label) in [("../evil.txt", "dotdot"), ("/evil.txt", "absolute")] {
            let dirs = Dirs::temp(&format!("traversal-{label}"));
            let tarball = raw_tar_entry(entry_name, b"evil");
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            gz.write_all(&tarball).unwrap();
            let bytes = gz.finish().unwrap();

            let err = resolve_package_path_in(
                &spec("@preview/evil:1.0.0"),
                &vpath("typst.toml"),
                &dirs.data,
                &dirs.cache,
                |_| Ok(bytes.clone()),
            )
            .expect_err("含穿越路径的归档应被拒绝");
            match err {
                FileError::Package(PackageError::MalformedArchive(Some(msg))) => {
                    assert!(
                        msg.contains("不安全路径"),
                        "诊断应说明不安全路径，实际 {msg}"
                    )
                }
                other => panic!("应为 MalformedArchive 诊断，实际 {other:?}"),
            }
            // 缓存外（数据根与缓存根父级）不得出现 evil.txt
            assert!(!dirs.data.join("evil.txt").exists());
            assert!(!dirs.cache.join("../evil.txt").exists());
            assert!(!dirs.cache.join("evil.txt").exists());
        }
    }

    /// 损坏归档（非 gzip）→ MalformedArchive 诊断
    #[test]
    fn corrupt_archive_reports_malformed() {
        let dirs = Dirs::temp("corrupt");
        let err = resolve_package_path_in(
            &spec("@preview/bad:1.0.0"),
            &vpath("typst.toml"),
            &dirs.data,
            &dirs.cache,
            |_| Ok(b"not a gzip".to_vec()),
        )
        .expect_err("损坏归档应报错");
        match err {
            FileError::Package(PackageError::MalformedArchive(Some(_))) => {}
            other => panic!("应为 MalformedArchive 诊断，实际 {other:?}"),
        }
        // 损坏包不得落缓存（无半成品）
        assert!(!dirs.cache.join("preview/bad/1.0.0").exists());
    }
}
