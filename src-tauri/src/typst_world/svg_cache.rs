// SVG 实际输入的 128 位指纹（包括字体、图片、变换和背景），在导出前比较。
// 不缓存几何或 Span 映射；它们必须读取本轮 World。
use super::*;
use std::collections::VecDeque;

const MAX_PAGES: usize = 256;
const MAX_BYTES: usize = 32 * 1024 * 1024;
static CACHE: OnceLock<Mutex<SvgCache>> = OnceLock::new();

#[derive(Default)]
struct SvgCache {
    pages: HashMap<u128, String>,
    order: VecDeque<u128>,
    bytes: usize,
}

impl SvgCache {
    fn get(&mut self, key: u128) -> Option<String> {
        let svg = self.pages.get(&key)?.clone();
        self.order.retain(|&entry| entry != key);
        self.order.push_back(key);
        Some(svg)
    }

    fn insert(&mut self, key: u128, svg: String) {
        if svg.len() > MAX_BYTES {
            return;
        }
        if let Some(old) = self.pages.remove(&key) {
            self.bytes -= old.len();
            self.order.retain(|&entry| entry != key);
        }
        self.bytes += svg.len();
        self.pages.insert(key, svg);
        self.order.push_back(key);
        while self.bytes > MAX_BYTES || self.pages.len() > MAX_PAGES {
            if let Some(key) = self.order.pop_front() {
                if let Some(svg) = self.pages.remove(&key) {
                    self.bytes -= svg.len();
                }
            }
        }
    }
}

pub(super) fn cached_svg(page: &Page) -> String {
    cached_svg_with_key(page, super::svg_fingerprint::fingerprint(page))
}

fn cached_svg_with_key(page: &Page, key: u128) -> String {
    let cache = CACHE.get_or_init(|| Mutex::new(SvgCache::default()));
    if let Some(svg) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(key) {
        return svg;
    }
    // 导出不占缓存锁；正常编译仍由命令层串行化。
    let svg = typst_svg::svg(page, &SvgOptions::default());
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, svg.clone());
    svg
}

// 指纹域带协议版本；SVG 导出选项变化时必须更换前缀或纳入指纹。
// null 只引用前端已持有的同位置页面。即使服务器 SVG 缓存被淘汰，也不需要重传。
pub(super) fn incremental_pages(
    pages: &[Page],
    known: Option<&[String]>,
) -> (Vec<Option<String>>, Vec<String>) {
    let mut output = Vec::with_capacity(pages.len());
    let mut keys = Vec::with_capacity(pages.len());
    for (index, page) in pages.iter().enumerate() {
        let hash = super::svg_fingerprint::fingerprint(page);
        let key = format!("v2:{hash:032x}");
        let held = known
            .and_then(|keys| keys.get(index))
            .is_some_and(|held| *held == key);
        output.push(if held {
            None
        } else {
            Some(cached_svg_with_key(page, hash))
        });
        keys.push(key);
    }
    (output, keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_pages_are_identical_to_full_export_after_content_and_style_changes() {
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        for change in [
            "原文",
            "修改",
            "#set text(size: 18pt)\n大字",
            "#set page(fill: yellow)\n背景",
            "#rect(width: 40pt, height: 20pt, fill: gradient.linear(red, blue))",
            "#let pat = tiling(size: (8pt, 8pt), [#circle(radius: 2pt, fill: red)])\n#rect(width: 40pt, height: 20pt, fill: pat)",
            "#box(width: 40pt, height: 20pt, clip: true)[#rotate(20deg)[#text(stroke: 0.5pt + red)[ABC😀]]]",
            "#set text(lang: \"ar\")\nمرحبا",
            "#image(bytes(\"<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20'><rect width='20' height='20' fill='blue'/></svg>\"), format: \"svg\", width: 20pt)",
        ] {
            let src = format!("#set page(width: 300pt, height: 400pt)\n{change} $x^2$\n#pagebreak()\n#table(columns: 2, [甲], [乙])\n#link(\"https://typst.app\")[链接]");
            let world = TypstWorld::new(src, None, &fonts, &FontConfig::default());
            let document = typst::compile::<PagedDocument>(&world).output.unwrap();
            for page in document.pages() {
                let expected = typst_svg::svg(page, &SvgOptions::default());
                assert_eq!(cached_svg(page), expected);
                assert_eq!(cached_svg(page), expected);
            }
        }
    }

    #[test]
    fn old_protocol_keys_force_full_svg_then_current_keys_reuse() {
        let fonts = Path::new(env!("CARGO_MANIFEST_DIR")).join("fonts");
        let world = TypstWorld::new(
            "甲\n#pagebreak()\n乙".into(),
            None,
            &fonts,
            &FontConfig::default(),
        );
        let document = typst::compile::<PagedDocument>(&world).output.unwrap();
        let (full, keys) = incremental_pages(document.pages(), None);
        let old: Vec<_> = keys
            .iter()
            .map(|key| key.replacen("v2:", "v1:", 1))
            .collect();
        assert_ne!(old, keys);
        assert_eq!(incremental_pages(document.pages(), Some(&old)).0, full);
        assert!(incremental_pages(document.pages(), Some(&keys))
            .0
            .iter()
            .all(Option::is_none));
        let swapped: Vec<_> = keys.iter().rev().cloned().collect();
        assert_eq!(incremental_pages(document.pages(), Some(&swapped)).0, full);
    }

    #[test]
    fn cache_bounds_and_recency() {
        let mut cache = SvgCache::default();
        for key in 0..MAX_PAGES as u128 {
            cache.insert(key, format!("page {key}"));
        }
        assert_eq!(cache.get(0).as_deref(), Some("page 0"));
        cache.insert(MAX_PAGES as u128, "new page".into());
        assert!(cache.get(1).is_none());
        assert!(cache.get(0).is_some());
        cache.insert(0, "replacement".into());
        assert_eq!(
            cache.bytes,
            cache.pages.values().map(String::len).sum::<usize>()
        );
        cache.insert(999, "x".repeat(MAX_BYTES));
        assert_eq!(cache.pages.len(), 1);
        assert_eq!(cache.bytes, MAX_BYTES);
        cache.insert(1000, "x".repeat(MAX_BYTES + 1));
        assert!(cache.get(1000).is_none());
        assert!(cache.get(999).is_some());
    }
}
