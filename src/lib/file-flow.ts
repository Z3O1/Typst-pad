// 文件流程的**编排层**（从 +page.svelte 搬出来）：打开 / 保存 / 重新读取 / 新建 / 导出 PDF。
//
// 纯判定（该弹哪句确认、该写哪句状态栏）留在这里，真正的 IPC 与页面状态仍由页面注入 ——
// 与 zoom-controller.ts / update-flow.ts 同一套依赖注入写法，单测里用假 read/write/confirm
// 把下面这几条红线钉住：
//
// 1. **写盘只有一条路**：`save → write → write_file`（页面注入 file-ops.saveTypFile），
//    只挂在显式保存上 —— 没有自动保存，不按保存磁盘上一个字节也不动。
// 2. **「空文档存进已有文件」不弹确认窗、直接写空**（2026-09-18 用户明确要求删掉那道确认）。
//    别在 save() 里加回任何"文档是空的，确定要覆盖吗"的分支。
// 3. **打开/重读同一个文件也要先确认**（未保存时）：Windows 上把 .typ 拖进窗口很常见，
//    以前用 `filePath !== path` 放行同路径，会静默用磁盘内容盖掉未保存的输入。
// 4. **`clearState()` 只由主窗口做**：副窗口（Ctrl+Shift+N 的草稿窗口）点"新建"不能把主窗口
//    的未保存内容从存档里抹掉（见 isSecondaryWindow 的说明）。
// 5. **新建不写存档**（只清）：清掉会话后不再顺手 schedulePersist，否则刚清掉的会话又被写回。

import { failureStatus } from "./failure-text";
import type { OpenedFile } from "./file-ops";
import type { FontConfigArgs, PdfExportResult } from "./typst-engine";

/** 未保存确认窗的标题（三种动作共用） */
export const DISCARD_TITLE = "未保存的修改";
/** 打开另一个文件 */
export const DISCARD_OPEN_NOTICE = "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？";
/** 重新打开**当前这个**文件（拖放/关联打开同一个 .typ 是常态，见红线 3） */
export function discardReopenNotice(title: string): string {
  return `「${title}」有未保存的修改，重新打开将丢弃这些修改。仍要打开吗？`;
}
/** Ctrl+R 从磁盘重读 */
export const DISCARD_RELOAD_NOTICE =
  "当前文档有未保存的修改，重新读取将丢失这些修改。仍要重新读取吗？";
/** 新建（全应用唯一"不问就丢内容"的路，所以这道确认必须在） */
export const DISCARD_NEW_NOTICE = "当前文档有未保存的修改，新建将丢弃这些修改。仍要新建吗？";

/** 未命名文档的标题（新建后落回它） */
export const UNTITLED_TITLE = "未命名.typ";

/** 页面当前状态快照（判定与文案都要用） */
export interface FileSnapshot {
  /** 有**实际**未保存修改吗：页面传 `isEffectiveDirty(dirty, doc)` —— 空/纯空白文档不算 */
  dirty: boolean;
  /** 当前文档文本（保存时写这一份） */
  doc: string;
  /** 当前文件路径；未命名 = null */
  path: string | null;
  /** 当前文件标题（窗口标题栏同名的那份，用于同路径重开的确认文案） */
  title: string;
}

/** 打开/重读成功后要落到页面上的三样东西 */
export interface OpenedDocument {
  content: string;
  path: string;
  title: string;
}

export interface FileFlowHooks {
  snapshot(): FileSnapshot;
  /** 未保存确认：页面负责 Tauri confirm / 浏览器 window.confirm 的分支 */
  confirm(message: string, title: string): Promise<boolean>;
  /** 按路径读 .typ（file-ops.readTypFile） */
  read(path: string): Promise<OpenedFile>;
  /**
   * 写盘（file-ops.saveTypFile）：path 为 null 时弹系统"另存为"。
   * 返回最终落盘路径；用户取消返回 null。**抛异常 = 写失败**（原因交给 failureStatus）。
   */
  write(path: string | null, content: string): Promise<string | null>;
  /** 弹出"打开"对话框选路径；取消返回 null */
  pickPath(): Promise<string | null>;
  /**
   * 导出 PDF（typst-engine.compileToPdf：自己弹"另存为"+ Rust 侧编译落盘）。
   * 页面在实现里用 compileSource()/fontArgs() 拼参数即可。
   */
  exportPdf(req: {
    source: string;
    documentPath: string | null;
    suggestedName: string;
    fonts: FontConfigArgs;
  }): Promise<PdfExportResult>;
  /** 编译源 = 前缀（补尾随换行）+ 文档，PDF 导出与编译共用一份 */
  compileSource(): string;
  fontArgs(): FontConfigArgs;
  /** 打开/重读成功：整体替换文档（doc 与 editorDoc 一起换）+ 作废缓存 + 排编译 + 写存档 */
  applyOpenedDocument(opened: OpenedDocument): void;
  /** 保存成功：路径/标题/未保存标记落定 + 写存档 */
  afterSave(path: string): void;
  /** 新建：文档置空为「未命名.typ」（不含清存档，见 clearSession 的调用时机） */
  resetDocument(): void;
  /** 清掉会话存档（persistence.clearState）——只有主窗口能调，见红线 4 */
  clearSession(): void;
  isSecondaryWindow(): boolean;
  setStatus(text: string): void;
  /** 导出失败时把预览区也置成错误态（与整页编译失败同一套展示） */
  setPreviewError(message: string): void;
}

