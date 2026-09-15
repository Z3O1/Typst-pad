// block-plan 单元测试：块表 → "哪些区间被切片覆盖 / 哪一块展开源码"的决策（纯逻辑，无 DOM）。
//
// 这里锁的是三条硬约束：
//  1. **格子铺满全文且首尾相接**（不然"整篇都被 widget 盖住"会让光标无处可去，或者空行叠出多余空白）；
//  2. **不可渲染的块（`#let` / `#show` / 注释行）永远保持可见**（源码透镜里它是"代码碎片"）；
//  3. **永远至少有一格是源码形态**（否则用户没法打字）。
import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
  applyBlockSelection,
  carryOverCrops,
  changedSpan,
  planBlockCovers,
  remapBlocksThroughEdit,
  revealBlocksWithDiagnostics,
  toBlockTable,
  verticalBlockTarget,
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
    page: opts.page ?? 1,
    xPt: opts.xPt ?? 58,
    yPt: opts.yPt ?? 0,
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
  it("格子铺满全文、首尾相接，且**落在整行边界**（CM 的块级替换要求整行）", () => {
    // 行：[0,3) aaa / [4,4) 空 / [5,8) bbb / [9,9) 空 / [10,13) ccc / [14,14) 空；doc.length = 14
    const doc = "aaa\n\nbbb\n\nccc\n";
    const text = Text.of(doc.split("\n"));
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    const covers = planBlockCovers(table.blocks, text);
    expect(covers).toHaveLength(3);
    expect(covers[0].coverFrom).toBe(0);
    expect(covers[0].coverTo).toBe(4); // 盖到"块尾那行 + 紧随的空行"的整行边界
    expect(covers[1].coverFrom).toBe(4); // 上一格的终点 = 这一格的起点（首尾相接）
    expect(covers[1].coverTo).toBe(9);
    expect(covers[2].coverFrom).toBe(9);
    expect(covers[2].coverTo).toBe(doc.length); // 末格延伸到文档末尾
    // 每个边界都必须是行首（CM 的块级替换要求整行对齐，否则原文会与 widget 并存）
    const lineStarts = new Set<number>([0]);
    for (let n = 1; n <= text.lines; n++) lineStarts.add(text.line(n).from);
    for (const cover of covers) {
      expect(lineStarts.has(cover.coverFrom)).toBe(true);
      expect(lineStarts.has(cover.coverTo)).toBe(true);
    }
  });

  it("列表为空时没有格子", () => {
    const text = Text.of(["hello"]);
    expect(planBlockCovers(null, text)).toEqual([]);
    expect(planBlockCovers([], text)).toEqual([]);
  });

  it("renderable 的判据是「有 SVG 且有高度」——`#let` 那种没有渲染结果的块不算", () => {
    const doc = "aaa\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3, { found: false, svg: "" }), crop(5, 8)]);
    const covers = planBlockCovers(table.blocks, Text.of(doc.split("\n")));
    expect(covers[0].renderable).toBe(false);
    expect(covers[1].renderable).toBe(true);
  });
});

