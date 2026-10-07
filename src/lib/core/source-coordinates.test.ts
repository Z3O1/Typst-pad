import { describe, expect, it } from "vitest";
import { byteOffsetsToPositions, positionsToByteOffsets, utf8Length } from "./block-offsets";
import { createSourceCoordinates } from "./source-coordinates";

describe("编译快照坐标索引", () => {
  it("跨稀疏检查点与多字节边界的双向查询等价于原有换算", () => {
    const text = "abc中文😀é\n".repeat(100);
    const index = createSourceCoordinates(text);
    const positions = Array.from({ length: text.length + 2 }, (_, i) => i - 1);
    const offsets = Array.from({ length: utf8Length(text) + 2 }, (_, i) => i - 1);
    expect(positions.map(index.toByte)).toEqual(positionsToByteOffsets(text, positions));
    expect(offsets.map(index.toPosition)).toEqual(byteOffsetsToPositions(text, offsets));
    expect(index.toByte(Infinity)).toBe(utf8Length(text));
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
