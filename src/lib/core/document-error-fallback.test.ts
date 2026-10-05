import { describe, expect, it, vi } from "vitest";
import { compileDocumentWithFallback } from "./document-error-fallback";
import { projectDocumentRanges } from "./document-projection";
import type { CompileErrorLocation, CompileResult } from "./typst-engine";

const ok: CompileResult = { ok: true, svg: "<svg/>", pageCount: 1, geometryId: 42 };
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

  it("修复后的请求从原文重新编译，不保留回退区域", async () => {
    const compile = vi.fn().mockResolvedValue(ok);
    const output = await compileDocumentWithFallback({ ...options("正文 $x^2$"), compile });
    expect(output.failure).toBeNull();
    expect(output.errorRanges).toEqual([]);
    expect(output.projection.source).toBe("正文 $x^2$");
  });
});
