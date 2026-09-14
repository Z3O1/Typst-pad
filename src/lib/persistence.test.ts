// localStorage 持久化模块单元测试（jsdom 提供 localStorage）
import { describe, it, expect, beforeEach } from "vitest";
import { loadState, saveState, clearState } from "./persistence";

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
    saveState({ theme: "light", content: "x", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "write", showPreview: false, editorWrap: false, dirty: false, restoreSession: true, autoCheckUpdates: true, lastUpdateCheckAt: null, uiZoom: 1, chineseFont: "", fontDirs: [] });
    clearState();
    expect(loadState()).toEqual({});
  });

  it("支持 theme 为 system 的偏好", () => {
    saveState({ theme: "system", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "write", showPreview: false, editorWrap: false, dirty: false, restoreSession: true, autoCheckUpdates: true, lastUpdateCheckAt: null, uiZoom: 1, chineseFont: "", fontDirs: [] });
    expect(loadState().theme).toBe("system");
  });

  it("旧存档（无 showPreview 字段）跟随模式：写作 → 单栏，源码 → 双栏", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "write" }),
    );
    expect(loadState().showPreview).toBe(false);
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "source" }),
    );
    expect(loadState().showPreview).toBe(true);
  });

  it("旧存档（只有 livePreview 布尔）迁移到 viewMode", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: false }),
    );
    expect(loadState().viewMode).toBe("source");
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: true }),
    );
    expect(loadState().viewMode).toBe("write");
  });

  it("旧存档（无 editorWrap）自动换行默认关", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "source", showPreview: true }),
    );
    expect(loadState().editorWrap).toBe(false);
  });

  it("全新存档（无任何模式字段）默认写作模式", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "" }),
    );
    expect(loadState().viewMode).toBe("write");
  });

  it("旧存档（无 restoreSession/dirty）默认：恢复会话开启、脏标记为否", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "旧内容", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", viewMode: "write", showPreview: false }),
    );
    const state = loadState();
    expect(state.restoreSession).toBe(true);
    expect(state.dirty).toBe(false);
    expect(state.content).toBe("旧内容");
    // 旧存档没有自动更新字段：默认开启，且"没检查过"（启动即检查一次，见 update-utils.isCheckDue）
    expect(state.autoCheckUpdates).toBe(true);
    expect(state.lastUpdateCheckAt).toBeNull();
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

  it("lastUpdateCheckAt 损坏（字符串/NaN 之类）时不传给节流逻辑", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ lastUpdateCheckAt: "刚刚" }),
    );
    expect(loadState().lastUpdateCheckAt).toBeNull();
  });
});
