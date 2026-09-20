// doc-utils：空文档判断 / 实际未保存修改判断 / 路径取文件名 / 前缀规范化纯函数单元测试
// （关闭确认弹窗的前置判断逻辑 + 窗口标题用的文件名 + 编译前缀补尾随换行）
import { describe, it, expect } from "vitest";
import { isBlankDoc, isEffectiveDirty, ensureTrailingNewline, fileNameOf } from "./doc-utils";

describe("isBlankDoc", () => {
  it("空字符串：视为空文档", () => {
    expect(isBlankDoc("")).toBe(true);
  });

  it("仅空白字符：视为空文档（空格/制表符/换行/回车）", () => {
    expect(isBlankDoc("   ")).toBe(true);
    expect(isBlankDoc("\t")).toBe(true);
    expect(isBlankDoc("\n")).toBe(true);
    expect(isBlankDoc(" \t\n\r ")).toBe(true);
  });

  it("有可见内容：非空文档", () => {
    expect(isBlankDoc("Hello")).toBe(false);
    expect(isBlankDoc(" 你好 ")).toBe(false);
    expect(isBlankDoc("#set page(margin: 2cm)")).toBe(false);
  });

  it("空白字符夹带可见内容：非空文档", () => {
    expect(isBlankDoc("\nHello\n")).toBe(false);
    expect(isBlankDoc("  \t Typst  \n")).toBe(false);
  });

  it("全角空格（U+3000）：属于 ECMAScript trim 的 WhiteSpace 集合，视为空文档", () => {
    expect(isBlankDoc("　")).toBe(true); // "　".trim() === ""，与 doc.trim().length === 0 的定义一致
  });
});

describe("isEffectiveDirty", () => {
  it("dirty 且内容为空：视为未修改（输入过又删光，无可丢失内容）", () => {
    expect(isEffectiveDirty(true, "")).toBe(false);
  });

  it("dirty 且仅空白字符：视为未修改（空格/制表符/换行/回车）", () => {
    expect(isEffectiveDirty(true, "   ")).toBe(false);
    expect(isEffectiveDirty(true, "\t\n ")).toBe(false);
    expect(isEffectiveDirty(true, "　")).toBe(false);
  });

  it("dirty 且有可见内容：视为有未保存修改", () => {
    expect(isEffectiveDirty(true, "Hello")).toBe(true);
    expect(isEffectiveDirty(true, " 你好 ")).toBe(true);
    expect(isEffectiveDirty(true, "\n#set page(margin: 2cm)\n")).toBe(true);
  });

  it("非 dirty：无论内容如何均视为未修改", () => {
    expect(isEffectiveDirty(false, "")).toBe(false);
    expect(isEffectiveDirty(false, "   ")).toBe(false);
    expect(isEffectiveDirty(false, "Hello")).toBe(false);
  });
});

describe("ensureTrailingNewline", () => {
  it("空字符串：原样返回", () => {
    expect(ensureTrailingNewline("")).toBe("");
  });

  it("已以 \\n 结尾：原样返回（单行/多行/纯换行）", () => {
    expect(ensureTrailingNewline("#set text(14pt)\n")).toBe("#set text(14pt)\n");
    expect(ensureTrailingNewline("// 注释\n#set text(14pt)\n")).toBe("// 注释\n#set text(14pt)\n");
    expect(ensureTrailingNewline("\n")).toBe("\n");
  });

  it("不带 \\n 结尾：末尾补一个 \\n（单行）", () => {
    expect(ensureTrailingNewline("// 注释")).toBe("// 注释\n");
    expect(ensureTrailingNewline("#set text(14pt)")).toBe("#set text(14pt)\n");
  });

  it("多行但末尾无 \\n：只在最末补一个 \\n，不触碰中间内容", () => {
    expect(ensureTrailingNewline("// 注释\n#set text(14pt)")).toBe("// 注释\n#set text(14pt)\n");
  });

  it("幂等性：对已规范化的输入再调用结果不变", () => {
    const once = ensureTrailingNewline("// 注释");
    expect(ensureTrailingNewline(once)).toBe(once);
    expect(ensureTrailingNewline(ensureTrailingNewline(""))).toBe("");
    expect(ensureTrailingNewline(ensureTrailingNewline("x\n"))).toBe("x\n");
  });
});

describe("fileNameOf", () => {
  it("Windows / Unix 路径都取最后一段；没有分隔符就原样返回", () => {
    expect(fileNameOf("C:\\Users\\me\\论文.typ")).toBe("论文.typ");
    expect(fileNameOf("/home/me/论文.typ")).toBe("论文.typ");
    expect(fileNameOf("未命名.typ")).toBe("未命名.typ");
  });

  it("取不到名字（路径以分隔符结尾、空串、只有分隔符）时返回空串，不抛异常", () => {
    expect(fileNameOf("/home/me/")).toBe("");
    expect(fileNameOf("C:\\Users\\")).toBe("");
    expect(fileNameOf("")).toBe("");
    expect(fileNameOf("/")).toBe("");
  });

  it("混合分隔符与重复分隔符也取最后一段", () => {
    expect(fileNameOf("C:/Users\\me/a.typ")).toBe("a.typ");
    expect(fileNameOf("/a//b.typ")).toBe("b.typ");
  });
});
