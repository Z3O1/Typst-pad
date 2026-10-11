import { Compartment, EditorState, type Extension } from "@codemirror/state";

/** 新文档清空历史/选区，但沿用扩展与当前 compartment 配置，不重建 EditorView。 */
export function createEditorDocumentState(
  doc: string,
  extensions: Extension,
  previous?: EditorState,
  compartments: readonly Compartment[] = [],
): EditorState {
  const state = EditorState.create({ doc, extensions });
  if (!previous) return state;
  return state.update({
    effects: compartments.map((compartment) =>
      compartment.reconfigure(compartment.get(previous) ?? []),
    ),
  }).state;
}
