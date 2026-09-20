// 文件流程编排层单元测试。
//
// 把几条"改起来很容易踩回去"的规则钉住：
//  ① 有未保存修改时打开/重读/新建**都要先确认**，取消则什么都不做（尤其不能先读了再问）；
//  ② 打开的是**当前这个文件**时，确认文案要说"重新打开"并带上标题（拖放同一个 .typ 是常态）；
//  ③ 保存这条路**没有**"空文档覆盖确认"——空文档直接写空（用户 2026-09-18 要求删掉那道窗）；
//  ④ 清会话存档（clearState）只由主窗口做，副窗口点"新建"不能动主窗口的未保存内容；
//  ⑤ 新建**不写存档**（只清），否则刚清掉的会话又被 schedulePersist 写回去。
import { describe, it, expect } from "vitest";
import {
  DISCARD_NEW_NOTICE,
  DISCARD_OPEN_NOTICE,
  DISCARD_RELOAD_NOTICE,
  DISCARD_TITLE,
  UNTITLED_TITLE,
  createFileFlow,
  discardReopenNotice,
  type FileFlowHooks,
  type FileSnapshot,
  type OpenedDocument,
} from "./file-flow";

/** 记录调用的假 hooks：只实现测试关心的事，其余用默认行为兜住 */
function harness(over: Partial<FileFlowHooks> = {}, snap: Partial<FileSnapshot> = {}) {
  const status: string[] = [];
  const calls: string[] = [];
  const applied: OpenedDocument[] = [];
  const savedPaths: string[] = [];
  const previewErrors: string[] = [];
  let state: FileSnapshot = { dirty: false, doc: "正文", path: null, title: UNTITLED_TITLE, ...snap };

  const hooks: FileFlowHooks = {
    snapshot: () => ({ ...state }),
    confirm: async () => {
      calls.push("confirm");
      return true;
    },
    read: async (path) => {
      calls.push(`read:${path}`);
      return { path, content: "磁盘内容" };
    },
    write: async (path, content) => {
      calls.push(`write:${path ?? "null"}:${content}`);
      return path ?? "/tmp/另存为.typ";
    },
    pickPath: async () => {
      calls.push("pickPath");
      return null;
    },
    exportPdf: async (req) => {
      calls.push(`exportPdf:${req.source}:${req.suggestedName}`);
      return { ok: true, targetPath: "/tmp/out.pdf" };
    },
    compileSource: () => "前缀\n正文",
    fontArgs: () => ({ families: ["思源宋体"], dirs: ["/fonts"] }),
    applyOpenedDocument: (opened) => {
      calls.push("applyOpenedDocument");
      applied.push(opened);
      state = { ...state, doc: opened.content, path: opened.path, title: opened.title, dirty: false };
    },
    afterSave: (path) => {
      calls.push("afterSave");
      savedPaths.push(path);
      state = { ...state, path, title: path.split(/[\\/]/).pop() ?? path, dirty: false };
    },
    resetDocument: () => {
      calls.push("resetDocument");
      state = { dirty: false, doc: "", path: null, title: UNTITLED_TITLE };
    },
    clearSession: () => calls.push("clearSession"),
    isSecondaryWindow: () => false,
    setStatus: (text) => {
      calls.push(`status:${text}`);
      status.push(text);
    },
    setPreviewError: (msg) => previewErrors.push(msg),
    ...over,
  };

  return {
    flow: createFileFlow(hooks),
    calls,
    status,
    applied,
    savedPaths,
    previewErrors,
    get state() {
      return state;
    },
    /** 覆盖某一处 hook（个别用例要换个返回值） */
    patch: (p: Partial<FileFlowHooks>) => Object.assign(hooks, p),
  };
}

describe("confirmDiscard：默认文案与标题", () => {
  it("不传参时用「打开新文件」那句，标题固定", async () => {
    const h = harness({ confirm: async (message, title) => {
      h.calls.push(`confirm:${message}:${title}`);
      return true;
    } });
    expect(await h.flow.confirmDiscard()).toBe(true);
    expect(h.calls).toContain(`confirm:${DISCARD_OPEN_NOTICE}:${DISCARD_TITLE}`);
  });

  it("用户点取消 → false（调用方据此放弃动作）", async () => {
    const h = harness({ confirm: async () => false });
    expect(await h.flow.confirmDiscard()).toBe(false);
  });
});

