import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { buildBlockCovers } from "./block-decorations";
import { scanNonMarkupRegions } from "../../core/typst-lex";
import type { LivePreviewOptions } from "./options";
import type { Block, BlockEditProof } from "../../core/block-plan";

/** 造一个块：区间 [from,to)、kind、found */
function block(from: number, to: number, kind: Block["kind"] = "Paragraph"): Block {
  return {
    from,
    to,
    kind,
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
    edit: null,
  };
}

const proof = (source: string, verdict: "verified" | "unknown" = "verified"): BlockEditProof => ({
  verdict,
  reason: verdict === "verified" ? "ok" : "gap",
  source,
});

/**
 * 用块表算一次"哪些格子展开源码"。
 *
 * **光标钉在最后那个"控制块"上**：它自己必然展开（光标所在格必须展开，那是硬约束），
 * 被检查的目标块因此只会因**决策**而展开 —— 否则"光标在文档末尾"会把最后一格也算成展开，
 * 断言就变成了恒真。
 */
function coversOf(doc: string, blocks: Block[], anchor: number) {
  const state = EditorState.create({ doc, selection: { anchor } });
  const opts = { enabled: () => true, blocks: () => blocks } as unknown as LivePreviewOptions;
  return buildBlockCovers(state, opts, doc, scanNonMarkupRegions(doc));
}

/** 目标块 + 一个控制段；返回 [covers, 目标块的 revealed] */
function decideTarget(targetDoc: string, target: Block, controlDoc: string) {
  const doc = `${targetDoc}\n\n${controlDoc}`;
  const controlFrom = targetDoc.length + 2;
  const control: Block = {
    ...block(controlFrom, doc.length),
    edit: proof(doc.slice(controlFrom)),
  };
  const from = target.from;
  const to = target.to;
  const covers = coversOf(doc, [{ ...target, from, to }, control], controlFrom);
  const cover = covers.find((c) => c.block.from === from && c.block.to === to);
  if (!cover) throw new Error("目标块的格子没算出来");
  return cover;
}

const CONTROL = "控制段。";

describe("buildBlockCovers：可编辑资格只由 core 决策给出", () => {
  it("文字对应已证明的正文/标题展开为真实文本", () => {
    const targetDoc = "= 标题";
    const target = { ...block(0, targetDoc.length, "Heading"), edit: proof(targetDoc) };
    expect(decideTarget(targetDoc, target, CONTROL).revealed).toBe(true);
    const body = "正文一段。";
    expect(
      decideTarget(body, { ...block(0, body.length), edit: proof(body) }, CONTROL).revealed,
    ).toBe(true);
  });

  it("证明为 unknown（换字 / 宏展开 / 重复输出）的块不展开 → 保持切片", () => {
    const targetDoc = "这里本来写着苹果两个字。";
    const target = { ...block(0, targetDoc.length), edit: proof(targetDoc, "unknown") };
    const cover = decideTarget(targetDoc, target, CONTROL);
    expect(cover.revealed).toBe(false);
  });

  it("证明里的源码与当前区间不一致（过期产物）→ 不可编辑", () => {
    const targetDoc = "当前文档的正文。";
    const target = { ...block(0, targetDoc.length), edit: proof("旧文档的正文。") };
    expect(decideTarget(targetDoc, target, CONTROL).revealed).toBe(false);
  });

  it("没有证明字段（旧后端 / 桩）沿用旧的语法判据", () => {
    const targetDoc = "正文一段。";
    const target = { ...block(0, targetDoc.length), edit: undefined };
    expect(decideTarget(targetDoc, target, CONTROL).revealed).toBe(true);
  });

  it("含代码 / raw / 注释或段内单 LF 的块不展开", () => {
    const raw = "正文里有 `code`。";
    expect(decideTarget(raw, { ...block(0, raw.length), edit: proof(raw) }, CONTROL).revealed).toBe(
      false,
    );
    const multiline = "第一行，\n第二行。";
    expect(
      decideTarget(multiline, { ...block(0, multiline.length), edit: proof(multiline) }, CONTROL)
        .revealed,
    ).toBe(false);
  });
});
