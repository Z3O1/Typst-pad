use super::*;

// ---------------------------------------------------------------------------
// 项目根：相对导入的解析基准（`#import "…"` / `#include "…"`）
// ---------------------------------------------------------------------------

/// 递归扫描的深度上限（文档 → 它引用的文件 → …）：正常项目 2~3 层足够，防病态自引用
const ROOT_SCAN_MAX_DEPTH: usize = 8;

/// `#import` / `#include` 里的一个字符串字面量路径
#[derive(Debug, Clone, PartialEq, Eq)]
struct SyntaxPath {
    /// 节点在源码里的字节偏移（把诊断定位到那一行）
    offset: usize,
    path: String,
}

/// 扫描源码里所有 `#import` / `#include` 的字符串字面量路径（按出现顺序）。
///
/// 只认节点子树里的第一个字符串字面量 —— 那正是 typst 的路径参数位置。**动态路径**
/// （`#import ("a" + ".typ")`）扫不到，那种情况交给编译期报错 + 越界提示兜住。
fn syntax_paths(src: &str) -> Vec<SyntaxPath> {
    let root = typst_syntax::parse(src);
    let mut out = Vec::new();
    // LinkedNode 自带字节偏移（SyntaxNode 不公开 offset）
    let mut stack: Vec<LinkedNode> = vec![LinkedNode::new(&root)];
    while let Some(node) = stack.pop() {
        let kind = node.get().kind();
        if kind == SyntaxKind::ModuleImport || kind == SyntaxKind::ModuleInclude {
            let mut inner: Vec<LinkedNode> = node.children().collect();
            while let Some(child) = inner.pop() {
                if child.get().kind() == SyntaxKind::Str {
                    if let Some(v) = child.get().cast::<typst::syntax::ast::Str>() {
                        out.push(SyntaxPath {
                            offset: node.offset(),
                            path: v.get().to_string(),
                        });
                    }
                    break;
                }
                inner.extend(child.children());
            }
        }
        stack.extend(node.children());
    }
    out.sort_by_key(|p| p.offset);
    out
}

/// 一条相对路径冲出「引用它的文件所在目录」的层数。
///
/// 与 typst 的路径归一化**同构**（`Segments::push_component`，typst-syntax 的
/// `src/path.rs`）：`Normal` 压栈、`..` 弹栈，弹不动就是冲出根 —— 于是项目根必须在
/// 引用文件目录之上至少 `need` 层，否则 typst 直接报 `would escape the project root`。
/// 注意分隔符只认 `/`：typst 的 `components()` 只按 `/` 切，反斜杠算非法字符。
pub(crate) fn needed_levels(path: &str) -> usize {
    let mut depth = 0usize;
    let mut need = 0usize;
    for comp in path.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                if depth > 0 {
                    depth -= 1;
                } else {
                    need += 1;
                }
            }
            _ => depth += 1,
        }
    }
    need
}

/// `anc` 是不是 `p` 的祖先（组件级）。Windows 磁盘不区分大小写，而 `Path::starts_with`
/// 是逐字节比较 —— 这里补一层忽略大小写的兜底（`\\wsl.localhost\Ubuntu` 与
/// `\\wsl.localhost\ubuntu` 是同一个目录，2026-08-06 的 issue #34 就是大小写匹配栽的）。
fn is_ancestor_of(anc: &Path, p: &Path) -> bool {
    if p.starts_with(anc) {
        return true;
    }
    if !cfg!(windows) {
        return false;
    }
    let fold = |path: &Path| -> Vec<String> {
        path.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let a = fold(anc);
    let b = fold(p);
    b.len() >= a.len() && a.iter().zip(&b).all(|(x, y)| x == y)
}

/// 两个绝对路径的最近公共祖先；找不到（不在同一个卷/盘上）时原样返回 `a` ——
/// 跨卷是 typst 单根模型的硬限制（CLI 也一样），交给越界提示说清楚。
fn common_ancestor(a: &Path, b: &Path) -> PathBuf {
    a.ancestors()
        .find(|cand| is_ancestor_of(cand, b))
        .map_or_else(|| a.to_path_buf(), PathBuf::from)
}

/// 词法规范化（去掉 `.` / `..`），**不碰文件系统**：typst 解析路径就是纯词法的，
/// 目标文件还不存在（写错名字、还没建）时也得能算出它落在哪，否则连"该往哪放宽"都不知道。
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            // 已经到卷根就再也上不去了（绝对路径不会有 `..` 逃出卷根的那一天）
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 主文档的（目录, 绝对路径）。目录做 canonicalize（与 main_id 的虚拟化同源，
/// 保证后续 join 出来的路径与它共享同一个前缀），失败就退回原样。
fn doc_dir_and_file(document_path: &str) -> Option<(PathBuf, PathBuf)> {
    let raw = PathBuf::from(document_path);
    let (parent, name) = (raw.parent()?, raw.file_name()?);
    let dir = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    let file = dir.join(name);
    Some((dir, file))
}

/// 递归收集"项目根的最低要求"：文档（以及它引用到的本地 .typ）里每条相对路径都要求
/// 根在引用文件目录之上若干层，这里把每条的**最低可满足根**收集起来，最后取公共祖先。
fn collect_required_roots(
    src: &str,
    dir: &Path,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<PathBuf>,
) {
    for p in syntax_paths(src) {
        let path = p.path.as_str();
        // `@` = 包（自己的虚拟根，不受项目根影响）；`/` 开头 = 根相对（永远不越界）；
        // 绝对路径（Windows 盘符等）在 typst 里本来就非法，放宽根也救不了 —— 都跳过
        if path.starts_with('@') || path.starts_with('/') || Path::new(path).is_absolute() {
            continue;
        }
        if let Some(required) = dir.ancestors().nth(needed_levels(path)) {
            out.push(required.to_path_buf());
        }
        // 引用到的本地 .typ 里可能还有自己的相对引用，它们同样要落在根内（递归看一遍）
        if depth >= ROOT_SCAN_MAX_DEPTH {
            continue;
        }
        let target = lexical_normalize(&dir.join(path));
        let is_typ = target
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("typ"));
        if !is_typ || !target.is_file() || !visited.insert(target.clone()) {
            continue;
        }
        if let (Ok(text), Some(parent)) = (fs::read_to_string(&target), target.parent()) {
            collect_required_roots(&text, parent, depth + 1, visited, out);
        }
    }
}

