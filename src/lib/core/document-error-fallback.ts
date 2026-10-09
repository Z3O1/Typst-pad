// 只修复本轮排版输入，绝不改写编辑器文档。每轮重新诊断，修复后自动退出回退。
import { Text } from "@codemirror/state";
import { sourceRevealRange } from "./document-interaction";
import { projectEmptyParagraphs } from "./document-empty-paragraphs";
import {
  mergeProjectionRanges,
  projectDocumentRanges,
  sourceDiagnostics,
  type DocumentProjection,
  type ProjectionRange,
  type SourceRange,
} from "./document-projection";
import type { CompileFail, CompileResult } from "./typst-engine";

export interface DocumentCompileResult {
  result: CompileResult;
  projection: DocumentProjection;
  failure: CompileFail | null;
  errorRanges: SourceRange[];
  editingRange: SourceRange | null;
  deferred?: boolean;
}

// sourceDiagnostics 已把主文档列换成 UTF-16，不能再次按 Unicode 字符换算。
function position(source: Text, line: number, col: number): number | null {
  if (line < 1 || line > source.lines || col < 1) return null;
  const row = source.line(line);
  return row.from + Math.min(col - 1, row.length);
}

export async function compileDocumentWithFallback(options: {
  source: string;
  prefixLength: number;
  reveal: SourceRange | null;
  // 已经点击编辑的错误区域：修复后仍排版为源码，直到退出该区域。
  editing?: SourceRange | null;
  recover: boolean;
  emptyParagraphs?: boolean;
  styleExpansion?: boolean;
  previewExpansion?: boolean;
  compile: (source: string) => Promise<CompileResult>;
  isCurrent: () => boolean;
  // 在途编译允许结束，但后续恢复轮次必须尊重调度器的输入法暂停。
  canRetry?: () => boolean;
}): Promise<DocumentCompileResult> {
  const { source, prefixLength, reveal, recover, compile, isCurrent } = options;
  const editing =
    recover && options.editing && options.editing.to > options.editing.from
      ? options.editing
      : null;
  // 整段正文回退不再执行其内容，避免修好后复制一遍正常输出再显示整段源码。
  const editingProjection: ProjectionRange | null = editing
    ? {
        ...editing,
        preserveDeclaration: editing.from !== prefixLength || editing.to !== source.length,
      }
    : null;
  let ranges: ProjectionRange[] = reveal ? [reveal] : [];
  let errorRanges: ProjectionRange[] = [];
  let failure: CompileFail | null = null;
  let sourceText: Text | null = null;
  const project = (ranges: ProjectionRange[]) => {
    const projection = projectDocumentRanges(source, ranges, {
      styled: options.styleExpansion,
      preview: options.previewExpansion,
    });
    return options.emptyParagraphs ? projectEmptyParagraphs(projection, prefixLength) : projection;
  };
  for (let attempt = 0; ; attempt++) {
    const projection = project(ranges);
    const result = await compile(projection.source);
    if (result.ok) {
      if (result.warnings) result.warnings = sourceDiagnostics(projection, result.warnings);
      if (editing && editingProjection) {
        const expanded = project([...ranges, editingProjection]);
        if (expanded.source !== projection.source) {
          if (isCurrent() && options.canRetry && !options.canRetry())
            return {
              result,
              projection,
              failure,
              errorRanges,
              editingRange: editing,
              deferred: true,
            };
          if (isCurrent()) {
            const visible = await compile(expanded.source);
            if (visible.ok) {
              if (visible.warnings)
                visible.warnings = sourceDiagnostics(expanded, visible.warnings);
              return {
                result: visible,
                projection: expanded,
                failure,
                errorRanges,
                editingRange: editing,
              };
            }
          }
          // 原文已有效；手动保留源码若不可排版，不制造投影专属的错误诊断。
          return { result, projection, failure, errorRanges, editingRange: null };
        }
      }
      return { result, projection, failure, errorRanges, editingRange: editing };
    }
    result.errors = sourceDiagnostics(projection, result.errors);
    const first = result.errors[0];
    if (first) result.error = `${first.message} (行 ${first.line}, 列 ${first.col})`;
    if (!failure) failure = { ...result, errors: [...result.errors] };
    else {
      for (const error of result.errors) {
        if (!failure.errors.some((item) => JSON.stringify(item) === JSON.stringify(error)))
          failure.errors.push(error);
      }
    }
    const stop = () => ({ result, projection, failure, errorRanges, editingRange: editing });
    if (!recover || !isCurrent() || !result.errors.length) return stop();
    const additions: ProjectionRange[] = [];
    const doc = source.slice(prefixLength);
    for (const error of result.errors) {
      // 前缀在设置中编辑，导入文件不属于编辑器；不猜测它们在正文里的位置。
      if (error.path) continue;
      sourceText ??= Text.of(source.split("\n"));
      const from = position(sourceText, error.line, error.col);
      const to = position(sourceText, error.endLine, error.endCol);
      if (from === null || to === null || from < prefixLength) continue;
      const start = sourceRevealRange(doc, from - prefixLength, true);
      const end = sourceRevealRange(doc, Math.max(from, to - 1) - prefixLength, true);
      const range = {
        from: prefixLength + Math.min(start.from, end.from),
        to: prefixLength + Math.max(start.to, end.to),
        preserveDeclaration: false,
      };
      // 未闭合 raw 等语法错误可能指向末尾空行，仍需显示正文源码来修复。
      additions.push(
        range.to > range.from
          ? range
          : {
              from: prefixLength,
              to: source.length,
              preserveDeclaration: false,
            },
      );
    }
    if (!additions.some((range) => range.to > range.from)) return stop();
    if (options.canRetry && !options.canRetry()) return stop();
    const next = mergeProjectionRanges([...errorRanges, ...additions]);
    // 残缺语法可能没有完整表达式边界；局部替换仍失败时安全退回整段正文。
    // 有限重试避免错误声明造成大量级联调用，使编译调度长期被占用。
    if (attempt >= 7 || JSON.stringify(next) === JSON.stringify(errorRanges)) {
      if (
        errorRanges.length === 1 &&
        errorRanges[0].from === prefixLength &&
        errorRanges[0].to === source.length
      )
        return stop();
      errorRanges = [{ from: prefixLength, to: source.length, preserveDeclaration: false }];
    } else errorRanges = next;
    ranges = mergeProjectionRanges([
      ...(reveal ? [reveal] : []),
      ...(editingProjection ? [editingProjection] : []),
      ...errorRanges,
    ]);
  }
}
