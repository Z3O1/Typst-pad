// **文字对应证明**（任务 1，见 docs/development/writing-rendering.md）：
// 回答"这一块画出来的可见内容，能不能严格对应回它的源码区间"。
//
// 为什么需要：写作模式让"纯文字块"在 CodeMirror 里以**真实文本**呈现（不再用 Typst 切片），
// 前提是**源码就是排版结果**。`#show "foo": "bar"`、`#let` 宏在使用处展开、同一段内容输出两次
// 这类写法都会让"画出来的字"与"源码的字"不是一回事 —— 这时直接编辑会把用户看到的文字换成
// 另一套，必须退回切片。
//
// 证明只依赖**帧里的字形几何**与源码字节，不重新解析 Typst 语法（避免和前端两套判据漂移）：
//   ① 与块区间相交的字形必须**全部落在块内**（跨块/来自别处的字形 ⇒ unknown）；
//   ② 全部同页，且**落在这一块的裁剪带里**（脚注正文被排到页底、`#place` 挪走的墨迹 ⇒ unknown）；
//   ③ 按阅读顺序（基线聚类 + 横向）源码区间**严格递增且不重叠**（重复输出/乱序 ⇒ unknown）；
//   ④ 块内**字母数字字符**（含 CJK）必须被某个字形覆盖（内容被丢掉/替换 ⇒ unknown）；
//      标点、空白、`*`/`=`/`$` 这类语法符允许没有字形；`<label>` / `@ref` 的名字也不画文字。
//   ⑤ 这一块的带里不许有**别的来源**的墨迹（其它块、include 进来的文件、解析不出区间的项）。
//
// ⑤ 里的"其它来源"包括 `stats.foreign_ink`（span 属于别的 `FileId` 或解析不出来的项）。
// 无法证明时一律返回 `unknown`（前端据此切片），绝不猜。
use super::*;

/// 证明的因果上限：超过 `MAX_CROP_SOURCE_BYTES` 的块本来就不渲图（`skipped`），证明没有意义。
const MAX_PROOF_SOURCE_BYTES: usize = MAX_CROP_SOURCE_BYTES;

/// 基线聚类的默认阈值（pt）：量不到行距时用（同一行的字形基线差通常 < 1pt）。
const DEFAULT_CLUSTER_TOL_PT: f64 = 3.0;

/// 自带字形允许越过裁剪带的容差（pt）：带是按墨迹中点切的，允许一点取整误差。
const OWN_BAND_TOL_PT: f64 = 2.0;

/// 判断"外来墨迹侵入了这一块的带"时用的容差（pt）：必须明显落在带内才算侵入。
const INTRUDE_TOL_PT: f64 = 0.75;

/// 一个块的**文字对应证明**（`BlockCrop.edit`）。
///
/// `verdict == "verified"` 才表示"这一块的可见文字严格对应这段源码"；其余一律按 unknown 处理。
/// `source` 是**编译时这一块的源码文本**：前端逐字比对当前文档的同一区间 —— 既确认区间没有漂移，
/// 也保证"为旧文档算出的产物不会给新文档授予资格"。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEditProof {
    /// `"verified"` | `"unknown"`
    pub verdict: String,
    /// 机器可读的原因码（`ok` / `straddle` / `out-of-band` / `order` / `gap` / …），便于测试与排障
    pub reason: String,
    /// 编译时的块源码文本（用户文档坐标；前端 `doc.slice(from, to)` 逐字比对）
    pub source: String,
}

impl BlockEditProof {
    fn verdict(source: &str, verdict: &str, reason: &str) -> Self {
        Self {
            verdict: verdict.to_string(),
            reason: reason.to_string(),
            source: source.to_string(),
        }
    }

    fn unknown(source: &str, reason: &str) -> Self {
        Self::verdict(source, "unknown", reason)
    }

    fn verified(source: &str) -> Self {
        Self::verdict(source, "verified", "ok")
    }
}

/// 缺口里允许"没有字形"的字符：只有**非字母数字**。
///
/// 缺了字母数字 ⇒ 有正文内容没画出来（被 show rule 换掉、被宏吃掉、被裁掉）⇒ unknown。
/// 标点/空白/语法符（`*`、`=`、`$`、`^`、`{}`、`\`…）本来就不一定各自成字形，放宽。
fn gap_char_ok(c: char) -> bool {
    !c.is_alphanumeric()
}

