import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildHeadingShrinkDecorations } from "./block-decorations";
import type { Block, BlockCover } from "../../core/block-plan";

describe("buildHeadingShrinkDecorations", () => {
  const doc = "= 标题\n\n正文";
  const state = EditorState.create({ doc });

  /** 直接造"已揭示的可编辑块"格子（真实路径由 buildBlockCovers 置 revealed） */
  function coversFor(block: Block): BlockCover[] {
    return [
      {
        block,
        coverFrom: block.from,
        coverTo: block.to,
        renderable: true,
        noOutput: false,
        revealed: true,
        selected: false,
      },
    ];
  }

  const heading: Block = {
    from: 0,
    to: 3,
    kind: "Heading",
    found: true,
    skipped: false,
    noOutput: false,
    svg: "<svg/>",
    page: 1,
    pages: 1,
    xPt: 0,
    yPt: 0,
    widthPt: 345.5,
    heightPt: 17.4,
    anchorBaselinePt: 13,
    links: [],
  };

  it("带高比自然行盒小 → 产生 cm-heading-fit 行装饰并带 --heading-fit 变量", () => {
    const covers = coversFor(heading);
    const deco = buildHeadingShrinkDecorations(state, covers, 11);
    expect(deco.length).toBe(1);
    const spec = deco[0].value.spec as { class?: string; attributes?: Record<string, string> };
    expect(spec.class).toBe("cm-heading-fit");
    expect(spec.attributes?.["style"]).toContain("--heading-fit:23.2");
  });

  it("带高比自然行盒大 → 不产生装饰（只压不撑）", () => {
    const tall: Block = { ...heading, heightPt: 30 };
    const deco = buildHeadingShrinkDecorations(state, coversFor(tall), 11);
    expect(deco).toEqual([]);
  });

  it("字号取不到（0）时不产生装饰", () => {
    expect(buildHeadingShrinkDecorations(state, coversFor(heading), 0)).toEqual([]);
  });
});
