// 块表派生状态的落地单元测试。
//
// 把三条"改起来很容易踩回去"的规则钉住：
//  ① 编译成功：换新块表、`exact` 打开、带上这次的几何编号与字号；
//  ② 编译失败：**只把被改动的那块退回源码**（其余原样平移），`exact` 关掉，几何编号不动；
//  ③ 编辑期间也要平移（`remapBlocksOnEdit`），没有块表或文档没变则什么都不做。
// 外加窗口换算（短文档全渲、长文档留预取、取不到视口从开头起）。
import { describe, it, expect } from "vitest";
import {
  BLOCK_WINDOW_MARGIN,
  blockWindowBytes,
  landBlocksResult,
  remapBlocksOnEdit,
  sameStamp,
  stampKey,
  type BlocksSnapshot,
} from "./block-state";
import { toBlockTable } from "./block-plan";
import type { Block } from "./block-plan";
import type { BlockCrop, BlocksFail, BlocksOk } from "./typst-engine";

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

function okResult(doc: string, blocks: BlockCrop[], over: Partial<BlocksOk> = {}): BlocksOk {
  return {
    ok: true,
    unavailable: false,
    blocks,
    pageCount: 1,
    pageWidthPt: 371.25,
    textPt: 11,
    geometryId: 7,
    ...over,
  };
}

const failResult = (errors: BlocksFail["errors"] = []): BlocksFail => ({
  ok: false,
  unavailable: false,
  error: "第 1 行有错误",
  errors,
});

/** 空快照（还没有任何块表） */
function emptySnap(over: Partial<BlocksSnapshot> = {}): BlocksSnapshot {
  return { blocks: null, doc: "", geometryId: 0, textPt: 11, ...over };
}

describe("landBlocksResult：编译成功", () => {
  it("换新块表：位置换算 + exact 打开 + 几何编号与字号跟上", () => {
    const doc = "标题\n\n正文。";
    const patch = landBlocksResult(
      emptySnap(),
      doc,
      okResult(doc, [crop(0, 6, { kind: "Heading" }), crop(8, 14)], {
        geometryId: 12,
        textPt: 12.5,
      }),
    );
    expect(patch.blocks?.map((b) => [b.from, b.to])).toEqual([
      [0, 2],
      [4, 6],
    ]);
    expect(patch.doc).toBe(doc);
    expect(patch.exact).toBe(true);
    expect(patch.geometryId).toBe(12);
    expect(patch.textPt).toBe(12.5);
    expect(patch.log).toBe("blocks ok blocks:2 页宽:371.3pt");
    expect(patch.detail).toBeNull();
  });

  it("后端没给字号（0）→ 保持上一次量到的值，别打回默认", () => {
    const doc = "abc";
    const patch = landBlocksResult(
      emptySnap({ textPt: 11.7 }),
      doc,
      okResult(doc, [crop(0, 3)], { textPt: 0 }),
    );
    expect(patch.textPt).toBe(11.7);
  });

  it("字号只差 0.01pt 以内 → 视为噪声，不更新（免得白触发一次重排）", () => {
    const doc = "abc";
    const patch = landBlocksResult(
      emptySnap({ textPt: 11 }),
      doc,
      okResult(doc, [crop(0, 3)], { textPt: 11.005 }),
    );
    expect(patch.textPt).toBe(11);
  });

  it("窗口外的块按「类型 + 源码文本」沿用上一轮切片，并给出统计日志", () => {
    const doc = "段落一\n\n段落二";
    const prevTable = toBlockTable(doc, [crop(0, 9), crop(11, 20, { svg: "<svg id='2'/>" })]);
    // 这一轮只渲了第一块（第二块在窗口外 → 没有 svg）
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc }),
      doc,
      okResult(doc, [crop(0, 9), crop(11, 20, { svg: "" })]),
    );
    expect(patch.blocks?.[1].svg).toBe("<svg id='2'/>");
    expect(patch.detail).toBe("切片窗口：新渲 1 / 沿用 1 / 待渲 0");
  });

  it("沿用来的块**标 stale**（精确命中关掉、滚到附近要补渲）（报告 T2 / A4）", () => {
    const doc = "段落一\n\n段落二";
    const prevTable = toBlockTable(doc, [crop(0, 9), crop(11, 20, { svg: "<svg id='2'/>" })]);
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc }),
      doc,
      okResult(doc, [crop(0, 9), crop(11, 20, { svg: "" })]),
    );
    expect(patch.blocks?.[0].stale).toBeUndefined(); // 这一轮新渲的：新鲜
    expect(patch.blocks?.[1].stale).toBe(true); // 沿用来的：旧图
  });

  it("**排版输入变了就不许沿用**（版心宽/字体/前缀变过 → 旧图配新几何比缺图更坏）", () => {
    const doc = "段落一\n\n段落二";
    const prevTable = toBlockTable(doc, [crop(0, 9), crop(11, 20, { svg: "<svg id='2'/>" })]);
    const prevStamp = { sessionId: 1, documentRevision: 3, contextRevision: 1, layoutRevision: 1 };
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc, stamp: prevStamp }),
      doc,
      okResult(doc, [crop(0, 9), crop(11, 20, { svg: "" })]),
      { ...prevStamp, layoutRevision: 2 }, // 版心宽改过
    );
    // 不许沿用 → 第二块保持"缺切片"（等下一轮真渲），而不是拿旧图顶上
    expect(patch.blocks?.[1].svg).toBe("");
    expect(patch.detail).toBe("切片窗口：新渲 1 / 沿用 0 / 待渲 1");
  });

  it("同一套排版输入（只有文档变了）→ 沿用照旧开", () => {
    const doc = "段落一\n\n段落二";
    const prevTable = toBlockTable(doc, [crop(0, 9), crop(11, 20, { svg: "<svg id='2'/>" })]);
    const prevStamp = { sessionId: 1, documentRevision: 3, contextRevision: 1, layoutRevision: 1 };
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc, stamp: prevStamp }),
      doc,
      okResult(doc, [crop(0, 9), crop(11, 20, { svg: "" })]),
      { ...prevStamp, documentRevision: 4 },
    );
    expect(patch.blocks?.[1].svg).toBe("<svg id='2'/>");
  });

  it("没有任何沿用/待渲时不写统计日志（少一行噪音）", () => {
    const doc = "abc";
    const patch = landBlocksResult(emptySnap(), doc, okResult(doc, [crop(0, 3)]));
    expect(patch.detail).toBeNull();
  });
});

