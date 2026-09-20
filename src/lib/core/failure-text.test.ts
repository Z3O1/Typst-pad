// failure-text 单测：把 invoke 抛出的各种形状变成状态栏那一句。
import { describe, it, expect } from "vitest";
import { describeFailure, failureStatus } from "./failure-text";

describe("describeFailure（从抛出的东西里抠一句原因）", () => {
  it("Rust 命令的字符串错误直接用（`Result<_, String>` 的常见形态）", () => {
    expect(describeFailure("仅支持 .typ 文件")).toBe("仅支持 .typ 文件");
    expect(describeFailure("目录无效")).toBe("目录无效");
  });

  it("Error 用 message", () => {
    expect(describeFailure(new Error("没有写入权限"))).toBe("没有写入权限");
  });

  it("带 message 的对象（插件抛的不是 Error 实例时）", () => {
    expect(describeFailure({ message: "文件不存在" })).toBe("文件不存在");
  });

  it("多行折成一行（状态栏是单行，换行会把后面那句吃掉）", () => {
    expect(describeFailure("第一行\n第二行\n\n  第三行  ")).toBe("第一行 第二行 第三行");
    expect(describeFailure(new Error("error: unexpected end of file\n  at line 3"))).toBe(
      "error: unexpected end of file at line 3",
    );
  });

  it("拿不到原因时返回空串（不许写出「undefined」「[object Object]」这种）", () => {
    expect(describeFailure(null)).toBe("");
    expect(describeFailure(undefined)).toBe("");
    expect(describeFailure("")).toBe("");
    expect(describeFailure("   ")).toBe("");
    expect(describeFailure({})).toBe("[object Object]"); // 对象没有 message：只能退成字符串
  });

  it("message 不是字符串、toString 会抛 —— 都不许把异常带出去", () => {
    expect(describeFailure({ message: 42 })).toBe("[object Object]");
    const nasty = {
      toString() {
        throw new Error("boom");
      },
    };
    expect(describeFailure(nasty)).toBe("");
  });
});

describe("failureStatus（状态栏那一句）", () => {
  it("有原因 → 「动作：原因」", () => {
    expect(failureStatus("保存失败", "仅支持 .typ 文件")).toBe("保存失败：仅支持 .typ 文件");
    expect(failureStatus("打开失败", new Error("目录无效"))).toBe("打开失败：目录无效");
  });

  it("没原因 → 只有动作，不写光秃秃的冒号", () => {
    expect(failureStatus("保存失败", null)).toBe("保存失败");
    expect(failureStatus("重新读取失败", "")).toBe("重新读取失败");
  });
});
