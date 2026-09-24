// 长行内公式的**可断行片段**渲染：片段依次渲染、片段之间留可断点。
// 这是"浏览器折行位置与 Typst 一致"的关键（见 Rust `split_inline_math` 与 widgets.ts 的说明）。
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MathWidget } from "./widgets";
import type { MathRender } from "../../core/typst-engine";

const seg = (body: string, widthPt: number) => ({
  body,
  svg: `<svg viewBox="0 0 ${widthPt} 6"><text>${body}</text></svg>`,
  widthPt,
  heightPt: 6,
  baselinePt: 4.5,
});

function widget(render: MathRender) {
  const view = new EditorView({ state: EditorState.create({ doc: "a b c" }) });
  const dom = new MathWidget(
    render,
    { from: 0, to: 5, body: "a+b", display: false, multiline: false },
    false,
  ).toDOM(view);
  view.destroy();
  return dom;
}

describe("MathWidget：长行内公式的可断行片段", () => {
  it("多片段：每个片段一个 inline-block，片段之间是可断点（<wbr>）", () => {
    const dom = widget({
      ok: true,
      svg: "<svg/>",
      widthPt: 30,
      heightPt: 6,
      baselinePt: 4.5,
      segments: [seg("a + b", 14), seg("+ c + d", 16)],
    });
    expect(dom.className).toContain("cm-math-split");
    const parts = dom.querySelectorAll(".cm-math-seg");
    expect(parts).toHaveLength(2);
    expect(dom.querySelectorAll("wbr")).toHaveLength(1);
    // 片段尺寸与基线对齐都按 pt 写死（与整块渲染同一口径）
    expect((parts[0] as HTMLElement).style.width).toBe("14pt");
    expect((parts[1] as HTMLElement).style.height).toBe("6pt");
    expect((parts[0] as HTMLElement).style.verticalAlign).toBe("-1.5pt");
  });

  it("单片段 / 没有片段：仍是整块渲染", () => {
    const dom = widget({
      ok: true,
      svg: '<svg viewBox="0 0 30 6"/>',
      widthPt: 30,
      heightPt: 6,
      baselinePt: 4.5,
      segments: [seg("a + b", 30)],
    });
    expect(dom.className).not.toContain("cm-math-split");
    expect(dom.querySelectorAll(".cm-math-seg")).toHaveLength(0);
    expect(dom.style.width).toBe("30pt");
  });

  it("被完整选中时保持整块（选区外观优先，不拆片段）", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "a b c" }) });
    const dom = new MathWidget(
      {
        ok: true,
        svg: "<svg/>",
        widthPt: 30,
        heightPt: 6,
        baselinePt: 4.5,
        segments: [seg("a + b", 14), seg("+ c", 16)],
      },
      { from: 0, to: 5, body: "a+b", display: false, multiline: false },
      false,
      true,
    ).toDOM(view);
    view.destroy();
    expect(dom.className).not.toContain("cm-math-split");
    expect(dom.querySelectorAll(".cm-math-seg")).toHaveLength(0);
  });
});
