// auto-pair 单元测试：输入 `$` 时的自动配对决策与空配对的整对退格（纯逻辑，无 DOM）。
import { describe, it, expect } from "vitest";
import { emptyPairBackspace, planDollarInput } from "./auto-pair";

/** 便于阅读：把决策压成一行短标签 */
const plan = (doc: string, pos: number) => {
  const p = planDollarInput(doc, pos);
  if (p.kind === "insert") return `insert(${JSON.stringify(p.text)},${p.caret})`;
  if (p.kind === "skip") return `skip(${p.caret})`;
  return "none";
};

describe("planDollarInput（输入 `$` 的配对决策）", () => {
  it("独占一行 → 行间公式脚手架 `$  $`，光标在中间（敲字即 `$ x $`）", () => {
    expect(plan("", 0)).toBe('insert("$  $",2)');
    expect(plan("上一段\n\n下一段", 4)).toBe('insert("$  $",2)');
    // 行内已有的空白不算"有内容"：只有空格的行仍按行间公式处理
    expect(plan("   ", 3)).toBe('insert("$  $",2)');
  });

  it("行内（同行还有别的字）→ 配对 `$$`，光标在中间（敲字即 `$x$`）", () => {
    expect(plan("前文 ", 3)).toBe('insert("$$",1)');
    expect(plan("= 标题", 4)).toBe('insert("$$",1)');
  });

  it("右侧已有闭合 `$` → 跳过，不再插一对（连按两下 `$` 不产生垃圾）", () => {
    // `$|$` 中间再按 `$`：光标移到闭合符之后
    expect(plan("$$", 1)).toBe("skip(1)");
    // 行间脚手架 `$  |  $`：跳过同行空白，光标移到闭合符之后
    expect(plan("$  $", 2)).toBe("skip(2)");
    expect(plan("$  $", 3)).toBe("skip(1)");
    // 公式刚闭合处不算"已在公式内部"：那里再按 `$` 是开新的一对（合理）
    expect(plan("$a$ 后文", 3)).toBe('insert("$$",1)');
  });

  it("**公式内部**但右侧就是闭合符 → 跳过（用户报的 `$ 1 $` → `$1$$`）", () => {
    // 用户原话：「依次按按键 $ 1 $ 后会得到 $1$$」。配对是 `$|$` 起手、敲 `1` 得到 `$1|$`，
    // 那时光标在公式内部，而"公式内部不配对"若排在"右侧已有 `$`"之前就会原样插一个 `$`
    // → `$1$$`（多出来的 `$` 永远不闭合，typst 直接报错）。正确动作是跨过已有的闭合符。
    expect(plan("$1$", 2)).toBe("skip(1)"); // 行内：`$1|$` → 光标到 `$1$|`
    expect(plan("$ 1 $", 3)).toBe("skip(2)"); // 行间脚手架：`$ 1| $` → 跳过空白与闭合符
    expect(plan("前文 $1$", 5)).toBe("skip(1)"); // 同一个位置带前缀也一样（5 = 闭合符之前）
  });

  it("已在公式内部 → 不配对（那里的 `$` 是闭合公式，补一对会插出 `$a + $|$b$`）", () => {
    expect(plan("$a + b$", 5)).toBe("none"); // 光标在 `+` 后、闭合符之前
    expect(plan("正文 $x$ 结尾", 4)).toBe("none"); // 光标在公式体里
  });

  it("代码 / 原始文本 / 注释 / 字符串里 → 不配对", () => {
    expect(plan("#let s = 1", 9)).toBe("none");
    expect(plan('#let s = "abc"', 12)).toBe("none"); // 字符串里
    expect(plan("// 注释内容", 4)).toBe("none");
    expect(plan("`原始文本`", 3)).toBe("none");
    expect(plan("```\ncode $\n```", 6)).toBe("none"); // 围栏代码块里
  });

  it("代码区的紧邻右边界 → 不配对（`#let s = 1|` 时还在写代码）", () => {
    // regionAt 是左闭右开：区域末端的那个位置本身已不算代码，所以要单独挡一道
    expect(plan("#let s = 1", 10)).toBe("none");
    // 代价（已知并接受）：代码表达式后紧跟公式要手打闭合符
    expect(plan("值 #f(1)", 7)).toBe("none");
  });

  it("围栏代码块**之后**回到 markup → 照常配对", () => {
    // doc 共 12 字符："```\ncode\n```"；位置 12 = 收尾围栏之后（raw 区是 [0,12)）
    expect(plan("```\ncode\n```", 12)).toBe('insert("$$",1)');
  });

  it("注释行末尾仍是注释：那里也不配对（按注释处理，不产生语法错误）", () => {
    // 注释右侧没有"代码边界"的概念：光标在注释区内 → 上一类规则已挡（这里是区域末端）
    expect(plan("// 说明文字", 6)).toBe("none");
  });

  it("前面是反斜杠（`\\$` 转义的字面美元号）→ 不配对", () => {
    expect(plan("价格 \\", 4)).toBe("none");
  });

  it("越界位置 → 不配对（防御性，不 panic）", () => {
    expect(plan("abc", -1)).toBe("none");
    expect(plan("abc", 99)).toBe("none");
  });

  it("行内配对后光标在中间：模拟「敲 $ 再敲 x」的完整结果", () => {
    // 用决策结果本身拼出来，锁住"敲一个字就得到 `$x$`"
    const doc = "前文 ";
    const p = planDollarInput(doc, doc.length);
    expect(p.kind).toBe("insert");
    if (p.kind !== "insert") return;
    const next = doc + p.text;
    const caret = doc.length + p.caret;
    const typed = next.slice(0, caret) + "x" + next.slice(caret);
    expect(typed).toBe("前文 $x$");
  });

  it("独占一行时敲一个字得到行间公式 `$ x $`", () => {
    const doc = "";
    const p = planDollarInput(doc, 0);
    expect(p.kind).toBe("insert");
    if (p.kind !== "insert") return;
    const typed = p.text.slice(0, p.caret) + "x" + p.text.slice(p.caret);
    expect(typed).toBe("$ x $");
  });
});

