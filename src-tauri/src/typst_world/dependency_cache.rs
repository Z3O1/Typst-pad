// 只复用已重新读盘并逐字节确认相同的依赖语法快照；不缓存路径、权限或读取结果。
use super::cache::BoundedCache;
use super::*;

type Key = (Option<PathBuf>, FileId);
type Snapshots = Mutex<BoundedCache<Key, Source>>;

/// 调用者必须先执行本轮路径/包解析和完整 read_to_string；失败不得查询此缓存。
/// 最多 8 份、2 MiB UTF-8 正文（不是 AST/RSS 上限），与主源预算相互独立。
pub(super) fn validated_dependency_source(text: String, root: Option<&Path>, id: FileId) -> Source {
    static SOURCES: OnceLock<Snapshots> = OnceLock::new();
    let cache = SOURCES.get_or_init(|| Mutex::new(BoundedCache::new(8, 2 * 1024 * 1024)));
    reuse_validated_source(cache, text, root, id)
}

fn reuse_validated_source(
    cache: &Snapshots,
    text: String,
    root: Option<&Path>,
    id: FileId,
) -> Source {
    let key = (root.map(Path::to_path_buf), id);
    if let Some(source) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .filter(|source| source.text() == text)
        .cloned()
    {
        return source;
    }
    // 不增量修改磁盘依赖：内容变化时完整解析，旧 World/Source 的不可变快照不动。
    // 解析不占缓存锁；并行迟到插入只影响命中率，每次仍核对实际读取的正文。
    let source = Source::new(id, text);
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

    #[test]
    fn validated_snapshots_reuse_only_identical_text_and_evict_deterministically() {
        let cache = Mutex::new(BoundedCache::new(2, 8));
        let id = Source::detached("").id();
        let load = |text: &str, root: &str| {
            reuse_validated_source(&cache, text.into(), Some(Path::new(root)), id)
        };
        let old = load("中文", "a");
        assert!(std::ptr::eq(old.root(), load("中文", "a").root()));
        let changed = load("中😀", "a");
        assert_eq!(old.text(), "中文");
        assert_eq!(changed.text(), "中😀");
        assert_eq!(
            typst::utils::hash128(&changed),
            typst::utils::hash128(&Source::new(id, "中😀".into()))
        );
        let other_root = load("中😀", "b");
        assert!(!std::ptr::eq(changed.root(), other_root.root()));
        assert_eq!(cache.lock().unwrap().usage(), (1, 7));
        assert!(!std::ptr::eq(changed.root(), load("中😀", "a").root()));
        let oversized = load("超出正文预算", "a");
        assert_eq!(cache.lock().unwrap().usage(), (0, 0));
        assert!(!std::ptr::eq(
            oversized.root(),
            load("超出正文预算", "a").root()
        ));
        assert_eq!(old.text(), "中文");
    }
}
