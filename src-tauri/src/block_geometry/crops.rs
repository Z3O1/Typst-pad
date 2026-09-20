use super::*;

// ---------------------------------------------------------------------------
// 写作模式的块级渲染（阶段 1）：整篇编译一次 → 每个源块切一块 SVG 给编辑器内联显示
// ---------------------------------------------------------------------------

/// 页面默认页边距比例（70.87pt / 595.28pt，即 A4 默认页边距）。与 `typst_world::preview_page_setup`
/// 同源：正文列宽 = 页宽 × (1 - 2×比例)，因此反推页宽 = 列宽 / (1 - 2×比例)。
const PAGE_MARGIN_RATIO: f64 = 70.87 / 595.28;

/// typst 的默认正文字号（pt）：文档没有 `#set text(size:)` 时源码透镜就用它
/// （11pt = 14.67px，与切片里的正文完全一致）。
pub const DEFAULT_TEXT_PT: f64 = 11.0;

/// **单个源块允许渲切片的字节上限**（超过就只回几何、不渲图，前端保持源码显示）。
///
/// 为什么需要（PR #60 审查第 7 条）：窗口化是**按块**的（`in_window`），于是一块如果自己就
/// 很大（没有空行的长段落、2000 行的围栏代码块），它永远是"窗口内的块" ⇒ 每按一个键都整块渲
/// 一遍，而逐块 SVG 约 **58 字节/源字符** —— 2000 行代码块（~6 万字符）就是 3MB 级的一次
/// 按键开销。8KB 与前端"短文档 ≤ 8000 字符就全渲"同一量级：比这个还大的单块本身就比整篇短
/// 文档还重，让它显示源码（可编辑）比渲一张巨图划算。
pub const MAX_CROP_SOURCE_BYTES: usize = 8_000;

/// 正文正字号的可接受区间（pt）—— 见 `document_text_pt` 的夹紧
pub const MIN_TEXT_PT: f64 = 6.0;
pub const MAX_TEXT_PT: f64 = 48.0;

/// 文档的**正文实际字号**（pt）：帧里所有文本按**字符数**投票，取票数最高的那个字号。
///
/// 为什么这么算：写作模式里"光标所在块展开成源码、其余块显示引擎切片"，而源码是编辑器 CSS
/// 画的 —— 如果它的字号与切片不一致，光标一进某一块，那一块的字和行高就会**变大**
/// （用户原话：「不要光标在哪里哪里就变大了」）。正文在字符数上占绝对多数（标题/代码块只是少数），
/// 所以众数就是正文字号：默认文档 11pt、`#set text(size: 12pt)` 的文档 12pt（都有单测）。
/// 没有文本（空文档 / 只有图形）时回落到 typst 默认的 11pt。
pub fn document_text_pt(stats: &FrameStats) -> f64 {
    let voted = stats
        .size_weights
        .iter()
        .max_by_key(|(_, weight)| **weight)
        .map(|(key, _)| *key as f64 / 100.0)
        .unwrap_or(DEFAULT_TEXT_PT);
    // **夹到合理区间**（PR #60 审查第 7 条的附带项）：这个值会一路变成编辑区正文字号
    // （`--write-doc-px = textPt × 4/3`），文档写个 `#set text(size: 400pt)` 或者字号统计
    // 被离群值带偏，就会把编辑区撑成"一行一个字"。夹紧范围取 typst 自己的合理区间。
    voted.clamp(MIN_TEXT_PT, MAX_TEXT_PT)
}

