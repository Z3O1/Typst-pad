// 文档生命周期：打开 / 保存 / 重新读取 / 新建 —— 文件安全那几条红线的**唯一落点**。
//
// 从 `+page.svelte` 搬出来（原来散在页面里 ~150 行，和编译、块级渲染、弹窗状态混在一起）。
// 依赖全注入（照着 `zoom-controller.ts` / `math-queue.ts` 的先例），所以单测里可以用假文件、
// 假确认框把"取消就不写盘""同路径脏文档也要问"这些**红线**钉死，不需要 DOM 也不需要 Tauri。
//
// 四条契约（改这里之前先读）：
// 1. **有未保存修改就必须确认**，包括"打开的正是当前这个文件"（`filePath === path`）：
//    早先用路径相同放行，Windows 上把同一个 .typ 拖进窗口（或从资源管理器"用 Typst-pad 打开"）
//    会静默拿磁盘内容覆盖未保存的输入，用户看到的是"内容退回上次保存的版本"。
// 2. **写盘只有一条路**：`save()` → 注入的 `writeFile`（页面侧就是 `saveTypFile` → Rust `write_file`）。
//    没有自动保存、没有旁路；`writeFile` 返回 `null`（用户在另存为对话框里取消）时**什么都不改**。
// 3. **`applyLoaded` 只此一份**：打开 / 重新读取都要同时落 `doc` 与 `editorDoc` 两处
//    （`editorDoc` 是编辑器内容的实时镜像，落后一次就丢内容 —— 见页面里 `editorDoc` 声明处的说明）。
// 4. **新建要连会话存档一起清**：它是全应用唯一"不问就丢内容"的路（清空编辑器 + `filePath` 置空
//    + `clearState()`）；确认框是这个洞唯一的闸门。清存档**只由主窗口做**，页面用注入的
//    `clearSession` 自己判断副窗口。
import { fileNameOf, isEffectiveDirty, UNTITLED_TITLE } from "./doc-utils";
import { failureStatus } from "./failure-text";
import type { OpenedFile } from "./file-ops";

/** 未保存修改的默认确认文案（打开另一份文件时用；同路径与新建/重读各有自己的文案） */
const DISCARD_OPEN_MESSAGE = "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？";
const DISCARD_TITLE = "未保存的修改";
/**
 * 文档状态的**完整**形状：页面把这五个字段分别写回自己的 `$state`。
 *
 * 为什么要有这组纯函数：契约 3（`doc` 与 `editorDoc` 必须同源）与"保存不改内容"这两条，
 * 在页面的 hook 里只是几行赋值，**单测够不着**（`?browserdev=1` 里打开对话框返回 null，
 * 浏览器验收也走不到真打开）。把"迁移后的状态长什么样"提到这里之后，红线就有了能跑红的断言。
 */
export interface DocumentState {
  doc: string;
  /** 编辑器内容的实时镜像（见页面 `editorDoc` 声明处：落后一次就丢未保存内容） */
  editorDoc: string;
  filePath: string | null;
  fileTitle: string;
  dirty: boolean;
}

/** 载入（打开 / 重新读取）之后的状态：`doc` 与 `editorDoc` **必须同源**（契约 3） */
export function loadedState(content: string, path: string): DocumentState {
  return {
    doc: content,
    editorDoc: content,
    filePath: path,
    fileTitle: fileNameOf(path),
    dirty: false,
  };
}

/** 保存成功之后的状态：**内容一个字节都不变**（把当前 `doc` 两处镜像原样带回去），只换路径/标题、清脏标记 */
export function savedState(path: string, doc: string): DocumentState {
  return {
    doc,
    editorDoc: doc,
    filePath: path,
    fileTitle: fileNameOf(path),
    dirty: false,
  };
}

/** 新建（清空）之后的状态：内容两处都空、路径置空、标题回到「未命名.typ」、脏标记复位 */
export function newState(): DocumentState {
  return { doc: "", editorDoc: "", filePath: null, fileTitle: UNTITLED_TITLE, dirty: false };
}

export interface DocumentSessionHooks {
  /** 页面当前的 `$state` 取值：**每次判断时重新取**，不能在创建时快照 */
  doc: () => string;
  filePath: () => string | null;
  fileTitle: () => string;
  dirty: () => boolean;
  /** 把磁盘内容落到页面状态：`doc` / `editorDoc` / `filePath` / `fileTitle` / `dirty`（契约 3） */
  applyLoaded: (content: string, path: string) => void;
  /** 保存成功后只动路径 / 标题 / 脏标记 —— **不碰 `doc` 与 `editorDoc`**（保存不改内容） */
  applySaved: (path: string) => void;
  /** 新建：清空文档、路径置空、标题回到「未命名.typ」、脏标记复位 */
  applyNew: () => void;
  /** 载入（打开 / 重新读取）之后统一的后继动作：作废公式缓存与块表 → 重编译 → 存会话 */
  afterLoad: () => void;
  /** 保存之后的后继动作（只存会话，**不重编译**） */
  afterSave: () => void;
  /** 新建之后的后继动作（作废公式缓存与块表 → 重编译）；清存档走 `clearSession`（契约 4） */
  afterNew: () => void;
  /** 新建时清会话存档；"只主窗口做"由页面在实现里判断（副窗口不该抹掉主窗口的存档） */
  clearSession: () => void;
  /** 状态栏文案（成功与失败都走这里） */
  setStatus: (text: string) => void;
  /** 桌面（Tauri）用原生确认框，浏览器回退 `window.confirm` */
  isDesktop: () => boolean;
  confirmNative: (message: string, title: string) => Promise<boolean>;
  /** 文件读写与选择（注入以便单测；模块本身不 import Tauri） */
  readFile: (path: string) => Promise<OpenedFile>;
  writeFile: (path: string | null, content: string) => Promise<string | null>;
  pickFile: () => Promise<string | null>;
}

