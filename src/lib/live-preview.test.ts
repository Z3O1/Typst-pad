// 所见即所得扩展（live-preview）的 DOM 级测试：在 jsdom 里真挂一个 EditorView，
// 断言公式 widget 与标记隐藏的实际装饰行为（与 scripts/browser-check/wysiwyg.mjs 的
// 浏览器验证互补：这里是 CI 可跑的回归网，那边是真实浏览器 + 真实输入的验收）。
//
// 注意：不引入 typst() 语言扩展（其 wasm 解析器在 Node 下处理文档变更会 panic，
// 见 editor-keymap.test.ts 的说明）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { livePreview } from "./live-preview";
import { mathCacheKey } from "./math-ranges";
import { MATH_SIZE_PT } from "./typst-engine";
import type { MathRender } from "./typst-engine";

/** 假渲染结果：真实契约里 svg 是 Rust 侧产物，这里只需区分不同公式 */
function render(body: string): MathRender {
  return {
    ok: true,
    svg: `<svg viewBox="0 0 10 7" width="10pt" height="7pt"><text>${body}</text></svg>`,
    widthPt: 10,
    heightPt: 7,
    baselinePt: 5,
  };
}

describe("livePreview 扩展", () => {
  let host: HTMLElement;
  let view: EditorView;
  const requests: { key: string; body: string; display: boolean; context: string }[] = [];
  const cache = new Map<string, MathRender>();

  /** 建视图：enabled / dark 可切换，缓存与请求回调用闭包读当前状态 */
  function mount(
    doc: string,
    opts: { enabled?: boolean; dark?: boolean; cache?: boolean; cursor?: number } = {},
  ) {
    const enabled = opts.enabled ?? true;
    const dark = opts.dark ?? false;
    if (opts.cache) cache.set(mathCacheKey("x^2", false, "", MATH_SIZE_PT), render("x^2"));
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        // 光标默认放在文档末尾（构造之外）：否则 jsdom 下默认 anchor=0 会落在构造内部，
        // 触发"展开源码"，测不到隐藏效果（实测踩过）
        selection: { anchor: opts.cursor ?? doc.length },
        extensions: [
          basicSetup,
          livePreview({
            enabled: () => enabled,
            prefix: () => "",
            lookup: (key) => cache.get(key),
            onRequest: (reqs) => requests.push(...reqs),
            dark: () => dark,
          }),
        ],
      }),
    });
  }

  const widgetCount = () => host.querySelectorAll(".cm-math-widget").length;
  const text = () => host.querySelector(".cm-content")?.textContent ?? "";

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    requests.length = 0;
    cache.clear();
  });

  afterEach(() => {
    view?.destroy();
    host.remove();
  });

  it("已缓存的公式被 widget 替换（源码里的 $ 不再出现）", () => {
    mount("前面的 $x^2$ 后面", { cache: true });
    expect(widgetCount()).toBe(1);
    expect(text()).toContain("前面");
    expect(text()).not.toContain("$x^2$");
  });

  it("未缓存的公式保持源码，并发出渲染请求", () => {
    mount("$y^2$");
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$y^2$");
    expect(requests.map((r) => r.body)).toContain("y^2");
    // 请求必须自带上下文（渲染是异步批处理，父组件不能到那时再取当前值）
    const req = requests.find((r) => r.body === "y^2");
    expect(req?.context).toBe("");
  });

  it("渲染失败（ok:false）不显示 widget，保持源码", () => {
    cache.set(mathCacheKey("bad", false, "", MATH_SIZE_PT), { ...render("bad"), ok: false, error: "boom" });
    mount("$bad$");
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$bad$");
  });

  it("光标进入公式区间 → 展开源码；移出 → 重新渲染", () => {
    mount("$x^2$ 尾巴", { cache: true });
    expect(widgetCount()).toBe(1);
    view.dispatch({ selection: { anchor: 2 } }); // 落在 `$x^2$` 内部
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$x^2$");
    view.dispatch({ selection: { anchor: 7 } }); // 移到公式之外的"尾巴"
    expect(widgetCount()).toBe(1);
  });

  it("独占整行的行间公式 → 块级 widget（居中显示）", () => {
    cache.set(mathCacheKey("x^2", true, "", MATH_SIZE_PT), render("x^2"));
    mount("$ x^2 $\n正文");
    // 块级：DOM 里是 .cm-math-block（不是行内 .cm-math-widget）
    expect(host.querySelectorAll(".cm-math-block").length).toBe(1);
    expect(widgetCount()).toBe(0);
    expect(text()).not.toContain("$ x^2 $");
  });

  it("跨行书写的行间公式也能整行渲染成块级 widget", () => {
    cache.set(mathCacheKey("a + b", true, "", MATH_SIZE_PT), render("a + b"));
    mount("$\n  a + b\n$\n正文");
    expect(host.querySelectorAll(".cm-math-block").length).toBe(1);
    expect(text()).toContain("正文");
    // 定界符消失即证明整段被替换（假 SVG 里含公式文本，故不按文本断言）
    expect(text()).not.toContain("$");
  });

  it("与文字同行的 `$ x $` 不整行替换（避免吃掉旁边正文）", () => {
    cache.set(mathCacheKey("x", true, "", MATH_SIZE_PT), render("x"));
    mount("前 $ x $ 后\n");
    expect(host.querySelectorAll(".cm-math-block").length).toBe(0);
    expect(widgetCount()).toBe(1);
    expect(text()).toContain("前");
    expect(text()).toContain("后");
  });

  it("行内跨行公式保持源码（不请求、不渲染）", () => {
    cache.set(mathCacheKey("a\nb", false, "", MATH_SIZE_PT), render("a\nb"));
    mount("$a\nb$\n");
    expect(widgetCount()).toBe(0);
    expect(host.querySelectorAll(".cm-math-block").length).toBe(0);
    expect(text()).toContain("a");
  });

  it("块级 widget 随光标进入展开为源码", () => {
    cache.set(mathCacheKey("x^2", true, "", MATH_SIZE_PT), render("x^2"));
    mount("$ x^2 $\n正文");
    expect(host.querySelectorAll(".cm-math-block").length).toBe(1);
    view.dispatch({ selection: { anchor: 3 } }); // 落在公式内部
    expect(host.querySelectorAll(".cm-math-block").length).toBe(0);
    expect(text()).toContain("$ x^2 $");
  });

  it("暗色主题标记注入 widget（供反色样式匹配）", () => {
    mount("$x^2$\n", { cache: true, dark: true });
    expect(host.querySelector(".cm-math-widget")?.className).toContain("cm-math-dark");
  });

  it("关闭开关 → 全部显示源码（含标记符号与公式定界符）", () => {
    mount("= 标题 *粗* $x^2$\n", { enabled: false, cache: true });
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$x^2$");
    expect(text()).toContain("= 标题");
    expect(text()).toContain("*粗*");
  });

  it("常用标记：标记符号被隐藏、正文仍可见（标题/粗体/斜体/行内代码/列表）", () => {
    mount("= 标题\n\n正文 *粗体* 与 _斜体_ 与 `代码`\n\n- 条目\n");
    const t = text();
    expect(t).toContain("标题");
    expect(t).not.toContain("= 标题");
    expect(t).toContain("粗体");
    expect(t).not.toContain("*粗体*");
    expect(t).toContain("斜体");
    expect(t).not.toContain("_斜体_");
    expect(t).toContain("代码");
    expect(t).not.toContain("`代码`");
    // 无序列表符号替换为圆点
    expect(host.querySelector(".cm-markup-replacement")?.textContent).toBe("• ");
  });

  it("样式类齐全：heading / strong / emph / raw，标题带级别类", () => {
    mount("== 二级\n\n*粗* 与 _斜_ 与 `码`\n");
    expect(host.querySelector(".cm-markup-heading-2")).not.toBeNull();
    expect(host.querySelector(".cm-markup-strong")).not.toBeNull();
    expect(host.querySelector(".cm-markup-emph")).not.toBeNull();
    expect(host.querySelector(".cm-markup-raw")).not.toBeNull();
  });

  it("光标进入构造内部 → 标记符号重新露出（可编辑源码）", () => {
    mount("= 标题\n正文");
    expect(text()).not.toContain("=");
    view.dispatch({ selection: { anchor: 3 } }); // 落在"标题"内部
    expect(text()).toContain("= 标题");
  });
});

