// @vitest-environment jsdom

// 编辑快捷键 keymap 的绑定断言与行为测试
// 行为测试通过 jsdom 在编辑器 DOM 上派发 keydown 事件，验证键位真正生效
// （CodeMirror 的 keydown 处理挂在 contentDOM 上，事件按真实浏览器路径派发）
// 说明：行为测试不引入 typst() 语言扩展——其 wasm 解析器在 Node 环境下对文档
// 变更会 panic；注释符号改用 EditorState.languageData 注入，键位语义不受影响。
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap as keymapFacet } from "@codemirror/view";
import {
  indentWithTab,
  deleteLine,
  copyLineDown,
  toggleBlockComment,
  toggleComment,
} from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import { basicSetup } from "codemirror";
import { createEditorKeymap, editorKeymap } from "./editor-keymap";
import { typst_lezer } from "codemirror-lang-typst/lezer";
import { INDENT_UNIT } from "./auto-indent";
import { scanNonMarkupRegions } from "../core/typst-lex";
import { scanMathRanges } from "../core/math-ranges";
import { scanMarkupDecorations } from "../core/markup-ranges";
import { scanParagraphGapRows } from "../core/paragraph-breaks";

/**
 * 文档里**纯段落分隔行**的行首集合（与写作渲染的段距装饰同源：`paragraphGapRows` 就是那些
 * 被压缩到 Typst 段距、因而不是竖直导航停靠点的行，见 core/block-plan 的 sourceVerticalTarget）。
 */
function separatorLineStarts(doc: string): Set<number> {
  const opaque = scanNonMarkupRegions(doc);
  const math = scanMathRanges(doc, opaque);
  const markup = scanMarkupDecorations(doc, { opaque, math });
  return new Set(scanParagraphGapRows(doc, opaque, math, markup).map((row) => row.from));
}

// 与 Editor.svelte buildExtensions 的键位相关扩展保持一致（typst() 不含键位，不影响断言）
// indentUnit 也要带上：Tab 一档缩进多宽由它决定（应用里是 4 个空格，见 auto-indent.ts）
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
    expect(keys).toContain("Tab");
    expect(keys).toContain("Mod-Shift-d");
    expect(keys).toContain("Mod-d");
    expect(keys).toContain("Mod-Shift-/");
    expect(keys).toContain("Mod-/");
  });

  it("各键位绑定到预期命令", () => {
    const bindings = allBindings();
    // 注册顺序上的第一个 Tab / Mod-d 才是生效的绑定（先返回 true 者胜出）
    expect(bindings.find((b) => b.key === "Tab")?.run).toBe(indentWithTab.run);
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

  it("Tab 一档缩进 = 4 个空格、Shift+Tab 反缩进一层", () => {
    const view = makeView("#foo\n");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
    // 用户要求「Tab 应该是四格缩进」：一档就是 INDENT_UNIT（4 个空格），不是 CM 默认的 2 个
    expect(view.state.doc.toString()).toBe("    #foo\n");
    expect(view.state.facet(indentUnit)).toBe(INDENT_UNIT);
    expect(INDENT_UNIT).toBe("    ");

    // Shift+Tab 反缩进一层
    press(view, { key: "Tab", code: "Tab", keyCode: 9, shiftKey: true });
    expect(view.state.doc.toString()).toBe("#foo\n");
    view.destroy();
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

  it("Tab 缩进与回车继承是同一套宽度：Tab 出来的 4 格，回车后照抄", () => {
    const view = makeView("#foo\n");
    view.dispatch({ selection: { anchor: 0 } });
    press(view, { key: "Tab", code: "Tab", keyCode: 9 });
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
      expect(separatorLineStarts(text).has(line.from), info).toBe(false);
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
    expect(separatorLineStarts(text).size, info).toBe(0);
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
