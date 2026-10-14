import { describe, it, expect, vi } from "vitest";
import { parser } from "codemirror-lang-typst/lezer";
import {
  closedMathRangeAt,
  nearestPageCoordinates,
  pageCoordinates,
  sourceRevealRange,
} from "./document-interaction";

describe("整页交互", () => {
  it("闭合数学范围使用当前语法树，不把转义、raw 或代码中的 $ 当闭合公式", () => {
    for (const source of ["$a$ 后文", "$$正文", "$\na\n$ "])
      expect(closedMathRangeAt(source, 0, parser.parse(source))).toEqual({
        from: 0,
        to: source.lastIndexOf("$") + 1,
      });
    for (const source of ["$a", "$a\\$", "`$a$`", "#let a = $x$;"])
      expect(closedMathRangeAt(source, 0)).toBeNull();
    const changed = "$a + b$ 后文";
    expect(closedMathRangeAt(changed, 0, parser.parse("$a$"))).toEqual({ from: 0, to: 7 });
  });
  it("缩放与滚动后的页面坐标沿用原始 viewBox", () => {
    expect(
      pageCoordinates(
        { x: 135, y: 220 },
        { left: 10, top: -30, width: 250, height: 500 },
        { x: 0, y: 0, width: 500, height: 1000 },
      ),
    ).toEqual({ xPt: 250, yPt: 500 });
    expect(
      pageCoordinates(
        { x: 0, y: 0 },
        { left: 0, top: 0, width: 0, height: 1 },
        { x: 0, y: 0, width: 5, height: 5 },
      ),
    ).toBeNull();
  });
  it("纸张外侧空白保留页外坐标，按垂直距离选择不同纸型的页面", () => {
    const pages = [
      {
        rect: { left: 100, top: -100, width: 180, height: 200 },
        box: { x: 0, y: 0, width: 360, height: 400 },
      },
      {
        rect: { left: 100, top: 110, width: 240, height: 150 },
        box: { x: 5, y: 10, width: 480, height: 300 },
      },
    ];
    expect(nearestPageCoordinates({ x: 350, y: 0 }, pages)).toEqual({
      page: 1,
      xPt: 500,
      yPt: 200,
    });
    expect(nearestPageCoordinates({ x: 50, y: 150 }, pages)).toEqual({
      page: 2,
      xPt: -95,
      yPt: 90,
    });
    expect(nearestPageCoordinates({ x: 200, y: 104 }, pages)?.page).toBe(1);
    expect(nearestPageCoordinates({ x: 200, y: 106 }, pages)?.page).toBe(2);
    expect(nearestPageCoordinates({ x: 200, y: -200 }, pages)).toEqual({
      page: 1,
      xPt: 200,
      yPt: -200,
    });
    expect(nearestPageCoordinates({ x: 200, y: 300 }, pages)).toEqual({
      page: 2,
      xPt: 205,
      yPt: 390,
    });
  });
  it("空产物、隐藏页面和非法坐标不生成点击位置，页号不因跳过无效页而变化", () => {
    const hidden = {
      rect: { left: 0, top: 0, width: 0, height: 0 },
      box: { x: 0, y: 0, width: 100, height: 200 },
    };
    const visible = { ...hidden, rect: { left: 0, top: 0, width: 100, height: 200 } };
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [])).toBeNull();
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [hidden])).toBeNull();
    expect(nearestPageCoordinates({ x: NaN, y: 10 }, [visible])).toBeNull();
    expect(nearestPageCoordinates({ x: 5, y: 10 }, [hidden, visible])?.page).toBe(2);
  });
  it("同一文档的诊断与光标移动共用一次解析，编辑后不复用旧树", () => {
    const doc = "缓存测试 #block[中文🙂 #missing()] 后文 $x$";
    const parse = vi.spyOn(parser, "parse");
    try {
      for (let i = 0; i < 100; i++) {
        const range = sourceRevealRange(doc, doc.indexOf("missing"), true);
        expect(doc.slice(range.from, range.to)).toBe("#block[中文🙂 #missing()]");
      }
      expect(parse).toHaveBeenCalledTimes(1);
      const edited = "前缀 " + doc;
      const range = sourceRevealRange(edited, edited.indexOf("missing"), true);
      expect(range.from).toBe(doc.indexOf("#block") + 3);
      expect(parse).toHaveBeenCalledTimes(2);
    } finally {
      parse.mockRestore();
    }
  });
  it("编辑器提供当前增量树时，跨修订定位不再次全文解析", () => {
    const docs = ["增量 $a$", "增量 $ab$", "增量 $abc$"];
    const trees = docs.map((doc) => parser.parse(doc));
    const parse = vi.spyOn(parser, "parse");
    try {
      docs.forEach((doc, i) => {
        const range = sourceRevealRange(doc, doc.indexOf("$") + 1, false, 1, trees[i]);
        expect(doc.slice(range.from, range.to)).toBe(doc.slice(doc.indexOf("$")));
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
  it("公式末尾和多行脚本内容展开完整源码", () => {
    const math = "正文 $x^2 + y$";
    expect(sourceRevealRange(math, math.length)).toEqual({
      from: 3,
      to: math.length,
      kind: "math",
    });
    const script = "前文\n#table(columns: 2,\n [甲],\n [乙])\n后文";
    const range = sourceRevealRange(script, script.indexOf("甲") + 1);
    expect(script.slice(range.from, range.to)).toBe("#table(columns: 2,\n [甲],\n [乙])");
    expect(range.kind).toBe("code");
    expect(sourceRevealRange("\n正文", 0)).toEqual({ from: 0, to: 0, kind: "text" });
  });
});

it("图片调用起点和 Hash 边界展开完整多行脚本", () => {
  const doc = '前文\n#image(\n "a.png",\n width: 60pt,\n)\n后文';
  for (const pos of [doc.indexOf("#"), doc.indexOf("image"), doc.indexOf("width")]) {
    const range = sourceRevealRange(doc, pos);
    expect(range.kind).toBe("code");
    expect(doc.slice(range.from, range.to)).toBe('#image(\n "a.png",\n width: 60pt,\n)');
  }
});

it("按语法覆盖完整 # 代码模式，包含分号、注释和多行空白", () => {
  for (const expression of [
    "#sym.alpha",
    "#(1 + 2)",
    "#let x = 1;",
    "#let x = 1 /* 注释 */ ;",
    "#set text(size: 12pt);",
    "#{\n let x = 1\n\n // 注释\n x\n}",
  ]) {
    const doc = `前文 ${expression} 后文`;
    for (let pos = 3; pos < 3 + expression.length; pos++)
      expect(sourceRevealRange(doc, pos, false, 1)).toEqual({
        from: 3,
        to: 3 + expression.length,
        kind: "code",
      });
    expect(sourceRevealRange(doc, doc.length).kind).toBe("text");
  }
});

it("数学模式中的 # 归属完整公式，代码模式中的公式归属外层代码", () => {
  const math = "前文 $a + #sym.beta$ 后文";
  expect(sourceRevealRange(math, math.indexOf("sym"))).toEqual({
    from: 3,
    to: math.lastIndexOf("$") + 1,
    kind: "math",
  });
  const code = "前文 #let value = $a + b$; 后文";
  for (let pos = code.indexOf("$"); pos <= code.lastIndexOf("$"); pos++)
    expect(sourceRevealRange(code, pos)).toEqual({
      from: 3,
      to: code.indexOf(";") + 1,
      kind: "code",
    });
});

it("嵌套内容块回到 markup，仍可最小展开其中的公式或 # 表达式", () => {
  const doc = "#text[正文 $a + #sym.beta$ 和 #strong[粗体]]";
  const math = sourceRevealRange(doc, doc.indexOf("sym"));
  expect(doc.slice(math.from, math.to)).toBe("$a + #sym.beta$");
  const code = sourceRevealRange(doc, doc.indexOf("strong"));
  expect(doc.slice(code.from, code.to)).toBe("#strong[粗体]");
});

it("未闭合语法仍按 #/$ 模式展开，raw、转义和注释中的同形字符不触发", () => {
  for (const doc of ["#foo(\n 1,\n\n 2", "$a + b", "$$", "#"]) {
    const range = sourceRevealRange(doc, doc.length);
    expect(range).toEqual({ from: 0, to: doc.length, kind: doc.startsWith("#") ? "code" : "math" });
  }
  for (const doc of ["`#foo $x$`", "\\#foo \\$x\\$", "/* #foo $x$ */", "// #foo $x$"])
    expect(sourceRevealRange(doc, doc.indexOf("foo")).kind).toBe("text");
});

describe("标题源码边界", () => {
  it.each(["= 中文🙂标题", "== English heading", "====== 多级 *标题*", "=", "== ", "===\t  "])(
    "真实标题 %j 包含级别标记、正文与行末输入空白，不吞下一行",
    (heading) => {
      const doc = `前文\n  ${heading}\n后文`;
      const from = doc.indexOf("=");
      const to = from + heading.length;
      for (let pos = from; pos < to; pos++)
        expect(sourceRevealRange(doc, pos, false, 1)).toEqual({ from, to, kind: "heading" });
      expect(sourceRevealRange(doc, to)).toEqual({ from, to, kind: "heading" });
      expect(sourceRevealRange(doc, to, false, 1).kind).toBe("text");
      expect(sourceRevealRange(doc, from, false, -1).kind).toBe("text");
      expect(sourceRevealRange(doc, to + 1).kind).toBe("text");
    },
  );

  it.each(["\n", "\r\n", "\n\n", "\r\n\r\n", "\v", "\f", "\u0085", "\u2028", "\u2029"])(
    "行末空白不包含语法识别的换行 %j",
    (newline) => {
      for (const heading of ["== 标题 \t", "== \t"]) {
        const doc = `${heading}${newline}后文`;
        expect(sourceRevealRange(doc, heading.length - 1)).toEqual({
          from: 0,
          to: heading.length,
          kind: "heading",
        });
        expect(sourceRevealRange(doc, doc.indexOf("后文")).kind).toBe("text");
      }
    },
  );

  it.each(["= *未完成", "== $x", "=== #foo(", "= `raw", "== [未完成"])(
    "残缺标题 %j 仍按当前语法树取得安全完整边界",
    (doc) => {
      expect(sourceRevealRange(doc, 0, false, 1)).toEqual({
        from: 0,
        to: doc.length,
        kind: "heading",
      });
    },
  );

  it("多行标题正文中的完整调用不能被截断为一行", () => {
    const heading = "== #block[\n正文🙂\n]";
    const doc = `${heading}\n后文`;
    expect(sourceRevealRange(doc, 1)).toEqual({ from: 0, to: heading.length, kind: "heading" });
    // 未闭合的嵌套模式可能延伸到下一行；不猜测行尾而留下不安全的语法碎片。
    const incomplete = "= *未完成\n后文";
    expect(sourceRevealRange(incomplete, 0, false, 1).to).toBe(incomplete.length);
  });

  it("标题中的代码和数学保持最小安全归属，最外层查询才取完整标题", () => {
    const doc = "== 中文 $a + #sym.beta$ 与 #strong[粗体]";
    for (const [token, expression, kind] of [
      ["sym", "$a + #sym.beta$", "math"],
      ["粗体", "#strong[粗体]", "code"],
    ] as const) {
      const pos = doc.indexOf(token);
      const range = sourceRevealRange(doc, pos);
      expect(range.kind).toBe(kind);
      expect(doc.slice(range.from, range.to)).toBe(expression);
      expect(sourceRevealRange(doc, pos, true)).toEqual({
        from: 0,
        to: doc.length,
        kind: "heading",
      });
    }
  });

  it("代码内容块中的标题取最小标题边界，保留外层代码范围查询", () => {
    const doc = "#block[\n== 子标题🙂 $x$\n正文\n]";
    const from = doc.indexOf("==");
    const to = doc.indexOf("\n正文");
    for (const pos of [from, doc.indexOf("子标题"), doc.indexOf("🙂")])
      expect(sourceRevealRange(doc, pos)).toEqual({ from, to, kind: "heading" });
    expect(sourceRevealRange(doc, doc.indexOf("子标题"), true)).toEqual({
      from: 0,
      to: doc.length,
      kind: "code",
    });
    expect(sourceRevealRange(doc, doc.indexOf("x")).kind).toBe("math");
    const nested = "= #block[\n== 子标题\n]";
    const range = sourceRevealRange(nested, nested.indexOf("子标题"));
    expect(nested.slice(range.from, range.to)).toBe("== 子标题");
  });

  it.each([
    "`= 假标题`",
    "```\n== 假标题\n```",
    "// = 假标题",
    "/*\n== 假标题\n*/",
    "\\= 假标题",
    "===未加空格",
    "正文 = 非标题",
    "$ = x $",
    '#let title = "= 假标题";',
    "#{ let x = 1; x == 1 }",
    "- 列表",
  ])("raw、注释、转义、代码与其他正文 %j 不误认标题", (doc) => {
    for (let pos = 0; pos <= doc.length; pos++)
      expect(sourceRevealRange(doc, pos).kind).not.toBe("heading");
  });

  it("标题定位也复用编辑器当前增量树，不使用其他修订的边界", () => {
    const docs = ["= 标题", "== 标题🙂", "=== 标题🙂\n后文"];
    const trees = docs.map((doc) => parser.parse(doc));
    const parse = vi.spyOn(parser, "parse");
    try {
      docs.forEach((doc, index) => {
        expect(sourceRevealRange(doc, 0, false, 1, trees[index])).toEqual({
          from: 0,
          to: doc.split("\n")[0].length,
          kind: "heading",
        });
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });
});
