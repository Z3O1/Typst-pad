import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { closeBrackets, insertBracket } from "@codemirror/autocomplete";
import { history, redo, undo } from "@codemirror/commands";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { dollarAutoPair, insertDollar, insertDollarSpace } from "./dollar-auto-pair";
import { dollarPairs } from "./dollar-pair-state";

function stateFor(doc = "", anchor = doc.length, head = anchor) {
  return EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [
      typst_lezer(),
      closeBrackets(),
      dollarAutoPair,
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}
function type(state: EditorState, text: string) {
  const tr = text === "$" ? insertDollar(state) : insertBracket(state, text);
  return (tr ?? state.update(state.replaceSelection(text), { userEvent: "input.type" })).state;
}
const normalized = (state: EditorState) => ({
  doc: state.doc.toString().replace(/[()]/g, "$"),
  selection: state.selection.ranges.map((range) => [range.anchor, range.head]),
});

// 这些历史对照都是同步操作；固定 Date，避免宿主调度/时钟校准跨过 CM 的分组窗口。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("$ 与 CM 原生 ( 的手感对照", () => {
  it.each([
    ["", 0],
    ["正文 ", 3],
    ["word", 2],
    [" x", 0],
    ["，", 0],
  ] as const)("在 %j 的位置 %d，插入与光标行为一致", (doc, pos) => {
    expect(normalized(type(stateFor(doc, pos), "$"))).toEqual(
      normalized(type(stateFor(doc, pos), "(")),
    );
  });

  it("原样包裹含首尾空白的反向选区，选区不缩小", () => {
    const state = stateFor("前 x 后", 4, 1);
    expect(normalized(type(state, "$"))).toEqual(normalized(type(state, "(")));
  });

  it("输入内容后关闭自动配对，源码、光标和撤销结果与 ( 相同", () => {
    const run = (open: string, close: string) => {
      let state = type(stateFor(), open);
      state = type(state, "x");
      state = type(state, close);
      const closed = normalized(state);
      undo({
        get state() {
          return state;
        },
        dispatch: (tr) => {
          state = tr.state;
        },
      });
      return { closed, undone: normalized(state) };
    };
    expect(run("$", "$")).toEqual(run("(", ")"));
  });

  it("读入的闭合符不被跳过，自动配对按括号规则只在本次编辑内跳过", () => {
    const dollar = stateFor("$x$", 2);
    const bracket = stateFor("(x)", 2);
    expect(insertDollar(dollar)).toBeNull();
    expect(insertBracket(bracket, ")")).toBeNull();
    expect(normalized(type(dollar, "$"))).toEqual(normalized(type(bracket, ")")));
  });

  it("已插入的普通空白不能被 $ 越过，和 ) 一样原样插入闭合字符", () => {
    const run = (open: string, close: string) => {
      let state = type(type(stateFor(), open), "x ");
      state = state.update({ selection: { anchor: 2 } }).state;
      return normalized(type(state, close));
    };
    expect(run("$", "$")).toEqual(run("(", ")"));
  });
});

describe("自动补出的 $ 状态", () => {
  it("前方插入、内部编辑后跟踪真实闭合符；跳过后消费记录", () => {
    let state = type(stateFor(), "$");
    state = state.update({ changes: { from: 0, insert: "前 " } }).state;
    state = type(state, "x");
    expect(state.field(dollarPairs)).toEqual([{ open: 2, close: 4, display: false }]);
    const tr = insertDollar(state)!;
    expect(tr.docChanged).toBe(false);
    expect(tr.newSelection.main.head).toBe(5);
    expect(tr.state.field(dollarPairs)).toEqual([]);
  });

  it("删除定界符或用同形文本重读全文，不能留下旧跳过状态", () => {
    const state = type(type(stateFor(), "$"), "x");
    const deleted = state.update({ changes: { from: 0, to: 1 } }).state;
    expect(deleted.field(dollarPairs)).toEqual([]);
    const reloaded = state.update({
      changes: { from: 0, to: 3, insert: "$x$" },
      selection: { anchor: 2 },
    }).state;
    expect(insertDollar(reloaded)).toBeNull();
  });

  it("多光标的每个闭合符都保留；所有光标离开所在行后解除跟踪", () => {
    let state = stateFor("\n\n", 0).update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(1)]),
    }).state;
    state = type(state, "$");
    expect(state.field(dollarPairs)).toEqual([
      { open: 0, close: 1, display: false },
      { open: 3, close: 4, display: false },
    ]);
    state = state.update({ selection: { anchor: state.doc.length } }).state;
    expect(state.field(dollarPairs)).toEqual([]);
  });

  it("撤销/重做恢复自动配对信息，仍能跳过自动闭合符", () => {
    let state = type(type(stateFor(), "$"), "xyz");
    const target = {
      get state() {
        return state;
      },
      dispatch: (tr: ReturnType<EditorState["update"]>) => {
        state = tr.state;
      },
    };
    expect(undo(target)).toBe(true);
    expect(redo(target)).toBe(true);
    expect(state.field(dollarPairs)).toEqual([{ open: 0, close: 4, display: false }]);
    // CM 重做后可把光标放在整段插入的末尾；回到闭合符前仍应保留自动配对信息。
    state = state.update({ selection: { anchor: 4 } }).state;
    expect(insertDollar(state)!.newSelection.main.head).toBe(5);
  });

  it("多光标的空格手势正确映射配对位置，并分别跳过行间闭合符", () => {
    let state = stateFor("\n", 0).update({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(1)]),
    }).state;
    state = type(state, "$");
    state = insertDollarSpace(state)!.state;
    expect(state.doc.toString()).toBe("$  $\n$  $");
    expect(state.field(dollarPairs)).toEqual([
      { open: 0, close: 3, display: true },
      { open: 5, close: 8, display: true },
    ]);
    state = type(state, "x");
    const tr = insertDollar(state)!;
    expect(tr.newSelection.ranges.map((range) => range.head)).toEqual([5, 11]);
    expect(tr.state.field(dollarPairs)).toEqual([]);
  });

  it("只有自动生成的空 $$ 响应空格手势，手工/粘贴文本不被改写", () => {
    const state = type(stateFor(), "$");
    const tr = insertDollarSpace(state)!;
    expect(tr.newDoc.toString()).toBe("$  $");
    expect(tr.newSelection.main.head).toBe(2);
    expect(tr.state.field(dollarPairs)).toEqual([{ open: 0, close: 3, display: true }]);
    expect(insertDollarSpace(stateFor("$$", 1))).toBeNull();
  });
});
