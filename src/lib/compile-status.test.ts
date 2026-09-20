// 编译派生状态（状态栏文案 / 徽标计数 / 波浪线 / 字符数）单元测试。
//
// 这段逻辑原来在 +page.svelte 的整页预览与块级切片两条路径里各写一遍，且只在真机编译时才能
// 看到效果。这里把四条分支的用户可见结果全部钉住：
//   成功无警告 / 成功带警告（原样 + 截断 + 字体族中文化）/ 失败有定位错误 / 失败只有非定位错误。
import { describe, it, expect } from "vitest";
import { reduceCompileStatus, type CompileStatusSource } from "./compile-status";
import { formatCompileFailMessage } from "./error-list";
import type { CompileErrorLocation, Diagnostic } from "./typst-engine";

const error = (over: Partial<CompileErrorLocation> = {}): CompileErrorLocation => ({
  message: "示例错误",
  line: 3,
  col: 2,
  endLine: 3,
  endCol: 6,
  ...over,
});

const warning = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  message: "示例警告",
  severity: "warning",
  line: 1,
  column: 1,
  ...over,
});

describe("成功：无警告", () => {
  const patch = reduceCompileStatus({ ok: true, pageCount: 4 }, 123);

  it("状态栏回到「就绪」，错误与警告都清空", () => {
    expect(patch).toEqual({
      ok: true,
      pageCount: 4,
      charCount: 123,
      editorDiagnostics: [],
      errorCount: 0,
      compileWarnings: [],
      lastNonPosError: null,
      statusText: "就绪",
    });
  });

  it("warnings 字段缺失（旧后端 / 桩）等价于空数组", () => {
    expect(reduceCompileStatus({ ok: true, pageCount: 1 }, 0).compileWarnings).toEqual([]);
    expect(
      reduceCompileStatus({ ok: true, pageCount: 1, warnings: undefined }, 0).compileWarnings,
    ).toEqual([]);
  });
});

describe("成功：带警告", () => {
  it("第一条警告顶掉「就绪」（字体族写错只有这里看得见）", () => {
    const patch = reduceCompileStatus(
      { ok: true, pageCount: 2, warnings: [warning({ message: "unknown font family: 微软雅黑" })] },
      10,
    );
    expect(patch.ok && patch.statusText.startsWith("警告：未知字体族「微软雅黑」")).toBe(true);
  });

  it("多条警告只展示第一条，但全部留在徽标列表里", () => {
    const patch = reduceCompileStatus(
      {
        ok: true,
        pageCount: 1,
        warnings: [warning({ message: "第一条" }), warning({ message: "第二条" })],
      },
      5,
    );
    expect(patch.statusText).toBe("警告：第一条");
    expect(patch.compileWarnings.map((w) => w.message)).toEqual(["第一条", "第二条"]);
  });

  it("长警告按 70 字截断（别把状态栏挤变形；截断算上「警告：」前缀，与旧行为一致）", () => {
    const patch = reduceCompileStatus(
      { ok: true, pageCount: 1, warnings: [warning({ message: "x".repeat(200) })] },
      5,
    );
    expect(patch.statusText).toBe(`警告：${"x".repeat(67)}…`);
    expect(patch.statusText.length).toBe(71); // 70 字 + 省略号
  });

  it("成功时错误计数/波浪线一律清空，非定位错误也清掉", () => {
    const patch = reduceCompileStatus({ ok: true, pageCount: 1, warnings: [] }, 7);
    expect(patch.ok && patch.errorCount).toBe(0);
    expect(patch.ok && patch.editorDiagnostics).toEqual([]);
    expect(patch.ok && patch.lastNonPosError).toBeNull();
  });

  it("字符数取的是传入的当前文档长度", () => {
    const patch = reduceCompileStatus({ ok: true, pageCount: 1 }, 4321);
    expect(patch.ok && patch.charCount).toBe(4321);
  });
});

