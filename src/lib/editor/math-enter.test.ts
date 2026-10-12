import { describe, expect, it } from "vitest";
import { enterMathRanges, mathContinuationPrefix, mathEnterTree } from "./math-enter";

function prefixAtCaret(marked: string) {
  const pos = marked.indexOf("|");
  const doc = marked.replace("|", "");
  return mathContinuationPrefix(doc, pos, mathEnterTree(doc));
}

describe("mathContinuationPrefix", () => {
  it.each(["  \\ =& ", "\t\\\t&=\t", " \\ = &  ", "\\ & = "])(
    "原样延续行首前缀 %j，不复制数学内容",
    (prefix) => {
      expect(prefixAtCaret(`$\n a\n${prefix}b| + c\n$`)).toBe(prefix);
      expect(prefixAtCaret(`$\n a\n${prefix}b |\n$`)).toBe(prefix);
      expect(prefixAtCaret(`$\n a\n${prefix}b|`)).toBe(prefix);
      expect(prefixAtCaret(`$\n a\n${prefix}b |`)).toBe(prefix);
    },
  );

  it.each([
    "$ \\ =& b| $",
    "$\n a\n b + c|\n$",
    "$\n a\n  \\ +& b|\n$",
    "$\n a\n  \\& = b|\n$",
    "$\n a\n  \\ =& b\n$|",
    "$\n a\n  \\ | =& b\n$",
    "正文\n  \\ =& b|",
    "\\$\n  \\ =& b|\n\\$",
    "```\n$\n  \\ =& b|\n$\n```",
    "// $\n// \\ =& b|\n// $",
    "/* $\n  \\ =& b|\n$ */",
    '#let s = "$\n  \\ =& b|\n$"',
    '$\n  \\ =& "b|"\n$',
    "$\n  \\ =& #f(b|)\n$",
    "$\n  \\ =& #x|\n$",
    "$\n  \\ =& #1|\n$",
    "$\n  \\ =& #`b|`\n$",
    "$\n  \\ =& b // c|\n$",
    "$\n  \\ =& b /* c| */\n$",
  ])("拒绝不受支持或非数学上下文 %j", (marked) => {
    expect(prefixAtCaret(marked)).toBeNull();
  });
});

describe("enterMathRanges", () => {
  it("保留空公式与未闭合范围；字符串、raw、注释和转义的 $ 不是公式", () => {
    expect(enterMathRanges(mathEnterTree("$$ $x"))).toEqual([
      { from: 0, to: 2, closed: true },
      { from: 3, to: 5, closed: false },
    ]);
    expect(enterMathRanges(mathEnterTree("$x \n "))).toEqual([{ from: 0, to: 5, closed: false }]);
    for (const doc of ['#let s = "$x$"', "`$x$`", "// $x$", "/* $x$ */", "\\$x\\$"]) {
      expect(enterMathRanges(mathEnterTree(doc))).toEqual([]);
    }
  });
});