/// 一个源块的渲染产物（前端直接消费：serde camelCase）。
///
/// `start`/`end` 是**用户文档坐标的字节偏移**（不含编译前缀）—— Rust 侧已经减掉了
/// `doc_offset`，前端只需把字节偏移换算成 CodeMirror 的 UTF-16 位置（见 block-offsets.ts）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockCrop {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    /// 是否有渲染结果（`#let` / `#show` / 纯注释行没有 → 前端保持源码显示）
    pub found: bool,
    /// **这一块被有意跳过渲图**（源码太大，见 `MAX_CROP_SOURCE_BYTES`）。
    /// 前端必须把它与"缺切片"区分开：`found && svg === ""` 会被当成"缺切片"去要求补渲
    /// （见 `notifyBlocksNeeded`），不区分的话就会变成**每 150ms 重编译一次的循环**。
    #[serde(default)]
    pub skipped: bool,
    /// 内容分布在几页（单张长页正常为 1；>1 = 文档自己分页了，此时只切首页那部分）
    pub pages: usize,
    /// 切片所在页（1-based）。点击定位要把"页面坐标"告诉 Rust 侧的命中测试
    pub page: usize,
    /// 裁剪带的左缘（pt）= 页边距。切片自己的坐标系原点在带的左上角，
    /// 所以页面坐标 = (x_pt + 切片内相对 x, y_pt + 切片内相对 y)
    pub x_pt: f64,
    /// 裁剪带在页面上的纵向范围（pt），仅调试/核查用
    pub y_pt: f64,
    /// 裁剪带宽度（pt）= 正文列宽；高度（pt）含与相邻块的半个间距，
    /// **所以各块按源码顺序摞起来高度总和 == 排版里的纵向总高度**
    pub width_pt: f64,
    pub height_pt: f64,
    /// 占了几行（行带数），调试用
    pub bands: usize,
    /// 该块 SVG **内部**的链接热区（相对裁剪带左上角，pt）：前端据此贴一层可点的透明方块。
    /// 只有窗口内的块才有（与 svg 同步取舍），没有链接时为空数组。
    pub links: Vec<CropLink>,
    /// 该块的 SVG（空串 = 没有渲染结果，前端保持源码显示）
    pub svg: String,
}

/// 切片上的一个链接热区（相对裁剪带左上角，pt —— 与 SVG 的坐标系一致）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropLink {
    pub x_pt: f64,
    pub y_pt: f64,
    pub width_pt: f64,
    pub height_pt: f64,
    pub href: String,
}

/// `compile_blocks` 的产物。字段与 `CompileOutput` 保持同构（诊断/警告同一套结构），
/// 前端因此在写作模式与源码模式之间可以共用状态栏、错误计数、波浪线逻辑。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlocksOutput {
    pub ok: bool,
    /// **这个键永远要发**（编译失败时是空数组）—— 别给它加 `skip_serializing_if`：
    /// 前端用"`blocks` 是不是数组"来区分「后端没实现这个命令」（旧安装包 / 浏览器桩）
    /// 与「这一次编译失败」，键缺了就会把**真机上任何 typst 错误**读成"后端不支持"，
    /// 于是退回整页预览路径，前端那条"撤掉切片 + 展开错误块"的失败分支永远走不到。
    /// （PR #60 审查抓到；与 `Diagnostic::path` 那个 `path:null` 同一类陷阱 ——
    /// **桩按契约写、真后端不这么发**，所以 115 项验收全绿也没抓住。）
    pub blocks: Vec<BlockCrop>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
    pub page_width_pt: f64,
    /// **文档的正文实际字号**（pt）—— 前端拿它当写作模式"源码透镜"的字号基准，
    /// 这样光标进出块时字号不跳（见 `document_text_pt`）。
    pub text_pt: f64,
    /// **这一轮编译写进 `HIT_CACHE` 的几何编号**（失败 = 0）。前端把它原样带回
    /// `block_hit_test`：编号对不上就拒绝命中（返回 None，前端退回"光标落到块首"）。
    ///
    /// 为什么需要它：命中几何是**进程级全局**的，而应用支持多窗口（`Ctrl+Shift+N`）——
    /// 窗口 A 编译完、窗口 B 又编译了一次之后，A 再点击就会用 B 的排版几何，
    /// 结果被钳进 A 的块区间 ⇒ **点错字但不会崩**（PR #60 审查抓到）。前端那两道闸门
    /// （块表与当前文档一致、块表精确）都是**每窗口**的，看不见另一个窗口。
    pub geometry_id: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<crate::typst_world::Diagnostic>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<crate::typst_world::Diagnostic>,
}

impl BlocksOutput {
    pub(crate) fn fail(
        diagnostics: Vec<crate::typst_world::Diagnostic>,
        page_width_pt: f64,
    ) -> Self {
        Self {
            ok: false,
            blocks: Vec::new(),
            pages: None,
            page_width_pt,
            text_pt: DEFAULT_TEXT_PT,
            geometry_id: 0, // 失败 = 没有可用的几何
            diagnostics,
            warnings: Vec::new(),
        }
    }
}

