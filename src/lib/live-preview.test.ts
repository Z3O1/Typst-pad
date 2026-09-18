// 所见即所得扩展（live-preview）的 DOM 级测试：在 jsdom 里真挂一个 EditorView，
// 断言公式 widget 与标记隐藏的实际装饰行为（与 scripts/browser-check/wysiwyg.mjs 的
// 浏览器验证互补：这里是 CI 可跑的回归网，那边是真实浏览器 + 真实输入的验收）。
//
// 注意：不引入 typst() 语言扩展（其 wasm 解析器在 Node 下处理文档变更会 panic，
// 见 editor-keymap.test.ts 的说明）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { livePreview } from "./live-preview";
import type { Block } from "./block-plan";
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

  // 回归：空正文的标记构造（`== ` 还没写标题文字、`**` 还没写内容）曾让 CM6 抛
  // `Mark decorations may not be empty` —— 异常冒泡进事务会让编辑区卡死
  // （用户报过"输入 `= 1 = 2` 后无法再输入任何东西" / "输入 `==` 所有标题都被展开"）
  it("空正文的标题（`== `）不抛异常，且后续输入照常生效", () => {
    mount("= 标题\n正文\n== ");
    expect(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } })).not.toThrow();
    expect(view.state.doc.toString()).toBe("= 标题\n正文\n== x");
    // 空正文那一行不产生样式类，正常标题仍然带样式
    expect(host.querySelectorAll(".cm-markup-heading").length).toBeGreaterThan(0);
  });

  it("空正文的粗体/斜体标记（`**`、`__`）同样不抛异常", () => {
    mount("前 ** 后\n__ 尾");
    expect(() =>
      view.dispatch({ changes: { from: view.state.doc.length, insert: "y" } }),
    ).not.toThrow();
    expect(view.state.doc.toString()).toContain("y");
  });

  it("已缓存的公式被 widget 替换（源码里的 $ 不再出现）", () => {
    mount("前面的 $x^2$ 后面", { cache: true });
    expect(widgetCount()).toBe(1);
    expect(text()).toContain("前面");
    expect(text()).not.toContain("$x^2$");
  });

  it("未缓存的公式保持源码，并发出渲染请求", () => {
    // 光标放在公式**之外**（第二行）：光标在公式里时按新规则不请求渲染（见下一条用例）
    mount("$y^2$\n", { cursor: 6 });
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$y^2$");
    expect(requests.map((r) => r.body)).toContain("y^2");
    // 请求必须自带上下文（渲染是异步批处理，父组件不能到那时再取当前值）
    const req = requests.find((r) => r.body === "y^2");
    expect(req?.context).toBe("");
  });

  it("光标在公式里时不请求渲染（它此刻就是源码，编译纯属浪费 —— 用户反馈「输入手感很差（公式）」）", () => {
    // 光标停在 `$y^2|$` 里：每敲一个字都会生成新的公式文本，旧行为会**每个按键编译一次公式**，
    // 而它和整篇编译共用一把锁 → 打字时公式渲染排在后面，半天不显示。
    mount("$y^2$", { cursor: 3 });
    expect(requests.map((r) => r.body)).not.toContain("y^2");
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$y^2$");
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

  // 用户要求「选中整个公式请不要展开」：与块级渲染同一套规则 —— 选区**完整盖住**公式时
  // 保持渲染外观（挂 .cm-math-selected 淡色底），只盖住一部分才展开。
  it("选区完整盖住公式 → 不展开，挂淡色底（用户要求「选中整个公式请不要展开」）", () => {
    mount("前面的 $x^2$ 后面", { cache: true });
    expect(widgetCount()).toBe(1);
    view.dispatch({ selection: { anchor: 4, head: 9 } }); // 恰好盖住 `$x^2$`（4..9）
    expect(widgetCount()).toBe(1);
    expect(text()).not.toContain("$x^2$"); // 定界符仍不出现 = 没有展开成源码
    expect(host.querySelector(".cm-math-widget")?.className).toContain("cm-math-selected");
    // 选区移开 → 淡色底撤掉
    view.dispatch({ selection: { anchor: 12 } });
    expect(host.querySelector(".cm-math-widget")?.className).not.toContain("cm-math-selected");
  });

  it("选区只盖住公式一部分 → 照旧展开源码（半个公式要高亮到字符）", () => {
    mount("前面的 $x^2$ 后面", { cache: true });
    view.dispatch({ selection: { anchor: 5, head: 9 } }); // 只从 `x` 到公式末尾
    expect(widgetCount()).toBe(0);
    expect(text()).toContain("$x^2$");
  });

  it("整行公式被完整盖住 → 块级 widget 也保持渲染 + 淡色底", () => {
    cache.set(mathCacheKey("x^2", true, "", MATH_SIZE_PT), render("x^2"));
    mount("$ x^2 $\n正文");
    const block = () => host.querySelector(".cm-math-block");
    expect(block()).not.toBeNull();
    view.dispatch({ selection: { anchor: 0, head: 7 } }); // 整行公式
    expect(block()).not.toBeNull();
    expect(block()?.className).toContain("cm-math-selected");
    expect(text()).not.toContain("$ x^2 $");
    // 光标点进公式内部 → 必须展开（不然 DOM 里没有真实文本，打字进不去）
    view.dispatch({ selection: { anchor: 3 } });
    expect(block()).toBeNull();
    expect(text()).toContain("$ x^2 $");
  });

  it("跨行的行间公式（整行 block widget）被完整盖住时**仍然展开**：那种形态里打字会插到下一行", () => {
    cache.set(mathCacheKey("a + b", true, "", MATH_SIZE_PT), render("a + b"));
    mount("$\n  a + b\n$\n后文\n");
    const block = () => host.querySelector(".cm-math-block");
    expect(block()).not.toBeNull();
    view.dispatch({ selection: { anchor: 0, head: 11 } }); // 完整盖住公式（0..11）
    expect(block()).toBeNull();
    expect(text()).toContain("$");
  });

  it("行首行尾带空白的行间公式：只选中公式（没盖住整行）时展开，不做「半盖住 widget」", () => {
    // 装饰盖的是**整行**（连空白一起，才真的居中），而选区只盖公式本身 → widget 只被盖住一部分。
    // DOM 里 widget 是原子节点，浏览器只能在它边缘插入 —— 实测那种情况打字会把字符插到行尾
    //（`  $ x^2 $  ` → `  $ x^2 $  z`），所以必须展开源码。
    cache.set(mathCacheKey("x^2", true, "", MATH_SIZE_PT), render("x^2"));
    mount("前文\n\n  $ x^2 $  \n\n后文\n");
    const block = () => host.querySelector(".cm-math-block");
    expect(block()).not.toBeNull();
    view.dispatch({ selection: { anchor: 6, head: 13 } }); // 只盖住 `$ x^2 $`
    expect(block()).toBeNull();
    expect(text()).toContain("$ x^2 $");
    // 整行（含空白，4..15）都盖住 → 保持渲染 + 淡色底
    view.dispatch({ selection: { anchor: 4, head: 15 } });
    expect(block()).not.toBeNull();
    expect(block()?.className).toContain("cm-math-selected");
  });

  it("选区完整盖住还没渲过的公式 → 仍然请求渲染（否则会一直停在源码）", () => {
    mount("$y^2$\n", { cursor: 5 });
    expect(requests.map((r) => r.body)).not.toContain("y^2");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(requests.map((r) => r.body)).toContain("y^2");
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

// ---------------------------------------------------------------------------
// 块级切片（写作模式的"渲染表面"）：非光标块显示成引擎画的切片，光标所在块保持源码
// 见 docs/文档模式渲染保真-调研.md 第三节。这里锁的是"装饰层"的行为，
// 真实排版几何由 Rust 侧 block_geometry 的测试与浏览器验收负责。
// ---------------------------------------------------------------------------
describe("livePreview 块级切片", () => {
  /** 假切片：真实契约里 svg 来自 Rust 的 compile_blocks */
  const blockSvg = (tag: string) => `<svg viewBox="0 0 100 20" width="100pt" height="20pt"><g>${tag}</g></svg>`;
  /** 父组件传下来的是**已换算成 CodeMirror 位置**的块（见 block-plan.toBlockTable）；
   *  下面用纯 ASCII 文档，位置与字节偏移一致 */
  const crop = (from: number, to: number, opts: Record<string, unknown> = {}): Block => ({
    from,
    to,
    kind: "Paragraph",
    found: true,
    noOutput: false,
    pages: 1,
    page: 1,
    xPt: 58,
    yPt: 0,
    widthPt: 371,
    heightPt: 20,
    svg: blockSvg("b"),
    links: [],
    ...opts,
  });

  let host: HTMLElement;
  let view: EditorView;

  /** 用纯 ASCII 文档：字节偏移 == CodeMirror 位置，测试不必掺进换算噪音 */
  function mount(doc: string, blocks: Block[] | null, sel?: number) {
    host = document.createElement("div");
    document.body.appendChild(host);
    const list = blocks;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: sel ?? doc.length },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => list,
          }),
        ],
      }),
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    view?.destroy();
    host?.remove();
  });

  /**
   * jsdom 没实现 `Range.getClientRects`，而 CodeMirror 测量文本尺寸时会用到它 ——
   * 点击类用例走了 CM 自己的 mousedown 处理（`basicMouseSelection` → 测量），
   * 于是会在 jsdom 里抛一个与业务无关的异常（真实浏览器里不存在）。补一个空实现。
   */
  beforeEach(() => {
    if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
      Range.prototype.getClientRects = function () {
        const rect = document.createElement("div").getBoundingClientRect();
        return Object.assign([rect], { item: (i: number) => (i === 0 ? rect : null) }) as unknown as DOMRectList;
      };
    }
  });

  const crops = () => host.querySelectorAll(".cm-block-crop");
  /**
   * 在切片上点一下（真实点击 = mousedown + mouseup；阶段 3 起由 CM 的 mouseSelectionStyle 接管）。
   * jsdom 没有布局也没实现 `elementFromPoint`，所以要把它指到被点的那张切片上 —— 真实浏览器里
   * 这一步由浏览器自己完成（落点命中测试靠它判断"指针在切片上还是源码行上"）。
   */
  const clickCrop = (el: HTMLElement, x = 40, y = 10) => {
    // jsdom 根本没实现 elementFromPoint（不是"返回 null"），只能自己装一个
    (document as unknown as Record<string, unknown>).elementFromPoint = () => el;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
  };
  const content = () => host.querySelector(".cm-content")?.textContent ?? "";

  it("非光标所在块被替换为切片，光标所在块保持源码", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    // 三块：aaa[0,3) bbb[5,8) ccc[10,13)；光标落在 bbb 里
    mount(doc, [crop(0, 3), crop(5, 8), crop(10, 13)], 6);
    expect(crops().length).toBe(2); // 第一块与第三块
    expect(content()).toContain("bbb"); // 光标所在块仍是源码
    expect(content()).not.toContain("aaa");
    expect(content()).not.toContain("ccc");
  });

  it("blocks 为 null（源码模式 / 后端不支持）时行为与加这个功能前一致：不动装饰", () => {
    mount("aaa\n\nbbb\n", null, 0);
    expect(crops().length).toBe(0);
    expect(content()).toContain("aaa");
  });

  it("没有渲染结果的块（`#let` 这类）永远保持源码可见", () => {
    // 偏移按真实文本：aaa[0,3) \n(3) \n(4) #let x = 1[5,15) \n(15) \n(16) bbb[17,20) \n(20)
    const doc = "aaa\n\n#let x = 1\n\nbbb\n";
    mount(doc, [crop(0, 3), crop(5, 15, { kind: "Code", found: false, svg: "" }), crop(17, 20)], 0);
    expect(content()).toContain("#let x = 1");
    expect(crops().length).toBe(1); // 只有最后一块被替换（aaa 是光标所在块）
  });

  it("点击切片 → 光标落到该块源码起点，切片随即展开为源码", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    mount(doc, [crop(0, 3), crop(5, 8), crop(10, 13)], 6);
    clickCrop(crops()[0] as HTMLElement);
    expect(view.state.selection.main.head).toBe(0); // aaa 的起点
    expect(content()).toContain("aaa"); // 展开后源码可见
    expect(crops().length).toBe(2); // 换成 bbb 与 ccc 被替换
  });

  it("点击切片 → 命中测试给出精确位置（阶段 2）：光标落在回调返回的位置，不是块首", async () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    // 一块的"页面坐标"：左 58pt、上 100pt、宽 371.25pt、高 20pt
    const geo = {
      page: 1,
      xPt: 58,
      yPt: 100,
      widthPt: 371.25,
      heightPt: 20,
    };
    const asked: { page: number; xPt: number; yPt: number; from: number; to: number }[] = [];
    // jsdom 没有布局：把 rect 量成"100px 宽 = 371.25pt"的假矩形，点击落在 75% 处
    const rect = { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) };
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(rect as DOMRect);
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: 6 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3, geo), crop(5, 8, geo), crop(10, 13, geo)],
            onCropClick: async (req) => {
              asked.push(req);
              return 7; // 假命中结果：第三块（被点的第一块是 aaa，7 落在 bbb 里）
            },
          }),
        ],
      }),
    });
    const first = crops()[0] as HTMLElement;
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 75, clientY: 25 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 75, clientY: 25 }));
    await new Promise((r) => setTimeout(r, 0));
    // ① 页面坐标换算：x = 58 + 371.25 × 0.75、y = 100 + 20 × 0.5
    //（mousedown 与 mouseup 各会问一次命中测试，取最后一次看参数）
    expect(asked.length).toBeGreaterThanOrEqual(1);
    const last = asked[asked.length - 1];
    expect(last.xPt).toBeCloseTo(58 + 371.25 * 0.75, 3);
    expect(last.yPt).toBeCloseTo(110, 3);
    expect(last.page).toBe(1);
    expect(last).toMatchObject({ from: 0, to: 3 });
    // ② 光标落在回调给的位置（而不是块首 0）
    expect(view.state.selection.main.head).toBe(7);
    spy.mockRestore();
  });

  it("命中测试失败（返回 null）→ 退回块首，点击不会被吞掉", async () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const geo = { page: 1, xPt: 58, yPt: 100, widthPt: 371.25, heightPt: 20 };
    const rect = { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) };
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue(rect as DOMRect);
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: 6 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3, geo), crop(5, 8, geo), crop(10, 13, geo)],
            onCropClick: async () => null,
          }),
        ],
      }),
    });
    const fallback = crops()[0] as HTMLElement;
    fallback.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 75, clientY: 25 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 75, clientY: 25 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.state.selection.main.head).toBe(0);
    spy.mockRestore();
  });

  it("在切片上按下再拖到另一张切片 → 选出一段跨块的**源码**区间（阶段 3 拖选）", async () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    const geo = { page: 1, xPt: 58, yPt: 100, widthPt: 371.25, heightPt: 20 };
    const rect = { left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    // 假命中测试：第一块给"块首"、第二块给"块尾"，便于断言选区两端
    const asked: number[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: 6 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3, geo), crop(5, 8, geo), crop(10, 13, geo)],
            onCropClick: async (req) => {
              asked.push(req.from);
              return req.from === 0 ? 0 : req.to; // 第一块 → 块首；另一块 → 块尾
            },
          }),
        ],
      }),
    });
    const list = Array.from(crops()) as HTMLElement[];
    let under = list[0];
    (document as unknown as Record<string, unknown>).elementFromPoint = () => under;
    // ① 在**第一张切片**上按下（锚点）
    list[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10, buttons: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(view.state.selection.main.head).toBe(0); // 精确命中的锚点
    // ② 拖到**第二张切片**上（buttons: 1 = 还在按着，CM 的 MouseSelection 靠它判断"在拖"）
    under = list[1];
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 90, clientY: 10, buttons: 1 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 90, clientY: 10 }));
    await new Promise((r) => setTimeout(r, 0));
    const sel = view.state.selection.main;
    expect({ from: sel.from, to: sel.to }).toEqual({ from: 0, to: 13 });
    // 选出来的是**源码**（与 Typora 一致：复制出去也是源码）
    expect(view.state.sliceDoc(sel.from, sel.to)).toBe("aaa\n\nbbb\n\nccc");
    // 三块都被**完整**盖住 → 除"光标（head=13，落在第三块里）那一块"外都保持切片外观
    // （用户要求：选中整块不要展开），那些切片挂 selected 类表示"被选中"；
    // 光标那一块必须展开成源码 —— 否则 DOM 里没有真实文本，打字会失灵（实测踩过）
    expect(host.querySelectorAll(".cm-block-crop").length).toBe(2);
    expect(host.querySelectorAll(".cm-block-crop-selected").length).toBe(2);
    // 选中色必须是一层**铺在 SVG 之上**的染色元素：切片 SVG 自带不透明白纸底，
    // 只给容器加背景色是看不见的（曾经还配了 1px outline → 全选时整页变网格，用户说「太丑了」）
    for (const el of Array.from(host.querySelectorAll(".cm-block-crop-selected"))) {
      const tint = el.querySelector(".cm-block-crop-tint");
      expect(tint).not.toBeNull();
      // 染色层必须是最后一个子节点之后仍能盖住 SVG（DOM 顺序在 svg 之后）
      const svgIndex = Array.from(el.children).indexOf(el.querySelector("svg") as Element);
      expect(Array.from(el.children).indexOf(tint as Element)).toBeGreaterThan(svgIndex);
    }
    expect(content()).toContain("ccc"); // 第三块展开成了源码
    expect(content()).not.toContain("aaa");
    expect(asked[0]).toBe(0); // 第一次命中问的是"按下去的那一块"
    expect(asked[asked.length - 1]).toBe(10); // 最后问的是"拖到的那一块"（第三块那张切片）
  });

  it("切片里的链接渲染成可点热区（阶段 3）：按百分比定位、点击交给 onOpenLink 且不动光标", () => {
    const doc = "aaa\n\nbbb\n";
    const geo = { page: 1, xPt: 58, yPt: 100, widthPt: 371.25, heightPt: 20 };
    const links = [
      { xPt: 10, yPt: 5, widthPt: 20, heightPt: 8, href: "https://example.com/x" },
      { xPt: 200, yPt: 10, widthPt: 40, heightPt: 8, href: "mailto:a@b.c" },
    ];
    const opened: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: 6 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3, { ...geo, links }), crop(5, 8, geo)],
            onOpenLink: (href) => opened.push(href),
          }),
        ],
      }),
    });
    const overlays = Array.from(host.querySelectorAll(".cm-block-crop-link")) as HTMLAnchorElement[];
    expect(overlays.length).toBe(2);
    expect(overlays.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com/x",
      "mailto:a@b.c",
    ]);
    // 按"带内相对 pt → 百分比"定位（与切片 SVG 的等比缩放一致）
    expect(parseFloat(overlays[0].style.left)).toBeCloseTo((10 / 371.25) * 100, 2);
    expect(parseFloat(overlays[0].style.top)).toBeCloseTo((5 / 20) * 100, 2);
    expect(parseFloat(overlays[0].style.width)).toBeCloseTo((20 / 371.25) * 100, 2);
    expect(parseFloat(overlays[0].style.height)).toBeCloseTo((8 / 20) * 100, 2);

    const before = view.state.selection.main.head;
    overlays[0].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened).toEqual(["https://example.com/x"]); // 打开的是链接，不是"把光标挪过来"
    expect(view.state.selection.main.head).toBe(before);
  });

  it("整块选中的围栏代码块：展开时把两行 ``` 围栏藏起来（用户要求「选中整个代码块请不要展开」）", () => {
    const doc = "开头。\n\n```rust\nfn main() {}\n```\n\n结尾。\n";
    // 代码块 = 位置 4..24；光标（head）落在代码块里 → 它必须展开（否则打不了字），
    // 但围栏不该露出来
    const fenceFrom = doc.indexOf("```rust");
    const fenceEnd = doc.indexOf("```", fenceFrom + 3);
    const block = crop(fenceFrom, fenceEnd + 3, { kind: "Raw", xPt: 58, yPt: 40, heightPt: 40 });
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        // 整块选中（选区正好覆盖 block.from..block.to）→ selected=true；
        // head 在块内 → 必须展开（DOM 里要有真实文本），此时围栏应当被藏起来
        selection: { anchor: block.from, head: block.to },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3), block, crop(31, 34)],
          }),
        ],
      }),
    });
    const shown = content();
    expect(shown).toContain("fn main() {}"); // 代码正文在（可选中、可编辑）
    expect(shown).not.toContain("```rust"); // 围栏被藏掉
    expect(shown).not.toContain("```");
  });

  it("编译错误所在的块不被切片盖住（波浪线才看得见）", () => {
    const doc = "aaa\n\nbbb\n\nccc\n";
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: 0 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => false,
            blocks: () => [crop(0, 3), crop(5, 8), crop(10, 13)],
            // 诊断落在第二块（位置 6）
            diagnosticRanges: () => [{ from: 6, to: 7 }],
          }),
        ],
      }),
    });
    // 光标在 aaa（第一块，本来就是源码），第二块因为错误也必须是源码、第三块仍是切片
    expect(content()).toContain("bbb");
    expect(content()).not.toContain("ccc");
    expect(crops().length).toBe(1);
  });

  it("块切片与公式 widget 不会重叠：被切片盖住的公式不再单独渲染", () => {
    // 行间公式自成一块且**已缓存**：如果两条装饰链各插一个 replace，CodeMirror 会抛
    // "Overlapping replacement decorations" —— 这条是那个约束的回归网。
    const doc = "aaa\n\n$ x^2 $\n\nccc\n";
    const mathRender: MathRender = {
      ok: true,
      svg: `<svg viewBox="0 0 10 7" width="10pt" height="7pt"></svg>`,
      widthPt: 10,
      heightPt: 7,
      baselinePt: 5,
    };
    const cache = new Map([[mathCacheKey("x^2", true, "", MATH_SIZE_PT), mathRender]]);
    host = document.createElement("div");
    document.body.appendChild(host);
    const blocks: Block[] = [crop(0, 3), crop(5, 12), crop(14, 17)];
    expect(() => {
      view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc,
          selection: { anchor: 0 },
          extensions: [
            livePreview({
              enabled: () => true,
              prefix: () => "",
              lookup: (key) => cache.get(key),
              onRequest: () => {},
              dark: () => false,
              blocks: () => blocks,
            }),
          ],
        }),
      });
    }).not.toThrow();
    expect(host.querySelectorAll(".cm-block-crop").length).toBe(2);
    expect(host.querySelectorAll(".cm-math-block").length).toBe(0); // 公式块已被切片覆盖
  });

  // 「完全隐藏，和 PDF 一样什么都看不到」（用户 2026-09-16 选定）：
  // `#set` / `#show` / `#let` / 注释行这类"规则"在真排版里没有输出（引擎对它们没有帧项、高度 0），
  // 所以写作模式下整格隐藏；光标/选区进去才展开成源码（照旧可编辑）。
  it("引擎没有输出的块（noOutput）整格隐藏；光标进去才展开成源码", () => {
    const doc = "#let x = 1\n\naaa\n";
    const blocks: Block[] = [
      crop(0, 10, { found: false, noOutput: true, svg: "", heightPt: 0 }),
      crop(12, 15),
    ];
    mount(doc, blocks); // 光标默认在文档末尾（第二块里）→ 第一块应被隐藏
    const text = () => host.querySelector(".cm-content")?.textContent ?? "";
    expect(text()).not.toContain("#let x = 1");
    expect(text()).toContain("aaa"); // 光标所在的第二块是源码形态
    expect(host.querySelectorAll(".cm-block-crop").length).toBe(0);
    // 光标进那一块 → 展开源码（可编辑）；同时第二块变成切片
    view.dispatch({ selection: { anchor: 5 } });
    expect(text()).toContain("#let x = 1");
    expect(host.querySelectorAll(".cm-block-crop").length).toBe(1);
  });

  it("**块表过期**的不可渲染块（noOutput=false）绝不隐藏 —— 它必须显示源码", () => {
    const doc = "#let x = 1\n\naaa\n";
    const blocks: Block[] = [
      crop(0, 10, { found: false, noOutput: false, svg: "", heightPt: 0 }),
      crop(12, 15),
    ];
    mount(doc, blocks);
    expect(host.querySelector(".cm-content")?.textContent).toContain("#let x = 1");
  });

  it("暗色主题给切片挂 cm-block-crop-dark（typst 产物是白底黑字，需整体反色）", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const blocks: Block[] = [crop(0, 3), crop(5, 8)];
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "aaa\n\nbbb\n",
        selection: { anchor: 6 },
        extensions: [
          livePreview({
            enabled: () => true,
            prefix: () => "",
            lookup: () => undefined,
            onRequest: () => {},
            dark: () => true,
            blocks: () => blocks,
          }),
        ],
      }),
    });
    expect(host.querySelectorAll(".cm-block-crop-dark").length).toBe(1);
  });
});
