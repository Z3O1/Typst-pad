<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
  import { EditorState, Compartment, StateField } from "@codemirror/state";
  import type { DecorationSet } from "@codemirror/view";
  import type { Range } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { typst } from "codemirror-lang-typst";
  import { editorKeymap } from "./editor-keymap";
  import { oneDark } from "@codemirror/theme-one-dark";
  import type { CompileErrorLocation } from "./typst-engine";

  interface Props {
    initialDoc?: string;
    onDocChange?: (doc: string) => void;
    onCursor?: (line: number, col: number) => void;
    doc?: string;
    theme?: "dark" | "light";
    /** 编译错误位置列表（父组件传入）；为空时不显示波浪线 */
    diagnostics?: CompileErrorLocation[];
    /** 跳转目标（1-based 行列；seq 变化确保重复跳同一位置也触发 effect） */
    jumpTo?: { line: number; col: number; seq: number } | null;
  }

  let { initialDoc = "", onDocChange, onCursor, doc, theme = "dark", diagnostics, jumpTo = null }: Props =
    $props();

  let host: HTMLElement;
  let view: EditorView;
  let themeCompartment = new Compartment();
  let diagnosticsCompartment = new Compartment();
  let applyingExternal = false; // 外部 doc 同步时抑制 onDocChange，避免误标脏
  // 当前生效的编译错误（由 diagnostics prop 驱动；供波浪线与 hover 提示读取）
  let diagList: CompileErrorLocation[] = [];

  function buildExtensions() {
    return [
      basicSetup,
      editorKeymap, // 自定义编辑快捷键（Prec.high，优先于 basicSetup 默认键位）
      typst(),
      themeCompartment.of(theme === "dark" ? oneDark : []),
      diagnosticsCompartment.of(diagnosticsExtensions()),
      diagTheme,
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
    // 先写入初始诊断，再创建 view：buildExtensions 会按当时 diagList 生成装饰
    diagList = diagnostics ?? [];
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

  // 外部跳转请求（错误列表点击条目）：定位到指定行列并居中滚动可见
  $effect(() => {
    if (!view || !jumpTo) return;
    const pos = posToOffset(view.state, jumpTo.line, jumpTo.col);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  });

  // 主题切换：通过 Compartment 动态重配
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.reconfigure(theme === "dark" ? oneDark : []),
    });
  });

  // 编译错误（diagnostics）变化：通过 Compartment 重配，刷新波浪线与 hover 提示
  $effect(() => {
    if (!view) return;
    const next = diagnostics ?? [];
    if (next === diagList) return;
    diagList = next;
    view.dispatch({
      effects: diagnosticsCompartment.reconfigure(diagnosticsExtensions()),
    });
  });

  /** 行/列（1-based）→ 文档 offset；越界时 clamp 到文档范围内 */
  function posToOffset(state: EditorState, line: number, col: number): number {
    const doc = state.doc;
    if (doc.lines === 0) return 0;
    const l = Math.min(Math.max(line, 1), doc.lines);
    const lineObj = doc.line(l);
    return lineObj.from + Math.min(Math.max(col, 1) - 1, lineObj.length);
  }

  /** 单个错误的装饰区间 [from, to)；越界或无法构成有效区间时返回 null */
  function diagRange(
    state: EditorState,
    d: CompileErrorLocation,
  ): { from: number; to: number } | null {
    const from = posToOffset(state, d.line, d.col);
    // 结束列通常指向范围后一位，减一避免越出行尾；单点错误（end == start）保证至少画 1 字符
    let to = posToOffset(state, d.endLine, Math.max(d.endCol - 1, 1));
    if (to <= from) to = from + 1;
    if (to > state.doc.length) to = state.doc.length;
    if (to <= from) return null;
    return { from, to };
  }

  /** 依据当前 diagList 生成红色波浪线装饰集 */
  function computeDeco(state: EditorState): DecorationSet {
    if (diagList.length === 0) return Decoration.none;
    const ranges: Range<Decoration>[] = [];
    for (const d of diagList) {
      const r = diagRange(state, d);
      if (r) ranges.push(Decoration.mark({ class: "cm-diag-wavy" }).range(r.from, r.to));
    }
    return Decoration.set(ranges, true);
  }

  /** 查找覆盖 pos 的错误（供 hover 提示） */
  function diagAt(state: EditorState, pos: number): CompileErrorLocation | undefined {
    return diagList.find((d) => {
      const r = diagRange(state, d);
      return r !== null && pos >= r.from && pos < r.to;
    });
  }

  /** 编译错误扩展：波浪线 StateField + hover 错误提示（经 Compartment 动态重配） */
  function diagnosticsExtensions() {
    return [
      StateField.define<DecorationSet>({
        create: (state) => computeDeco(state),
        update(deco, tr) {
          // 文档变化后基于新文档重算位置（诊断行列是绝对坐标，简单映射不可靠）
          if (tr.docChanged) return computeDeco(tr.state);
          return deco;
        },
        provide: (f) => EditorView.decorations.from(f),
      }),
      hoverTooltip((editorView, pos) => {
        const d = diagAt(editorView.state, pos);
        if (!d) return null;
        return {
          pos,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "cm-diag-tooltip";
            dom.textContent = d.message;
            return { dom };
          },
        };
      }),
    ];
  }

  // 波浪线与提示框样式：经 EditorView.theme 注入（扩展属于 script 部分，不动 style）
  const diagTheme = EditorView.theme({
    ".cm-diag-wavy": {
      textDecoration: "underline wavy #f14c4c",
      textDecorationSkipInk: "none",
    },
    ".cm-tooltip .cm-diag-tooltip": {
      backgroundColor: "#3c1f1f",
      border: "1px solid #7a3a3a",
      color: "#ffc9c9",
      fontSize: "12px",
      padding: "4px 8px",
      maxWidth: "360px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    },
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

  /* 行号使用等宽 console 字体，保证与代码列对齐 */
  .editor-host :global(.cm-gutters),
  .editor-host :global(.cm-lineNumbers),
  .editor-host :global(.cm-gutterElement) {
    font-family: Consolas, "Courier New", monospace;
  }
</style>
