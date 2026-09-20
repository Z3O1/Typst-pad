// block-plan 单元测试：块表 → "哪些区间被切片覆盖 / 哪一块展开源码"的决策（纯逻辑，无 DOM）。
//
// 这里锁的是三条硬约束：
//  1. **格子铺满全文且首尾相接**（不然"整篇都被 widget 盖住"会让光标无处可去，或者空行叠出多余空白）；
//  2. **"引擎说这块没有输出"的块（`#set` / `#show` / `#let` / 注释行）整格隐藏**（与 PDF 一致），
//     光标/选区进去才展开；而"块表过期 / 编译失败"那种不可渲染的块**必须永远展开**（不许隐藏）；
//  3. **永远至少有一格是源码形态**（否则用户没法打字）。
import { describe, it, expect } from "vitest";
import { Text } from "@codemirror/state";
import {
  applyBlockSelection,
  carryOverCrops,
  changedSpan,
  crossesCollapsedCover,
  isSafeHref,
  planBlockCovers,
  remapBlocksThroughEdit,
  revealBlocksWithDiagnostics,
  sourceVerticalTarget,
  toBlockTable,
} from "./block-plan";
import type { Block, BlockCover } from "./block-plan";
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
    // 每格盖到**下一块的第一行行首** ⇒ 块与块之间的空行归**上一块**（实测：空行若归下一块，
    // 在行尾按 Enter 后光标正好落在"空行行首 = 上一块切片结尾"，CM 会把光标画到正文列最右边）
    expect(covers[0].coverTo).toBe(5); // 下一块（bbb）的第一行行首
    expect(covers[1].coverFrom).toBe(5); // 上一格的终点 = 这一格的起点（首尾相接）
    expect(covers[1].coverTo).toBe(10); // 再下一块（ccc）的第一行行首
    expect(covers[2].coverFrom).toBe(10);
    expect(covers[2].coverTo).toBe(doc.length); // 末格延伸到文档末尾
    // 每块正文都要被自己的格子完整盖住（空行多出来没关系）
    for (let i = 0; i < covers.length; i++) {
      expect(covers[i].coverFrom).toBeLessThanOrEqual(covers[i].block.from);
      expect(covers[i].coverTo).toBeGreaterThanOrEqual(covers[i].block.to);
    }
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
  /** 三块文档：格子见 planBlockCovers（空行归上一块）→ [0,5) [5,10) [10,14) */
  function three(): { covers: BlockCover[]; doc: string } {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    return { covers: planBlockCovers(table.blocks, Text.of(doc.split("\n"))), doc };
  }

  it("光标在中间块里 → 只有它展开源码（其余两块保持切片）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 6, to: 6 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("光标在块之间的空行里 → 展开**上面**那一块（空行归属上一格）", () => {
    // 实测背景（用户报「用 Enter 拆分块的时候，光标会有问题」）：在行尾按 Enter 后光标正好落在
    // 新空行的行首，而那里同时是**上一块切片的结尾** —— CM 会把光标定位到 widget 自己身上，
    // 画到正文列最右边。空行归上一块之后，光标落在上一格**内部** → 那一格展开源码 → 光标正常。
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 4, to: 4 }], doc.length); // 第 4 位 = 第一格里的空行
    expect(covers.map((c) => c.revealed)).toEqual([true, false, false]);
  });

  it("光标正好落在格子边界 → 只展开后面那一格（否则点段落开头会把上一段也展开）", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 10, to: 10 }], doc.length); // 第 10 位 = 第三块第一行行首（两格共享的边界）
    expect(covers.map((c) => c.revealed)).toEqual([false, false, true]);
  });

  it("光标在文档末尾（末格是闭区间）→ 展开最后一格", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: doc.length, to: doc.length }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, false, true]);
  });

  it("**引擎说这块没有输出**（`#set` / `#show` / `#let`）→ 不展开（写作模式下整格隐藏，见 live-preview）", () => {
    const doc = "aaa\n\n#let x = 1\n\nbbb\n";
    const table = asciiTable(doc, [
      crop(0, 3),
      crop(5, 15, { kind: "Code", found: false, svg: "" }),
      crop(17, 20),
    ]);
    const covers = planBlockCovers(table.blocks, Text.of(doc.split("\n")));
    applyBlockSelection(covers, [{ from: 0, to: 0 }], doc.length);
    // 第二块 noOutput=true → 光标不在里面就不展开（它会由 buildHiddenBlockDecorations 藏掉）
    expect(covers.map((c) => c.noOutput)).toEqual([false, true, false]);
    expect(covers.map((c) => c.revealed)).toEqual([true, false, false]);
    // 光标进去 → 展开成源码，能编辑
    applyBlockSelection(covers, [{ from: 6, to: 6 }], doc.length);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
  });

  it("**块表过期 / 编译失败**那种不可渲染（noOutput=false）仍然永远展开，绝不隐藏用户刚打的字", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const table = asciiTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    // 模拟 remapBlocksThroughEdit 把被改动的那一块标成不可渲染
    const remapped = remapBlocksThroughEdit(table.blocks, table.doc, "aaa\n\nbXb\n\nccc\n");
    const after = "aaa\n\nbXb\n\nccc\n";
    const covers = planBlockCovers(remapped.blocks, Text.of(after.split("\n")));
    applyBlockSelection(covers, [{ from: 0, to: 0 }], after.length);
    const stale = covers.filter((c) => !c.renderable && !c.noOutput);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((c) => c.noOutput === false)).toBe(true);
    // 过期块永远展开（这一条以前由 !renderable 兜着，现在被拆成两种情况，别回退）
    for (const cover of covers) {
      if (!cover.renderable && !cover.noOutput) expect(cover.revealed).toBe(true);
    }
  });

  it("跨块选区：**只盖住一部分**的格子展开源码（高亮才精确）", () => {
    const { covers, doc } = three();
    // 2..11：第一块被切掉尾巴、第三块被切掉头 → 那两块展开，中间那块整块被盖住 → 保持切片
    applyBlockSelection(covers, [{ from: 2, to: 11 }], doc.length);
    expect(covers.map((c) => c.selected)).toEqual([false, true, false]);
    expect(covers.map((c) => c.revealed)).toEqual([true, false, true]);
  });

  it("**整块被选中** → 不展开（保持切片外观），用 selected 标出来（用户要求：选中整个代码块不要展开）", () => {
    const { covers, doc } = three();
    // head=0：光标在第一块里（不是末尾那块）→ 除"光标那块"外都不展开
    applyBlockSelection(covers, [{ from: 0, to: doc.length, head: 0 }], doc.length);
    expect(covers.map((c) => c.selected)).toEqual([true, true, true]);
    expect(covers.map((c) => c.revealed)).toEqual([true, false, false]);
  });

  it("**光标所在的那一块必须展开**（哪怕被整块选中）—— 否则打字会失灵", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 0, to: doc.length, head: 12 }], doc.length);
    // 光标在第三块里 → 它展开（DOM 里得有真实文本，浏览器的输入事件才落得下去）
    expect(covers.map((c) => c.revealed)).toEqual([false, false, true]);
    expect(covers.map((c) => c.selected)).toEqual([true, true, true]);
  });

  it("只整块选中中间那一格：光标在里面 → 它展开；光标不在里面 → 它保持切片", () => {
    const { covers, doc } = three();
    applyBlockSelection(covers, [{ from: 5, to: 8, head: 8 }], doc.length);
    expect(covers.map((c) => c.selected)).toEqual([false, true, false]);
    expect(covers.map((c) => c.revealed)).toEqual([false, true, false]);
    const again = planBlockCovers(
      three().covers[0].block
        ? toBlockTable(doc, [crop(0, 3), crop(5, 8), crop(10, 13)]).blocks
        : [],
      Text.of(doc.split("\n")),
    );
    applyBlockSelection(again, [{ from: 5, to: 8, head: 12 }], doc.length);
    expect(again.map((c) => c.selected)).toEqual([false, true, false]);
    expect(again.map((c) => c.revealed)).toEqual([false, false, true]);
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
    expect(out.blocks.map((b) => b.svg)).toEqual([
      "<svg>aaa</svg>",
      "<svg>bbb</svg>",
      "<svg>ccc</svg>",
    ]);
  });

  it("文本改过的块不沿用（宁可先显示源码，也不显示旧排版）", () => {
    const before = "aaa\n\nbbb\n";
    const prev = table(before, [
      crop(0, 3, { svg: "<svg>aaa</svg>" }),
      crop(5, 8, { svg: "<svg>bbb</svg>" }),
    ]).blocks;
    const after = "aaa\n\nbbbx\n"; // 第二块变了，且本轮没渲
    const next = table(after, [
      crop(0, 3, { svg: "<svg>aaa</svg>" }),
      crop(5, 9, { svg: "" }),
    ]).blocks;
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

describe("竖直移动的判定（写作模式照代码模式走：逐源码行、空行也停、列保留）", () => {
  /** 行：1 `aaa`(0-3) 2 空(4) 3 `bbb`(5-8) 4 空(9) 5 `ccc`(10-13) 6 空(14) */
  const DOC = "aaa\n\nbbb\n\nccc\n";
  /** 格子（空行归上一块）：[0,5) [5,10) [10,14)；光标在 cursor 处 → 那一格展开源码 */
  const coversWith = (cursor: number) => {
    const table = toBlockTable(DOC, [crop(0, 3), crop(5, 8), crop(10, 13)]);
    const c = planBlockCovers(table.blocks, Text.of(DOC.split("\n")));
    applyBlockSelection(c, [{ from: cursor, to: cursor, head: cursor }], DOC.length);
    return c;
  };

  describe("crossesCollapsedCover（这一走要不要接管）", () => {
    it("块内移动（默认结果在同一格）→ 不接管，交回 CodeMirror 的逐行行为", () => {
      expect(crossesCollapsedCover(coversWith(6), 6, 5)).toBe(false);
    });

    it("默认落到段落之间那条空行 → 不接管（代码模式也在这里停一拍）", () => {
      // 光标在第一块（位置 1）里，默认从 3 落到空行 4 —— 空行属**第一块自己的格子**（[0,5)）
      expect(crossesCollapsedCover(coversWith(1), 3, 4)).toBe(false);
      // 站在那条空行上再往上：落到 3 也还在第一格里
      expect(crossesCollapsedCover(coversWith(4), 4, 3)).toBe(false);
    });

    it("站在空行上往下：默认会跳过整个 bbb 那一块 → 接管", () => {
      expect(crossesCollapsedCover(coversWith(4), 4, 5)).toBe(false); // 正好停在下一块开头：不算跨
      expect(crossesCollapsedCover(coversWith(4), 4, 9)).toBe(true); // 跳过整块 bbb
    });

    it("向上跨过未展开的切片 → 接管（「在最后一块按上跳回文档开头」那条）", () => {
      expect(crossesCollapsedCover(coversWith(10), 10, 0)).toBe(true);
    });

    it("原地不动 / 没有格子（源码模式）→ 永不接管", () => {
      expect(crossesCollapsedCover(coversWith(6), 6, 6)).toBe(false);
      expect(crossesCollapsedCover([], 6, 5)).toBe(false);
    });
  });

  describe("sourceVerticalTarget（逐源码行走的落点）", () => {
    const doc = Text.of(DOC.split("\n"));

    it("↓ 走一行：段落之间那条空行也停（不是直接进下一段）", () => {
      expect(sourceVerticalTarget(doc, 1, 1, 1, 1)).toBe(4); // aaa 第 1 列 → 空行（列夹到 0）
    });

    it("站在空行上再 ↓ → 下一块正文的开头", () => {
      expect(sourceVerticalTarget(doc, 4, 1, 1, 0)).toBe(5);
    });

    it("↑ 走一行：第二块行首的上面是那条空行，不是上一块的行尾", () => {
      expect(sourceVerticalTarget(doc, 5, -1, 1, 0)).toBe(4);
    });

    it("列保留，但按目标行长度夹住", () => {
      const two = Text.of(["aaaaa", "bbbbb", ""]);
      expect(sourceVerticalTarget(two, 3, 1, 1, 3)).toBe(9); // 第 4 列 → 下一行第 4 列
      expect(sourceVerticalTarget(two, 9, -1, 1, 3)).toBe(3); // 来回对称
      expect(sourceVerticalTarget(doc, 12, 1, 1, 2)).toBe(14); // 目标行是空行 → 夹到 0 列
      expect(sourceVerticalTarget(doc, 4, -1, 1, 2)).toBe(2); // 目标行 `aaa` 只有 3 列
    });

    it("走一屏的行数（翻页用同一套语义）", () => {
      expect(sourceVerticalTarget(doc, 0, 1, 3, 0)).toBe(9); // 第 1 行 → 第 4 行
    });

    it("到第一/最后一行 → null（交回默认，那里有「落到行首/行尾」的兜底）", () => {
      expect(sourceVerticalTarget(doc, 1, -1, 1, 0)).toBeNull();
      expect(sourceVerticalTarget(doc, 14, 1, 1, 0)).toBeNull();
    });
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

  it("在块之间插入整块：新文本所在的**上面那一块**退回源码，其余原样/平移", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const after = "aaa\n\nXX\n\nbbb\n\nccc\n"; // 在第二块之前插入一整块
    const out = remapBlocksThroughEdit(table(before), before, after);
    expect(out.blocks.length).toBe(3); // 铺满全文的约束：块数不变
    // 新文本落在第一块后面的那些空行上 —— 这些空行属于**第一块**的格子（见 planBlockCovers）→ 第一块退回源码
    expect(out.blocks[0]).toMatchObject({ from: 0, to: 3, found: false, svg: "" });
    // 第二块整体平移，切片照用
    expect(out.blocks[1]).toMatchObject({ from: 5 + 4, found: true, svg: "<svg/>" });
    expect(out.blocks[2].from).toBe(10 + 4);
    expect(out.blocks[2].svg).toBe("<svg/>");
    expect(out.kept).toBe(2);
  });

  it("在段落之间那条空行上打字：空行所属的那一块退回源码（新字不会被它的旧切片盖住）", () => {
    const before = "aaa\n\nbbb\n";
    const after = "aaa\nX\nbbb\n"; // 在空行上打一个字（不改变块结构）
    const out = remapBlocksThroughEdit(table(before), before, after);
    const middle = out.blocks.find((b) => b.found === false);
    expect(middle, "至少要有一块退回源码").toBeTruthy();
    expect(middle!.svg).toBe("");
    expect(out.blocks[0].found).toBe(false); // 空行归上一块 → 放开的是上面那一块
  });

  it("在文末追加：最后一块退回源码（末格的 coverTo 是文末，新字会被它盖住）", () => {
    const before = "aaa\n\nbbb\n";
    const after = "aaa\n\nbbb\n新段落";
    const out = remapBlocksThroughEdit(table(before), before, after);
    expect(out.blocks[out.blocks.length - 1].found).toBe(false);
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

  it("在文档最开头插入：块整体平移；第一块退回源码（新文本落在它的格子里）", () => {
    const before = "aaa\n\nbbb\n\nccc\n";
    const after = "ZZ\naaa\n\nbbb\n\nccc\n";
    const out = remapBlocksThroughEdit(table(before), before, after);
    expect(out.blocks[0]).toMatchObject({ from: 3, found: false, svg: "" });
    expect(out.blocks[1].from).toBe(5 + 3);
    expect(out.blocks[2].from).toBe(10 + 3);
    expect(out.kept).toBe(2);
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
    // 位置 4 是空行 = **第一格**的范围（空行归上一块，见 planBlockCovers）
    const revealed = revealBlocksWithDiagnostics(covers, [{ from: 4, to: 5 }]);
    expect(revealed).toBe(1);
    expect(covers.map((c) => c.revealed)).toEqual([true, false, false]);
  });

  it("已经展开 / 不可渲染的格子不重复计数", () => {
    const covers = setup();
    covers[1].revealed = true;
    expect(revealBlocksWithDiagnostics(covers, [{ from: 6, to: 7 }])).toBe(0);
  });
});

describe("编辑后的增量平移：改动不许落进旧切片里（修「块内 Enter 出问题」）", () => {
  /**
   * 真实形状的块表：文档字面量 + 按顺序列出各块的正文（测试自己按文本定位算出**字节**区间，
   * 不手写偏移、也不依赖夹具文件，所以 CI 里也能跑）。覆盖标题 / 段落 / 列表（项与项之间没有空行）
   * / 跨行的行间公式。
   */
  const DOCS: { name: string; doc: string; pieces: string[] }[] = [
    {
      name: "标题 + 两段",
      doc: "= 标题\n\n第一段。\n\n第二段。\n",
      pieces: ["= 标题", "第一段。", "第二段。"],
    },
    {
      name: "列表（每项一块，项间没有空行）",
      doc: "- 甲\n- 乙\n- 丙\n\n尾段。\n",
      pieces: ["- 甲", "- 乙", "- 丙", "尾段。"],
    },
    {
      name: "跨行的行间公式",
      doc: "前文。\n\n$ a + b \\\n  + c $\n\n后文。\n",
      pieces: ["前文。", "$ a + b \\\n  + c $", "后文。"],
    },
    {
      name: "块前有两个空行",
      doc: "= 标题\n\n\n正文。\n",
      pieces: ["= 标题", "正文。"],
    },
  ];

  /** 按顺序在文档里定位每个块的**字节**区间 */
  const byteRanges = (doc: string, pieces: string[]): [number, number][] => {
    const enc = new TextEncoder();
    let cursor = 0;
    return pieces.map((p) => {
      const at = doc.indexOf(p, cursor);
      expect(at, `文档里应找得到块 ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(0);
      const start = enc.encode(doc.slice(0, at)).length;
      cursor = at + p.length;
      return [start, start + enc.encode(p).length] as [number, number];
    });
  };

  /** 与 +page.svelte 的 remapBlocksForEdit 同款：按前后缀差分平移旧表，再重建格子 */
  const edit = (
    doc: string,
    blocks: Block[],
    pos: number,
    insert: string,
  ): { doc: string; caret: number; covers: BlockCover[] } => {
    const next = doc.slice(0, pos) + insert + doc.slice(pos);
    const caret = pos + insert.length;
    const remap = remapBlocksThroughEdit(blocks, doc, next);
    const covers = planBlockCovers(remap.blocks, Text.of(next.split("\n")));
    applyBlockSelection(covers, [{ from: caret, to: caret }], next.length);
    return { doc: next, caret, covers };
  };

  for (const d of DOCS) {
    it(`${d.name}：任意位置按 Enter（含连按两次 = 插入新块）、任意位置打字都不出问题`, () => {
      const blocks = toBlockTable(
        d.doc,
        byteRanges(d.doc, d.pieces).map(([s, e]) => crop(s, e, { xPt: 58, yPt: 40 })),
      ).blocks;
      let checked = 0;
      for (let pos = 0; pos <= d.doc.length; pos++) {
        for (const insert of ["\n", "\n\n", "字"]) {
          const { doc: next, caret, covers } = edit(d.doc, blocks, pos, insert);
          const span = changedSpan(d.doc, next);
          const newSpan = { from: span.from, to: span.from + insert.length };
          // ① 改动必须落在**已展开**的格子里（用户刚打的字看得见）
          for (const c of covers) {
            if (!c.revealed && newSpan.from < c.coverTo && newSpan.to > c.coverFrom) {
              throw new Error(
                `pos=${pos} 插入 ${JSON.stringify(insert)}：改动落在未展开的格子里 ` +
                  `[${c.coverFrom},${c.coverTo}) 块=[${c.block.from},${c.block.to}) ` +
                  `上下文=${JSON.stringify(next.slice(Math.max(0, pos - 8), pos + 8))}`,
              );
            }
          }
          // ② 格子边界必须落在行首（CM 的块级替换硬要求，错一个字符就会"既插 widget 又留原文"）
          const lineStarts = new Set<number>();
          let off = 0;
          for (const line of next.split("\n")) {
            lineStarts.add(off);
            off += line.length + 1;
          }
          for (const c of covers) {
            if (
              !lineStarts.has(c.coverFrom) ||
              (c.coverTo !== next.length && !lineStarts.has(c.coverTo))
            ) {
              throw new Error(
                `pos=${pos} 插入 ${JSON.stringify(insert)}：格子边界不在行首 [${c.coverFrom},${c.coverTo})`,
              );
            }
          }
          // ③ 不许"重复"：未展开的格子必须把那一块的正文**完整**盖住
          //    （只盖一半的话，那半截既显示在旧切片里、又露成源码）
          for (const c of covers) {
            if (c.revealed || !c.renderable) continue;
            if (c.block.from >= c.coverFrom && c.block.to <= c.coverTo) continue;
            throw new Error(
              `pos=${pos} 插入 ${JSON.stringify(insert)}：块 [${c.block.from},${c.block.to}) 只被格子 ` +
                `[${c.coverFrom},${c.coverTo}) 盖住一部分（会重复显示）`,
            );
          }
          expect(caret).toBeGreaterThanOrEqual(0);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
    });
  }
});

// PR #60 审查第 6 条的附带项：切片里的链接会变成真实的 `<a href>`，前端不该只依赖
// Rust 侧的过滤（文档可能来自任何地方）。白名单与 Rust 同一口径：http / https / mailto，
// 无协议的相对链接放行，`javascript:` / `data:` 这类一律丢掉。
describe("isSafeHref（链接热区的 href 白名单）", () => {
  it("放行 http / https / mailto 与无协议的相对链接", () => {
    for (const href of [
      "https://typst.app/docs",
      "http://example.com/a",
      "HTTPS://EXAMPLE.COM",
      "mailto:a@b.c",
      "#label",
      "sub/page.typ",
      "  https://example.com  ",
    ]) {
      expect(isSafeHref(href), href).toBe(true);
    }
  });

  it("挡掉伪协议与空串", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "",
      "   ",
    ]) {
      expect(isSafeHref(href), href).toBe(false);
    }
  });

  it("toBlockTable 会滤掉不安全的 link", () => {
    const doc = "正文"; // 6 字节（两个 CJK 字符）
    const withLinks: BlockCrop = {
      ...crop(0, 6),
      links: [
        { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, href: "https://ok.example" },
        { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, href: "javascript:alert(1)" },
        { xPt: 0, yPt: 0, widthPt: 1, heightPt: 1, href: "" },
      ],
    };
    const table = toBlockTable(doc, [withLinks]);
    expect(table.blocks[0].links?.map((l) => l.href)).toEqual(["https://ok.example"]);
  });
});

// PR #60 审查第 7 条：后端有意跳过的块（skipped）必须与"缺切片"分开 —— 它照给几何
// （格子边界不变）但不可渲染，保持源码显示。
describe("skipped 的块不可渲染", () => {
  it("found=true 但 svg 为空且 skipped=true → renderable=false（而且不算 noOutput）", () => {
    const table = toBlockTable("正文", [{ ...crop(0, 6), svg: "", skipped: true }, crop(6, 12)]);
    expect(table.blocks[0].skipped).toBe(true);
    const covers = planBlockCovers(table.blocks, Text.of(["正文正文"]));
    const first = covers.find((c) => c.block.from === 0)!;
    expect(first.renderable).toBe(false);
    expect(first.noOutput).toBe(false); // 不是"引擎没画"，是"太大了我们不渲"
  });
});
