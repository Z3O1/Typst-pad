// 外部程序修改当前 .typ 文件的检测与处理。
//
// 策略（经用户确认）：
// - 当前编辑器**没有**未保存修改时，检测到磁盘变化自动重读新内容；
// - 当前编辑器**有**未保存修改时，弹出确认框让用户选择「重读磁盘」或「保留当前内容」；
// - 绝不静默覆盖当前内容，也不自动写盘。
//
// 与 `document-session.ts` 的分工：那边管显式打开/保存/新建/重读；这里管**被动**的外部变更。
// 所有写盘仍走 document-session.save() → file-ops.saveTypFile() → Rust write_file。

import { isDocModified } from "./doc-utils";
import type { OpenedFile } from "./file-ops";

const DIALOG_TITLE = "文件已被外部修改";
const SAVE_CONFLICT_TITLE = "保存冲突";
const DEBOUNCE_MS = 150;

export interface ExternalFileChangeHooks {
  /** 当前正在编辑的文件路径 */
  currentPath(): string | null;
  /** 当前编辑器正文 */
  currentDoc(): string;
  /** 当前基线（用于判断是否有未保存修改） */
  currentBaseline(): string | null;
  /** 应用磁盘内容：建立新会话、清撤销、重编译、持久化 */
  applyReload(path: string, content: string): void;
  /** 提示用户选择；返回 true 表示「重读磁盘」，false 表示「保留当前内容」 */
  promptReloadOrKeep(message: string, title: string): Promise<boolean>;
  setStatus(text: string): void;
  readFile(path: string): Promise<OpenedFile>;
  startWatch(path: string): Promise<void>;
  stopWatch(): Promise<void>;
}

export interface ExternalFileChange {
  /** 切换要监控的文件；传 null 表示停止监控 */
  watchPath(path: string | null): Promise<void>;
  /** 收到 Rust 发来的 file-changed 事件 */
  onFileChanged(payload: { path: string }): void;
  /** 是否存在已知的外部变更冲突（用于保存前确认） */
  hasConflict(): boolean;
  /** 保存前调用；返回 true 表示可以继续保存 */
  confirmSaveIfConflict(): Promise<boolean>;
  /** 保存成功后清除冲突标记 */
  clearConflict(): void;
  /** 卸载时解绑 */
  dispose(): Promise<void>;
}

export function createExternalFileChange(hooks: ExternalFileChangeHooks): ExternalFileChange {
  let watchedPath: string | null = null;
  let pendingConflict = false;
  /** 用户选择「保留当前内容」的那份磁盘内容；同一版本不再重复打扰 */
  let lastIgnoredDiskContent: string | null = null;
  let lastIgnoredPath: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function isDirty(): boolean {
    return isDocModified(hooks.currentDoc(), hooks.currentBaseline());
  }

  function clearTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  async function watchPath(path: string | null): Promise<void> {
    if (disposed) return;
    clearTimer();
    // 同路径不必重启 watch（保存/外部重读后仍监控同一个文件），只清冲突状态。
    if (path === watchedPath) {
      pendingConflict = false;
      lastIgnoredDiskContent = null;
      lastIgnoredPath = null;
      return;
    }
    watchedPath = path;
    pendingConflict = false;
    lastIgnoredDiskContent = null;
    lastIgnoredPath = null;
    try {
      if (path) {
        await hooks.stopWatch();
        await hooks.startWatch(path);
      } else {
        await hooks.stopWatch();
      }
    } catch (e) {
      hooks.setStatus(`文件监控失败：${e}`);
    }
  }

  function onFileChanged(payload: { path: string }): void {
    if (disposed) return;
    if (payload.path !== watchedPath) return; // 旧路径事件作废
    clearTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void checkDisk(payload.path);
    }, DEBOUNCE_MS);
  }

  async function checkDisk(path: string): Promise<void> {
    if (disposed || path !== watchedPath) return;

    let content: string;
    try {
      content = (await hooks.readFile(path)).content;
    } catch (e) {
      handleUnreadable();
      return;
    }

    const doc = hooks.currentDoc();
    if (content === doc) {
      // 自己的 save 或同内容变更：不需要任何动作
      pendingConflict = false;
      return;
    }

    if (!isDirty()) {
      // 干净文档自动重读
      hooks.applyReload(path, content);
      pendingConflict = false;
      lastIgnoredDiskContent = null;
      lastIgnoredPath = null;
      hooks.setStatus("已自动重新读取外部修改");
      return;
    }

    // 有未保存修改：询问用户
    if (content === lastIgnoredDiskContent && path === lastIgnoredPath) {
      // 同一磁盘版本已经选择过保留，不再重复弹窗
      return;
    }

    const reload = await hooks.promptReloadOrKeep(
      `「${path}」已被外部程序修改。是否重新读取磁盘内容？\n选择「取消」将保留当前未保存的编辑。`,
      DIALOG_TITLE,
    );

    // 弹窗期间用户不能编辑（原生/系统确认框阻塞），但仍要防止会话已切换
    if (disposed || path !== watchedPath) return;

    if (reload) {
      hooks.applyReload(path, content);
      pendingConflict = false;
      lastIgnoredDiskContent = null;
      lastIgnoredPath = null;
      hooks.setStatus("已重新读取磁盘内容");
    } else {
      lastIgnoredDiskContent = content;
      lastIgnoredPath = path;
      pendingConflict = true;
      hooks.setStatus("已保留当前内容（磁盘版本已变更）");
    }
  }

  function handleUnreadable(): void {
    if (isDirty()) {
      hooks.setStatus("文件已删除或暂时无法读取，已保留当前未保存内容");
    } else {
      hooks.setStatus("外部修改检测：文件已删除或暂时无法读取");
    }
    pendingConflict = false;
  }

  function hasConflict(): boolean {
    return pendingConflict;
  }

  async function confirmSaveIfConflict(): Promise<boolean> {
    if (!pendingConflict) return true;
    const proceed = await hooks.promptReloadOrKeep(
      "磁盘上的文件已被外部程序修改，保存会覆盖这些修改。仍要保存吗？",
      SAVE_CONFLICT_TITLE,
    );
    return proceed;
  }

  function clearConflict(): void {
    pendingConflict = false;
    lastIgnoredDiskContent = null;
    lastIgnoredPath = null;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    clearTimer();
    watchedPath = null;
    pendingConflict = false;
    try {
      await hooks.stopWatch();
    } catch {
      // 卸载时忽略停止失败
    }
  }

  return {
    watchPath,
    onFileChanged,
    hasConflict,
    confirmSaveIfConflict,
    clearConflict,
    dispose,
  };
}
