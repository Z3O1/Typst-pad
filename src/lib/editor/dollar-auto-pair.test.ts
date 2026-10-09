// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { createEditorKeymap } from "./editor-keymap";
import { dollarAutoPair, insertDollar } from "./dollar-auto-pair";
import { addDollarPair, dollarPairs } from "./dollar-pair-state";

function stateFor(doc: string, ranges = [EditorSelection.cursor(doc.length)], main = 0) {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges, main),
    extensions: [typst_lezer(), dollarPairs, EditorState.allowMultipleSelections.of(true)],
  });
}

const views: EditorView[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const view of views.splice(0)) view.destroy();
  document.body.replaceChildren();
});

function viewFor(doc: string, head: number) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: head },
      extensions: [basicSetup, typst_lezer(), createEditorKeymap(), dollarAutoPair],
    }),
  });
  views.push(view);
  return view;
}

function input(
  view: EditorView,
  text = "$",
  userEvent = "input.type",
  from = view.state.selection.main.from,
) {
  const to = view.state.selection.main.to;
  const fallback = () => view.state.update(view.state.replaceSelection(text), { userEvent });
  return view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, fallback));
}

function backspace(view: EditorView) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      keyCode: 8,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("$ 事务与多选区", () => {
  it("每个光标分别配对，保持主光标索引并标记真实输入", () => {
    const state = stateFor("前 \n\n后", [EditorSelection.cursor(2), EditorSelection.cursor(3)], 1);
    const tr = insertDollar(state)!;
    expect(tr.newDoc.toString()).toBe("前 $$\n$$\n后");
    expect(tr.newSelection.ranges.map((r) => r.head)).toEqual([3, 6]);
    expect(tr.newSelection.mainIndex).toBe(1);
    expect(tr.annotation(Transaction.userEvent)).toBe("input.type");
  });

  it("混合正文、代码和闭合符：同时插入/跳过，不能吞掉其它光标的字面输入", () => {
    const doc = "前 $x$\n// 注释\n正文 ";
    const state = stateFor(doc, [
      EditorSelection.cursor(4),
      EditorSelection.cursor(11),
      EditorSelection.cursor(doc.length),
    ]).update({ effects: addDollarPair.of({ open: 2, close: 4, display: false }) }).state;
    const tr = insertDollar(state)!;
    expect(tr.newDoc.toString()).toBe("前 $x$\n// 注释$\n正文 $$");
    expect(tr.newSelection.ranges.map((r) => r.head)).toEqual([5, 12, doc.length + 2]);
  });

  it("全是闭合符跳过时只改变选区，不产生文档变更", () => {
    const state = stateFor("$x$ $y$", [
      EditorSelection.cursor(2),
      EditorSelection.cursor(6),
    ]).update({
      effects: [
        addDollarPair.of({ open: 0, close: 2, display: false }),
        addDollarPair.of({ open: 4, close: 6, display: false }),
      ],
    }).state;
    const tr = insertDollar(state)!;
    expect(tr.docChanged).toBe(false);
    expect(tr.newSelection.ranges.map((r) => r.head)).toEqual([3, 7]);
    expect(tr.annotation(Transaction.userEvent)).toBe("select");
  });

  it("包裹选区保留内容与反向选区，多个选区坐标随同一事务映射", () => {
    const state = stateFor("前 x 后 y", [EditorSelection.range(3, 2), EditorSelection.range(6, 7)]);
    const tr = insertDollar(state)!;
    expect(tr.newDoc.toString()).toBe("前 $x$ 后 $y$");
    expect(tr.newSelection.ranges.map((r) => [r.anchor, r.head])).toEqual([
      [4, 3],
      [9, 10],
    ]);
  });

  it("整行选区也原样包裹，不自动加空格；后续输入只替换选区", () => {
    const state = stateFor("x + y", [EditorSelection.range(0, 5)]);
    const next = insertDollar(state)!.state;
    expect(next.doc.toString()).toBe("$x + y$");
    expect(next.selection.main.from).toBe(1);
    expect(next.update(next.replaceSelection("z")).newDoc.toString()).toBe("$z$");
  });

  it("只读状态和完全不可配对的多光标不接管输入", () => {
    expect(insertDollar(stateFor("// 注释"))).toBeNull();
    const state = EditorState.create({
      extensions: [typst_lezer(), EditorState.readOnly.of(true)],
    });
    expect(insertDollar(state)).toBeNull();
  });
});

