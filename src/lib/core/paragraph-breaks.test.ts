import { describe, expect, it } from "vitest";
import { scanMarkupDecorations } from "./markup-ranges";
import { scanMathRanges } from "./math-ranges";
import { hasCustomParSpacing, scanParagraphGapRows } from "./paragraph-breaks";
import { scanNonMarkupRegions } from "./typst-lex";

function gaps(doc: string, prefix = "") {
  const opaque = scanNonMarkupRegions(doc);
  const math = scanMathRanges(doc, opaque);
  const markup = scanMarkupDecorations(doc, { opaque, math });
  return scanParagraphGapRows(doc, opaque, math, markup, prefix);
}

describe("scanParagraphGapRows", () => {
  it("认出普通段落间的空白行，但不改动源码", () => {
    const doc = "1 \n\n 1";
    expect(gaps(doc)).toEqual([{ from: 3, count: 1 }]);
  });

  it("连续空行共享一份段距，空白缩进也保留为源码", () => {
    const doc = "前段\n  \n\n后段";
    // 两条空白行里只有**第一条**是那两个段落之间必需的分隔行，第二条是用户自己创建的空段落
    // （按普通行盒呈现、也是竖直导航的停靠点，见下面的用例）。段距因此只落在第一条上。
    expect(gaps(doc)).toEqual([{ from: 3, count: 1 }]);
  });

  it("两个正文段落之间：只有第一条空白行是必需的分隔行，其余是用户的空段落", () => {
    // 用户 2026-09-26：「要区分"维持两个段落所必需的分隔换行"与"额外创建的空段落"」。
    // 一次 Enter 建出一条空段落（Enter 落在最后那条空白行上），它必须仍是停靠点。
    expect(gaps("前段\n\n后段")).toEqual([{ from: 3, count: 1 }]);
    expect(gaps("前段\n\n\n后段")).toEqual([{ from: 3, count: 1 }]);
    // 连续按 Enter：只有第一条压缩，其余（用户建的两条空段落）保持普通行盒。
    expect(gaps("前段\n\n\n\n后段")).toEqual([{ from: 3, count: 1 }]);
    // 标题 / 列表行同样是"正文行"，与相邻段落之间适用同一条规则。
    const heading = "= 标题\n\n\n正文";
    expect(gaps(heading)).toEqual([{ from: heading.indexOf("\n\n\n") + 1, count: 1 }]);
    const list = "正文\n\n\n- 列表项";
    expect(gaps(list)).toEqual([{ from: list.indexOf("\n\n\n") + 1, count: 1 }]);
  });

  it("贴着规则 / 注释 / 代码的空白串仍整串按分隔行压缩（几何由裁剪带承载）", () => {
    // 反例保护：这些构造两侧的空白行如果也长出一条可见空行，整页就会偏离真实排版
    // （PKU 高代周一实测 `#pagebreak()` 后面那两条空行）。
    const pagebreak = "#pagebreak()\n\n\n// 注释\n";
    expect(gaps(pagebreak)).toEqual([
      { from: pagebreak.indexOf("\n\n\n") + 1, count: 2 },
      { from: pagebreak.indexOf("\n\n\n") + 2, count: 2 },
    ]);
    const rule = "#let x = 1\n\n\n正文";
    expect(gaps(rule)).toEqual([
      { from: rule.indexOf("\n\n\n") + 1, count: 2 },
      { from: rule.indexOf("\n\n\n") + 2, count: 2 },
    ]);
  });

  it("文档首部空行不作为段距，文末新段预留稳定段距", () => {
    expect(gaps("\n首段\n\n尾段\n")).toEqual([{ from: 4, count: 1 }]);
    expect(gaps("正文\n\n")).toEqual([{ from: 3, count: 1 }]);
    expect(gaps("正文\n\n  ")).toEqual([{ from: 3, count: 1 }]);
    // 文末连续 Enter：最后一行是光标所在的新段落（不压缩），其余只有第一条是必需的分隔行 ——
    // 与两个正文段落之间的规则同源（用户 2026-09-26：连续 Enter 建出的空段落都要能进入）。
    expect(gaps("正文\n\n\n")).toEqual([{ from: 3, count: 1 }]);
    // 贴在规则行后面的文末空行没有裁剪带承载几何，整串仍按分隔行压缩（但最后一行照旧留给光标）。
    expect(gaps("#let x = 1\n\n\n")).toEqual([
      { from: 11, count: 2 },
      { from: 12, count: 2 },
    ]);
  });

  it("全空文档与文首空白没有可压缩的段距；UTF-16 偏移仍指向正确空行", () => {
    expect(gaps("\n\n  \n")).toEqual([]);
    expect(gaps("  \n\n正文")).toEqual([]);
    expect(gaps("😀段\n\n尾段")).toEqual([{ from: 4, count: 1 }]);
  });

  it("围栏代码内外的空行都由复杂块承载，不误作普通正文段距", () => {
    const doc = ["前段", "", "```typ", "a", "", "b", "```", "", "后段"].join("\n");
    expect(gaps(doc)).toEqual([]);
    // 对照：删去围栏后，同一位置的普通段落空行才进入段距压缩。
    expect(gaps("前段\n\n后段")).toEqual([{ from: 3, count: 1 }]);
  });

  it("标题两侧的空白行也压缩（标题是可编辑文本，上下间距没有切片承载）", () => {
    const doc = "普通段落\n\n= 标题\n\n正文";
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n= 标题") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文") + 1, count: 1 },
    ]);
  });

  it("行间公式所在的可编辑段落两侧空行也压缩（它只有 MathBlockWidget，没有块带承载段距）", () => {
    // 只有"整段被当切片"时裁剪带才承载段距；`$ … $` 单独成段是可编辑段落，没有带。
    const doc = ["普通段落", "", "$ x^2 $", "", "正文"].join("\n");
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n$ x^2 $") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文") + 1, count: 1 },
    ]);
  });

  it("无输出的规则 / 整行注释两侧空行压缩（它们没有裁剪带承载段距）", () => {
    // PKU 高代周二实测：贴着 `#set` / `#let` / 整行注释的空行原本按整行 24.2px 渲染，
    // 而 Typst 的段距已含在相邻块的带高里 —— 全文约 16 行 × 24px ≈ 390px 的纵向漂移。
    // 注释块**内部**的空行仍不动（它在注释区域里，见下面的 lineHasNonMarkup 守卫）。
    const doc = ["#let x = 1", "", "正文一", "", "/* 注释", "", "注释 */", "", "正文二"].join("\n");
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n正文一") + 1, count: 1 },
      { from: doc.indexOf("\n\n/* 注释") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
  });

  it("列表两侧的空白行也压缩（列表间距由空白行代表，不压缩会多占一整行）", () => {
    const doc = "普通段落\n\n- 列表项\n\n正文";
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n- 列表项") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文") + 1, count: 1 },
    ]);
  });

  it("出现自定义 par 规则时不假设 1.2em 默认段距", () => {
    expect(gaps("#set par(spacing: 0.8em)\n\n正文一\n\n正文二")).toEqual([]);
    expect(gaps("#show par: set block(breakable: false)\n\n正文一\n\n正文二")).toEqual([]);
    expect(gaps("正文一\n\n正文二", "#set par(spacing: 0.8em)\n")).toEqual([]);
  });

  it("注释里的 par 示例不禁用段距压缩", () => {
    const lineComment = "// #set par(spacing: 0.8em)\n\n正文一\n\n正文二";
    const blockComment = "/* #show par: ... */\n\n正文一\n\n正文二";
    expect(gaps(lineComment)).toEqual([
      { from: lineComment.indexOf("\n\n正文一") + 1, count: 1 },
      { from: lineComment.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
    expect(gaps(blockComment)).toEqual([
      { from: blockComment.indexOf("\n\n正文一") + 1, count: 1 },
      { from: blockComment.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
    expect(gaps("正文一\n\n正文二", "// #set par(spacing: 0.8em)\n")).toEqual([
      { from: 4, count: 1 },
    ]);
  });

  it("活动 par 规则仍禁用段距压缩，即使注释里也有示例", () => {
    expect(
      gaps("// #set par(spacing: 0.8em)\n#set par(spacing: 0.6em)\n\n正文一\n\n正文二"),
    ).toEqual([]);
  });

  it("只改 leading / justify 的 #set par 不禁用段距压缩（段距仍是默认 1.2em）", () => {
    const doc = "#set par(leading: 0.9em, justify: true)\n\n正文一\n\n正文二";
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n正文一") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
    const of = (s: string) => scanNonMarkupRegions(s);
    expect(hasCustomParSpacing("#set par(leading: 0.9em)", of("#set par(leading: 0.9em)"))).toBe(
      false,
    );
    expect(hasCustomParSpacing("#set par(spacing: 0.8em)", of("#set par(spacing: 0.8em)"))).toBe(
      true,
    );
    expect(hasCustomParSpacing("#show par: it => it", of("#show par: it => it"))).toBe(true);
  });

  it("正文里的直引号与行内公式不妨碍识别段间隔", () => {
    expect(gaps('他说 "你好"，公式 $x^2$。\n\n下一段。')).toEqual([{ from: 18, count: 1 }]);
  });

  it("规则/注释行之间的空行也压缩（多行 #set 的收尾行算规则行）", () => {
    const doc = [
      "#set page(",
      "  margin: 1cm,",
      ")",
      "",
      "#set text(",
      "  size: 11pt,",
      ")",
      "",
      "#let a = 1",
      "",
      "= 标题",
      "",
      "正文",
    ].join("\n");
    const rows = scanParagraphGapRows(doc, scanNonMarkupRegions(doc), [], []);
    const starts = [0];
    for (let i = 0; i < doc.length; i++) if (doc[i] === "\n") starts.push(i + 1);
    const lineOf = (p: number) => starts.filter((x) => x <= p).length;
    expect(rows.map((r) => lineOf(r.from))).toEqual([4, 8, 10, 12]);
  });

  it("整行以 `#` 开头的代码行两侧空行也压缩（如 `#table(` 这类多行调用）", () => {
    const doc = ["正文一", "", "#table(", "  columns: 2,", "  [a], [b],", ")", "", "正文二"].join(
      "\n",
    );
    expect(gaps(doc)).toEqual([
      { from: doc.indexOf("\n\n#table(") + 1, count: 1 },
      { from: doc.indexOf("\n\n正文二") + 1, count: 1 },
    ]);
  });
});
