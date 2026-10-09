import { describe, expect, it } from "vitest";
import {
  EMPTY_PARAGRAPH_SPACE as space,
  hasEmptyParagraphs,
  projectEmptyParagraphs,
} from "./document-empty-paragraphs";
import { projectDocument, sourceDiagnostics } from "./document-projection";

const project = (source: string) => projectEmptyParagraphs(projectDocument(source, null));
function roundTrip(source: string) {
  const projection = project(source);
  expect(projection.original).toBe(source);
  for (let pos = 0; pos <= source.length; pos++)
    expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
  return projection;
}

describe("文档模式空段占位", () => {
  it("普通段落边界和源码软换行不增加空段", () => {
    for (const source of ["甲\n\n乙", "甲\n乙\n", "甲\n\n\n乙"])
      expect(roundTrip(source).source).toBe(source);
    expect(hasEmptyParagraphs("甲\n\n乙")).toBe(false);
  });

  it("每两个换行保留一个段落边界，额外空段有真实占位", () => {
    expect(roundTrip("甲\n\n\n\n乙\n\n").source).toBe(`甲\n\n${space}\n\n乙\n\n${space}`);
    expect(roundTrip("\n\n甲").source).toBe(`${space}\n\n甲`);
    expect(roundTrip("甲\n\n\n\n\n\n乙").source).toBe(`甲\n\n${space}\n\n${space}\n\n乙`);
  });

  it("空文档和只有缩进的空段也能定位，不改变原文位置", () => {
    for (const source of ["", "  ", "\n", "  \n\n\t \n\n"]) {
      const projection = roundTrip(source);
      expect(hasEmptyParagraphs(source)).toBe(true);
      for (let pos = 0; pos <= source.length; pos++)
        expect(projection.source[projection.sourceToCaret!(pos)]).toBe(space);
      expect(projection.sourceToCaret!(source.length)).toBe(projection.source.lastIndexOf(space));
    }
    expect(project("  \n\n\t \n\n").source).toBe(`  ${space}\n\n\t ${space}\n\n${space}`);
  });

  it("空段点击映射到缩进后，空段内移动共用停靠点而正文不被吸入", () => {
    const source = "A\n\n  \n\nB";
    const projection = roundTrip(source);
    const at = source.indexOf("  ") + 2;
    for (let pos = 3; pos < 7; pos++) expect(projection.sourceToCaret!(pos)).toBe(at);
    expect(projection.renderedToSource(at)).toBe(at);
    expect(projection.renderedToSource(at + 1)).toBe(at);
    expect(projection.source[projection.sourceToCaret!(source.indexOf("B"))]).toBe("B");
  });

  it("raw、公式、代码字符串、注释和内容块里的空白不注入占位", () => {
    for (const source of [
      "```\nA\n\n\n\nB\n```",
      "$ A\n\n\n\nB $",
      '#let x = "A\n\n\n\nB"',
      "/* A\n\n\n\nB */",
      "#block[A\n\n\n\nB]",
      "#let x = [\n\n\n\n]",
    ])
      expect(roundTrip(source).source).toBe(source);
  });

  it("前缀不显示为空段，设置语句后的输入行可以显示", () => {
    const prefix = "#set page(margin: 24pt)\n\n\n\n";
    const source = prefix + "";
    const projection = projectEmptyParagraphs(projectDocument(source, null), prefix.length);
    expect(projection.source).toBe(prefix + space);
    expect(projection.sourceToCaret!(source.length)).toBe(source.length);
    expect(project("#set text(size: 12pt)\n").source).toBe(`#set text(size: 12pt)\n${space}`);
  });

  it("CRLF 不被占位切开", () => {
    expect(roundTrip("#set text(size: 12pt)\r\n").source).toBe(`#set text(size: 12pt)\r\n${space}`);
    expect(roundTrip("A\r\n\r\n\r\n\r\nB\r\n\r\n").source).toBe(
      `A\r\n\r\n${space}\r\n\r\nB\r\n\r\n${space}`,
    );
  });

  it("和源码展开组合后，围栏内不占位，坐标仍回到原文", () => {
    const source = "#block[\n\n正文🙂\n\n]\n\n";
    const expanded = projectDocument(source, { from: 0, to: source.length - 2 });
    const projection = projectEmptyParagraphs(expanded);
    expect(projection.source).toBe(expanded.source + space);
    for (let pos = 0; pos <= source.length; pos++)
      expect(projection.renderedToSource(projection.sourceToRendered(pos))).toBe(pos);
    expect(projection.renderedToSource(projection.sourceToCaret!(source.length))).toBe(
      source.length,
    );
  });

  it("占位不增加源码行，后文和占位位置的诊断映射回原文", () => {
    const source = "\n\n🙂 #unknown()\n\n";
    const projection = project(source);
    const diagnostics = sourceDiagnostics(projection, [
      { severity: "error" as const, message: "error", line: 3, column: 4 },
      { severity: "warning" as const, message: "warning", line: 5, column: 2 },
    ]);
    expect(diagnostics[0]).toMatchObject({ line: 3, column: 5 });
    expect(diagnostics[1]).toMatchObject({ line: 5, column: 1 });
  });
});
