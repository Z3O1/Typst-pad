// 外部程序修改当前 .typ 文件的检测与处理。
//
// 策略（经用户确认）：
// - 当前编辑器**没有**未保存修改时，检测到磁盘变化自动重读新内容；
// - 当前编辑器**有**未保存修改时，弹出确认框让用户选择「重读磁盘」或「保留当前内容」；
// - 绝不静默覆盖当前内容，也不自动写盘。
//
// 异步安全：每个文件变更事件都会绑定「路径 + 正文 + 基线 + 会话」快照；
// 所有 await（读盘、提示）之后重新核对快照，路径切换 / 同路径新会话 / dispose
// 都会让旧结果作废。同一时刻只跑一次检查，新事件排成 latest-demand，
// 防止重叠 prompt、乱序 read 把旧版本写回当前编辑器。

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
  /** 可选：会话/版本标识；提供时参与过期判定 */
  currentSession?(): number | string;
  /** 正文事务版本，包含输入后撤销回相同内容的情况 */
  currentRevision?(): number;
  /** 应用磁盘内容：建立新会话、清撤销、重编译、持久化 */
  applyReload(path: string, content: string): void;
  /** 提示用户选择；返回 true 表示「重读磁盘」，false 表示「保留当前内容」 */
  promptReloadOrKeep(message: string, title: string): Promise<boolean>;
  setStatus(text: string): void;
  readFile(path: string): Promise<OpenedFile>;
  startWatch(path: string): Promise<void>;
  stopWatch(): Promise<void>;
}

export interface ExternalFileSaveToken {
  readonly path: string | null;
  readonly session: number | string | undefined;
  readonly generation: number;
}

export interface ExternalFileChange {
  /** 切换要监控的文件；传 null 表示停止监控 */
  watchPath(path: string | null, session?: number | string): Promise<void>;
  /** 收到 Rust 发来的 file-changed 事件 */
  onFileChanged(payload: { path: string }): void;
  /** 是否存在已知的外部变更冲突（用于保存前确认） */
  hasConflict(): boolean;
  /** 显式保存的同步入口：同身份只允许一次保存，暂缓检查但保留最新事件。 */
  beginSave(): ExternalFileSaveToken | null;
  /** 保存前调用；返回 true 表示可以继续保存。传 token 时检查槽保留到 endSave。 */
  confirmSaveIfConflict(token?: ExternalFileSaveToken): Promise<boolean>;
  /** write 回复、基线应用或取消/失败后释放；旧身份 token 不影响新保存。 */
  endSave(token: ExternalFileSaveToken): void;
  /** 保存成功后核对实际写入快照；不能清掉期间出现的另一磁盘版本冲突 */
  acknowledgeSave(path: string, content: string): void;
  clearConflict(): void;
  /** 卸载时解绑 */
  dispose(): Promise<void>;
}

