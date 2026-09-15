// block-offsets 单元测试：字节偏移 → CodeMirror 位置（UTF-16）的换算。
//
// 这是块级渲染里最容易静默出错的一环：中文一个字 3 字节 / 1 码元，emoji 4 字节 / 2 码元，
// 一旦按字节当位置用，整篇的块边界都会错位（而且不会报错，只是"渲染得莫名其妙"）。
import { describe, it, expect } from "vitest";
import {
  byteOffsetsToPositions,
  positionRangeToByteRange,
  positionsToByteOffsets,
  utf8Length,
} from "./block-offsets";

describe("utf8Length", () => {
  it("ASCII 一字节一个", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("")).toBe(0);
  });

  it("中文按 3 字节算（与 Rust 的 str::len() 一致）", () => {
    expect(utf8Length("标题")).toBe(6);
    expect(utf8Length("a标题b")).toBe(1 + 6 + 1);
  });

  it("emoji 按 4 字节算（代理对是两个码元）", () => {
    expect(utf8Length("😀")).toBe(4);
    expect("😀".length).toBe(2); // UTF-16 码元数 —— 两者的区别正是本模块存在的理由
  });
});

describe("byteOffsetsToPositions", () => {
  it("纯 ASCII：字节偏移就是位置", () => {
    const text = "hello world";
    expect(byteOffsetsToPositions(text, [0, 5, 11])).toEqual([0, 5, 11]);
  });

  it("中文文档：字节偏移要换算成码元偏移", () => {
    // "标题\n正文" —— 字节：标(0-3) 题(3-6) \n(6) 正(7-10) 文(10-13)
    const text = "标题\n正文";
    expect(byteOffsetsToPositions(text, [0, 3, 6, 7, 10, 13])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("emoji：一个字符占 4 字节 / 2 码元", () => {
    const text = "a😀b";
    // 字节：a(0) 😀(1-5) b(5)
    expect(byteOffsetsToPositions(text, [0, 1, 5, 6])).toEqual([0, 1, 3, 4]);
  });

  it("与入参同序同长（乱序传入也能按下标对应回去）", () => {
    const text = "标题";
    expect(byteOffsetsToPositions(text, [6, 0, 3])).toEqual([2, 0, 1]);
  });

  it("越界偏移取文本末尾；负数按 0 处理（不抛异常、不返回 NaN）", () => {
    const text = "标题";
    expect(byteOffsetsToPositions(text, [-5, 999])).toEqual([0, 2]);
  });

  it("落在多字节字符中间的偏移向后取到字符起点（兜底，不抛异常）", () => {
    const text = "标题"; // 标 = 字节 0..3
    expect(byteOffsetsToPositions(text, [1, 2])).toEqual([0, 0]);
  });

  it("空输入返回空数组", () => {
    expect(byteOffsetsToPositions("abc", [])).toEqual([]);
  });
});

describe("positionsToByteOffsets（反向换算：视口窗口要用）", () => {
  it("中文文档：位置 → 字节", () => {
    const text = "标题\n正文";
    expect(positionsToByteOffsets(text, [0, 1, 2, 3, 4, 5])).toEqual([0, 3, 6, 7, 10, 13]);
  });

  it("emoji：两个码元 → 4 字节", () => {
    const text = "a😀b";
    expect(positionsToByteOffsets(text, [0, 1, 3, 4])).toEqual([0, 1, 5, 6]);
  });

  it("越界位置取文本末尾；与正向换算互为逆运算", () => {
    const text = "标题\n正文段落。";
    const positions = [0, 2, 3, 5, 8, 999];
    const bytes = positionsToByteOffsets(text, positions);
    expect(byteOffsetsToPositions(text, bytes)).toEqual([0, 2, 3, 5, 8, text.length]);
  });

  it("空输入返回空数组", () => {
    expect(positionsToByteOffsets("abc", [])).toEqual([]);
  });
});

describe("positionRangeToByteRange", () => {
  it("把视口位置区间换算成字节区间（顺序颠倒也能兜住）", () => {
    const text = "标题\n正文";
    expect(positionRangeToByteRange(text, 1, 4)).toEqual({ from: 3, to: 10 });
    expect(positionRangeToByteRange(text, 4, 1)).toEqual({ from: 3, to: 10 });
  });
});
