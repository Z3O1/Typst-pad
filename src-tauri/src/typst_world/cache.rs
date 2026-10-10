// 小容量 LRU / 帧摘要 FIFO 共用的有界缓存；不持有编译世界或几何。
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

pub(super) struct BoundedCache<K, V> {
    entries: HashMap<K, (V, usize)>,
    order: VecDeque<K>,
    weight: usize,
    max_items: usize,
    max_weight: usize,
}

impl<K: Eq + Hash + Clone, V> BoundedCache<K, V> {
    pub(super) fn new(max_items: usize, max_weight: usize) -> Self {
        assert!(max_items > 0);
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            weight: 0,
            max_items,
            max_weight,
        }
    }

    // FIFO 查询不维护队列，供数千个帧摘要使用，避免每次命中线性扫描。
    pub(super) fn peek(&self, key: &K) -> Option<&V> {
        self.entries.get(key).map(|(value, _)| value)
    }

    pub(super) fn get(&mut self, key: &K) -> Option<&V> {
        if !self.entries.contains_key(key) {
            return None;
        }
        if self.order.back() != Some(key) {
            self.order.retain(|entry| entry != key);
            self.order.push_back(key.clone());
        }
        self.peek(key)
    }

    pub(super) fn insert(&mut self, key: K, value: V, weight: usize) {
        if let Some((_, old_weight)) = self.entries.remove(&key) {
            self.weight -= old_weight;
            self.order.retain(|entry| entry != &key);
        }
        if weight > self.max_weight {
            return;
        }
        // 先淘汰再加权，max_weight=usize::MAX 时也不溢出。
        while self.entries.len() >= self.max_items || weight > self.max_weight - self.weight {
            let oldest = self.order.pop_front().expect("非空缓存必须有淘汰顺序");
            let (_, old_weight) = self.entries.remove(&oldest).unwrap();
            self.weight -= old_weight;
        }
        self.weight += weight;
        self.order.push_back(key.clone());
        self.entries.insert(key, (value, weight));
    }

    #[cfg(test)]
    pub(super) fn usage(&self) -> (usize, usize) {
        (self.entries.len(), self.weight)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recency_weight_and_oversized_replacement() {
        let mut cache = BoundedCache::new(2, 5);
        cache.insert(1, "a", 2);
        cache.insert(2, "b", 2);
        assert_eq!(cache.get(&1), Some(&"a"));
        cache.insert(3, "c", 3);
        assert!(cache.peek(&2).is_none());
        assert_eq!(cache.usage(), (2, 5));
        cache.insert(1, "too large", 6);
        assert!(cache.peek(&1).is_none());
        assert_eq!(cache.usage(), (1, 3));
        cache.insert(3, "replacement", 1);
        assert_eq!(cache.usage(), (1, 1));
    }

    #[test]
    fn fifo_peek_and_weight_overflow_boundary() {
        let mut cache = BoundedCache::new(2, usize::MAX);
        cache.insert(1, "first", usize::MAX);
        assert_eq!(cache.peek(&1), Some(&"first"));
        cache.insert(2, "second", 1);
        assert!(cache.peek(&1).is_none());
        cache.insert(3, "third", 0);
        cache.peek(&2);
        cache.insert(4, "fourth", 0);
        assert!(cache.peek(&2).is_none());
        assert_eq!(cache.usage(), (2, 0));
    }
}
