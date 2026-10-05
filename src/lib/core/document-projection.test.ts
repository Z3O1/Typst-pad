import { describe, it, expect } from "vitest";
import { projectDocument, sourceDiagnostics } from "./document-projection";

describe("Typst 原地源码展开", () => {
  it("展开完整表达式；中英文、emoji 与后文的位置可往返映射", () => {
    const doc = "前文🙂 $x^2 + y$，后文中文";
    const from = doc.indexOf("$"),
      to = doc.lastIndexOf("$") + 1;
    const projection = projectDocument(doc, { from, to });
    expect(projection.source).toBe("前文🙂 ` $x^2 + y$ `，后文中文");
    for (let pos = 0; pos <= doc.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
    expect(projectDocument(doc, null).source).toBe(doc);
  });
  it("多行及嵌套反引号选用不会提前闭合的围栏", () => {
    const doc = "#block[\n```typ\n#let x = 1\n```\n]";
    const projection = projectDocument(doc, { from: 0, to: doc.length });
    expect(projection.source).toBe("````typ\n" + doc + "\n````");
  });
  it("展开声明保留它的作用域，同时只把输入位置映射到可见源码", () => {
    const doc = "#let x = [内容]\n#x";
    const to = doc.indexOf("\n");
    const projection = projectDocument(doc, { from: 0, to });
    expect(projection.source.startsWith(doc.slice(0, to) + "\n")).toBe(true);
    expect(
      projection.source.slice(projection.sourceToRendered(0), projection.sourceToRendered(to)),
    ).toBe(doc.slice(0, to));
  });
  it("后文诊断映射回原文，外部文件诊断保持原坐标", () => {
    const doc = "#table(\n [甲],\n)\n#unknown()";
    const to = doc.indexOf("\n#unknown");
    const projection = projectDocument(doc, { from: 0, to });
    const line = projection.source
      .slice(0, projection.source.indexOf("#unknown"))
      .split("\n").length;
    const [main, external] = sourceDiagnostics(projection, [
      { message: "error", severity: "error" as const, line, column: 2 },
      { message: "error", severity: "error" as const, line, column: 2, path: "other.typ" },
    ]);
    expect(main.line).toBe(4);
    expect(main.column).toBe(2);
    expect(external.line).toBe(line);
  });
  it("同一行的 emoji 与展开标记不影响诊断在原文中的 UTF-16 列", () => {
    const doc = "🙂 $x$ #unknown()";
    const projection = projectDocument(doc, {
      from: doc.indexOf("$"),
      to: doc.lastIndexOf("$") + 1,
    });
    const column = [...projection.source.slice(0, projection.source.indexOf("unknown"))].length + 1;
    const [mapped] = sourceDiagnostics(projection, [
      { message: "error", severity: "error" as const, line: 1, column },
    ]);
    expect(mapped.column).toBe(doc.indexOf("unknown") + 1);
  });
});
