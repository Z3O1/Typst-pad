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
