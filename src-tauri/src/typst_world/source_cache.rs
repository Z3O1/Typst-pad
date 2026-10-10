// 只缓存主源语法快照；相对依赖每轮 World 重新读盘，绝不缓存几何或写回源文件。
// 用字符边界安全的 diff 调 Source.edit：0.15.1 的 Source.replace 扩大非边界公共尾缀，
// 如「页」→「段」可能保留旧字，「吃」→「😃」可能越界，不能用于编辑器原文。
use super::cache::BoundedCache;
use super::*;

type Key = (Option<PathBuf>, FileId);
const MAX_SOURCES: usize = 8;
// UTF-8 正文预算，不是 AST / 进程 RSS 的内存上限。
const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
static SOURCES: OnceLock<Mutex<BoundedCache<Key, Source>>> = OnceLock::new();

fn update_source(source: &mut Source, text: &str) {
    let old = source.text();
    if old == text {
        return;
    }
    let prefix: usize = old
        .chars()
        .zip(text.chars())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum();
    // 只扫描剩余部分，避免首尾重叠；按字符相等累计 UTF-8 字节数，不拆开共享尾字节。
    let suffix: usize = old[prefix..]
        .chars()
        .rev()
        .zip(text[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(ch, _)| ch.len_utf8())
        .sum();
    let range = prefix..old.len() - suffix;
    source.edit(range, &text[prefix..text.len() - suffix]);
    debug_assert_eq!(source.text(), text);
}

pub(super) fn cached_main_source(text: String, root: Option<&Path>, id: FileId) -> Source {
    let key = (root.map(Path::to_path_buf), id);
    let cache =
        SOURCES.get_or_init(|| Mutex::new(BoundedCache::new(MAX_SOURCES, MAX_SOURCE_BYTES)));
    let previous = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .cloned();
    // Typst 的 Source.clone + edit 使用 COW；旧 World 仍持有自己的不可变修订。
    // diff / 增量解析不占缓存锁，迟到的插入最多影响命中率，不会改变返回值。
    let source = match previous {
        Some(mut source) => {
            update_source(&mut source, &text);
            source
        }
        None => Source::new(id, text),
    };
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(
        key,
        source.clone(),
        source.text().len(),
    );
    source
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syntax_ranges(source: &Source) -> Vec<(SyntaxKind, std::ops::Range<usize>)> {
        fn collect(node: LinkedNode<'_>, out: &mut Vec<(SyntaxKind, std::ops::Range<usize>)>) {
            out.push((node.kind(), node.range()));
            for child in node.children() {
                collect(child, out);
            }
        }
        let mut out = Vec::new();
        collect(LinkedNode::new(source.root()), &mut out);
        out
    }

    #[test]
    fn unicode_edits_preserve_old_world_and_match_fresh_parse() {
        let id = RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("snapshot-test.typ").unwrap(),
        )
        .intern();
        let original = "#let square(x) = x*x\n中文😀 $square(2)$\n第二段";
        let old = cached_main_source(original.into(), None, id);
        let old_ranges = syntax_ranges(&old);
        for text in [
            "#let square(x) = x*x\n中文测😀 $square(2)$\n第二段",
            "#let square(x) = x*x\n\n新段落\n中文😀 $square(2)$\n第二段",
            "#let square(x) =\n中文😀 $square(2)$",
            original,
        ] {
            let current = cached_main_source(text.into(), None, id);
            assert_eq!(current.text(), text);
            assert_eq!(
                syntax_ranges(&current),
                syntax_ranges(&Source::new(id, text.into()))
            );
            assert_eq!(old.text(), original);
            assert_eq!(syntax_ranges(&old), old_ranges);
            fn check(node: LinkedNode<'_>, source: &Source) {
                assert_eq!(source.find(node.span()).unwrap().range(), node.range());
                for child in node.children() {
                    check(child, source);
                }
            }
            check(LinkedNode::new(current.root()), &current);
        }
    }

    #[test]
    fn utf8_shared_tail_bytes_do_not_preserve_old_characters_or_panic() {
        let mut source = Source::detached("第二页");
        for text in [
            "第二段",
            "吃",
            "😃",
            "吃😃\r\n页",
            "吃😃\r\n段",
            "",
            "前缀😀页",
            "前缀😀段",
        ] {
            let old = source.clone();
            let old_text = old.text().to_owned();
            update_source(&mut source, text);
            assert_eq!(source.text(), text);
            assert_eq!(source.root().full_text().as_str(), text);
            assert_eq!(
                syntax_ranges(&source),
                syntax_ranges(&Source::new(source.id(), text.into()))
            );
            assert_eq!(old.text(), old_text);
        }
    }

    #[test]
    fn source_budget_evicts_without_invalidating_held_snapshot() {
        let id = Source::detached("").id();
        let mut cache = BoundedCache::new(2, 5);
        let held = Source::new(id, "旧".into());
        cache.insert(0, held.clone(), held.text().len());
        assert_eq!(cache.usage(), (1, 3));
        cache.insert(1, Source::new(id, "a".into()), 1);
        cache.insert(2, Source::new(id, "b".into()), 1);
        cache.insert(3, Source::new(id, "c".into()), 1);
        assert!(cache.peek(&1).is_none());
        assert_eq!(held.text(), "旧");
        assert_eq!(cache.usage(), (2, 2));
    }
}
