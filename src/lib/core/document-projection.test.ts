import { describe, it, expect } from "vitest";
import { projectDocument, projectDocumentRanges, sourceDiagnostics } from "./document-projection";
import expansionStyle from "./document-expansion-style.json";
import { projectEmptyParagraphs } from "./document-empty-paragraphs";

describe("Typst 原地源码展开", () => {
  it("源码旁预览保留原表达式一次，编辑始终定位到 raw 而非预览副本", () => {
    const source = "正文 $a + β$ 后文";
    const from = source.indexOf("$"),
      to = source.lastIndexOf("$") + 1;
    const p = projectDocumentRanges(source, [{ from, to }], { styled: true, preview: true });
    const preview = p.source.lastIndexOf(source.slice(from, to));
    expect(p.source).toContain(expansionStyle.previewInlineHead);
    for (let i = 0; i <= to - from; i++) {
      expect(p.renderedToSource(preview + i)).toBe(from + i);
      expect(p.isPreview?.(preview + i)).toBe(true);
      expect(p.isPreview?.(p.sourceToRendered(from + i))).toBe(false);
    }
    for (let pos = 0; pos <= source.length; pos++)
      expect(p.renderedToSource(p.sourceToRendered(pos))).toBe(pos);
    expect(p.renderedToSource(preview - 1)).toBe(from);
    expect(p.original).toBe(source);
  });
  it("块公式采用上下预览面板，预览副本诊断仍映射到原文", () => {
    const source = "$ a + missing $";
    const p = projectDocumentRanges(source, [{ from: 0, to: source.length }], {
      styled: true,
      preview: true,
    });
    expect(p.source).toContain("```\n" + source + "\n```");
    expect(p.source).toContain(expansionStyle.previewBlockHead);
    const preview = p.source.lastIndexOf("missing");
    const before = p.source.slice(0, preview);
    const errors = sourceDiagnostics(p, [
      {
        message: "unknown",
        line: before.split("\n").length,
        col: [...before.slice(before.lastIndexOf("\n") + 1)].length + 1,
        endLine: before.split("\n").length,
        endCol: [...before.slice(before.lastIndexOf("\n") + 1)].length + 8,
      },
    ]);
    expect(errors[0]).toMatchObject({ line: 1, col: 7 });
  });
  it("声明和导入只在原作用域执行一次，不为预览再次调用或猜测变量值", () => {
    for (const text of [
      "#let x = 1;",
      "#set text(size: 12pt)",
      "#show raw: it => []",
      '#import "module.typ": x',
    ]) {
      const p = projectDocumentRanges(text, [{ from: 0, to: text.length }], {
        styled: true,
        preview: true,
      });
      expect(p.source.split(text).length).toBe(3); // 仅声明执行与不可执行的源码 raw。
      expect(p.source).not.toContain(expansionStyle.previewInlineHead);
      expect(p.source).not.toContain(expansionStyle.outputHead);
      expect(p.source.startsWith(text + "\n")).toBe(true);
    }
  });
  it("错误回退不执行无效表达式，仅保留源码与不可预览提示", () => {
    const text = "$unknown$";
    const p = projectDocumentRanges(
      text,
      [{ from: 0, to: text.length, preserveDeclaration: false }],
      { styled: true, preview: true },
    );
    expect(p.source.split(text).length).toBe(2);
    expect(p.source).not.toContain(expansionStyle.previewInlineHead);
    expect(p.source).not.toContain(expansionStyle.outputHead);
  });
  it("空段占位组合仍保留预览命中分类与原文映射", () => {
    const source = "\n\n$x$";
    const p = projectEmptyParagraphs(
      projectDocumentRanges(source, [{ from: 2, to: source.length }], {
        styled: true,
        preview: true,
      }),
    );
    const preview = p.source.lastIndexOf("$x$");
    expect(p.isPreview?.(preview + 1)).toBe(true);
    expect(p.renderedToSource(preview + 1)).toBe(3);
    expect(p.isPreview?.(p.sourceToRendered(3))).toBe(false);
  });
  it("行内展开使用局部样式，所有字符和后文仍精确映射回原文", () => {
    const source = "正文 $a + 🙂$ 后文";
    const from = source.indexOf("$");
    const to = source.lastIndexOf("$") + 1;
    const projection = projectDocumentRanges(source, [{ from, to }], { styled: true });
    expect(projection.source).toBe(
      source.slice(0, from) +
        expansionStyle.head +
        "` $a + 🙂$ `" +
        expansionStyle.tail +
        source.slice(to),
    );
    for (let pos = 0; pos <= source.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
    expect(projection.renderedToSource(from + 1)).toBe(from);
  });
  it("多行源码保留原始字形内容与声明执行，样式不进入保存或撤销原文", () => {
    const source = "#let x = {\n 1\n}\n#x";
    const to = source.indexOf("\n#x");
    const projection = projectDocumentRanges(source, [{ from: 0, to }], { styled: true });
    expect(
      projection.source.startsWith(source.slice(0, to) + "\n" + expansionStyle.head + "```\n"),
    ).toBe(true);
    expect(
      projection.source.slice(projection.sourceToRendered(0), projection.sourceToRendered(to)),
    ).toBe(source.slice(0, to));
    expect(projection.original).toBe(source);
    for (let pos = 0; pos <= source.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
  });
  it("局部 raw 隔离规则只包装展开区，用户其他 raw 和无展开输入保持原样", () => {
    const source = "#show raw: it => []\n$x$\n`USER-RAW`";
    const from = source.indexOf("$"),
      to = source.lastIndexOf("$") + 1;
    expect(projectDocumentRanges(source, [], { styled: true }).source).toBe(source);
    const projection = projectDocumentRanges(source, [{ from, to }], { styled: true });
    expect(projection.source.endsWith(expansionStyle.tail + "\n`USER-RAW`")).toBe(true);
    expect(expansionStyle.head).toContain("it.lines.map(line => line.body)");
    expect(expansionStyle.head).toContain("#set std.raw(lang: none, theme: none)");
  });
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
  it("相邻错误合并围栏，多区间后的诊断和光标仍映射回原文", () => {
    const doc = "#a()#b()\n中文🙂 #missing()";
    const projection = projectDocumentRanges(doc, [
      { from: 0, to: 4, preserveDeclaration: false },
      { from: 4, to: 8, preserveDeclaration: false },
    ]);
    expect(projection.source).toBe("` #a()#b() `\n中文🙂 #missing()");
    const [error] = sourceDiagnostics(projection, [
      { message: "error", severity: "error" as const, line: 2, column: 7 },
    ]);
    expect(error.column).toBe(8);
    for (let pos = 0; pos <= doc.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
  });
  it("多行及嵌套反引号选用不会提前闭合的围栏", () => {
    const doc = "#block[\n```typ\n#let x = 1\n```\n]";
    const projection = projectDocument(doc, { from: 0, to: doc.length });
    expect(projection.source).toBe("````\n" + doc + "\n````");
    for (let pos = 0; pos <= doc.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
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
