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
//!
//! 本目录（契约见 `docs/development/compiler-backend.md`）：
//!   * `world.rs`       `World` 实现（主文档 / 相对 include / 包解析）+ 输出与诊断类型
//!   * `fonts.rs`       字体加载、逐 face 注册、进程内缓存、默认族注入
//!   * `compile.rs`     预览页宽重排（`preview_page_setup`）+ 整篇编译（`compile_doc`）
//!   * `math.rs`        公式级渲染：贴边透明单页 SVG + 基线探针 + 墨迹撑画布
//!   * `pdf.rs`         PDF 导出
//!   * `diagnostics.rs` 诊断转换（span → 1-based 行列）
//!   * `paths.rs`       项目根放宽 + 相对导入预检

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use typst::diag::{FileError, FileResult, Severity, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::layout::{Abs, Frame, FrameItem, Point};
use typst::syntax::{FileId, LinkedNode, RootedPath, Source, SyntaxKind, VirtualPath, VirtualRoot};
use typst::text::{
    BottomEdge, BottomEdgeMetric, Font, FontBook, FontFamily, FontList, TextEdgeBounds, TextElem,
    TopEdge, TopEdgeMetric,
};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World, WorldExt};
use typst_layout::{Page, PagedDocument};
use typst_pdf::PdfOptions;
use typst_svg::SvgOptions;

mod compile;
mod diagnostics;
mod fonts;
mod math;
mod paths;
mod pdf;
mod world;

pub use compile::*;
pub(crate) use diagnostics::*;
pub use fonts::*;
pub use math::*;
pub use paths::*;
pub use pdf::*;
pub use world::*;

#[cfg(test)]
mod tests;
