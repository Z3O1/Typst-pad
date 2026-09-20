// 字节偏移 ↔ CodeMirror 位置的换算。
//
// **为什么必须有这个模块**：Rust 侧（typst）给出的所有偏移都是 **UTF-8 字节偏移**，
// 而 CodeMirror 的位置是 **UTF-16 码元偏移**（= JavaScript 字符串下标）。中文一个字
// 3 字节 / 1 码元，emoji 4 字节 / 2 码元 —— 把字节偏移直接当位置用会整篇错位。
// （现有的诊断走的是"1-based 行列"，由 CodeMirror 的 line 对象换算，从没碰过字节偏移；
// 块级渲染是第一次需要它，见 docs/文档模式渲染保真-调研.md。）

/** 字符串的 UTF-8 字节长度（与 Rust 的 `str::len()` 同义） */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * 把一批**字节**偏移换算成 **UTF-16 位置**（单遍扫描，O(文本长度)）。
 *
 * - 返回值与入参**同序同长**，可以直接按下标对应回去；
 * - 偏移落在多字节字符中间时向后取到该字符的**起点**（Rust 侧的块边界都是字符边界，
 *   这条只是兜底，保证不抛异常、不返回 NaN）；
 * - 超出文本长度的偏移取文本末尾。
 *
 * 复杂度说明：块边界有几十上百个，但文本只扫一遍 —— 不是"每个偏移扫一遍全文"。
 */
export function byteOffsetsToPositions(text: string, byteOffsets: number[]): number[] {
  const out = new Array<number>(byteOffsets.length).fill(0);
  if (byteOffsets.length === 0) return out;
  // 按下标排序后再扫，保证一趟走完；结果写回原下标
  const order = byteOffsets.map((b, i) => [Math.max(0, b), i] as const).sort((a, b) => a[0] - b[0]);

  let bytes = 0; // 已扫过的 UTF-8 字节数
  let units = 0; // 已扫过的 UTF-16 码元数（= 该字符的起始位置）
  let k = 0;
  for (const ch of text) {
    if (k >= order.length) break;
    const cp = ch.codePointAt(0) ?? 0;
    const cpBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    // 落在**本字符的字节范围内**（含首字节）的目标 → 结算为它的起始位置。
    // 用「字符末字节」比较而不是「下一个字符首字节」：这样 t 落在多字节字符中间时
    // 取到的是它所在那个字符，而不是跳到下一个字符（兜底更保守）。
    const lastByte = bytes + cpBytes - 1;
    while (k < order.length && order[k][0] <= lastByte) {
      out[order[k][1]] = units;
      k++;
    }
    bytes += cpBytes;
    units += ch.length; // UTF-16 码元数（基本平面 1、emoji 2）
  }
  // 越界的目标一律落到文本末尾
  while (k < order.length) {
    out[order[k][1]] = units;
    k++;
  }
  return out;
}

/**
 * `byteOffsetsToPositions` 的反向：把 **UTF-16 位置**换算成 **UTF-8 字节偏移**。
 *
 * 用途：编辑器只知道"视口覆盖了哪些位置"，而 Rust 侧的块级渲染窗口要的是字节偏移
 * （见 compile_blocks 的 wantFrom/wantTo）。
 * 位置落在代理对中间时取该字符的起点（与正向换算对称）；越界取文本末尾。
 */
export function positionsToByteOffsets(text: string, positions: number[]): number[] {
  const out = new Array<number>(positions.length).fill(0);
  if (positions.length === 0) return out;
  const order = positions.map((p, i) => [Math.max(0, p), i] as const).sort((a, b) => a[0] - b[0]);

  let bytes = 0;
  let units = 0;
  let k = 0;
  for (const ch of text) {
    if (k >= order.length) break;
    const cp = ch.codePointAt(0) ?? 0;
    const cpBytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    // 落在本字符的码元范围内（含首码元）的目标 → 结算为它的起始字节
    const lastUnit = units + ch.length - 1;
    while (k < order.length && order[k][0] <= lastUnit) {
      out[order[k][1]] = bytes;
      k++;
    }
    bytes += cpBytes;
    units += ch.length;
  }
  while (k < order.length) {
    out[order[k][1]] = bytes;
    k++;
  }
  return out;
}

/** [from, to) 位置区间 → [字节, 字节]（窗口参数用；两端都向内取整，宁可窗口小一点也不多渲） */
export function positionRangeToByteRange(
  text: string,
  from: number,
  to: number,
): { from: number; to: number } {
  const [start, end] = positionsToByteOffsets(text, [from, to]);
  return { from: Math.min(start, end), to: Math.max(start, end) };
}