export interface FileFlow {
  /** 有未保存修改就问一句；用户点"取消"返回 false */
  confirmDiscard(message?: string, title?: string): Promise<boolean>;
  /** 按路径打开（打开对话框/拖放/关联打开共用）；已打开返回 true */
  openPath(path: string): Promise<boolean>;
  /** 菜单/快捷键「打开…」：先弹对话框再 openPath */
  openViaDialog(): Promise<void>;
  /** 保存（未命名 → 另存为）；返回落盘路径，取消返回 null */
  save(): Promise<string | null>;
  /** Ctrl+R：从磁盘重新读取当前文件（未命名文档忽略） */
  reload(): Promise<void>;
  /**
   * 新建：清空文档（有未保存修改先确认）。
   *
   * 这是全应用唯一"不问就丢内容"的路 —— 它把编辑器清空、`filePath` 置空，还顺手
   * `clearState()` 清掉会话存档，连"启动恢复上次内容"那条后路一起断；所以那道确认必须在
   * （2026-09-16 用户问过「编辑器会清空文件吗」之后补齐）。
   * 磁盘文件不受影响：`filePath` 被置空，紧接着按 Ctrl+S 走的是"另存为"，覆盖不到原文件。
   */
  createNew(): Promise<void>;
  /** 导出 PDF（另存为对话框 + Rust 侧编译落盘） */
  exportPdf(): Promise<void>;
}

export function createFileFlow(hooks: FileFlowHooks): FileFlow {
  async function confirmDiscard(
    message = DISCARD_OPEN_NOTICE,
    title = DISCARD_TITLE,
  ): Promise<boolean> {
    return await hooks.confirm(message, title);
  }

  async function openPath(path: string): Promise<boolean> {
    const snap = hooks.snapshot();
    // 有未保存修改就必须确认 —— **包括打开的就是当前这个文件**（红线 3）
    if (snap.dirty) {
      const same = snap.path === path;
      const ok = await confirmDiscard(
        same ? discardReopenNotice(snap.title) : DISCARD_OPEN_NOTICE,
      );
      if (!ok) return false;
    }
    try {
      const opened = await hooks.read(path);
      hooks.applyOpenedDocument({
        content: opened.content,
        path: opened.path,
        title: opened.path.split(/[\\/]/).pop() ?? opened.path,
      });
      hooks.setStatus("已打开");
      return true;
    } catch (e) {
      // 带上 Rust 侧的原因（`仅支持 .typ 文件` / `目录无效` …）：光写「打开失败」用户不知道能改什么
      hooks.setStatus(failureStatus("打开失败", e));
      return false;
    }
  }

  async function openViaDialog(): Promise<void> {
    const path = await hooks.pickPath();
    if (!path) return;
    await openPath(path);
  }

  async function save(): Promise<string | null> {
    // 这里**没有**「空文档覆盖已有文件」的确认（红线 2）：空文档直接写空
    try {
      const snap = hooks.snapshot();
      const saved = await hooks.write(snap.path, snap.doc);
      if (!saved) return null; // 用户取消了"另存为"
      hooks.afterSave(saved);
      return saved;
    } catch (e) {
      hooks.setStatus(failureStatus("保存失败", e));
      return null;
    }
  }

  async function reload(): Promise<void> {
    const snap = hooks.snapshot();
    if (!snap.path) return; // 未命名文档：忽略
    if (snap.dirty) {
      const ok = await confirmDiscard(DISCARD_RELOAD_NOTICE);
      if (!ok) return;
    }
    try {
      const opened = await hooks.read(snap.path);
      hooks.applyOpenedDocument({
        content: opened.content,
        path: opened.path,
        title: opened.path.split(/[\\/]/).pop() ?? opened.path,
      });
      hooks.setStatus("已重新读取");
    } catch (e) {
      hooks.setStatus(failureStatus("重新读取失败", e));
    }
  }

  async function createNew(): Promise<void> {
    const snap = hooks.snapshot();
    if (snap.dirty) {
      const ok = await confirmDiscard(DISCARD_NEW_NOTICE);
      if (!ok) return;
    }
    hooks.resetDocument();
    // 清存档**只由主窗口做**（红线 4）：副窗口的内容是空的，抹掉存档等于替主窗口丢内容
    if (!hooks.isSecondaryWindow()) hooks.clearSession();
    hooks.setStatus("已新建");
  }

  async function exportPdf(): Promise<void> {
    hooks.setStatus("导出 PDF…");
    const snap = hooks.snapshot();
    try {
      const result = await hooks.exportPdf({
        source: hooks.compileSource(),
        documentPath: snap.path,
        suggestedName: snap.title,
        fonts: hooks.fontArgs(),
      });
      if (result.ok) {
        hooks.setStatus("已导出 PDF");
      } else if (result.cancelled) {
        hooks.setStatus("已取消导出");
      } else {
        hooks.setStatus(failureStatus("导出失败", result.error));
        hooks.setPreviewError(result.error);
      }
    } catch (e) {
      hooks.setStatus(failureStatus("导出失败", e));
      hooks.setPreviewError(e instanceof Error ? e.message : String(e));
    }
  }

  return { confirmDiscard, openPath, openViaDialog, save, reload, createNew, exportPdf };
}