describe("applyBlockSelection", () => {
  /** 三块文档：每格 = 块自身（位置见断言） */
  function three(): { covers: BlockCover[]; doc: string } {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    // 整行对齐后的格子：[0,4) [4,9) [9,14)
    return { covers: planBlockCovers(table.blocks, Text.of(doc.split("\n"))), doc };
  }

  it("光标在中间块里 → 只有它展开源码（其余两块保持切片）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 6, to: 6 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("光标在块之间的空行里 → 展开**下面**那一块（空行归属后一格）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 4, to: 4 }], doc.length); // 第 4 位 = 第二格行首
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("光标正好落在格子边界 → 只展开后面那一格（否则点段落开头会把上一段也展开）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 9, to: 9 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, false, true]);
  });

  it("光标在文档末尾（末格是闭区间）→ 展开最后一格", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: doc.length, to: doc.length }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, false, true]);
  });

  it("不可渲染的块永远展开（`#let` / `#show` 必须看得见）", () => {
    const doc = "aaa\n\n#let x = 1\n\nbbb\n";
    const table = asciiTable(doc, [
      crop(0, 3),
      crop(5, 15, { kind: "Code", found: false, svg: "" }),
      crop(17, 20),
    ]);
    const covers = planBlockCovers(table.blocks, Text.of(doc.split("\n")));
    applyBlockSelection(covers, [{ from: 0, to: 0 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([true, true, false]);
  });

  it("跨块选区 → 涉及的格子全部展开（多展开永远是安全方向）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 2, to: 11 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([true, true, true]);
  });

  it("永远至少有一格展开源码（不然整篇被切片盖住，光标无处可去）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 999, to: 999 }], doc.length); // 越界选区
    expect(covers.some((c) => c.revealed)).toBe(true);
  });

  it("返回值表示 revealed 是否真的变了（供调用方决定要不要重建装饰）", () => {
    const { covers, doc } = three();
    expect(applyBlockSelection(covers, [{ from: 6, to: 6 }], doc.length)).toBe(true);
    expect(applyBlockSelection(covers, [{ from: 6, to: 6 }], doc.length)).toBe(false);
    expect(applyBlockSelection(covers, [{ from: 12, to: 12 }], doc.length)).toBe(true);
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

describe("verticalBlockTarget（跨块竖直移动：修「按上跳回开头」）", () => {
  const covers = () => {
    const doc = "aaa\n\nbbb\n\nccc\n"; // 格子：[0,4) [4,9) [9,14)
    const table = toBlockTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    return planBlockCovers(table.blocks, Text.of(doc.split("\n")));
  };

  it("块内移动不接管（交回 CodeMirror 的逐行行为）", () => {
    const c = covers();
    // 光标在第 2 格内，默认结果也落在第 2 格 → null
    expect(verticalBlockTarget(c, 6, 5, -1)).toBeNull();
  });

  it("向上跨格 → 落到上一格源码的末尾（不是文档开头）", () => {
    const c = covers();
    // 光标在第 2 格开头（位置 4），默认结果会跑到第 1 格 → 接管，落到第 1 格末尾
    expect(verticalBlockTarget(c, 4, 0, -1)).toBe(3); // covers[0].coverTo - 1
  });

  it("向下跨格 → 落到下一块**正文**的开头（不是格子里那条空行）", () => {
    const c = covers();
    // 格子 [4,9) 里的正文是 bbb[5,8)：往下应当落到 10（第三块正文开头），而不是 coverFrom
    expect(verticalBlockTarget(c, 8, 14, 1)).toBe(10);
  });

  it("从块尾按 ↓ → 一次就进下一段正文（不再先停在段落之间的空行上）", () => {
    const c = covers();
    // 位置 3 = 第一块正文的末尾；CodeMirror 的默认结果会是那条空行（位置 4），
    // 它在第二格的范围里但**不在第二块正文里** → 接管，直接落到 bbb 的开头
    expect(verticalBlockTarget(c, 3, 4, 1)).toBe(5);
    // 光标已经在空行（位置 4）上时，默认结果 5 就是下一段正文的开头 → 不必接管
    expect(verticalBlockTarget(c, 4, 5, 1)).toBeNull();
  });

  it("多行块内逐行移动仍然不接管（块内正文没走完）", () => {
    const doc = "aaa\nline2\nline3\n\nbbb\n";
    const table = toBlockTable(doc, [crop(0, 15), crop(17, 20)]);
    const c = planBlockCovers(table.blocks, Text.of(doc.split("\n")));
    // 光标在第一行，默认结果落到第二行（仍在第一块正文里）→ 不接管
    expect(verticalBlockTarget(c, 0, 4, 1)).toBeNull();
    // 从块尾往下 → 落到下一块正文开头
    expect(verticalBlockTarget(c, 15, 17, 1)).toBe(17);
  });

  it("已经在第一/最后一格 → 不接管（保持默认：不动）", () => {
    const c = covers();
    expect(verticalBlockTarget(c, 1, 0, -1)).toBeNull(); // 第一格再往上
    expect(verticalBlockTarget(c, 12, 14, 1)).toBeNull(); // 最后一格再往下
  });

  it("没有格子（源码模式）→ 永不接管", () => {
    expect(verticalBlockTarget([], 3, 0, -1)).toBeNull();
  });
});

describe("changedSpan / remapBlocksThroughEdit（编译失败时保留没被改到的切片）", () => {
  /** 造一张块表（纯 ASCII：字节偏移 == 位置） */
  const table = (doc: string) =>
    toBlockTable(doc, [
      crop(0, 3, { kind: "Heading", xPt: 58, yPt: 10 }),
      crop(5, 8, { xPt: 58, yPt: 40 }),
      crop(10, 13, { xPt: 58, yPt: 70 }),
    ]).blocks;

  it("changedSpan：中间插入 → 改动段在插入点，delta 为正", () => {
    expect(changedSpan("abcdef", "abcXYdef")).toEqual({ from: 3, to: 3, delta: 2 });
  });

  it("changedSpan：中间删除 → delta 为负", () => {
    expect(changedSpan("abcXYdef", "abcdef")).toEqual({ from: 3, to: 5, delta: -2 });
  });

  it("changedSpan：整体替换", () => {
    expect(changedSpan("abc", "xyz")).toEqual({ from: 0, to: 3, delta: 0 });
  });

  it("changedSpan：代理对不被切开（emoji 前后的共同前缀按整字符算）", () => {
    // "🚀" 是 2 个码元；在后面插入 "!" 时前缀必须停在 emoji 之后，不能切进它中间
    const span = changedSpan("🚀a", "🚀!a");
    expect(span.from).toBe(2);
    expect(span.delta).toBe(1);
  });

  it("在块之间插入：改动段之前的块原样、之后的位置平移、剩下的切片都还在", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const after = "aaa\n\nXX\n\nbbb\n\nccc\n"; // 在第二块之前插入一整块
    const out = remapBlocksThroughEdit(table(before), before, after);
    expect(out.blocks.length).toBe(3); // 铺满全文的约束：块数不变
    expect(out.blocks[0]).toMatchObject({ from: 0, to: 3, svg: "<svg/>" });
    // 后两块整体平移 +4（插入的 "XX\n\n" 的字节长度）
    expect(out.blocks[1].from).toBe(5 + 4);
    expect(out.blocks[2].from).toBe(10 + 4);
    expect(out.kept).toBe(3);
  });

  it("改动落在某一块内部：那一块退回源码（区间放宽），其它块不受影响", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const after = "aaa\n\nbXbb\n\nccc\n"; // 第二块里插入一个字符
    const out = remapBlocksThroughEdit(table(before), before, after);
    const middle = out.blocks[1];
    expect(middle.found).toBe(false);
    expect(middle.svg).toBe("");
    expect(middle.heightPt).toBe(0);
    // 改动段之后的第三块平移 +1，切片照旧
    expect(out.blocks[2]).toMatchObject({ from: 11, to: 14, svg: "<svg/>" });
    expect(out.kept).toBe(2);
    // 放宽之后的区间必须仍然包住**改动段在改动后坐标里的位置**（否则新打的字会被旁边的切片盖住）
    expect(middle.from).toBeLessThanOrEqual(6);
    expect(middle.to).toBeGreaterThanOrEqual(7);
    // 首尾相接、递增不重叠的约束不能破
    for (let i = 1; i < out.blocks.length; i++) {
      expect(out.blocks[i].from).toBeGreaterThanOrEqual(out.blocks[i - 1].from);
    }
  });

  it("在文档最开头插入：所有块平移，切片全保留", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const after = "ZZ\naaa\n\nbbb\n\nccc\n";
    const out = remapBlocksThroughEdit(table(before), before, after);
    expect(out.kept).toBe(3);
    expect(out.blocks[0].from).toBe(3);
  });

  it("文档没变 → 原样返回（不产生新对象数组内容变化）", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const out = remapBlocksThroughEdit(table(before), before, before);
    expect(out.kept).toBe(3);
    expect(out.blocks[0].svg).toBe("<svg/>");
  });

  it("空块表 → 空结果", () => {
    expect(remapBlocksThroughEdit([], "", "x")).toEqual({ blocks: [], kept: 0 });
  });
});

