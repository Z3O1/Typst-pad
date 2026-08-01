// 文件路径筛选逻辑单元测试（拖放打开 .typ 文件用）
import { describe, it, expect } from "vitest";
import { isTypPath, pickTypPath } from "./file-ops";

describe("isTypPath", () => {
  it("识别 .typ 后缀（大小写不敏感）", () => {
    expect(isTypPath("a.typ")).toBe(true);
    expect(isTypPath("D:\\docs\\报告.TYP")).toBe(true);
    expect(isTypPath("/home/user/main.Typ")).toBe(true);
  });

  it("拒绝非 .typ 文件", () => {
    expect(isTypPath("a.txt")).toBe(false);
    expect(isTypPath("a.ty")).toBe(false);
    expect(isTypPath("typ")).toBe(false);
    expect(isTypPath("main.typ.bak")).toBe(false);
  });
});

describe("pickTypPath", () => {
  it("从多个路径中选出第一个 .typ 文件", () => {
    const paths = ["C:\\a.txt", "C:\\docs\\main.typ", "C:\\b.md"];
    expect(pickTypPath(paths)).toBe("C:\\docs\\main.typ");
  });

  it("没有 .typ 文件时返回 null", () => {
    expect(pickTypPath(["a.txt", "b.md"])).toBeNull();
    expect(pickTypPath([])).toBeNull();
  });
});
