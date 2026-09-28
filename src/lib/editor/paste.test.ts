// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createPaste } from "./paste";

// jsdom 没实现 Range 的几何 API，而 CodeMirror 的测量会用到它（与别的编辑器单测同一处理）
beforeAll(() => {
  (Range.prototype as unknown as { getClientRects: () => [] }).getClientRects = () => [];
});

/** 造一个"粘贴事件"：jsdom 不实现 DataTransfer/ClipboardEvent 的构造，这里给足用到的接口 */
function pasteEvent(data: { text?: string; html?: string; files?: File[]; fail?: boolean }) {
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

function mount(doc: string, opts: { fail?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const saved: string[] = [];
  const errors: string[] = [];
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        createPaste({
          onPasteImage: async (file) => {
            if (opts.fail) throw new Error("磁盘满了");
            saved.push(`${file.name}:${file.type}`);
            return "image-1.png";
          },
          onPasteError: (m) => errors.push(m),
        }),
      ],
    }),
  });
  const paste = (ev: Event) => view.contentDOM.dispatchEvent(ev);
  return { view, host, saved, errors, paste };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createPaste：图片", () => {
  it('把图片交给页面写盘，再在光标处插入 #image("相对路径")', async () => {
    const { view, saved, paste, host } = mount("前文\n");
    const file = new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" });
    const ev = pasteEvent({ files: [file] });
    paste(ev);
    // 事件被接管（不让浏览器把图片变成不可控的默认粘贴）
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    await tick();
    expect(saved).toEqual(["截图.png:image/png"]);
    expect(view.state.doc.toString()).toBe('前文\n#image("image-1.png")');
    view.destroy();
    host.remove();
  });

  it("写盘失败：提示原因，**不插入半截源码**", async () => {
    const { view, errors, paste, host } = mount("前文\n", { fail: true });
    paste(pasteEvent({ files: [new File([new Uint8Array([0])], "a.png", { type: "image/png" })] }));
    await tick();
    await tick();
    expect(errors).toEqual(["磁盘满了"]);
    expect(view.state.doc.toString()).toBe("前文\n");
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
    const { view, paste, host } = mount("");
    // 先按一次 Ctrl+Shift+V（真实路径里 paste 紧跟在 keydown 之后）
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "v",
        code: "KeyV",
        keyCode: 86,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
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