/// `<label>` / `@ref` 的**保守词法范围**：它们的名字是字母数字，但排版里不画成文字
/// （标签完全不画，引用画成编号/文献），所以不能按"缺口里的字母数字"判成内容丢失。
///
/// 只承认最常见的形态：`<` 或 `@` + 字母/下划线开头 + `[A-Za-z0-9_.:-]*`；
/// `<` 还必须有配对的 `>`。不做完整语法解析（那是前端扫描器的职责），漏认只会更保守。
fn invisible_name_ranges(text: &str) -> Vec<Range<usize>> {
    fn is_start(b: u8) -> bool {
        b.is_ascii_alphabetic() || b == b'_'
    }
    fn is_name(b: u8) -> bool {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-')
    }
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let open = bytes[i];
        if open == b'<' || open == b'@' {
            let mut j = i + 1;
            if j < bytes.len() && is_start(bytes[j]) {
                j += 1;
                while j < bytes.len() && is_name(bytes[j]) {
                    j += 1;
                }
                let closed = open == b'@' || (j < bytes.len() && bytes[j] == b'>');
                if closed {
                    if open == b'<' {
                        j += 1;
                    }
                    out.push(i..j);
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// 一个矩形（页面坐标）的纵向中心是否落在 `[top, bottom]` 内（容差 `tol`）
fn center_in_band(rect: &Rect, top: f64, bottom: f64, tol: f64) -> bool {
    let cy = (rect.min.y.to_pt() + rect.max.y.to_pt()) / 2.0;
    cy > top - tol && cy < bottom + tol
}

/// **证明一个块的文字对应**（纯函数，可单测）。
///
/// * `text` —— 这一块的**源码文本**（用户文档坐标；`abs` 是它在编译源里的对应区间，
///   两者长度相同 —— 编译源只是在最前面多了注入行与前缀）
/// * `abs` —— 这一块在**编译源**里的字节区间（帧项的区间就是编译源坐标）
/// * `page` / `band` —— 这一块的页号与裁剪带（页面坐标 pt）
/// * `items` —— 主文档里能解出源码区间的帧项（`collect_geometry` 的产物）
/// * `foreign_ink` —— 不属于主文档 / 解析不出区间的墨迹（`FrameStats::foreign_ink`）
/// * `atoms` —— 块内**原子区间**（相对块起点；公式/标签/引用/行内 raw，来自语法树）：
///   这些区间不要求逐字符有字形（见 `SourceBlock::atoms`）。
/// * `definitions` —— **定义/规则块与编译前缀**的源码区间（编译源坐标）：这些地方的
///   content value 在使用处的字形其 `Span` 仍指回定义处，不能算"外来墨迹"。
/// * `line_spacing` —— 文档行距（pt；量不到时用默认聚类阈值）
#[allow(clippy::too_many_arguments)]
pub fn prove_block_text(
    text: &str,
    abs: Range<usize>,
    page: usize,
    band: Rect,
    atoms: &[Range<usize>],
    definitions: &[Range<usize>],
    items: &[PlacedItem],
    foreign_ink: &[(usize, Rect)],
    line_spacing: Option<f64>,
) -> BlockEditProof {
    if text.len() > MAX_PROOF_SOURCE_BYTES {
        return BlockEditProof::unknown(text, "oversized");
    }

    // ① 与块区间相交的字形
    let own: Vec<&PlacedItem> = items
        .iter()
        .filter(|i| i.range.start < abs.end && i.range.end > abs.start)
        .collect();
    if own.is_empty() {
        return BlockEditProof::unknown(text, "no-glyph");
    }
    // ② 同页 + 全部落在块内
    if own.iter().any(|i| i.page != page) {
        return BlockEditProof::unknown(text, "multi-page");
    }
    if own
        .iter()
        .any(|i| i.range.start < abs.start || i.range.end > abs.end)
    {
        return BlockEditProof::unknown(text, "straddle");
    }
    // ②b 自带字形必须落在这一块的带里（脚注正文/`#place` 挪走的墨迹会出带）
    let top = band.min.y.to_pt();
    let bottom = band.max.y.to_pt();
    if own
        .iter()
        .any(|i| !center_in_band(&i.rect, top, bottom, OWN_BAND_TOL_PT))
    {
        return BlockEditProof::unknown(text, "out-of-band");
    }
    // ⑤ 带里不许有别的来源的墨迹（其它块的字形 / include 进来的文件 / 解析不出区间的项）
    let in_band = |r: &Rect| center_in_band(r, top, bottom, -INTRUDE_TOL_PT);
    let belongs = |i: &PlacedItem| i.range.start < abs.end && i.range.end > abs.start;
    // 指回 `#let`/`#show` 定义处或编译前缀的字形**不算外来**：content value 在使用处的 span
    // 本来就留在定义点（实测 PKU 真实作业里正文公式的宏字形全部指回文档开头的 `#let`）。
    let from_definition = |r: &Range<usize>| {
        definitions
            .iter()
            .any(|d| d.start <= r.start && r.end <= d.end)
    };
    if items
        .iter()
        .any(|i| i.page == page && !belongs(i) && in_band(&i.rect) && !from_definition(&i.range))
    {
        return BlockEditProof::unknown(text, "intrusion");
    }
    if foreign_ink.iter().any(|(p, r)| *p == page && in_band(r)) {
        return BlockEditProof::unknown(text, "foreign-ink");
    }

    // ③ 顺序与重复
    //
    // 分两层，因为**原子区间（公式）内部的字形不参与"阅读顺序"**：上下标/积分上下限的基线
    // 离主行很远（实测 `integral_0^1` 的 `0`/`1` 比主行低/高 10pt 以上），按基线聚类会把它们
    // 排到主行之后，源码区间自然不递增 —— 但那是 Typst 的正常排版，不是"乱序"。
    //   * ① 重复：**所有**字形（含公式里的）源码起点严格互不相同；
    //   * ② 乱序：**非原子**字形按阅读顺序源码区间严格递增且不重叠。
    {
        let rel = |i: &PlacedItem| (i.range.start - abs.start)..(i.range.end - abs.start);
        let atom_of = |r: &Range<usize>| {
            atoms
                .iter()
                .position(|a| a.start <= r.start && r.end <= a.end)
        };
        // 与原子相交却不被原子包含：说明这个字形的源码归属说不清
        for i in &own {
            let r = rel(i);
            if atoms.iter().any(|a| a.start < r.end && a.end > r.start) && atom_of(&r).is_none() {
                return BlockEditProof::unknown(text, "atom-straddle");
            }
        }
        let text_glyphs: Vec<&PlacedItem> = own
            .iter()
            .copied()
            .filter(|i| atom_of(&rel(i)).is_none())
            .collect();
        // 重复检查只看**非原子字形**：公式内部同一个源区间被多个字形共用是 typst 的正常排版
        // （`block_lines` 的注释也记过这条），拿它当"同一段输出两次"会误伤大量真实公式
        // （实测 PKU 四份作业 45 个正文/列表块因此被误判）。真正的重复输出（`it => it + it`）
        // 重复的是正文文字，仍然会被这里抓到。
        let mut starts: Vec<usize> = text_glyphs.iter().map(|i| i.range.start).collect();
        starts.sort_unstable();
        if starts.windows(2).any(|w| w[0] == w[1]) {
            return BlockEditProof::unknown(text, "duplicate");
        }
        let tol = line_spacing
            .map(|s| s * 0.5)
            .unwrap_or(DEFAULT_CLUSTER_TOL_PT);
        let order = reading_order(&text_glyphs, tol);
        for w in order.windows(2) {
            let (a, b) = (text_glyphs[w[0]], text_glyphs[w[1]]);
            if b.range.start <= a.range.start || b.range.start < a.range.end {
                return BlockEditProof::unknown(text, "order");
            }
        }
    }

    // ④ 覆盖检查：块内的字母数字必须有字形
    //（原子区间、`<label>` / `@ref` 与标点/空白/语法符允许没有字形，见各自的说明）
    let ranges = merged_ranges(&own, abs.start);
    // 允许"没有字形"的区间 = 语法树给的原子区间 ∪ 保守词法认出的 `<label>` / `@ref`
    let mut allowed = atoms.to_vec();
    allowed.extend(invisible_name_ranges(text));
    allowed.sort_by_key(|r| (r.start, r.end));
    let mut covered_ptr = 0usize;
    let mut allow_ptr = 0usize;
    for (off, ch) in text.char_indices() {
        let cs = off;
        let ce = off + ch.len_utf8();
        while covered_ptr < ranges.len() && ranges[covered_ptr].end <= cs {
            covered_ptr += 1;
        }
        let covered = covered_ptr < ranges.len()
            && ranges[covered_ptr].start <= cs
            && ranges[covered_ptr].end >= ce;
        if covered {
            continue;
        }
        let partial = covered_ptr < ranges.len()
            && ranges[covered_ptr].start < ce
            && ranges[covered_ptr].end > cs;
        if partial {
            return BlockEditProof::unknown(text, "partial");
        }
        while allow_ptr < allowed.len() && allowed[allow_ptr].end <= cs {
            allow_ptr += 1;
        }
        if allow_ptr < allowed.len()
            && allowed[allow_ptr].start <= cs
            && allowed[allow_ptr].end >= ce
        {
            continue;
        }
        if !gap_char_ok(ch) {
            return BlockEditProof::unknown(text, "gap");
        }
    }

    BlockEditProof::verified(text)
}

/// 把一堆（可能重叠的）源码区间合并成**升序、互不重叠**的块内相对区间。
///
/// 覆盖检查的游标只能往前推，所以喂给它的区间必须已经合并好 —— 重叠的区间（`$x$` 这类
/// 一个字形的区间覆盖整条公式时很常见）不合并会让后面的字符被判成"没覆盖"。
fn merged_ranges(items: &[&PlacedItem], base: usize) -> Vec<Range<usize>> {
    let mut raw: Vec<Range<usize>> = items
        .iter()
        .map(|i| (i.range.start - base)..(i.range.end - base))
        .collect();
    raw.sort_by_key(|r| (r.start, r.end));
    let mut out: Vec<Range<usize>> = Vec::with_capacity(raw.len());
    for r in raw {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

/// 阅读顺序：先按基线聚类（同一行的上下标/取整差异不拆行），行内按横向位置。
///
/// 返回的是 `items` 的下标序列。**不能只按 `(baseline, x)` 排序**：同一行的字形基线
/// 理论上相同，但浮点取整会让个别字形落到相邻的键上；先聚类再按 x 排更稳。
fn reading_order(items: &[&PlacedItem], tol: f64) -> Vec<usize> {
    if items.is_empty() {
        return Vec::new();
    }
    let mut by_baseline: Vec<usize> = (0..items.len()).collect();
    by_baseline.sort_by(|&a, &b| items[a].baseline_pt.total_cmp(&items[b].baseline_pt));
    let mut cluster = vec![0usize; items.len()];
    let mut c = 0usize;
    let mut start = items[by_baseline[0]].baseline_pt;
    for k in 1..by_baseline.len() {
        let b = items[by_baseline[k]].baseline_pt;
        if b - start > tol {
            c += 1;
            start = b;
        }
        cluster[by_baseline[k]] = c;
    }
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| {
        cluster[a].cmp(&cluster[b]).then(
            items[a]
                .rect
                .min
                .x
                .to_pt()
                .total_cmp(&items[b].rect.min.x.to_pt()),
        )
    });
    order
}

// ---------------------------------------------------------------------------
// 列表符号（任务 2）：符号/缩进/编号必须与 typst 一致
// ---------------------------------------------------------------------------

/// 一个列表项块的**渲染标记**（`BlockCrop.listMarker`）。
///
/// 为什么必须由引擎给：前端的 `markup-ranges` 按"缩进计数"近似 `+` 的序号，遇到
/// `#set enum(numbering: ...)`、`start:`、`full:` 或复杂列表就冒充不了真实结果。
/// 这里从帧里取出 typst **实际画出来的**符号（`•` / `1.` / `a)` …）与正文起点偏移，
/// 前端照它画，就把"符号、缩进、编号"三件事一起钉死了。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMarkerProof {
    /// typst 实际画出的标记文字（`•` / `1.` / `a)` …）
    pub text: String,
    /// **标记起点**相对裁剪带左缘的偏移（pt）：`marker-align` 不是默认的 `end` 时，
    /// 标记在标记盒里的位置会不同 —— 用引擎给的实际位置画，不假设对齐方式。
    pub marker_x_pt: f64,
    /// **正文起点**相对裁剪带左缘的偏移（pt）：前端把标记画成这个宽度的盒子，
    /// 正文正好落在 typst 的 `indent + marker_width + body_indent` 上。
    pub body_offset_pt: f64,
}

/// 取一个列表项的渲染标记（`None` = 不是列表项 / 取不到 / 这一块没有标记）。
///
/// 判据：块内**主文档**字号的最小基线就是首行；首行上、正文最左字形**左边**的
/// `typst 合成字形`（`DetachedInk`：`•`、`1.` 这些）按 x 排起来就是标记。
/// 合成字形还包含 `dif` 的 "d" 这类（在正文右侧，被 `x < body_x` 挡掉）。
pub fn list_marker_of(
    detached: &[DetachedInk],
    items: &[PlacedItem],
    abs: Range<usize>,
    page: usize,
    band: Rect,
    text_pt: f64,
    line_spacing: Option<f64>,
) -> Option<ListMarkerProof> {
    // 首行上的一个字形（标记与正文都可能来自 `items` 或 `detached`）
    struct LineGlyph {
        x: f64,
        end: f64,
        detached: bool,
        text: Option<String>,
    }
    let own: Vec<&PlacedItem> = items
        .iter()
        .filter(|i| i.page == page && i.range.start < abs.end && i.range.end > abs.start)
        .collect();
    if own.is_empty() {
        return None;
    }
    let tol = line_spacing
        .map(|s| s * 0.5)
        .unwrap_or(DEFAULT_CLUSTER_TOL_PT);
    let first_baseline = own
        .iter()
        .map(|i| i.baseline_pt)
        .fold(f64::INFINITY, f64::min);
    let top = band.min.y.to_pt() - OWN_BAND_TOL_PT;
    let bottom = band.max.y.to_pt() + OWN_BAND_TOL_PT;

    let mut line: Vec<LineGlyph> = Vec::new();
    for i in own.iter().filter(|i| i.baseline_pt - first_baseline <= tol) {
        line.push(LineGlyph {
            x: i.rect.min.x.to_pt(),
            end: i.rect.max.x.to_pt(),
            detached: false,
            text: None,
        });
    }
    for d in detached.iter().filter(|d| {
        d.page == page
            && (d.baseline_pt - first_baseline).abs() <= tol
            && d.rect.min.y.to_pt() >= top
            && d.rect.max.y.to_pt() <= bottom
    }) {
        line.push(LineGlyph {
            x: d.rect.min.x.to_pt(),
            end: d.rect.max.x.to_pt(),
            detached: true,
            text: Some(d.text.clone()),
        });
    }
    if line.is_empty() {
        return None;
    }
    line.sort_by(|a, b| a.x.total_cmp(&b.x));

    // 标记 = 首行**最左**的一段 typst 合成字形（`•`、`1.` …），到**正文起点**为止。
    //
    // 断开的判据是**横向间距**：typst 的列表把正文放在 `marker_width + body_indent`
    // （`body_indent` 默认 0.5em）处，所以标记与正文之间必然有一段明显大于字形间紧排的空白；
    // 而标记内部的字（`1` 与 `.`、多字标记）是紧挨着的。
    //
    // **不能只看"在第一个主文档字形左边"**（这是实测踩过的坑）：公式里 typst 合成的字形
    // （`$ar(va,s)$` 画出的 `𝛼`）也是合成字形，而且它们会在正文最左主文档字形**左边** ——
    // 按旧判据会把 `𝛼𝛼𝛼` 当成标记、把正文起点算到 64pt 处，前端画出来的标记宽 64pt、
    // 内容被推到右边，整块多折一行（PKU 高代周二 L101）。
    let gap_limit = (text_pt.max(1.0)) * 0.35;
    let mut run = 1usize;
    while run < line.len() {
        let prev_end = line[run - 1].end;
        if !line[run].detached || line[run].x - prev_end > gap_limit {
            break;
        }
        run += 1;
    }
    let marker = &line[..run];
    if !marker.iter().all(|g| g.detached) {
        return None; // 最左一段不是合成的标记字形（如自定义 marker 指回定义处）⇒ 切片
    }
    let text: String = marker.iter().filter_map(|g| g.text.as_deref()).collect();
    if text.is_empty() {
        return None;
    }
    let body_x = line[run..]
        .iter()
        .map(|g| g.x)
        .fold(f64::INFINITY, f64::min);
    if !body_x.is_finite() {
        return None;
    }
    let band_left = band.min.x.to_pt();
    Some(ListMarkerProof {
        text,
        marker_x_pt: marker[0].x - band_left,
        body_offset_pt: body_x - band_left,
    })
}
