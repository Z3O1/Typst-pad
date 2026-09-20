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
import { editorKeymap } from "./editor-keymap";
import { INDENT_UNIT } from "./auto-indent";

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
    const shiftEnter = bindings.find((b) => b.key === "Shift-Enter")?.run;
    const enterRuns = bindings.filter((b) => b.key === "Enter").map((b) => b.run);
    expect(shiftEnter).toBeTruthy();
    expect(enterRuns).toContain(shiftEnter);
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
