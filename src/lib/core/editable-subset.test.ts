import { describe, expect, it } from "vitest";
import {
  decideTextBlockEditing,
  overlapsComplexExcept,
  overlapsComplexRegion,
} from "./editable-subset";
import { scanAllowedInlineCode } from "./markup-ranges";
import type { EditDecisionInput } from "./editable-subset";
import { scanNonMarkupRegions } from "./typst-lex";
import type { Block } from "./block-plan";

/** 造一个块；`edit` 缺省 = 旧后端（没有证明通道） */
function block(geo: Partial<Block> = {}): EditDecisionInput["block"] {
  return {
    from: 0,
    to: 0,
    kind: "Paragraph",
    found: true,
    skipped: false,
    noOutput: false,
    heightPt: 10,
    ...geo,
  };
}

/** 用文档与块区间算一次决策（复制真实的调用口径）；`edit` 缺省 = 没有证明通道 */
function decide(doc: string, b: EditDecisionInput["block"], edit?: Block["edit"]) {
  const withProof = edit === undefined ? b : { ...b, edit };
  return decideTextBlockEditing({
    block: withProof,
    source: doc.slice(b.from, b.to),
    opaque: scanNonMarkupRegions(doc),
  });
}

const verified = (source: string) => ({ verdict: "verified" as const, reason: "ok", source });
const unknown = (source: string, reason = "gap") => ({
  verdict: "unknown" as const,
  reason,
  source,
});

describe("decideTextBlockEditing：正常案例", () => {
  it("纯文字段落与标题在证明成立时可以直接编辑", () => {
    const doc = "= 标题\n\n正文一段。";
    const heading = block({ from: 0, to: 4, kind: "Heading" });
    const para = block({ from: 6, to: doc.length });
    const d1 = decide(doc, heading, verified(doc.slice(0, 4)));
    expect(d1).toMatchObject({ editable: true, reason: "editable" });
    expect(d1).toMatchObject({ syntax: "simple", text: "verified", geometry: "ok", fresh: true });
    expect(decide(doc, para, verified(doc.slice(6))).editable).toBe(true);
  });

  it("引号是 markup：写了一对引号的正文照样能编辑", () => {
    const doc = '他说"你好"，然后走了。';
    const b = block({ from: 0, to: doc.length });
    expect(decide(doc, b, verified(doc)).editable).toBe(true);
  });

  it("行内公式不改变段落资格（公式由 math decoration 局部替换）", () => {
    const doc = "正文 $a^2 + b^2$ 收尾。";
    const b = block({ from: 0, to: doc.length });
    expect(decide(doc, b, verified(doc)).editable).toBe(true);
  });

  it("证明字段缺失（旧后端 / 只给几何的桩）退回旧的语法判据", () => {
    const doc = "正文一段。";
    const b = block({ from: 0, to: doc.length });
    const d = decide(doc, b);
    expect(d).toMatchObject({ editable: true, text: "no-proof", reason: "editable" });
  });
});

