// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createExternalFileChange, type ExternalFileChangeHooks } from "./external-file-change";

function createHooks(): ExternalFileChangeHooks & {
  calls: {
    applyReload: [string, string][];
    prompt: [string, string][];
    status: string[];
    startWatch: (string | null)[];
    stopWatch: number;
  };
  setPromptResults: (results: boolean[]) => void;
  setPath: (p: string | null) => void;
  setDoc: (d: string) => void;
  setBaseline: (b: string | null) => void;
  setSession: (s: number) => void;
  setDisk: (p: string, c: string) => void;
  removeDisk: (p: string) => void;
  bumpSession: () => void;
} {
  const calls = {
    applyReload: [] as [string, string][],
    prompt: [] as [string, string][],
    status: [] as string[],
    startWatch: [] as (string | null)[],
    stopWatch: 0,
  };
  let path: string | null = null;
  let doc = "";
  let baseline: string | null = "";
  let session = 0;
  let disk = new Map<string, string>();
  let promptResults: boolean[] = [];
  let promptIndex = 0;

  return {
    calls,
    setPromptResults: (results) => {
      promptResults = results;
      promptIndex = 0;
    },
    setPath: (p) => (path = p),
    setDoc: (d) => (doc = d),
    setBaseline: (b) => (baseline = b),
    setSession: (s) => (session = s),
    setDisk: (p, c) => disk.set(p, c),
    removeDisk: (p) => disk.delete(p),
    bumpSession: () => session++,
    currentPath: () => path,
    currentDoc: () => doc,
    currentBaseline: () => baseline,
    currentSession: () => session,
    applyReload: (p, c) => {
      calls.applyReload.push([p, c]);
      doc = c;
      baseline = c;
      path = p;
    },
    promptReloadOrKeep: async (message, title) => {
      calls.prompt.push([message, title]);
      const result = promptResults[promptIndex++] ?? false;
      return result;
    },
    setStatus: (text) => calls.status.push(text),
    readFile: async (p) => {
      const content = disk.get(p);
      if (content === undefined) throw new Error("文件不存在");
      return { path: p, content };
    },
    startWatch: async (p) => {
      calls.startWatch.push(p);
    },
    stopWatch: async () => {
      calls.stopWatch++;
    },
  };
}

