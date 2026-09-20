// 文档生命周期的单测：脏文档必问（含"打开的就是当前这个文件"）、取消就不动状态、
// 另存为取消不写盘、失败文案带原因、新建连存档一起清、桌面/浏览器两套确认框，
// 外加三个状态迁移纯函数（契约 3：`doc` 与 `editorDoc` 必须同源）。
// 依赖全注入 + 假文件，不碰 DOM（除了 `window.confirm` 那一条，jsdom 里有）、不碰 Tauri。
//
// 读断言时的约定：`calls` 记的是**完整 hook 序列**，`toEqual` 整串比较就是契约本身
// （顺序有意义：`applyNew → clearSession → afterNew`；取消时"一个副作用都没有"靠空数组钉住）。
// 加/删 hook 时同步更新这里的期望串。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentSession,
  fileNameOf,
  loadedState,
  newState,
  savedState,
  UNTITLED_TITLE,
} from "./document-session";
import type { DocumentSessionHooks } from "./document-session";

describe("fileNameOf", () => {
  it("Windows / Unix 路径都取最后一段；没有分隔符就原样返回", () => {
    expect(fileNameOf("C:\\Users\\me\\论文.typ")).toBe("论文.typ");
    expect(fileNameOf("/home/me/论文.typ")).toBe("论文.typ");
    expect(fileNameOf("未命名.typ")).toBe("未命名.typ");
  });
});

describe("状态迁移纯函数", () => {
  it("loadedState：`doc` 与 `editorDoc` 同源（落后一次就丢未保存内容），标题跟路径走、脏标记清掉", () => {
    expect(loadedState("磁盘内容", "C:\\Users\\me\\论文.typ")).toEqual({
      doc: "磁盘内容",
      editorDoc: "磁盘内容", // 契约 3：两处镜像必须同一份
      filePath: "C:\\Users\\me\\论文.typ",
      fileTitle: "论文.typ",
      dirty: false,
    });
  });

  it("savedState：**内容不变**（两处镜像原样带回），只换路径/标题、清脏标记", () => {
    expect(savedState("/tmp/另存为.typ", "正在写的正文")).toEqual({
      doc: "正在写的正文",
      editorDoc: "正在写的正文",
      filePath: "/tmp/另存为.typ",
      fileTitle: "另存为.typ",
      dirty: false,
    });
  });

  it("newState：内容两处都空、路径置空、标题回到「未命名.typ」", () => {
    expect(newState()).toEqual({
      doc: "",
      editorDoc: "",
      filePath: null,
      fileTitle: UNTITLED_TITLE,
      dirty: false,
    });
    expect(UNTITLED_TITLE).toBe("未命名.typ"); // 页面 fileTitle 的初值也用它
  });
});

