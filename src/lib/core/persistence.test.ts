// @vitest-environment jsdom

// localStorage 持久化模块单元测试（jsdom 提供 localStorage）
import { describe, it, expect, beforeEach } from "vitest";
import { loadState, saveState, clearState, mergeSessionFields } from "./persistence";
import type { PersistedState } from "./persistence";

/** 一份完整状态（测试里只关心个别字段，其余给默认值） */
const fullState = (over: Partial<PersistedState> = {}): PersistedState => ({
  theme: "system",
  content: "",
  filePath: null,
  fileTitle: null,
  prefixEnabled: false,
  prefixCode: "",
  viewMode: "write",
  showPreview: false,
  editorWrap: false,
  dirty: false,
  restoreSession: true,
  autoCheckUpdates: true,
  lastUpdateCheckAt: null,
  updateDismissedAt: null,
  uiZoom: 1,
  chineseFont: "",
  fontDirs: [],
  ...over,
});

describe("persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("无存储时返回空对象", () => {
    expect(loadState()).toEqual({});
  });

  it("saveState 后 loadState 能读回完整状态", () => {
    saveState({
      theme: "dark",
      content: "= hello",
      filePath: "D:\\doc.typ",
      fileTitle: "doc.typ",
      prefixEnabled: true,
      prefixCode: "#set text(size: 12pt)\n",
      viewMode: "source",
      showPreview: true,
      editorWrap: true,
      dirty: true,
      restoreSession: false,
      autoCheckUpdates: false,
      lastUpdateCheckAt: 1_700_000_000_000,
      updateDismissedAt: 1_700_000_100_000,
      uiZoom: 1.3,
      chineseFont: "SimSun",
      fontDirs: ["D:\\fonts"],
    });
    expect(loadState()).toEqual({
      theme: "dark",
      content: "= hello",
      filePath: "D:\\doc.typ",
      fileTitle: "doc.typ",
      prefixEnabled: true,
      prefixCode: "#set text(size: 12pt)\n",
      viewMode: "source",
      showPreview: true,
      editorWrap: true,
      dirty: true,
      restoreSession: false,
      autoCheckUpdates: false,
      lastUpdateCheckAt: 1_700_000_000_000,
      updateDismissedAt: 1_700_000_100_000,
      uiZoom: 1.3,
      chineseFont: "SimSun",
      fontDirs: ["D:\\fonts"],
    });
  });

  it("损坏的 JSON 返回空对象（不抛错）", () => {
    localStorage.setItem("typst-pad:state", "{broken json");
    expect(loadState()).toEqual({});
  });

  it("clearState 后回到空对象", () => {
    saveState({
      theme: "light",
      content: "x",
      filePath: null,
      fileTitle: null,
      prefixEnabled: false,
      prefixCode: "",
      viewMode: "write",
      showPreview: false,
      editorWrap: false,
      dirty: false,
      restoreSession: true,
      autoCheckUpdates: true,
      lastUpdateCheckAt: null,
      updateDismissedAt: null,
      uiZoom: 1,
      chineseFont: "",
      fontDirs: [],
    });
    clearState();
    expect(loadState()).toEqual({});
  });

  it("支持 theme 为 system 的偏好", () => {
    saveState({
      theme: "system",
      content: "",
      filePath: null,
      fileTitle: null,
      prefixEnabled: false,
      prefixCode: "",
      viewMode: "write",
      showPreview: false,
      editorWrap: false,
      dirty: false,
      restoreSession: true,
      autoCheckUpdates: true,
      lastUpdateCheckAt: null,
      updateDismissedAt: null,
      uiZoom: 1,
      chineseFont: "",
      fontDirs: [],
    });
    expect(loadState().theme).toBe("system");
  });

  it("旧存档（无 showPreview 字段）跟随模式：写作 → 单栏，源码 → 双栏", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        viewMode: "write",
      }),
    );
    expect(loadState().showPreview).toBe(false);
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        viewMode: "source",
      }),
    );
    expect(loadState().showPreview).toBe(true);
  });

  it("旧存档（只有 livePreview 布尔）迁移到 viewMode", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        livePreview: false,
      }),
    );
    expect(loadState().viewMode).toBe("source");
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        livePreview: true,
      }),
    );
    expect(loadState().viewMode).toBe("write");
  });

  it("旧存档（无 editorWrap）自动换行默认关", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        viewMode: "source",
        showPreview: true,
      }),
    );
    expect(loadState().editorWrap).toBe(false);
  });

  it("全新存档（无任何模式字段）默认写作模式", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
      }),
    );
    expect(loadState().viewMode).toBe("write");
  });

  it("旧存档（无 restoreSession/dirty）默认：恢复会话开启、脏标记为否", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({
        theme: "dark",
        content: "旧内容",
        filePath: null,
        fileTitle: null,
        prefixEnabled: false,
        prefixCode: "",
        viewMode: "write",
        showPreview: false,
      }),
    );
    const state = loadState();
    expect(state.restoreSession).toBe(true);
    expect(state.dirty).toBe(false);
    expect(state.content).toBe("旧内容");
    // 旧存档没有自动更新字段：默认开启（启动时会检查一次，不再有"上次检查时间"这道门）
    expect(state.autoCheckUpdates).toBe(true);
    expect(state.lastUpdateCheckAt).toBeNull();
    // "点过稍后 = 别再自动弹窗"也是新字段：旧存档读出来是 null（= 照常弹窗）
    expect(state.updateDismissedAt).toBeNull();
    // 界面缩放也是新增字段：旧存档读出来是默认 100%
    expect(state.uiZoom).toBe(1);
  });

  it("uiZoom 损坏（字符串）时回落默认 100%，不让脏数据把界面放大", () => {
    localStorage.setItem("typst-pad:state", JSON.stringify({ uiZoom: "两倍" }));
    expect(loadState().uiZoom).toBe(1);
  });

  it("旧存档（无 chineseFont/fontDirs）默认：正文字体「默认」、无额外字体目录", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null }),
    );
    const state = loadState();
    expect(state.chineseFont).toBe("");
    expect(state.fontDirs).toEqual([]);
  });

  it("chineseFont 损坏（非字符串）/ fontDirs 损坏（非数组）时回落默认", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ chineseFont: 123, fontDirs: "D:\\fonts" }),
    );
    const state = loadState();
    expect(state.chineseFont).toBe("");
    expect(state.fontDirs).toEqual([]);
  });

  it("lastUpdateCheckAt 损坏（字符串/NaN 之类）时不写进状态（它现在只是记录，别再被当成判定依据）", () => {
    localStorage.setItem("typst-pad:state", JSON.stringify({ lastUpdateCheckAt: "刚刚" }));
    expect(loadState().lastUpdateCheckAt).toBeNull();
  });

  it("updateDismissedAt 损坏时不写进状态（否则一个坏值会让更新弹窗永远不再出现）", () => {
    localStorage.setItem("typst-pad:state", JSON.stringify({ updateDismissedAt: "刚刚" }));
    expect(loadState().updateDismissedAt).toBeNull();
  });
});

