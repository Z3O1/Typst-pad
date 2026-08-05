// typst-libs 路径/消息纯函数单元测试（本地 .typ 库注册辅助逻辑）
import { describe, it, expect } from "vitest";
import {
  dirOfPath,
  toVirtualRelPath,
  libraryVirtualPaths,
  formatCompileFailMessage,
} from "./typst-libs";

describe("dirOfPath", () => {
  it("Windows 反斜杠路径", () => {
    expect(dirOfPath("C:\\a\\b.typ")).toBe("C:\\a");
    expect(dirOfPath("C:\\proj\\lib\\a.typ")).toBe("C:\\proj\\lib");
  });

  it("POSIX 斜杠路径", () => {
    expect(dirOfPath("/a/b.typ")).toBe("/a");
    expect(dirOfPath("/home/user/main.typ")).toBe("/home/user");
  });

  it("无分隔符返回原始串", () => {
    expect(dirOfPath("main.typ")).toBe("main.typ");
  });
});

describe("toVirtualRelPath", () => {
  it("Windows 路径转虚拟相对路径（分隔符统一为 /）", () => {
    expect(toVirtualRelPath("C:\\proj\\lib\\a.typ", "C:\\proj")).toBe(
      "lib/a.typ",
    );
    expect(toVirtualRelPath("C:\\proj\\a.typ", "C:\\proj")).toBe("a.typ");
  });

  it("POSIX 路径转虚拟相对路径", () => {
    expect(toVirtualRelPath("/proj/lib/a.typ", "/proj")).toBe("lib/a.typ");
    expect(toVirtualRelPath("/proj/a.typ", "/proj")).toBe("a.typ");
  });

  it("子目录嵌套保留", () => {
    expect(
      toVirtualRelPath("C:\\proj\\chapters\\a.typ", "C:\\proj"),
    ).toBe("chapters/a.typ");
  });

  it("拒绝含 .. 段的路径", () => {
    expect(toVirtualRelPath("C:\\proj\\..\\etc\\a.typ", "C:\\proj")).toBeNull();
    expect(toVirtualRelPath("/proj/../a.typ", "/proj")).toBeNull();
  });

  it("目录不匹配或路径在目录之外返回 null", () => {
    expect(toVirtualRelPath("D:\\other\\a.typ", "C:\\proj")).toBeNull();
    expect(toVirtualRelPath("C:\\proj2\\a.typ", "C:\\proj")).toBeNull();
    expect(toVirtualRelPath("C:\\proj\\a.typ", "D:\\proj")).toBeNull();
  });
});

describe("libraryVirtualPaths", () => {
  const dir = "C:\\proj";

  it("转成 registerLocalLibraries 入参", () => {
    const out = libraryVirtualPaths(
      [
        { path: "C:\\proj\\lib.typ", content: "#let hi = 1" },
        { path: "C:\\proj\\chapters\\a.typ", content: "#let x = 2" },
      ],
      dir,
    );
    expect(out).toEqual({
      "lib.typ": "#let hi = 1",
      "chapters/a.typ": "#let x = 2",
    });
  });

  it("过滤目录外路径", () => {
    const out = libraryVirtualPaths(
      [{ path: "D:\\other\\a.typ", content: "" }],
      dir,
    );
    expect(out).toEqual({});
  });

  it("跳过与 main.typ 同名文件（防覆盖 shadow，大小写不敏感）", () => {
    const out = libraryVirtualPaths(
      [
        { path: "C:\\proj\\main.typ", content: "shadow" },
        { path: "C:\\proj\\MAIN.TYP", content: "shadow2" },
        { path: "C:\\proj\\lib.typ", content: "#let a = 1" },
      ],
      dir,
    );
    expect(out).toEqual({ "lib.typ": "#let a = 1" });
  });

  it("拒绝含 .. 段的路径", () => {
    const out = libraryVirtualPaths(
      [{ path: "C:\\proj\\..\\evil.typ", content: "" }],
      dir,
    );
    expect(out).toEqual({});
  });
});

describe("formatCompileFailMessage", () => {
  it("errorCount > 0 显示计数形式", () => {
    expect(formatCompileFailMessage(3, "anything")).toBe("编译错误：3 处");
  });

  it("errorCount = 0 显示错误消息", () => {
    expect(
      formatCompileFailMessage(0, "package @preview/cetz:0.1.0 not found"),
    ).toBe("编译错误：package @preview/cetz:0.1.0 not found");
  });

  it("长消息截断到 ~120 字符", () => {
    const long = "x".repeat(500);
    const msg = formatCompileFailMessage(0, long);
    expect(msg.startsWith("编译错误：")).toBe(true);
    expect(msg.length).toBeLessThanOrEqual("编译错误：".length + 120 + 1);
    expect(msg.endsWith("…")).toBe(true);
  });
});