describe("revealBlocksWithDiagnostics（错误位置不许被切片盖住）", () => {
  const setup = () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = toBlockTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    return planBlockCovers(table.blocks, Text.of(doc.split("\n")));
  };

  it("与诊断区间相交的格子被标成展开源码，其它格子不动", () => {
    const covers = setup();
    // 诊断落在第二块里（位置 6）
    const revealed = revealBlocksWithDiagnostics(covers, [{ from: 6, to: 7 }]);
    expect(revealed).toBe(1);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("没有诊断 → 一个都不展开", () => {
    const covers = setup();
    expect(revealBlocksWithDiagnostics(covers, [])).toBe(0);
    expect(covers.every((c) => !c.revealed)).toBe(true);
  });

  it("诊断落在块与块之间的空行上 → 也是被盖住的范围，照样展开（宁可多展开）", () => {
    const covers = setup();
    // 位置 4 是空行 = 第二格的 coverFrom（格子也盖住它）
    const revealed = revealBlocksWithDiagnostics(covers, [{ from: 4, to: 5 }]);
    expect(revealed).toBe(1);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("已经展开 / 不可渲染的格子不重复计数", () => {
    const covers = setup();
    covers[1].revealed = true;
    expect(revealBlocksWithDiagnostics(covers, [{ from: 6, to: 7 }])).toBe(0);
  });
});
