// 写作模式格式命令的单元测试：包装 / 行首标记 / 行间公式 / 代码块 / 链接。
// 这些是"格式菜单 + 快捷键"的全部语义，UI 只负责把 EditPlan 落成事务。
import { describe, it, expect } from "vitest";
import {
  planForCommand,
  planWrap,
  planLinePrefix,
  planBlockMath,
  planCodeBlock,
  planLink,
} from "./write-commands";
import type { EditPlan } from "./write-commands";

/** 应用 EditPlan 到文档（模拟 CodeMirror 事务），返回新文档与选区 */
function apply(doc: string, plan: EditPlan) {
  const next = doc.slice(0, plan.from) + plan.insert + doc.slice(plan.to);
  return { doc: next, selected: next.slice(plan.anchor, plan.head ?? plan.anchor) };
}

describe("planWrap 包装", () => {
  it("有选区：两侧加定界符，选区盖住原内容", () => {
    const doc = "这是重点内容";
    const plan = planWrap(doc, 2, 4, "*");
    expect(apply(doc, plan).doc).toBe("这是*重点*内容");
    expect(apply(doc, plan).selected).toBe("重点");
  });

  it("无选区：插入成对定界符，光标落在中间", () => {
    const doc = "abc";
    const plan = planWrap(doc, 1, 1, "*");
    expect(apply(doc, plan).doc).toBe("a**bc");
    expect(plan.anchor).toBe(2);
  });

  it("选区已含定界符：再包一次是取消（切换语义）", () => {
    const doc = "这是*重点*内容";
    const plan = planWrap(doc, 2, 6, "*");
    expect(apply(doc, plan).doc).toBe("这是重点内容");
  });

  it("选区紧贴在定界符内侧：去掉外层定界符，不产生 `**`", () => {
    const doc = "这是*重点*内容";
    // 选中 `重点`（不含星号）
    const plan = planWrap(doc, 3, 5, "*");
    expect(apply(doc, plan).doc).toBe("这是重点内容");
    expect(apply(doc, plan).selected).toBe("重点");
  });

  it("不同定界符（斜体/行内代码/自定义前后缀）", () => {
    expect(apply("x", planWrap("x", 0, 1, "_")).doc).toBe("_x_");
    expect(apply("x", planWrap("x", 0, 1, "`")).doc).toBe("`x`");
    expect(apply("x", planWrap("x", 0, 1, "#strike[", "]")).doc).toBe("#strike[x]");
  });
});

describe("planLinePrefix 行首标记", () => {
  it("标题：整行前加 `= `", () => {
    const doc = "标题文字\n第二行";
    const plan = planLinePrefix(doc, 1, "= ");
    expect(apply(doc, plan).doc).toBe("= 标题文字\n第二行");
    // 光标跟随右移
    expect(plan.anchor).toBe(3);
  });

  it("标题级别互相替换（`= ` → `=== `）", () => {
    const doc = "= 标题\n";
    expect(apply(doc, planLinePrefix(doc, 3, "=== ")).doc).toBe("=== 标题\n");
  });

  it("同族标记再点一次 = 取消（切换语义）", () => {
    const doc = "- 列表项\n";
    expect(apply(doc, planLinePrefix(doc, 3, "- ")).doc).toBe("列表项\n");
  });

  it("不同族标记不会互相取消：列表 → 标题是替换", () => {
    const doc = "- 列表项\n";
    expect(apply(doc, planLinePrefix(doc, 3, "= ")).doc).toBe("= 列表项\n");
  });

  it("保留缩进；正文（空前缀）清掉任何标记", () => {
    const doc = "  - 缩进的列表项\n";
    expect(apply(doc, planLinePrefix(doc, 5, "= ")).doc).toBe("  = 缩进的列表项\n");
    // 正文：清掉任何行首标记但保留缩进
    expect(apply(doc, planLinePrefix(doc, 5, "")).doc).toBe("  缩进的列表项\n");
    expect(apply("  =  标题\n", planLinePrefix("  =  标题\n", 4, "")).doc).toBe("  标题\n");
  });

  it("在多行文档里只改光标所在行", () => {
    const doc = "第一行\n第二行\n第三行";
    const pos = doc.indexOf("第二行") + 1;
    expect(apply(doc, planLinePrefix(doc, pos, "== ")).doc).toBe("第一行\n== 第二行\n第三行");
  });
});

describe("planBlockMath / planCodeBlock", () => {
  it("行间公式（无选区）：整行成为公式体，不死吞内容", () => {
    const doc = "前文\n后文";
    const plan = planBlockMath(doc, 0);
    expect(apply(doc, plan).doc).toBe("$\n  前文\n$\n\n后文");
    expect(plan.anchor).toBe(3); // `$\n  ` 之后
  });

  it("行间公式（有选区）：只替换选区，行内其它文字保留", () => {
    const doc = "前 frac(a,b) 后";
    const plan = planBlockMath(doc, 2, 11);
    expect(apply(doc, plan).doc).toBe("前 $\n  frac(a,b)\n$\n 后");
  });

  it("行间公式：空行插入后光标在公式体里，可直接输入", () => {
    const doc = "前文\n\n";
    const plan = planBlockMath(doc, 3);
    // 文档末尾原本那个换行保留 → 公式后还有一个空行
    expect(apply(doc, plan).doc).toBe("前文\n$\n  \n$\n\n");
    expect(apply(doc, plan).selected).toBe("");
  });

  it("代码块：``` 围栏 + 语言标记，选中代码内容便于直接改写", () => {
    // 无选区：整行成为代码块内容
    const plan = planCodeBlock("let a = 1\n后", 0);
    expect(apply("let a = 1\n后", plan).doc).toBe("```typ\nlet a = 1\n```\n\n后");
    expect(apply("let a = 1\n后", plan).selected).toBe("let a = 1");
  });
});

