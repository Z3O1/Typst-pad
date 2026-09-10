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
      livePreview: false,
      showPreview: true,
    });
    expect(loadState()).toEqual({
      theme: "dark",
      content: "= hello",
      filePath: "D:\\doc.typ",
      fileTitle: "doc.typ",
      prefixEnabled: true,
      prefixCode: "#set text(size: 12pt)\n",
      livePreview: false,
      showPreview: true,
    });
  });

  it("损坏的 JSON 返回空对象（不抛错）", () => {
    localStorage.setItem("typst-pad:state", "{broken json");
    expect(loadState()).toEqual({});
  });

  it("clearState 后回到空对象", () => {
    saveState({ theme: "light", content: "x", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: true, showPreview: false });
    clearState();
    expect(loadState()).toEqual({});
  });

  it("支持 theme 为 system 的偏好", () => {
    saveState({ theme: "system", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: true, showPreview: false });
    expect(loadState().theme).toBe("system");
  });

  it("旧存档（无 showPreview 字段）跟随形态：所见即所得 → 单栏", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: true }),
    );
    expect(loadState().showPreview).toBe(false);
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "", livePreview: false }),
    );
    expect(loadState().showPreview).toBe(true);
  });

  it("旧存档（无 livePreview 字段）默认开启所见即所得", () => {
    localStorage.setItem(
      "typst-pad:state",
      JSON.stringify({ theme: "dark", content: "", filePath: null, fileTitle: null, prefixEnabled: false, prefixCode: "" }),
    );
    expect(loadState().livePreview).toBe(true);
  });
});
