import { describe, it, expect } from "vitest";
import { describeCompileWarning } from "./font-warnings";

describe("describeCompileWarning 编译警告可读化", () => {
  it("未知字体族：给出英文族名与字体目录两条例行做法", () => {
    const out = describeCompileWarning("unknown font family: 微软雅黑");
    expect(out).toContain("微软雅黑");
    expect(out).toContain("Microsoft YaHei");
    expect(out).toContain("额外字体目录");
  });

  it("大小写不同、多余空白也能识别", () => {
    expect(describeCompileWarning("Unknown Font Family:   SimSun ")).toContain("SimSun");
  });

  it("其它警告原样返回", () => {
    expect(describeCompileWarning("unused import")).toBe("unused import");
    expect(describeCompileWarning("")).toBe("");
  });
});