describe("planLink 链接", () => {
  it("有选区：选区成为链接文字", () => {
    // 下标按 UTF-16 计：见[0] 空格[1] 官[2] 网[3] 空格[4] 说[5] 明[6]
    const doc = "见 官网 说明";
    const plan = planLink(doc, 2, 4, "https://typst.app");
    const out = apply(doc, plan).doc;
    expect(out).toBe('见 #link("https://typst.app")[官网] 说明');
    expect(plan.head! - plan.anchor).toBe(2); // 选中"官网"，便于直接改写文字
  });

  it("无选区：插入占位文字并选中它", () => {
    const plan = planLink("", 0, 0);
    expect(plan.insert).toBe('#link("https://")[文字]');
    expect(plan.head! - plan.anchor).toBe(2);
  });
});

describe("planForCommand 命令映射", () => {
  const doc = "内容";
  it("每个命令都有对应的编辑方案", () => {
    const commands = [
      "bold",
      "italic",
      "code",
      "strike",
      "heading1",
      "heading2",
      "heading3",
      "body",
      "bullet",
      "ordered",
      "quote",
      "math-inline",
      "math-block",
      "code-block",
      "link",
    ] as const;
    for (const command of commands) {
      const plan = planForCommand(doc, 0, 2, command);
      expect(plan.from, command).toBeGreaterThanOrEqual(0);
      expect(plan.to, command).toBeGreaterThanOrEqual(plan.from);
      expect(plan.anchor, command).toBeGreaterThanOrEqual(0);
    }
  });

  it("常用命令的结果文档", () => {
    expect(apply("内容", planForCommand("内容", 0, 2, "bold")).doc).toBe("*内容*");
    expect(apply("内容", planForCommand("内容", 0, 2, "italic")).doc).toBe("_内容_");
    expect(apply("内容", planForCommand("内容", 0, 2, "math-inline")).doc).toBe("$内容$");
    expect(apply("内容", planForCommand("内容", 0, 2, "heading2")).doc).toBe("== 内容");
    expect(apply("内容", planForCommand("内容", 0, 2, "bullet")).doc).toBe("- 内容");
    expect(apply("内容", planForCommand("内容", 0, 2, "ordered")).doc).toBe("+ 内容");
    // 引用是 Typst 的 #quote(block: true)[...]，不是 Markdown 的 `>`
    expect(apply("内容", planForCommand("内容", 0, 2, "quote")).doc).toBe(
      "#quote(block: true)[\n  内容\n]\n",
    );
  });

  it("无选区时块级命令取当前行内容（不丢已写的内容）", () => {
    // 光标在第 1 行行首，无选区
    expect(
      apply("x^2 + y^2\n后文", planForCommand("x^2 + y^2\n后文", 0, 0, "math-block")).doc,
    ).toBe("$\n  x^2 + y^2\n$\n\n后文");
    expect(
      apply("前\nlet a = 1\n", planForCommand("前\nlet a = 1\n", 3, 3, "code-block")).doc,
    ).toBe("前\n```typ\nlet a = 1\n```\n\n");
  });

  it("有选区时块级命令只替换选区（行内其它文字保留）", () => {
    const doc = "前 frac(a,b) 后";
    expect(apply(doc, planForCommand(doc, 2, 11, "math-block")).doc).toBe(
      "前 $\n  frac(a,b)\n$\n 后",
    );
  });
});

describe("planWrap 首尾空白处理", () => {
  it("选区含末尾换行时，换行留在定界符外侧（否则变成跨行强调）", () => {
    // Ctrl+A 选到全文（含末尾换行）后按 Ctrl+B 的实际情况
    const doc = "要加粗的文字\n";
    const plan = planWrap(doc, 0, doc.length, "*");
    expect(apply(doc, plan).doc).toBe("*要加粗的文字*\n");
    expect(apply(doc, plan).selected).toBe("要加粗的文字");
  });

  it("前后空格同样留在外侧（`* 文字 *` 在 typst 里不是粗体）", () => {
    const doc = "  内容  ";
    const plan = planWrap(doc, 0, doc.length, "*");
    expect(apply(doc, plan).doc).toBe("  *内容*  ");
  });

  it("全是空白时不加定界符（没有可加粗的正文）", () => {
    const doc = "   ";
    const plan = planWrap(doc, 0, 3, "*");
    expect(apply(doc, plan).doc).toBe("*   *");
  });
});
