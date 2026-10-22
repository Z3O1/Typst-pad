import { describe, expect, it } from "vitest";
import { createSourceCoordinates } from "./source-coordinates";

describe("编译快照坐标索引", () => {
  it("跨稀疏检查点的每个码元与字节边界对照原生 UTF-8 编码", () => {
    const text = "abc中文😀é\n".repeat(100);
    const index = createSourceCoordinates(text);
    const encoder = new TextEncoder();
    let position = 0;
    let offset = 0;
    for (const char of text) {
      const length = encoder.encode(char).length;
      for (let unit = 0; unit < char.length; unit++) {
        expect(index.toByte(position + unit)).toBe(offset);
      }
      for (let byte = 0; byte < length; byte++) {
        expect(index.toPosition(offset + byte)).toBe(position);
      }
      position += char.length;
      offset += length;
    }
    expect(index.toByte(-1)).toBe(0);
    expect(index.toPosition(-1)).toBe(0);
    expect(index.toByte(text.length)).toBe(encoder.encode(text).length);
    expect(index.toPosition(offset)).toBe(text.length);
    expect(index.toByte(Infinity)).toBe(offset);
    expect(index.toPosition(Infinity)).toBe(text.length);
  });

  it("行列映射与修订隔离，空文档仍可定位插入点", () => {
    const a = createSourceCoordinates("中文\n😀\n");
    const b = createSourceCoordinates("新中文\n😀\n");
    expect(a.linePosition(2, 3)).toBe(5);
    expect(b.linePosition(2, 3)).toBe(6);
    expect(a.toByte(a.linePosition(2, 3))).toBe(11);
    expect(a.linePosition(3, 1)).toBe(6);
    const empty = createSourceCoordinates("");
    expect(empty.toByte(10)).toBe(0);
    expect(empty.toPosition(10)).toBe(0);
    expect(empty.linePosition(1, 1)).toBe(0);
  });
});
