// block-plan 单元测试：块表 → "哪些区间被切片覆盖 / 哪一块展开源码"的决策（纯逻辑，无 DOM）。
//
// 这里锁的是三条硬约束：
//  1. **格子铺满全文且首尾相接**（不然"整篇都被 widget 盖住"会让光标无处可去，或者空行叠出多余空白）；
//  2. **不可渲染的块（`#let` / `#show` / 注释行）永远保持可见**（源码透镜里它是"代码碎片"）；
//  3. **永远至少有一格是源码形态**（否则用户没法打字）。
import { describe, it, expect } from "vitest";
import {
  applyBlockSelection,
  carryOverCrops,
  planBlockCovers,
  toBlockTable,
} from "./block-plan";
import type { BlockCover } from "./block-plan";
import type { BlockCrop } from "./typst-engine";

/** 造一块 Rust 侧的产物：`start`/`end` 是**字节**偏移 */
function crop(start: number, end: number, opts: Partial<BlockCrop> = {}): BlockCrop {
  return {
    start,
    end,
    kind: opts.kind ?? "Paragraph",
    found: opts.found ?? true,
    pages: 1,
    yPt: 0,
    widthPt: 371,
    heightPt: opts.heightPt ?? 20,
    bands: 1,
    svg: opts.svg ?? "<svg/>",
  };
}

/** 纯 ASCII 文档里的块：字节偏移 == 位置，省去换算噪音 */
function asciiTable(doc: string, blocks: BlockCrop[]) {
  return toBlockTable(doc, blocks);
}

describe("toBlockTable", () => {
  it("把字节偏移换算成 CodeMirror 位置（中文文档）", () => {
    // "标题\n\n正文。" —— 字节：标(0-3) 题(3-6) \n(6) \n(7) 正(8-11) 文(11-14) 。(14-17)
    // 位置（UTF-16）：标(0) 题(1) \n(2) \n(3) 正(4) 文(5) 。(6)
    const doc = "标题\n\n正文。";
    const table = toBlockTable(doc, [crop(0, 6, { kind: "Heading" }), crop(8, 14)]);
    expect(table.blocks).toHaveLength(2);
    expect(table.blocks[0]).toMatchObject({ from: 0, to: 2, kind: "Heading" });
    expect(table.blocks[1]).toMatchObject({ from: 4, to: 6 });
  });

  it("越界 / 空块直接丢掉（编译期间文档又改了时的兜底）", () => {
    const doc = "abc";
    const table = toBlockTable(doc, [crop(0, 3), crop(2, 2), crop(1, 99)]);
    expect(table.blocks).toHaveLength(1);
    expect(table.blocks[0]).toMatchObject({ from: 0, to: 3 });
  });

  it("反序的块也丢掉（必须递增不重叠，否则装饰会抛重叠替换错误）", () => {
    const doc = "abcdefgh";
    const table = toBlockTable(doc, [crop(4, 8), crop(0, 4)]);
    expect(table.blocks).toHaveLength(1);
    expect(table.blocks[0]).toMatchObject({ from: 4, to: 8 });
  });
});

describe("planBlockCovers", () => {
  it("格子首尾相接铺满全文（首格起 0、末格到文档末尾）", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    const covers = planBlockCovers(table.blocks, doc.length);
    expect(covers).toHaveLength(3);
    expect(covers[0].coverFrom).toBe(0);
    expect(covers[0].coverTo).toBe(3);
    expect(covers[1].coverFrom).toBe(3); // 上一块的终点 = 这一格的起点（吃掉中间的空行）
    expect(covers[1].coverTo).toBe(8);
    expect(covers[2].coverFrom).toBe(8);
    expect(covers[2].coverTo).toBe(doc.length); // 末格延伸到文档末尾
  });

  it("列表为空时没有格子", () => {
    expect(planBlockCovers(null, 10)).toEqual([]);
    expect(planBlockCovers([], 10)).toEqual([]);
  });

  it("renderable 的判据是「有 SVG 且有高度」——`#let` 那种没有渲染结果的块不算", () => {
    const doc = "aaa\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3, { found: false, svg: "" }), crop(5, 8)]);
    const covers = planBlockCovers(table.blocks, doc.length);
    expect(covers[0].renderable).toBe(false);
    expect(covers[1].renderable).toBe(true);
  });
});

