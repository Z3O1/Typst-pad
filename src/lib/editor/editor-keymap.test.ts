// @vitest-environment jsdom

// 编辑快捷键 keymap 的绑定断言与行为测试
// 行为测试通过 jsdom 在编辑器 DOM 上派发 keydown 事件，验证键位真正生效
// （CodeMirror 的 keydown 处理挂在 contentDOM 上，事件按真实浏览器路径派发）
// 说明：行为测试不引入 typst() 语言扩展——其 wasm 解析器在 Node 环境下对文档
// 变更会 panic；注释符号改用 EditorState.languageData 注入，键位语义不受影响。
// 缩进键：Ctrl+Tab / Ctrl+Shift+Tab 按 indentUnit（四空格）缩进；普通 Tab / Shift+Tab 自
// 2026-09-28 起被接管，2026-10-07 档宽改为设置项 tabSpaces（默认 2 空格，0 = 制表符）：
// Tab 有选区给行首加一档、无选区插一档、有补全候选先接受候选；Shift+Tab 对称退一档。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap as keymapFacet } from "@codemirror/view";
import {
  indentLess,
  indentMore,
  deleteLine,
  copyLineDown,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { autocompletion, completionStatus, startCompletion } from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { createEditorKeymap, editorKeymap } from "./editor-keymap";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { INDENT_UNIT } from "./auto-indent";
// 与 Editor.svelte buildExtensions 的键位相关扩展保持一致（typst() 不含键位，不影响断言）
// indentUnit 也要带上：Ctrl+Tab 一档缩进多宽由它决定（应用里是 4 个空格，见 auto-indent.ts）
const bindingExtensions = [basicSetup, editorKeymap, indentUnit.of(INDENT_UNIT)];

/** 行为测试用扩展：basicSetup + 自定义键位 + 注释符号定义（代替 typst()） */
const commentTokensData = EditorState.languageData.of(() => [
  { commentTokens: { block: { open: "/*", close: "*/" }, line: "//" } },
]);
const behaviorExtensions = [
  basicSetup,
  editorKeymap,
  indentUnit.of(INDENT_UNIT),
  commentTokensData,
];

const writeBehaviorExtensions = [
  basicSetup,
  createEditorKeymap({ isWriteMode: () => true }),
  indentUnit.of(INDENT_UNIT),
  typst_lezer(),
  commentTokensData,
];

/** 按优先级展平后的全部键位绑定（facet 值按 Prec 优先级排列） */
function allBindings() {
  return EditorState.create({ extensions: bindingExtensions }).facet(keymapFacet).flat();
}

describe("editorKeymap 导出与绑定", () => {
  it("导出存在，且是 EditorState 可接受的合法扩展", () => {
    // Prec.high 返回 { inner, prec } 包装对象（非数组）；能通过 EditorState.create 即合法
    expect(editorKeymap).toBeTruthy();
    expect(() => EditorState.create({ extensions: editorKeymap })).not.toThrow();
  });

  it("自定义键位齐全（Enter / Shift-Enter 也在其中）", () => {
    const keys = new Set(allBindings().map((b) => b.key));
    expect(keys).toContain("Enter");
    expect(keys).toContain("Shift-Enter");
    expect(keys).toContain("Backspace");
    // 缩进键：Ctrl+Tab（反缩进 Ctrl+Shift+Tab）仍是四空格一档；普通 Tab / Shift+Tab 也被接管
    expect(keys).toContain("Ctrl-Tab");
    expect(keys).toContain("Ctrl-Shift-Tab");
    expect(keys).toContain("Tab"); // 2026-09-28：Tab 不再交回浏览器焦点移动
    expect(keys).toContain("Shift-Tab");
    expect(keys).toContain("Mod-Shift-d");
    expect(keys).toContain("Mod-d");
    expect(keys).toContain("Mod-Shift-/");
    expect(keys).toContain("Mod-/");
  });

  it("各键位绑定到预期命令", () => {
    const bindings = allBindings();
    // 注册顺序上的第一个 Ctrl+Tab / Mod-d 才是生效的绑定（先返回 true 者胜出）
    expect(bindings.find((b) => b.key === "Ctrl-Tab")?.run).toBe(indentMore);
    expect(bindings.find((b) => b.key === "Ctrl-Shift-Tab")?.run).toBe(indentLess);
    // Tab 绑的是本文件的包装命令（候选 → 行首缩进 → 插一档，行为由下面的用例锁住）；
    // Shift-Tab 也是本文件的对称退档命令（dedentTabUnit，按 tabSpaces 退）；
    // Ctrl+Shift-Tab 仍是 indentLess（与 Ctrl+Tab 的 indentUnit 四空格配对）
    expect(bindings.find((b) => b.key === "Shift-Tab")?.run).not.toBe(indentLess);
    expect(bindings.find((b) => b.key === "Ctrl-Shift-Tab")?.run).toBe(indentLess);
    expect(typeof bindings.find((b) => b.key === "Tab")?.run).toBe("function");
    expect(typeof bindings.find((b) => b.key === "Shift-Tab")?.run).toBe("function");
    expect(bindings.find((b) => b.key === "Mod-d")?.run).toBe(deleteLine);
    expect(bindings.find((b) => b.key === "Mod-Shift-d")?.run).toBe(copyLineDown);
    expect(bindings.find((b) => b.key === "Mod-Shift-/")?.run).toBe(toggleBlockComment);
    expect(bindings.find((b) => b.key === "Mod-/")?.run).toBe(toggleComment);
    // Enter 必须换成我们那条：CM 默认的 insertNewlineAndIndent 拿语言服务的缩进，
    // 在 typst 文档里时灵时不灵（用户报「换行时应该和上一行缩进一样」）。
    // 注意 Enter 上还有 autocomplete 的 acceptCompletion（Prec.highest，缺省键位就在），
    // 补全面板开着时它先返回 true —— 那是既有行为，只要我们的命令确实挂在 Enter 上即可。
    const enterRun = bindings.find((b) => b.key === "Enter")?.run;
    const shiftEnterRun = bindings.find((b) => b.key === "Shift-Enter")?.run;
    expect(typeof enterRun).toBe("function");
    expect(typeof shiftEnterRun).toBe("function");
    // 报告 T5 起两者是**不同的包装**：Enter 先把列表命令（`insertNewTypstListItem`）调一遍、
    // Shift-Enter 试"续行"（`insertTypstListContinuation`），都不是 CM 默认的
    // `insertNewlineAndIndent`（那条的缩进来自语言服务，在 typst 文档里时灵时不灵）。
    // 源码模式下两者行为依旧等价，由下面的行为用例锁住。
    expect(enterRun).not.toBe(shiftEnterRun);
  });

  it("Mod-d 优先级高于 basicSetup 的「选中下一处」（searchKeymap）", () => {
    const bindings = allBindings();
    // basicSetup 的 searchKeymap 也有 Mod-d（selectNextOccurrence）；
    // Prec.high 保证自定义键位排在其前，find 取到的第一个必须是 deleteLine
    const modDs = bindings.filter((b) => b.key === "Mod-d");
    expect(modDs.length).toBeGreaterThanOrEqual(2);
    expect(modDs[0].run).toBe(deleteLine);
  });
});

describe("editorKeymap 行为（jsdom 按键模拟）", () => {
  beforeAll(() => {
    // jsdom 未实现 Range 的几何 API，而 CodeMirror 的部分命令（如 deleteLine 删除后
    // 移动光标、选区高亮测量）依赖它；补一个返回空集的桩避免 TypeError
    (Range.prototype as any).getClientRects = () => [];
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  /** 创建编辑器实例（挂载到 jsdom 的 body 上） */
  function makeView(doc: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    return new EditorView({ doc, parent: host, extensions: behaviorExtensions });
  }

  /** 写作模式行为测试使用原生 Lezer（避免 wasm 解析器在 Node 环境下 panic）。 */
  function makeWriteView(doc: string) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    return new EditorView({ doc, parent: host, extensions: writeBehaviorExtensions });
  }

  /** 在编辑器上派发 keydown（与真实浏览器一致：shift 修饰键通常反映到 key 上） */
  function press(view: EditorView, init: KeyboardEventInit & { code: string; keyCode: number }) {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  }

  it("Ctrl+Tab 一档缩进 = 4 个空格、Ctrl+Shift+Tab 反缩进一层", () => {
    const view = makeView("#foo\n");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true });
    // 用户要求「缩进应该是四格」：一档就是 INDENT_UNIT（4 个空格），不是 CM 默认的 2 个
    expect(view.state.doc.toString()).toBe("    #foo\n");
    expect(view.state.facet(indentUnit)).toBe(INDENT_UNIT);
    expect(INDENT_UNIT).toBe("    ");

    // Ctrl+Shift+Tab 反缩进一层
    press(view, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("#foo\n");
    view.destroy();
  });

  it("**普通 Tab = 插入一档空格**（默认 2，tabSpaces 设置），光标停在一档之后", () => {
    const view = makeView("abc");
    view.dispatch({ selection: { anchor: 1 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(view.state.doc.toString()).toBe("a  bc");
    expect(view.state.selection.main.head).toBe(3);
    view.destroy();
  });

  it("tabSpaces=0 时 Tab 插一个制表符（旧行为）；tabSpaces=4 插四个空格", () => {
    // tabSpaces 由键位的 getter 现取现算（同 isWriteMode）：用两个实例模拟两份设置
    const makeTabView = (tabSpaces: () => number) => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const view = new EditorView({
        doc: "abc",
        parent: host,
        extensions: [basicSetup, createEditorKeymap({ tabSpaces }), indentUnit.of(INDENT_UNIT)],
      });
      view.dispatch({ selection: { anchor: 1 } });
      return view;
    };

    const tabView = makeTabView(() => 0);
    press(tabView, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(tabView.state.doc.toString()).toBe("a\tbc");
    tabView.destroy();

    const spaceView = makeTabView(() => 4);
    press(spaceView, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(spaceView.state.doc.toString()).toBe("a    bc");
    spaceView.destroy();
  });

  it("**选中内容按 Tab：选区触碰的每行行首各加一档**（默认 2 空格，选区正文保留），Shift+Tab 整组退回", () => {
    // 单行内选区：行首加一档
    let view = makeView("aaa\nbbb\n");
    view.dispatch({ selection: { anchor: 0, head: 2 } }); // 选中 "aa"
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(view.state.doc.toString()).toBe("  aaa\nbbb\n");
    view.destroy();

    // 多行选区：触碰的行都缩进（与 indentMore 同口径：选区结尾停在行首也算到达）
    view = makeView("aaa\nbbb\nccc\n");
    view.dispatch({ selection: { anchor: 1, head: 8 } }); // "aa\nbbb\nc"
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(view.state.doc.toString()).toBe("  aaa\n  bbb\n  ccc\n");
    // 同一选区 Shift+Tab：逐行去掉一档，整组退回原样
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("aaa\nbbb\nccc\n");
    view.destroy();
  });

  it("**Shift+Tab 按 tabSpaces 退一档**：不够一档删到行首尽头，制表符整只删，无缩进行跳过", () => {
    // 默认一档 2 空格：4 空格（两次 Tab）退一次剩 2，不是 indentLess 的一次吃 4
    let view = makeView("    abc\n");
    view.dispatch({ selection: { anchor: 6 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("  abc\n");
    view.destroy();

    // 只有 1 个空格：删到行首尽头，不删正文
    view = makeView(" abc\n");
    view.dispatch({ selection: { anchor: 3 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("abc\n");
    view.destroy();

    // 行首制表符：整只删（半個制表符没有意义）
    view = makeView("\tabc\n");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("abc\n");
    view.destroy();

    // 无缩进行：吃掉按键、不改文档（也不交回浏览器焦点移动）
    view = makeView("abc\n");
    view.dispatch({ selection: { anchor: 1 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("abc\n");
    view.destroy();
  });

  it("**补全候选打开时 Tab = 接受所选候选**（公式候选即 CM 补全面板），候选关着照插一档", async () => {
    // 真实应用里候选来自 typst_lezer 语言数据自带的 typstCompletionSource（公式内是
    // typstMathCompletions）。这里用 override 的同步补全源把「面板开着」钉死，不依赖语法。
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      doc: "$al",
      parent: host,
      extensions: [
        editorKeymap,
        indentUnit.of(INDENT_UNIT),
        autocompletion({
          override: [
            (context) => {
              const word = context.matchBefore(/al/);
              if (!word) return null;
              return { from: word.from, options: [{ label: "alpha", type: "function" }] };
            },
          ],
        }),
      ],
    });
    // 光标要停在候选词尾（CompletionContext.matchBefore 在行首返回 null，源才给得出候选）
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    startCompletion(view);
    await new Promise((r) => setTimeout(r, 50));
    expect(completionStatus(view.state)).toBe("active"); // 候选面板确实开着
    // CM 的 acceptCompletion 带 interactionDelay（默认 75ms）防误触：面板刚打开的那一瞬不接受。
    // 真实使用里人是看到候选后才按 Tab（远超 75ms），这里也等过这个窗口再按。
    await new Promise((r) => setTimeout(r, 120));
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(view.state.doc.toString()).toBe("$alpha"); // 接受候选，而不是插入 \t
    view.destroy();

    // 候选面板关着：Tab 回到插入制表符的本职
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const view2 = new EditorView({
      doc: "$al",
      parent: host2,
      extensions: [
        editorKeymap,
        indentUnit.of(INDENT_UNIT),
        autocompletion({ override: [() => null] }),
      ],
    });
    view2.dispatch({ selection: { anchor: view2.state.doc.length } });
    press(view2, { key: "Tab", code: "Tab", keyCode: 9 });
    expect(view2.state.doc.toString()).toBe("$al  "); // 默认 tabSpaces=2
    view2.destroy();
  });

  it("写作模式：列表里按回车续出下一项；空项回车退出列表（报告 T5）", () => {
    // 用**原生 Lezer** 语言入口（`typst_lezer`，无 wasm）：列表命令要语法树，
    // 而 `typst()` 那个 wasm 入口在 Node 下会 panic（见文件头说明）。
    // ① 列表项末尾回车 → 续出同级新项
    let view = makeWriteView("- 第一项");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("- 第一项\n- ");
    view.destroy();

    // ② 空列表项回车 → 退出列表（不留下一个空标记）
    view = makeWriteView("- 第一项\n- ");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("- 第一项\n");
    view.destroy();

    // ③ 非列表正文 Enter → Typora 段落语义：两个源码换行，并沿用缩进
    view = makeWriteView("  普通正文");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("  普通正文\n\n  ");
    view.destroy();

    // ④ **源码模式不碰列表语义**（模式感知的价值）：同一份文档、同一个回车 → 只是换行 + 抄缩进
    view = makeWriteView("- 第一项");
    view.destroy();
    const sourceView = makeView("- 第一项");
    sourceView.dispatch({ selection: { anchor: sourceView.state.doc.length } });
    press(sourceView, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(sourceView.state.doc.toString()).toBe("- 第一项\n");
    sourceView.destroy();
  });

  it("Ctrl+Tab 缩进与回车继承是同一套宽度：缩出来的 4 格，回车后照抄", () => {
    const view = makeView("#foo\n");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9, ctrlKey: true });
    expect(view.state.doc.toString()).toBe("    #foo\n");
    // 光标移到行尾再回车：新行缩进 = 上一行实际的 4 个空格
    view.dispatch({ selection: { anchor: view.state.doc.length - 1 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    // 原文末尾那个换行还在，所以是「4 格 + 换行 + 4 格 + 原换行」
    expect(view.state.doc.toString()).toBe("    #foo\n    \n");
    view.destroy();
  });

  it("Enter 换行继承上一行缩进（行尾 / 行中间 / 纯空白行 / Shift+Enter）", () => {
    // 行尾回车：新行照抄缩进
    let view = makeView("前文\n  缩进行");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("前文\n  缩进行\n  ");
    view.destroy();

    // 光标停在正文中间：换行后的下半行也带上同一缩进
    view = makeView("  abcdef");
    view.dispatch({ selection: { anchor: 5 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("  abc\n  def");
    view.destroy();

    // 纯空白行：清掉残留空白、新行不缩进（连按回车不堆缩进空行）
    view = makeView("前文\n  ");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("前文\n\n");
    view.destroy();

    // Shift+Enter 与 Enter 同义（CM 默认键位里两者也是同一条命令）
    view = makeView("  缩进");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(view.state.doc.toString()).toBe("  缩进\n  ");
    view.destroy();
  });

  it("**空脚手架 `$  $` 中间按 Enter → 展开三行**（中行一档 = 默认 2 空格，光标落档后）", () => {
    // 源码模式（editorKeymap 默认 tabSpaces=2）
    let view = makeView("$  $");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("$\n  \n$");
    expect(view.state.selection.main.head).toBe(4); // 中行 2 个空格之后
    view.destroy();

    // 写作模式同样接管（展开在列表命令之前，模式无关）
    view = makeWriteView("$  $");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("$\n  \n$");
    view.destroy();

    // 展开后接着打字：直接写进公式里
    view = makeView("$  $");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    view.dispatch(view.state.update(view.state.replaceSelection("x^2"), { userEvent: "input" }));
    expect(view.state.doc.toString()).toBe("$\n  x^2\n$");
    view.destroy();
  });

  it("脚手架展开不接管：光标不在中间 / 行内有内容 / Shift+Enter", () => {
    // 光标在行首（不在两个 $ 之间）→ 普通换行（源码模式：换行继承前导空白，此处无）
    let view = makeView("$  $");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("\n$  $");
    view.destroy();

    // 有内容的公式 `$ x $` → 不接管，走原有链路（公式内 = 单个换行，非段落语义）
    view = makeWriteView("$ x $");
    view.dispatch({ selection: { anchor: 3 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("$ x\n $");
    view.destroy();

    // Shift+Enter 不展开（它是 Typst 显式换行的语义）
    view = makeWriteView("$  $");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(view.state.doc.toString()).toBe("$ \\\n $");
    view.destroy();
  });

  it("写作模式：Enter 分段，Shift+Enter 写 Typst 显式换行并保留缩进", () => {
    let view = makeWriteView("  abcdef");
    view.dispatch({ selection: { anchor: 5 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("  abc\n\n  def");
    view.destroy();

    view = makeWriteView("  abcdef");
    view.dispatch({ selection: { anchor: 5 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(view.state.doc.toString()).toBe("  abc\\\n  def");
    view.destroy();

    // 行尾已有的换行被替换为段落分隔符；光标落在新段落正文起点。
    view = makeWriteView("abc\ndef");
    view.dispatch({ selection: { anchor: 3 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe("abc\n\ndef");
    expect(view.state.selection.main.head).toBe("abc\n\n".length);
    view.destroy();

    // 行尾的既有换行被复用；下一行原有缩进保留且光标落在正文开头。
    view = makeWriteView("  abc\n  def");
    view.dispatch({ selection: { anchor: 5 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    expect(view.state.doc.toString()).toBe("  abc\\\n  def");
    expect(view.state.selection.main.head).toBe("  abc\\\n  ".length);
    view.destroy();
  });

  it("写作模式：Enter 新建的空段落不是「只用于分隔的空源码行」，光标就落在它上面", () => {
    // 用户 2026-09-26：「按 Enter 后光标会跳动」+「真正的空段落仍须能进入、输入和删除」。
    // 判据用**段距扫描**（与写作渲染同一份纯函数）：Enter 的落点那一行不得是纯分隔行 ——
    // 分隔行在版面上只有 0~3px 高（段距由相邻块的带高承载），旧实现把两者混在一起，于是
    // Enter 之后光标先落到那条看不见的行上、编译落地再跳回来。
    for (const { doc, pos } of [
      { doc: "前段\n\n后段", pos: 2 }, // 两段之间：新空段落插在中间
      { doc: "前段", pos: 2 }, // 文末：新空段落在文末（必须可进入）
      { doc: "前段\n", pos: 2 }, // 行尾已经有换行
    ]) {
      const view = makeWriteView(doc);
      view.dispatch({ selection: { anchor: pos } });
      press(view, { key: "Enter", code: "Enter", keyCode: 13 });
      const text = view.state.doc.toString();
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const info = JSON.stringify({ doc, text, head, line: line.number });
      expect(line.from, info).toBe(view.state.selection.main.head);
      expect(head, info).toBe(line.from); // 落在新段落的可输入起点（行首）
      view.destroy();
    }
  });

  it("写作模式：只替换实际选区，markup 引号仍按普通正文处理", () => {
    let view = makeWriteView('带 "引号" 的正文');
    view.dispatch({ selection: { anchor: 4 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(view.state.doc.toString()).toBe('带 "引\n\n号" 的正文');
    view.destroy();

    view = makeWriteView("abcdef\nnext");
    view.dispatch({ selection: { anchor: 2, head: 6 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13 });
    // 选区恰好到行尾时复用后面的原换行，只形成一个段落分隔。
    expect(view.state.doc.toString()).toBe("ab\n\nnext");
    expect(view.state.selection.main.head).toBe("ab\n\n".length);
    view.destroy();
  });

  it("写作模式：代码、raw、注释与公式内沿用安全的普通换行", () => {
    const contexts = [
      { doc: "#let x = 1", pos: 6 },
      { doc: "#let x = 1", pos: "#let x = 1".length },
      { doc: '#let s = "abc"', pos: 11 },
      { doc: "`raw`", pos: 2 },
      { doc: "// comment", pos: 4 },
      { doc: "// comment", pos: "// comment".length },
      { doc: "/* open", pos: "/* open".length },
      { doc: "```\n  let a = 1", pos: "```\n  let a = 1".length },
      { doc: "$x$", pos: 1 },
    ];

    for (const { doc, pos } of contexts) {
      for (const shiftKey of [false, true]) {
        const view = makeWriteView(doc);
        view.dispatch({ selection: { anchor: pos } });
        press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey });
        expect(view.state.doc.toString().split("\n")).toHaveLength(doc.split("\n").length + 1);
        expect(view.state.doc.toString()).not.toContain("\\\n");
        view.destroy();
      }
    }
  });

  it("写作模式：文首、文末与已有空行按键只产生预期的源码行", () => {
    const cases = [
      { doc: "", pos: 0, shiftKey: false, expected: "\n", head: 1 },
      { doc: "", pos: 0, shiftKey: true, expected: "\n", head: 1 },
      { doc: "  ", pos: 2, shiftKey: false, expected: "\n", head: 1 },
      { doc: "正文\n  ", pos: 5, shiftKey: true, expected: "正文\n\n", head: 4 },
      { doc: "前段\n\n后段", pos: 3, shiftKey: false, expected: "前段\n\n\n后段", head: 4 },
      { doc: "前段\n\n", pos: 4, shiftKey: false, expected: "前段\n\n\n", head: 5 },
    ];
    for (const { doc, pos, shiftKey, expected, head } of cases) {
      const view = makeWriteView(doc);
      view.dispatch({ selection: { anchor: pos } });
      press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey });
      expect(view.state.doc.toString(), JSON.stringify({ doc, pos, shiftKey })).toBe(expected);
      expect(view.state.selection.main.head).toBe(head);
      view.destroy();
    }
  });

  it("写作模式：跨公式或 raw 的选区只做安全换行，不在残余源码里插入段落符", () => {
    for (const { doc, from, to, expected } of [
      { doc: "a $x$ b", from: 2, to: 5, expected: "a \n b" },
      { doc: "a `raw` b", from: 2, to: 7, expected: "a \n b" },
    ]) {
      for (const shiftKey of [false, true]) {
        const view = makeWriteView(doc);
        view.dispatch({ selection: { anchor: from, head: to } });
        press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey });
        expect(view.state.doc.toString(), JSON.stringify({ doc, shiftKey })).toBe(expected);
        expect(view.state.selection.main.head).toBe(from + 1);
        view.destroy();
      }
    }
  });

  it("写作模式：Shift+Enter 不产生空行 —— 换行后的内容是一条普通可见行（不是分隔行）", () => {
    // 用户 2026-09-26 的第 2 条：「Shift+Enter 保持 Typst 显式行内换行语义；上下键将换行后的
    // 内容当作下一条可见行」。判据：整篇**没有任何纯段落分隔行**（所以竖直移动不会把它跳过），
    // 而且光标落在换行后的那一条源码行起点上。
    const view = makeWriteView("前段\n后段");
    view.dispatch({ selection: { anchor: 2 } });
    press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey: true });
    const text = view.state.doc.toString();
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const info = JSON.stringify({ text, head, line: line.number });
    expect(text, info).toBe("前段\\\n后段");
    expect(line.number, info).toBe(2);
    expect(head - line.from, info).toBe(0);

    view.destroy();
  });

  it("写作模式：Enter 和 Shift+Enter 各作为一次编辑撤销，完整恢复源码和光标", () => {
    for (const shiftKey of [false, true]) {
      const view = makeWriteView("前段\n后段");
      view.dispatch({ selection: { anchor: 2 } });
      press(view, { key: "Enter", code: "Enter", keyCode: 13, shiftKey });
      expect(view.state.doc.toString()).toBe(shiftKey ? "前段\\\n后段" : "前段\n\n后段");
      press(view, { key: "z", code: "KeyZ", keyCode: 90, ctrlKey: true });
      expect(view.state.doc.toString()).toBe("前段\n后段");
      expect(view.state.selection.main.head).toBe(2);
      view.destroy();
    }
  });

  it("Ctrl+D 无选区删除整行（覆盖 searchKeymap 的选中下一处）", () => {
    const view = makeView("aaa\nbbb\nccc\n");
    view.dispatch({ selection: { anchor: 0 } }); // 光标在首行行首，无选区
    press(view, { key: "d", code: "KeyD", keyCode: 68, ctrlKey: true });
    expect(view.state.doc.toString()).toBe("bbb\nccc\n"); // 整行被删而非选中单词
    view.destroy();
  });

  it("Ctrl+Shift+D 复制当前行到下方", () => {
    const view = makeView("aaa\nbbb\n");
    view.dispatch({ selection: { anchor: 4 } }); // 光标在 "bbb" 行
    press(view, { key: "D", code: "KeyD", keyCode: 68, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("aaa\nbbb\nbbb\n");
    view.destroy();
  });

  it("Ctrl+Shift+/ 块注释（选中范围包裹）", () => {
    const view = makeView("#foo\n");
    view.dispatch({ selection: { anchor: 0, head: 4 } }); // 选中 "#foo"
    // 真实浏览器中 Ctrl+Shift+/ 的 key 是 "?"，keyCode 191 对应 "/"
    press(view, { key: "?", code: "Slash", keyCode: 191, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("/* #foo */\n"); // CM 会在包裹内容两侧补空格

    // 再按一次取消注释
    press(view, { key: "?", code: "Slash", keyCode: 191, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe("#foo\n");
    view.destroy();
  });

  it("Ctrl+/ 行注释（无选区时注释光标所在行）", () => {
    const view = makeView("aaa\nbbb\n");
    view.dispatch({ selection: { anchor: 1 } }); // 光标在 "aaa" 行内
    // 真实浏览器中 Ctrl+/ 的 key 是 "/"，keyCode 191 对应 "/"（无 shift）
    press(view, { key: "/", code: "Slash", keyCode: 191, ctrlKey: true });
    expect(view.state.doc.toString()).toBe("// aaa\nbbb\n"); // 行首插入 "// "

    // 再按一次取消注释
    press(view, { key: "/", code: "Slash", keyCode: 191, ctrlKey: true });
    expect(view.state.doc.toString()).toBe("aaa\nbbb\n");
    view.destroy();
  });
});
