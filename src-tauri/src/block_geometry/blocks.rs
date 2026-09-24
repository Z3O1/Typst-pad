// 源块划分：语法树顶层节点 → 块区间（`source_blocks` 与它的判据）。
use super::*;

/// 一个**源块**：语法树顶层节点，或者一段连续的行内内容（= typst 的一个段落）
#[derive(Debug, Clone)]
pub struct SourceBlock {
    pub kind: &'static str,
    pub range: Range<usize>,
    /// **这块在 Typst 里不产生任何版面内容**（`#let` / `#set` / `#show` / `#import`）。
    ///
    /// 为什么需要它：这些语句里的**内容值**（如 `#let va = $v$` 里的公式）在使用处的字形，
    /// 其 `Span` 仍指回**定义处**（typst 的内容值保留定义点 span）。于是"按源区间匹配帧项"
    /// 会把文档里所有用到该宏的字形都算进定义块 —— 实测高代作业里 `#let va` 那一块因此
    /// 拿到了跨 500pt 的假包围盒，前端把它当成一张大切片画出来，正文重复出现。
    /// 这类块必须按"无输出"处理（前端会整格隐藏、光标进去才展开源码），不做几何匹配。
    pub no_output: bool,
}

/// 这些语法树顶层节点在 Typst 里**不产生版面内容**（定义/规则/导入）。
/// `SyntaxKind::Code`（`#table(...)` / `#figure(...)`）**不在此列**：它们会画东西。
pub(crate) fn is_no_output_node(kind: SyntaxKind) -> bool {
    matches!(
        kind,
        SyntaxKind::LetBinding
            | SyntaxKind::SetRule
            | SyntaxKind::ShowRule
            | SyntaxKind::ModuleImport
    )
}

/// 这段源码是否**整段都是无输出语句**（每个非空行都以 `#let/#set/#show/#import/#include` 开头）。
/// 用于补 `#` + `LetBinding` 那种"节点 kind 判不出来"的情况（见 `close_para` 的说明）。
fn text_is_no_output_statements(text: &str) -> bool {
    let mut any = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        any = true;
        let ok = ["#let", "#set", "#show", "#import", "#include"]
            .iter()
            .any(|kw| {
                t.strip_prefix(kw).is_some_and(|rest| {
                    rest.starts_with(|c: char| c.is_whitespace()) || rest.starts_with('(')
                })
            });
        if !ok {
            return false;
        }
    }
    any
}

/// 这些语法树顶层节点各自**独占一个流式块**（typst 的排版也是以它们分块的）
const BLOCK_KINDS: &[SyntaxKind] = &[
    SyntaxKind::Heading,
    SyntaxKind::ListItem,
    SyntaxKind::EnumItem,
    SyntaxKind::TermItem,
];

/// 这些节点**只有独占整行时**才自成一块（`#let` / `#show` / `#table(...)` 这类代码表达式）。
const LINE_ONLY_KINDS: &[SyntaxKind] = &[SyntaxKind::Code];

