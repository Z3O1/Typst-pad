// 列表结构化退格的纯决策：四种动作（反嵌套 / 空项 / 行首并项 / 体首退成段落）逐条断言。
// 按键接线在 `editor-keymap.test.ts`，这里只锁纯函数结果（区间、插入文本、光标）。
import { describe, it, expect } from "vitest";
import { parseListItem, planListBackspace } from "./list-structure";

/** 用 `|` 标出光标位置，省得手数偏移 */
function plan(source: string, unit = "  ") {
  const pos = source.indexOf("|");
  const doc = source.slice(0, pos) + source.slice(pos + 1);
  const edit = planListBackspace(doc, pos, unit);
  if (!edit) return null;
  const out = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to);
  return { ...edit, out, caretOut: edit.caret, doc };
}

describe("parseListItem", () => {
  it("认出三种标记：- / + / 1.，标记后必须有空白", () => {
    expect(parseListItem("- 甲", 0)).toMatchObject({ body: "甲", bodyEmpty: false, nested: false });
    expect(parseListItem("+ 甲", 0)).toMatchObject({ body: "甲" });
    expect(parseListItem("3. 甲", 0)).toMatchObject({ body: "甲" });
    // `-乙` 不是标记（Typst 需要标记后的空白）
    expect(parseListItem("-乙", 0)).toBeNull();
    expect(parseListItem("正文", 0)).toBeNull();
  });

  it("切出缩进与各段位置，嵌套项带 nested", () => {
    const item = parseListItem("  - 甲", 4)!;
    expect(item).toMatchObject({
      lineFrom: 0,
      lineTo: 5,
      indent: "  ",
      markerFrom: 2,
      markerTo: 3,
      bodyFrom: 4,
      body: "甲",
      nested: true,
    });
  });

  it("空项（标记后有空白、正文为空）算 bodyEmpty", () => {
    expect(parseListItem("- ", 2)).toMatchObject({ bodyEmpty: true, body: "" });
    expect(parseListItem("-   ", 4)).toMatchObject({ bodyEmpty: true });
  });
});

describe("planListBackspace", () => {
  it("正文里（标记之后）交回默认退格", () => {
    expect(plan("- 甲乙|")).toBeNull();
    expect(plan("  - 甲乙|")).toBeNull();
  });

  it("体首：去掉标记，正文退成普通段落", () => {
    expect(plan("- |甲乙")!.out).toBe("甲乙");
  });

  it("嵌套项：先反嵌套一档（与 Tab 一档对称）", () => {
    // 两空格一档 → 退掉两格，仍是列表项
    expect(plan("  - |甲")!.out).toBe("- 甲");
    // 一档 4 空格时，6 格缩进退到 2 格
    expect(plan("      - |甲", "    ")!.out).toBe("  - 甲");
    // 行首制表符整只删
    expect(plan("\t- |甲", "    ")!.out).toBe("- 甲");
  });

  it("空项：整条抹掉，留一个空段落", () => {
    expect(plan("甲\n- |")).toEqual(expect.objectContaining({ out: "甲\n" }));
    expect(plan("甲\n+ |\n乙")).toEqual(expect.objectContaining({ out: "甲\n\n乙" }));
  });

  it("行首（标记之前）：并进上一行", () => {
    expect(plan("甲\n|- 乙")!.out).toBe("甲乙");
    expect(plan("甲\n|- 乙")!.caret).toBe(1);
    // 文档第一行没有上一行 → 只去掉标记
    expect(plan("|- 乙")!.out).toBe("乙");
  });

  it("显式编号列表同样按结构处理", () => {
    expect(plan("3. |甲")!.out).toBe("甲");
    expect(plan("甲\n|- 乙")!.out).toBe("甲乙");
  });
});
