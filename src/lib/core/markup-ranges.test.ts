// 常用标记（标题 / 粗体 / 斜体 / 行内代码 / 列表符号）扫描的单元测试。
import { describe, it, expect } from "vitest";
import { scanMarkupDecorations } from "./markup-ranges";
import { scanMathRanges } from "./math-ranges";

/** 便捷断言：取某类装饰的标记文本与正文文本 */
function parts(doc: string) {
  return scanMarkupDecorations(doc).map((d) => ({
    kind: d.kind,
    level: d.level,
    markers: d.markers.map((m) => doc.slice(m.from, m.to)),
    content: doc.slice(d.content.from, d.content.to),
  }));
}

describe("scanMarkupDecorations", () => {
  it("标题：`= 标题` → 隐藏 `= `，正文加样式并带级别", () => {
    expect(parts("= 一级标题")).toEqual([
      { kind: "heading", level: 1, markers: ["= "], content: "一级标题" },
    ]);
    expect(parts("=== 三级标题")).toEqual([
      { kind: "heading", level: 3, markers: ["=== "], content: "三级标题" },
    ]);
  });

  it("不带空格的 `=` 不是标题（如 `=1` 是普通文本）", () => {
    expect(parts("=1 不是标题")).toEqual([]);
  });

  it("粗体：`*粗*` → 隐藏两侧 `*`，正文加粗样式", () => {
    expect(parts("这是 *重点* 内容")).toEqual([
      { kind: "strong", level: undefined, markers: ["*", "*"], content: "重点" },
    ]);
  });

  it("斜体：`_斜_` → 隐藏两侧 `_`", () => {
    expect(parts("这是 _强调_ 内容")).toEqual([
      { kind: "emph", level: undefined, markers: ["_", "_"], content: "强调" },
    ]);
  });

  it("行内原始文本：`` `code` `` → 隐藏反引号，正文等宽样式", () => {
    expect(parts("运行 `npm test` 即可")).toEqual([
      { kind: "raw-inline", level: undefined, markers: ["`", "`"], content: "npm test" },
    ]);
  });

  it("多行原始文本（``` 围栏）走块级结构（见下方专门用例）", () => {
    const blocks = scanMarkupDecorations("```\ncode\n```");
    expect(blocks.map((d) => d.kind)).toEqual(["raw-block"]);
  });

  it("无序列表符号替换为圆点，有序列表（`+`）不动", () => {
    expect(parts("- 条目一")).toEqual([
      { kind: "list-marker", level: undefined, markers: ["- "], content: "条目一" },
    ]);
    // `+` 是编号列表：符号替换为序号（编号规则见下方专门用例）
    expect(parts("+ 条目一")).toEqual([
      { kind: "list-marker", level: undefined, markers: ["+ "], content: "条目一" },
    ]);
    const withText = scanMarkupDecorations("- 条目一")[0].markers[0].text;
    expect(withText).toBe("• ");
  });

  it("代码 / 注释 / 字符串里的标记不算标记", () => {
    expect(parts("#let a = b * c * d")).toEqual([]);
    expect(parts("// *注释* 里的星号")).toEqual([]);
    expect(parts('#let s = "*不是粗体*"')).toEqual([]);
  });

  it("公式里的 `*`、`_` 不算标记（数学乘号 / 下标）", () => {
    expect(parts("$a * b$")).toEqual([]);
    expect(parts("$x_1 + y_2$")).toEqual([]);
    // 公式外的同样是标记
    expect(parts("$a*b$ 与 *粗体*").map((p) => p.kind)).toEqual(["strong"]);
  });

  it("跨行的 `*` 不识别为粗体（保守）", () => {
    expect(parts("*跨\n行*")).toEqual([]);
  });

  it("内侧带空格的 `*` 不是粗体（typst 的词边界要求）", () => {
    expect(parts("* 不是粗体 *")).toEqual([]);
  });

  it("多个标记按位置升序返回", () => {
    const doc = "= 标题\n正文 *粗* 与 _斜_ 与 `码`";
    expect(parts(doc).map((p) => p.kind)).toEqual(["heading", "strong", "emph", "raw-inline"]);
  });
});

describe("scanMarkupDecorations 链接", () => {
  it('`#link("url")[文字]` → 隐藏 link 调用与方括号，只留文字', () => {
    const doc = '见 #link("https://typst.app")[官网] 说明';
    expect(parts(doc)).toEqual([
      {
        kind: "link",
        level: undefined,
        markers: ['#link("https://typst.app")', "[", "]"],
        content: "官网",
      },
    ]);
  });

  it('无内容块的 `#link("url")` 不装饰（没有可显示的链接文字）', () => {
    expect(parts('#link("https://typst.app")')).toEqual([]);
  });

  it("普通代码里的 link 字样不装饰", () => {
    expect(parts('#let l = link("x")')).toEqual([]);
  });
});

