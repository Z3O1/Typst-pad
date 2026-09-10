// 随机文档下的鲁棒性测试：三个纯扫描器（区域 / 公式 / 标记）会在**每次按键**时
// 跑在任意用户文本上，必须保证「不抛异常、不越界、区间有序且互不重叠」。
// 用固定种子的伪随机（同一种子结果可复现），覆盖 `$`、反引号、引号、括号、`#`、换行
// 这些会互相打架的字符组合。
import { describe, it, expect } from "vitest";
import { scanNonMarkupRegions, scanMarkupRegions } from "./typst-lex";
import { scanMathRanges } from "./math-ranges";
import { scanMarkupDecorations } from "./markup-ranges";

/** mulberry32：小而确定的 PRNG（不引依赖，种子固定 → 失败可复现） */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符池：全是会与扫描规则相互影响的字符 */
const POOL = [
  "$",
  "`",
  '"',
  "[",
  "]",
  "{",
  "}",
  "(",
  ")",
  "*",
  "_",
  "#",
  "\\",
  "/",
  "=",
  "-",
  "+",
  " ",
  "\n",
  "a",
  "中",
  "1",
  "let",
  "link",
  "text",
  "//",
  "/*",
  "*/",
  "```",
];

function randomDoc(rand: () => number, length: number): string {
  let out = "";
  while (out.length < length) out += POOL[Math.floor(rand() * POOL.length)];
  return out;
}

/** 区间合法性：升序、不重叠、落在文档内、非空 */
function assertOrdered(ranges: { from: number; to: number }[], length: number, label: string) {
  let prevTo = -1;
  for (const r of ranges) {
    expect(Number.isInteger(r.from) && Number.isInteger(r.to), `${label}: 整数区间`).toBe(true);
    expect(r.from, `${label}: from >= 0`).toBeGreaterThanOrEqual(0);
    expect(r.to, `${label}: to <= 文档长度`).toBeLessThanOrEqual(length);
    expect(r.from, `${label}: from < to`).toBeLessThan(r.to);
    expect(r.from, `${label}: 与前一个区间不重叠`).toBeGreaterThanOrEqual(prevTo);
    prevTo = r.to;
  }
}

describe("随机文档鲁棒性", () => {
  it("120 份随机文档：扫描不抛异常且区间合法", () => {
    const rand = prng(20260910);
    for (let i = 0; i < 120; i++) {
      const doc = randomDoc(rand, 40 + Math.floor(rand() * 260));

      const opaque = scanNonMarkupRegions(doc);
      const markup = scanMarkupRegions(doc);
      assertOrdered([...opaque].sort((a, b) => a.from - b.from), doc.length, "opaque");

      // opaque 与 markup 互补且拼起来覆盖全文
      const merged = [...opaque, ...markup].sort((a, b) => a.from - b.from);
      let cursor = 0;
      for (const r of merged) {
        expect(r.from, "区域无缝衔接").toBe(cursor);
        cursor = r.to;
      }
      expect(cursor, "区域覆盖到文档末尾").toBe(doc.length);

      const math = scanMathRanges(doc, opaque);
      assertOrdered(math, doc.length, "math");
      for (const m of math) {
        // 公式区间必须以 `$` 收尾（定界符）
        expect(doc[m.from], "公式以 $ 开头").toBe("$");
        expect(doc[m.to - 1], "公式以 $ 结尾").toBe("$");
        // body 与源码一致：行间公式取 trim 后内容，行内公式原样
        const inner = doc.slice(m.from + 1, m.to - 1);
        expect(m.body, "公式 body 与源码一致").toBe(m.display ? inner.trim() : inner);
      }

      const marks = scanMarkupDecorations(doc, { opaque, math });
      for (const d of marks) {
        for (const mk of d.markers) {
          expect(mk.from, "标记 from 合法").toBeGreaterThanOrEqual(0);
          expect(mk.to, "标记 to 合法").toBeLessThanOrEqual(doc.length);
          expect(mk.from, "标记非空").toBeLessThan(mk.to);
        }
        expect(d.content.from, "正文 from < to").toBeLessThanOrEqual(d.content.to);
        expect(d.content.to).toBeLessThanOrEqual(doc.length);
      }
    }
  });

  it("病态输入（未闭合 / 超长围栏 / 全符号）不挂死也不越界", () => {
    const pathological = [
      "$",
      "$$$$$$$$",
      "`".repeat(200),
      "```".repeat(50),
      "#let x = " + "[".repeat(100),
      "#".repeat(100),
      "*".repeat(100),
      "_".repeat(100),
      '"'.repeat(50),
      "/*".repeat(50),
      "//" + "$x$",
      "$" + "\n".repeat(50) + "$",
      "#link(" + '"'.repeat(20),
      "[".repeat(60) + "]".repeat(60),
      "\\".repeat(80),
    ];
    for (const doc of pathological) {
      const opaque = scanNonMarkupRegions(doc);
      const math = scanMathRanges(doc, opaque);
      const marks = scanMarkupDecorations(doc, { opaque, math });
      assertOrdered(math, doc.length, `math(${JSON.stringify(doc.slice(0, 12))}…)`);
      for (const d of marks) {
        expect(d.content.to).toBeLessThanOrEqual(doc.length);
      }
    }
  });
});