describe("RenderStamp：戳的比较与去重键", () => {
  it("四个修订号全同才算同戳；缺省（undefined）按全零戳处理", () => {
    const a = { sessionId: 1, documentRevision: 2, contextRevision: 3, layoutRevision: 4 };
    expect(sameStamp(a, { ...a })).toBe(true);
    expect(sameStamp(a, { ...a, layoutRevision: 5 })).toBe(false);
    expect(sameStamp(undefined, undefined)).toBe(true);
    expect(sameStamp(a, undefined)).toBe(false);
  });

  it("补渲去重键**必须带戳**：同一窗口的新 revision 是一次新请求", () => {
    const stamp = { sessionId: 1, documentRevision: 2, contextRevision: 0, layoutRevision: 0 };
    const w = { from: 10, to: 20 };
    expect(stampKey(stamp, w)).not.toBe(stampKey({ ...stamp, documentRevision: 3 }, w));
    expect(stampKey(stamp, w)).not.toBe(stampKey({ ...stamp, layoutRevision: 1 }, w));
    expect(stampKey(stamp, w)).toBe(stampKey(stamp, { from: 10, to: 20 }));
    expect(stampKey(stamp, null)).toContain("all");
  });
});

describe("landBlocksResult：编译失败", () => {
  it("失败时平移来的块也标 stale（旧图 + 新坐标，精确命中必须关）", () => {
    const before = "段落一\n\n段落二";
    const after = "段落一改了\n\n段落二";
    const prevTable = toBlockTable(before, [crop(0, 9), crop(11, 20)]);
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc: before, geometryId: 3 }),
      after,
      failResult(),
    );
    expect(patch.blocks?.length).toBeGreaterThan(0);
    expect(patch.blocks?.every((b) => b.stale === true)).toBe(true);
  });

  it("**保留切片**：没被碰到的块原样平移，exact 关掉（区间是估算的）", () => {
    const before = "段落一\n\n段落二";
    const after = "段落一改了\n\n段落二";
    const prevTable = toBlockTable(before, [crop(0, 9), crop(11, 20)]);
    const patch = landBlocksResult(
      emptySnap({ blocks: prevTable.blocks, doc: before, geometryId: 5, textPt: 12 }),
      after,
      failResult(),
    );
    expect(patch.blocks).not.toBeNull();
    expect(patch.exact).toBe(false);
    expect(patch.doc).toBe(after);
    // 块表没换 → 几何编号与字号都不动
    expect(patch.geometryId).toBe(5);
    expect(patch.textPt).toBe(12);
    expect(patch.log).toMatch(/^blocks fail errors:0 保留切片:\d+\/\d+$/);
  });

  it("没有上一批块表时失败 → 块表就是 null（编辑器整篇源码）", () => {
    const patch = landBlocksResult(emptySnap(), "abc", failResult());
    expect(patch.blocks).toBeNull();
    expect(patch.exact).toBe(false);
  });

  it("错误条数进日志（状态栏那边另有计数，这里只是可查的现场）", () => {
    const errors = [
      { message: "m1", line: 1, col: 1, endLine: 1, endCol: 2 },
      { message: "m2", line: 2, col: 1, endLine: 2, endCol: 2 },
    ] as BlocksFail["errors"];
    const patch = landBlocksResult(emptySnap(), "abc", failResult(errors));
    expect(patch.log).toContain("errors:2");
  });
});

