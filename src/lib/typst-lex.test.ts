// 所见即所得「区域扫描」与「公式范围」的单元测试。
// 两条主线：typst-lex 不把代码里的符号当标记；math-ranges 只在 markup 区里认公式。
import { describe, it, expect } from "vitest";
import { scanNonMarkupRegions, scanMarkupRegions, regionAt } from "./typst-lex";
import { scanMathRanges, mathCacheKey, selectionTouchesRange } from "./math-ranges";

describe("typst-lex 区域扫描", () => {
  it("识别行注释 / 块注释（含嵌套）/ 原始文本 / 字符串 / 代码表达式", () => {
    const doc = 'a // 注释\nb /* 外 /* 内 */ 尾 */ c `raw` d "str" e #text(x)[y] f';
    const regions = scanNonMarkupRegions(doc);
    expect(regions.map((r) => r.kind)).toEqual([
      "comment",
      "comment",
      "raw",
      "string",
      "code",
    ]);
    // 切片校验（防止只对类别不对位置）
    expect(regions.map((r) => doc.slice(r.from, r.to))).toEqual([
      "// 注释",
      "/* 外 /* 内 */ 尾 */",
      "`raw`",
      '"str"',
      "#text(x)",
    ]);
    // `[...]` 是内容块 → 内部回到 markup（typst 语义）：`[y] f` 不在不可见区域内
    expect(doc.slice(regions[4].to)).toBe("[y] f");
  });

  it("多行 raw（``` 与更长的反引号）配对", () => {
    const doc = "```\n$ x $\n```\n正文 $y$";
    const regions = scanNonMarkupRegions(doc);
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("raw");
    expect(doc.slice(regions[0].from, regions[0].to)).toBe("```\n$ x $\n```");
    // 只有正文里的 $y$ 是公式
    expect(scanMathRanges(doc).map((m) => m.body)).toEqual(["y"]);
  });

  it("markup 区是其余部分的补集，合起来覆盖全文", () => {
    const doc = 'x #f(1) y `z` "w"';
    const markup = scanMarkupRegions(doc);
    const opaque = scanNonMarkupRegions(doc);
    const all = [...markup, ...opaque].sort((a, b) => a.from - b.from);
    expect(all[0].from).toBe(0);
    expect(all[all.length - 1].to).toBe(doc.length);
    for (let i = 1; i < all.length; i++) expect(all[i].from).toBe(all[i - 1].to);
    expect(markup.every((r) => r.kind === "markup")).toBe(true);
  });

  it("regionAt 的边界语义（左闭右开）", () => {
    const doc = "#let x = 1";
    const regions = scanNonMarkupRegions(doc);
    expect(regions).toHaveLength(1);
    expect(regionAt(regions, 0)?.kind).toBe("code");
    expect(regionAt(regions, doc.length - 1)?.kind).toBe("code");
    expect(regionAt(regions, doc.length)).toBeUndefined();
  });
});

describe("scanMathRanges 公式范围", () => {
  it("行内公式：$x^2$ → body=x^2，非行间", () => {
    const doc = "前 $x^2$ 后";
    const [m] = scanMathRanges(doc);
    expect(doc.slice(m.from, m.to)).toBe("$x^2$");
    expect(m.body).toBe("x^2");
    expect(m.display).toBe(false);
    expect(m.multiline).toBe(false);
  });

  it("行间公式（定界符内侧带空白）→ display=true 且 body 已 trim", () => {
    const doc = "文字\n$ sum_(i=1)^n i $\n文字";
    const [m] = scanMathRanges(doc);
    expect(m.body).toBe("sum_(i=1)^n i");
    expect(m.display).toBe(true);
    expect(m.multiline).toBe(false);
  });

  it("跨行公式 → multiline=true", () => {
    const doc = "$\n  a + b\n$";
    const [m] = scanMathRanges(doc);
    expect(m.multiline).toBe(true);
    expect(m.body).toBe("a + b");
    expect(m.display).toBe(true);
  });

  it("一行多个公式按顺序全部识别", () => {
    const doc = "$a$ 与 $b$";
    expect(scanMathRanges(doc).map((m) => m.body)).toEqual(["a", "b"]);
  });

  it("转义 \\$ 不是定界符", () => {
    const doc = "价格 \\$5 元";
    expect(scanMathRanges(doc)).toEqual([]);
  });

  it("代码区 / 字符串 / 注释 / 原始文本里的 $ 不算公式", () => {
    expect(scanMathRanges('#let s = "$5"')).toEqual([]);
    expect(scanMathRanges("// $x$")).toEqual([]);
    expect(scanMathRanges("`$x$`")).toEqual([]);
    // 代码行里的 `$`（`#let` 语句整体是代码区）
    expect(scanMathRanges("#let a = b * c $ d")).toEqual([]);
  });

  it("未闭合的 $ 跳过（宁可漏渲染）", () => {
    expect(scanMathRanges("只有开头 $x + 1")).toEqual([]);
    expect(scanMathRanges("$a$ 未闭合 $b")).toHaveLength(1);
  });

  it("空公式（$$ / $  $）跳过", () => {
    expect(scanMathRanges("$$")).toEqual([]);
    expect(scanMathRanges("前 $  $ 后")).toEqual([]);
  });

  it("公式内可含转义反斜杠与代码（#x）", () => {
    const doc = "$a \\ b$ 与 $#x$";
    expect(scanMathRanges(doc).map((m) => m.body)).toEqual(["a \\ b", "#x"]);
  });
});

describe("mathCacheKey / selectionTouchesRange", () => {
  it("缓存键区分风格与前缀，但不区分公式出现位置", () => {
    expect(mathCacheKey("x", false, "")).toBe(mathCacheKey("x", false, ""));
    expect(mathCacheKey("x", false, "")).not.toBe(mathCacheKey("x", true, ""));
    expect(mathCacheKey("x", false, "")).not.toBe(mathCacheKey("x", false, "#set text(size: 20pt)"));
  });

  it("光标落在范围内（含两端）→ 展开源码", () => {
    const range = { from: 2, to: 7 }; // $x^2$ 占 [2,7)
    expect(selectionTouchesRange(range, [{ from: 0, to: 0 }])).toBe(false);
    expect(selectionTouchesRange(range, [{ from: 1, to: 1 }])).toBe(false);
    expect(selectionTouchesRange(range, [{ from: 2, to: 2 }])).toBe(true);
    expect(selectionTouchesRange(range, [{ from: 5, to: 5 }])).toBe(true);
    expect(selectionTouchesRange(range, [{ from: 7, to: 7 }])).toBe(true);
    expect(selectionTouchesRange(range, [{ from: 8, to: 8 }])).toBe(false);
  });

  it("选区与范围相交 → 展开；仅在范围两侧则不相交", () => {
    const range = { from: 2, to: 7 };
    expect(selectionTouchesRange(range, [{ from: 0, to: 2 }])).toBe(true);
    expect(selectionTouchesRange(range, [{ from: 0, to: 1 }])).toBe(false);
    expect(selectionTouchesRange(range, [{ from: 7, to: 9 }])).toBe(true);
    expect(selectionTouchesRange(range, [{ from: 8, to: 9 }])).toBe(false);
    // 多光标：任一命中即展开
    expect(selectionTouchesRange(range, [{ from: 0, to: 1 }, { from: 4, to: 4 }])).toBe(true);
  });
});
