import { describe, expect, it } from "vitest";
import { parseListItem, planListBackspace } from "./list-structure";

/** 把计划应用到文档上（与 keymap 里的 dispatch 同一语义，便于断言结果文本与光标） */
function apply(doc: string, pos: number) {
  const plan = planListBackspace(doc, pos);
  if (!plan) return null;
  const after = doc.slice(0, plan.from) + plan.insert + doc.slice(plan.to);
  return { doc: after, caret: plan.caret, plan };
}

describe("parseListItem", () => {
  it("认出顶格 / 缩进的列表项，并切出标记与正文", () => {
    const doc = "- 甲\n  + 乙丙\n";
    const first = parseListItem(doc, 1);
    expect(first).toMatchObject({
      lineFrom: 0,
      lineTo: 3,
      indent: "",
      markerFrom: 0,
      markerTo: 1,
      bodyFrom: 2,
      body: "甲",
      bodyEmpty: false,
      nested: false,
    });
    const second = parseListItem(doc, 8);
    expect(second).toMatchObject({
      lineFrom: 4,
      markerFrom: 6,
      markerTo: 7,
      bodyFrom: 8,
      body: "乙丙",
      nested: true,
    });
  });

  it("`-乙` / 普通正文 / 缩进但没有标记的行都不算列表项", () => {
    expect(parseListItem("-乙\n", 1)).toBeNull();
    expect(parseListItem("普通正文\n", 2)).toBeNull();
    expect(parseListItem("  缩进正文\n", 3)).toBeNull();
    // 空项（标记 + 空白 + 什么都没有）算列表项，且 bodyEmpty
    expect(parseListItem("- \n", 2)).toMatchObject({ bodyEmpty: true, body: "" });
    expect(parseListItem("-   \n", 2)).toMatchObject({ bodyEmpty: true });
  });
});

describe("planListBackspace", () => {
  it("嵌套项：先反嵌套一层（与 Shift+Tab 同一语义），光标跟着走", () => {
    // "甲\n  - 乙\n"：第二行 lineFrom=2、indent=[2,4)、marker=[4,5)、bodyFrom=6
    expect(apply("甲\n  - 乙\n", 6)).toMatchObject({ doc: "甲\n- 乙\n", caret: 4 });
    // 6 空格缩进按一次只去掉一档（4 空格），剩 2 空格 —— 与 Shift+Tab 实测一致
    expect(apply("甲\n      - 乙\n", 10)).toMatchObject({ doc: "甲\n  - 乙\n", caret: 6 });
    // 光标停在缩进里（不是正文处）也照样反嵌套
    expect(apply("甲\n  - 乙\n", 2)).toMatchObject({ doc: "甲\n- 乙\n", caret: 2 });
  });

  it("空项：整条标记抹掉，留一个空段落（不留下孤立的 `-`）", () => {
    expect(apply("- 甲\n- \n", 6)).toMatchObject({ doc: "- 甲\n\n", caret: 4 });
    expect(apply("- 甲\n-   \n", 8)).toMatchObject({ doc: "- 甲\n\n", caret: 4 });
    // 嵌套的空项也**先反嵌套**（第二次退格才抹掉），与上面的规则顺序一致
    expect(apply("甲\n   -   \n", 5)).toMatchObject({ doc: "甲\n-   \n", caret: 2 });
  });

  it("行首退格：并进上一行（标记与换行一起消掉）", () => {
    expect(apply("- 甲\n- 乙\n", 4)).toMatchObject({ doc: "- 甲乙\n", caret: 3 });
    // 上一行不是列表项也照并（与 Typora「退格并入上一块」一致）
    expect(apply("正文\n- 乙\n", 3)).toMatchObject({ doc: "正文乙\n", caret: 2 });
    // 文档第一行没有上一行 → 退成普通段落
    expect(apply("- 乙\n", 0)).toMatchObject({ doc: "乙\n", caret: 0 });
  });

  it("体首 / 标记区内退格：去掉标记，正文退成普通段落", () => {
    expect(apply("- 甲\n- 乙\n", 6)).toMatchObject({ doc: "- 甲\n乙\n", caret: 4 });
    // 光标在标记与空白之间也算"取消列表"
    expect(apply("- 甲\n- 乙\n", 5)).toMatchObject({ doc: "- 甲\n乙\n", caret: 4 });
  });

  it("正文里退格不动结构（交回默认）", () => {
    expect(apply("- 甲乙\n", 5)).toBeNull();
    expect(apply("普通正文\n", 3)).toBeNull();
    expect(apply("-乙\n", 1)).toBeNull();
  });
});