describe("remapBlocksOnEdit：编辑期间让块表跟上", () => {
  const before = "段落一\n\n段落二";
  const table = toBlockTable(before, [crop(0, 9), crop(11, 20)]);

  it("没有块表：返回 null（编辑器本来就显示源码）", () => {
    expect(remapBlocksOnEdit(emptySnap({ doc: before }), "改了", 1)).toBeNull();
  });

  it("文档没变：返回 null（O(n) 的比较没必要白跑，也不该白增代次）", () => {
    expect(
      remapBlocksOnEdit(emptySnap({ blocks: table.blocks, doc: before }), before, 1),
    ).toBeNull();
  });

  it("文档变了：平移块表、exact 关掉、几何编号与字号保持", () => {
    const patch = remapBlocksOnEdit(
      emptySnap({ blocks: table.blocks, doc: before, geometryId: 3, textPt: 11.5 }),
      "段落一\n\n段落二。",
      7,
    );
    expect(patch).not.toBeNull();
    expect(patch!.doc).toBe("段落一\n\n段落二。");
    expect(patch!.exact).toBe(false);
    expect(patch!.geometryId).toBe(3);
    expect(patch!.textPt).toBe(11.5);
    expect(patch!.blocks!.length).toBeGreaterThan(0);
  });
});

describe("blockWindowBytes：视口 → 编译窗口（字节）", () => {
  it("短文档（≤ 2×预取）：整篇都渲（返回 null）", () => {
    const doc = "x".repeat(BLOCK_WINDOW_MARGIN * 2);
    expect(blockWindowBytes(doc, { from: 0, to: 10 })).toBeNull();
  });

  it("长文档：视口前后各留一段预取", () => {
    const doc = "x".repeat(BLOCK_WINDOW_MARGIN * 4);
    const win = blockWindowBytes(doc, { from: 10000, to: 10100 });
    expect(win).toEqual({ from: 10000 - BLOCK_WINDOW_MARGIN, to: 10100 + BLOCK_WINDOW_MARGIN });
  });

  it("取不到视口（编辑器未挂载）：从文档开头起一段，而不是整篇渲", () => {
    const doc = "x".repeat(BLOCK_WINDOW_MARGIN * 4);
    expect(blockWindowBytes(doc, null)).toEqual({ from: 0, to: BLOCK_WINDOW_MARGIN });
  });

  it("前后越界夹到文档边界", () => {
    const doc = "x".repeat(BLOCK_WINDOW_MARGIN * 3);
    const win = blockWindowBytes(doc, { from: 10, to: doc.length });
    expect(win!.from).toBe(0);
    expect(win!.to).toBe(doc.length);
  });

  it("中文文档返回的是**字节**偏移（不是位置）", () => {
    const doc = "中".repeat(BLOCK_WINDOW_MARGIN * 4);
    const win = blockWindowBytes(doc, { from: 5000, to: 5100 });
    // 位置 → 字节 ×3（位置 0 处是文档开头，位置 5000 对应字节 15000）
    expect(win!.from).toBe((5000 - BLOCK_WINDOW_MARGIN) * 3);
    expect(win!.to).toBe((5100 + BLOCK_WINDOW_MARGIN) * 3);
  });
});

describe("landBlocksResult / remapBlocksOnEdit 的 blocks 形状", () => {
  it("成功分支的块是 toBlockTable 的产物（带 svg 字段，编辑器直接照着渲）", () => {
    const doc = "abc";
    const patch = landBlocksResult(emptySnap(), doc, okResult(doc, [crop(0, 3)]));
    const block: Block = patch.blocks![0];
    expect(block.svg).toBe("<svg/>");
    expect(block.kind).toBe("Paragraph");
  });
});