describe("decideTextBlockEditing：反例（推翻资格判据）", () => {
  it("呈现文字证不出来（换字 / 宏展开 / 重复输出）→ 退回切片", () => {
    const doc = "这里本来写着苹果两个字。";
    const b = block({ from: 0, to: doc.length });
    const d = decide(doc, b, unknown(doc));
    expect(d).toMatchObject({ editable: false, reason: "text-unknown", text: "unknown" });
  });

  it("旧结果不得为新文档授权：证明里的源码与当前区间不一致 → 不可编辑", () => {
    const doc = "这是新文档的正文。";
    const b = block({ from: 0, to: doc.length });
    const d = decide(doc, b, verified("这是旧文档的正文。"));
    expect(d).toMatchObject({ editable: false, reason: "text-stale", fresh: false });
    // 资格变化不得改变源码：决策是纯函数，输入没有被就地修改
    expect(doc).toBe("这是新文档的正文。");
  });

  it("段内有单 LF 的段落不可直接编辑（Typst 当空白连排）", () => {
    const doc = "第一行，\n第二行。";
    const b = block({ from: 0, to: doc.length });
    expect(decide(doc, b, verified(doc))).toMatchObject({ editable: false, reason: "multi-line" });
  });

  it("含行内 raw / 注释的块仍走切片", () => {
    const raw = "正文里有 `code` 一段。";
    expect(decide(raw, block({ from: 0, to: raw.length }), verified(raw))).toMatchObject({
      editable: false,
      reason: "complex",
    });
    const comment = "正文 // 注释";
    expect(
      decide(comment, block({ from: 0, to: comment.length }), verified(comment)),
    ).toMatchObject({ editable: false, reason: "complex" });
  });

  it("公式块 / 代码块不可直接编辑", () => {
    const doc = "$ x + y $";
    expect(
      decide(doc, block({ from: 0, to: doc.length, kind: "Equation" }), verified(doc)),
    ).toMatchObject({ editable: false, reason: "not-text-kind", syntax: "unsupported" });
    expect(
      decide(doc, block({ from: 0, to: doc.length, kind: "Raw" }), verified(doc)),
    ).toMatchObject({ editable: false, reason: "not-text-kind" });
  });

  it("取不到引擎标记的列表项不可直接编辑（不许用近似编号冒充）", () => {
    const doc = "- 列表项";
    expect(
      decide(doc, block({ from: 0, to: doc.length, kind: "ListItem" }), verified(doc)),
    ).toMatchObject({ editable: false, reason: "list-unsupported", syntax: "unsupported" });
  });

  it("没有几何 / 被有意跳过 / 无输出的块不可直接编辑", () => {
    const doc = "正文。";
    const len = doc.length;
    expect(decide(doc, block({ from: 0, to: len, found: false }), verified(doc))).toMatchObject({
      editable: false,
      reason: "no-geometry",
      geometry: "missing",
    });
    expect(decide(doc, block({ from: 0, to: len, skipped: true }), verified(doc))).toMatchObject({
      editable: false,
      reason: "skipped",
    });
    expect(decide(doc, block({ from: 0, to: len, noOutput: true }), verified(doc))).toMatchObject({
      editable: false,
      reason: "no-output",
    });
  });
});

describe("decideTextBlockEditing：简单列表项（任务 2）", () => {
  const bullet = { text: "•", bodyOffsetPt: 9.36 };
  const ordered = { text: "1.", bodyOffsetPt: 11 };

  it("单行、顶格、有引擎标记的 `-` / `+` 项可以直接编辑", () => {
    const doc = "- 第一项";
    const d = decide(
      doc,
      { ...block({ from: 0, to: doc.length, kind: "ListItem" }), listMarker: bullet },
      verified(doc),
    );
    expect(d).toMatchObject({ editable: true, reason: "editable", syntax: "simple" });
    const doc2 = "+ 有序一";
    expect(
      decide(
        doc2,
        { ...block({ from: 0, to: doc2.length, kind: "EnumItem" }), listMarker: ordered },
        verified(doc2),
      ).editable,
    ).toBe(true);
  });

  it("缩进的嵌套项（多源码行 / 有前导空白）不开放", () => {
    const doc = "- 外层\n  - 内层";
    const b = { ...block({ from: 0, to: doc.length, kind: "ListItem" }), listMarker: bullet };
    expect(decide(doc, b, verified(doc))).toMatchObject({
      editable: false,
      reason: "list-unsupported",
      syntax: "unsupported",
    });
    // 有前导空白（嵌套但只有一行）同样不开放
    const nested = "  - 内层";
    expect(
      decide(
        nested,
        { ...block({ from: 0, to: nested.length, kind: "ListItem" }), listMarker: bullet },
        verified(nested),
      ),
    ).toMatchObject({ editable: false, reason: "list-unsupported" });
  });

  it("带内容的简单列表项也要求文字对应已证明", () => {
    const doc = "- 这里本来写着苹果";
    const b = { ...block({ from: 0, to: doc.length, kind: "ListItem" }), listMarker: bullet };
    expect(decide(doc, b, unknown(doc))).toMatchObject({
      editable: false,
      reason: "text-unknown",
    });
  });

  it("含行内公式的列表项走切片（更窄的正文列里公式附近分行不可靠，实测 PKU 两块不一致）", () => {
    const doc = "- 为什么非零元仍有逆：取共轭 $macron(q) = a - b i$ 即可。";
    const b = { ...block({ from: 0, to: doc.length, kind: "ListItem" }), listMarker: bullet };
    expect(decide(doc, b, verified(doc))).toMatchObject({
      editable: false,
      reason: "list-unsupported",
    });
  });

  it("列表项里的行内 raw 仍走切片", () => {
    const doc = "- 有 `code` 的项";
    const b = { ...block({ from: 0, to: doc.length, kind: "ListItem" }), listMarker: bullet };
    expect(decide(doc, b, verified(doc))).toMatchObject({ editable: false, reason: "complex" });
  });
});