describe("createExternalFileChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("干净文档遇到外部修改时自动重读", async () => {
    const hooks = createHooks();
    hooks.setPath("/doc.typ");
    hooks.setDoc("hello");
    hooks.setBaseline("hello");
    hooks.setDisk("/doc.typ", "world");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    expect(hooks.calls.startWatch).toEqual(["/doc.typ"]);

    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.applyReload).toEqual([["/doc.typ", "world"]]);
    expect(m.hasConflict()).toBe(false);
    expect(hooks.calls.prompt).toHaveLength(0);
  });

  it("外部修改与当前正文一致时不动作", async () => {
    const hooks = createHooks();
    hooks.setPath("/doc.typ");
    hooks.setDoc("same");
    hooks.setBaseline("same");
    hooks.setDisk("/doc.typ", "same");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(hooks.calls.prompt).toHaveLength(0);
  });

  it("有未保存修改时提示用户；选择重读则应用磁盘内容", async () => {
    const hooks = createHooks();
    hooks.setPromptResults([true]);
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");
    hooks.setDisk("/doc.typ", "disk");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });

    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.prompt).toHaveLength(1);
    expect(hooks.calls.applyReload).toEqual([["/doc.typ", "disk"]]);
    expect(m.hasConflict()).toBe(false);
  });

  it("有未保存修改时选择保留，则不再为同一磁盘版本重复弹窗", async () => {
    const hooks = createHooks();
    hooks.setPromptResults([false]);
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");
    hooks.setDisk("/doc.typ", "disk");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.prompt).toHaveLength(1);
    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(m.hasConflict()).toBe(true);

    // 同一内容再次触发事件
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);
    expect(hooks.calls.prompt).toHaveLength(1); // 没有二次弹窗
  });

  it("新的外部版本会再次提示", async () => {
    const hooks = createHooks();
    hooks.setPromptResults([false, true]);
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");

    hooks.setDisk("/doc.typ", "disk1");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    hooks.setDisk("/doc.typ", "disk2");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.prompt).toHaveLength(2);
    expect(hooks.calls.applyReload).toEqual([["/doc.typ", "disk2"]]);
  });

  it("旧路径事件在切文件后被忽略", async () => {
    const hooks = createHooks();
    hooks.setPath("/a.typ");
    hooks.setDoc("a");
    hooks.setBaseline("a");
    hooks.setDisk("/a.typ", "changed");
    hooks.setDisk("/b.typ", "b");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");

    // 切到 b.typ
    await m.watchPath("/b.typ");

    // 旧的 a.typ 事件到达
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(hooks.calls.prompt).toHaveLength(0);
  });

  it("文件不可读时给出非破坏提示", async () => {
    const hooks = createHooks();
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("local");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(hooks.calls.prompt).toHaveLength(0);
    expect(hooks.calls.status.at(-1)).toContain("已删除或暂时无法读取");
  });

  it("保存前已知冲突时确认；取消则阻止保存", async () => {
    const hooks = createHooks();
    hooks.setPromptResults([false, false]); // 保留外部修改，再取消保存
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");
    hooks.setDisk("/doc.typ", "disk");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);

    const proceed = await m.confirmSaveIfConflict();
    expect(proceed).toBe(false);
    expect(hooks.calls.prompt).toHaveLength(2);
  });

  it("保存前无冲突时直接放行", async () => {
    const hooks = createHooks();
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");

    const proceed = await m.confirmSaveIfConflict();
    expect(proceed).toBe(true);
    expect(hooks.calls.prompt).toHaveLength(0);
  });

  it("保存成功后清除冲突标记", async () => {
    const hooks = createHooks();
    hooks.setPromptResults([false]);
    hooks.setPath("/doc.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");
    hooks.setDisk("/doc.typ", "disk");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });
    await vi.advanceTimersByTimeAsync(200);
    expect(m.hasConflict()).toBe(true);

    m.clearConflict();
    expect(m.hasConflict()).toBe(false);
  });

  it("dispose 取消在途检查并停止监控", async () => {
    const hooks = createHooks();
    hooks.setPath("/doc.typ");
    hooks.setDoc("a");
    hooks.setBaseline("a");
    hooks.setDisk("/doc.typ", "b");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/doc.typ");
    m.onFileChanged({ path: "/doc.typ" });

    await m.dispose();
    vi.advanceTimersByTimeAsync(500);

    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(hooks.calls.stopWatch).toBeGreaterThan(0);
  });

  it("在途 read 完成后若路径已切换，不得应用旧磁盘内容", async () => {
    const hooks = createHooks();
    let finishRead: ((value: { path: string; content: string }) => void) | null = null;
    hooks.setPath("/a.typ");
    hooks.setDoc("a-baseline");
    hooks.setBaseline("a-baseline");
    hooks.readFile = () =>
      new Promise((resolve) => {
        finishRead = resolve;
      });

    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);

    // read 在途时切到 b.typ
    hooks.setPath("/b.typ");
    hooks.setDoc("b-baseline");
    hooks.setBaseline("b-baseline");
    await m.watchPath("/b.typ");

    finishRead!({ path: "/a.typ", content: "external-a" });
    await vi.advanceTimersByTimeAsync(0);

    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(hooks.calls.prompt).toHaveLength(0);
  });

  it("dirty 文档收到磁盘仍是基线的内容时，不视为外部变更", async () => {
    const hooks = createHooks();
    hooks.setPath("/a.typ");
    hooks.setDoc("new-unsaved-edit-after-save");
    hooks.setBaseline("a-baseline");
    hooks.setDisk("/a.typ", "a-baseline");

    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);

    expect(hooks.calls.prompt).toHaveLength(0);
    expect(m.hasConflict()).toBe(false);
  });

  it("同路径新会话开始后，旧 prompt 的结果不得覆盖新会话", async () => {
    const hooks = createHooks();
    let finishPrompt: ((value: boolean) => void) | null = null;
    hooks.setPath("/a.typ");
    hooks.setDoc("dirty-a");
    hooks.setBaseline("a-baseline");
    hooks.setDisk("/a.typ", "external-a");
    hooks.promptReloadOrKeep = async () =>
      new Promise((resolve) => {
        finishPrompt = resolve;
      });

    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);

    // prompt 在途时同路径换成新会话
    hooks.setDoc("new-session-same-path");
    hooks.setBaseline("new-session-same-path");
    hooks.bumpSession();
    await m.watchPath("/a.typ");

    finishPrompt!(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(hooks.calls.applyReload).toHaveLength(0);
  });

  it("提示期间用户继续输入，旧选择不得覆盖新编辑", async () => {
    const hooks = createHooks();
    let finishPrompt: ((value: boolean) => void) | null = null;
    hooks.setPromptResults([]);
    hooks.setPath("/a.typ");
    hooks.setDoc("dirty-a");
    hooks.setBaseline("a-baseline");
    hooks.setDisk("/a.typ", "external-a");
    hooks.promptReloadOrKeep = async () =>
      new Promise((resolve) => {
        finishPrompt = resolve;
      });

    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);

    hooks.setDoc("typed-after-prompt");
    finishPrompt!(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(hooks.calls.applyReload).toHaveLength(0);
  });

  it("未知恢复基线按 dirty 提示，不自动覆盖", async () => {
    const hooks = createHooks();
    hooks.setPath("/a.typ");
    hooks.setDoc("restored");
    hooks.setBaseline(null);
    hooks.setDisk("/a.typ", "disk");
    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    await vi.advanceTimersByTimeAsync(200);
    expect(hooks.calls.prompt).toHaveLength(1);
    expect(hooks.calls.applyReload).toHaveLength(0);
  });

  it("stop/start 串行，切换和 dispose 不留下旧 watch", async () => {
    const hooks = createHooks();
    hooks.setPath("/a.typ");
    let release!: () => void;
    let actual: string | null = null;
    hooks.startWatch = async (path) => {
      hooks.calls.startWatch.push(path);
      if (path === "/a.typ") await new Promise<void>((r) => (release = r));
      actual = path;
    };
    hooks.stopWatch = async () => {
      actual = null;
    };
    const m = createExternalFileChange(hooks);
    const a = m.watchPath("/a.typ");
    await vi.advanceTimersByTimeAsync(0);
    hooks.setPath("/b.typ");
    const b = m.watchPath("/b.typ");
    expect(hooks.calls.startWatch).toEqual(["/a.typ"]);
    release();
    await Promise.all([a, b]);
    expect(actual).toBe("/b.typ");
    await m.dispose();
    expect(actual).toBeNull();
  });

  it("确认期间的新磁盘版本保留 latest demand，旧版本不落地", async () => {
    const hooks = createHooks();
    hooks.setPath("/a.typ");
    hooks.setDoc("local");
    hooks.setBaseline("base");
    hooks.setDisk("/a.typ", "disk1");
    let release!: (value: boolean) => void;
    let prompts = 0;
    hooks.promptReloadOrKeep = async () => {
      prompts++;
      if (prompts === 1) return new Promise<boolean>((r) => (release = r));
      return false;
    };
    const m = createExternalFileChange(hooks);
    await m.watchPath("/a.typ");
    await vi.advanceTimersByTimeAsync(200);
    hooks.setDisk("/a.typ", "disk2");
    m.onFileChanged({ path: "/a.typ" });
    await vi.advanceTimersByTimeAsync(200);
    expect(prompts).toBe(1);
    release(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(prompts).toBe(2);
    expect(hooks.calls.applyReload).toHaveLength(0);
    expect(m.hasConflict()).toBe(true);
  });

  it.each(["session", "path", "disk", "doc"])(
    "保存确认绑定原快照：%s 变化则拒绝",
    async (change) => {
      const hooks = createHooks();
      hooks.setPath("/a.typ");
      hooks.setDoc("local");
      hooks.setBaseline("base");
      hooks.setDisk("/a.typ", "disk");
      const m = createExternalFileChange(hooks);
      await m.watchPath("/a.typ");
      await vi.advanceTimersByTimeAsync(200);
      let release!: (value: boolean) => void;
      hooks.promptReloadOrKeep = () => new Promise<boolean>((r) => (release = r));
      const save = m.confirmSaveIfConflict();
      if (change === "session") hooks.bumpSession();
      if (change === "path") hooks.setPath("/b.typ");
      if (change === "disk") hooks.setDisk("/a.typ", "new-disk");
      if (change === "doc") hooks.setDoc("new-input");
      release(true);
      expect(await save).toBe(false);
      expect(hooks.calls.applyReload).toHaveLength(0);
    },
  );
});
