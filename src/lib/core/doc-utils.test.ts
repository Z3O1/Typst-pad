// doc-utils：空文档判断 / 未保存修改判断 / 路径取文件名 / 前缀规范化纯函数单元测试
// （启动恢复的空白闸门 + 窗口标题圆点与各确认框共用的判据 + 窗口标题用的文件名 + 前缀补尾随换行）
import { describe, it, expect } from "vitest";
import {
  isBlankDoc,
  isDocModified,
  ensureTrailingNewline,
  fileNameOf,
  isTypPath,
  pickTypPath,
} from "./doc-utils";

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

describe("isDocModified", () => {
  it("正文与基线逐字符相同：未修改（改了又撤销回原样也走这条）", () => {
    expect(isDocModified("正文", "正文")).toBe(false);
    expect(isDocModified("", "")).toBe(false); // 未命名新文档：输入过又全删光 ⇒ 回到基线
    expect(isDocModified("  \n", "  \n")).toBe(false);
  });

  it("**打开有内容的文件再全选删光：仍是未保存修改**（空白不等于没改过，这是旧判据报错的那条）", () => {
    expect(isDocModified("", "磁盘上的正文")).toBe(true);
    expect(isDocModified("  \n\n", "磁盘上的正文")).toBe(true);
  });

  it("正文比基线多、少、改动：都算未保存修改", () => {
    expect(isDocModified("正文加一句", "正文")).toBe(true);
    expect(isDocModified("正", "正文")).toBe(true);
    expect(isDocModified("另起一段", "正文")).toBe(true);
  });

  it("基线为 `null`（存档恢复的未保存文档）：一律按有修改处理（保守，保存一次才落到真实基线）", () => {
    expect(isDocModified("恢复出来的正文", null)).toBe(true);
    expect(isDocModified("", null)).toBe(true); // 基线未知时连"空正文"也不敢判干净
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

describe("isTypPath / pickTypPath", () => {
  it("只认 .typ 后缀，大小写不敏感（`.TYP` 也算）", () => {
    expect(isTypPath("/tmp/论文.typ")).toBe(true);
    expect(isTypPath("/tmp/论文.TYP")).toBe(true);
    expect(isTypPath("/tmp/论文.typ.txt")).toBe(false);
    expect(isTypPath("/tmp/论文")).toBe(false);
    expect(isTypPath("")).toBe(false);
  });

  it("pickTypPath：取**第一个** .typ（拖放里夹着图片时靠它挑）", () => {
    expect(pickTypPath(["/tmp/图.png", "/tmp/甲.typ", "/tmp/乙.typ"])).toBe("/tmp/甲.typ");
    expect(pickTypPath(["/tmp/图.png", "/tmp/文档.pdf"])).toBeNull();
    expect(pickTypPath([])).toBeNull();
  });

  it("pickTypPath 不改动传进来的数组", () => {
    const paths = ["/tmp/a.png", "/tmp/b.typ"];
    pickTypPath(paths);
    expect(paths).toEqual(["/tmp/a.png", "/tmp/b.typ"]);
  });
});