describe("livePreview 代码块（``` 围栏）", () => {
  let host2: HTMLElement;
  let view2: EditorView;

  beforeEach(() => {
    host2 = document.createElement("div");
    document.body.appendChild(host2);
  });
  afterEach(() => {
    view2?.destroy();
    host2.remove();
  });

  function mount2(doc: string) {
    view2 = new EditorView({
      parent: host2,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          basicSetup,
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
          }),
        ],
      }),
    });
  }

  it("围栏代码块整段替换为代码块 widget（围栏不可见、代码可见）", () => {
    mount2("前文\n\n```typ\n#let x = 1\n```\n\n后文\n");
    const block = host2.querySelector(".cm-raw-block");
    expect(block).not.toBeNull();
    expect(block?.querySelector("pre")?.textContent).toBe("#let x = 1");
    expect(host2.querySelector(".cm-content")?.textContent).not.toContain("```");
    expect(host2.querySelector(".cm-content")?.textContent).toContain("后文");
  });

  it("光标进入代码块 → 整段回到源码", () => {
    const doc = "```\ncode\n```\n";
    mount2(doc);
    expect(host2.querySelectorAll(".cm-raw-block").length).toBe(1);
    view2.dispatch({ selection: { anchor: 4 } }); // 落在代码内容里
    expect(host2.querySelectorAll(".cm-raw-block").length).toBe(0);
    expect(host2.querySelector(".cm-content")?.textContent).toContain("```");
  });
});