describe("applyBlockSelection", () => {
  /** 三块文档：每格 = 块自身（位置见断言） */
  function three(): { covers: BlockCover[]; doc: string } {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    return { covers: planBlockCovers(table.blocks, doc.length), doc };
  }

  it("光标在中间块里 → 只有它展开源码（其余两块保持切片）", () => {
    const { covers } = three();
    applyBlockSelection(covers, [{ from: 6, to: 6 }]);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("光标在块之间的空行里 → 展开**下面**那一块（空行归属后一格）", () => {
    const { covers } = three();
    applyBlockSelection(covers, [{ from: 4, to: 4 }]); // 第 4 位落在第一格尾部（块 0 的终点之后）
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("不可渲染的块永远展开（`#let` / `#show` 必须看得见）", () => {
    const doc = "aaa\n\n#let x = 1\n\nbbb\n";
    const table = asciiTable(doc, [
      crop(0, 3),
      crop(5, 15, { kind: "Code", found: false, svg: "" }),
      crop(17, 20),
    ]);
    const covers = planBlockCovers(table.blocks, doc.length);
    applyBlockSelection(covers, [{ from: 0, to: 0 }]);
    expect(covers.map((c) => c.revealed)).toEqual([true, true, false]);
  });

  it("跨块选区 → 涉及的格子全部展开（多展开永远是安全方向）", () => {
    const { covers } = three();
    applyBlockSelection(covers, [{ from: 2, to: 11 }]);
    expect(covers.map((c) => c.revealed)).toEqual([true, true, true]);
  });

  it("永远至少有一格展开源码（不然整篇被切片盖住，光标无处可去）", () => {
    const { covers } = three();
    applyBlockSelection(covers, [{ from: 999, to: 999 }]); // 越界选区
    expect(covers.some((c) => c.revealed)).toBe(true);
  });

  it("返回值表示 revealed 是否真的变了（供调用方决定要不要重建装饰）", () => {
    const { covers } = three();
    expect(applyBlockSelection(covers, [{ from: 6, to: 6 }])).toBe(true);
    expect(applyBlockSelection(covers, [{ from: 6, to: 6 }])).toBe(false);
    expect(applyBlockSelection(covers, [{ from: 12, to: 12 }])).toBe(true);
  });

  it("没有块时返回空、不抛异常", () => {
    expect(applyBlockSelection([], [{ from: 0, to: 0 }])).toBe(false);
  });
});

describe("carryOverCrops（窗口化：窗口外的块沿用上一轮切片）", () => {
  const table = (doc: string, blocks: BlockCrop[]) => toBlockTable(doc, blocks);

  it("块文本没变 → 沿用上一轮的 SVG；文本变了 → 不沿用（显示源码等下一轮）", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const prev = table(doc, [
      crop(0, 3, { svg: "<svg>aaa</svg>" }),
      crop(5, 8, { svg: "<svg>bbb</svg>" }),
      crop(10, 13, { svg: "<svg>ccc</svg>" }),
    ]).blocks;
    // 本轮只渲了第一块（窗口内），后两块 svg 为空
    const next = table(doc, [
      crop(0, 3, { svg: "<svg>aaa</svg>" }),
      crop(5, 8, { svg: "" }),
      crop(10, 13, { svg: "" }),
    ]).blocks;
    const out = carryOverCrops(prev, next, doc);
    expect(out.carried).toBe(2);
    expect(out.missing).toBe(0);
    expect(out.blocks.map((b) => b.svg)).toEqual(["<svg>aaa</svg>", "<svg>bbb</svg>", "<svg>ccc</svg>"]);
  });

  it("文本改过的块不沿用（宁可先显示源码，也不显示旧排版）", () => {
    const before = "aaa\n\nbbb\n";
    const prev = table(before, [crop(0, 3, { svg: "<svg>aaa</svg>" }), crop(5, 8, { svg: "<svg>bbb</svg>" })]).blocks;
    const after = "aaa\n\nbbbx\n"; // 第二块变了，且本轮没渲
    const next = table(after, [crop(0, 3, { svg: "<svg>aaa</svg>" }), crop(5, 9, { svg: "" })]).blocks;
    const out = carryOverCrops(prev, next, after);
    expect(out.carried).toBe(0);
    expect(out.missing).toBe(1);
  });

  it("没有上一轮（首次渲染）时不沿用，全部算 missing", () => {
    const doc = "aaa\n";
    const next = table(doc, [crop(0, 3, { svg: "" })]).blocks;
    const out = carryOverCrops(null, next, doc);
    expect(out.carried).toBe(0);
    expect(out.missing).toBe(1);
  });
});
