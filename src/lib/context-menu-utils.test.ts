// 自定义右键菜单纯逻辑模块的单测：
// 区域判定（resolveContextZone）、选区判定（editor/preview）、菜单项 enabled 计算、位置收边。
import { describe, it, expect } from "vitest";
import {
  resolveContextZone,
  editorSelectionHasContent,
  previewSelectionHasContent,
  buildContextMenuItems,
  computeMenuPosition,
  type ContextMenuItemSpec,
} from "./context-menu-utils";

/** 构造一段 DOM 片段，返回首个元素（jsdom 提供 closest/contains 语义） */
function makeElement(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

/** 从菜单条目中取指定命令的条目 */
function itemFor(
  items: ContextMenuItemSpec[],
  command: ContextMenuItemSpec["command"],
): ContextMenuItemSpec {
  const found = items.find((i) => i.command === command);
  if (!found) throw new Error(`未找到命令 ${command}`);
  return found;
}

describe("resolveContextZone 区域判定", () => {
  it("target 为 .cm-content 内部元素 → editor", () => {
    const content = makeElement(
      `<div class="cm-content"><span class="cm-line">abc</span></div>`,
    );
    const line = content.querySelector(".cm-line")!;
    expect(resolveContextZone(line)).toBe("editor");
  });

  it("target 为 .cm-content 祖先链上的 .editor-host 内元素（行号栏）→ editor", () => {
    const host = makeElement(
      `<div class="editor-host"><div class="cm-gutters"><div class="cm-gutterElement">1</div></div></div>`,
    );
    const gutter = host.querySelector(".cm-gutterElement")!;
    expect(resolveContextZone(gutter)).toBe("editor");
  });

  it("target 为 data-context-zone=preview 容器内元素 → preview", () => {
    const preview = makeElement(
      `<div data-context-zone="preview"><div class="preview-paper"><svg><text>hi</text></svg></div></div>`,
    );
    const text = preview.querySelector("text")!;
    expect(resolveContextZone(text)).toBe("preview");
  });

  it("其余区域（body/菜单栏/状态栏）→ other", () => {
    const bar = makeElement(`<div class="menubar"><button>文件</button></div>`);
    expect(resolveContextZone(bar)).toBe("other");
    expect(resolveContextZone(document.body)).toBe("other");
  });

  it("null 与非 Node target → other（防御）", () => {
    expect(resolveContextZone(null)).toBe("other");
    expect(resolveContextZone({} as EventTarget)).toBe("other");
  });
});

describe("editorSelectionHasContent 编辑器选区判定", () => {
  it("空选区 → false", () => {
    expect(editorSelectionHasContent({ empty: true })).toBe(false);
  });

  it("非空选区 → true", () => {
    expect(editorSelectionHasContent({ empty: false })).toBe(true);
  });

  it("null（编辑器不可用）→ false", () => {
    expect(editorSelectionHasContent(null)).toBe(false);
  });
});

describe("previewSelectionHasContent 预览选区判定", () => {
  const host = makeElement(`<div class="preview-paper"><svg><text>hello</text></svg></div>`);

  it("选区锚点落在预览容器内且非空 → true", () => {
    const anchor = host.querySelector("text")!;
    expect(
      previewSelectionHasContent(
        { isCollapsed: false, anchorNode: anchor },
        host,
      ),
    ).toBe(true);
  });

  it("空选区（isCollapsed）→ false", () => {
    const anchor = host.querySelector("text")!;
    expect(
      previewSelectionHasContent(
        { isCollapsed: true, anchorNode: anchor },
        host,
      ),
    ).toBe(false);
  });

  it("选区锚点在预览容器外（如编辑器内）→ false", () => {
    const outside = makeElement(`<div class="cm-content"><span>x</span></div>`);
    expect(
      previewSelectionHasContent(
        { isCollapsed: false, anchorNode: outside.querySelector("span") },
        host,
      ),
    ).toBe(false);
  });

  it("null 选区 / null 容器 → false", () => {
    expect(previewSelectionHasContent(null, host)).toBe(false);
    expect(
      previewSelectionHasContent({ isCollapsed: false, anchorNode: host }, null),
    ).toBe(false);
  });
});

describe("buildContextMenuItems 菜单项 enabled 计算", () => {
  it("编辑器有选区：剪切/复制可用，粘贴/全选始终可用", () => {
    const items = buildContextMenuItems("editor", true);
    expect(itemFor(items, "cut").disabled).toBe(false);
    expect(itemFor(items, "copy").disabled).toBe(false);
    expect(itemFor(items, "paste").disabled).toBe(false);
    expect(itemFor(items, "select-all").disabled).toBe(false);
  });

  it("编辑器无选区：剪切/复制置灰，粘贴/全选仍可用", () => {
    const items = buildContextMenuItems("editor", false);
    expect(itemFor(items, "cut").disabled).toBe(true);
    expect(itemFor(items, "copy").disabled).toBe(true);
    expect(itemFor(items, "paste").disabled).toBe(false);
    expect(itemFor(items, "select-all").disabled).toBe(false);
  });

  it("预览区：剪切/粘贴恒置灰", () => {
    const items = buildContextMenuItems("preview", true);
    expect(itemFor(items, "cut").disabled).toBe(true);
    expect(itemFor(items, "paste").disabled).toBe(true);
  });

  it("预览区有选区：复制可用；无选区：复制置灰；全选始终可用", () => {
    const withSel = buildContextMenuItems("preview", true);
    expect(itemFor(withSel, "copy").disabled).toBe(false);
    expect(itemFor(withSel, "select-all").disabled).toBe(false);
    const noSel = buildContextMenuItems("preview", false);
    expect(itemFor(noSel, "copy").disabled).toBe(true);
    expect(itemFor(noSel, "select-all").disabled).toBe(false);
  });

  it("应用操作（保存/导出 PDF/设置/打开）在两区均始终可用", () => {
    for (const zone of ["editor", "preview"] as const) {
      const items = buildContextMenuItems(zone, false);
      expect(itemFor(items, "save").disabled).toBe(false);
      expect(itemFor(items, "export-pdf").disabled).toBe(false);
      expect(itemFor(items, "settings").disabled).toBe(false);
      expect(itemFor(items, "open").disabled).toBe(false);
    }
  });

  it("编辑操作与应用操作之间有一条分隔线", () => {
    const items = buildContextMenuItems("editor", true);
    expect(items.some((i) => i.type === "separator")).toBe(true);
    const sepIndex = items.findIndex((i) => i.type === "separator");
    expect(items[sepIndex - 1].command).toBe("select-all");
    expect(items[sepIndex + 1].command).toBe("save");
  });

  it("菜单总条目数稳定：4 编辑项 + 1 分隔线 + 4 应用项", () => {
    expect(buildContextMenuItems("editor", true)).toHaveLength(9);
    expect(buildContextMenuItems("preview", false)).toHaveLength(9);
  });
});

describe("computeMenuPosition 视口收边", () => {
  it("视口内：菜单按鼠标坐标弹出", () => {
    expect(computeMenuPosition(100, 100, 160, 40, 800, 600)).toEqual({
      left: 100,
      top: 100,
    });
  });

  it("右缘越界：收回到视口内（保留 margin）", () => {
    // 800 - 160 - 4 = 636
    expect(computeMenuPosition(700, 100, 160, 40, 800, 600)).toEqual({
      left: 636,
      top: 100,
    });
  });

  it("底缘越界：收回到视口内（保留 margin）", () => {
    // 600 - 40 - 4 = 556
    expect(computeMenuPosition(100, 590, 160, 40, 800, 600)).toEqual({
      left: 100,
      top: 556,
    });
  });

  it("右下同时越界：两个方向都收边", () => {
    expect(computeMenuPosition(9999, 9999, 160, 40, 800, 600)).toEqual({
      left: 636,
      top: 556,
    });
  });

  it("菜单大于视口：贴边显示（下限 margin，不出现负坐标）", () => {
    // 菜单宽 900 > 视口 800：left 下限 4
    expect(computeMenuPosition(10, 10, 900, 40, 800, 600)).toEqual({
      left: 4,
      top: 10,
    });
    // 菜单高 700 > 视口 600：top 下限 4
    expect(computeMenuPosition(10, 10, 160, 700, 800, 600)).toEqual({
      left: 10,
      top: 4,
    });
  });
});
