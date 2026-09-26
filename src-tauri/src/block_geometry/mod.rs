// **源块 ↔ 版面区域的几何映射**（调研见 `docs/design/rendering-model.md`）。
//
// 要回答的问题只有一个：**整篇按写作模式的版心宽编译一次之后，能不能把每一个源块在页面上所占的
// 那一块几何（页号 + x/y + 宽高）算出来？** 这是"渲染表面 + 源码透镜"方案的唯一真风险点 ——
// 覆盖率、连续性、耗时都要先量出来，再决定要不要动前端。
//
// 本目录（契约见 `docs/development/writing-rendering.md`）：
//   * `blocks.rs`  源块划分（语法树顶层节点 → 块区间；`$x$` 行内 / `$ x $` 行间的判据）
//   * `collect.rs` 帧遍历（字形 `Span` → 源字节区间）+ 块几何 `BlockGeom`
//   * `render.rs`  版面矩形工具 + 「切一块渲成 SVG」（`crops` / `probe` 共用）
//   * `crops.rs`   `compile_blocks`（整篇编译一次 → 每块一张 SVG）+ `BlocksOutput` 契约 + 文档正文字号
//   * `hit.rs`     点击定位：`HIT_CACHE` / `pick_hit` / `hit_test`
//   * `probe.rs`   阶段 0 探针：只被测试与 `--ignored` 用例调用，**不改产品行为**
//
// 三条关键事实（逐条核对过 typst 0.15.1 源码，见调研文档 3.2 的 API 表）：
//   * **每个字形自带源位置**：`Glyph.span: (Span, u16)`（`typst-library/src/text/item.rs:109`），
//     `Span` 给源节点、`u16` 给节点内子偏移 ⇒ 字形 → 源字节区间是通的可算的；
//   * **子帧坐标要按 `pos + p.transform(group.transform)` 映射回本层**（与 typst-ide 的
//     `find_in_frame` 同构；tinymist 自己抄的那份留着 `// TODO: Handle transformation.`，
//     说明变换是真坑，所以这里显式统计"带变换的 group"有多少）；
//   * `Shape`/`Image` 带**裸 `Span`**（不是 `Option`），`Group`/`Link`/`Tag` 不带源位置；
//     **导出格式里没有任何源信息**（SVG 只有 `data-typst-label`），所以映射只能做在内存的帧上。
//
// 未做的事（阶段 1 再说，别当成已解决）：
//   * 不处理 `FiledId` 不是主文档的项（include 进来的文件）——只统计主文档；
//   * 不处理嵌套列表项的细粒度（整段 ListItem 算一个块）；
//   * 切片的 `fill` 沿用原页设置（阶段 1 要决定透明还是白底）。

use std::ops::Range;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use typst::layout::{Abs, Frame, FrameItem, FrameKind, Point, Rect, Size, Transform};
use typst::syntax::{SyntaxKind, SyntaxNode};
use typst::text::{BottomEdge, BottomEdgeMetric, TextEdgeBounds, TopEdge, TopEdgeMetric};
use typst::{World, WorldExt};
use typst_layout::{Page, PagedDocument};
use typst_svg::SvgOptions;

use crate::typst_world::{FontConfig, TypstWorld};

mod blocks;
mod collect;
mod crops;
mod hit;
mod probe;
mod render;
mod text_proof;

pub use blocks::*;
pub use collect::*;
pub use crops::*;
pub use hit::*;
pub use text_proof::*;
// 探针对外路径与拆分前一致（`crate::block_geometry::probe_blocks` 等）：它只被测试与
// `--ignored` 用例调用，但**别把 `pub use` 省掉** —— 省掉就等于把三个 `pub` 项从
// `block_geometry` 之外变成不可达（PR #61 审查第 1 条）。今天 crate 内没有别的调用方，
// 所以这条 re-export 自身是"未使用"的，用 allow 压掉那条 warning（**别删 allow 下面的行**）。
#[allow(unused_imports)]
pub use probe::*;
pub(crate) use render::*;

#[cfg(test)]
mod tests;