describe("openPath：按路径打开", () => {
  it("干净文档：不确认，直接读盘并落文档、状态写「已打开」", async () => {
    const h = harness();
    expect(await h.flow.openPath("/tmp/a.typ")).toBe(true);
    expect(h.calls).not.toContain("confirm");
    expect(h.calls).toContain("read:/tmp/a.typ");
    expect(h.applied).toEqual([{ content: "磁盘内容", path: "/tmp/a.typ", title: "a.typ" }]);
    expect(h.status).toEqual(["已打开"]);
  });

  it("未保存 + 同一路径：文案说「重新打开」并带标题（不能放行）", async () => {
    const seen: string[] = [];
    const h = harness(
      { confirm: async (message) => (seen.push(message), true) },
      { dirty: true, path: "/tmp/a.typ", title: "a.typ" },
    );
    await h.flow.openPath("/tmp/a.typ");
    expect(seen).toEqual([discardReopenNotice("a.typ")]);
  });

  it("未保存 + 另一个路径：用「打开新文件」那句", async () => {
    const seen: string[] = [];
    const h = harness(
      { confirm: async (message) => (seen.push(message), true) },
      { dirty: true, path: "/tmp/a.typ", title: "a.typ" },
    );
    await h.flow.openPath("/tmp/b.typ");
    expect(seen).toEqual([DISCARD_OPEN_NOTICE]);
  });

  it("确认被取消：不读盘、不落文档、返回 false、状态栏不动", async () => {
    const h = harness({ confirm: async () => false }, { dirty: true });
    expect(await h.flow.openPath("/tmp/a.typ")).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(h.applied).toEqual([]);
    expect(h.status).toEqual([]);
  });

  it("读盘失败：状态栏带原因，返回 false，不落文档", async () => {
    const h = harness({
      read: async () => {
        throw "仅支持 .typ 文件";
      },
    });
    expect(await h.flow.openPath("/tmp/a.txt")).toBe(false);
    expect(h.status).toEqual(["打开失败：仅支持 .typ 文件"]);
    expect(h.applied).toEqual([]);
  });

  it("路径里的目录不参与标题（Windows 反斜杠同样处理）", async () => {
    const h = harness({ read: async (path) => ({ path, content: "" }) });
    await h.flow.openPath("C:\\文稿\\我的论文.typ");
    expect(h.applied[0].title).toBe("我的论文.typ");
  });
});

describe("openViaDialog：菜单「打开…」", () => {
  it("对话框取消 → 连 openPath 都不走", async () => {
    const h = harness();
    await h.flow.openViaDialog();
    expect(h.calls).toEqual(["pickPath"]);
  });

  it("选了文件 → 交给 openPath（确认/读盘/状态一整套都在那边）", async () => {
    const h = harness({ pickPath: async () => "/tmp/pick.typ" });
    await h.flow.openViaDialog();
    expect(h.calls).toContain("read:/tmp/pick.typ");
    expect(h.status).toEqual(["已打开"]);
  });
});

describe("save：保存（唯一写盘路径）", () => {
  it("未命名文档：write(null, 文档) → 落盘后 afterSave，返回路径", async () => {
    const h = harness({ write: async (path, content) => {
      h.calls.push(`write:${path ?? "null"}:${content}`);
      return "/tmp/新文档.typ";
    } });
    expect(await h.flow.save()).toBe("/tmp/新文档.typ");
    expect(h.calls).toContain("write:null:正文");
    expect(h.savedPaths).toEqual(["/tmp/新文档.typ"]);
    expect(h.state.title).toBe("新文档.typ");
  });

  it("已有路径：write 收到原路径与当前文档", async () => {
    const h = harness({}, { path: "/tmp/a.typ", doc: "改了", dirty: true });
    await h.flow.save();
    expect(h.calls).toContain("write:/tmp/a.typ:改了");
  });

  it("取消「另存为」（write 返回 null）：不写存档、不落状态、返回 null", async () => {
    const h = harness({ write: async () => null });
    expect(await h.flow.save()).toBeNull();
    expect(h.calls).not.toContain("afterSave");
    expect(h.status).toEqual([]);
  });

  it("写盘抛错：状态栏「保存失败：原因」，返回 null，未保存标记不动", async () => {
    const h = harness({
      write: async () => {
        throw new Error("目录无效");
      },
    }, { dirty: true });
    expect(await h.flow.save()).toBeNull();
    expect(h.status).toEqual(["保存失败：目录无效"]);
    expect(h.calls).not.toContain("afterSave");
  });

  it("空文档**不弹任何确认**，直接写空（红线：那道确认窗 2026-09-18 已删，别再回退）", async () => {
    const h = harness({ write: async (path, content) => {
      h.calls.push(`write:${path ?? "null"}:${JSON.stringify(content)}`);
      return "/tmp/a.typ";
    } }, { doc: "", path: "/tmp/a.typ" });
    expect(await h.flow.save()).toBe("/tmp/a.typ");
    expect(h.calls).not.toContain("confirm");
    expect(h.calls).toContain('write:/tmp/a.typ:""');
  });
});

