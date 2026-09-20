// block_geometry 的单元测试按**关注点**分文件（原先是一个 1379 行的 `tests.rs`）。
//
// 这里只放**公共件**：测试锁、helper、几组共享的样例文档，以及各分册的 `mod` 声明。
// 每个子模块自己的用例在 `tests/<关注点>.rs` 里；`#[ignore]` 的探针集中在 `tests/probes.rs`
// （`package.json` 的 `fixtures:blocks` 按**用例名**过滤它们，名字不能改）。
use super::*;
use std::path::PathBuf;

// ⚠️ 两个 glob 会把**同名的兄弟模块**也带进作用域（`tests/` 里的 `crops`/`hit` 与被测模块的
// 私有 `mod crops` / `mod hit` 同名；`typst_world` 侧是 `fonts`/`math`/`paths`）。今天合法，
// 因为没人裸用这些模块名；但**别在分册里写 `crops::foo` 这种裸模块路径** —— 那会撞 E0659。

/// **命中几何是进程级全局的**（`HIT_CACHE` 只保留"最近一次 `compile_blocks`"的字形几何）。
/// 生产路径没问题：前端只对刚编译过的同一篇文档做命中测试，前面还有"块表必须与当前文档一致"
/// 的闸门。但**测试是并行跑的** —— 两个用例同时编译不同文档时，后者的几何会覆盖前者，
/// 命中断言就读到了别人的排版。实测：`hit_test_on_real_layout_maps_edges_to_block_bounds`
/// 单独跑绿、跑全集红（期望 `Some(0)` 拿到 `Some(2)`，正好差一个前缀的长度）。
/// 所以凡是**写**缓存（调 `compile_blocks`）或**读**缓存（调 `hit_test`）的用例都先拿这把锁，
/// 让它们串行；`pick_hit` 那种纯函数用例不受影响（自造 items）。
static HIT_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

/// 拿测试锁（用 `into_inner` 兜住中毒：某个用例 panic 了也要放别人过去）
fn hit_cache_guard() -> std::sync::MutexGuard<'static, ()> {
    HIT_CACHE_TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn fonts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts")
}

/// 造一个字形项：源区间 + 版面矩形（页面坐标）
fn item(page: usize, range: Range<usize>, x0: f64, y0: f64, x1: f64, y1: f64) -> PlacedItem {
    PlacedItem {
        page,
        range,
        rect: Rect::new(
            Point::new(Abs::pt(x0), Abs::pt(y0)),
            Point::new(Abs::pt(x1), Abs::pt(y1)),
        ),
    }
}

/// 生成点击探针：在每个可渲染块的裁剪带里取「横向 5 × 纵向 3」个网格点，
/// 每个点都过一遍**真实的** `hit_test`，把答案记下来当期望值。
///
/// 为什么用网格而不是"每个字形取一个点"：夹具要能在**浏览器里原样复现**，
/// 网格点是任意的 (x, y)，不依赖前端知道字形的位置；而期望值来自真实几何，
/// 端到端验的还是"点在哪儿 → 光标落在哪个字符"。
fn hit_probes(out: &BlocksOutput) -> Vec<serde_json::Value> {
    const XF: &[f64] = &[0.06, 0.3, 0.5, 0.7, 0.98];
    const YF: &[f64] = &[0.2, 0.55, 0.85];
    let mut probes = Vec::new();
    for (idx, b) in out.blocks.iter().enumerate() {
        if !b.found || b.svg.is_empty() || b.height_pt <= 0.5 {
            continue;
        }
        for &yf in YF {
            for &xf in XF {
                let x = b.x_pt + b.width_pt * xf;
                let y = b.y_pt + b.height_pt * yf;
                if let Some(offset) = hit_test(b.start, b.end, b.page, x, y, None) {
                    // 保留两位小数：浏览器侧按这个值算视口坐标，误差 < 0.01pt 不会改变命中结果
                    probes.push(serde_json::json!({
                        "b": idx,
                        "x": (x * 100.0).round() / 100.0,
                        "y": (y * 100.0).round() / 100.0,
                        "o": offset,
                    }));
                }
            }
        }
    }
    probes
}

/// 真实文档样例：覆盖标题 / 段落 / 列表 / 行内与行间公式 / 围栏代码 / 表格 / 图 / 脚注 /
/// `#show` 规则 / 前缀宏 —— 阶段 0 就是拿它们量"能不能切干净"
const DOCS: &[(&str, &str)] = &[
    (
        "散文（中文 + 行内公式）",
        "= 第一章 引言\n\n\
             本文讨论 $a^2 + b^2 = c^2$ 这个恒等式，以及它在\n\
             实际排版里的表现。这里再放一个行内的 $alpha + beta$ 收尾。\n\n\
             == 小节标题\n\n\
             第二段的文字，用来观察段落之间的间距是否被正确切分出来。\n",
    ),
    (
        "列表 + 有序列表 + 行间公式",
        "= 清单\n\n\
             - 第一项\n\
             - 第二项\n\
               - 嵌套项\n\n\
             + 有序一\n\
             + 有序二\n\n\
             下面是一个行间公式：\n\n\
             $ integral_0^1 f(x) dif x = 1 $\n\n\
             公式之后的收尾段落。\n",
    ),
    (
        "代码块 + 表格 + 强调",
        "= 结构\n\n\
             正文里有 *粗体*、_斜体_ 与 `行内代码`。\n\n\
             ```rust\n\
             fn main() { println!(\"hi\"); }\n\
             ```\n\n\
             #table(\n\
               columns: 2,\n\
               [甲], [乙],\n\
               [1], [2],\n\
             )\n\n\
             表格之后的段落。\n",
    ),
    (
        "宏 / show 规则 / 脚注 / 引用",
        "#let name = \"Typst\"\n\
             #show heading: it => text(fill: rgb(\"#1d4ed8\"), it)\n\n\
             = 带宏的文档\n\n\
             这个文档用了宏 #name 和脚注#footnote[这是脚注正文，会被排到页底]。\n\n\
             = 第二个标题\n\n\
             这里不放交叉引用，只看几何是否切得干净。\n",
    ),
    (
        "长段落（观察多行与分页）",
        "= 长段落\n\n\
             #lorem(180)\n",
    ),
];

/// 供"切片几何等价"验收用的样例文档（真实产物夹具与不变量测试共用）。
/// **每条都是一行字面量**：用源码续行（`\` 换行）写会被续行的缩进带进文档文本，
/// 而 typst 把缩进 4+ 空格的段落当代码块 → 直接编译报错（实测踩过）。
const GEOMETRY_DOCS: &[(&str, &str)] = &[
    (
        "段落与标题",
        "= 第一章\n\n第一段正文，两行以上比较好，用来观察块间距是否被正确分到相邻两块。继续这一段的第二行文字。\n\n== 小节\n\n第二段正文。\n",
    ),
    (
        "列表",
        "= 清单\n\n- 第一项\n- 第二项\n  - 嵌套项\n\n+ 有序一\n+ 有序二\n\n收尾段落。\n",
    ),
    (
        "公式与代码",
        "= 公式\n\n行内 $a^2 + b^2$ 与行间：\n\n$ integral_0^1 f(x) dif x = 1 $\n\n```rust\nfn main() {}\n```\n\n代码之后的段落。\n",
    ),
];

mod crops;
mod hit;
mod partition;
mod probes;
mod text_size;
mod window;