describe("$ 输入接线、历史与退格", () => {
  it("实际 inputHandler 执行配对、输入内容后跳过闭合符，撤销/重做恢复源码", () => {
    const view = viewFor("", 0);
    expect(input(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$$");
    expect(view.state.selection.main.head).toBe(1);
    view.dispatch(view.state.update(view.state.replaceSelection("x"), { userEvent: "input.type" }));
    expect(input(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$x$");
    expect(view.state.selection.main.head).toBe(3);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("");
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$x$");
  });

  it("选区包裹是独立撤销步骤，不连带撤销刚输入的正文", () => {
    const view = viewFor("", 0);
    view.dispatch(view.state.update(view.state.replaceSelection("x"), { userEvent: "input.type" }));
    view.dispatch({ selection: { anchor: 0, head: 1 } });
    expect(input(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$x$");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("x");
    expect(view.state.selection.main.from).toBe(0);
    expect(view.state.selection.main.to).toBe(1);
  });

  it.each(["input.paste", "input.drop", "input.type.compose"])(
    "%s 的单个 $ 不触发自动配对",
    (event) => {
      const view = viewFor("", 0);
      expect(input(view, "$", event)).toBe(false);
      expect(view.state.doc.toString()).toBe("");
    },
  );

  it("合成期间、非单个 $ 和替换范围不匹配均交回默认输入", () => {
    const view = viewFor("正文", 1);
    expect(input(view, "$$")).toBe(false);
    expect(input(view, "$", "input.type", 0)).toBe(false);
    vi.spyOn(view, "compositionStarted", "get").mockReturnValue(true);
    expect(input(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("正文");
  });

  it("刚输入空配对再退格，撤销分组与 ( 相同", () => {
    // 比较同一分组窗口内的操作，不让整套测试的并发负载决定原生括号是否拆组。
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const results = ["(", "$"].map((open) => {
      const view = viewFor("", 0);
      expect(input(view, open)).toBe(true);
      backspace(view);
      undo(view);
      return [view.state.doc.toString(), view.state.selection.main.head];
    });
    expect(results).toEqual([
      ["", 0],
      ["", 0],
    ]);
  });

  it("空行间公式先退回 $$，撤销恢复原空格与光标", () => {
    const view = viewFor("$  $", 2);
    backspace(view);
    expect(view.state.doc.toString()).toBe("$$");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("$  $");
    expect(view.state.selection.main.head).toBe(2);
  });

  it("raw 中的 $$ 只按默认退格删一个字符，只读文档不删除", () => {
    const view = viewFor("`$$`", 2);
    backspace(view);
    expect(view.state.doc.toString()).toBe("`$`");
    const readOnly = new EditorView({
      state: EditorState.create({
        doc: "$  $",
        selection: { anchor: 2 },
        extensions: [
          basicSetup,
          typst_lezer(),
          createEditorKeymap(),
          EditorState.readOnly.of(true),
        ],
      }),
    });
    views.push(readOnly);
    backspace(readOnly);
    expect(readOnly.state.doc.toString()).toBe("$  $");
  });

  it("多光标空配对整对删除，所有光标和主光标都保留", () => {
    const view = viewFor("$$ $$", 1);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(4)], 1),
    });
    backspace(view);
    expect(view.state.doc.toString()).toBe(" ");
    expect(view.state.selection.ranges.map((r) => r.head)).toEqual([0, 1]);
    expect(view.state.selection.mainIndex).toBe(1);
  });

  it("紧凑 $$ Enter 沿用缩进，自动闭合符状态保持到三行内部", () => {
    const view = viewFor("  $$", 3);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("  $\n    \n  $");
    expect(view.state.selection.main.head).toBe(8);
    view.dispatch(view.state.update(view.state.replaceSelection("x"), { userEvent: "input.type" }));
    expect(input(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(13);
  });

  it("空三行公式先退回 $$，下一次退格删除配对", () => {
    const view = viewFor("  $\n    \n  $", 8);
    backspace(view);
    expect(view.state.doc.toString()).toBe("  $$");
    expect(view.state.selection.main.head).toBe(3);
    backspace(view);
    expect(view.state.doc.toString()).toBe("  ");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("  $\n    \n  $");
  });

  it("空格选择行间公式，退格先撤回空格手势，再删除配对", () => {
    const view = viewFor("", 0);
    expect(input(view)).toBe(true);
    expect(input(view, " ")).toBe(true);
    expect(view.state.doc.toString()).toBe("$  $");
    expect(view.state.selection.main.head).toBe(2);
    backspace(view);
    expect(view.state.doc.toString()).toBe("$$");
    expect(view.state.selection.main.head).toBe(1);
    expect(view.state.field(dollarPairs)).toEqual([{ open: 0, close: 1, display: false }]);
    backspace(view);
    expect(view.state.doc.toString()).toBe("");
  });

  it("CRLF 分隔配置下 Enter 的光标按 CM 内部文本位置计算", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "$$",
        selection: { anchor: 1 },
        extensions: [
          basicSetup,
          typst_lezer(),
          createEditorKeymap(),
          dollarAutoPair,
          EditorState.lineSeparator.of("\r\n"),
        ],
      }),
    });
    views.push(view);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("$\n  \n$");
    expect(view.state.selection.main.head).toBe(4);
  });
});
