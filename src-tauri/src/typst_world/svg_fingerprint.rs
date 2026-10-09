// 按 typst-svg 0.15.1 的默认导出字段散列，不把不可见源码 Span / introspection Tag 当成画面。
// Paint/Image 保留完整 Hash（尤其 tiling 的资源 ID 使用其完整帧）；不可递归剥离其元数据。
// 升级 Typst 或修改 SvgOptions 时必须重新审计渲染器，并更新此域与 IPC 前缀。
use super::cache::BoundedCache;
use super::*;
use std::hash::{Hash, Hasher};
use typst::layout::GroupItem;
use typst::text::{Glyph, TextItem};

const MAX_FRAME_HASHES: usize = 4096;
static FRAMES: OnceLock<Mutex<Fingerprints>> = OnceLock::new();

struct SvgText<'a>(&'a TextItem);
impl Hash for SvgText<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // 刻意穷举字段；上游新增字段时编译失败，避免悄悄遗漏新的 SVG 输入。
        let TextItem {
            font,
            size,
            fill,
            stroke,
            lang,
            region,
            text,
            glyphs,
        } = self.0;
        (font, size, fill, stroke, lang, region, text).hash(state);
        glyphs.len().hash(state);
        for Glyph {
            id,
            x_advance,
            x_offset,
            y_advance,
            y_offset,
            range,
            span: _,
        } in glyphs
        {
            (id, x_advance, x_offset, y_advance, y_offset, range).hash(state);
        }
    }
}

struct Fingerprints(BoundedCache<u128, u128>);
impl Default for Fingerprints {
    fn default() -> Self {
        Self(BoundedCache::new(MAX_FRAME_HASHES, usize::MAX))
    }
}
impl Fingerprints {
    fn frame(&mut self, frame: &Frame) -> u128 {
        // 完整帧摘要由 Typst LazyHash 复用，只做 FIFO O(1) 查询；不持有 Frame / Font / Source。
        let full = typst::utils::hash128(frame);
        if let Some(hash) = self.0.peek(&full) {
            return *hash;
        }
        let items: Vec<_> = frame
            .items()
            .filter_map(|(position, item)| {
                let hash = match item {
                    FrameItem::Group(GroupItem {
                        frame,
                        transform,
                        clip,
                        label,
                        parent: _,
                    }) => typst::utils::hash128(&(0u8, transform, clip, label, self.frame(frame))),
                    FrameItem::Text(text) => typst::utils::hash128(&(1u8, SvgText(text))),
                    FrameItem::Shape(shape, _) => typst::utils::hash128(&(2u8, shape)),
                    FrameItem::Image(image, size, _) => typst::utils::hash128(&(3u8, image, size)),
                    FrameItem::Link(destination, size) => {
                        typst::utils::hash128(&(4u8, destination, size))
                    }
                    FrameItem::Tag(_) => return None,
                };
                Some((position, hash))
            })
            .collect();
        let hash = typst::utils::hash128(&(frame.size(), frame.kind(), items));
        self.0.insert(full, hash, 0);
        hash
    }

    fn page(&mut self, page: &Page) -> u128 {
        let Page {
            frame,
            bleed,
            fill,
            numbering: _,
            supplement: _,
            number: _,
        } = page;
        typst::utils::hash128(&(
            "typst-svg-0.15.1:default:v2",
            bleed,
            fill,
            self.frame(frame),
        ))
    }
}

pub(super) fn fingerprint(page: &Page) -> u128 {
    FRAMES
        .get_or_init(|| Mutex::new(Fingerprints::default()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .page(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use typst::layout::{FrameKind, Size};
    use typst::visualize::Geometry;

    #[test]
    fn invisible_page_metadata_does_not_invalidate_svg() {
        let world = TypstWorld::new(
            "hello".into(),
            None,
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts"),
            &FontConfig::default(),
        );
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let page = &document.pages()[0];
        let mut changed = page.clone();
        changed.number += 10;
        changed.numbering = None;
        assert_eq!(
            typst_svg::svg(page, &SvgOptions::default()),
            typst_svg::svg(&changed, &SvgOptions::default())
        );
        assert_eq!(fingerprint(page), fingerprint(&changed));
    }

    #[test]
    fn source_spans_and_tags_do_not_change_svg_identity() {
        fn strip(frame: &Frame) -> Frame {
            let mut result = frame.clone();
            result.clear();
            for (position, item) in frame.items() {
                let mut item = item.clone();
                match &mut item {
                    FrameItem::Group(group) => {
                        group.frame = strip(&group.frame);
                        group.parent = None;
                    }
                    FrameItem::Text(text) => {
                        for glyph in &mut text.glyphs {
                            glyph.span = (typst::syntax::Span::detached(), 17);
                        }
                    }
                    FrameItem::Shape(_, span) | FrameItem::Image(_, _, span) => {
                        *span = typst::syntax::Span::detached()
                    }
                    FrameItem::Tag(_) => continue,
                    FrameItem::Link(_, _) => {}
                }
                result.push(*position, item);
            }
            result
        }
        let world = TypstWorld::new(
            "= 中文\n#rect(fill: red)\n#box[标签] <anchor>\n#link(\"https://typst.app\")[链接]"
                .into(),
            None,
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts"),
            &FontConfig::default(),
        );
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let original = &document.pages()[0];
        let mut changed = original.clone();
        changed.frame = strip(&original.frame);
        assert_ne!(
            typst::utils::hash128(original),
            typst::utils::hash128(&changed)
        );
        assert_eq!(
            typst_svg::svg(original, &SvgOptions::default()),
            typst_svg::svg(&changed, &SvgOptions::default())
        );
        assert_eq!(fingerprint(original), fingerprint(&changed));
    }

    #[test]
    fn frame_summaries_are_bounded_and_recompute_after_eviction() {
        let mut cache = Fingerprints::default();
        let make = |i: usize| {
            let mut frame = Frame::new(Size::new(Abs::pt(20.0), Abs::pt(20.0)), FrameKind::Soft);
            frame.push(
                Point::new(Abs::pt(i as f64), Abs::zero()),
                FrameItem::Shape(
                    Geometry::Rect(frame.size()).filled(typst::visualize::Color::BLACK),
                    typst::syntax::Span::detached(),
                ),
            );
            frame
        };
        let first = make(0);
        let expected = cache.frame(&first);
        for i in 1..=MAX_FRAME_HASHES {
            cache.frame(&make(i));
        }
        assert_eq!(cache.0.usage(), (MAX_FRAME_HASHES, 0));
        assert!(cache.0.peek(&typst::utils::hash128(&first)).is_none());
        assert_eq!(cache.frame(&first), expected);
    }
}
