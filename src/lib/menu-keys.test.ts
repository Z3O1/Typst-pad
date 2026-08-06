// 菜单栏按键决策纯函数的单元测试：
// decideMenuKey（Alt 切换 / accessKey / 导航键 / #2 退出规则 / #3 组合键快捷键）
// 与 parseShortcut / findShortcutTarget / shortcutMatches（快捷键文本解析与匹配）。
import { describe, it, expect } from "vitest";
import {
  decideMenuKey,
  parseShortcut,
  findShortcutTarget,
  shortcutMatches,
  type MenuGroupLike,
  type MenuKeyEvent,
} from "./menu-keys";

// 与 +page.svelte menuGroups 同构的夹具（accessKey 与小写字母匹配，忽略大小写）
const groups: MenuGroupLike[] = [
  {
    accessKey: "F",
    items: [
      { shortcut: "Ctrl+N" },
      { shortcut: "Ctrl+O" },
      { shortcut: "Ctrl+S" },
      { shortcut: "Ctrl+," },
      { shortcut: "Ctrl+P" },
    ],
  },
  { accessKey: "V", items: [{}, {}, {}] },
  { accessKey: "H", items: [{}] },
];

/** 构造按键事件（默认无修饰键、非重复） */
function press(init: Partial<MenuKeyEvent> & { key: string }): MenuKeyEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...init,
  };
}

function state(selectedIndex: number | null): { selectedIndex: number | null; groups: MenuGroupLike[] } {
  return { selectedIndex, groups };
}

describe("decideMenuKey：Alt 选中态切换", () => {
  it("未选中时按 Alt → 选中（selected=false 表示切换目标为选中）", () => {
    expect(decideMenuKey(press({ key: "Alt" }), state(null))).toEqual({
      type: "alt-toggle",
      selected: false,
    });
  });

  it("已选中时按 Alt → 取消选中", () => {
    expect(decideMenuKey(press({ key: "Alt" }), state(0))).toEqual({
      type: "alt-toggle",
      selected: true,
    });
  });

  it("长按 Alt 的重复 keydown 不响应", () => {
    expect(decideMenuKey(press({ key: "Alt", repeat: true }), state(null))).toEqual({
      type: "ignored",
    });
    expect(decideMenuKey(press({ key: "Alt", repeat: true }), state(0))).toEqual({
      type: "ignored",
    });
  });
});

describe("decideMenuKey：未选中态", () => {
  it("普通按键一律忽略", () => {
    for (const key of ["a", "1", ",", " ", "Tab", "Escape", "ArrowRight", "Enter"]) {
      expect(decideMenuKey(press({ key }), state(null))).toEqual({ type: "ignored" });
    }
  });

  it("组合键在未选中态也触发菜单快捷键（全局生效）", () => {
    expect(decideMenuKey(press({ key: "s", ctrlKey: true }), state(null))).toEqual({
      type: "shortcut",
      group: 0,
      item: 2,
    });
  });
});

describe("decideMenuKey：accessKey 跳转与展开", () => {
  it("字母跳转到对应分类（大小写不敏感）", () => {
    expect(decideMenuKey(press({ key: "f" }), state(1))).toEqual({
      type: "accesskey",
      index: 0,
      expand: false,
    });
    expect(decideMenuKey(press({ key: "H" }), state(1))).toEqual({
      type: "accesskey",
      index: 2,
      expand: false,
    });
  });

  it("按当前已选中分类的字母 → 直接展开", () => {
    expect(decideMenuKey(press({ key: "F" }), state(0))).toEqual({
      type: "accesskey",
      index: 0,
      expand: true,
    });
  });
});

describe("decideMenuKey：菜单导航键（选中态）", () => {
  it("空格 / Enter → toggle（展开收起由 MenuBar 依据 openIndex 执行）", () => {
    expect(decideMenuKey(press({ key: " " }), state(0))).toEqual({ type: "toggle" });
    expect(decideMenuKey(press({ key: "Enter" }), state(0))).toEqual({ type: "toggle" });
  });

  it("Escape → escape（先收起还是退出由 MenuBar 依据 openIndex 执行）", () => {
    expect(decideMenuKey(press({ key: "Escape" }), state(0))).toEqual({ type: "escape" });
  });

  it("Tab / → → next；← → prev", () => {
    expect(decideMenuKey(press({ key: "Tab" }), state(0))).toEqual({ type: "next" });
    expect(decideMenuKey(press({ key: "ArrowRight" }), state(0))).toEqual({ type: "next" });
    expect(decideMenuKey(press({ key: "ArrowLeft" }), state(0))).toEqual({ type: "prev" });
  });
});

