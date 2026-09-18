// 状态栏两个计数徽标的浮层状态机单元测试
//
// 这一块的用户可见症状是"点了没反应"和"警告的关闭行为和错误不一样"，两条都是踩过的：
//  - 两个徽标曾经各有一份开合状态 ⇒ 警告侧少了 Esc / 点外部 / 跳转即关 / 视口收边四条行为；
//  - 空浮层（只有标题、没有条目）曾经会留下来（错误修好后浮层不收）。
// 所以这里既测状态机本身，也测"有内容才可见"。
import { describe, it, expect } from "vitest";
import {
  badgePopoverStyle,
  errorPopoverVisible,
  nextBadgePopover,
  warningPopoverVisible,
  type BadgePopoverState,
} from "./badge-popover";

describe("nextBadgePopover 开合语义", () => {
  it("从关着点任一徽标 → 开那一个", () => {
    expect(nextBadgePopover("none", "errors")).toBe("errors");
    expect(nextBadgePopover("none", "warnings")).toBe("warnings");
  });

  it("再点同一个 → 关（用户点两次就是开关）", () => {
    expect(nextBadgePopover("errors", "errors")).toBe("none");
    expect(nextBadgePopover("warnings", "warnings")).toBe("none");
  });

  it("点另一个 → 切换过去，绝不是两个都开", () => {
    expect(nextBadgePopover("errors", "warnings")).toBe("warnings");
    expect(nextBadgePopover("warnings", "errors")).toBe("errors");
  });

  it("开合只由 (当前, 点谁) 决定 —— 遍历全部组合", () => {
    const states: BadgePopoverState[] = ["none", "errors", "warnings"];
    const table = states.flatMap((s) =>
      (["errors", "warnings"] as const).map((k) => [s, k, nextBadgePopover(s, k)] as const),
    );
    expect(table).toEqual([
      ["none", "errors", "errors"],
      ["none", "warnings", "warnings"],
      ["errors", "errors", "none"],
      ["errors", "warnings", "warnings"],
      ["warnings", "errors", "errors"],
      ["warnings", "warnings", "none"],
    ]);
  });
});

describe("浮层可见性（有内容才存在）", () => {
  it("错误：关着时一律不可见", () => {
    expect(errorPopoverVisible("none", 3, null)).toBe(false);
    expect(errorPopoverVisible("none", 0, "包不存在")).toBe(false);
  });

  it("错误：只有定位错误也算有内容", () => {
    expect(errorPopoverVisible("errors", 2, null)).toBe(true);
  });

  it("错误：没有定位错误但有非定位错误也算有内容", () => {
    expect(errorPopoverVisible("errors", 0, "包不存在")).toBe(true);
  });

  it("错误：开着但一条错误都没有 → 不可见（空浮层不许留）", () => {
    expect(errorPopoverVisible("errors", 0, null)).toBe(false);
    expect(errorPopoverVisible("errors", 0, "")).toBe(false);
  });

  it("警告：开着且有条目才可见", () => {
    expect(warningPopoverVisible("warnings", 1)).toBe(true);
    expect(warningPopoverVisible("warnings", 0)).toBe(false);
  });

  it("两个徽标不串台：状态指向另一个时本徽标不可见", () => {
    expect(errorPopoverVisible("warnings", 5, "x")).toBe(false);
    expect(warningPopoverVisible("errors", 5)).toBe(false);
  });
});

describe("badgePopoverStyle 收边内联样式", () => {
  it("无平移、无限宽（clamp 的初值）时只有 transform", () => {
    expect(badgePopoverStyle({ translateX: 0, translateY: 0, maxWidth: 0 })).toBe(
      "transform: translate(0px, 0px);",
    );
  });

  it("平移量为负（视口左/上收边）照原样写进 transform", () => {
    expect(badgePopoverStyle({ translateX: -24, translateY: -8, maxWidth: 0 })).toBe(
      "transform: translate(-24px, -8px);",
    );
  });

  it("maxWidth > 0 时追加 max-width（窄视口才限宽）", () => {
    expect(badgePopoverStyle({ translateX: 0, translateY: 12, maxWidth: 320 })).toBe(
      "transform: translate(0px, 12px);max-width:320px",
    );
  });

  it("maxWidth 为 0 或负数时不出现 max-width（不是 max-width:0）", () => {
    expect(badgePopoverStyle({ translateX: 0, translateY: 0, maxWidth: -1 })).not.toContain(
      "max-width",
    );
  });
});
