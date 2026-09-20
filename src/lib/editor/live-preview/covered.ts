// 「区间是否落在已被块 widget 盖住的格子里」——一个 16 行的二分辅助，**独立成文件是有意的**：
// 标记装饰与公式装饰都要用它，而它跟块级装饰的其余部分（切片 widget、planBlockCovers）毫无关系。
// 放在 block-decorations 里会让那两个模块为它拖进整条块级依赖。
/** 区间是否落在某个"已被块 widget 盖住"的格子里（covered 已按 from 递增且不重叠） */
export function insideCovered(
  from: number,
  to: number,
  covered: readonly { from: number; to: number }[],
): boolean {
  let lo = 0;
  let hi = covered.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = covered[mid];
    if (to <= c.from) hi = mid - 1;
    else if (from >= c.to) lo = mid + 1;
    else return true;
  }
  return false;
}
