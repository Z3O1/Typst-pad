import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { Range } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { buildEngineBreakDecorations } from "./block-decorations";
import type { Block, BlockCover } from "../../core/block-plan";
import type { Region } from "../../core/typst-lex";

/**
 * **引擎断点装饰**的契约：断点插在 `pos-1` 与 `pos` 之间、只给"自洽 + 不落在原子区间里"的块。
 *
 * 为什么要单测（而不是只靠浏览器验收）：这条装饰是 round 12 那次灾难（行内 widget 让 CodeMirror
 * 拆逻辑行、带高盒全丢）之后换的方案，判据是"**行结构与块级装饰都不受影响**"—— 而这里产出的
 * 只是 mark，有没有 widget / 有没有块级替换，靠装饰集本身就能钉死。
 */
function block(from: number, to: number, geo: Partial<Block> = {}): Block {
  return {
    from,
    to,
    kind: "Paragraph",
    found: true,
    skipped: false,
    noOutput: false,
    svg: "<svg/>",
    page: 1,
    pages: 1,
    xPt: 0,
    yPt: 0,
    anchorBaselinePt: null,
    widthPt: 100,
    heightPt: 10,
    lineBreaks: [],
    lineCount: 0,
    links: [],
    ...geo,
  };
}

function cover(b: Block, revealed = true): BlockCover {
  return {
    block: b,
    coverFrom: b.from,
    coverTo: b.to,
    renderable: true,
    noOutput: false,
    revealed,
    selected: false,
  };
}

/** 造一个 state，并取回"被套 mark 的区间"（用来断言断点落在哪两个字符之间） */
function markedRanges(
  doc: string,
  covers: BlockCover[],
  opaque: Region[] = [],
  math: { from: number; to: number }[] = [],
) {
  const state = EditorState.create({ doc });
  const decos = buildEngineBreakDecorations(state, covers, opaque, math);
  // 只取 mark：行装饰（`cm-write-engine-break-line`）也在同一个数组里，它不是断点本身
  return decos
    .filter((d) => specOf(d).class === "cm-write-engine-break")
    .map((d) => [d.from, d.to] as const);
}

/** `Range<Decoration>` 的装饰体在 `.value.spec` 上（CodeMirror 没把它写进类型） */
function specOf(d: Range<Decoration>): { class?: string; widget?: unknown; block?: boolean } {
  return (d.value as unknown as { spec: { class?: string; widget?: unknown; block?: boolean } })
    .spec;
}

/** 这一批装饰里有没有"禁止浏览器折行"的行装饰（返回它们的行首位置） */
function noWrapLines(doc: string, covers: BlockCover[], opaque: Region[] = []) {
  const state = EditorState.create({ doc });
  return buildEngineBreakDecorations(state, covers, opaque)
    .filter((d) => specOf(d).class === "cm-write-engine-break-line")
    .map((d) => d.from);
}

describe("禁止浏览器折行的行装饰", () => {
  it("断点全部落上时给这一行加禁折（否则浏览器会在断点前先折，每满一行多折一行）", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    expect(noWrapLines(doc, [cover(b)])).toEqual([0]);
  });

  it("有断点被原子区间挡掉时不加禁折（那一段会连成超长行，禁折就等于让它冲出页面）", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    expect(noWrapLines(doc, [cover(b)], [{ from: 7, to: 9, kind: "code" }])).toEqual([]);
  });

  it("跨多条源码行的块不加禁折（一条 .cm-line 的样式盖不住它）", () => {
    const doc = "abcdefghijkl\n第二行文字\n";
    const b = block(0, 18, { lineBreaks: [4, 8], lineCount: 3 });
    expect(noWrapLines(doc, [cover(b)])).toEqual([]);
  });

  it("引擎说只有一行时也要禁折（Typst 的行尾标点压缩会让浏览器差几像素多折一行）", () => {
    // 实测 PKU：同一个纯中文列表项 typst=1 / browser=2，只是列宽余量差几个像素
    const doc = "- 先去掉乘法交换律，得到四元数（4 维）：结合律、单位元、非零元有逆都还在。";
    const b = block(0, doc.length, { kind: "ListItem", lineBreaks: [], lineCount: 1 });
    expect(noWrapLines(doc, [cover(b)])).toEqual([0]);
  });

  it("拿不到行数（lineCount=0，老后端/桩/刚被编辑触碰）时不加禁折", () => {
    const doc = "正文一段。";
    const b = block(0, doc.length, { lineBreaks: [], lineCount: 0 });
    expect(noWrapLines(doc, [cover(b)])).toEqual([]);
  });
});