export interface DocumentSession {
  /** 按路径加载 .typ（打开对话框 / 拖放 / 关联打开 / 单实例转发都走这里） */
  openPath(path: string): Promise<boolean>;
  /** 打开对话框 → `openPath` */
  open(): Promise<void>;
  /** 保存到当前路径；未命名文档由 `saveTypFile` 自己弹另存为。返回落盘的路径（取消/失败为 null） */
  save(): Promise<string | null>;
  /** Ctrl+R：从磁盘重新读取当前文件（未命名文档忽略；有未保存修改先确认） */
  reload(): Promise<void>;
  /** 新建：清空文档并清除持久化的上次内容 */
  createNew(): Promise<void>;
}

export function createDocumentSession(hooks: DocumentSessionHooks): DocumentSession {
  /** 有未保存修改时请求确认；桌面走原生对话框（带标题与警告图标），浏览器回退到 `window.confirm` */
  async function confirmDiscard(
    message = DISCARD_OPEN_MESSAGE,
    title = DISCARD_TITLE,
  ): Promise<boolean> {
    if (hooks.isDesktop()) return await hooks.confirmNative(message, title);
    return window.confirm(message);
  }

  async function openPath(path: string): Promise<boolean> {
    // 契约 1：**包括打开的就是当前这个文件**也算"会丢内容"，必须问
    if (isEffectiveDirty(hooks.dirty(), hooks.doc())) {
      const same = hooks.filePath() === path;
      const ok = await confirmDiscard(
        same
          ? `「${hooks.fileTitle()}」有未保存的修改，重新打开将丢弃这些修改。仍要打开吗？`
          : DISCARD_OPEN_MESSAGE,
      );
      if (!ok) return false;
    }
    try {
      const opened = await hooks.readFile(path);
      hooks.applyLoaded(opened.content, opened.path);
      hooks.afterLoad();
      hooks.setStatus("已打开");
      return true;
    } catch (e) {
      // 带上 Rust 侧的原因（`仅支持 .typ 文件` / `目录无效` …）：光写「打开失败」用户不知道能改什么
      hooks.setStatus(failureStatus("打开失败", e));
      return false;
    }
  }

  async function open(): Promise<void> {
    const path = await hooks.pickFile();
    if (!path) return;
    await openPath(path);
  }

  async function save(): Promise<string | null> {
    // 2026-09-18 用户要求删掉「保存空文档」那个确认窗：空文档保存进已有文件时**直接写**，不再问。
    // 前提没变：全工程只有 `writeFile`（页面侧 `saveTypFile`）一个 .typ 写入口，只挂在显式保存上 ——
    // 不按保存，磁盘上的文件一个字节也不会动。
    try {
      const saved = await hooks.writeFile(hooks.filePath(), hooks.doc());
      if (!saved) return null; // 另存为对话框里取消了：路径 / 脏标记都不许动
      hooks.applySaved(saved);
      hooks.afterSave();
      return saved;
    } catch (e) {
      hooks.setStatus(failureStatus("保存失败", e));
      return null;
    }
  }

  async function reload(): Promise<void> {
    const path = hooks.filePath();
    if (!path) return; // 未命名文档：忽略
    if (isEffectiveDirty(hooks.dirty(), hooks.doc())) {
      const ok = await confirmDiscard(
        "当前文档有未保存的修改，重新读取将丢失这些修改。仍要重新读取吗？",
      );
      if (!ok) return;
    }
    try {
      const opened = await hooks.readFile(path);
      hooks.applyLoaded(opened.content, opened.path);
      hooks.afterLoad();
      hooks.setStatus("已重新读取");
    } catch (e) {
      hooks.setStatus(failureStatus("重新读取失败", e));
    }
  }

  async function createNew(): Promise<void> {
    if (isEffectiveDirty(hooks.dirty(), hooks.doc())) {
      const ok = await confirmDiscard("当前文档有未保存的修改，新建将丢弃这些修改。仍要新建吗？");
      if (!ok) return;
    }
    hooks.applyNew();
    hooks.clearSession(); // 契约 4：连"启动恢复上次内容"那条后路一起断（页面负责只主窗口做）
    hooks.afterNew();
    hooks.setStatus("已新建");
  }

  return { openPath, open, save, reload, createNew };
}
