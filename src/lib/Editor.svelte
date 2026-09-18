<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, Decoration, hoverTooltip } from "@codemirror/view";
  import { EditorState, Compartment, StateField } from "@codemirror/state";
  import type { Text } from "@codemirror/state";
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
  import { editorKeymap } from "./editor-keymap";
  import { planDollarInput } from "./auto-pair";
  import { INDENT_UNIT } from "./auto-indent";
  import { oneDark } from "@codemirror/theme-one-dark";
  import type { CompileErrorLocation, MathRender } from "./typst-engine";
  import type { Block } from "./block-plan";
  import { squiggleRanges, offsetAt } from "./diagnostics-utils";
  import { livePreview, refreshLivePreview } from "./live-preview";
  import type { MathRequest } from "./live-preview";
  import { planForCommand } from "./write-commands";
  import type { WriteCommand } from "./write-commands";
  import { mark } from "./startup-timing";
  import { anchorPosEffect } from "./scroll-anchor";
  import { WRITE_FONT_STACK } from "./editor-font";
  import { dbg } from "./debug";

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
    /**
     * 界面模式：
     * - "write"  写作模式（仿 Typora）：整页纸张、衬线正文、无行号、公式/标记就地渲染；
     * - "source" 源码模式：等宽代码编辑器 + 行号，显示 Typst 源码。
     */
    mode?: "write" | "source";
    /** 公式渲染结果查询（父组件维护缓存；key 见 math-ranges.mathCacheKey） */
    lookupMath?: (key: string) => MathRender | undefined;
    /** 需要渲染的公式（父组件去重 / 防抖后调 Rust 侧 compile_math） */
    onMathRequest?: (requests: MathRequest[]) => void;
    /** 渲染结果代次：变化时重整装饰（父组件收到新渲染结果后自增） */
    mathVersion?: number;
    /**
     * 写作模式的**块级切片**（父组件每次 compile_blocks 后更新）：
     * 非光标所在块显示成引擎自己画的那一块，光标所在块保持源码。
     * null / 空 = 关闭（源码模式、后端不支持该命令时都走这条路，行为与加此功能前一致）。
     * 见 docs/文档模式渲染保真-调研.md。
     */
    blocks?: Block[] | null;
    /**
     * **文档正文实际字号**（pt，来自 Rust 侧 compile_blocks 的 `textPt`）：写作模式的源码透镜
     * 按它渲染（`--write-doc-px = textPt × 4/3`），于是光标进出块时字号、行高都不跳
     * （用户：「不要光标在哪里哪里就变大了」）。缺省用 typst 默认 11pt。
     */
    docTextPt?: number;
    /** 块切片代次：变化时重整块装饰（父组件收到新编译结果后自增） */
    blocksVersion?: number;
    /** 视口内出现"能渲染但还没有切片"的块：父组件去抖后按新窗口重编译 */
    onBlocksNeeded?: () => void;
    /**
     * **点击定位**（阶段 2）：点在某张切片上的 `(xPt, yPt)`（页面坐标，pt）→ 光标位置。
     * 父组件负责换算（字节 ↔ 位置）与 IPC（Rust 侧 `block_hit_test`）；返回 null =
     * 定不了位，编辑器退回"光标落到块首"。见 block-hit.ts 与 live-preview 的说明。
     */
    onCropClick?: (req: {
      page: number;
      xPt: number;
      yPt: number;
      from: number;
      to: number;
    }) => Promise<number | null>;
    /** **切片里的链接被点**（阶段 3）：父组件交给 opener 插件打开（不移动光标、不吞点击） */
    onOpenLink?: (href: string) => void;
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
    lookupMath,
    onMathRequest,
    mathVersion = 0,
    blocks = null,
    blocksVersion = 0,
    docTextPt = 11,
    onBlocksNeeded,
    onCropClick,
    onOpenLink,
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

  /** 所见即所得扩展的实时选项：用闭包读最新 prop，避免重建扩展时丢状态 */
  const livePreviewOptions = {
    // 内联渲染只在写作模式开启：源码模式下要看到真正的 Typst 源码
    enabled: () => mode === "write",
    prefix: () => prefixCode ?? "",
    lookup: (key: string) => lookupMath?.(key),
    onRequest: (requests: MathRequest[]) => onMathRequest?.(requests),
    dark: () => theme === "dark",
    // 块级切片：只在写作模式交给渲染层，源码模式一律 null（要看到真正的源码）
    blocks: () => (mode === "write" ? (blocks ?? null) : null),
    onBlocksNeeded: () => onBlocksNeeded?.(),
    // 点击定位（阶段 2）：父组件换算成字节偏移后问 Rust，编辑器只负责落光标
    onCropClick: (req: { page: number; xPt: number; yPt: number; from: number; to: number }) =>
      onCropClick?.(req) ?? Promise.resolve(null),
    onOpenLink: (href: string) => onOpenLink?.(href),
    // 编译错误所在的块不许被切片盖住（波浪线画在源码上，见 live-preview 的说明）。
    // 用参数里的 doc：StateField 计算时 view 上的 state 还是旧的
    diagnosticRanges: (doc: Text) =>
      diagState.list.length === 0
        ? []
        : squiggleRanges(doc, diagState.list, diagState.prefix).map((r) => ({
            from: r.from,
            to: r.to,
          })),
  };

  /**
   * 输入 `$` 时自动补出配对的定界符（用户要求「加入功能：自动补全 $$」，判定见 auto-pair.ts）：
   * 独占一行 → `$  $`（行间公式脚手架，光标在中间）；行内 → `$$`；右侧已有闭合 `$` → 只把光标
   * 移过去。**只在"当前是空选区 + 输入内容恰好是 `$`"时介入**，其它一律返回 false 交给 CodeMirror
   * 默认行为（不碰粘贴、不碰 IME 组字、不碰选中替换）。
   *
   * 异常兜底：任何抛错都返回 false 退回默认输入 —— 输入链路绝不能因为配对逻辑而吞掉按键
   * （与装饰/widget 的 try/catch 是同一条纪律）。
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
      editorKeymap, // 自定义编辑快捷键（Prec.high，优先于 basicSetup 默认键位）
      // 一档缩进 = 4 个空格（用户要求「Tab 应该是四格缩进」）：Tab / Shift+Tab 与语言侧自动缩进
      // 都走这个 facet。回车那条**不用它** —— 新行照抄上一行实际的前导空白（见 auto-indent.ts）。
      indentUnit.of(INDENT_UNIT),
      typst_lezer(),
      typstHeadingHighlight, // 压掉默认高亮给标题加的下划线（见 typst-highlight.ts 的根因注释）
      dollarAutoPair, // `$` 自动配对（空选区输入 `$` 时补出定界符）
      themeCompartment.of(theme === "dark" ? oneDark : []),
      diagnosticsCompartment.of(diagnosticsExtensions()),
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
      diagTheme,
      livePreview(livePreviewOptions), // 公式内联渲染（开关与缓存由父组件注入）
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

    return () => {
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

  // 主题 / 模式切换：重配 CodeMirror 主题，并重整公式装饰
  // （暗色要反色；写作↔源码要立刻收起/露出所有 widget，见 live-preview）
  $effect(() => {
    if (!view) return;
    // 两种模式都要跟着主题走：**写作模式不能只靠 CSS 上色**——CodeMirror 基础主题自带
    // 白底黑字，若暗色下不挂 oneDark，编辑器仍是白底，而公式 widget 已被 invert 成白色
    // → 白底白字看不见（实测踩过：深色主题下公式"消失"）。
    view.dispatch({
      effects: [
        themeCompartment.reconfigure(theme === "dark" ? oneDark : []),
        refreshLivePreview.of(null),
      ],
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
   * 布局换完之后把滚动调回去，让光标回到原来的屏幕高度；调到文档端点时会被夹住，但仍在视口内。
   * 光标切换前本来就在视口外（用户手动滚走了）时**不做任何事** —— 那是用户的意图，别把他拽回来。
   */
  let caretAnchor: { pos: number; offsetFromTop: number } | null = null;

  /** 记下光标当前在视口里的高度（页面在改 viewMode **之前**调用；见 restoreCaretAnchor） */
  export function captureCaretAnchor(): void {
    if (!view) return;
    const pos = view.state.selection.main.head;
    const caret = view.coordsAtPos(pos);
    if (!caret) return;
    const offsetFromTop = caret.top - view.scrollDOM.getBoundingClientRect().top;
    // 视口外（含贴边）不接管：那是用户自己滚出去的位置
    if (offsetFromTop < 0 || offsetFromTop > view.scrollDOM.clientHeight) return;
    caretAnchor = { pos, offsetFromTop };
  }

  /** 换完布局把滚动调回去，让光标回到原来的屏幕高度（越界时夹在视口内） */
  function restoreCaretAnchor(): void {
    const anchor = caretAnchor;
    caretAnchor = null;
    if (!view || !anchor) return;
    const scroller = view.scrollDOM;
    const caret = view.coordsAtPos(view.state.selection.main.head);
    if (!caret) return;
    const current = caret.top - scroller.getBoundingClientRect().top;
    const target = Math.max(0, Math.min(anchor.offsetFromTop, scroller.clientHeight - 1));
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const next = Math.max(0, Math.min(maxScroll, scroller.scrollTop + (current - target)));
    if (Math.abs(next - scroller.scrollTop) > 1) {
      dbg.log(
        "editor",
        `模式切换：把光标调回视口 y≈${Math.round(target)}（滚动 ${Math.round(scroller.scrollTop)} → ${Math.round(next)}）`,
      );
      scroller.scrollTop = next;
    }
  }

  // 界面模式变化 → 下一帧（再下一帧，等 CodeMirror 自己的 measure 跑完）把光标调回原处
  let appliedMode: "write" | "source" | null = null;
  $effect(() => {
    if (!view) return;
    if (appliedMode === mode) return;
    appliedMode = mode;
    requestAnimationFrame(() => requestAnimationFrame(restoreCaretAnchor));
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
   * 所见即所得：开关切换、渲染结果到货（mathVersion 自增）、前缀变化（缓存键变化）
   * 时重整公式装饰。读这三个响应式值即建立依赖。
   *
   * 滚动锚定交给 CodeMirror 自己（它的 measure 循环里就有 anchor diff，装饰换掉 widget 导致的
   * 高度变化会被它补偿）—— 第一版在这里又加了一层自己的锚定，结果与它叠加（见 scroll-anchor.ts
   * 的说明）。只有"把光标钉在某个屏幕高度"（点击定位 / 翻页）才需要我们显式给滚动目标。
   */
  $effect(() => {
    if (!view) return;
    void mode;
    void mathVersion;
    void blocksVersion; // 新的块切片到货 → 重整块装饰
    void prefixCode; // 前缀变化 → 编译上下文与缓存键变化，重新请求与渲染
    view.dispatch({ effects: refreshLivePreview.of(null) });
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

  /**
   * 写作模式**正文列宽**（CSS px）：CodeMirror 内容列的实际宽度。
   *
   * 用于给写作模式的块级渲染定版心宽（pt = px × 3/4）—— 版心宽是**编译期输入**
   * （Rust 侧注入 `#set page(width: …)`），所以列宽变了要重新编译（见 +page.svelte 的
   * scheduleWritingReflow）。写作模式下左右各 48px 留白挂在 `.cm-scroller` 上，
   * 因此 contentDOM 的宽度就是文字列宽度；源码模式另有用途，不在此处区分。
   */
  /**
   * 当前视口覆盖的文档范围（CodeMirror 位置）：父组件用它算块级渲染的**窗口**
   * （只渲视口附近的块，见 compile_blocks 的 wantFrom/wantTo）。
   * 取不到（视图未建）时返回 null，调用方退化成"整篇都渲"（短文档无所谓）。
   */
  export function visibleRange(): { from: number; to: number } | null {
    if (!view) return null;
    try {
      const ranges = view.visibleRanges;
      if (ranges.length === 0) return null;
      return {
        from: ranges[0].from,
        to: ranges[ranges.length - 1].to,
      };
    } catch {
      return null;
    }
  }

  export function contentWidthPx(): number {
    if (!view) return 0;
    try {
      return view.contentDOM.clientWidth;
    } catch {
      return 0;
    }
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

<!-- style:--write-doc-px = 文档正文字号（pt → px，1pt = 4/3px）：写作模式的正文与行高按它渲染，
     与引擎切片完全一致，光标进出块时字号不跳（见样式里 .editor-host.write 的说明）。
     style:--write-font-stack = 写作模式的字体栈（与 typst 默认族顺序一致）：字号/行高/字体
     三条腿齐了，源码形态与切片形态才是同一套排版（见 editor-font.ts） -->
<div
  class="editor-host"
  class:write={mode === "write"}
  style:--write-doc-px={`${(docTextPt * 4) / 3}px`}
  style:--write-font-stack={WRITE_FONT_STACK}
  bind:this={host}
></div>

<style>
  .editor-host {
    height: 100%;
  }

  .editor-host :global(.cm-editor) {
    height: 100%;
    font-size: 14px;
  }

  /* ---------- 写作模式（仿 Typora）：衬线正文 + 无行号 + 宽行距 ---------- */
  /*
   * 写作模式的正文字号 = **文档实际字号**（Rust 侧 compile_blocks 的 `textPt`，前端换算成 px
   * 挂在 `--write-doc-px` 上），行高 = typst 的 leading（`par.leading` 默认 0.65em → 1.65）。
   *
   * 为什么必须这样：写作模式是"非光标块显示引擎切片 + 光标所在块展开成源码"，两者字号不一致时
   * 光标一进某一块，那一块的字和行高就会**变大**（用户：「不要光标在哪里哪里就变大了」）。
   * 实测旧行为：编辑区固定 16px、行高 1.9，而切片是 typst 默认 11pt（14.67px）、行高 1.65
   * → 光标一进去，字大 9%、行盒高 26%。现在字体与行高都跟着文档走：
   * 默认文档 14.67px / 1.65，`#set text(size: 12pt)` 的文档 16px / 1.65。
   * 兜底 14.6667px = typst 默认 11pt（旧后端没给 textPt 时，与切片仍然对得上）。
   */
  .editor-host.write :global(.cm-editor) {
    font-size: var(--write-doc-px, 14.6667px);
  }

  /*
   * 字体必须落在 .cm-content 上：CodeMirror 的基础主题给 .cm-content 自己钉了
   * `font-family: monospace`，只改 .cm-editor 是**不生效**的（实测：写作模式正文仍是等宽）。
   * 字体与预览/PDF 输出一致（思源宋体），所见即所得才对得上。
   */
  .editor-host.write :global(.cm-content) {
    /* 字体栈由 editor-font.ts 的 WRITE_FONT_STACK 提供（拉丁 Libertinus → 中文思源宋体 → 系统宋体）；
       打包字体装上之前/装不上时，那两族名自然落空、退回后面的系统族，行为与从前一致。 */
    font-family: var(
      --write-font-stack,
      "Noto Serif CJK SC",
      "Songti SC",
      "Source Han Serif SC",
      Georgia,
      serif
    );
  }

  /* 写作模式下编辑器底色/文字跟随主题变量（暗色时与纸张底色一致，不漏白底） */
  .editor-host.write :global(.cm-editor),
  .editor-host.write :global(.cm-scroller),
  .editor-host.write :global(.cm-gutters) {
    background-color: var(--bg-paper, inherit);
  }

  /* 行内原始文本 / 代码块在写作模式下仍是等宽（那是代码，不该用衬线） */
  .editor-host.write :global(.cm-markup-raw),
  .editor-host.write :global(.cm-raw-block-pre) {
    font-family: Consolas, "Courier New", monospace;
  }

  /* 行号槽 / 折叠箭头：Typora 没有，写作模式下整条隐藏 */
  .editor-host.write :global(.cm-gutters) {
    display: none;
  }

  /* 当前行高亮（代码编辑器的味道）在写作模式下不要 */
  .editor-host.write :global(.cm-activeLine) {
    background: transparent;
  }

  /* 纸张内留白：左右各 48px（Typora 式阅读边距）**必须留在 .cm-content 之外**。
     CodeMirror 画整行选区的底色时会把 .cm-content 的左右内边距一起铺满 →
     选个全选就比文字列两边各凸出 48px（用户反馈「两边不应该凸出来」）。
     放到 .cm-scroller 上：内容盒 == 文字列，高亮自然对齐文字。 */
  .editor-host.write :global(.cm-scroller) {
    padding-left: 48px;
    padding-right: 48px;
    /* 滚动条槽位常驻：写作模式的**版心宽是编译期输入**（Rust 侧按列宽注入 #set page），
       如果滚动条出现/消失会让列宽来回变，就形成"重编译 → 内容高度变 → 滚动条变 → 再重编译"
       的反馈环（预览区当年就是这么闪的，见 docs/WYSIWYG-调研.md 4.3）。 */
    scrollbar-gutter: stable;
  }
  .editor-host.write :global(.cm-content) {
    /* 只留竖直方向：顶部呼吸感 + 底部留白（末行不贴底边） */
    padding: 40px 0 160px;
    /* typst 的 `par.leading` 默认 0.65em ⇒ 行高 1.65em（与切片里的行距一致，见上） */
    line-height: 1.65;
    caret-color: var(--typora-caret, currentColor);
  }

  /* 标题：字号梯度**必须跟 typst 一致**（`typst-library/src/model/heading.rs` 的 ShowSet：
     level 1 = 1.4em、level 2 = 1.2em、level 3 及以下 = 1.0em，只加粗、不再变大），
     行高用 typst 的 leading（1.65em，见上）—— 这样光标进标题块时，那一行的高度与切片对得上。
     以前这里是仿 Typora 的 1.8 / 1.5 / 1.25 / 1.08em：块级渲染落地后就成了 bug，
     光标一进标题块那一行就比切片大 36%~40%（用户报「在标题所在块，标题就会变的很大」）。
     上下留白也用 typst 的块间距（heading.rs 的 above / below，单位是**正文字号**的 em，
     而 padding 正好挂在字号 = 正文的行上，所以直接写数值即可）：
     level 1 → above 1.8em / below 0.75em；level 2 及以下 → above 1.44em / below 0.75em。 */
  /*
   * 标题行**不加上下 padding**（实测取舍，别再加回去）：切片是"按 y 序把页面切成的带"，
   * 标题周围的空白**已经分散在相邻块的带里**（带在相邻墨迹的中点处切），所以源码形态不需要
   * 再补一份 —— 补了反而跳：
   *   padding 0        → 光标进标题块，页面高度 +3px
   *   0.6em / 0.2em    → +19px（旧值）
   *   typst 的 1.8em / 0.75em → +40px
   * 三种都实测过（`.browser-check/probe-pagejump.mjs` 那套量法，600px 视口 + 真实夹具）。
   */

  .editor-host.write :global(.cm-markup-heading-1) {
    font-size: 1.4em;
    line-height: 1.65;
    font-weight: 700;
  }

  .editor-host.write :global(.cm-markup-heading-2) {
    font-size: 1.2em;
    line-height: 1.65;
    font-weight: 700;
  }

  .editor-host.write :global(.cm-markup-heading-3) {
    font-size: 1em;
    line-height: 1.65;
    font-weight: 600;
  }

  .editor-host.write :global(.cm-markup-heading-4),
  .editor-host.write :global(.cm-markup-heading-5),
  .editor-host.write :global(.cm-markup-heading-6) {
    font-size: 1em;
    line-height: 1.65;
    font-weight: 600;
  }

  /* 列表符号/序号：替换出来的字符与正文同色、不与正文基线错位 */
  .editor-host.write :global(.cm-markup-replacement) {
    color: var(--fg-dim);
  }

  /* 行内代码与公式 widget 的字号跟随正文 */
  .editor-host.write :global(.cm-math-widget),
  .editor-host.write :global(.cm-math-block) {
    font-size: 1em;
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
