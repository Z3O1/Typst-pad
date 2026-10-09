// 同次整页编译中的零流占位输出：移出页面后，仅公式帧作为浮动预览返回。
use super::*;
use typst::introspection::Tag;
use typst::model::Document;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaPreview {
    pub svg: String,
    pub width_pt: f64,
    pub height_pt: f64,
}

fn ink_bounds(
    frame: &Frame,
    transform: typst::layout::Transform,
    bounds: &mut Option<typst::layout::Rect>,
) {
    use typst::layout::{Rect, Transform};
    let mut add = |rect: Rect| {
        *bounds = Some(match *bounds {
            Some(old) => Rect::new(
                Point::new(old.min.x.min(rect.min.x), old.min.y.min(rect.min.y)),
                Point::new(old.max.x.max(rect.max.x), old.max.y.max(rect.max.y)),
            ),
            None => rect,
        });
    };
    for (position, item) in frame.items() {
        let ts = transform.pre_concat(Transform::translate(position.x, position.y));
        match item {
            FrameItem::Group(group) => {
                let mut child = None;
                ink_bounds(&group.frame, ts.pre_concat(group.transform), &mut child);
                if let Some(rect) = child {
                    add(rect);
                }
            }
            FrameItem::Text(text) => {
                let mut x = Abs::zero();
                for glyph in &text.glyphs {
                    let (up, down) = crate::block_geometry::glyph_ink(text, glyph.id);
                    let width = glyph.x_advance.at(text.size);
                    let offset = glyph.y_offset.at(text.size);
                    add(crate::block_geometry::transformed_rect(
                        Rect::new(
                            Point::new(x, -up - offset),
                            Point::new(x + width, down - offset),
                        ),
                        ts,
                    ));
                    x += width;
                }
            }
            FrameItem::Shape(shape, _) => add(crate::block_geometry::transformed_rect(
                shape.bbox(true),
                ts,
            )),
            FrameItem::Image(_, size, _) => add(crate::block_geometry::transformed_rect(
                Rect::from_pos_size(Point::zero(), *size),
                ts,
            )),
            _ => {}
        }
    }
}

fn strip(frame: &mut Frame, found: &mut Option<Frame>) {
    let mut output = None;
    frame.retain(|item| {
        if let FrameItem::Tag(Tag::Start(elem, _)) = item {
            match elem.label().map(|label| label.resolve()).as_deref() {
                Some("_typstpad_formula_preview") => {
                    output = Some(true);
                    return false;
                }
                Some("_typstpad_expansion_output") => {
                    output = Some(false);
                    return false;
                }
                _ => {}
            }
        }
        if let FrameItem::Group(group) = item {
            if let Some(formula) = output.take() {
                if formula {
                    *found = Some(group.frame.clone());
                }
                return false;
            }
            strip(&mut group.frame, found);
        }
        true
    });
}

pub(crate) fn extract(document: &PagedDocument) -> (PagedDocument, Option<FormulaPreview>) {
    let mut pages = document.pages().to_vec();
    let mut found = None;
    for page in &mut pages {
        strip(&mut page.frame, &mut found);
    }
    let preview = found.and_then(|mut frame| {
        let mut bounds = None;
        ink_bounds(&frame, typst::layout::Transform::identity(), &mut bounds);
        let bounds = bounds?;
        let padding = Abs::pt(1.0);
        frame.translate(Point::new(padding - bounds.min.x, padding - bounds.min.y));
        frame.set_size(typst::layout::Size::new(
            bounds.max.x - bounds.min.x + padding * 2.0,
            bounds.max.y - bounds.min.y + padding * 2.0,
        ));
        let width_pt = frame.width().to_pt();
        let height_pt = frame.height().to_pt();
        if width_pt <= 0.0 || height_pt <= 0.0 {
            return None;
        }
        let mut page = pages.first()?.clone();
        page.frame = frame;
        page.bleed = typst::layout::Sides::splat(Abs::zero());
        page.fill = typst::foundations::Smart::Custom(None);
        Some(FormulaPreview {
            svg: svg_for_page(&page),
            width_pt,
            height_pt,
        })
    });
    (
        PagedDocument::new(pages.into(), document.info().clone()),
        preview,
    )
}