/// 按**语法树顶层节点**切分源块。
///
/// 规则（保守优先，宁可把两块合一块，也不要把一块拆错）：
///   1. `Parbreak`（空行）结束当前段落；
///   2. `BLOCK_KINDS` 里的节点独占一块（标题 / 列表项 / 围栏代码 / 行间公式）；
///   3. 独占整行的 `#...` 代码表达式（`#let` / `#set` / `#show` / `#figure(...)` / `#table(...)`）
///      也独占一块 —— 判据是"该节点之前的字节在所在行里全是空白"；
///   4. 其余（`Text` / `Strong` / `Emph` / 行内公式 / 行内代码 / `Space` …）累加成一个段落块。
pub fn source_blocks(src: &str) -> Vec<SourceBlock> {
    let root: SyntaxNode = typst_syntax::parse(src);
    let mut out: Vec<SourceBlock> = Vec::new();
    // 当前段落块的范围（None = 还没有开始）
    let mut para: Option<Range<usize>> = None;
    // 当前段落是否**只由无输出语句组成**（见 SourceBlock::no_output）
    let mut para_no_output = false;
    // 子节点字节偏移的累加游标（见下面循环里的说明）
    let mut cursor = 0usize;

    let close_para =
        |para: &mut Option<Range<usize>>, no_output: &mut bool, out: &mut Vec<SourceBlock>| {
            if let Some(r) = para.take() {
                if r.end > r.start {
                    // 文本兜底：`#let ... = $...$` 这类语句在语法树里是 `#` + `LetBinding`，
                    // 只看 `is_no_output_node(节点kind)` 会漏掉（`#` 那个 Hash 节点不是无输出），
                    // 于是宏定义块仍会被宏内容在使用处的 span 污染。这里按源码行再判一次：
                    // 整段每一非空行都以 `#let/#set/#show/#import/#include` 开头 ⇒ 无输出。
                    let no_output = *no_output || text_is_no_output_statements(&src[r.clone()]);
                    out.push(SourceBlock {
                        kind: if no_output { "Code" } else { "Paragraph" },
                        range: r,
                        no_output,
                    });
                }
            }
            *no_output = false;
        };

    for node in root.children() {
        // `typst_syntax::parse` 的树是**未 numberize** 的（span 要等 `Source::new` 才编上号），
        // 所以字节区间按"子节点字节长度依次累加"重建 —— `SyntaxNode::len()` 就是节点在源文本里的
        // 字节长度，且解析树的子节点连续覆盖父节点（trivia 也在树里）。
        let start = cursor;
        let end = start + node.len();
        cursor = end;
        let range = start..end;
        if range.is_empty() {
            continue;
        }
        let kind = node.kind();

        // 空行 / 注释 / 空白：不算块内容，但空行要断开段落
        if matches!(kind, SyntaxKind::Parbreak) {
            close_para(&mut para, &mut para_no_output, &mut out);
            continue;
        }
        if matches!(
            kind,
            SyntaxKind::Space | SyntaxKind::LineComment | SyntaxKind::BlockComment
        ) {
            continue;
        }

        // 公式与 raw 的自成块判据**跟 typst 的语义走，不能看"是否独占整行"**（实测被真实文档咬过）：
        //   * 公式：`$x$`（定界符内侧无空白）是**行内**的 —— 哪怕它独占整行，也仍属于同一个段落，
        //     于是几个连续的 `$x$` 会被 typst 连排成一行；按"独占整行"切成多块会让这些块的带
        //     互相重叠（实测：5 个公式的帧项全在同一个 y 带里交错，DOM 顺序与页面顺序对不上，
        //     看起来就是"公式挤成一团"）。只有 `$ x $`（内侧有空白）才是行间公式，才打断段落。
        //   * raw：`` `code` `` 是行内的，只有 ```` ``` ```` 围栏才是块。
        let own_block = BLOCK_KINDS.contains(&kind)
            || (kind == SyntaxKind::Equation && is_display_equation(src, &range))
            || (kind == SyntaxKind::Raw && is_fenced_raw(src, &range))
            || (LINE_ONLY_KINDS.contains(&kind) && is_alone_on_line(src, range.start, range.end));

        if own_block {
            close_para(&mut para, &mut para_no_output, &mut out);
            out.push(SourceBlock {
                kind: kind_name(kind),
                range,
                no_output: is_no_output_node(kind),
            });
            continue;
        }

        let this_no_output = is_no_output_node(kind);
        para = match para {
            Some(r) => {
                // 混进任何会画东西的节点（Text / Strong / Equation …）就不再是"无输出块"
                para_no_output = para_no_output && this_no_output;
                Some(r.start..r.end.max(range.end))
            }
            None => {
                para_no_output = this_no_output;
                Some(range.start..range.end)
            }
        };
    }
    close_para(&mut para, &mut para_no_output, &mut out);
    out
}

/// 行间公式判据（与 typst 一致、也与前端 math-ranges 的判定一致）：
/// **定界符内侧两侧都有空白** 的 `$ x $` 才是行间/块级公式；`$x$` 是行内公式。
fn is_display_equation(src: &str, range: &Range<usize>) -> bool {
    let text = &src[range.clone()];
    let mut chars = text.chars();
    if chars.next() != Some('$') {
        return false;
    }
    let inner: String = text
        .chars()
        .rev()
        .skip(1)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let inner = inner.trim_start_matches('$');
    match (inner.chars().next(), inner.chars().last()) {
        (Some(first), Some(last)) => {
            first.is_whitespace() && last.is_whitespace() && !inner.trim().is_empty()
        }
        _ => false,
    }
}

/// 块级 raw 判据：必须是以 ```` ``` ```` 开头的围栏（`` `x` `` 是行内 raw）。
fn is_fenced_raw(src: &str, range: &Range<usize>) -> bool {
    src[range.clone()].trim_start().starts_with("```")
}

/// 该字节区间是否"独占整行"（前一行的残余与本行的后续都只有空白）
fn is_alone_on_line(src: &str, start: usize, end: usize) -> bool {
    let line_start = src[..start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end = src[end..].find('\n').map(|i| end + i).unwrap_or(src.len());
    src[line_start..start].trim().is_empty() && src[end..line_end].trim().is_empty()
}

fn kind_name(kind: SyntaxKind) -> &'static str {
    match kind {
        SyntaxKind::Heading => "Heading",
        SyntaxKind::ListItem => "ListItem",
        SyntaxKind::EnumItem => "EnumItem",
        SyntaxKind::TermItem => "TermItem",
        SyntaxKind::Raw => "Raw",
        SyntaxKind::Equation => "Equation",
        SyntaxKind::Code => "Code",
        _ => "Other",
    }
}