describe("失败：有定位错误", () => {
  const errors = [error(), error({ line: 9, col: 1, message: "第二个" })];
  const patch = reduceCompileStatus({ ok: false, error: "编译失败", errors }, 50);

  it("状态栏写「N 处」，波浪线逐条给出", () => {
    expect(patch).toEqual({
      ok: false,
      editorDiagnostics: errors,
      errorCount: 2,
      compileWarnings: [],
      lastNonPosError: null,
      statusText: "编译错误：2 处",
    });
  });

  it("有定位错误时非定位错误不单独记（同源，浮层里不重复展示）", () => {
    const p = reduceCompileStatus({ ok: false, error: "另有非定位错误", errors }, 50);
    expect(p.ok === false && p.lastNonPosError).toBeNull();
  });

  it("失败时**不带页数与字符数**（保留上一次成功预览，调用方不许改）", () => {
    expect("pageCount" in patch).toBe(false);
    expect("charCount" in patch).toBe(false);
  });

  it("失败时清空警告（错误优先，避免两套提示打架）", () => {
    const p = reduceCompileStatus({ ok: false, error: "x", errors }, 1);
    expect(p.compileWarnings).toEqual([]);
  });
});

describe("失败：只有非定位错误", () => {
  it("状态栏带原因（包不存在这类），并单独记进 lastNonPosError", () => {
    const patch = reduceCompileStatus(
      { ok: false, error: "包不存在：@preview/foo:1.0.0", errors: [] },
      8,
    );
    expect(patch).toEqual({
      ok: false,
      editorDiagnostics: [],
      errorCount: 0,
      compileWarnings: [],
      lastNonPosError: "包不存在：@preview/foo:1.0.0",
      statusText: formatCompileFailMessage(0, "包不存在：@preview/foo:1.0.0"),
    });
    expect(patch.statusText).toBe("编译错误：包不存在：@preview/foo:1.0.0");
    // 退化输入：失败但 `error` 是空串（IPC 抛了没有 message 的异常）时仍回到「编译错误：0 处」，
    // 与拆分前的内联写法逐字一致 —— 别让状态栏只剩一个冒号（`编译错误：`）
    expect(reduceCompileStatus({ ok: false, error: "", errors: [] }, 0).statusText).toBe(
      "编译错误：0 处",
    );
  });

  it("超长错误原因按 120 字截断（formatCompileFailMessage 的约定）", () => {
    const long = "e".repeat(300);
    const patch = reduceCompileStatus({ ok: false, error: long, errors: [] }, 1);
    expect(patch.statusText).toBe(`编译错误：${"e".repeat(120)}…`);
  });
});

describe("两条编译路径共用同一份归约（键集合是契约）", () => {
  // 这两条以前写成"同一入参调两次 reduceCompileStatus 再互比" —— 恒真，锁不住任何东西。
  // 真正会坏的是**键集合**：页面按 patch 的键逐项写状态（+page.svelte 的 applyCompileStatus），
  // 归约多一个键会被静默忽略、少一个键会留下上一轮的旧值，两条编译路径都可能踩。
  it("成功支的键集合与契约逐字相同（多一个键会被页面静默忽略）", () => {
    const patch = reduceCompileStatus(
      { ok: true, pageCount: 3, warnings: [warning({ message: "w" })] },
      11,
    );
    expect(Object.keys(patch).sort()).toEqual(
      [
        "ok",
        "pageCount",
        "charCount",
        "editorDiagnostics",
        "errorCount",
        "compileWarnings",
        "lastNonPosError",
        "statusText",
      ].sort(),
    );
    expect(patch).toMatchObject({
      ok: true,
      pageCount: 3,
      charCount: 11,
      editorDiagnostics: [],
      errorCount: 0,
      compileWarnings: [warning({ message: "w" })],
      lastNonPosError: null,
    });
    expect(patch.statusText).toMatch(/^警告：/); // 成功但有警告时不写「就绪」
  });

  it("失败支**不带** pageCount / charCount（页面据此保留上一次成功预览的页数与字符数）", () => {
    const patch = reduceCompileStatus({ ok: false, error: "e", errors: [error()] }, 2);
    expect("pageCount" in patch).toBe(false);
    expect("charCount" in patch).toBe(false);
    expect(patch).toEqual({
      ok: false,
      editorDiagnostics: [error()],
      errorCount: 1,
      compileWarnings: [],
      lastNonPosError: null,
      statusText: "编译错误：1 处",
    });
  });

  it("形状来源可判别：BlocksUnavailable 这种没有 error/errors 的结果传不进来", () => {
    // 编译期保证（见 CompileStatusSource 的注释）：这里只留一条运行期可读的断言，
    // 说明"后端没有 compile_blocks 命令"必须走退回整页预览那条路，而不是当成编译失败。
    const unavailable = { ok: false, unavailable: true } as const;
    expect("error" in unavailable).toBe(false);
    const source: CompileStatusSource = { ok: false, error: "x", errors: [] };
    expect(reduceCompileStatus(source, 0).ok).toBe(false);
  });
});
