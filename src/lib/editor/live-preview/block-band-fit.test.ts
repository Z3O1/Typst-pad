import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { blockBandFit, buildBlockBandFitDecorations } from "./block-decorations";
import type { Block, BlockCover } from "../../core/block-plan";

/** 造一个块：[from,to)、带顶 yPt、带高 heightPt、首行主基线 anchorBaselinePt（都是 pt） */
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
    noOutput: b.noOutput,
    revealed,
    selected: false,
  };
}

/** 与浏览器验收同一套度量（14.667px 思源宋体实测值） */
const METRICS = { ascent: 17, descent: 4 };

describe("blockBandFit", () => {
  it("盒高 = 带高 × 4/3，行高由首行主基线在带内的偏移反解", () => {
    // 带顶 100pt、带高 20pt、首行主基线 113pt ⇒ 偏移 13pt = 17.333px
    const fit = blockBandFit(
      block(0, 4, { yPt: 100, heightPt: 20, anchorBaselinePt: 113 }),
      METRICS,
    );
    expect(fit?.heightPx).toBeCloseTo(20 * (4 / 3), 6);
    // line-height = 2 × 偏移 − 上升部 + 下降部
    expect(fit?.lineHeightPx).toBeCloseTo(2 * ((13 * 4) / 3) - 17 + 4, 6);
    // 行盒模型自检：盒顶 + (行高 − (上升部 + 下降部)) / 2 + 上升部 == 主基线偏移
    const baseline = (fit!.lineHeightPx - (METRICS.ascent + METRICS.descent)) / 2 + METRICS.ascent;
    expect(baseline).toBeCloseTo((13 * 4) / 3, 6);
  });

  it("没有几何 / 没有输出 / 基线为负解时不下手（保持自然行盒）", () => {
    const base = { yPt: 0, heightPt: 20, anchorBaselinePt: 13 };
    expect(blockBandFit(block(0, 4, { ...base, found: false }), METRICS)).toBeNull();
    expect(blockBandFit(block(0, 4, { ...base, noOutput: true }), METRICS)).toBeNull();
    expect(blockBandFit(block(0, 4, { ...base, heightPt: 0 }), METRICS)).toBeNull();
    expect(blockBandFit(block(0, 4, { ...base, anchorBaselinePt: null }), METRICS)).toBeNull();
    // 带顶 100、基线 100.5pt：偏移 0.5pt ⇒ 反解出的行高为负 —— 这种几何不成立，不下手
    expect(
      blockBandFit(block(0, 4, { yPt: 100, heightPt: 20, anchorBaselinePt: 100.5 }), METRICS),
    ).toBeNull();
  });
});

describe("buildBlockBandFitDecorations", () => {
  it("给可编辑正文的单源码行挂上盒高/行高两个变量", () => {
    const doc = "第一段。\n\n= 标题\n";
    const state = EditorState.create({ doc });
    const para = block(0, 4, { yPt: 20, heightPt: 18, anchorBaselinePt: 33 });
    const heading = block(7, 10, { yPt: 40, heightPt: 24, anchorBaselinePt: 52, kind: "Heading" });
    const deco = buildBlockBandFitDecorations(state, [cover(para), cover(heading)], METRICS);
    expect(deco.length).toBe(2);
    const specs = deco.map((d) => `${document_spec(d)}`);
    expect(specs[0]).toContain("--write-band-h:24.000px");
    expect(specs[1]).toContain("--write-band-h:32.000px");
  });

  it("没展开的格子（切片）与多源码行块不挂：前者不需要，后者行盒是多行的", () => {
    const doc = "第一段。\n\n第二段第一行，\n第二行。";
    const state = EditorState.create({ doc });
    const geo = { yPt: 0, heightPt: 18, anchorBaselinePt: 12 };
    const revealed = block(0, 4, geo);
    const crop = cover(block(7, doc.length, geo), false);
    const multi = cover(block(7, doc.length, geo), true);
    expect(buildBlockBandFitDecorations(state, [cover(revealed), crop], METRICS).length).toBe(1);
    expect(buildBlockBandFitDecorations(state, [cover(revealed), multi], METRICS).length).toBe(1);
  });

  it("量不出字体度量时整条规则不启用", () => {
    const state = EditorState.create({ doc: "第一段。\n" });
    const c = cover(block(0, 4, { yPt: 0, heightPt: 18, anchorBaselinePt: 12 }));
    expect(buildBlockBandFitDecorations(state, [c], null)).toEqual([]);
  });
});

/** 取装饰挂的属性（`Range` 的装饰体在 `.value.spec` 上） */
function document_spec(d: unknown): string {
  const spec = (d as { value?: { spec?: { attributes?: Record<string, string> } } }).value?.spec;
  return spec?.attributes?.style ?? "";
}

// ---------------------------------------------------------------------------
// 真视图回归：带高盒的 line decoration 必须真的落到 DOM 上
// （曾经出现"装饰算出了 87 条，DOM 里只有 16 条"—— 就是这条测试要挡的）
// ---------------------------------------------------------------------------
import { EditorView } from "@codemirror/view";
import { livePreview } from "../live-preview";

describe("带高盒装到 DOM 上", () => {
  const geo = {
    found: true,
    noOutput: false,
    pages: 1,
    page: 1,
    xPt: 0,
    widthPt: 371,
    heightPt: 20,
    svg: "<svg/>",
    links: [],
  };
  const editable = (from: number, to: number): Block =>
    block(from, to, { ...geo, kind: "Paragraph", yPt: 0, anchorBaselinePt: 12 });
  const crop = (from: number, to: number): Block =>
    block(from, to, { ...geo, kind: "ListItem", yPt: 0, anchorBaselinePt: null, heightPt: 20 });

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

  it("每一条可编辑正文行都挂上带高盒（切片后面那一行也不能漏）", () => {
    const doc = "aaa\n\nbbb\n\nccc\n\nddd\n\neee\n";
    const blocks = [
      editable(0, 3),
      crop(5, 8),
      editable(10, 13),
      editable(15, 18),
      editable(20, 23),
    ];
    const { host, view } = mount(doc, blocks);
    try {
      const banded = Array.from(host.querySelectorAll(".cm-line.cm-block-band"));
      const texts = banded.map((el) => el.textContent);
      expect(texts).toEqual(["aaa", "ccc", "ddd", "eee"]);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