describe("多窗口：副窗口（新建窗口）只写设置，不动主窗口的会话", () => {
  it("mergeSessionFields 用 previous 的会话字段覆盖 next", () => {
    const merged = mergeSessionFields(
      fullState({ content: "副窗口的空文档", dirty: true, uiZoom: 1.4 }),
      {
        content: "主窗口的未保存内容",
        filePath: "D:\\doc.typ",
        fileTitle: "doc.typ",
        dirty: true,
        uiZoom: 1,
      },
    );
    // 会话字段来自 previous
    expect(merged.content).toBe("主窗口的未保存内容");
    expect(merged.filePath).toBe("D:\\doc.typ");
    expect(merged.fileTitle).toBe("doc.typ");
    expect(merged.dirty).toBe(true);
    // 设置字段来自 next
    expect(merged.uiZoom).toBe(1.4);
  });

  it("previous 里没有会话字段（首启动/旧存档）时回落成空会话，不写入 undefined", () => {
    const merged = mergeSessionFields(fullState({ content: "x" }), {});
    expect(merged.content).toBe("");
    expect(merged.filePath).toBeNull();
    expect(merged.fileTitle).toBeNull();
    expect(merged.dirty).toBe(false);
  });

  it("saveState({ session: false }) 保留存档里已有的会话（副窗口改设置后主窗口内容还在）", () => {
    saveState(
      fullState({
        content: "主窗口的未保存内容",
        filePath: "D:\\doc.typ",
        fileTitle: "doc.typ",
        dirty: true,
      }),
    );
    // 副窗口：空文档 + 改了自己的界面缩放
    saveState(fullState({ content: "", uiZoom: 1.5 }), { session: false });
    const saved = loadState();
    expect(saved.content).toBe("主窗口的未保存内容");
    expect(saved.filePath).toBe("D:\\doc.typ");
    expect(saved.dirty).toBe(true);
    expect(saved.uiZoom).toBe(1.5); // 设置是共享的：副窗口改的也要落盘
  });

  it("默认（不带 options）= 主窗口，会话一起写", () => {
    saveState(fullState({ content: "主窗口的未保存内容" }));
    saveState(fullState({ content: "换成新文档了" }));
    expect(loadState().content).toBe("换成新文档了");
  });
});