describe("createDocumentSession", () => {
  let state: {
    doc: string;
    filePath: string | null;
    fileTitle: string;
    dirty: boolean;
    status: string;
  };
  let calls: string[];
  let confirmed: boolean;
  let confirmMessages: string[];
  let confirmTitles: string[];
  let fileContent: string;
  /** 读盘返回的路径与请求不同（防御性契约；今天 Rust 侧原样回填，见 file-ops.readTypFile） */
  let readPathOverride: string | null;
  let readError: unknown;
  let writeError: unknown;

  /** 只记"发生了什么"的最小页面替身：每个 hook 对应一条记录，断言直接看这些记录 */
  function make(overrides: Partial<DocumentSessionHooks> = {}) {
    return createDocumentSession({
      doc: () => state.doc,
      filePath: () => state.filePath,
      fileTitle: () => state.fileTitle,
      dirty: () => state.dirty,
      applyLoaded: (content, path) => {
        calls.push(`applyLoaded:${path}`);
        state.doc = content;
        state.filePath = path;
        state.fileTitle = fileNameOf(path);
        state.dirty = false;
      },
      applySaved: (path) => {
        calls.push(`applySaved:${path}`);
        state.filePath = path;
        state.fileTitle = fileNameOf(path);
        state.dirty = false;
      },
      applyNew: () => {
        calls.push("applyNew");
        state.doc = "";
        state.filePath = null;
        state.fileTitle = "未命名.typ";
        state.dirty = false;
      },
      afterLoad: () => calls.push("afterLoad"),
      afterSave: () => calls.push("afterSave"),
      afterNew: () => calls.push("afterNew"),
      clearSession: () => calls.push("clearSession"),
      setStatus: (text) => {
        calls.push(`status:${text}`);
        state.status = text;
      },
      isDesktop: () => true,
      confirmNative: async (message, title) => {
        confirmMessages.push(message);
        confirmTitles.push(title);
        return confirmed;
      },
      readFile: async (path) => {
        calls.push(`read:${path}`);
        if (readError !== undefined) throw readError;
        return { content: fileContent, path: readPathOverride ?? path };
      },
      writeFile: async (path, content) => {
        calls.push(`write:${path ?? "<null>"}:${content}`);
        if (writeError !== undefined) throw writeError;
        return path === null ? "/tmp/另存为.typ" : path;
      },
      pickFile: async () => "/tmp/选中.typ",
      ...overrides,
    });
  }

  beforeEach(() => {
    state = { doc: "正文", filePath: "/tmp/a.typ", fileTitle: "a.typ", dirty: false, status: "" };
    calls = [];
    confirmed = true;
    confirmMessages = [];
    confirmTitles = [];
    fileContent = "磁盘内容";
    readPathOverride = null;
    readError = undefined;
    writeError = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("不脏：不问、直接读，落文档 + 后继动作 + 「已打开」", async () => {
    const s = make();
    // 刻意换一个文件名：夹具初始标题是 a.typ，若这里还开 a.typ，"标题有没有被落下来"就测不出来了
    await expect(s.openPath("/tmp/另一篇.typ")).resolves.toBe(true);
    expect(confirmMessages).toEqual([]);
    expect(calls).toEqual([
      "read:/tmp/另一篇.typ",
      "applyLoaded:/tmp/另一篇.typ",
      "afterLoad",
      "status:已打开",
    ]);
    expect(state.doc).toBe("磁盘内容");
    expect(state.filePath).toBe("/tmp/另一篇.typ");
    expect(state.fileTitle).toBe("另一篇.typ"); // 标题跟着落盘路径走（窗口标题 / 拖放文案都读它）
    expect(state.dirty).toBe(false);
  });

  it("脏 + 另一份文件：问通用文案；取消 → 一个字节都不读、状态不变", async () => {
    state.dirty = true;
    confirmed = false;
    const s = make();
    await expect(s.openPath("/tmp/b.typ")).resolves.toBe(false);
    expect(confirmMessages).toEqual([
      "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
    ]);
    expect(calls).toEqual([]); // 没读盘、没落状态、连状态栏都没动
    expect(state.doc).toBe("正文");
  });

  it("脏 + **就是当前这个文件**：文案带书名号标题，确认后照样重读（否则拖放会静默丢内容）", async () => {
    state.dirty = true;
    const s = make();
    await expect(s.openPath("/tmp/a.typ")).resolves.toBe(true);
    expect(confirmMessages).toEqual([
      "「a.typ」有未保存的修改，重新打开将丢弃这些修改。仍要打开吗？",
    ]);
    expect(calls).toContain("read:/tmp/a.typ");
  });

  it("同名但不同目录**不算**同路径：走通用文案（判据是完整路径，不是文件名）", async () => {
    state.dirty = true;
    const s = make();
    await s.openPath("/tmp/其他/a.typ"); // 与当前 /tmp/a.typ 同名
    expect(confirmMessages).toEqual([
      "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
    ]);
  });

  it("空白文档不算脏（`isEffectiveDirty`）：脏标记为真但正文只有空白时也不弹确认", async () => {
    state.dirty = true;
    state.doc = "  \n\n";
    const s = make();
    await expect(s.openPath("/tmp/b.typ")).resolves.toBe(true);
    expect(confirmMessages).toEqual([]);
    expect(state.dirty).toBe(false); // 读盘把脏标记清掉（从 true 起断言，不是恒真）
  });

  it("读盘返回的路径与请求不同（规范化）时，路径与标题跟**返回的**那个", async () => {
    readPathOverride = "/规范后/目录/另一篇.typ";
    const s = make();
    await expect(s.openPath("/tmp/另一篇.typ")).resolves.toBe(true);
    expect(state.filePath).toBe("/规范后/目录/另一篇.typ");
    expect(state.fileTitle).toBe("另一篇.typ");
  });

  it("读盘失败：状态栏带 A 侧原因，且不落任何文档状态", async () => {
    readError = "仅支持 .typ 文件";
    const s = make();
    await expect(s.openPath("/tmp/b.typ")).resolves.toBe(false);
    expect(state.status).toBe("打开失败：仅支持 .typ 文件");
    expect(calls).toEqual(["read:/tmp/b.typ", "status:打开失败：仅支持 .typ 文件"]);
  });

  it("open()：选择框取消（返回 null）时什么都不做", async () => {
    const s = make({ pickFile: async () => null });
    await s.open();
    expect(calls).toEqual([]);
  });

  it("open()：选中路径后走 openPath", async () => {
    const s = make();
    await s.open();
    expect(calls).toEqual([
      "read:/tmp/选中.typ",
      "applyLoaded:/tmp/选中.typ",
      "afterLoad",
      "status:已打开",
    ]);
  });

  it("save：把当前路径与正文交给写盘；成功只动路径/标题/脏标记（不重编译）", async () => {
    state.dirty = true;
    const s = make();
    await expect(s.save()).resolves.toBe("/tmp/a.typ");
    expect(calls).toEqual(["write:/tmp/a.typ:正文", "applySaved:/tmp/a.typ", "afterSave"]);
    expect(state.doc).toBe("正文"); // 保存不改内容
  });

  it("save：未命名文档走另存为，成功后路径/标题都跟新路径", async () => {
    state.filePath = null;
    state.fileTitle = UNTITLED_TITLE;
    state.dirty = true;
    const s = make();
    await expect(s.save()).resolves.toBe("/tmp/另存为.typ");
    expect(calls).toEqual(["write:<null>:正文", "applySaved:/tmp/另存为.typ", "afterSave"]);
    expect(state.filePath).toBe("/tmp/另存为.typ");
    expect(state.fileTitle).toBe("另存为.typ");
    expect(state.dirty).toBe(false);
  });

  it("save：另存为对话框里取消（写盘返回 null）→ 路径与脏标记都不许动", async () => {
    state.dirty = true;
    state.filePath = null;
    state.fileTitle = "未命名.typ";
    const s = make({
      writeFile: async () => {
        calls.push("write:取消另存为");
        return null;
      },
    });
    await expect(s.save()).resolves.toBeNull();
    expect(calls).toEqual(["write:取消另存为"]);
    expect(state.filePath).toBeNull();
    expect(state.dirty).toBe(true);
  });

  it("save：写盘抛错 → 状态栏「保存失败：原因」，不认成功", async () => {
    writeError = "没有写入权限";
    const s = make();
    await expect(s.save()).resolves.toBeNull();
    expect(state.status).toBe("保存失败：没有写入权限");
    expect(calls).not.toContain("afterSave");
  });

  it("reload：未命名文档直接忽略（连确认框都不问）", async () => {
    state.filePath = null;
    state.dirty = true;
    const s = make();
    await s.reload();
    expect(calls).toEqual([]);
    expect(confirmMessages).toEqual([]);
  });

  it("reload：脏 → 专用文案；确认后重读并写「已重新读取」", async () => {
    state.dirty = true;
    const s = make();
    await s.reload();
    expect(confirmMessages).toEqual([
      "当前文档有未保存的修改，重新读取将丢失这些修改。仍要重新读取吗？",
    ]);
    expect(calls).toEqual([
      "read:/tmp/a.typ",
      "applyLoaded:/tmp/a.typ",
      "afterLoad",
      "status:已重新读取",
    ]);
    expect(state.dirty).toBe(false);
  });

  it("reload：失败写「重新读取失败：原因」", async () => {
    readError = "目录无效";
    const s = make();
    await s.reload();
    expect(state.status).toBe("重新读取失败：目录无效");
  });

  it("createNew：脏 + 取消 → 不清空、不清存档、不重编译", async () => {
    state.dirty = true;
    confirmed = false;
    const s = make();
    await s.createNew();
    expect(confirmMessages).toEqual(["当前文档有未保存的修改，新建将丢弃这些修改。仍要新建吗？"]);
    expect(calls).toEqual([]);
    expect(state.doc).toBe("正文");
  });

  it("createNew：确认 → 清空 + 清存档 + 重编译，**不写会话存档**（那是 clearState 的活）", async () => {
    state.dirty = true;
    const s = make();
    await s.createNew();
    expect(calls).toEqual(["applyNew", "clearSession", "afterNew", "status:已新建"]);
    expect(state.doc).toBe("");
    expect(state.filePath).toBeNull();
    expect(state.fileTitle).toBe("未命名.typ");
    expect(calls).not.toContain("afterSave");
  });

  it("桌面（Tauri）走原生确认框并带上标题；浏览器回退 window.confirm", async () => {
    state.dirty = true;
    const native = make({ isDesktop: () => true });
    await native.openPath("/tmp/b.typ");
    expect(confirmMessages).toEqual([
      "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
    ]);
    expect(confirmTitles).toEqual(["未保存的修改"]); // 原生框的标题也要传下去

    // 浏览器：jsdom 里有 window.confirm，spy 成"取消"
    const spy = vi.spyOn(window, "confirm").mockReturnValue(false);
    state.dirty = true;
    calls.length = 0;
    confirmMessages.length = 0;
    const web = make({ isDesktop: () => false });
    // 换一个**不同**的路径：上一段已经把 filePath 落成 /tmp/b.typ 了（同路径会换用另一句文案）
    await expect(web.openPath("/tmp/c.typ")).resolves.toBe(false);
    expect(spy).toHaveBeenCalledWith(
      "当前文档有未保存的修改，打开新文件将丢失这些修改。仍要打开吗？",
    );
    expect(calls).toEqual([]);
  });
});
