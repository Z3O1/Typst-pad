// word-wrap 单元测试：Alt+Z 自动换行开关的按键判定与提示文案（纯逻辑，无 DOM）。
import { describe, it, expect } from "vitest";
import { WRAP_SOURCE_ONLY_NOTICE, isWrapToggleKey, wrapNotice } from "./word-wrap";

/** 构造按键事件：只写关心字段，修饰键默认全 false */
const key = (
  k: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isWrapToggleKey", () => {
  it("Alt+Z 命中（小写 z）", () => {
    expect(isWrapToggleKey(key("z", { altKey: true }))).toBe(true);
  });

  it("大小写都认（Alt 按住时 key 可能是 Z，输入法/布局差异）", () => {
    expect(isWrapToggleKey(key("Z", { altKey: true }))).toBe(true);
  });

  it("单独的 Z 不算：没有 Alt 时那是正常输入", () => {
    expect(isWrapToggleKey(key("z"))).toBe(false);
  });

  it("Ctrl+Z 绝不能被抢（撤销）", () => {
    expect(isWrapToggleKey(key("z", { ctrlKey: true }))).toBe(false);
    expect(isWrapToggleKey(key("z", { ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("Cmd+Z（macOS 撤销）同样不抢", () => {
    expect(isWrapToggleKey(key("z", { metaKey: true }))).toBe(false);
    expect(isWrapToggleKey(key("z", { metaKey: true, altKey: true }))).toBe(false);
  });

  it("Alt+Shift+Z 不认（部分输入法/布局另有语义）", () => {
    expect(isWrapToggleKey(key("z", { altKey: true, shiftKey: true }))).toBe(false);
  });

  it("Alt+其它字母不算", () => {
    expect(isWrapToggleKey(key("x", { altKey: true }))).toBe(false);
    expect(isWrapToggleKey(key("a", { altKey: true }))).toBe(false);
  });
});

describe("文案", () => {
  it("开关反馈说清是开还是关", () => {
    expect(wrapNotice(true)).toBe("自动换行：开");
    expect(wrapNotice(false)).toBe("自动换行：关");
  });

  it("写作模式下的提示点明「写作模式本来就折行、Alt+Z 只管源码模式」", () => {
    expect(WRAP_SOURCE_ONLY_NOTICE).toContain("始终自动换行");
    expect(WRAP_SOURCE_ONLY_NOTICE).toContain("源代码模式");
  });
});