describe("decideTextBlockEditing：简单函数白名单（任务 4）", () => {
  /** 复制真实调用口径：区域表与白名单都由文档现算 */
  function decideWithWhitelist(doc: string, b: EditDecisionInput["block"], source = doc) {
    const opaque = scanNonMarkupRegions(doc);
    return decideTextBlockEditing({
      block: b,
      source,
      opaque,
      allowedCode: scanAllowedInlineCode(doc, opaque),
    });
  }

  it("`#strong[文字]` / `#emph[文字]` 的正文块可以直接编辑", () => {
    const doc = "正文 #strong[加粗] 与 #emph[斜体] 收尾。";
    const b = block({ from: 0, to: doc.length });
    expect(decideWithWhitelist(doc, b)).toMatchObject({ editable: true, reason: "editable" });
  });

  it("其它行内代码 / 自定义函数不开放", () => {
    for (const doc of [
      "正文 #box[内容] 收尾。",
      "正文 #h(1em) 收尾。",
      "正文 #figure([图]) 收尾。",
      "正文 #place(top)[飘] 收尾。",
    ]) {
      expect(decideWithWhitelist(doc, block({ from: 0, to: doc.length }))).toMatchObject({
        editable: false,
        reason: "complex",
      });
    }
  });

  it("白名单调用里夹带别的代码不放行", () => {
    const doc = "正文 #strong[#h(1em)字] 收尾。";
    expect(decideWithWhitelist(doc, block({ from: 0, to: doc.length }))).toMatchObject({
      editable: false,
      reason: "complex",
    });
  });

  it("未闭合的 `#strong[` 不算白名单（保持保守）", () => {
    const doc = "正文 #strong[没闭合";
    expect(decideWithWhitelist(doc, block({ from: 0, to: doc.length }))).toMatchObject({
      editable: false,
      reason: "complex",
    });
  });

  it("白名单只放行**整体落在允许区间里**的 code 区域", () => {
    const doc = "正文 #strong[字] 收尾。";
    const opaque = scanNonMarkupRegions(doc);
    const allowed = scanAllowedInlineCode(doc, opaque);
    const code = opaque.find((r) => r.kind === "code")!;
    expect(overlapsComplexExcept(0, doc.length, opaque, [])).toBe(true);
    expect(overlapsComplexExcept(0, doc.length, opaque, allowed)).toBe(false);
    // 半开区间包含：只允许一部分不算
    expect(
      overlapsComplexExcept(0, doc.length, opaque, [{ from: code.from, to: code.to - 1 }]),
    ).toBe(true);
  });
});

describe("行内原子（任务 3）：引用 / 标签放行，脚注与 raw / 链接仍切片", () => {
  it("带 `@ref` 与 `<label>` 的段落/标题仍可直接编辑（原子不阻塞资格）", () => {
    const para = "见 @sec[p.~7] 一节，后面还有 @sec。";
    expect(decide(para, block({ from: 0, to: para.length }), verified(para)).editable).toBe(true);
    const heading = "= 标题 <sec>";
    expect(
      decide(heading, block({ from: 0, to: heading.length, kind: "Heading" }), verified(heading))
        .editable,
    ).toBe(true);
  });

  it("脚注段落判复杂 → 切片（正文被排到页底，呈现对应不上）", () => {
    const doc = "正文里有脚注#footnote[页底文字]。";
    expect(decide(doc, block({ from: 0, to: doc.length }), verified(doc))).toMatchObject({
      editable: false,
      reason: "complex",
    });
  });

  it("含链接 / 行内 raw 的段落仍切片（呈现来源与揭示规则未定义完）", () => {
    for (const doc of ['看 #link("https://typst.app")[官方文档]。', "正文里有 `code` 一段。"]) {
      expect(decide(doc, block({ from: 0, to: doc.length }), verified(doc))).toMatchObject({
        editable: false,
        reason: "complex",
      });
    }
  });
});

describe("overlapsComplexRegion", () => {
  it("code/raw/comment 算复杂，string（markup 引号）不算", () => {
    const doc = '他说"你好"，然后 `x` 了。';
    const regions = scanNonMarkupRegions(doc);
    // 引号所在的那一段不算复杂
    const quoteAt = doc.indexOf('"');
    expect(overlapsComplexRegion(quoteAt, quoteAt + 1, regions)).toBe(false);
    // 行内 raw 算复杂
    const tickAt = doc.indexOf("`");
    expect(overlapsComplexRegion(tickAt, tickAt + 3, regions)).toBe(true);
  });
});
