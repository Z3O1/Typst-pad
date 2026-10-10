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
import type { CompileFail, CompileOk, CompileResult } from "./typst-engine";

export interface DocumentCompileResult {
  result: CompileResult;
  // 只记录源码字节与原文完全相同的编译，绝不从展示投影猜测原文语义。
  originalResult: CompileResult | null;
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

interface DocumentCompileOptions {
  source: string;
  prefixLength: number;
  reveal: SourceRange | null;
  // 调用方只可提供同一源码/会话/上下文修订的原文成功结果。
  validatedOriginal?: CompileOk | null;
  // 已经点击编辑的错误区域：修复后仍排版为源码，直到退出该区域。
  editing?: SourceRange | null;
  recover: boolean;
  emptyParagraphs?: boolean;
  styleExpansion?: boolean;
  previewExpansion?: boolean;
  compile: (source: string) => Promise<CompileResult>;
  // 需要自然纸型时，compile也必须无页面注入；已有原文结果优先复用，否则至多测量一次。
  measureOriginal?: (source: string) => Promise<CompileResult>;
  isCurrent: () => boolean;
  // 在途编译允许结束，但后续恢复轮次必须尊重调度器的输入法暂停。
  canRetry?: () => boolean;
}

export async function compileDocumentWithFallback(
  options: DocumentCompileOptions,
): Promise<DocumentCompileResult> {
  let originalResult: CompileResult | null = null;
  let originalAttempted = false;
  let deferred = false;
  // 展开可能改变 show 上下文或隐藏原文错误；同一修订先验证原文，再排版展示。
  // 此结果也复用为自然纸型测量，失败直接驱动恢复，不再编译同一坏表达式的预览。
  if (options.reveal && options.isCurrent()) {
    if (options.canRetry && !options.canRetry()) {
      return {
        result: { ok: false, error: "编译已暂停", errors: [] },
        originalResult: null,
        projection: projectDocumentRanges(options.source, []),
        failure: null,
        errorRanges: [],
        editingRange: options.editing ?? null,
        deferred: true,
      };
    } else {
      originalAttempted = true;
      originalResult =
        options.validatedOriginal ??
        (await (options.measureOriginal ?? options.compile)(options.source));
      if (!options.isCurrent() || (options.canRetry && !options.canRetry())) {
        return {
          result: originalResult,
          originalResult: null,
          projection: projectDocumentRanges(options.source, []),
          failure: originalResult.ok ? null : originalResult,
          errorRanges: [],
          editingRange: options.editing ?? null,
          deferred: true,
        };
      }
    }
  }
  const output = await compileProjectedDocument({
    ...options,
    initialFailure: originalResult && !originalResult.ok ? originalResult : null,
    compile: async (source) => {
      if (
        source !== options.source &&
        options.measureOriginal &&
        !originalAttempted &&
        options.isCurrent()
      ) {
        if (options.canRetry && !options.canRetry()) deferred = true;
        else {
          originalAttempted = true;
          originalResult = await options.measureOriginal(options.source);
          // 自然测量先于展示编译；过期或合成暂停后不再启动旧投影。
          if (!options.isCurrent()) return originalResult;
          if (options.canRetry && !options.canRetry()) {
            deferred = true;
            return originalResult;
          }
        }
      }
      const result = await options.compile(source);
      if (source === options.source) {
        originalAttempted = true;
        originalResult = result;
      }
      return result;
    },
  });
  return {
    ...output,
    originalResult: !deferred && options.isCurrent() ? originalResult : null,
    ...(deferred ? { deferred: true } : {}),
  };
}

async function compileProjectedDocument(
  options: DocumentCompileOptions & { initialFailure?: CompileFail | null },
): Promise<Omit<DocumentCompileResult, "originalResult">> {
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
    const seeded = attempt === 0 ? options.initialFailure : null;
    const projection = seeded ? projectDocumentRanges(source, []) : project(ranges);
    const result = seeded ?? (await compile(projection.source));
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
      // 内容块中的局部表达式可以安全 raw，不把正常外层正文也展开。
      // 局部恢复仍失败时才扩大到外层；最终整正文回退仍有严格轮数上限。
      const outermost = attempt > 0;
      const start = sourceRevealRange(doc, from - prefixLength, outermost);
      const end = sourceRevealRange(doc, Math.max(from, to - 1) - prefixLength, outermost);
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