/// 写作模式的块级编译：**整篇编译一次**（与预览同一条链路），把每个源块在版面上的那一块
/// 切出来单独渲成 SVG。
///
/// * `src` —— 编译源（可能含设置里的前缀代码，与 `compile_doc` 的约定一致）
/// * `doc_offset` —— 用户文档在 `src` 里的起始**字节**偏移（= 前缀字符串的 UTF-8 字节长度）；
///   返回的块区间都相对它，前端拿到就是 CodeMirror 可直接用的文档坐标
/// * `content_width_pt` —— 写作模式正文列宽（pt）：版心宽随编辑器列宽走，正文在这个宽度下重排
/// * `want_from` / `want_to` —— **只给这个字节窗口内的块渲切片**（**用户文档字节偏移**，
///   与返回的块区间同一坐标系；None = 全渲）。
///   实测（`dump_long_doc_blocks`）：逐块 SVG 会各自复制一份字形轮廓，约 **58 字节/源字符**
///   —— 2 万字符的文档全渲一次要 11.7MB、debug 下 3.7s，**每按键一次**。所以编辑器只请求
///   视口附近的那一段，窗口外的块照旧返回几何（`found`/`height_pt`），但 `svg` 为空，
///   由前端用上一轮的结果按"块文本相同"沿用（见 block-plan 的 carryOverCrops）。
///
/// 失败与 `compile_doc` 同样返回结构化诊断（行号口径一致：注入的 `#set page` 行已减掉，
/// 但**前缀行仍在**，与现有 `mapCompiledPosToDoc` 的假设一致）。
// 参数与 IPC 命令 `compile_blocks` 一一对应（同一个窗口三元组 want_from/want_to 必须一起传），
// 收成结构体只是换个写法、并不能减少调用方要提供的信息，所以显式豁免参数个数检查。
#[allow(clippy::too_many_arguments)]
pub fn compile_blocks(
    src: String,
    doc_offset: usize,
    document_path: Option<String>,
    fonts_dir: &Path,
    font_config: &FontConfig,
    content_width_pt: f64,
    want_from: Option<usize>,
    want_to: Option<usize>,
) -> BlocksOutput {
    let content_width_pt = if content_width_pt.is_finite() {
        content_width_pt.clamp(120.0, 2000.0)
    } else {
        371.25 // 兜底 = 495px 正文列宽
    };
    // 页宽反推：正文列宽 = 页宽 ×(1 - 2×页边距比例)
    let page_width_pt = content_width_pt / (1.0 - 2.0 * PAGE_MARGIN_RATIO);
    let margin_pt = page_width_pt * PAGE_MARGIN_RATIO;
    let injected =
        format!("#set page(width: {page_width_pt:.2}pt, height: auto, margin: {margin_pt:.2}pt)\n");
    let compiled_src = format!("{injected}{src}");
    // 编译源里的"用户文档起点"：注入行 + 前缀
    let doc_start = injected.len() + doc_offset;

    let world = TypstWorld::new(compiled_src, document_path, fonts_dir, font_config);
    // `main_line_offset = 1`：注入的 `#set page(...)` 占了一行，主源诊断的行号要减回去
    // （与 compile_with_page_width 同一口径；前缀行仍留在行号里，由前端 mapCompiledPosToDoc 处理）
    let (document, raw_warnings) = match typst::compile::<PagedDocument>(&world) {
        typst::diag::Warned {
            output: Ok(doc),
            warnings,
        } => (doc, warnings),
        typst::diag::Warned {
            output: Err(errors),
            ..
        } => {
            let diags = crate::typst_world::collect_diagnostics(&world, errors, 1);
            return BlocksOutput::fail(diags, page_width_pt);
        }
    };
    let warnings = crate::typst_world::collect_diagnostics(&world, raw_warnings, 1);

    // 块划分只看用户文档那一段（前缀不属于编辑器里的内容）
    let Some(doc_text) = src.get(doc_offset..) else {
        return BlocksOutput::fail(Vec::new(), page_width_pt);
    };
    let blocks = source_blocks(doc_text);
    let ((items, stats), placed_links) = collect_geometry_with_links(&world, &document);

    // 1) 每个块的几何（编译源坐标 = 文档坐标 + doc_start）
    struct Found {
        idx: usize,
        page: usize,
        top: f64,
        bottom: f64,
        pages: usize,
        bands: usize,
        left: f64,
    }
    let mut geoms: Vec<Option<Found>> = Vec::with_capacity(blocks.len());
    for (idx, block) in blocks.iter().enumerate() {
        let injected_range = (block.range.start + doc_start)..(block.range.end + doc_start);
        geoms.push(geometry_for_range(&items, injected_range).map(|g| Found {
            idx,
            page: g.page,
            top: g.rect.min.y.to_pt(),
            bottom: g.rect.max.y.to_pt(),
            pages: g.pages,
            bands: g.bands,
            left: g.rect.min.x.to_pt(),
        }));
    }

    // 2) 按 (页, y) 排序后，用相邻块的"中点"切带：相邻两块各自分到一半间距，
    //    于是各块高度之和 = 排版里的纵向总高度，按顺序摞起来就还原版式。
    let mut order: Vec<usize> = (0..geoms.len()).filter(|i| geoms[*i].is_some()).collect();
    // `total_cmp` 而不是 `partial_cmp().unwrap()`：坐标理论上不会是 NaN，但真出现 NaN 时
    // `unwrap()` 会 **panic 在整个编译命令里**（渲染表面直接没了），而 total_cmp 只是排序
    // 顺序退化 —— 这是"宁可丑、不可崩"的那一类（PR #60 审查的第 10 条）。
    order.sort_by(|a, b| {
        let (ga, gb) = (geoms[*a].as_ref().unwrap(), geoms[*b].as_ref().unwrap());
        ga.page.cmp(&gb.page).then(ga.top.total_cmp(&gb.top))
    });

    // 2b) **越界夹紧**：块自己的纵向区间不许越过它在 y 序里的下一个块的顶。
    //
    // 为什么需要：typst 允许把内容排到远处（脚注正文在页底、`#place` 的内容在别处），而块的
    // 墨迹包围盒是**并集** —— 带脚注的段落因此会得到一个一直伸到页底的高盒子，把后面几块的
    // 中点切带全压扁：实测代码块被压到 ≤0.5pt（切片被丢弃 → 回退成源码/旧 widget），
    // 而它的内容又被脚注段那张超长切片吞进去又画了一遍（截图里代码块出现两次）。
    // 夹紧后各块的带仍首尾相接，且不会有哪一块被压没。
    for pos in 0..order.len() {
        let idx = order[pos];
        let next_same_page = order
            .get(pos + 1)
            .and_then(|n| geoms[*n].as_ref())
            .filter(|n| n.page == geoms[idx].as_ref().unwrap().page)
            .map(|n| n.top);
        let cur = geoms[idx].as_mut().unwrap();
        let limit = next_same_page.unwrap_or(f64::INFINITY);
        if cur.bottom > limit - 0.25 {
            cur.bottom = (limit - 0.25).max(cur.top + 0.5);
        }
        if cur.bottom <= cur.top {
            cur.bottom = cur.top + 0.5;
        }
    }

    let mut crops: Vec<Option<BlockCrop>> = Vec::with_capacity(blocks.len());
    crops.resize_with(blocks.len(), || None);
    for (pos, idx) in order.iter().enumerate() {
        let g = geoms[*idx].as_ref().unwrap();
        let prev = if pos > 0 {
            geoms[order[pos - 1]].as_ref()
        } else {
            None
        };
        let next = if pos + 1 < order.len() {
            geoms[order[pos + 1]].as_ref()
        } else {
            None
        };
        // 相邻块必须同页才能取中点（跨页之间没有"间距"可言）
        let band_top = match prev.filter(|p| p.page == g.page) {
            Some(p) => (p.bottom + g.top) / 2.0,
            None => g.top,
        };
        let band_bottom = match next.filter(|n| n.page == g.page) {
            Some(n) => (g.bottom + n.top) / 2.0,
            None => g.bottom,
        };
        let band_top = band_top.max(0.0);
        // 带高退化（极端文档）时留一条最小带，而不是把这块丢掉 —— 丢掉会让前端把它当成
        // "不可渲染"，回退到源码/旧 widget，看起来就是"这块没渲染"
        let height = (band_bottom - band_top).max(0.75);
        // 横向切**正文列**（不是墨迹外接盒）：列表缩进、居中公式、段首缩进都在列内，
        // 按墨迹切会把它们挤掉。
        let rect = Rect::new(
            Point::new(Abs::pt(margin_pt), Abs::pt(band_top)),
            Point::new(
                Abs::pt(page_width_pt - margin_pt),
                Abs::pt(band_top + height),
            ),
        );
        // 只渲"窗口内"的块：窗口外的块只回几何（前端沿用上一轮切片或先显示源码）
        // 窗口与返回的块区间**同一坐标系**（用户文档字节偏移，不含注入行与前缀）
        // **半开窗口 = 全渲**：只给一端时无法判断"窗口内"，宁可全渲也不静默少渲
        // （前端只会两端都给或都不给；这里把语义写明，别让它看起来像是漏判）。
        let in_window = match (want_from, want_to) {
            (Some(from), Some(to)) => {
                let s = blocks[*idx].range.start;
                let e = blocks[*idx].range.end;
                s < to && e >= from
            }
            _ => true,
        };
        // 单块太大 → 只回几何、不渲图（见 MAX_CROP_SOURCE_BYTES 的说明）
        let src_bytes = blocks[*idx]
            .range
            .end
            .saturating_sub(blocks[*idx].range.start);
        let skipped = in_window && src_bytes > MAX_CROP_SOURCE_BYTES;
        let svg = if in_window && !skipped {
            match document.pages().get(g.page.saturating_sub(1)) {
                Some(page) => render_crop(page, rect),
                None => String::new(),
            }
        } else {
            String::new()
        };
        // 链接热区：只取落在这一带里的（换算成"带内相对 pt"，与切片 SVG 的坐标系一致）。
        // 与 svg 一样只给窗口内的块 —— 窗口外的块这一轮没有图，热区也就没有意义。
        let links: Vec<CropLink> = if in_window && !skipped && !svg.is_empty() {
            placed_links
                .iter()
                .filter(|l| l.page == g.page && rects_intersect(l.rect, rect))
                // 夹到带内：链接方框有时比"块的墨迹包围盒"略高一点（行高 vs 墨迹），
                // 直接给前端会让热区溢出切片一两像素 —— 夹紧后前端按百分比铺出来必然在界内。
                .filter_map(|l| {
                    let x0 = (l.rect.min.x - rect.min.x)
                        .to_pt()
                        .clamp(0.0, rect.size().x.to_pt());
                    let y0 = (l.rect.min.y - rect.min.y)
                        .to_pt()
                        .clamp(0.0, rect.size().y.to_pt());
                    let x1 = (l.rect.max.x - rect.min.x)
                        .to_pt()
                        .clamp(0.0, rect.size().x.to_pt());
                    let y1 = (l.rect.max.y - rect.min.y)
                        .to_pt()
                        .clamp(0.0, rect.size().y.to_pt());
                    (x1 - x0 > 0.5 && y1 - y0 > 0.5).then(|| CropLink {
                        x_pt: x0,
                        y_pt: y0,
                        width_pt: x1 - x0,
                        height_pt: y1 - y0,
                        href: l.href.clone(),
                    })
                })
                .collect()
        } else {
            Vec::new()
        };
        crops[*idx] = Some(BlockCrop {
            start: blocks[*idx].range.start,
            end: blocks[*idx].range.end,
            kind: blocks[*idx].kind.to_string(),
            found: true,
            skipped,
            pages: g.pages,
            page: g.page,
            x_pt: rect.min.x.to_pt(),
            y_pt: band_top,
            width_pt: rect.size().x.to_pt(),
            height_pt: height,
            bands: g.bands,
            links,
            svg,
        });
    }

    // 3) 没有几何的块也返回（前端要拿它的区间做"源码透镜"的边界，不能凭空漏掉）
    let mut out: Vec<BlockCrop> = Vec::with_capacity(blocks.len());
    for (idx, block) in blocks.iter().enumerate() {
        out.push(crops[idx].take().unwrap_or(BlockCrop {
            start: block.range.start,
            end: block.range.end,
            kind: block.kind.to_string(),
            found: false, // 没有几何 = 引擎这块没画（前端整格隐藏，见 noOutput）
            skipped: false,
            pages: 0,
            page: 0,
            x_pt: 0.0,
            y_pt: 0.0,
            width_pt: content_width_pt,
            height_pt: 0.0,
            bands: 0,
            links: Vec::new(),
            svg: String::new(),
        }));
    }

    // 文档正文实际字号：**必须在 `store_hit_geometry` 之前算**（stats 与 items 一起被消费掉）
    let text_pt = document_text_pt(&stats);

    // 字形几何进缓存，供"点击 → 精确字符"的命中测试用（见 HIT_CACHE）。
    // 放在最后：前面的几何计算都借用了 items，这里把所有权交出去，不再多一份拷贝。
    let geometry_id = store_hit_geometry(items, doc_start);

    BlocksOutput {
        ok: true,
        blocks: out,
        pages: Some(document.pages().len()),
        page_width_pt,
        text_pt,
        geometry_id,
        diagnostics: Vec::new(),
        warnings,
    }
}

/// 切割用不到的尺寸类型再导出一次，避免外部（阶段 1 的命令层）重复 import
pub type CropSize = Size;
