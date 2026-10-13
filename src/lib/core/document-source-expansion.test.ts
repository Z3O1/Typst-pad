import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  resolveSourceExpansion as resolve,
  sameSourceRange,
  type SourceExpansion,
} from "./document-source-expansion";

const doc = "前文 $a + b$ 中间 #text[嵌套 $c + d$ 与 #strong[粗体]] 后文";
const math = { from: doc.indexOf("$a"), to: doc.indexOf("$a") + "$a + b$".length };
const code = { from: doc.indexOf("#text"), to: doc.indexOf(" 后文") };
const empty: SourceExpansion = { range: null, error: null };
const expanded: SourceExpansion = { range: math, error: null };
const at = (head: number, previousHead = head, anchor = head) => ({ head, previousHead, anchor });

describe("光标主导的源码展开", () => {
  it("# 语法空白和结束分号都展开，跨出完整代码边界才收起", () => {
    const source = "正文 #let x = 1 /* 注释 */ ; 后文";
    const range = { from: source.indexOf("#"), to: source.indexOf(";") + 1 };
    const active = { range, error: null };
    for (let head = range.from; head < range.to; head++)
      expect(resolve(source, empty, at(head, head - 1), "move")).toEqual(active);
    expect(resolve(source, active, at(range.to, range.to - 1), "move")).toEqual(empty);
    expect(resolve(source, empty, at(range.to, range.to + 1), "move")).toEqual(active);
  });
  it("数学中的 # 和代码中的公式遵循所在语法模式，不单独替换内部子串", () => {
    for (const [source, head] of [
      ["前文 $a + #sym.beta$ 后文", 10],
      ["前文 #let value = $a + b$; 后文", 18],
    ] as const) {
      const range = source.startsWith("前文 $")
        ? { from: 3, to: source.lastIndexOf("$") + 1 }
        : { from: 3, to: source.indexOf(";") + 1 };
      expect(resolve(source, empty, at(head, head - 1), "move")).toEqual({ range, error: null });
    }
  });
  it("普通空段与空段占位不属于 # 或数学语法模式", () => {
    for (const source of ["正文\n\n\n\n后文", "\u00a0\n\n正文"])
      expect(resolve(source, empty, at(source.indexOf("\n") + 1), "move")).toBe(empty);
  });
  it("进入表达式打开完整范围，普通文字不展开", () => {
    expect(resolve(doc, empty, at(math.from + 1, math.from), "move")).toEqual(expanded);
    expect(resolve(doc, empty, at(1, 0), "move")).toBe(empty);
  });
  it("向右进入起点，向左进入终点；反方向跨出就收起", () => {
    expect(resolve(doc, empty, at(math.from, math.from - 1), "move")).toEqual(expanded);
    expect(resolve(doc, empty, at(math.to, math.to + 1), "move")).toEqual(expanded);
    expect(resolve(doc, expanded, at(math.to, math.to - 1), "move")).toEqual(empty);
    expect(resolve(doc, expanded, at(math.from, math.from + 1), "move")).toEqual(empty);
  });
  it("内部移动不重建状态或范围，远距离离开直接收起", () => {
    expect(resolve(doc, expanded, at(math.from + 2, math.from + 1), "move")).toBe(expanded);
    expect(resolve(doc, expanded, at(doc.length, math.from + 2), "move")).toEqual(empty);
  });
  it("直接切换到另一表达式，不经过额外的空展开状态", () => {
    expect(resolve(doc, expanded, at(code.from + 2, math.from + 2), "move")).toEqual({
      range: code,
      error: null,
    });
  });
  it("父范围展开后进入内层公式/调用仍保持父范围", () => {
    const parent = { range: code, error: null };
    for (const head of [doc.indexOf("c +"), doc.indexOf("strong")])
      expect(resolve(doc, parent, at(head, head - 1), "move")).toBe(parent);
  });
  it("边界输入或残缺语法继续保留已映射的编辑范围", () => {
    expect(resolve(doc, expanded, at(math.to, math.to - 1), "edit")).toBe(expanded);
    const broken = doc.slice(0, math.to - 1) + doc.slice(math.to);
    const mapped = { range: { from: math.from, to: math.to - 1 }, error: null };
    expect(resolve(broken, mapped, at(math.to - 1), "edit")).toBe(mapped);
  });
  it("输入新公式可自动展开；删空范围后不保留无效编辑锁", () => {
    const inserted = "正文 $$";
    expect(resolve(inserted, empty, at(inserted.length - 1), "edit")).toEqual({
      range: { from: 3, to: 5 },
      error: null,
    });
    expect(
      resolve("", { range: { from: 0, to: 0 }, error: { from: 0, to: 0 } }, at(0), "edit"),
    ).toEqual(empty);
  });
  it("非空正反向选区冻结布局，收拢选区再按活动端切换", () => {
    for (const cursor of [
      at(doc.length, math.from, math.from),
      at(math.from, doc.length, doc.length),
    ])
      expect(resolve(doc, expanded, cursor, "move")).toBe(expanded);
    expect(resolve(doc, expanded, at(doc.length, doc.length), "move")).toEqual(empty);
  });
  it("合成与外部文档恢复不抢占光标或切换布局", () => {
    expect(resolve(doc, expanded, at(doc.length), "edit", { composing: true })).toBe(expanded);
    expect(resolve(doc, expanded, at(doc.length), "restore")).toBe(expanded);
  });
  it("点击空白不展开邻近表达式，已展开范围内空白不收起", () => {
    expect(resolve(doc, empty, at(math.to), "click", { whitespace: true })).toBe(empty);
    expect(resolve(doc, expanded, at(math.to), "click", { whitespace: true })).toBe(expanded);
    expect(resolve(doc, expanded, at(doc.length), "click", { whitespace: true })).toEqual(empty);
    expect(resolve(doc, empty, at(math.to), "click")).toEqual(expanded);
  });
  it("键盘进入错误区建立编辑锁，修好但光标没离开时继续保留", () => {
    const error = { range: null, error: math };
    expect(resolve(doc, empty, at(math.from + 2), "move", { errors: [math] })).toEqual(error);
    expect(resolve(doc, error, at(math.from + 3, math.from + 2), "move", { errors: [] })).toBe(
      error,
    );
    expect(resolve(doc, error, at(math.to, math.to - 1), "move")).toEqual(empty);
  });
  it("错误范围变化时锁采用当前范围，不让修复后的旧边界提前收起", () => {
    const grown = { from: math.from, to: code.to };
    const state = { range: null, error: math };
    const next = resolve(doc, state, at(math.from + 2), "edit", { errors: [grown] });
    expect(next.error).toEqual(grown);
    expect(resolve(doc, next, at(code.from + 2), "edit", { errors: [] })).toBe(next);
    const shrunk = resolve(doc, next, at(math.from + 2), "edit", { errors: [math] });
    expect(shrunk.error).toEqual(math);
  });
  it("错误锁退出不被手动展开阻断，错误源优先于手动展开", () => {
    expect(resolve(doc, { range: code, error: math }, at(code.from + 2), "move")).toEqual({
      range: code,
      error: null,
    });
    expect(resolve(doc, expanded, at(math.from + 2), "explicit", { errors: [math] })).toEqual({
      range: null,
      error: math,
    });
  });
  it("相邻公式共享边界时按方向直接选择左/右表达式", () => {
    const adjacent = "$a$#strong[b]";
    expect(resolve(adjacent, empty, at(3, 2), "move").range).toEqual({
      from: 3,
      to: adjacent.length,
    });
    expect(resolve(adjacent, empty, at(3, 4), "move").range).toEqual({ from: 0, to: 3 });
  });
  it("坐标相同的范围复用当前对象，不造成重复编译", () => {
    expect(sameSourceRange(null, null)).toBe(true);
    expect(sameSourceRange(math, { ...math })).toBe(true);
    expect(sameSourceRange(math, null)).toBe(false);
    const locked = { range: null, error: math };
    expect(resolve(doc, locked, at(math.from + 2), "move", { errors: [{ ...math }] })).toBe(locked);
  });
});

