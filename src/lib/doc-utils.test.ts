// doc-utils 空文档判断纯函数单元测试（关闭确认弹窗的前置判断逻辑）
import { describe, it, expect } from "vitest";
import { isBlankDoc } from "./doc-utils";

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