describe("emptyPairBackspace（空配对整对退格）", () => {
  // 返回的是"光标两侧各删几个"：行间脚手架 `$  |  $` 的配对跨在光标两侧，
  // 用一个"向前删 N 个"的总长度会算出负数位置（浏览器实测踩过）。
  it("`$|$` → 两侧各删 1 个（一共 2 个字符）", () => {
    expect(emptyPairBackspace("$$", 1)).toEqual({ before: 1, after: 1 });
    expect(emptyPairBackspace("前文$$后文", 3)).toEqual({ before: 1, after: 1 });
  });

  it("行间脚手架 `$  |  $` → 两侧各删 2 个（一共 4 个字符）", () => {
    expect(emptyPairBackspace("$  $", 2)).toEqual({ before: 2, after: 2 });
  });

  it("配对里已经有内容 → null（走默认退格，不整对删）", () => {
    expect(emptyPairBackspace("$x$", 2)).toBeNull(); // 光标在 x 后
    expect(emptyPairBackspace("$ x $", 3)).toBeNull();
    expect(emptyPairBackspace("$ x $", 2)).toBeNull();
    expect(emptyPairBackspace("$x$", 3)).toBeNull();
  });

  it("相邻成对 `$$$$` 每处都只删自己那一对（不做贪婪匹配）", () => {
    expect(emptyPairBackspace("$$$$", 1)).toEqual({ before: 1, after: 1 });
    expect(emptyPairBackspace("$$$$", 2)).toEqual({ before: 1, after: 1 });
    expect(emptyPairBackspace("$$$$", 3)).toEqual({ before: 1, after: 1 });
  });

  it("普通文本位置 → null（不接管退格）", () => {
    expect(emptyPairBackspace("abc", 2)).toBeNull();
    expect(emptyPairBackspace("", 0)).toBeNull();
    expect(emptyPairBackspace("$", 1)).toBeNull();
    expect(emptyPairBackspace("abc", 99)).toBeNull();
  });
});
