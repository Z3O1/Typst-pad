// 文档扫描缓存（报告 T3 / P1）的单元测试。
//
// 这一版要防的回归：**纯选区移动 / 滚动**又去全文重扫。判据是 CodeMirror 的 `Text` 对象身份
// （不可变、结构共享），所以"同一份文档"在选区事务里必须是同一个对象 —— 这条如果被改坏，
// 缓存就永远不命中，滚动时每帧重扫一整篇（40k 文档实测 6.4ms/次）。
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { docScanStats, resetDocScanCache, scanDocument } from "./doc-scan";

describe("scanDocument：文档扫描缓存", () => {
  beforeEach(() => resetDocScanCache());

  it("同一份文档 + 同一前缀：第二次直接命中（连数组都不重建）", () => {
    const state = EditorState.create({ doc: "= 标题\n\n公式 $x^2$\n" });
    const first = scanDocument(state, "");
    const second = scanDocument(state, "");
    expect(second).toBe(first);
    expect(docScanStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("**纯选区移动**不重扫（报告 T3：选区变化不该触发全文词法扫描）", () => {
    const state = EditorState.create({ doc: "第一段 $x^2$\n\n第二段\n" });
    scanDocument(state, "");
    const moved = state.update({ selection: { anchor: 2 } }).state;
    const scan = scanDocument(moved, "");
    expect(scan.math.map((m) => m.body)).toContain("x^2");
    expect(docScanStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("文档变了 → 重扫（`Text` 身份变了）", () => {
    const state = EditorState.create({ doc: "abc" });
    scanDocument(state, "");
    const edited = state.update({ changes: { from: 0, insert: "x" } }).state;
    scanDocument(edited, "");
    expect(docScanStats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it("前缀变了 → 重扫（编译上下文与公式缓存键都跟着变）", () => {
    const state = EditorState.create({ doc: "#let a = 1\n\n$ a $" });
    scanDocument(state, "");
    const scan = scanDocument(state, "#let b = 2\n");
    expect(scan.prefix).toBe("#let b = 2\n");
    expect(docScanStats()).toMatchObject({ misses: 2 });
  });

  it("一次算齐：docString / opaque / math / context 都来自同一次快照", () => {
    const state = EditorState.create({ doc: "#let R = 1\n\n正文 $x^2$ 与 `code`\n" });
    const scan = scanDocument(state, "");
    expect(scan.docString).toContain("$x^2$");
    expect(scan.math.map((m) => m.body)).toContain("x^2");
    expect(scan.context).toContain("#let R = 1");
    expect(scan.opaque.some((r) => r.kind === "raw")).toBe(true);
  });
});
