// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createPaste, imageFilesFrom } from "./paste";

// jsdom 没实现 Range 的几何 API，而 CodeMirror 的测量会用到它（与别的编辑器单测同一处理）
beforeAll(() => {
  (Range.prototype as unknown as { getClientRects: () => [] }).getClientRects = () => [];
});

/** 造一个"粘贴事件"：jsdom 不实现 DataTransfer/ClipboardEvent 的构造，这里给足用到的接口 */
function pasteEvent(data: { text?: string; html?: string; files?: File[] }) {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  const files = data.files ?? [];
  Object.defineProperty(ev, "clipboardData", {
    value: {
      items: files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      files,
      getData: (t: string) =>
        t === "text/plain" ? (data.text ?? "") : t === "text/html" ? (data.html ?? "") : "",
    },
  });
  return ev;
}

interface MountOptions {
  /** 写盘失败信息（不给 = 成功） */
  fail?: string;
  /** 自定义写盘：返回相对路径；用它可以扣住响应，模拟"写盘期间用户继续编辑 / 切文档" */
  save?: (file: File) => Promise<string>;
}

function mount(doc: string, opts: MountOptions = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const saved: string[] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const extensions = createPaste({
    onPasteImage: async (file) => {
      saved.push(`${file.name}:${file.type}`);
      if (opts.fail) throw new Error(opts.fail);
      return opts.save ? await opts.save(file) : "image-1.png";
    },
    onPasteError: (message) => errors.push(message),
    onPasteSaved: (relative) => notices.push(relative),
  });
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions,
    }),
  });
  const paste = (ev: Event) => view.contentDOM.dispatchEvent(ev);
  const keydown = (init: KeyboardEventInit) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  return { view, host, saved, errors, notices, paste, keydown, extensions };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const image = (name = "截图.png", type = "image/png", bytes = [1, 2, 3]) =>
  new File([new Uint8Array(bytes)], name, { type });

/** 一个手动 resolve 的写盘：用来在"写盘还没回复"期间继续编辑或换文档 */
function deferredSave() {
  let resolve: ((path: string) => void) | null = null;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve: (path: string) => resolve?.(path) };
}

describe("imageFilesFrom", () => {
  it("只挑 image/*，没有图片时返回空", () => {
    const png = image();
    const txt = new File(["x"], "a.txt", { type: "text/plain" });
    const list = [txt, png] as unknown as FileList;
    expect(imageFilesFrom(null, list)).toEqual([png]);
    expect(imageFilesFrom(null, [txt] as unknown as FileList)).toEqual([]);
    expect(imageFilesFrom(null, null)).toEqual([]);
  });
});

