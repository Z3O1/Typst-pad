// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorView, keymap } from "@codemirror/view";
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { basicSetup } from "codemirror";
import { createEditorKeymap } from "./editor-keymap";
import {
  documentCompletionCoords,
  documentCompletionTooltips,
} from "./document-completion-tooltip";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});
function makeView() {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    doc: "al",
    extensions: [
      basicSetup,
      createEditorKeymap({ isWriteMode: () => true }),
      documentCompletionTooltips(() => null),
      autocompletion({
        override: [() => ({ from: 0, options: [{ label: "alpha" }] })],
        interactionDelay: 0,
      }),
    ],
  });
  views.push(view);
  view.dispatch({ selection: { anchor: 2 } });
  return view;
}
async function open(view: EditorView) {
  startCompletion(view);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(completionStatus(view.state)).toBe("active");
}
function press(view: EditorView, key: string, keyCode: number) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }),
  );
}

describe("document-completion-tooltip", () => {
  it("页面锚点以视口坐标和实际光标高度定位", () => {
    expect(documentCompletionCoords({ left: 123.5, top: 234.25, height: 18 })).toEqual({
      left: 123.5,
      right: 124.5,
      top: 234.25,
      bottom: 252.25,
    });
  });
  it("Enter 在段落键位前接受原候选，关闭后回退原换行", async () => {
    const view = makeView();
    expect(
      view.state
        .facet(keymap)
        .flat()
        .find((binding) => binding.key === "Enter")?.run,
    ).toBeDefined();
    await open(view);
    press(view, "Enter", 13);
    expect(view.state.doc.toString()).toBe("alpha");
    press(view, "Enter", 13);
    expect(view.state.doc.toString()).toBe("alpha\n\n");
  });
  it("IME 的 Esc 不被补全关闭处理截获", async () => {
    const view = makeView();
    await open(view);
    view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      keyCode: 27,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    let reachedWindow = false;
    const listener = () => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", listener);
    try {
      view.contentDOM.dispatchEvent(event);
      // 交回 CM/IME 原路径，不由新增处理器截断传播或修改源码。
      expect(reachedWindow).toBe(true);
      expect(view.state.doc.toString()).toBe("al");
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });
  it("Esc 仅关闭候选，不传播到页面的退出展开键位", async () => {
    const view = makeView();
    await open(view);
    let escaped = false;
    const listener = () => {
      escaped = true;
    };
    window.addEventListener("keydown", listener);
    try {
      press(view, "Escape", 27);
      expect(completionStatus(view.state)).toBeNull();
      expect(escaped).toBe(false);
      expect(view.state.doc.toString()).toBe("al");
      press(view, "Escape", 27);
      expect(escaped).toBe(true);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });
});
