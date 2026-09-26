// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview } from "../live-preview";
import type { Block } from "../../core/block-plan";

/**
 * **简单函数白名单**（任务 4）的编辑器集成：`#strong[文字]` 的调用语法被隐藏、正文是真实文本，
 * 用户输入/删除都落在正文源码上，函数调用与定界符原样保留（只有选区触及标记时才露出）。
 */
function mount(doc: string, blocks: Block[], anchor = 0) {
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
        }),
      ],
    }),
  });
  return { host, view };
}

function verifiedBlock(doc: string, kind = "Paragraph"): Block {
  return {
    from: 0,
    to: doc.length,
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
    widthPt: 371,
    heightPt: 20,
    lineBreaks: [],
    lineCount: 0,
    links: [],
    edit: { verdict: "verified", reason: "ok", source: doc },
  };
}

describe("#strong[文字] / #emph[文字]：调用语法隐藏、正文可编辑", () => {
  it("隐藏 `#strong[` 与 `]`，正文带 strong 样式", () => {
    const doc = "正文 #strong[加粗的字] 收尾。";
    const { host, view } = mount(doc, [verifiedBlock(doc)]);
    try {
      const strong = host.querySelector(".cm-markup-strong");
      expect(strong?.textContent).toBe("加粗的字");
      const line = host.querySelector(".cm-line");
      expect(line?.textContent).toBe("正文 加粗的字 收尾。");
      expect(line?.textContent).not.toContain("#strong[");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("`#emph[文字]` 走同一条路径", () => {
    const doc = "正文 #emph[斜体的字] 收尾。";
    const { host, view } = mount(doc, [verifiedBlock(doc)]);
    try {
      expect(host.querySelector(".cm-markup-emph")?.textContent).toBe("斜体的字");
      expect(host.querySelector(".cm-line")?.textContent).toBe("正文 斜体的字 收尾。");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("光标落进某一枚标记时只露出那一枚（与 `*粗*` 同一套局部揭示规则）", () => {
    const doc = "#strong[加粗]";
    const { host, view } = mount(doc, [verifiedBlock(doc)]);
    try {
      view.dispatch({ selection: { anchor: 3 } }); // 光标在 `#strong` 里
      expect(host.querySelector(".cm-line")?.textContent).toBe("#strong[加粗");
      // 光标移回正文：标记全部收起
      view.dispatch({ selection: { anchor: doc.indexOf("加") + 1 } });
      expect(host.querySelector(".cm-line")?.textContent).toBe("加粗");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("证明为 unknown 时整块退回切片（不显示源码文本）", () => {
    const body = "正文 #strong[加粗的字] 收尾。";
    const doc = `${body}\n\n控制段。`;
    const controlFrom = body.length + 2;
    const target = verifiedBlock(body);
    target.edit = { verdict: "unknown", reason: "straddle", source: body };
    const control: Block = {
      ...verifiedBlock(doc.slice(controlFrom)),
      from: controlFrom,
      to: doc.length,
    };
    const { host, view } = mount(doc, [target, control], controlFrom);
    try {
      // 目标块被切片盖住：DOM 里既没有 strong 装饰，也没有它的源码文本
      expect(host.querySelector(".cm-markup-strong")).toBeNull();
      expect(host.textContent).not.toContain("#strong[");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