describe("createPaste：图片", () => {
  it('把图片交给页面写盘，再在光标处插入 #image("相对路径")', async () => {
    const { view, saved, notices, paste, host } = mount("前文\n");
    const ev = pasteEvent({ files: [image()] });
    paste(ev);
    // 事件被接管（不让浏览器把图片变成不可控的默认粘贴）
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    await tick();
    expect(saved).toEqual(["截图.png:image/png"]);
    expect(notices).toEqual(["image-1.png"]);
    expect(view.state.doc.toString()).toBe('前文\n#image("image-1.png")');
    expect(view.state.selection.main.head).toBe('前文\n#image("image-1.png")'.length);
    view.destroy();
    host.remove();
  });

  it("写盘失败：提示原因，**不插入半截源码**", async () => {
    const { view, errors, paste, host } = mount("前文\n", { fail: "磁盘满了" });
    paste(pasteEvent({ files: [image()] }));
    await tick();
    await tick();
    expect(errors).toEqual(["磁盘满了"]);
    expect(view.state.doc.toString()).toBe("前文\n");
    view.destroy();
    host.remove();
  });

  it("写盘期间继续编辑：插入点跟着变更走，不插到旧位置", async () => {
    const gate = deferredSave();
    const { view, paste, host } = mount("甲\n", { save: () => gate.promise });
    view.dispatch({ selection: { anchor: 1 } }); // 光标在"甲"之后
    paste(pasteEvent({ files: [image()] }));
    await tick();
    // 用户先在最前面打字：插入点必须整体后移
    view.dispatch({ changes: { from: 0, insert: "前缀" }, selection: { anchor: 2 } });
    gate.resolve("image-7.png");
    await tick();
    await tick();
    expect(view.state.doc.toString()).toBe('前缀甲#image("image-7.png")\n');
    view.destroy();
    host.remove();
  });

  it("写盘期间切换文档：不往新文档里插源码，只提示已保存的文件名", async () => {
    const gate = deferredSave();
    const { view, errors, paste, host, extensions } = mount("旧文档", { save: () => gate.promise });
    paste(pasteEvent({ files: [image()] }));
    await tick();
    // 新建 / 打开 / 重读都走这条：整个 EditorState 被换掉
    view.setState(EditorState.create({ doc: "新文档", extensions }));
    gate.resolve("image-9.png");
    await tick();
    await tick();
    expect(view.state.doc.toString()).toBe("新文档");
    expect(errors).toEqual(["图片已保存为 image-9.png，但文档已切换，未插入源码"]);
    view.destroy();
    host.remove();
  });

  it("Ctrl+Shift+V 仍然按图片处理（纯文本约束对图片没有可选形态）", async () => {
    const { view, saved, keydown, paste, host } = mount("");
    keydown({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true });
    const ev = pasteEvent({ text: "文字", files: [image()] });
    paste(ev);
    await tick();
    await tick();
    expect(saved).toHaveLength(1);
    expect(view.state.doc.toString()).toBe('#image("image-1.png")');
    view.destroy();
    host.remove();
  });

  it("同一处连续贴两张：按落地顺序分段，不挤成一行", async () => {
    let count = 0;
    const { view, paste, host } = mount("", { save: async () => `image-${++count}.png` });
    paste(pasteEvent({ files: [image("a.png"), image("b.png")] }));
    await tick();
    await tick();
    await tick();
    expect(view.state.doc.toString()).toBe('#image("image-1.png")\n\n#image("image-2.png")');
    view.destroy();
    host.remove();
  });
});

describe("createPaste：纯文本兜底", () => {
  it("只有 HTML（没有 text/plain）时抽成纯文本，绝不把标签塞进源码", () => {
    const { view, paste, host } = mount("");
    paste(pasteEvent({ html: "<p>甲</p><ul><li>乙</li></ul>" }));
    expect(view.state.doc.toString()).toBe("甲\n- 乙");
    view.destroy();
    host.remove();
  });

  it("同时有 text/plain 与 text/html 且不按修饰键 → 走 CodeMirror 默认粘贴（插纯文本）", () => {
    const { view, paste, host } = mount("");
    paste(pasteEvent({ text: "纯文本", html: "<p>纯文本</p>" }));
    // 我们的处理器在这条路上返回 false，由 CodeMirror 自己的粘贴把 text/plain 插进来 ——
    // 这条断言同时证明"加了钩子没有把默认粘贴弄坏"。
    expect(view.state.doc.toString()).toBe("纯文本");
    view.destroy();
    host.remove();
  });

  it("Ctrl+Shift+V：即使剪贴板同时给 HTML，也只插 text/plain", () => {
    const { view, keydown, paste, host } = mount("");
    // 真实路径里 paste 紧跟在 keydown 之后
    keydown({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true });
    const ev = pasteEvent({ text: "甲 乙", html: "<p>甲&nbsp;&nbsp;乙</p>" });
    paste(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("甲 乙");
    view.destroy();
    host.remove();
  });

  it("空剪贴板（既无文本也无 HTML）不动文档", () => {
    const { view, paste, host } = mount("");
    paste(pasteEvent({}));
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
    host.remove();
  });
});
