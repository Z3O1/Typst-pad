// 编译快照上的稀疏 UTF-8/UTF-16 索引；光标查询只扫描至多一小段，不反复扫描全文。
export function createSourceCoordinates(text: string) {
  const units = [0];
  const bytes = [0];
  const lines = [0];
  let unit = 0,
    byte = 0;
  for (const ch of text) {
    if (unit - units[units.length - 1] >= 256) {
      units.push(unit);
      bytes.push(byte);
    }
    const cp = ch.codePointAt(0)!;
    byte += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    unit += ch.length;
    if (ch === "\n") lines.push(unit);
  }
  const byteLength = byte;

  function checkpoint(values: number[], target: number): number {
    let low = 0,
      high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid] <= target) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  }

  function convert(target: number, fromBytes: boolean): number {
    target = Math.max(0, target);
    if (target >= (fromBytes ? byteLength : text.length))
      return fromBytes ? text.length : byteLength;
    const index = checkpoint(fromBytes ? bytes : units, target);
    let unit = units[index],
      byte = bytes[index];
    while (unit < text.length) {
      const cp = text.codePointAt(unit)!;
      const size = cp > 0xffff ? 2 : 1;
      const length = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (target < (fromBytes ? byte + length : unit + size)) return fromBytes ? unit : byte;
      unit += size;
      byte += length;
    }
    return fromBytes ? unit : byte;
  }

  return {
    toByte: (position: number) => convert(position, false),
    toPosition: (offset: number) => convert(offset, true),
    linePosition: (line: number, column: number) =>
      (lines[Math.max(0, Math.min(line - 1, lines.length - 1))] ?? 0) + column - 1,
  };
}
