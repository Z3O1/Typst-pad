// @vitest-environment jsdom
// htmlToText 走 DOMParser，所以这份测试需要 DOM 环境。
import { describe, expect, it } from "vitest";
import { htmlToText, imageExtension, imageSnippet, pastedImageName } from "./paste";

describe("imageExtension", () => {
  it("常见图片类型取子类型；jpeg 归一成 jpg，未知给 bin", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/svg+xml")).toBe("svgxml");
    expect(imageExtension("")).toBe("bin");
    expect(imageExtension("application/octet-stream")).toBe("bin");
  });
});

describe("pastedImageName", () => {
  const at = new Date(2026, 8, 28, 7, 15, 30);

  it("用时间戳 + 序号命名，不带上剪贴板里的原始文件名", () => {
    expect(pastedImageName("image/png", at, 2)).toBe("image-20260928-071530-2.png");
    // 序号取整、不为负；同一秒内两张不重名
    expect(pastedImageName("image/png", at, 0)).toBe("image-20260928-071530-0.png");
    expect(pastedImageName("image/png", at, -5)).toBe("image-20260928-071530-0.png");
    expect(pastedImageName("image/png", at, 1.7)).toBe("image-20260928-071530-1.png");
  });

  it("生成的名字不含路径分隔符（拼进目标路径前最后一道保证）", () => {
    for (const mime of ["image/png", "image/../../evil", "image/x;y", ""]) {
      const name = pastedImageName(mime, at, 0);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });
});

describe("imageSnippet", () => {
  it("按 Typst 字符串转义引号与反斜线", () => {
    expect(imageSnippet("image-1.png")).toBe('#image("image-1.png")');
    expect(imageSnippet('a"b.png')).toBe('#image("a\\"b.png")');
    expect(imageSnippet("a\\b.png")).toBe('#image("a\\\\b.png")');
  });
});

describe("htmlToText", () => {
  it("段落与换行保留，列表项补 -，script/style 内容丢弃", () => {
    expect(htmlToText("<p>甲</p><p>乙</p>")).toBe("甲\n\n乙");
    expect(htmlToText("甲<br>乙")).toBe("甲\n乙");
    expect(htmlToText("<ul><li>甲</li><li>乙</li></ul>")).toBe("- 甲\n- 乙");
    expect(htmlToText("<p>甲</p><script>alert(1)</script><style>p{}</style>")).toBe("甲");
  });

  it("收敛多余空行、去掉尾部换行；空输入返回空串", () => {
    expect(htmlToText("<p>甲</p><p></p><p></p><p>乙</p>")).toBe("甲\n\n乙");
    expect(htmlToText("<p>甲</p>")).toBe("甲");
    expect(htmlToText("")).toBe("");
  });

  it("普通行内标签只影响文本内容，不产生换行", () => {
    expect(htmlToText("<p>甲<b>乙</b>丙</p>")).toBe("甲乙丙");
  });
});
