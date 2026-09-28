// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { htmlToText, imageExtension, imageSnippet, pastedImageName } from "./paste";

describe("imageExtension", () => {
  it("从 mime 取扩展名，jpeg → jpg，未知给 bin", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/svg+xml")).toBe("svgxml");
    expect(imageExtension("")).toBe("bin");
    expect(imageExtension("text/plain")).toBe("bin");
  });
});

describe("pastedImageName", () => {
  it("只用时间戳与序号，绝不带剪贴板里的原始文件名", () => {
    const at = new Date(2026, 8, 28, 7, 15, 30);
    expect(pastedImageName("image/png", at, 0)).toBe("image-20260928-071530-0.png");
    expect(pastedImageName("image/jpeg", at, 12)).toBe("image-20260928-071530-12.jpg");
    // 名字里没有分隔符、没有 `..`，Rust 侧的路径校验也不会被这次命名触发
    const name = pastedImageName("image/png", at, 3);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain("..");
  });

  it("负数 / 小数序号也会被规范化", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(pastedImageName("image/png", at, -3)).toBe("image-20260102-030405-0.png");
    expect(pastedImageName("image/png", at, 2.7)).toBe("image-20260102-030405-2.png");
  });
});

describe("imageSnippet", () => {
  it("生成带引号的 Typst 片段，路径里的引号/反斜线被转义", () => {
    expect(imageSnippet("image-1.png")).toBe('#image("image-1.png")');
    expect(imageSnippet('a"b.png')).toBe('#image("a\\"b.png")');
    expect(imageSnippet("dir\\x.png")).toBe('#image("dir\\\\x.png")');
  });
});

describe("htmlToText", () => {
  it("抽文本并保住块级结构（段落换行、列表项前缀）", () => {
    const html = "<p>第一段</p><p>第二段<br>换行</p><ul><li>甲</li><li>乙</li></ul><div>尾</div>";
    expect(htmlToText(html)).toBe("第一段\n第二段\n换行\n- 甲\n- 乙\n尾");
  });

  it("丢弃脚本 / 样式；空输入给空串；连续空行压成一个", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<style>p{color:red}</style><p>文字</p>")).toBe("文字");
    expect(htmlToText("<script>alert(1)</script>")).toBe("");
    expect(htmlToText("<p>甲</p><p></p><p></p><p>乙</p>")).toBe("甲\n\n乙");
  });

  it("没有 DOMParser 时退化成正则去标签（不抛异常）", () => {
    const saved = globalThis.DOMParser;
    // @ts-expect-error 故意移除，验证降级路径
    delete globalThis.DOMParser;
    try {
      expect(htmlToText("<p>甲<br>乙</p>")).toBe("甲乙");
    } finally {
      globalThis.DOMParser = saved;
    }
  });
});
