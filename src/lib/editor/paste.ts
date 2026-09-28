// **粘贴事件的接线**（typora-parity 审计 P0-4）：图片落盘 + 纯文本兜底。
//
// 分档（与审计一致）：
//   ① **图片**（`image/*`）：交给页面写进文档旁边的磁盘（`onPasteImage`），再在光标处插入
//      `#image("相对路径")`。排版结果由引擎画，**不作为富文本进文档** —— 与"源码是唯一真相"一致。
//   ② **纯文本**：默认走 CodeMirror 自己的粘贴（原样插入）。只有两种情形这里才显式接管：
//       - **Ctrl/Cmd+Shift+V**：强制纯文本（有些应用同时给 `text/html`）；
//       - 剪贴板**只有 HTML**（没有 `text/plain`）：退化成"抽掉标签的文本"（`htmlToText`），
//         绝不把 HTML 塞进源码。HTML → Typst 的智能转换是审计里的 P1，本轮不做。
//
// 边界：判定与插入在编辑器侧，写盘与路径策略在页面侧（`core/file-ops.ts`）。图片写盘失败只提示、
// 不插入半截源码 —— 不吞按键、不写坏文档。
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { htmlToText, imageSnippet } from "../core/paste";

export interface PasteOptions {
  /** 图片与纯文本粘贴在两种模式下都可用（缺省 true） */
  enabled?: () => boolean;
  /**
   * 把一张粘贴进来的图片写进磁盘，返回**写进 Typst 源码的相对路径**（相对文档所在目录）。
   * 抛错 = 这次粘贴失败（页面负责提示原因）。
   */
  onPasteImage: (file: File) => Promise<string>;
  /** 失败提示（页面据此写状态栏）；不给就只记控制台 */
  onPasteError?: (message: string) => void;
}

/** 从一次粘贴里挑出图片文件（按 `image/*` 过滤；没有返回空数组） */
export function imageFilesFrom(
  items: DataTransferItemList | null | undefined,
  files: FileList | null | undefined,
): File[] {
  const out: File[] = [];
  if (files) {
    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  if (out.length === 0 && items) {
    for (const it of Array.from(items)) {
      if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** 纯文本/图片粘贴的扩展；见文件头 */
export function createPaste(opts: PasteOptions): Extension {
  /**
   * `Ctrl/Cmd+Shift+V` 的时间戳。
   *
   * 为什么不能直接读 `event.ctrlKey`：按 DOM 规范 `paste` 事件的类型是 `ClipboardEvent`，
   * 它**没有**修饰键字段（浏览器实际派发时也不保证带上）。所以在 keydown 里记一笔，
   * paste 时按一个小窗口认领。浏览器自己的"粘贴并匹配样式"通常已经只给 `text/plain`，
   * 这个窗口是给"仍然把 HTML 塞进来"的 WebView 兜底（审计 P0-4 的第三条）。
   */
  let forcePlainUntil = 0;
  return EditorView.domEventHandlers({
    keydown(event) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        (event.key === "v" || event.key === "V")
      ) {
        forcePlainUntil = Date.now() + 1500;
      }
      return false;
    },
    paste(event, view) {
      if (opts.enabled && !opts.enabled()) return false;
      const dt = event.clipboardData;
      if (!dt) return false;
      const images = imageFilesFrom(dt.items, dt.files);
      if (images.length > 0) {
        event.preventDefault();
        // 捕获插入点：写盘是异步的，加载完之后用户可能已经动了光标 —— 但"粘贴发生在哪"是
        // 用户按下这一刻的意图，所以按捕获的位置插入（越界时夹到文档末尾）。
        const at = view.state.selection.main;
        const from = at.from;
        const to = at.to;
        void (async () => {
          const snippets: string[] = [];
          for (let i = 0; i < images.length; i++) {
            try {
              const rel = await opts.onPasteImage(images[i]);
              if (rel) snippets.push(imageSnippet(rel));
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error("[paste] 图片保存失败：", e);
              opts.onPasteError?.(msg);
            }
          }
          if (snippets.length === 0) return;
          const len = view.state.doc.length;
          const at2 = Math.min(from, len);
          const to2 = Math.min(to, len);
          // 每张图片一段（Typst 里 `#image` 是块级内容；贴在一起会挤成一行）
          const insert = snippets.join("\n\n");
          view.dispatch({
            changes: { from: at2, to: to2, insert },
            selection: { anchor: at2 + insert.length },
            scrollIntoView: true,
            userEvent: "input.paste",
          });
        })();
        return true;
      }
      const text = dt.getData("text/plain");
      const html = dt.getData("text/html");
      const forcePlain = Date.now() < forcePlainUntil;
      const htmlOnly = text === "" && html !== "";
      if (!forcePlain && !htmlOnly) return false; // 默认粘贴（纯文本）交给 CodeMirror
      const plain = text !== "" ? text : htmlToText(html);
      if (plain === "") return false;
      event.preventDefault();
      const at = view.state.selection.main;
      view.dispatch({
        changes: { from: at.from, to: at.to, insert: plain },
        selection: { anchor: at.from + plain.length },
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      return true;
    },
  });
}
