// 菜单表（+page.svelte 的 menuGroups()）单元测试
//
// 这张表是"用户唯一能看见的命令表"：快捷键文案、勾选态、命令映射都只在这里摆一次。
// 覆盖重点：
//  - 文件/格式/视图/帮助四组的结构（label / accessKey / 每项都有 action）
//  - 格式组的 label → WriteCommand 映射（写错命令名 = 菜单点了没反应，线上才会发现）
//  - 视图组的 checked 必须跟随 viewMode / showPreview / editorWrap / uiZoom / theme
//  - 红线回归：模式切换是 Ctrl+E（Ctrl+/ 归注释，不许回退）；带 Shift 的键只作灰字提示
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildMenuGroups,
  type MenuModelDeps,
  type MenuModelGroup,
  type MenuModelItem,
} from "./menu-model";
import type { WriteCommand } from "./write-commands";
import { ZOOM_DEFAULT } from "./zoom";

function makeDeps(over: Partial<MenuModelDeps> = {}): MenuModelDeps {
  return {
    viewMode: "write",
    showPreview: false,
    editorWrap: false,
    uiZoom: ZOOM_DEFAULT,
    theme: "system",
    onNew: vi.fn(),
    onNewWindow: vi.fn(),
    onOpen: vi.fn(),
    onSave: vi.fn(),
    onOpenSettings: vi.fn(),
    onExportPdf: vi.fn(),
    runFormat: vi.fn(),
    onToggleViewMode: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleWrap: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onResetZoom: vi.fn(),
    onSetTheme: vi.fn(),
    onCheckUpdates: vi.fn(),
    onShowAbout: vi.fn(),
    ...over,
  };
}

function group(groups: MenuModelGroup[], label: string): MenuModelGroup {
  const found = groups.find((g) => g.label === label);
  if (!found) throw new Error(`没有「${label}」这组菜单`);
  return found;
}

/** label → 菜单项（找不到就抛，免得断言在 undefined 上静默通过） */
function item(groups: MenuModelGroup[], groupLabel: string, itemLabel: string): MenuModelItem {
  const found = group(groups, groupLabel).items.find((i) => i.label === itemLabel);
  if (!found) throw new Error(`「${groupLabel}」里没有「${itemLabel}」`);
  return found;
}

function shortcutsOf(groups: MenuModelGroup[], label: string): Record<string, string | undefined> {
  return Object.fromEntries(group(groups, label).items.map((i) => [i.label, i.shortcut]));
}

