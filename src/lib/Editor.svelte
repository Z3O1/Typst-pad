<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
  import { EditorState, Compartment, StateField } from "@codemirror/state";
  import type { DecorationSet } from "@codemirror/view";
  import { basicSetup } from "codemirror";
  import { typst } from "codemirror-lang-typst";
  import { editorKeymap } from "./editor-keymap";
  import { oneDark } from "@codemirror/theme-one-dark";
  import type { CompileErrorLocation } from "./typst-engine";
  import { squiggleRanges, offsetAt } from "./diagnostics-utils";

  interface Props {
    initialDoc?: string;
    onDocChange?: (doc: string) => void;
    onCursor?: (line: number, col: number) => void;
    doc?: string;
    theme?: "dark" | "light";
    /** 编译错误位置列表（父组件传入）；为空时不显示波浪线 */
    diagnostics?: CompileErrorLocation[];
    /** 编译前缀代码（启用前缀时传入）；波浪线位置按编译源（前缀 + 用户文档）换算回用户文档 */
    prefixCode?: string;
    /** 跳转目标（1-based 行列；seq 变化确保重复跳同一位置也触发 effect） */
    jumpTo?: { line: number; col: number; seq: number } | null;
  }

  let {
    initialDoc = "",
    onDocChange,
    onCursor,
    doc,
    theme = "dark",
    diagnostics,
    prefixCode = "",
    jumpTo = null,
  }: Props = $props();

  let host: HTMLElement;
  let view: EditorView;
  let themeCompartment = new Compartment();
  let diagnosticsCompartment = new Compartment();
  let applyingExternal = false; // 外部 doc 同步时抑制 onDocChange，避免误标脏
  // 当前生效的编译错误与前缀代码（由 diagnostics/prefixCode prop 驱动；供波浪线与 hover 提示读取）
  let diagState: { list: CompileErrorLocation[]; prefix: string } = { list: [], prefix: "" };

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
    // 先写入初始诊断，再创建 view：buildExtensions 会按当时 diagState 生成装饰
    diagState = { list: diagnostics ?? [], prefix: prefixCode ?? "" };
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
    const pos = offsetAt(view.state.doc, jumpTo.line, jumpTo.col);
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

  // 编译错误（diagnostics）/ 前缀代码（prefixCode）变化：通过 Compartment 重配，
  // 刷新波浪线与 hover 提示（reconfigure 会重跑 StateField.create，见 diagnostics-utils）
  $effect(() => {
    if (!view) return;
    const next = diagnostics ?? [];
    const prefix = prefixCode ?? "";
    if (next === diagState.list && prefix === diagState.prefix) return;
    diagState = { list: next, prefix };
    view.dispatch({
      effects: diagnosticsCompartment.reconfigure(diagnosticsExtensions()),
    });
  });

  /**
   * 编辑器是否存在非空选区（供右键菜单计算剪切/复制是否可点）。
   * 基于 CM6 state 而非原生 selection：多光标/编辑器未聚焦时依然准确。
   */
  export function hasSelection(): boolean {
    // 多选区（多光标）下任一选区非空即视为有选区：遍历 selection.ranges
    return view.state.selection.ranges.some((r) => r.from !== r.to);
  }

  /** 全选：dispatch 选区覆盖全文并聚焦（CM6 原生 selectAll 命令的同义实现） */
  export function selectAll(): void {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }

  /**
   * 执行剪贴板命令（右键菜单调用）：聚焦编辑器后走 document.execCommand。
   * 选择 execCommand 而非 navigator.clipboard：
   * - WebView2（Chromium）中 execCommand 在用户手势（菜单点击）内同步执行且稳定，
   *   cut/paste 无需额外权限；navigator.clipboard 为异步且受权限策略/聚焦约束；
   * - CM6 内置的 copy/cut 命令内部同样依赖 execCommand 或 ClipboardEvent 模拟，
   *   直接调用最简，不引入事件派发的兼容成本。
   */
  export function execCommand(cmd: "cut" | "copy" | "paste"): void {
    view.focus();
    document.execCommand(cmd);
  }

  /** 依据当前 diagState 生成红色波浪线装饰集（位置计算见 diagnostics-utils.squiggleRanges） */
  function computeDeco(state: EditorState): DecorationSet {
    const ranges = squiggleRanges(state.doc, diagState.list, diagState.prefix);
    if (ranges.length === 0) return Decoration.none;
    return Decoration.set(
      ranges.map((r) => Decoration.mark({ class: "cm-diag-wavy" }).range(r.from, r.to)),
      true,
    );
  }

  /** 查找覆盖 pos 的错误（供 hover 提示） */
  function diagAt(state: EditorState, pos: number): CompileErrorLocation | undefined {
    return squiggleRanges(state.doc, diagState.list, diagState.prefix).find(
      (r) => pos >= r.from && pos < r.to,
    )?.diag;
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
