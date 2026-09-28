<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
  import { EditorState, Compartment, StateField, StateEffect } from "@codemirror/state";
  import { indentUnit } from "@codemirror/language";
  import type { DecorationSet } from "@codemirror/view";
  import { basicSetup } from "codemirror";
  // Typst 语言支持走**无 wasm**的 Lezer 入口（2026-09-18）：主入口 `typst()` 的语法高亮是
  // wasm-bindgen 产物，它把同一个 wasm 解析器对象同时用于"文档变更时 edit()"与"lezer 解析时 tree()"，
  // 两者重叠就抛 `recursive use of an object detected which would lead to unsafe aliasing in rust`，
  // 之后那个窗口的语法高亮就废了（状态栏会挂一句「脚本错误」）。`typst_lezer()` 是原生 Lezer 实现，
  // 完全不碰 wasm（上游 0.5.0 起提供）。顺带：0.6.0 的它不再给标题加下划线，
  // 所以我们那份 `typst-highlight.ts` 覆盖补丁已经删掉（见 CHANGELOG）。
  import { typst_lezer } from "codemirror-lang-typst/lezer";
  import { typstHeadingHighlight } from "./typst-highlight";
  import { createEditorKeymap } from "./editor-keymap";
  import { planDollarInput } from "./auto-pair";
  import { INDENT_UNIT } from "./auto-indent";
  import { oneDark } from "@codemirror/theme-one-dark";
  import type { CompileErrorLocation } from "../core/typst-engine";
  import { squiggleRanges, offsetAt } from "../core/diagnostics-utils";
  import { planForCommand } from "../core/write-commands";
  import type { WriteCommand } from "../core/write-commands";
  import { mark } from "../core/startup-timing";
  import { dbg } from "../core/debug";
  import { anchorEffectAt, measureAnchorYMargin } from "./scroll-anchor";
  // 浏览器验收用的测试钩子（只在 `?browserdev=1` 下真的挂到 window 上，桌面版是空操作）
  import { registerEditorView, unregisterEditorView } from "../dev/editor-test-hook";

  interface Props {
    initialDoc?: string;
    onDocChange?: (doc: string, mapPosition: (pos: number, assoc?: number) => number) => void;
    onCursor?: (line: number, col: number) => void;
    doc?: string;
    theme?: "dark" | "light";
    /** 编译错误位置列表（父组件传入）；为空时不显示波浪线 */
    diagnostics?: CompileErrorLocation[];
    /** 编译前缀代码（启用前缀时传入）；波浪线位置按编译源（前缀 + 用户文档）换算回用户文档 */
    prefixCode?: string;
    /** 跳转目标（1-based 行列；seq 变化确保重复跳同一位置也触发 effect） */
    jumpTo?: { line: number; col: number; seq: number } | null;
    /** 文档模式源码层保留段落/列表输入语义；源码模式直接编辑 Typst 原文。 */
    mode?: "write" | "source";
    /** 合成期间暂停后台整页编译，源码镜像仍实时更新。 */
    onComposition?: (active: boolean) => void;
    /**
     * 自动换行（源码模式 Alt+Z 切换，状态与持久化由父组件持有）。
     * 打开时给内容加 CodeMirror 的 `cm-lineWrapping`（`white-space: break-spaces` + 断词），
     * 长行折行显示、不再需要横向滚动。
     */
    wrap?: boolean;
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
    mode = "source",
    onComposition,
    wrap = false,
  }: Props = $props();

  let host: HTMLElement;
  let view: EditorView;
  let themeCompartment = new Compartment();
  let diagnosticsCompartment = new Compartment();
  let wrapCompartment = new Compartment();
  // 已应用的换行开关：初值在 onMount 里跟 buildExtensions 一起写入（见两处注释），
  // 避免 wrap 的 $effect 首跑再做一次等价重配。不在此处读 prop：顶层读 prop 会被
  // svelte-check 判为"只捕获初值"的误用告警（state_referenced_locally）。
  let appliedWrap = false;
  let applyingExternal = false; // 外部 doc 同步时抑制 onDocChange，避免误标脏
  // 当前生效的编译错误与前缀代码（由 diagnostics/prefixCode prop 驱动；供波浪线与 hover 提示读取）
  let diagState: { list: CompileErrorLocation[]; prefix: string } = { list: [], prefix: "" };

  const revealEffect = StateEffect.define<{ from: number; to: number } | null>();
  const revealField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const effect of tr.effects) {
        if (!effect.is(revealEffect)) continue;
        const range = effect.value;
        value =
          range && range.to > range.from
            ? Decoration.set([
                Decoration.mark({ class: "cm-source-reveal" }).range(range.from, range.to),
              ])
            : Decoration.none;
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  /**
   * 输入 `$` 时自动补出配对的定界符（用户要求「加入功能：自动补全 $$」，判定见 auto-pair.ts）：
   * 独占一行 → `$  $`（行间公式脚手架，光标在中间）；行内 → `$$`；右侧已有闭合 `$` → 只把光标
   * 移过去。**只在"当前是空选区 + 输入内容恰好是 `$`"时介入**，其它一律返回 false 交给 CodeMirror
   * 默认行为（不碰粘贴、不碰 IME 组字、不碰选中替换）。
   *
   * 异常兜底：任何抛错都返回 false 退回默认输入 —— 输入链路绝不能因为配对逻辑而吞掉按键
   * 输入扩展异常不能阻止默认输入。
   */
  const dollarAutoPair = EditorView.inputHandler.of((target, from, to, text) => {
    if (text !== "$" || from !== to) return false;
    try {
      const plan = planDollarInput(target.state.doc.toString(), from);
      if (plan.kind === "none") return false;
      target.dispatch({
        changes: plan.kind === "insert" ? { from, to, insert: plan.text } : undefined,
        selection: { anchor: from + plan.caret },
      });
      return true;
    } catch (err) {
      dbg.log("editor", "$ 自动配对失败，退回默认输入", err);
      return false;
    }
  });

  function buildExtensions() {
    return [
      basicSetup,
      // 自定义编辑快捷键（Prec.high，优先于 basicSetup 默认键位）。**模式感知**：
      // 写作模式先把 Enter 交给 typst 的列表命令（续项 / 空项退出），它不认才沿用上一行缩进
      createEditorKeymap({ isWriteMode: () => mode === "write" }),
      // 一档缩进 = 4 个空格（用户要求「缩进应该是四格」）：Ctrl+Tab / Ctrl+Shift+Tab 与语言侧
      // 自动缩进都走这个 facet。普通 Tab / Shift+Tab **不走它** —— Tab 插入制表符本身（有选区
      // 给行首加一个 tab，有补全候选先接受所选候选），Shift+Tab 反缩进（见 editor-keymap.ts）。
      // 回车那条也**不用它** —— 新行照抄上一行实际的前导空白（见 auto-indent.ts）。
      indentUnit.of(INDENT_UNIT),
      typst_lezer(),
      typstHeadingHighlight, // 压掉默认高亮给标题加的下划线（见 typst-highlight.ts 的根因注释）
      dollarAutoPair, // `$` 自动配对（空选区输入 `$` 时补出定界符）
      themeCompartment.of(theme === "dark" ? oneDark : []),
      diagnosticsCompartment.of(diagnosticsExtensions()),
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
      diagTheme,
      revealField,
      EditorView.domEventHandlers({
        compositionstart: () => {
          onComposition?.(true);
          return false;
        },
        compositionend: () => {
          queueMicrotask(() => {
            if (view) onComposition?.(false);
          });
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternal) {
          onDocChange?.(update.state.doc.toString(), (pos, assoc) =>
            update.changes.mapPos(pos, assoc),
          );
        }
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        if (update.selectionSet || update.docChanged) onCursor?.(line.number, head - line.from + 1);
      }),
    ];
  }

  onMount(() => {
    mark("editor-mount-start");
    // 先写入初始诊断，再创建 view：buildExtensions 会按当时 diagState 生成装饰
    diagState = { list: diagnostics ?? [], prefix: prefixCode ?? "" };
    // 同理：换行开关的初值也由 buildExtensions 按当时的 wrap 建好，这里标记为"已应用"
    appliedWrap = wrap === true;
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: initialDoc, extensions: buildExtensions() }),
    });
    mark("editor-created");
    registerEditorView(view);

    return () => {
      // 视图销毁：让已经排队的那次"模式切换恢复"作废（它要去动一个已经拆掉的视图）
      caretAnchorEpoch += 1;
      caretAnchor = null;
      unregisterEditorView(view);
      view.destroy();
    };
  });

  // 外部 doc 变化（如打开文件）时替换编辑器全文。
  // 两条约束，缺一就会出现"切个模式，未保存的新内容退回上一版"（实测被反馈）：
  // 1. **同一个外部值只推一次**：effect 因任何原因重跑（组件重挂载、props 重新生效）时，
  //    已推过的值不再二次覆盖编辑器里正在编辑的内容；
  // 2. 父组件的 doc 是**实时镜像**（见 +page.svelte 的 editorDoc），正常情况下与编辑器内容
  //    永远相等，这里的相等判断会把绝大多数重跑变成无副作用的一次比较。
  let appliedExternalDoc: string | undefined = undefined;
  $effect(() => {
    if (!view || doc === undefined) return;
    if (doc === appliedExternalDoc) return;
    appliedExternalDoc = doc;
    const current = view.state.doc.toString();
    if (doc === current) return;
    applyingExternal = true;
    try {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: doc },
        effects: revealEffect.of(null),
      });
    } finally {
      applyingExternal = false;
    }
    dbg.log("editor", `外部文档替换 ${current.length} → ${doc.length} 字符`);
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

  // 源码层主题独立于完整页面的滤镜，不重建视图。
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: [themeCompartment.reconfigure(theme === "dark" ? oneDark : [])],
    });
  });

  /**
   * 自动换行开关（源码模式 Alt+Z）：只重配这一条扩展，不动文档、选区与滚动锚点。
   * 用 Compartment 而不是重建 EditorView —— 重建会丢掉撤销历史与光标位置。
   */
  $effect(() => {
    if (!view) return;
    const on = wrap === true;
    if (on === appliedWrap) return;
    appliedWrap = on;
    view.dispatch({
      effects: wrapCompartment.reconfigure(on ? EditorView.lineWrapping : []),
    });
  });

  /**
   * 切换界面模式时"把光标留在原处"用的锚点（用户要求：「切换模式不应该改变光标位置」）。
   *
   * 背景：写作模式 ↔ 源码模式换的是**整套布局**（单栏 16px / 行距 1.9 / 正文衬线 ↔ 双栏
   * 14px / 等宽 + 折行开关 + 编辑区只剩一半宽），而 CodeMirror 的滚动锚点是"最上面那条可见行"，
   * 不是光标。于是切完之后光标常被甩出视口：实测 40 行文档、光标在第 30 行（视口 y=415）时
   * 切一次模式，`scroller.scrollTop` 归零，切回写作模式后光标在 **y=920**（视口只有 800）——
   * 用户看到的就是"光标位置变了 / 光标不见了"。
   * （注意：**不是**折行重配导致的：源码模式下单独按 Alt+Z 切换折行，scrollTop 2920 纹丝不动。）
   *
   * 做法：切换**前**记下光标在视口里的偏移（由页面在改 viewMode 之前调 `captureCaretAnchor`），
   * 布局换完之后把这个偏移**表达成 CodeMirror 自己的滚动目标**（`scrollIntoView` 的 yMargin），
   * 而不是自己去写 `scrollTop`。见 scroll-anchor.ts 顶部那段实测说明：直接写 scrollTop 会被
   * CM 的 measure 循环再改一次，两次修正叠加反而偏得更多（实测偏 91px）。
   * 光标切换前本来就在视口外（用户手动滚走了）时**不做任何事** —— 那是用户的意图，别把他拽回来。
   */
  let caretAnchor: { pos: number; offsetFromTop: number } | null = null;
  /**
   * 在途恢复请求的代号。三种情况下 +1，让已经排队但还没跑的那次恢复**作废**：
   * ① 又捕获了一次锚点（用户连续按 Ctrl+E）；② 视图销毁。见 restoreCaretAnchor。
   */
  let caretAnchorEpoch = 0;

  /** 记下光标当前在视口里的高度（页面在改 viewMode **之前**调用；见 restoreCaretAnchor） */
  export function captureCaretAnchor(): void {
    // 捕获前清掉旧 anchor 并作废在途请求：连续切换时不该再按上一轮的位置去滚
    caretAnchorEpoch += 1;
    caretAnchor = null;
    if (!view) return;
    const pos = view.state.selection.main.head;
    const caret = view.coordsAtPos(pos);
    if (!caret) return;
    const offsetFromTop = caret.top - view.scrollDOM.getBoundingClientRect().top;
    // 视口外（含贴边）不接管：那是用户自己滚出去的位置
    if (offsetFromTop < 0 || offsetFromTop > view.scrollDOM.clientHeight) return;
    caretAnchor = { pos, offsetFromTop };
  }

  /**
   * 换完布局把光标调回原来的屏幕高度。
   *
   * 三步，顺序有讲究（实测踩过）：
   *  1. **读布局**放在 CM 的 `requestMeasure().read` 里：那里是官方允许读 rect 的时机，
   *     也不会在别处逼出计划外的重排；
   *  2. **事务不能在 `write` 里派发**：measure 的 write 阶段 `updateState` 仍是 Updating，
   *     `view.dispatch` 会抛 `Calls to EditorView.update are not allowed while an update is
   *     in progress`（实测：模式切换时那次调回**整条静默失效**，光标照旧被甩走）。
   *     所以用微任务推迟到这次 measure 结束之后；
   *  3. 滚动目标由 CM 自己的测量循环消费（`scrollIntoView` + yMargin），**不写 scrollTop**。
   * `epoch` 与当前代号不符（又捕了一次 / 视图销毁）就直接作废，不做任何补偿。
   */
  function restoreCaretAnchor(epoch: number): void {
    if (epoch !== caretAnchorEpoch) return;
    const target = view;
    const anchor = caretAnchor;
    caretAnchor = null;
    if (!target || !anchor) return;
    target.requestMeasure({
      read: () => {
        // 整体 try/catch：视图在排队期间被销毁时 `scrollDOM.getBoundingClientRect()` 会抛，
        // 而 read 抛错会被 CodeMirror 记成 `logException` → 状态栏弹「脚本错误」。抛了就当
        // 这次不还原（与 measureAnchorYMargin 内部那条兜底同一个语义）。
        try {
          const box = target.scrollDOM.getBoundingClientRect();
          return measureAnchorYMargin(target, box.top + anchor.offsetFromTop, "top");
        } catch {
          return null;
        }
      },
      write: (yMargin) => {
        if (yMargin === null || epoch !== caretAnchorEpoch || target !== view) return;
        // 见上面第 2 条：这里还在 CM 的更新过程中，只能推迟一拍再派发
        queueMicrotask(() => {
          if (epoch !== caretAnchorEpoch || target !== view) return;
          target.dispatch({ effects: anchorEffectAt(anchor.pos, yMargin) });
          dbg.log(
            "editor",
            `模式切换：把光标（pos ${anchor.pos}）调回视口 y≈${Math.round(anchor.offsetFromTop)}（yMargin ${Math.round(yMargin)}，${mode} 布局）`,
          );
        });
      },
    });
  }

  // 界面模式变化 → 下一帧（等这次模式切换的布局/扩展都落地）把光标调回原处。
  // **只等一帧、不重试**：滚动目标交给 CodeMirror 自己的测量循环（见 restoreCaretAnchor）。
  let appliedMode: "write" | "source" | null = null;
  $effect(() => {
    if (!view) return;
    if (appliedMode === mode) return;
    appliedMode = mode;
    const epoch = caretAnchorEpoch;
    requestAnimationFrame(() => restoreCaretAnchor(epoch));
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
   * 执行写作模式的格式命令（菜单 / 快捷键共用）：按 write-commands 的纯函数算出编辑方案，
   * 再落成一次 CodeMirror 事务。光标落在新插入的标记内部，便于继续输入。
   */
  export function runWriteCommand(command: WriteCommand): void {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const plan = planForCommand(view.state.doc.toString(), from, to, command);
    view.dispatch({
      changes: { from: plan.from, to: plan.to, insert: plan.insert },
      selection: { anchor: plan.anchor, head: plan.head ?? plan.anchor },
      scrollIntoView: true,
    });
    view.focus();
  }

  /** 展开位置只影响独立源码层，不参与整页布局。保留同一个视图和撤销历史。 */
  export function revealAt(pos: number, range?: { from: number; to: number }): void {
    if (!view) return;
    const at = Math.max(0, Math.min(pos, view.state.doc.length));
    view.requestMeasure();
    view.dispatch({
      selection: { anchor: at },
      effects: [revealEffect.of(range ?? null), EditorView.scrollIntoView(at, { y: "center" })],
    });
    view.focus();
  }

  export function focus(): void {
    view?.requestMeasure();
    view?.focus();
  }

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
    // 调试日志：存在诊断（或画出了波浪线）时输出实际条数，对照 compile-diagnostics 排查缺失/错位
    if (diagState.list.length > 0 || ranges.length > 0) {
      dbg.log("squiggle", `count:${ranges.length}/${diagState.list.length}`);
    }
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
  .editor-host :global(.cm-scroller) {
    scrollbar-gutter: stable;
  }
  .editor-host :global(.cm-source-reveal) {
    background: var(--accent-muted, #4488bb22);
  }
</style>
