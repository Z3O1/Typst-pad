// 窗口级流程单元测试。
//
// 把几条"改起来很容易踩回去"的规则钉住：
//  ① open-file 是广播：**有焦点的窗口接**（并清掉队列告诉别人"已接走"）；
//  ② 都没焦点时**只有主窗口**延迟兜底，且兜底前先看队列（有人接走了就放手）；
//  ③ 副窗口没焦点不抢（草稿窗口不该被启动参数里的文件顶掉内容）；
//  ④ 新建窗口 label 必须唯一（时间戳）且带 `editor-` 前缀（ACL 靠它对上），
//     失败原因同步/异步两条路都要报到状态栏；
//  ⑤ 拖放：悬停显示提示，落下时只认 .typ，拖了别的文件说明一句。
import { describe, it, expect, vi } from "vitest";

// window-flow 通过 file-ops 用 pickTypPath（纯函数），而 file-ops 顶层 import 了 Tauri 插件
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import {
  NEW_WINDOW_LABEL_PREFIX,
  NEW_WINDOW_TITLE,
  ONLY_TYP_NOTICE,
  OPEN_FILE_FALLBACK_DELAY_MS,
  createWindowFlow,
  newWindowFailureReason,
  type WindowFlowHooks,
} from "./window-flow";

function harness(over: Partial<WindowFlowHooks> = {}) {
  const calls: string[] = [];
  const status: string[] = [];
  const logs: unknown[] = [];
  let dragActive = false;
  let timer: (() => void) | undefined;
  let timerMs: number | undefined;
  let timerSeq = 0;
  /** createWindow 注入的异步失败回调（模拟 tauri://error 事件） */
  let asyncFail: ((detail: unknown) => void) | undefined;

  const hooks: WindowFlowHooks = {
    isTauri: () => true,
    createWindow: (label, title, onAsyncError) => {
      calls.push(`create:${label}:${title}`);
      asyncFail = onAsyncError;
    },
    closeWindow: () => calls.push("closeWindow"),
    isFocused: async () => true,
    takePendingFiles: async () => {
      calls.push("takePendingFiles");
      return [];
    },
    openPath: async (path) => {
      calls.push(`openPath:${path}`);
      return true;
    },
    isSecondaryWindow: () => false,
    setDragActive: (active) => {
      dragActive = active;
      calls.push(`dragActive:${active}`);
    },
    setStatus: (text) => {
      status.push(text);
    },
    logCreateFailure: (detail) => logs.push(detail),
    now: () => 1700000000000,
    setTimer: (fn, ms) => {
      timer = fn;
      timerMs = ms;
      return ++timerSeq;
    },
    clearTimer: () => {
      timer = undefined;
    },
    ...over,
  };

  return {
    flow: createWindowFlow(hooks),
    calls,
    status,
    logs,
    get dragActive() {
      return dragActive;
    },
    get timerMs() {
      return timerMs;
    },
    get hasTimer() {
      return timer !== undefined;
    },
    /** 触发建窗口过程中的异步失败（tauri://error） */
    failAsync: (detail: unknown) => asyncFail?.(detail),
    /** 跑掉兜底定时器 */
    runTimer: async () => {
      const fn = timer;
      timer = undefined;
      fn?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("newWindowFailureReason：失败原因两种来源", () => {
  it("同步抛出的 Error → message", () => {
    expect(newWindowFailureReason(new Error("label 已存在"))).toBe("label 已存在");
  });

  it("异步事件里的字符串 payload → 原样", () => {
    expect(newWindowFailureReason("Command not allowed by ACL")).toBe(
      "Command not allowed by ACL",
    );
  });

  it("拿不到原因 → 空串（不写 undefined）", () => {
    expect(newWindowFailureReason(undefined)).toBe("");
    expect(newWindowFailureReason(null)).toBe("");
  });

  it("非字符串的 payload → String(...)", () => {
    expect(newWindowFailureReason(42)).toBe("42");
  });
});

describe("openNewWindow：新建窗口", () => {
  it("label 用 editor- 前缀 + 时间戳，标题是未命名", () => {
    const h = harness();
    h.flow.openNewWindow();
    expect(h.calls).toEqual([`create:${NEW_WINDOW_LABEL_PREFIX}1700000000000:${NEW_WINDOW_TITLE}`]);
  });

  it("非 Tauri（浏览器预览）什么都不做", () => {
    const h = harness({ isTauri: () => false });
    h.flow.openNewWindow();
    expect(h.calls).toEqual([]);
  });

  it("同步抛错：状态栏「新建窗口失败：原因」", () => {
    const h = harness({
      createWindow: () => {
        throw new Error("系统拒绝");
      },
    });
    h.flow.openNewWindow();
    expect(h.status).toEqual(["新建窗口失败：系统拒绝"]);
  });

  it("异步失败（tauri://error）：状态栏 + 调试日志都留痕", () => {
    const h = harness();
    h.flow.openNewWindow();
    h.failAsync("Command plugin:webview|create_webview_window not allowed by ACL");
    expect(h.status).toEqual([
      "新建窗口失败：Command plugin:webview|create_webview_window not allowed by ACL",
    ]);
    expect(h.logs).toEqual(["Command plugin:webview|create_webview_window not allowed by ACL"]);
  });

  it("异步失败但不是字符串 payload：状态栏给 String(...)", () => {
    const h = harness();
    h.flow.openNewWindow();
    h.failAsync({ code: 7 });
    expect(h.status).toEqual(["新建窗口失败：[object Object]"]);
  });
});

describe("closeCurrentWindow：关闭当前窗口", () => {
  it("Tauri 内转给 closeWindow（与标题栏同一条路）", () => {
    const h = harness();
    h.flow.closeCurrentWindow();
    expect(h.calls).toEqual(["closeWindow"]);
  });

  it("非 Tauri 不调（浏览器里没有窗口 API）", () => {
    const h = harness({ isTauri: () => false });
    h.flow.closeCurrentWindow();
    expect(h.calls).toEqual([]);
  });
});

describe("claimOpenFileOnBroadcast：open-file 广播由谁接", () => {
  it("有焦点：先清队列（告诉别人已接走）再打开", async () => {
    const h = harness();
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    expect(h.calls).toEqual(["takePendingFiles", "openPath:/tmp/a.typ"]);
    expect(h.hasTimer).toBe(false);
  });

  it("没焦点 + 主窗口：不立刻打开，排一个兜底定时器", async () => {
    const h = harness({ isFocused: async () => false });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    expect(h.calls).toEqual([]);
    expect(h.hasTimer).toBe(true);
    expect(h.timerMs).toBe(OPEN_FILE_FALLBACK_DELAY_MS);
  });

  it("兜底时队列里还有文件（没人接走）→ 主窗口接", async () => {
    const h = harness({
      isFocused: async () => false,
      takePendingFiles: async () => ["/tmp/old.typ", "/tmp/new.typ"],
    });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    await h.runTimer();
    // 取最后一个（最新请求）
    expect(h.calls).toContain("openPath:/tmp/new.typ");
  });

  it("兜底时队列已空（别的窗口接走了）→ 放手，不打开", async () => {
    const h = harness({ isFocused: async () => false, takePendingFiles: async () => [] });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    await h.runTimer();
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
  });

  it("没焦点 + 副窗口：连定时器都不排（交给主窗口兜底）", async () => {
    const h = harness({ isFocused: async () => false, isSecondaryWindow: () => true });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    expect(h.calls).toEqual([]);
    expect(h.hasTimer).toBe(false);
  });

  it("焦点查询失败（抛错）按没有焦点处理 → 主窗口走兜底", async () => {
    const h = harness({
      isFocused: async () => {
        throw new Error("窗口 API 不可用");
      },
    });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
    expect(h.hasTimer).toBe(true);
  });

  it("接连两条广播：兜底定时器只留最后一个（不叠加）", async () => {
    const h = harness({ isFocused: async () => false });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    await h.flow.claimOpenFileOnBroadcast("/tmp/b.typ");
    expect(h.hasTimer).toBe(true);
  });

  it("dispose：取消还没落地的兜底打开", async () => {
    const h = harness({ isFocused: async () => false });
    await h.flow.claimOpenFileOnBroadcast("/tmp/a.typ");
    h.flow.dispose();
    expect(h.hasTimer).toBe(false);
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
  });
});

describe("claimPendingFileOnStartup：启动时取关联打开的待打开文件", () => {
  it("主窗口：取队列里最后一个（最新请求）并打开", async () => {
    const h = harness({ takePendingFiles: async () => ["/tmp/old.typ", "/tmp/new.typ"] });
    await h.flow.claimPendingFileOnStartup();
    expect(h.calls).toContain("openPath:/tmp/new.typ");
  });

  it("队列为空：不打开任何东西（只是启动，不是关联双击）", async () => {
    const h = harness();
    await h.flow.claimPendingFileOnStartup();
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
  });

  it("副窗口：连队列都不取（草稿窗口不被启动参数顶掉内容）", async () => {
    const h = harness({
      isSecondaryWindow: () => true,
      takePendingFiles: async () => ["/tmp/a.typ"],
    });
    await h.flow.claimPendingFileOnStartup();
    expect(h.calls).toEqual([]);
  });
});

describe("handleDragDrop：窗口级拖放", () => {
  it("enter / over：显示悬停提示", () => {
    const h = harness();
    h.flow.handleDragDrop("enter", []);
    expect(h.dragActive).toBe(true);
    h.flow.handleDragDrop("over", []);
    expect(h.dragActive).toBe(true);
  });

  it("drop 到 .typ：关掉提示并打开它", () => {
    const h = harness();
    h.flow.handleDragDrop("enter", []);
    h.flow.handleDragDrop("drop", ["/tmp/a.typ"]);
    expect(h.dragActive).toBe(false);
    expect(h.calls).toContain("openPath:/tmp/a.typ");
  });

  it("drop 里夹着非 .typ：取第一个 .typ 打开，不报「仅支持」", () => {
    const h = harness();
    h.flow.handleDragDrop("drop", ["/tmp/a.txt", "/tmp/b.TYP"]);
    expect(h.calls).toContain("openPath:/tmp/b.TYP");
    expect(h.status).toEqual([]);
  });

  it("drop 的全不是 .typ：状态栏说明一句（文件多选时不静默）", () => {
    const h = harness();
    h.flow.handleDragDrop("drop", ["/tmp/a.txt"]);
    expect(h.status).toEqual([ONLY_TYP_NOTICE]);
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
  });

  it("drop 的路径数组为空：什么都不做", () => {
    const h = harness();
    h.flow.handleDragDrop("drop", []);
    expect(h.status).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("openPath"))).toEqual([]);
  });

  it("leave：关掉悬停提示", () => {
    const h = harness();
    h.flow.handleDragDrop("enter", []);
    h.flow.handleDragDrop("leave", []);
    expect(h.dragActive).toBe(false);
  });
});