/// 项目根 + 主文档绝对路径（编译世界按这个根把虚拟路径落到磁盘上）
pub struct ProjectRoot {
    pub root: PathBuf,
    pub main_file: PathBuf,
}

/// 解析项目根：**文档所在目录起手，再按文档实际引用到的路径往上放宽**。
///
/// 为什么不是"文档目录"就够了（2026-09-18 用户报「还是没法 `#import` 别的文件」）：
/// typst 的 `..` 是按**虚拟路径**判越界的（`typst-syntax/src/path.rs` 的
/// `Segments::push_component`：`..` 弹不动就 `PathError::Escapes`），目标文件哪怕确实
/// 躺在磁盘上、只是比根高一层，也会直接报
/// ``path "../touying/z.typ" would escape the project root``。所以根必须是"能容纳所有
/// 相对引用的最低目录"，等价于 typst CLI 的 `--root` 自动版（CLI 靠用户手填）。
///
/// 放宽只跟着文档自己写了什么走：同卷内相对引用 ⇒ 根抬到它们的公共祖先；跨卷（例如
/// 文档在 `\\wsl.localhost\…` 而模板在 `D:\…`）没有公共祖先 ⇒ 根保持文档目录，编译期
/// 报越界时由 [`escape_hint`] 把根和原因说清楚。
pub(crate) fn resolve_project_root(src: &str, document_path: &str) -> Option<ProjectRoot> {
    let (dir, main_file) = doc_dir_and_file(document_path)?;
    let mut visited = HashSet::new();
    let mut required = Vec::new();
    collect_required_roots(src, &dir, 0, &mut visited, &mut required);
    let mut root = dir;
    for req in required {
        root = common_ancestor(&root, &req);
    }
    Some(ProjectRoot { root, main_file })
}

/// 越界诊断补一句"当前项目根 + 下一步"：typst 原文只有
/// `path "…" would escape the project root` 加一句 hint（`cannot access files outside of
/// the project sandbox`），而 hint 在 `SourceDiagnostic.hints` 里、我们只取 message ⇒
/// 用户看到的就是没头没尾的一句。这里把根与"同一卷内会自动放宽"的规则讲明白。
pub(crate) fn escape_hint(message: &str, root: Option<&Path>) -> Option<String> {
    if !message.contains("would escape the project root") {
        return None;
    }
    Some(match root {
        Some(root) => format!(
            "（当前项目根：{}；同一卷内的相对引用会自动把项目根放宽到能容纳它们，\
             仍越界通常是目标在另一个盘/卷上 —— typst 引擎不支持跨卷导入，\
             请把被引用的文件放进文档所在的盘/卷）",
            root.display()
        ),
        None => "（文档尚未保存，无法确定项目根；相对导入需要先保存文档）".to_string(),
    })
}

/// 未保存文档时预检相对导入：`#import "x.typ": …` / `#include "x.typ"`（含 `/` 绝对
/// 虚拟路径）都无法解析磁盘路径，直接返回"需要先保存文档"诊断；`@` 开头的包导入不依赖
/// 文档位置，编译期经包解析（packages.rs）正常处理，无需保存文档，故保持跳过。
///
/// `#import` 与 `#include` 都收（2026-09-18 之前只认 include，于是文档没保存时
/// `#import` 会掉进引擎那句笼统的 failed to load file）。
pub(crate) fn check_relative_imports(src: &str) -> Option<Vec<Diagnostic>> {
    let mut diags = Vec::new();
    for p in syntax_paths(src) {
        if p.path.starts_with('@') {
            continue;
        }
        let (line, column) = offset_to_line_column(src, p.offset);
        diags.push(Diagnostic {
            message: "相对导入需要先保存文档（#import / #include 的路径按文档所在目录解析，请先保存后重试）".to_string(),
            severity: "error".to_string(),
            line,
            column,
            end_line: None,
            end_column: None,
            path: None,
        });
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
