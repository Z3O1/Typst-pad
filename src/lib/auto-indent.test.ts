// auto-indent 单元测试：回车换行时新行该带多少缩进（纯逻辑，无 DOM）。
// 回归背景：用户报「换行时应该和上一行缩进一样」——CM 默认的 insertNewlineAndIndent
// 在 typst 文档里时灵时不灵（见 auto-indent.ts 顶部注释）。
import { describe, it, expect } from "vitest";
import { indentForNewLine, isBlankLine } from "./auto-indent";

describe("indentForNewLine（新行沿用上一行缩进）", () => {
  it("光标在行尾：整行前导空白照抄", () => {
    expect(indentForNewLine("  缩进行", 5)).toBe("  ");
    expect(indentForNewLine("    深缩进", 7)).toBe("    ");
    expect(indentForNewLine("\tTab 缩进", 7)).toBe("\t");
    // 行间公式脚手架（两空格）与列表嵌套（两空格 + 标记）一样照抄
    expect(indentForNewLine("  - 二级", 6)).toBe("  ");
    expect(indentForNewLine("$ 1 $", 5)).toBe("");
  });

  it("没有缩进 / 空行文档：就是普通换行（不多插空格）", () => {
    expect(indentForNewLine("普通文本", 4)).toBe("");
    expect(indentForNewLine("", 0)).toBe("");
  });

  it("光标停在缩进内部：只取光标左边那一段，不凭空多出右边的空格", () => {
    expect(indentForNewLine("    code", 2)).toBe("  ");
    expect(indentForNewLine("    code", 0)).toBe("");
    expect(indentForNewLine("    code", 4)).toBe("    ");
  });

  it("光标停在正文中间：仍按整行缩进（换行后正文跟着对齐）", () => {
    expect(indentForNewLine("  abcdef", 5)).toBe("  ");
  });

  it("行内空格不算缩进（只认行首）", () => {
    expect(indentForNewLine("abc  def", 7)).toBe("");
    expect(indentForNewLine("abc  def", 3)).toBe("");
  });

  it("纯空白行不续缩进：连按回车不会堆出一串带缩进的空行", () => {
    expect(indentForNewLine("  ", 2)).toBe("");
    expect(indentForNewLine("", 0)).toBe("");
    expect(indentForNewLine("\t ", 2)).toBe("");
    expect(indentForNewLine("　", 1)).toBe(""); // 全角空格：不算缩进，也不是内容
  });
});

describe("isBlankLine（纯空白行判定）", () => {
  it("只有空白 → true（换行时顺手清掉这串残留空白）", () => {
    expect(isBlankLine("")).toBe(true);
    expect(isBlankLine("   ")).toBe(true);
    expect(isBlankLine("\t")).toBe(true);
  });

  it("有内容 → false（哪怕是公式脚手架、列表标记）", () => {
    expect(isBlankLine("x")).toBe(false);
    expect(isBlankLine("  - 二级")).toBe(false);
    expect(isBlankLine("$ 1 $")).toBe(false);
  });
});