describe("decideMenuKey：#2 非菜单键退出选择", () => {
  it("数字、标点、非 accessKey 字母 → exit", () => {
    for (const key of ["1", "9", ",", ".", "/", "z", "Q", "Backspace"]) {
      expect(decideMenuKey(press({ key }), state(0))).toEqual({ type: "exit" });
    }
  });

  it("重复按键同样按退出处理（退出由 MenuBar 侧的状态清空保证幂等）", () => {
    expect(decideMenuKey(press({ key: "x", repeat: true }), state(1))).toEqual({ type: "exit" });
  });
});

describe("decideMenuKey：#3 Ctrl/Meta 组合键", () => {
  it("命中菜单项快捷键 → shortcut，优先于退出判断（选中态下也不退出）", () => {
    expect(decideMenuKey(press({ key: "s", ctrlKey: true }), state(1))).toEqual({
      type: "shortcut",
      group: 0,
      item: 2,
    });
    // Ctrl+,（设置）：标点键原样匹配
    expect(decideMenuKey(press({ key: ",", ctrlKey: true }), state(1))).toEqual({
      type: "shortcut",
      group: 0,
      item: 3,
    });
    // 大写字母键（Shift 未按下时的 CapsLock 场景）同样命中
    expect(decideMenuKey(press({ key: "N", ctrlKey: true }), state(1))).toEqual({
      type: "shortcut",
      group: 0,
      item: 0,
    });
  });

  it("Meta（Cmd）同样触发（macOS）", () => {
    expect(decideMenuKey(press({ key: "p", metaKey: true }), state(1))).toEqual({
      type: "shortcut",
      group: 0,
      item: 4,
    });
  });

  it("Shift 修饰视为不同快捷键：Ctrl+Shift+S 不命中、不退出", () => {
    expect(decideMenuKey(press({ key: "S", ctrlKey: true, shiftKey: true }), state(1))).toEqual({
      type: "ignored",
    });
  });

  it("Alt 修饰的组合键不命中快捷键", () => {
    expect(decideMenuKey(press({ key: "s", ctrlKey: true, altKey: true }), state(1))).toEqual({
      type: "ignored",
    });
  });

  it("未命中任何菜单项的组合键 → ignored，不退出选择", () => {
    expect(decideMenuKey(press({ key: "k", ctrlKey: true }), state(1))).toEqual({ type: "ignored" });
    expect(decideMenuKey(press({ key: "k", ctrlKey: true }), state(null))).toEqual({
      type: "ignored",
    });
  });

  it("长按组合键的重复 keydown 不重复触发动作", () => {
    expect(decideMenuKey(press({ key: "s", ctrlKey: true, repeat: true }), state(1))).toEqual({
      type: "ignored",
    });
  });
});

describe("parseShortcut", () => {
  it("解析 'Ctrl+X' 为归一化小写键", () => {
    expect(parseShortcut("Ctrl+N")).toEqual({ key: "n" });
    expect(parseShortcut("Ctrl+P")).toEqual({ key: "p" });
  });

  it("标点键原样保留（Ctrl+, → ','）", () => {
    expect(parseShortcut("Ctrl+,")).toEqual({ key: "," });
  });

  it("非 Ctrl+ 形式返回 null（暂不支持，避免误匹配）", () => {
    expect(parseShortcut("N")).toBeNull();
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("Ctrl+")).toBeNull();
    expect(parseShortcut("Ctrl++")).toEqual({ key: "+" }); // Ctrl++：加号本身
  });
});

describe("findShortcutTarget / shortcutMatches", () => {
  it("按菜单顺序返回第一命中项", () => {
    expect(findShortcutTarget(groups, press({ key: "n", ctrlKey: true }))).toEqual({
      group: 0,
      item: 0,
    });
    expect(findShortcutTarget(groups, press({ key: "o", metaKey: true }))).toEqual({
      group: 0,
      item: 1,
    });
  });

  it("无命中返回 null", () => {
    expect(findShortcutTarget(groups, press({ key: "z", ctrlKey: true }))).toBeNull();
    expect(findShortcutTarget(groups, press({ key: "s" }))).toBeNull(); // 无 Ctrl 修饰
    expect(findShortcutTarget([{ items: [] }], press({ key: "n", ctrlKey: true }))).toBeNull();
  });

  it("shortcutMatches 要求 Ctrl/Meta 且无 Shift/Alt 修饰", () => {
    const parsed = parseShortcut("Ctrl+S")!;
    expect(parsed).not.toBeNull();
    expect(shortcutMatches(parsed, press({ key: "s", ctrlKey: true }))).toBe(true);
    expect(shortcutMatches(parsed, press({ key: "S", metaKey: true }))).toBe(true);
    expect(shortcutMatches(parsed, press({ key: "s", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(shortcutMatches(parsed, press({ key: "s", ctrlKey: true, altKey: true }))).toBe(false);
    expect(shortcutMatches(parsed, press({ key: "s" }))).toBe(false);
  });
});
