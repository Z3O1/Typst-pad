// app-keys 单元测试：页面级快捷键的路由决策（纯逻辑，无 DOM）。
// 重点锁两条**顺序敏感**的判定：① Esc 只关弹窗；② Ctrl+Shift+N（新建窗口）绝不能被
// Shift 格式表吞掉 —— 后者正是 2026-09-14 用户报「Ctrl+Shift+N 新建窗口」没反应的根因。
import { describe, it, expect } from "vitest";
import { SHIFT_FORMAT_COMMANDS, decideAppKey, topModal } from "./app-keys";
import type { AppKeyState } from "./app-keys";

/** 构造按键事件：只写关心字段，修饰键默认全 false；`code` 用于物理键判定（可选） */
const key = (
  k: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> & {
    code?: string;
  } = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  code: undefined,
  ...mods,
});

/** 默认页面状态：无文件、无弹窗 */
const state = (s: Partial<AppKeyState> = {}): AppKeyState => ({
  hasFilePath: false,
  openModal: null,
  ...s,
});

describe("decideAppKey：新建窗口", () => {
  it("Ctrl+Shift+N → 新建窗口（**不被 Shift 格式表吞掉**，这就是那个 bug）", () => {
    expect(decideAppKey(key("n", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "new-window",
    });
  });

  it("Cmd+Shift+N（macOS）同样命中", () => {
    expect(decideAppKey(key("N", { metaKey: true, shiftKey: true }), state())).toEqual({
      type: "new-window",
    });
  });

  it("无 Shift 的 Ctrl+N 不在此处理（那是菜单「新建」，由 MenuBar 统一处理）", () => {
    expect(decideAppKey(key("n", { ctrlKey: true }), state())).toBeNull();
  });

  it("Shift 格式表仍然完好：Ctrl+Shift+M 还是公式块，且表里没有 n", () => {
    expect(decideAppKey(key("m", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "format",
      command: "math-block",
    });
    expect("n" in SHIFT_FORMAT_COMMANDS).toBe(false);
  });

  it("表里没有的 Shift 组合不处理（不抢系统手势）", () => {
    expect(decideAppKey(key("p", { ctrlKey: true, shiftKey: true }), state())).toBeNull();
    expect(decideAppKey(key("w", { ctrlKey: true, shiftKey: true }), state())).toBeNull();
  });
});

describe("decideAppKey：Ctrl+Shift+= / - 调整界面缩放（用户要求）", () => {
  it("Ctrl+Shift+= → 放大一格", () => {
    expect(decideAppKey(key("=", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "zoom",
      steps: 1,
    });
  });

  it("Ctrl+Shift++ （真的按出加号，布局不同 key 也不同）同样放大", () => {
    expect(decideAppKey(key("+", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "zoom",
      steps: 1,
    });
  });

  it("Ctrl+Shift+- → 缩小一格（含 Shift 把 - 打成 _ 的布局）", () => {
    expect(decideAppKey(key("-", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "zoom",
      steps: -1,
    });
    expect(decideAppKey(key("_", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "zoom",
      steps: -1,
    });
  });

  it("按物理键也能命中（键盘布局把字符改掉时靠 code 兜住）", () => {
    expect(decideAppKey(key("?", { ctrlKey: true, shiftKey: true, code: "Equal" }), state())).toEqual({
      type: "zoom",
      steps: 1,
    });
    expect(decideAppKey(key("_", { ctrlKey: true, shiftKey: true, code: "NumpadSubtract" }), state())).toEqual({
      type: "zoom",
      steps: -1,
    });
  });

  it("Cmd（macOS）同样命中", () => {
    expect(decideAppKey(key("=", { metaKey: true, shiftKey: true }), state())).toEqual({
      type: "zoom",
      steps: 1,
    });
  });

  it("不带 Shift 的 Ctrl+= / Ctrl+- 不抢（那是引擎/系统自己的缩放手势）", () => {
    expect(decideAppKey(key("=", { ctrlKey: true }), state())).toBeNull();
    expect(decideAppKey(key("-", { ctrlKey: true }), state())).toBeNull();
  });

  it("带 Alt 的组合不认（部分输入法/布局另有含义）", () => {
    expect(decideAppKey(key("=", { ctrlKey: true, shiftKey: true, altKey: true }), state())).toBeNull();
  });

  it("缩放这一对不影响既有的 Shift 手势：Ctrl+Shift+N 仍是新建窗口、Ctrl+Shift+M 仍是公式块", () => {
    expect(decideAppKey(key("n", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "new-window",
    });
    expect(decideAppKey(key("m", { ctrlKey: true, shiftKey: true }), state())).toEqual({
      type: "format",
      command: "math-block",
    });
  });
});

describe("decideAppKey：Esc 关弹窗", () => {
  it("没有弹窗时 Esc 不动（编辑器自己要用它）", () => {
    expect(decideAppKey(key("Escape"), state())).toBeNull();
  });

  it("设置弹窗开着 → 关设置", () => {
    expect(decideAppKey(key("Escape"), state({ openModal: "settings" }))).toEqual({
      type: "dismiss-modal",
      modal: "settings",
    });
  });

  it("Esc 优先于其它判定：同时按着 Ctrl 也只会关弹窗，不会去改格式", () => {
    expect(
      decideAppKey(key("Escape", { ctrlKey: true, shiftKey: true }), state({ openModal: "settings" })),
    ).toEqual({ type: "dismiss-modal", modal: "settings" });
  });

  it("弹窗开着时 Esc 不会被任何编辑类动作抢走（逐个弹窗核对）", () => {
    for (const modal of ["close-prompt", "update", "settings", "about"] as const) {
      const action = decideAppKey(key("Escape"), state({ openModal: modal }));
      expect(action).toEqual({ type: "dismiss-modal", modal });
    }
  });
});

describe("topModal：Esc 的收件人优先级", () => {
  it("都没开 → null", () => {
    expect(topModal({})).toBeNull();
    expect(topModal({ settings: false, about: false })).toBeNull();
  });

  it("关闭确认最上层，其次更新弹窗、设置、关于", () => {
    expect(topModal({ "close-prompt": true, update: true, settings: true })).toBe("close-prompt");
    expect(topModal({ update: true, settings: true })).toBe("update");
    expect(topModal({ settings: true, about: true })).toBe("settings");
    expect(topModal({ about: true })).toBe("about");
  });
});

describe("decideAppKey：其余页面级快捷键", () => {
  it("Alt+Z → 自动换行开关（排在 Ctrl/Meta 门之前，因为它没有 Ctrl）", () => {
    expect(decideAppKey(key("z", { altKey: true }), state())).toEqual({ type: "wrap-toggle" });
  });

  it("Ctrl+R 只在有文件时拦（没文件时放行给浏览器刷新）", () => {
    expect(decideAppKey(key("r", { ctrlKey: true }), state({ hasFilePath: true }))).toEqual({
      type: "reload-file",
    });
    expect(decideAppKey(key("r", { ctrlKey: true }), state({ hasFilePath: false }))).toBeNull();
  });

  it("Ctrl+W → 关闭窗口", () => {
    expect(decideAppKey(key("w", { ctrlKey: true }), state())).toEqual({ type: "close-window" });
  });

  it("不含 Ctrl/Meta 的普通按键一律不处理", () => {
    expect(decideAppKey(key("s"), state())).toBeNull();
    expect(decideAppKey(key("Enter"), state())).toBeNull();
    expect(decideAppKey(key("Escape"), state({ openModal: null }))).toBeNull();
  });
});
