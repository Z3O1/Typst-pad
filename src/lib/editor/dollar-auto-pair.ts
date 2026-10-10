// $ 输入接线：默认像 ( 配出 $|$；空格/Enter 再显式进入 Typst 行间公式。
import { EditorSelection, Prec, Transaction } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import type { CloseBracketConfig } from "@codemirror/autocomplete";
import { emptyPairBackspace, planDollarInput } from "./auto-pair";
import {
  addDollarPair,
  consumeDollarPair,
  dollarPairHistory,
  dollarPairs,
} from "./dollar-pair-state";
import { dbg } from "../core/debug";

function dollarInput(state: EditorState, text: "$" | " "): Transaction | null {
  if (state.readOnly) return null;
  const pairs = state.field(dollarPairs, false) ?? [];
  // 普通空格是高频输入；没有待展开空配对时，不读全文也不推进语法解析。
  if (
    text === " " &&
    !state.selection.ranges.some(
      (range) =>
        range.empty &&
        pairs.some((pair) => pair.open === range.head - 1 && pair.close === range.head),
    )
  )
    return null;
  const tree = ensureSyntaxTree(state, state.doc.length, 20);
  if (!tree || tree.topNode.name !== "Typst") return null;
  const doc = state.doc.toString();
  let handled = false;
  let edited = false;
  const changes = state.changeByRange((range) => {
    if (text === " ") {
      const pair = range.empty
        ? pairs.find((pair) => pair.open === range.head - 1 && pair.close === range.head)
        : undefined;
      if (pair && emptyPairBackspace(doc, range.head, tree)) {
        handled = edited = true;
        return {
          changes: { from: range.head, insert: "  " },
          range: EditorSelection.cursor(range.head + 1),
          effects: addDollarPair.of({ ...pair, close: pair.close + 2, display: true }),
        };
      }
    } else {
      const before =
        state.languageDataAt<CloseBracketConfig>("closeBrackets", range.from)[0]?.before ||
        ")]}:;>";
      const plan = planDollarInput(doc, range.from, range.to, tree, before + "$");
      if (plan.kind === "skip") {
        const close = range.from + plan.caret - 1;
        const pair = pairs.find((pair) => pair.close === close);
        if (pair && (plan.caret === 1 || pair.display)) {
          handled = true;
          return {
            range: EditorSelection.cursor(close + 1),
            effects: consumeDollarPair.of(close),
          };
        }
      }
      if (plan.kind === "wrap") {
        handled = edited = true;
        const body = doc.slice(plan.from, plan.to);
        return {
          changes: [
            { from: plan.from, insert: plan.before },
            { from: plan.to, insert: plan.after },
          ],
          range: EditorSelection.range(range.anchor + 1, range.head + 1),
          effects: addDollarPair.of({
            open: plan.from,
            close: plan.to + 1,
            display: /^\s/.test(body) && /\s$/.test(body),
          }),
        };
      }
      if (plan.kind === "insert") {
        handled = edited = true;
        return {
          changes: { from: range.from, insert: plan.text },
          range: EditorSelection.cursor(range.from + plan.caret),
          effects: addDollarPair.of({ open: range.from, close: range.from + 1, display: false }),
        };
      }
    }
    // 混合上下文的多光标：不配对处仍输入原字符，不丢光标、不吞输入。
    edited = true;
    return {
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    };
  });
  return handled
    ? state.update(changes, {
        scrollIntoView: true,
        userEvent: edited ? "input.type" : "select",
        // 纯跳过不是用户移动选区：不能在历史中留下 selection 事件，拆开前后连续输入。
        annotations: edited ? [] : Transaction.addToHistory.of(false),
      })
    : null;
}

export const insertDollar = (state: EditorState): Transaction | null => dollarInput(state, "$");
export const insertDollarSpace = (state: EditorState): Transaction | null =>
  dollarInput(state, " ");

export const dollarAutoPair = [
  dollarPairs,
  dollarPairHistory,
  Prec.high(
    EditorView.inputHandler.of((view, from, to, text, insert) => {
      const { state } = view;
      if (
        (text !== "$" && text !== " ") ||
        state.readOnly ||
        view.composing ||
        view.compositionStarted ||
        from !== state.selection.main.from ||
        to !== state.selection.main.to
      )
        return false;
      try {
        const defaultInput = insert();
        if (
          defaultInput.isUserEvent("input.paste") ||
          defaultInput.isUserEvent("input.drop") ||
          defaultInput.isUserEvent("input.type.compose")
        )
          return false;
        const transaction = dollarInput(state, text);
        if (!transaction) return false;
        view.dispatch(transaction);
        return true;
      } catch (err) {
        dbg.log("editor", "$ 自动配对失败，退回默认输入", err);
        return false;
      }
    }),
  ),
];
