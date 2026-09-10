// 公式编译上下文（前缀 + 文档内 #let 定义）的单元测试。
import { describe, it, expect } from "vitest";
import { extractMathDefinitions, buildMathContext } from "./math-context";

describe("extractMathDefinitions", () => {
  it("提取单行顶层 #let 定义，按文档顺序", () => {
    const doc = "#let R = math.bb(R)\n正文\n#let eps = 1e-9\n";
    expect(extractMathDefinitions(doc)).toBe("#let R = math.bb(R)\n#let eps = 1e-9");
  });

  it("函数定义（带参数）也提取", () => {
    expect(extractMathDefinitions("#let norm(x) = sqrt(x dot x)")).toBe(
      "#let norm(x) = sqrt(x dot x)",
    );
  });

  it("同名重定义只保留最后一次（避免拼出「变量已存在」）", () => {
    const doc = "#let a = 1\n#let a = 2";
    expect(extractMathDefinitions(doc)).toBe("#let a = 2");
  });

  it("代码块 / 注释 / 字符串里的 let 不算（只认顶层 #let 语句）", () => {
    expect(extractMathDefinitions("// #let x = 1")).toBe("");
    expect(extractMathDefinitions("`#let x = 1`")).toBe("");
    expect(extractMathDefinitions('#let s = "内层 #let y = 2 只是字符串"')).toBe(
      '#let s = "内层 #let y = 2 只是字符串"',
    );
  });

  it("含内容块 `[...]` 或多行的 let 保守跳过（拼接后可能残缺）", () => {
    expect(extractMathDefinitions('#let a = [*粗*]')).toBe("");
    expect(extractMathDefinitions("#let f(x) = {\n  x + 1\n}")).toBe("");
  });

  it("正在输入中的半截语句（`#let x =` 无值）不进去上下文", () => {
    // 若被拼进上下文，会让所有公式一起编译失败（整篇公式同时退回源码）
    expect(extractMathDefinitions("#let x =")).toBe("");
    expect(extractMathDefinitions("#let x =\n正文")).toBe("");
  });

  it("没有定义时返回空串", () => {
    expect(extractMathDefinitions("= 标题\n正文 $x^2$")).toBe("");
  });
});

describe("buildMathContext", () => {
  it("前缀在前、定义在后，各自补尾随换行", () => {
    expect(buildMathContext("#set text(size: 12pt)", "#let R = 1")).toBe(
      "#set text(size: 12pt)\n#let R = 1\n",
    );
  });

  it("无定义时等价于「前缀 + 尾随换行」", () => {
    expect(buildMathContext("#set page(margin: 2cm)", "正文")).toBe("#set page(margin: 2cm)\n");
    expect(buildMathContext("", "正文")).toBe("");
    expect(buildMathContext("", "")).toBe("");
  });

  it("只有定义、无前缀时也成立", () => {
    expect(buildMathContext("", "#let R = 1")).toBe("#let R = 1\n");
  });
});