export function createExternalFileChange(hooks: ExternalFileChangeHooks): ExternalFileChange {
  let watchedPath: string | null = null;
  let watchedSession: number | string | undefined;
  let generation = 0;
  let watchQueue: Promise<void> = Promise.resolve();
  /** 最新到达但尚未开始检查的路径 */
  let pendingPath: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前正在执行的检查（读盘或提示） */
  let activeCheck: Promise<void> | null = null;
  /** dialog 占用独立于身份授权；切会话不能释放尚未结束的原生提示。 */
  let activePrompt: Promise<boolean> | null = null;
  let ownSave: { token: ExternalFileSaveToken; writing: boolean } | null = null;
  let disposed = false;
  let pendingConflict = false;
  let conflictSnapshot: {
    path: string;
    content: string;
    pathAtStart: string | null;
    baselineAtStart: string | null;
    sessionAtStart: number | string | undefined;
  } | null = null;
  /** 用户选择「保留」的磁盘版本，同一版本不再重复打扰 */
  let lastIgnored: {
    path: string;
    content: string;
    baselineAtStart: string | null;
    sessionAtStart: number | string | undefined;
  } | null = null;

  function clearTimer(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function captureSnapshot(path: string | null) {
    return {
      path,
      doc: hooks.currentDoc(),
      baseline: hooks.currentBaseline(),
      session: hooks.currentSession?.(),
      revision: hooks.currentRevision?.(),
      generation,
    };
  }

  function isIdentityStale(snapshot: ExternalFileSaveToken): boolean {
    return (
      disposed ||
      generation !== snapshot.generation ||
      hooks.currentPath() !== snapshot.path ||
      (hooks.currentSession !== undefined && hooks.currentSession() !== snapshot.session)
    );
  }

  function isStale(snapshot: ReturnType<typeof captureSnapshot>): boolean {
    return (
      isIdentityStale(snapshot) ||
      hooks.currentDoc() !== snapshot.doc ||
      hooks.currentBaseline() !== snapshot.baseline ||
      hooks.currentRevision?.() !== snapshot.revision
    );
  }

  function rememberConflict(path: string, content: string): void {
    const snapshot = captureSnapshot(path);
    if (isIdentityStale(snapshot) || isContentUnchanged(content, snapshot.baseline)) return;
    pendingConflict = true;
    conflictSnapshot = {
      path,
      content,
      pathAtStart: snapshot.path,
      baselineAtStart: snapshot.baseline,
      sessionAtStart: snapshot.session,
    };
  }

  /** 身份变化丢弃；同身份输入只作废旧选择，不能遗忘已读到的磁盘版本。 */
  function retainChangedDemand(
    snapshot: ReturnType<typeof captureSnapshot>,
    content?: string,
  ): boolean {
    if (isIdentityStale(snapshot)) return true;
    if (savePaused()) {
      if (snapshot.path) {
        // 确认阶段尚未写盘，已有 read 的外部版本仍必须进入保存 guard。
        // write 阶段可能读到自己的落盘快照，留到实际基线应用后再检查。
        if (content !== undefined && !ownSave!.writing) rememberConflict(snapshot.path, content);
        pendingPath = snapshot.path;
      }
      return true;
    }
    if (!isStale(snapshot)) return false;
    if (snapshot.path) {
      if (content !== undefined) rememberConflict(snapshot.path, content);
      // 单槽去抖重查，避免连续输入造成立即重读/重弹的忙循环。
      onFileChanged({ path: snapshot.path });
    }
    return true;
  }

  function isContentUnchanged(content: string, baseline: string | null): boolean {
    // 与自己的 save 一致，或外部改回了基线，都不算「外部新版本」
    return content === hooks.currentDoc() || (baseline !== null && content === baseline);
  }

  function watchPath(path: string | null, session = hooks.currentSession?.()): Promise<void> {
    if (disposed) return Promise.resolve();
    if (path === watchedPath && session === watchedSession) return watchQueue;
    watchedPath = path;
    watchedSession = session;
    const request = ++generation;
    clearTimer();
    pendingPath = null;
    ownSave = null;
    clearConflict();
    watchQueue = watchQueue.then(async () => {
      if (disposed || request !== generation) return;
      try {
        await hooks.stopWatch();
        if (disposed || request !== generation) return;
        if (path) await hooks.startWatch(path);
        // listener 已注册；补读启动间隙的磁盘变化（仍走串行检查）。
        if (!disposed && request === generation && path) onFileChanged({ path });
      } catch (e) {
        if (!disposed && request === generation) hooks.setStatus(`文件监控失败：${e}`);
      }
    });
    return watchQueue;
  }

  function onFileChanged(payload: { path: string }): void {
    if (disposed) return;
    if (payload.path !== watchedPath) return; // 旧路径事件作废
    clearTimer();
    pendingPath = payload.path;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scheduleCheck();
    }, DEBOUNCE_MS);
  }

  function scheduleCheck(): void {
    if (activeCheck || activePrompt || savePaused() || debounceTimer || !pendingPath) return;
    const path = pendingPath;
    pendingPath = null;
    const snapshot = captureSnapshot(path);
    activeCheck = runCheck(path)
      .catch((error) => {
        if (!isStale(snapshot)) hooks.setStatus(`外部修改检测失败：${error}`);
      })
      .finally(() => {
        activeCheck = null;
        scheduleCheck();
      });
  }

  async function promptForSnapshot(
    snapshot: ReturnType<typeof captureSnapshot>,
    message: string,
    title: string,
  ): Promise<boolean> {
    while (activePrompt) {
      try {
        await activePrompt;
      } catch {
        // 前一个 dialog 的拒绝只释放占用，不应传给新身份的请求。
      }
      if (isStale(snapshot)) return false;
    }
    if (isStale(snapshot)) return false;
    const prompt = hooks.promptReloadOrKeep(message, title);
    activePrompt = prompt;
    try {
      return await prompt;
    } finally {
      if (activePrompt === prompt) {
        activePrompt = null;
        scheduleCheck();
      }
    }
  }

  async function runCheck(path: string): Promise<void> {
    const snapshot = captureSnapshot(path);
    if (isStale(snapshot)) return;

    let content: string;
    try {
      content = (await hooks.readFile(path)).content;
    } catch (e) {
      if (retainChangedDemand(snapshot)) return;
      handleUnreadable();
      return;
    }

    if (retainChangedDemand(snapshot, content)) return;

    if (isContentUnchanged(content, snapshot.baseline)) {
      // 自己的 save / 同内容 / 外部改回基线：不提示，但清掉已解决的冲突
      if (
        pendingConflict &&
        conflictSnapshot &&
        conflictSnapshot.path === snapshot.path &&
        conflictSnapshot.pathAtStart === snapshot.path &&
        conflictSnapshot.baselineAtStart === snapshot.baseline &&
        conflictSnapshot.sessionAtStart === snapshot.session
      ) {
        clearConflict();
      }
      return;
    }

    // 干净文档（且磁盘确实偏离基线）才自动重读
    if (snapshot.baseline !== null && snapshot.doc === snapshot.baseline) {
      hooks.applyReload(path, content);
      hooks.setStatus("已自动重新读取外部修改");
      clearConflict();
      return;
    }

    // 有未保存修改：询问用户
    if (
      lastIgnored &&
      lastIgnored.path === path &&
      lastIgnored.content === content &&
      lastIgnored.baselineAtStart === snapshot.baseline &&
      lastIgnored.sessionAtStart === snapshot.session
    ) {
      return;
    }

    rememberConflict(path, content);
    const reload = await promptForSnapshot(
      snapshot,
      `「${path}」已被外部程序修改。是否重新读取磁盘内容？\n选择「取消」将保留当前未保存的编辑。`,
      DIALOG_TITLE,
    );

    if (retainChangedDemand(snapshot, content)) return;

    // 确认只授权刚才看到的磁盘版本；提示期间的新版本重新排队。
    try {
      const latest = (await hooks.readFile(path)).content;
      if (retainChangedDemand(snapshot, latest)) return;
      if (latest !== content) {
        pendingPath = path;
        return;
      }
    } catch {
      if (!retainChangedDemand(snapshot, content)) handleUnreadable();
      return;
    }

    if (reload) {
      hooks.applyReload(path, content);
      hooks.setStatus("已重新读取磁盘内容");
      clearConflict();
    } else {
      lastIgnored = {
        path,
        content,
        baselineAtStart: snapshot.baseline,
        sessionAtStart: snapshot.session,
      };
      pendingConflict = true;
      conflictSnapshot = {
        path,
        content,
        pathAtStart: snapshot.path,
        baselineAtStart: snapshot.baseline,
        sessionAtStart: snapshot.session,
      };
      hooks.setStatus("已保留当前内容（磁盘版本已变更）");
    }
  }

  function handleUnreadable(): void {
    if (isDocModified(hooks.currentDoc(), hooks.currentBaseline())) {
      hooks.setStatus("文件已删除或暂时无法读取，已保留当前未保存内容");
    } else {
      hooks.setStatus("外部修改检测：文件已删除或暂时无法读取");
    }
    pendingConflict = false;
  }

  function hasConflict(): boolean {
    if (!pendingConflict || !conflictSnapshot) return false;
    return (
      hooks.currentPath() === conflictSnapshot.path &&
      hooks.currentBaseline() === conflictSnapshot.baselineAtStart &&
      (hooks.currentSession === undefined ||
        hooks.currentSession() === conflictSnapshot.sessionAtStart)
    );
  }

  function savePaused(): boolean {
    return ownSave !== null && !isIdentityStale(ownSave.token);
  }

  function beginSave(): ExternalFileSaveToken | null {
    if (disposed || savePaused()) return null;
    const token = captureSnapshot(hooks.currentPath());
    ownSave = { token, writing: false };
    return token;
  }

  function endSave(token: ExternalFileSaveToken): void {
    if (ownSave?.token !== token) return;
    ownSave = null;
    scheduleCheck();
  }

  async function confirmSaveIfConflict(token?: ExternalFileSaveToken): Promise<boolean> {
    const managed = token === undefined;
    token ??= beginSave() ?? undefined;
    if (!token || ownSave?.token !== token || isIdentityStale(token)) return false;
    const snapshot = captureSnapshot(hooks.currentPath());
    try {
      // 保存确认和外部检查共用提示槽；等待时路径/正文变化不能授权保存新状态。
      if (activeCheck) await activeCheck;
      if (isStale(snapshot) || ownSave?.token !== token) return false;
      if (pendingPath === token.path && token.path) {
        // 同步保存入口前已有的事件先读一次，只记版本、不弹外部提示或重读正文。
        clearTimer();
        pendingPath = null;
        await runCheck(token.path);
      }
      if (isStale(snapshot) || ownSave?.token !== token) return false;
      const proceed = await checkSaveConflict();
      if (!proceed || isStale(snapshot) || ownSave?.token !== token) return false;
      ownSave.writing = true;
      return true;
    } finally {
      if (managed) endSave(token);
    }
  }

  async function checkSaveConflict(): Promise<boolean> {
    if (!hasConflict()) return true;
    const snap = conflictSnapshot!;
    const snapshot = captureSnapshot(hooks.currentPath());
    const proceed = await promptForSnapshot(
      snapshot,
      "磁盘上的文件已被外部程序修改，保存会覆盖这些修改。仍要保存吗？",
      SAVE_CONFLICT_TITLE,
    );
    // 确认期间若会话/路径/冲突版本变化，这次确认无效，禁止保存
    if (
      isStale(snapshot) ||
      hooks.currentPath() !== snap.path ||
      hooks.currentBaseline() !== snap.baselineAtStart ||
      (hooks.currentSession && hooks.currentSession() !== snap.sessionAtStart) ||
      !pendingConflict ||
      conflictSnapshot?.content !== snap.content
    ) {
      return false;
    }
    if (!proceed) return false;
    try {
      const disk = (await hooks.readFile(snap.path)).content;
      if (isStale(snapshot) || conflictSnapshot !== snap) return false;
      if (disk !== snap.content) {
        onFileChanged({ path: snap.path });
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function acknowledgeSave(path: string, content: string): void {
    if (!conflictSnapshot || conflictSnapshot.path !== path) return;
    if (hooks.currentSession?.() !== conflictSnapshot.sessionAtStart) return;
    if (conflictSnapshot.content === content) {
      clearConflict();
    } else {
      conflictSnapshot.baselineAtStart = content;
      if (lastIgnored) lastIgnored.baselineAtStart = content;
    }
  }

  function clearConflict(): void {
    pendingConflict = false;
    conflictSnapshot = null;
    lastIgnored = null;
  }

  async function dispose(): Promise<void> {
    disposed = true;
    generation++;
    clearTimer();
    pendingPath = null;
    watchedPath = null;
    ownSave = null;
    pendingConflict = false;
    conflictSnapshot = null;
    lastIgnored = null;
    await watchQueue;
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
    beginSave,
    confirmSaveIfConflict,
    endSave,
    acknowledgeSave,
    clearConflict,
    dispose,
  };
}
