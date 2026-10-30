// **粘贴事件的接线**：图片落盘 + 纯文本兜底。
//
// 分档：
//   ① **图片**（`image/*`）：交给页面写进文档旁边的磁盘（`onPasteImage`），再在**粘贴发生的位置**
//      插入 `#image("相对路径")`。排版结果由引擎画，不作为富文本进文档 —— 与"源码是唯一真相"一致。
//      **图片优先于任何修饰键**：`Ctrl+Shift+V` 只约束文本的形态，剪贴板里是一张图时它没有可选形态。
//   ② **纯文本**：默认走 CodeMirror 自己的粘贴（原样插入）。只有两种情形这里才显式接管：
//       - **Ctrl/Cmd+Shift+V**：强制纯文本（有些应用同时给 `text/html`）；
//       - 剪贴板**只有 HTML**（没有 `text/plain`）：退化成"抽掉标签的文本"（`htmlToText`），
//         绝不把 HTML 塞进源码。HTML → Typst 的智能转换不在本轮范围。
//
// 边界：判定与插入在编辑器侧，写盘与路径策略在页面侧（`core/file-ops.ts`）。图片写盘失败只提示、
// 不插入半截源码 —— 不吞按键、不写坏文档。
//
// **异步写盘期间的位置与文档身份**：写盘是异步的，用户可能继续编辑、切文件或新建。直接记住
// 像素位置在继续编辑后就是错的，而重建编辑器（新会话）后连"同一个文档"都不成立。所以插入点是
// 一个 `StateField` 里的待办：继续编辑时按变更映射，会话重建（EditorState 整体替换）时
// **待办自然消失** —— 迟到的写盘结果只提示文件名，不往新文档里插源码。
import { EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { htmlToText, imageSnippet } from "../core/paste";

export interface PasteOptions {
  /** 两种模式下都可用（缺省 true） */
  enabled?: () => boolean;
  /**
   * 把一张粘贴进来的图片写进磁盘，返回**写进 Typst 源码的相对路径**（相对文档所在目录）。
   * 抛错 = 这次粘贴失败（页面负责提示原因）。
   */
  onPasteImage: (file: File) => Promise<string>;
  /** 提示文本（页面据此写状态栏）；不给就只记控制台 */
  onPasteError?: (message: string) => void;
  /** 图片落盘成功（页面用它在状态栏说一句"已保存图片 …"） */
  onPasteSaved?: (relativePath: string) => void;
}

/** 一次待落地的图片插入：`from`/`to` 是按下粘贴那一刻的选区，随文档变更映射 */
interface PasteTarget {
  id: number;
  from: number;
  to: number;
}

const addPasteTarget = StateEffect.define<PasteTarget>();
const dropPasteTarget = StateEffect.define<number>();

/**
 * 待落地的图片插入点。
 *
 * 只映射、不推断：用户继续打字时 `from`/`to` 跟着变更走（assoc=1，插在同一处的多张图保持
 * 剪贴板顺序）；整个 `EditorState` 被换掉（新建 / 打开 / 重读 / 会话恢复）时这个字段重新
 * `create`，旧待办自动消失，迟到结果只能提示、不能回写新文档。
 */
const pasteTargets = StateField.define<PasteTarget[]>({
  create: () => [],
  update(targets, tr) {
    let next = targets.map((target) => ({
      id: target.id,
      from: tr.changes.mapPos(target.from, 1),
      to: tr.changes.mapPos(target.to, 1),
    }));
    for (const effect of tr.effects) {
      if (effect.is(addPasteTarget)) next.push(effect.value);
      else if (effect.is(dropPasteTarget)) next = next.filter((one) => one.id !== effect.value);
    }
    return next;
  },
});

/** 从一次粘贴里挑出图片文件（按 `image/*` 过滤；没有返回空数组） */
export function imageFilesFrom(
  items: DataTransferItemList | null | undefined,
  files: FileList | null | undefined,
): File[] {
  const out: File[] = [];
  if (files) {
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) out.push(file);
    }
  }
  if (out.length === 0 && items) {
    for (const item of Array.from(items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) out.push(file);
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
   * 这个窗口是给"仍然把 HTML 塞进来"的 WebView 兜底。
   */
  let forcePlainUntil = 0;
  let nextTargetId = 1;

  return [
    pasteTargets,
    EditorView.domEventHandlers({
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
        const data = event.clipboardData;
        if (!data) return false;

        const images = imageFilesFrom(data.items, data.files);
        if (images.length > 0) {
          // 图片优先：`Ctrl+Shift+V` 说的是"文本要纯"，对图片没有可选形态。
          event.preventDefault();
          const at = view.state.selection.main;
          const targets = images.map((file) => ({ id: nextTargetId++, file }));
          // 一次事务把所有待办插入点登记好；后续继续编辑按变更映射。
          view.dispatch({
            effects: targets.map(({ id }) => addPasteTarget.of({ id, from: at.from, to: at.to })),
          });
          // 同一处落多张图时按实际落地顺序分隔成段，避免 `#image` 挤成一行。
          let placed = 0;
          for (const { id, file } of targets) {
            void (async () => {
              let relative: string;
              try {
                relative = await opts.onPasteImage(file);
              } catch (error) {
                view.dispatch({ effects: dropPasteTarget.of(id) });
                const message = error instanceof Error ? error.message : String(error);
                console.error("[paste] 图片保存失败：", error);
                opts.onPasteError?.(message);
                return;
              }
              opts.onPasteSaved?.(relative);
              const target = view.state.field(pasteTargets, false)?.find((one) => one.id === id);
              if (!target) {
                // 会话已经换掉（新建 / 打开 / 重读）：图片在磁盘上，但不属于当前文档
                opts.onPasteError?.(`图片已保存为 ${relative}，但文档已切换，未插入源码`);
                return;
              }
              const insert = `${placed > 0 ? "\n\n" : ""}${imageSnippet(relative)}`;
              placed += 1;
              view.dispatch({
                changes: { from: target.from, to: target.to, insert },
                selection: { anchor: target.from + insert.length },
                effects: dropPasteTarget.of(id),
                scrollIntoView: true,
                userEvent: "input.paste",
              });
            })();
          }
          return true;
        }

        const text = data.getData("text/plain");
        const html = data.getData("text/html");
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
    }),
  ];
}
