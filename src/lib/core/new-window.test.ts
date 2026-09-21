// 新建窗口的规则单测：label 唯一性与前缀、失败原因文案、以及"不是 Tauri 就什么都不做"。
//
// 规则本身见 `core/new-window.ts` 的文件头（label 必须唯一、前缀必须与 capabilities 的
// `editor-*` 一致、失败要报到状态栏）。这些以前只写在页面里、单测够不着 —— 而 ACL 拒绝那类
// 失败是**运行时**才发作的（0.7.9 发出去过一次），所以除了 `scripts/capabilities.test.mjs`
// 的静态体检，这里把"失败怎么报"钉住。
import { describe, it, expect, vi } from "vitest";
import {
  NEW_WINDOW_LABEL_PREFIX,
  NEW_WINDOW_TITLE,
  createNewWindow,
  newWindowFailureReason,
  newWindowLabel,
} from "./new-window";
import type { NewWindowHooks } from "./new-window";

function hooks(over: Partial<NewWindowHooks> = {}): NewWindowHooks {
  return {
    isTauri: () => true,
    createWindow: vi.fn(),
    setStatus: vi.fn(),
    logCreateFailure: vi.fn(),
    now: () => 1700000000000,
    ...over,
  };
}

describe("newWindowLabel", () => {
  it("前缀与 capabilities 的 editor-* 一致，且带时间戳保证唯一", () => {
    expect(NEW_WINDOW_LABEL_PREFIX).toBe("editor-");
    expect(newWindowLabel(1700000000000)).toBe("editor-1700000000000");
    expect(newWindowLabel(1)).not.toBe(newWindowLabel(2));
  });
});

describe("newWindowFailureReason", () => {
  it("Error 取 message", () => {
    expect(newWindowFailureReason(new Error("label 撞车"))).toBe("label 撞车");
  });

  it("字符串原样返回（tauri://error 事件的 payload 就是字符串）", () => {
    expect(
      newWindowFailureReason("Command plugin:webview|create_webview_window not allowed by ACL"),
    ).toContain("not allowed by ACL");
  });

  it("拿不到东西时给空串，不写一个光秃秃的 undefined", () => {
    expect(newWindowFailureReason(undefined)).toBe("");
    expect(newWindowFailureReason(null)).toBe("");
    expect(newWindowFailureReason({ a: 1 })).toBe("[object Object]");
  });
});

describe("createNewWindow", () => {
  it("非 Tauri（浏览器预览）什么都不做", () => {
    const h = hooks({ isTauri: () => false });
    createNewWindow(h).open();
    expect(h.createWindow).not.toHaveBeenCalled();
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("建窗口：label 用注入的时间戳、标题是空白草稿窗口的标题", () => {
    const h = hooks({ now: () => 42 });
    createNewWindow(h).open();
    expect(h.createWindow).toHaveBeenCalledTimes(1);
    const [label, title] = (h.createWindow as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(label).toBe("editor-42");
    expect(title).toBe(NEW_WINDOW_TITLE);
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it("异步失败（tauri://error 的 payload）→ 状态栏 + 调试日志", () => {
    const h = hooks();
    let onAsyncError: ((detail: unknown) => void) | undefined;
    h.createWindow = vi.fn((_label, _title, cb) => {
      onAsyncError = cb;
    }) as unknown as NewWindowHooks["createWindow"];
    createNewWindow(h).open();
    onAsyncError?.("Command plugin:webview|create_webview_window not allowed by ACL");
    expect(h.setStatus).toHaveBeenCalledWith(
      "新建窗口失败：Command plugin:webview|create_webview_window not allowed by ACL",
    );
    expect(h.logCreateFailure).toHaveBeenCalledWith(
      "Command plugin:webview|create_webview_window not allowed by ACL",
    );
  });

  it("同步抛错（系统拒绝 / label 撞车）→ 状态栏带 message，不冒泡", () => {
    const h = hooks({
      createWindow: vi.fn(() => {
        throw new Error("a webview with label `editor-1` already exists");
      }) as unknown as NewWindowHooks["createWindow"],
    });
    expect(() => createNewWindow(h).open()).not.toThrow();
    expect(h.setStatus).toHaveBeenCalledWith(
      "新建窗口失败：a webview with label `editor-1` already exists",
    );
    // 同步这条分支没有 payload 可记日志（页面那边也只有状态栏这一份现场）
    expect(h.logCreateFailure).not.toHaveBeenCalled();
  });
});