describe("buildEngineBreakDecorations", () => {
  it("断点插在断点字符之前：n 个断点 → n 枚 mark，区间是 [pos-1, pos)", () => {
    // 文档 12 个 ASCII 字符，第 4 与第 8 个字符之后断行
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    expect(markedRanges(doc, [cover(b)])).toEqual([
      [3, 4],
      [7, 8],
    ]);
  });

  it("断点条数与引擎给的行数不自洽 → 整块不用（宁可退回浏览器折行）", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 5 });
    expect(markedRanges(doc, [cover(b)])).toEqual([]);
  });

  it("没有行数（老后端）或没有断点 → 不折", () => {
    const doc = "abcdefghijkl";
    expect(markedRanges(doc, [cover(block(0, 12))])).toEqual([]);
    expect(markedRanges(doc, [cover(block(0, 12, { lineBreaks: [4], lineCount: 0 }))])).toEqual([]);
  });

  it("未展开（切片/隐藏）的块不折：它显示的是图片，折了也没有文本可折", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    expect(markedRanges(doc, [cover(b, false)])).toEqual([]);
  });

  it("反序/越界的断点作废：整块不折，不会把 mark 建到别人家的字上", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [8, 4], lineCount: 3 });
    expect(markedRanges(doc, [cover(b)])).toEqual([]);
    // 越出块尾的断点：同样整块不用
    const out = markedRanges(doc, [cover(block(0, 12, { lineBreaks: [20], lineCount: 2 }))]);
    expect(out).toEqual([]);
  });

  it("断点前那个字符落在公式/代码区间里 → **整块**不折（不是只跳过那一枚）", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    // 折不了的那一刀会连累整块：只折剩下的几刀，等于凭空多插几刀却不管这一行的容量，
    // 实测会让"本来对的块"多出一行（高代周二 L207 4→6 行）。
    const math = [{ from: 3, to: 5 }];
    expect(markedRanges(doc, [cover(b)], [], math)).toEqual([]);
    // code/raw/注释同理
    const code: Region[] = [{ from: 7, to: 9, kind: "code" }];
    expect(markedRanges(doc, [cover(b)], code)).toEqual([]);
  });

  it("断点前是 markup 引号时**照样折**（引号是 markup，不是复杂内容）", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4], lineCount: 2 });
    // 位置 3 落在 string 区域里（lexer 把未配对引号也登记成 string，见 overlapsComplexRegion）
    const quote: Region[] = [{ from: 3, to: 4, kind: "string" }];
    expect(markedRanges(doc, [cover(b)], quote)).toEqual([[3, 4]]);
  });

  it("产出的断点全是 mark（不是 replace）：这条装饰绝不能改变 CodeMirror 的行结构", () => {
    const doc = "abcdefghijkl";
    const b = block(0, 12, { lineBreaks: [4, 8], lineCount: 3 });
    const state = EditorState.create({ doc });
    // `Range<Decoration>` 的装饰体在 `.value` 上：mark 没有 widget、也不是块级装饰
    for (const d of buildEngineBreakDecorations(state, [cover(b)])) {
      const spec = specOf(d);
      expect(spec.widget).toBeUndefined();
      expect(spec.block ?? false).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 真视图回归（round 12 的反面教材就在这条上栽的）：断点装饰落到 DOM 之后，
// **逻辑行不能被拆**、带高盒不能丢 —— 行结构与块级装饰都必须原样
// ---------------------------------------------------------------------------
import { EditorView } from "@codemirror/view";
import { livePreview } from "../live-preview";

describe("引擎断点装到 DOM 上", () => {
  function mount(doc: string, blocks: Block[]): { host: HTMLElement; view: EditorView } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => blocks,
            writeFontMetrics: () => ({ ascent: 17, descent: 4 }),
          }),
        ],
      }),
    });
    return { host, view };
  }

  it("一行源码内折两次，仍是同一个 .cm-line，带高盒也还在", () => {
    const doc = "abcdefghijkl\n\n第二段短句。\n";
    const geo = { yPt: 0, heightPt: 24, anchorBaselinePt: 12 };
    const withBreaks: Block[] = [
      block(0, 12, { ...geo, lineBreaks: [4, 8], lineCount: 3 }),
      block(14, doc.length, { ...geo, yPt: 30, anchorBaselinePt: 42, lineCount: 1 }),
    ];
    // 对照组：同一份文档、同一批块，只是没有引擎断点
    const withoutBreaks: Block[] = [
      block(0, 12, { ...geo, lineCount: 0 }),
      block(14, doc.length, { ...geo, yPt: 30, anchorBaselinePt: 42, lineCount: 0 }),
    ];
    const a = mount(doc, withBreaks);
    const b = mount(doc, withoutBreaks);
    try {
      // **逻辑行数与块级形态逐项不变**：折行是浏览器层的视觉行为，不是 CodeMirror 的行切分
      //（round 12 的行内 widget 方案正是在这里把逻辑行拆开、让带高盒丢了 71 条）
      expect(a.view.dom.querySelectorAll(".cm-line").length).toBe(
        b.view.dom.querySelectorAll(".cm-line").length,
      );
      expect(a.view.dom.querySelectorAll(".cm-line.cm-block-band").length).toBe(
        b.view.dom.querySelectorAll(".cm-line.cm-block-band").length,
      );
      expect(a.view.dom.querySelectorAll(".cm-block-crop").length).toBe(
        b.view.dom.querySelectorAll(".cm-block-crop").length,
      );
      // 断点 mark 真的落到 DOM 上（两个断点），对照组一个都没有
      expect(a.view.dom.querySelectorAll(".cm-write-engine-break").length).toBe(2);
      expect(b.view.dom.querySelectorAll(".cm-write-engine-break").length).toBe(0);
    } finally {
      a.view.destroy();
      a.host.remove();
      b.view.destroy();
      b.host.remove();
    }
  });
});
