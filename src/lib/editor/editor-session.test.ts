import { describe, expect, it } from "vitest";
import { Compartment, EditorState, StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { createEditorDocumentState } from "./editor-session";

const text = (state: EditorState) => state.doc.toString();

describe("createEditorDocumentState", () => {
  it.each(["B", "", "A edited"])(
    "starts a fresh undo history for a new session containing %j",
    (doc) => {
      const extensions = [history()];
      const previous = createEditorDocumentState("A", extensions).update({
        changes: { from: 1, insert: " edited" },
        selection: { anchor: 4 },
      }).state;
      expect(undoDepth(previous)).toBe(1);
      let state = createEditorDocumentState(doc, extensions, previous);
      expect(text(state)).toBe(doc);
      expect(state.selection.main.head).toBe(0);
      expect(undoDepth(state)).toBe(0);
      expect(redoDepth(state)).toBe(0);
      state = state.update({ changes: { from: doc.length, insert: " new" } }).state;
      expect(undoDepth(state)).toBe(1);
      expect(undo({ state, dispatch: (transaction) => (state = transaction.state) })).toBe(true);
      expect(text(state)).toBe(doc);
    },
  );

  it("does not carry an old redo branch into an equal-text session", () => {
    const extensions = [history()];
    let previous = createEditorDocumentState("A", extensions).update({
      changes: { from: 1, insert: " old edit" },
    }).state;
    undo({ state: previous, dispatch: (transaction) => (previous = transaction.state) });
    expect(redoDepth(previous)).toBe(1);
    const state = createEditorDocumentState("A", extensions, previous);
    expect(redo({ state, dispatch: () => {} })).toBe(false);
    expect(text(state)).toBe("A");
  });

  it("retains the live compartment configurations, root extensions and listeners", () => {
    const theme = new Compartment();
    const wrap = new Compartment();
    const diagnostics = new Compartment();
    const rootField = StateField.define({ create: () => "root", update: (value) => value });
    const initialTheme = EditorView.theme({}, { dark: true });
    const liveTheme = EditorView.theme({}, { dark: false });
    const liveDiagnostics = StateField.define({
      create: () => "current diagnostics",
      update: (value) => value,
    });
    const listener = EditorView.updateListener.of(() => {});
    const extensions = [
      history(),
      rootField,
      listener,
      theme.of(initialTheme),
      wrap.of([]),
      diagnostics.of([]),
    ];
    const previous = createEditorDocumentState("A", extensions).update({
      effects: [
        theme.reconfigure(liveTheme),
        wrap.reconfigure(EditorView.lineWrapping),
        diagnostics.reconfigure(liveDiagnostics),
      ],
    }).state;
    const state = createEditorDocumentState("B", extensions, previous, [theme, wrap, diagnostics]);
    expect(theme.get(state)).toBe(liveTheme);
    expect(wrap.get(state)).toBe(EditorView.lineWrapping);
    expect(diagnostics.get(state)).toBe(liveDiagnostics);
    expect(state.field(liveDiagnostics)).toBe("current diagnostics");
    expect(state.field(rootField)).toBe("root");
    expect(state.facet(EditorView.updateListener)).toEqual(
      previous.facet(EditorView.updateListener),
    );
  });
});
