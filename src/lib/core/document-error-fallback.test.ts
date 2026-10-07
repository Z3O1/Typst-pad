import { describe, expect, it, vi } from "vitest";
import { compileDocumentWithFallback } from "./document-error-fallback";
import { projectDocumentRanges } from "./document-projection";
import type { CompileErrorLocation, CompileResult } from "./typst-engine";

const ok: CompileResult = { ok: true, pages: ["<svg/>"], pageCount: 1, geometryId: 42 };
function fail(source: string, parts: string[], path?: string): CompileResult {
  return {
    ok: false,
    error: "unknown variable",
    errors: parts.map((part): CompileErrorLocation => {
      const at = source.indexOf(part);
      expect(at).toBeGreaterThanOrEqual(0);
      const before = source.slice(0, at);
      const line = before.split("\n").length;
      const col = [...before.slice(before.lastIndexOf("\n") + 1)].length + 1;
      return {
        message: "unknown variable",
        line,
        col,
        endLine: line,
        endCol: col + [...part].length,
        path,
      };
    }),
  };
}
const options = (source: string) => ({
  source,
  prefixLength: 0,
  reveal: null,
  recover: true,
  isCurrent: () => true,
});

describe("文档模式编译错误源码回退", () => {
  it("多个错误只展开对应表达式，保留前缀、正常正文和错误诊断", async () => {
    const prefix = "#set page(width: 300pt)\n";
    const source = prefix + "中文🙂 $unknown$，正文 #missing()\n后文";
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(source, ["unknown", "missing"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({
      ...options(source),
      prefixLength: prefix.length,
      compile,
    });
    expect(compile.mock.calls[1][0]).toBe(
      prefix + "中文🙂 ` $unknown$ `，正文 ` #missing() `\n后文",
    );
    expect(output.result).toEqual(ok);
    expect(output.failure?.errors[0].col).toBe("中文🙂 $".length + 1);
    expect(output.failure?.errors).toHaveLength(2);
    expect(output.errorRanges).toHaveLength(2);
    for (let pos = 0; pos <= source.length; pos++) {
      expect(output.projection.renderedToSource(output.projection.sourceToRendered(pos))).toBe(pos);
    }
  });

  it("错误声明不再执行；失去定义的后续调用也按自己的位置回退", async () => {
    const source = "#let x = unknown\n正常正文 #x";
    const projected = "` #let x = unknown `\n正常正文 #x";
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(source, ["unknown"]))
      .mockResolvedValueOnce(fail(projected, ["#x"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), compile });
    expect(compile.mock.calls[1][0]).toBe(projected);
    expect(compile.mock.calls[2][0]).toBe("` #let x = unknown `\n正常正文 ` #x `");
    expect(output.failure?.errors.map((error) => [error.line, error.col])).toEqual([
      [1, 10],
      [2, 6],
    ]);
  });

  it("嵌套代码整体回退为外层表达式，而不向代码上下文插入 raw", async () => {
    const source = "前文 #block[内容 #missing()] 后文";
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(source, ["missing"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), compile });
    expect(output.projection.source).toBe("前文 ` #block[内容 #missing()] ` 后文");
  });

  it("手动展开与错误区域重叠时，不重复执行错误声明", async () => {
    const source = "#let x = unknown\n#x";
    const reveal = { from: 0, to: source.indexOf("\n") };
    const initial = projectDocumentRanges(source, [reveal]).source;
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(initial, ["unknown"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), reveal, compile });
    expect(output.projection.source).toBe("` #let x = unknown `\n#x");
  });

  it("残缺语法局部回退不能恢复时，有限重试后显示整段正文源码", async () => {
    const source = "正文 #missing()\n后文";
    const local = "正文 ` #missing() `\n后文";
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(source, ["missing"]))
      .mockResolvedValueOnce(fail(local, ["missing"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), compile });
    expect(output.projection.source).toBe("```typ\n" + source + "\n```");
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it("错误指向末尾空行时也能展开未闭合源码，且围栏不提前闭合", async () => {
    const source = "```typ\n";
    const compile = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "unclosed raw",
        errors: [
          {
            message: "unclosed raw",
            line: 2,
            col: 1,
            endLine: 2,
            endCol: 1,
          },
        ],
      })
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), compile });
    expect(output.projection.source).toBe("````typ\n" + source + "\n````");
  });

  it("不可恢复的前缀、外部文件、无位置错误及源码模式不重试", async () => {
    const source = "#missing()\n正文";
    for (const config of [
      { prefixLength: source.indexOf("\n") + 1 },
      { recover: false },
      { external: true },
      { unlocated: true },
    ]) {
      const result = config.unlocated
        ? { ok: false as const, error: "IPC failure", errors: [] }
        : fail(source, ["missing"], config.external ? "other.typ" : undefined);
      const compile = vi.fn().mockResolvedValue(result);
      const output = await compileDocumentWithFallback({ ...options(source), ...config, compile });
      expect(compile).toHaveBeenCalledTimes(1);
      expect(output.result.ok).toBe(false);
      expect(output.errorRanges).toEqual([]);
    }
  });

  it("编辑或切换会话后不继续重试旧输入", async () => {
    const source = "#missing()";
    const compile = vi.fn().mockResolvedValue(fail(source, ["missing"]));
    await compileDocumentWithFallback({ ...options(source), compile, isCurrent: () => false });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("输入法合成期间暂停恢复重试，合成结束后可以重新恢复", async () => {
    const source = "#missing()";
    let composing = true;
    const compile = vi
      .fn()
      .mockImplementation(async (src: string) => (src === source ? fail(source, ["missing"]) : ok));
    const canRetry = vi.fn(() => !composing);
    const request = { ...options(source), compile, canRetry };
    const deferred = await compileDocumentWithFallback(request);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(deferred.result.ok).toBe(false);
    expect(canRetry).toHaveBeenCalledTimes(1);
    composing = false;
    const resumed = await compileDocumentWithFallback(request);
    expect(compile).toHaveBeenCalledTimes(3);
    expect(resumed.result.ok).toBe(true);
  });

  it("正在编辑的错误修好后保留源码，但仍先诊断原文；退出编辑锁才收起", async () => {
    const source = "正文 $x^2$ 后文";
    const editing = { from: source.indexOf("$"), to: source.lastIndexOf("$") + 1 };
    const compile = vi.fn().mockResolvedValue(ok);
    const retained = await compileDocumentWithFallback({ ...options(source), editing, compile });
    expect(compile.mock.calls.map(([src]) => src)).toEqual([source, "正文 ` $x^2$ ` 后文"]);
    expect(retained.failure).toBeNull();
    expect(retained.editingRange).toEqual(editing);
    const closed = await compileDocumentWithFallback({ ...options(source), compile });
    expect(closed.projection.source).toBe(source);
    expect(closed.editingRange).toBeNull();
  });

  it("错误编辑锁不屏蔽诊断；修好的声明展开仍保留作用域", async () => {
    const source = "#let x = unknown\n#x";
    const editing = { from: 0, to: source.indexOf("\n") };
    const compile = vi
      .fn()
      .mockResolvedValueOnce(fail(source, ["unknown"]))
      .mockResolvedValueOnce(ok);
    const output = await compileDocumentWithFallback({ ...options(source), editing, compile });
    expect(output.failure?.errors).toHaveLength(1);
    expect(output.projection.source).toBe("` #let x = unknown `\n#x");
    const fixed = "#let x = 1\n#x";
    const fixedEditing = { from: 0, to: fixed.indexOf("\n") };
    const fixedCompile = vi.fn().mockResolvedValue(ok);
    const repaired = await compileDocumentWithFallback({
      ...options(fixed),
      editing: fixedEditing,
      compile: fixedCompile,
    });
    expect(repaired.projection.source).toBe("#let x = 1\n` #let x = 1 `\n#x");
    expect(repaired.failure).toBeNull();
  });

  it("整段正文的编辑锁修好后不复制正常输出或重新执行整段声明", async () => {
    const source = "#set text(size: 12pt)\n正常正文";
    const editing = { from: 0, to: source.length };
    const compile = vi.fn().mockResolvedValue(ok);
    const output = await compileDocumentWithFallback({ ...options(source), editing, compile });
    expect(output.projection.source).toBe("```typ\n" + source + "\n```");
    expect(output.editingRange).toEqual(editing);
  });

  it("保留源码本身不能排版时，仍使用有效原文且不展示投影专属错误", async () => {
    const source = "#let x = 1\n#x";
    const editing = { from: 0, to: source.indexOf("\n") };
    const expanded = projectDocumentRanges(source, [editing]).source;
    const compile = vi
      .fn()
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(fail(expanded, ["x"]));
    const output = await compileDocumentWithFallback({ ...options(source), editing, compile });
    expect(output.result.ok).toBe(true);
    expect(output.projection.source).toBe(source);
    expect(output.failure).toBeNull();
    expect(output.editingRange).toBeNull();
  });

  it("过期结果和输入法暂停不启动修复后保留源码的额外编译", async () => {
    const source = "$x$";
    const editing = { from: 0, to: source.length };
    for (const gate of [{ isCurrent: () => false }, { canRetry: () => false }]) {
      const compile = vi.fn().mockResolvedValue(ok);
      const result = await compileDocumentWithFallback({
        ...options(source),
        editing,
        compile,
        ...gate,
      });
      expect(compile).toHaveBeenCalledTimes(1);
      if ("canRetry" in gate) {
        expect(result.deferred).toBe(true);
        expect(result.editingRange).toEqual(editing);
      }
    }
  });

  it("修复后的请求从原文重新编译，不保留回退区域", async () => {
    const compile = vi.fn().mockResolvedValue(ok);
    const output = await compileDocumentWithFallback({ ...options("正文 $x^2$"), compile });
    expect(output.failure).toBeNull();
    expect(output.errorRanges).toEqual([]);
    expect(output.projection.source).toBe("正文 $x^2$");
  });
});