describe("reload：Ctrl+R 从磁盘重新读取", () => {
  it("未命名文档：直接忽略（连磁盘都不碰）", async () => {
    const h = harness();
    await h.flow.reload();
    expect(h.calls).toEqual([]);
  });

  it("干净文档：读盘 + 落文档 + 状态「已重新读取」", async () => {
    const h = harness({}, { path: "/tmp/a.typ", title: "a.typ" });
    await h.flow.reload();
    expect(h.status).toEqual(["已重新读取"]);
    expect(h.applied[0]).toMatchObject({ path: "/tmp/a.typ", title: "a.typ" });
  });

  it("未保存：先确认（文案说「重新读取」），取消则不读盘", async () => {
    const seen: string[] = [];
    const h = harness(
      { confirm: async (message) => (seen.push(message), false) },
      { dirty: true, path: "/tmp/a.typ" },
    );
    await h.flow.reload();
    expect(seen).toEqual([DISCARD_RELOAD_NOTICE]);
    expect(h.calls.filter((c) => c.startsWith("read:"))).toEqual([]);
    expect(h.status).toEqual([]);
  });

  it("读盘失败：状态栏「重新读取失败：原因」，不落文档", async () => {
    const h = harness(
      {
        read: async () => {
          throw new Error("文件已删除");
        },
      },
      { path: "/tmp/a.typ" },
    );
    await h.flow.reload();
    expect(h.status).toEqual(["重新读取失败：文件已删除"]);
    expect(h.applied).toEqual([]);
  });
});

describe("createNew：新建", () => {
  it("清空文档并清会话存档（主窗口）", async () => {
    const h = harness();
    await h.flow.createNew();
    expect(h.calls).toContain("resetDocument");
    expect(h.calls).toContain("clearSession");
    expect(h.status).toEqual(["已新建"]);
  });

  it("**副窗口不清存档**（否则会把主窗口的未保存内容抹掉）", async () => {
    const h = harness({ isSecondaryWindow: () => true });
    await h.flow.createNew();
    expect(h.calls).toContain("resetDocument");
    expect(h.calls).not.toContain("clearSession");
  });

  it("有未保存修改：先确认，取消则什么都不做", async () => {
    const seen: string[] = [];
    const h = harness({ confirm: async (message) => (seen.push(message), false) }, { dirty: true });
    await h.flow.createNew();
    expect(seen).toEqual([DISCARD_NEW_NOTICE]);
    expect(h.calls).not.toContain("resetDocument");
    expect(h.calls).not.toContain("clearSession");
    expect(h.status).toEqual([]);
  });

  it("空文档（dirty 但正文为空）不算未保存 → 不问（判定由页面传 isEffectiveDirty）", async () => {
    const h = harness({}, { dirty: false, doc: "" });
    await h.flow.createNew();
    expect(h.calls).not.toContain("confirm");
    expect(h.calls).toContain("resetDocument");
  });

  it("新建**不写存档**：整条路径里没有 afterSave/写存档调用", async () => {
    const h = harness();
    await h.flow.createNew();
    expect(h.calls.filter((c) => c.startsWith("write:"))).toEqual([]);
    expect(h.calls).not.toContain("afterSave");
  });
});

describe("exportPdf：导出 PDF", () => {
  it("成功：先写「导出 PDF…」再写「已导出 PDF」，参数用编译源与字体配置", async () => {
    const h = harness();
    await h.flow.exportPdf();
    expect(h.status).toEqual(["导出 PDF…", "已导出 PDF"]);
    expect(h.calls).toContain("exportPdf:前缀\n正文:未命名.typ");
  });

  it("用户取消「另存为」：状态「已取消导出」，不报错", async () => {
    const h = harness({ exportPdf: async () => ({ ok: false, cancelled: true }) });
    await h.flow.exportPdf();
    expect(h.status).toEqual(["导出 PDF…", "已取消导出"]);
    expect(h.previewErrors).toEqual([]);
  });

  it("Rust 侧失败：状态栏 + 预览区都进错误态", async () => {
    const h = harness({
      exportPdf: async () => ({ ok: false, cancelled: false, error: "第 3 行有语法错误" }),
    });
    await h.flow.exportPdf();
    expect(h.status).toEqual(["导出 PDF…", "导出失败：第 3 行有语法错误"]);
    expect(h.previewErrors).toEqual(["第 3 行有语法错误"]);
  });

  it("调用本身抛错（IPC 异常）：同样报出来，原因取 Error.message", async () => {
    const h = harness({
      exportPdf: async () => {
        throw new Error("命令不存在");
      },
    });
    await h.flow.exportPdf();
    expect(h.status).toEqual(["导出 PDF…", "导出失败：命令不存在"]);
    expect(h.previewErrors).toEqual(["命令不存在"]);
  });
});