describe("scanMarkupDecorations 有序列表编号", () => {
  it("`+ ` 连续项按 1. 2. 编号", () => {
    const doc = "+ 甲\n+ 乙\n+ 丙";
    expect(scanMarkupDecorations(doc).map((d) => d.markers[0]?.text)).toEqual([
      "1. ",
      "2. ",
      "3. ",
    ]);
  });

  it("被正文隔开的两个列表各自从 1 开始", () => {
    const doc = "+ 甲\n+ 乙\n\n正文\n\n+ 丙";
    expect(scanMarkupDecorations(doc).map((d) => d.markers[0]?.text)).toEqual([
      "1. ",
      "2. ",
      "1. ",
    ]);
  });

  it("不同缩进的有序列表分别计数", () => {
    const doc = "+ 甲\n  + 子甲\n  + 子乙\n+ 乙";
    expect(scanMarkupDecorations(doc).map((d) => d.markers[0]?.text)).toEqual([
      "1. ",
      "1. ",
      "2. ",
      "2. ",
    ]);
  });

  it("无序列表仍替换为圆点（不受编号影响）", () => {
    const doc = "- 甲\n+ 乙";
    expect(scanMarkupDecorations(doc).map((d) => d.markers[0]?.text)).toEqual(["• ", "1. "]);
  });
});

describe("scanMarkupDecorations 代码块（``` 围栏）", () => {
  const doc = "前文\n\n```typ\n#let x = 1\n  let y = 2\n```\n\n后文\n";

  it("整段（含围栏行）作为块级结构返回，代码去掉围栏与公共缩进", () => {
    const blocks = scanMarkupDecorations(doc).filter((d) => d.kind === "raw-block");
    expect(blocks).toHaveLength(1);
    // 顶层代码块的公共缩进是 0，内容原样保留
    expect(blocks[0].block?.code).toBe("#let x = 1\n  let y = 2");
    // 整段范围覆盖围栏行本身（块级替换要整行，否则会漏出反引号）
    expect(doc.slice(blocks[0].block!.from, blocks[0].block!.to)).toBe(
      "```typ\n#let x = 1\n  let y = 2\n```",
    );
  });

  it("整体缩进的代码块剔除公共缩进（与 typst 渲染一致）", () => {
    const indented = "前文\n\n  ```\n  #let a = 1\n    let b = 2\n  ```\n";
    const blocks = scanMarkupDecorations(indented).filter((d) => d.kind === "raw-block");
    expect(blocks[0].block?.code).toBe("#let a = 1\n  let b = 2");
  });

  it("围栏行旁边还有文字时不整段替换（避免盖掉正文）", () => {
    const inline = "文字 ```\ncode\n``` 文字";
    expect(scanMarkupDecorations(inline).filter((d) => d.kind === "raw-block")).toHaveLength(0);
  });

  it("单个反引号的行内代码不受影响", () => {
    const blocks = scanMarkupDecorations("行内 `code` 与\n\n```\n块\n```\n");
    expect(blocks.filter((d) => d.kind === "raw-inline")).toHaveLength(1);
    expect(blocks.filter((d) => d.kind === "raw-block")).toHaveLength(1);
  });
});

describe("区域极多时的判定（二分相交检查的功能守护）", () => {
  it("数百个 code/公式区域下，只标记真正的粗体", () => {
    // 每行一个 #let（code 区）+ 一个公式 + 一个粗体：区域表上千条
    const doc = Array.from(
      { length: 200 },
      (_, i) => `#let v${i} = ${i}\n$v${i}$ 与 *粗${i}* 与 _斜${i}_\n`,
    ).join("");
    const marks = scanMarkupDecorations(doc);
    expect(marks.filter((m) => m.kind === "strong")).toHaveLength(200);
    expect(marks.filter((m) => m.kind === "emph")).toHaveLength(200);
    // 没有标记落在公式区间内部（`$v0$` 里的下划线/星号等不该被当成标记）
    const math = scanMathRanges(doc);
    const insideMath = marks.filter((m) =>
      math.some((x) => m.content.from >= x.from && m.content.to <= x.to),
    );
    expect(insideMath.map((m) => m.kind)).toEqual([]);
  });

  it("粗体/斜体与公式、代码区紧邻时不被误判", () => {
    const doc = "$a*b$ 与 *真粗* 与 `c*d` 与 _真斜_";
    // 行内原始文本本身是一条合法装饰（反引号收起），此处只关心粗/斜没被公式与代码带偏
    expect(scanMarkupDecorations(doc).map((m) => m.kind)).toEqual(["strong", "raw-inline", "emph"]);
    const strong = scanMarkupDecorations(doc)[0];
    expect(doc.slice(strong.content.from, strong.content.to)).toBe("真粗");
  });
});