describe("标题光标展开状态机", () => {
  const source = "前文\n== 中文🙂 $x$ 与 #strong[粗体] \t\n后文\n=== ";
  const heading = { from: source.indexOf("=="), to: source.indexOf("\n后文") };
  const second = { from: source.lastIndexOf("==="), to: source.length };
  const active: SourceExpansion = { range: heading, error: null };

  it("点击与左右进入共用完整标题边界，跨出边界收起", () => {
    const head = source.indexOf("中文");
    expect(resolve(source, empty, at(head), "click")).toEqual(active);
    expect(resolve(source, empty, at(head, head - 1), "move")).toEqual(active);
    expect(resolve(source, empty, at(heading.from, heading.from - 1), "move")).toEqual(active);
    expect(resolve(source, empty, at(heading.to, heading.to + 1), "move")).toEqual(active);
    expect(resolve(source, active, at(heading.to, heading.to - 1), "move")).toEqual(empty);
    expect(resolve(source, active, at(heading.from, heading.from + 1), "move")).toEqual(empty);
    expect(resolve(source, active, at(source.indexOf("后文")), "click")).toEqual(empty);
  });

  it("标题展开后进入嵌套代码或数学不缩小父范围，未展开时仍取最小范围", () => {
    for (const head of [source.indexOf("x"), source.indexOf("strong"), source.indexOf("粗体")]) {
      expect(resolve(source, active, at(head, head - 1), "move")).toBe(active);
      const child = resolve(source, empty, at(head), "click").range;
      expect(child).not.toBeNull();
      expect(child!.from).toBeGreaterThan(heading.from);
      expect(child!.to).toBeLessThan(heading.to);
    }
    const parent = { range: { from: 0, to: source.length }, error: null };
    expect(resolve(source, parent, at(heading.from + 1), "move")).toBe(parent);
  });

  it("点击标题行末空白不打开邻居，已有标题内空白保持展开", () => {
    for (const head of [heading.to - 1, heading.to, second.to]) {
      expect(resolve(source, empty, at(head), "click", { whitespace: true })).toBe(empty);
    }
    expect(resolve(source, active, at(heading.to), "click", { whitespace: true })).toBe(active);
    expect(resolve(source, active, at(second.to), "click", { whitespace: true })).toEqual(empty);
    expect(resolve(source, active, at(second.to), "click")).toEqual({ range: second, error: null });
  });

  it("空标题的行末可直接进入；从旧标题切换无需中间收起", () => {
    expect(resolve(source, empty, at(second.to), "edit")).toEqual({ range: second, error: null });
    expect(resolve(source, active, at(second.from, heading.to), "move")).toEqual({
      range: second,
      error: null,
    });
  });

  it("标题选区和合成期间冻结，最终光标决定范围；恢复不自动展开", () => {
    for (const cursor of [
      at(second.to, heading.from, heading.from),
      at(heading.from, second.to, second.to),
    ])
      expect(resolve(source, active, cursor, "move")).toBe(active);
    expect(resolve(source, active, at(second.to), "edit", { composing: true })).toBe(active);
    expect(resolve(source, active, at(second.to), "edit")).toEqual({ range: second, error: null });
    expect(resolve(source, empty, at(heading.from + 1), "restore")).toBe(empty);
    expect(resolve(source, active, at(second.to), "restore")).toBe(active);
  });

  it("真实编辑事务映射标题边界与 UTF-16 光标，反向事务恢复同一源码范围", () => {
    const state = EditorState.create({ doc: source });
    const transaction = state.update({
      changes: [
        { from: 0, insert: "前置🙂\n" },
        { from: heading.to, insert: "补充🙂" },
      ],
    });
    const edited = transaction.state.doc.toString();
    const mapped = {
      range: {
        from: transaction.changes.mapPos(heading.from, -1),
        to: transaction.changes.mapPos(heading.to, 1),
      },
      error: null,
    };
    expect(edited.slice(mapped.range.from, mapped.range.to)).toBe(
      source.slice(heading.from, heading.to) + "补充🙂",
    );
    expect(resolve(edited, mapped, at(mapped.range.to), "edit")).toBe(mapped);
    const reversed = transaction.state.update({ changes: transaction.changes.invert(state.doc) });
    const restored = {
      range: {
        from: reversed.changes.mapPos(mapped.range.from, -1),
        to: reversed.changes.mapPos(mapped.range.to, 1),
      },
      error: null,
    };
    expect(reversed.state.doc.toString()).toBe(source);
    expect(restored).toEqual(active);
    expect(resolve(source, restored, at(heading.to), "edit")).toBe(restored);
  });

  it("删除完整标题后不保留零宽编辑范围；残缺标题输入仍可打开", () => {
    const state = EditorState.create({ doc: source });
    const transaction = state.update({ changes: { from: heading.from, to: heading.to } });
    const head = transaction.changes.mapPos(heading.from, -1);
    const mapped = { range: { from: head, to: head }, error: null };
    expect(resolve(transaction.state.doc.toString(), mapped, at(head), "edit")).toEqual(empty);
    for (const incomplete of ["=", "== ", "=== *未完成"])
      expect(resolve(incomplete, empty, at(incomplete.length), "edit")).toEqual({
        range: { from: 0, to: incomplete.length },
        error: null,
      });
  });
});
