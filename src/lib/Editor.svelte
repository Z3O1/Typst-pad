<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { EditorState, Compartment } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { typst } from "codemirror-lang-typst";
  import { oneDark } from "@codemirror/theme-one-dark";

  interface Props {
    initialDoc?: string;
    onDocChange?: (doc: string) => void;
    onCursor?: (line: number, col: number) => void;
    doc?: string;
    theme?: "dark" | "light";
  }

  let { initialDoc = "", onDocChange, onCursor, doc, theme = "dark" }: Props = $props();

  let host: HTMLElement;
  let view: EditorView;
  let themeCompartment = new Compartment();
  let applyingExternal = false; // 外部 doc 同步时抑制 onDocChange，避免误标脏

  function buildExtensions() {
    return [
      basicSetup,
      typst(),
      themeCompartment.of(theme === "dark" ? oneDark : []),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternal) {
          onDocChange?.(update.state.doc.toString());
        }
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        onCursor?.(line.number, head - line.from + 1);
      }),
    ];
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: initialDoc, extensions: buildExtensions() }),
    });

    return () => {
      view.destroy();
    };
  });

  // 外部 doc 变化（如打开文件）时替换编辑器全文
  $effect(() => {
    if (!view || doc === undefined) return;
    const current = view.state.doc.toString();
    if (doc !== current) {
      applyingExternal = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: doc },
      });
      applyingExternal = false;
    }
  });

  // 主题切换：通过 Compartment 动态重配
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(theme === "dark" ? oneDark : []),
    });
  });
</script>

<div class="editor-host" bind:this={host}></div>

<style>
  .editor-host {
    height: 100%;
  }

  .editor-host :global(.cm-editor) {
    height: 100%;
    font-size: 14px;
  }

  .editor-host :global(.cm-editor.cm-focused) {
    outline: none;
  }
</style>
