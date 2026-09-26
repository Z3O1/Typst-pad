import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview } from "../live-preview";
import type { Block } from "../../core/block-plan";

/**
 * **列表标记按引擎偏移画**（任务 2）：
 * 前端不再用 `TextWidget("• ")` 猜宽度，而是按 Rust 侧给的 `bodyOffsetPt` 画一个右对齐的定宽
 * 盒子 —— 符号、缩进、编号都与 typst 一致（自定义 numbering/start 也走同一个值）。
 *
 * 这里用真视图钉住"装饰真的落成 `ListMarkerWidget` 的 DOM"和宽度换算（pt × 4/3）。
 */
function makeBlock(from: number, to: number, kind: string, extra: Partial<Block>): Block {
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
    xPt: 58,
    yPt: 0,
    anchorBaselinePt: 12,
    widthPt: 371,
    heightPt: 20,
    lineBreaks: [],
    lineCount: 0,
    links: [],
    ...extra,
  };
}

function mount(
  doc: string,
  blocks: Block[],
  anchor: number,
): { host: HTMLElement; view: EditorView } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor },
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

describe("列表标记：符号/缩进/编号取自引擎", () => {
  it("渲染成定宽右对齐的标记盒（宽度 = bodyOffsetPt × 4/3）", () => {
    const doc = "- 第一项\n\n控制段。";
    const controlFrom = doc.indexOf("控制段");
    const listEnd = doc.indexOf("\n\n");
    const list = makeBlock(0, listEnd, "ListItem", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(0, listEnd) },
      listMarker: { text: "•", markerXPt: 0, bodyOffsetPt: 9.36 },
    });
    const control = makeBlock(controlFrom, doc.length, "Paragraph", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(controlFrom) },
    });
    const { host, view } = mount(doc, [list, control], controlFrom);
    try {
      const marker = host.querySelector<HTMLElement>(".cm-markup-list-marker");
      expect(marker).not.toBeNull();
      expect(marker!.getAttribute("data-marker")).toBe("•");
      // 9.36pt × 4/3 = 12.48px（jsdom 会把尾零规范化掉，所以按数值断言）
      expect(parseFloat(marker!.style.width)).toBeCloseTo((9.36 * 4) / 3, 2);
      expect(marker!.style.textAlign).toBe("left");
      expect(marker!.style.boxSizing).toBe("border-box");
      expect(marker!.style.paddingLeft).toBe(""); // 圆点本身就在列左缘
      // 行内不再出现源码里的 `- `
      expect(host.querySelector(".cm-line")!.textContent).not.toContain("- ");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("自定义编号直接用引擎文字（前端计数不参与）", () => {
    const doc = "+ 甲\n\n控制段。";
    const controlFrom = doc.indexOf("控制段");
    const listEnd = doc.indexOf("\n\n");
    const list = makeBlock(0, listEnd, "EnumItem", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(0, listEnd) },
      listMarker: { text: "a)", markerXPt: 5.5, bodyOffsetPt: 11 },
    });
    const control = makeBlock(controlFrom, doc.length, "Paragraph", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(controlFrom) },
    });
    const { host, view } = mount(doc, [list, control], controlFrom);
    try {
      const marker = host.querySelector<HTMLElement>(".cm-markup-list-marker");
      expect(marker!.getAttribute("data-marker")).toBe("a)");
      expect(parseFloat(marker!.style.width)).toBeCloseTo((11 * 4) / 3, 2);
      // 序号右对齐：标记起点 = 正文起点 − 标记宽（引擎给的实际位置）
      expect(parseFloat(marker!.style.paddingLeft)).toBeCloseTo((5.5 * 4) / 3, 2);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("多源码行块只有**第一行**用引擎标记（后续行退回扫描器近似，不拿外层标记画内层）", () => {
    const doc = "- 外层\n  - 内层\n\n控制段。";
    const listEnd = doc.indexOf("\n\n");
    const controlFrom = listEnd + 2;
    const list = makeBlock(0, listEnd, "ListItem", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(0, listEnd) },
      listMarker: { text: "•", markerXPt: 0, bodyOffsetPt: 9.36 },
    });
    const control = makeBlock(controlFrom, doc.length, "Paragraph", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(controlFrom) },
    });
    // 光标落在多行块的**正文**里（不贴标记）→ 它展开成源码，两行都有列表标记装饰
    const { host, view } = mount(doc, [list, control], doc.indexOf("外层") + 1);
    try {
      const exact = host.querySelectorAll(".cm-markup-list-marker");
      expect(exact).toHaveLength(1);
      const lines = Array.from(host.querySelectorAll(".cm-line")).map((el) => el.textContent);
      expect(lines[0]).toContain("外层");
      expect(lines[1]).toContain("内层");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("取不到引擎标记时退回旧的近似符号（旧行为），列表项也保持切片/源码", () => {
    const doc = "- 第一项\n\n控制段。";
    const controlFrom = doc.indexOf("控制段");
    const listEnd = doc.indexOf("\n\n");
    const list = makeBlock(0, listEnd, "ListItem", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(0, listEnd) },
      listMarker: null,
    });
    const control = makeBlock(controlFrom, doc.length, "Paragraph", {
      edit: { verdict: "verified", reason: "ok", source: doc.slice(controlFrom) },
    });
    const { host, view } = mount(doc, [list, control], controlFrom);
    try {
      // 块没被判定为可编辑 → 保持切片：DOM 里没有标记装饰，也没有源码形态
      expect(host.querySelector(".cm-markup-list-marker")).toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
