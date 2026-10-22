import { describe, it, expect } from "vitest";
import { projectDocument, projectDocumentRanges, sourceDiagnostics } from "./document-projection";
import expansionStyle from "./document-expansion-style.json";
import { projectEmptyParagraphs } from "./document-empty-paragraphs";

describe("Typst 原地源码展开", () => {
  it("标题包含级别标记，单行也使用 block raw 并隔离后文，只执行一个隐藏标题", () => {
    for (const title of ["== 中文🙂 $x$ #strong[标题]", "=== ", "= 标题 #block[\n多行\n]"]) {
      const source = `前文\n\n${title}\n后正文。`;
      const from = source.indexOf(title),
        to = from + title.length;
      const p = projectDocumentRanges(source, [{ from, to }], { styled: true, preview: true });
      expect(p.source).toContain(`\`\`\`typ\n\n${title}\n\`\`\`${expansionStyle.tail}\n\n`);
      expect(p.source).toContain(
        `${expansionStyle.outputHead}\n${title}${expansionStyle.outputTail}\n\n`,
      );
      expect(p.source).not.toContain(expansionStyle.previewInlineHead);
      expect(p.original).toBe(source);
      for (let pos = 0; pos <= source.length; pos++)
        expect(p.renderedToSource(p.sourceToRendered(pos))).toBe(pos);
      const preview = p.source.lastIndexOf(title);
      expect(p.isPreview!(p.sourceToRendered(from))).toBe(false);
      expect(p.renderedToSource(preview + 2)).toBe(from + 2);
      const invalid = projectDocumentRanges(source, [{ from, to, preserveDeclaration: false }], {
        styled: true,
        preview: true,
      });
      expect(invalid.source).not.toContain(expansionStyle.outputHead);
    }
  });
  it("公式和脚本共享代码卡片样式，不为高亮切分 raw 或改变诊断来源", () => {
    expect(expansionStyle.formulaHead).toBe(expansionStyle.head);
    expect(expansionStyle.head).toContain("ligatures: false");
    // 文档 11pt 经页面缩放对应源码模式的 14px；浅底卡片由现有页面主题滤镜处理。
    expect(expansionStyle.head).toContain("size: 11pt");
    expect(expansionStyle.head).toContain('fill: std.rgb("#1f1f1f")');
    expect(expansionStyle.head).toContain(
      'fill: std.rgb("#f6f5f1"), stroke: 0.45pt + std.rgb("#e3e0d8"), radius: 3pt',
    );
    expect(expansionStyle.head).not.toContain("fill: white");
    for (const head of [expansionStyle.previewInlineHead, expansionStyle.previewBlockHead]) {
      expect(head).toContain('fill: std.rgb("#ffffff")');
      expect(head).not.toContain("fill: white");
    }
    expect(expansionStyle.head).toContain("inset: (x: 6pt, top: 4pt, bottom: 6pt)");
    expect(expansionStyle.head).toContain("leading: 0.64em");
    expect(expansionStyle.head).toContain(
      'std.highlight(fill: std.rgb("#f2f0ea"), radius: 2pt, extent: 1pt',
    );
    expect(expansionStyle.head).toContain('lang: "typ", theme: bytes(');
    expect(expansionStyle.head).not.toContain("regex(");
  });
  it("高亮调色板在块卡片、行内底色及深色滤镜下都保持可读对比度", () => {
    // 深色模式对整页套 invert(1) contrast(0.71)；调色板须在两种光路上都过 4.5。
    const themeMatch = expansionStyle.head.match(/theme: bytes\("((?:[^"\\]|\\.)*)"\)/);
    expect(themeMatch).not.toBeNull();
    const theme = JSON.parse(`"${themeMatch![1]}"`) as string;
    const cards = ["#f6f5f1", "#f2f0ea"];
    const toSrgb = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
    };
    const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = (rgb: number[]) =>
      0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
    const night = (rgb: number[]) =>
      rgb.map((c) => Math.min(1, Math.max(0, (0.5 - c) * 0.71 + 0.5)));
    const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const colors = [
      ...theme.matchAll(
        /<key>scope<\/key><string>[^<]*<\/string><key>settings<\/key><dict><key>foreground<\/key><string>(#[0-9A-Fa-f]{6})<\/string>/g,
      ),
    ].map((m) => m[1]);
    expect(colors.length).toBeGreaterThan(5);
    for (const card of cards) {
      const bgDay = luminance(toSrgb(card));
      const bgNight = luminance(night(toSrgb(card)));
      for (const color of colors) {
        const day = contrast(luminance(toSrgb(color)), bgDay);
        const nightContrast = contrast(luminance(night(toSrgb(color))), bgNight);
        expect(day, `${color} 在 ${card} 上的浅色对比度`).toBeGreaterThanOrEqual(4.5);
        expect(nightContrast, `${color} 在 ${card} 上的深色对比度`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("块与行内展开均用 typ 高亮和隐藏首行，非样式投影不携带占位", () => {
    expect(expansionStyle.head).toContain("it.lines.slice(1)");
    const source = "#let x = {\n 1\n}\n#x";
    const to = source.indexOf("\n#x");
    const styled = projectDocumentRanges(source, [{ from: 0, to }], { styled: true });
    expect(styled.source).toContain("```typ\n\n" + source.slice(0, to) + "\n```");
    // 非样式投影没有 show 规则隐藏占位行,不能携带语言标签或占位行。
    const plain = projectDocumentRanges(source, [{ from: 0, to }]);
    expect(plain.source).toContain("```\n" + source.slice(0, to) + "\n```");
    expect(plain.source).not.toContain("```typ");
    for (const text of [
      '$a_12 + "中文🙂"$',
      "$$",
      "#strong[中文🙂]",
      '$a_12 + "中文🙂"$\n',
      '#let value = {\n  "中文🙂" // comment\n  12 + 34\n};',
    ]) {
      const p = projectDocumentRanges(text, [{ from: 0, to: text.length }], {
        styled: true,
        preview: true,
      });
      expect(p.original).toBe(text);
      if (!text.includes("\n")) {
        expect(p.source).toContain("`\n" + text + "`" + expansionStyle.tail);
        expect(p.source).not.toContain("```typ");
      }
      for (let pos = 0; pos <= text.length; pos++)
        expect(p.renderedToSource(p.sourceToRendered(pos))).toBe(pos);
      const offset = Math.max(1, text.indexOf("中"));
      const rendered = p.sourceToRendered(offset);
      const before = p.source.slice(0, rendered);
      const [error] = sourceDiagnostics(p, [
        {
          message: "source",
          line: before.split("\n").length,
          col: [...before.slice(before.lastIndexOf("\n") + 1)].length + 1,
          endLine: before.split("\n").length,
          endCol: [...before.slice(before.lastIndexOf("\n") + 1)].length + 2,
        },
      ]);
      const originalBefore = text.slice(0, offset);
      expect(error).toMatchObject({
        line: originalBefore.split("\n").length,
        col: originalBefore.slice(originalBefore.lastIndexOf("\n") + 1).length + 1,
      });
    }
  });
  it("展开 raw 的空行与缩进只在投影中占位，边界/中文/emoji/多范围映射可往返", () => {
    const text = "\n \t\n中文🙂\n\n\t \n";
    const source = `前🙂 ${text} 后 $x$\n\n`;
    const from = source.indexOf(text),
      to = from + text.length;
    const mathFrom = source.indexOf("$x$");
    const p = projectEmptyParagraphs(
      projectDocumentRanges(
        source,
        [
          { from, to },
          { from: mathFrom, to: mathFrom + 3 },
        ],
        { styled: true, preview: true },
      ),
    );
    expect(p.original).toBe(source);
    for (let pos = 0; pos <= source.length; pos++)
      expect(p.renderedToSource(p.sourceToRendered(pos)), `原文 ${pos}`).toBe(pos);
    let lineFrom = from;
    for (const line of text.split("\n")) {
      if (/^[ \t]*$/.test(line)) {
        const at = lineFrom + line.length;
        for (let pos = lineFrom; pos <= at; pos++) {
          const caret = p.sourceToCaret!(pos);
          expect(p.source[caret]).toBe("\u00a0");
          expect(p.renderedToSource(caret)).toBe(at);
          expect(p.renderedToSource(caret + 1)).toBe(at);
        }
      } else expect(p.source[p.sourceToCaret!(lineFrom)]).toBe("中");
      lineFrom += line.length + 1;
    }
    const preview = p.source.lastIndexOf(text);
    expect(preview).toBeGreaterThan(p.sourceToRendered(to));
    for (let i = 0; i <= text.length; i++) {
      expect(p.renderedToSource(preview + i)).toBe(from + i);
      expect(p.isPreview!(preview + i)).toBe(true);
    }
    const rendered = p.sourceToRendered(source.indexOf("中"));
    const before = p.source.slice(0, rendered);
    const [diagnostic] = sourceDiagnostics(p, [
      {
        message: "range",
        line: before.split("\n").length,
        col: 1,
        endLine: before.split("\n").length,
        endCol: 3,
      },
    ]);
    expect(diagnostic).toMatchObject({ line: 3, col: 1, endLine: 3, endCol: 3 });
  });
  it("闭合公式后空段定位不落回展开围栏或预览，空行源码仍不变", () => {
    const source = "$x$\n\n \t\n\n";
    const p = projectEmptyParagraphs(
      projectDocumentRanges(source, [{ from: 0, to: 3 }], {
        styled: true,
        preview: true,
      }),
    );
    for (const pos of [5, 6, 7, source.length]) {
      const caret = p.sourceToCaret!(pos);
      expect(p.source[caret]).toBe("\u00a0");
      expect(p.isPreview!(caret)).toBe(false);
    }
    for (let pos = 0; pos <= source.length; pos++)
      expect(p.renderedToSource(p.sourceToRendered(pos))).toBe(pos);
  });
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
    expect(p.source).toContain("```typ\n\n" + source + "\n```");
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
        "`\n$a + 🙂$`" +
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
      projection.source.startsWith(source.slice(0, to) + "\n" + expansionStyle.head + "```typ\n\n"),
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
    expect(expansionStyle.head).toContain("lines.map(line => line.body)");
    expect(expansionStyle.head).toContain('#set std.raw(lang: "typ", theme: bytes(');
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
  it("单个反引号也必须使用块围栏，不能生成表示空 raw 的双反引号", () => {
    const source = '#text("`")';
    for (const styled of [false, true]) {
      const p = projectDocumentRanges(source, [{ from: 0, to: source.length }], { styled });
      expect(p.source).toContain((styled ? "```typ\n\n" : "```\n") + source + "\n```");
      for (let pos = 0; pos <= source.length; pos++)
        expect(p.renderedToSource(p.sourceToRendered(pos))).toBe(pos);
    }
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