describe("buildMenuGroups 结构", () => {
  let groups: MenuModelGroup[];
  beforeEach(() => {
    groups = buildMenuGroups(makeDeps());
  });

  it("四组菜单、顺序与 accessKey 固定", () => {
    expect(groups.map((g) => g.label)).toEqual(["文件", "格式", "视图", "帮助"]);
    expect(groups.map((g) => g.accessKey)).toEqual(["F", "O", "V", "H"]);
  });

  it("每一项都有非空 label 与可调用 action", () => {
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const i of g.items) {
        expect(typeof i.label).toBe("string");
        expect(i.label.length).toBeGreaterThan(0);
        expect(typeof i.action).toBe("function");
      }
    }
  });

  it("同一组内 label 不重复（重复就会有两个同名菜单项）", () => {
    for (const g of groups) {
      const labels = g.items.map((i) => i.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("有 shortcut 的项互不重复（复制粘贴菜单项时最容易撞）", () => {
    const all = groups.flatMap((g) => g.items.map((i) => i.shortcut).filter(Boolean));
    expect(new Set(all).size).toBe(all.length);
  });

  it("每组项数（改动菜单要同步改这里，防静默增删）", () => {
    expect(groups.map((g) => g.items.length)).toEqual([6, 14, 9, 2]);
  });
});

describe("文件菜单", () => {
  it("快捷键文案（Ctrl+Shift+N 只作灰字：匹配器不认 Shift，见注释）", () => {
    const groups = buildMenuGroups(makeDeps());
    expect(shortcutsOf(groups, "文件")).toEqual({
      新建: "Ctrl+N",
      新建窗口: "Ctrl+Shift+N",
      "打开…": "Ctrl+O",
      保存: "Ctrl+S",
      "设置…": "Ctrl+,",
      "导出 PDF…": "Ctrl+P",
    });
  });

  it("每项触发对应回调", () => {
    const deps = makeDeps();
    const groups = buildMenuGroups(deps);
    for (const i of group(groups, "文件").items) i.action();
    expect(deps.onNew).toHaveBeenCalledTimes(1);
    expect(deps.onNewWindow).toHaveBeenCalledTimes(1);
    expect(deps.onOpen).toHaveBeenCalledTimes(1);
    expect(deps.onSave).toHaveBeenCalledTimes(1);
    expect(deps.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(deps.onExportPdf).toHaveBeenCalledTimes(1);
  });
});

describe("格式菜单", () => {
  const COMMAND_BY_LABEL: Record<string, WriteCommand> = {
    加粗: "bold",
    斜体: "italic",
    行内代码: "code",
    行内公式: "math-inline",
    公式块: "math-block",
    "标题 1": "heading1",
    "标题 2": "heading2",
    "标题 3": "heading3",
    正文: "body",
    无序列表: "bullet",
    有序列表: "ordered",
    引用: "quote",
    代码块: "code-block",
    链接: "link",
  };

  it("label → WriteCommand 映射与顺序", () => {
    const groups = buildMenuGroups(makeDeps());
    expect(group(groups, "格式").items.map((i) => i.label)).toEqual(Object.keys(COMMAND_BY_LABEL));
  });

  it("每项把对应命令交给 runFormat", () => {
    const deps = makeDeps();
    const groups = buildMenuGroups(deps);
    for (const i of group(groups, "格式").items) i.action();
    expect((deps.runFormat as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(
      Object.values(COMMAND_BY_LABEL),
    );
  });

  it("快捷键文案", () => {
    const groups = buildMenuGroups(makeDeps());
    expect(shortcutsOf(groups, "格式")).toEqual({
      加粗: "Ctrl+B",
      斜体: "Ctrl+I",
      行内代码: "Ctrl+Shift+`",
      行内公式: "Ctrl+M",
      公式块: "Ctrl+Shift+M",
      "标题 1": "Ctrl+1",
      "标题 2": "Ctrl+2",
      "标题 3": "Ctrl+3",
      正文: "Ctrl+0",
      无序列表: "Ctrl+Shift+]",
      有序列表: "Ctrl+Shift+[",
      引用: "Ctrl+Shift+Q",
      代码块: "Ctrl+Shift+C",
      链接: "Ctrl+K",
    });
  });
});

describe("视图菜单", () => {
  it("勾选态跟随状态（默认态）", () => {
    const groups = buildMenuGroups(
      makeDeps({ viewMode: "write", showPreview: false, editorWrap: false, uiZoom: 1.5, theme: "dark" }),
    );
    expect(item(groups, "视图", "源代码模式").checked).toBe(false);
    expect(item(groups, "视图", "显示预览栏").checked).toBe(false);
    expect(item(groups, "视图", "自动换行").checked).toBe(false);
    expect(item(groups, "视图", "重置缩放").checked).toBe(false); // 1.5 ≠ 100%
    expect(item(groups, "视图", "主题：自动").checked).toBe(false);
    expect(item(groups, "视图", "主题：暗").checked).toBe(true);
    expect(item(groups, "视图", "主题：明").checked).toBe(false);
  });

  it("勾选态跟随状态（另一侧）", () => {
    const groups = buildMenuGroups(
      makeDeps({
        viewMode: "source",
        showPreview: true,
        editorWrap: true,
        uiZoom: ZOOM_DEFAULT,
        theme: "light",
      }),
    );
    expect(item(groups, "视图", "源代码模式").checked).toBe(true);
    expect(item(groups, "视图", "显示预览栏").checked).toBe(true);
    expect(item(groups, "视图", "自动换行").checked).toBe(true);
    expect(item(groups, "视图", "重置缩放").checked).toBe(true);
    expect(item(groups, "视图", "主题：明").checked).toBe(true);
  });

  it("缩放档位只要不是 100% 就不勾「重置缩放」", () => {
    for (const uiZoom of [0.5, 0.9, 1.1, 2.5]) {
      const groups = buildMenuGroups(makeDeps({ uiZoom }));
      expect(item(groups, "视图", "重置缩放").checked).toBe(false);
    }
  });

  it("每项触发对应回调（含主题三项各传各的值）", () => {
    const deps = makeDeps();
    const groups = buildMenuGroups(deps);
    item(groups, "视图", "源代码模式").action();
    item(groups, "视图", "显示预览栏").action();
    item(groups, "视图", "自动换行").action();
    item(groups, "视图", "放大").action();
    item(groups, "视图", "缩小").action();
    item(groups, "视图", "重置缩放").action();
    item(groups, "视图", "主题：自动").action();
    item(groups, "视图", "主题：暗").action();
    item(groups, "视图", "主题：明").action();
    expect(deps.onToggleViewMode).toHaveBeenCalledTimes(1);
    expect(deps.onTogglePreview).toHaveBeenCalledTimes(1);
    expect(deps.onToggleWrap).toHaveBeenCalledTimes(1);
    expect(deps.onZoomIn).toHaveBeenCalledTimes(1);
    expect(deps.onZoomOut).toHaveBeenCalledTimes(1);
    expect(deps.onResetZoom).toHaveBeenCalledTimes(1);
    expect((deps.onSetTheme as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      "system",
      "dark",
      "light",
    ]);
  });
});

describe("帮助菜单与红线回归", () => {
  it("帮助两项触发对应回调", () => {
    const deps = makeDeps();
    const groups = buildMenuGroups(deps);
    for (const i of group(groups, "帮助").items) i.action();
    expect(deps.onCheckUpdates).toHaveBeenCalledTimes(1);
    expect(deps.onShowAbout).toHaveBeenCalledTimes(1);
  });

  it("模式切换是 Ctrl+E，整张菜单里没有 Ctrl+/（那一按归注释，见注释里的踩坑）", () => {
    const groups = buildMenuGroups(makeDeps());
    expect(item(groups, "视图", "源代码模式").shortcut).toBe("Ctrl+E");
    const allShortcuts = groups.flatMap((g) => g.items.map((i) => i.shortcut ?? ""));
    expect(allShortcuts.some((s) => s.includes("Ctrl+/"))).toBe(false);
  });

  it("三处「只作灰字提示」的姿势还在（触发都在 handleKeydown，不在 MenuBar 匹配器里）", () => {
    const groups = buildMenuGroups(makeDeps());
    expect(item(groups, "文件", "新建窗口").shortcut).toBe("Ctrl+Shift+N");
    expect(item(groups, "视图", "自动换行").shortcut).toBe("Alt+Z");
    expect(item(groups, "视图", "放大").shortcut).toBe("Ctrl+滚轮 / Ctrl+Shift+=");
  });
});
