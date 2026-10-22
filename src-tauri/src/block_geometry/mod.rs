// 整页帧的源位置、字形几何与最近命中；不切片或单独编译表达式。
use std::ops::Range;

use typst::layout::{Abs, Frame, FrameItem, FrameKind, Point, Rect, Transform};
use typst::text::{BottomEdge, BottomEdgeMetric, TextEdgeBounds, TopEdge, TopEdgeMetric};
use typst::{World, WorldExt};
use typst_layout::PagedDocument;

#[cfg(test)]
use crate::typst_world::{FontConfig, TypstWorld};
#[cfg(test)]
use std::path::Path;

mod collect;
mod hit;

pub use collect::*;
pub use hit::*;

#[cfg(test)]
mod tests;
