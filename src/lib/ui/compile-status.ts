// 完整编译结果转换成状态栏、徽标与源码诊断；失败保留上次成功页数。
import { formatCompileFailMessage } from "./error-list";
import { describeCompileWarning } from "../core/font-warnings";
import { truncateStatus } from "./status-view";
import type { CompileErrorLocation, Diagnostic } from "../core/typst-engine";

export type CompileStatusSource =
  | { ok: true; pageCount: number; warnings?: Diagnostic[] }
  | { ok: false; error: string; errors: CompileErrorLocation[] };

export type CompileStatusPatch =
  | {
      ok: true;
      pageCount: number;
      charCount: number;
      /** 编译成功：波浪线清空 */
      editorDiagnostics: [];
      errorCount: 0;
      compileWarnings: Diagnostic[];
      lastNonPosError: null;
      statusText: string;
    }
  | {
      ok: false;
      /** 失败时不带 pageCount / charCount：调用方保留上一次成功的页数与字符数 */
      editorDiagnostics: CompileErrorLocation[];
      errorCount: number;
      compileWarnings: [];
      lastNonPosError: string | null;
      statusText: string;
    };

/**
 * 算这份派生状态。`docLength` 是**当前文档**长度（状态栏右侧的字符数，只在成功时更新）。
 *
 * 失败时 `lastNonPosError` 只在"一条定位错误都没有"时才有值：定位错误存在时非定位错误与
 * 第一条同源，浮层里不重复展示（见 error-list.buildErrorListItems）。
 */
export function reduceCompileStatus(
  result: CompileStatusSource,
  docLength: number,
): CompileStatusPatch {
  if (result.ok) {
    // 编译警告（典型：unknown font family）必须可见——typst 对写错的字体族名只发 warning
    // 然后静默改用其他字体，不显示出来用户只会看到"改了字体没用"（见 font-warnings.ts）
    const warnings = result.warnings ?? [];
    return {
      ok: true,
      pageCount: result.pageCount,
      charCount: docLength,
      editorDiagnostics: [],
      errorCount: 0,
      compileWarnings: warnings,
      lastNonPosError: null,
      statusText:
        warnings.length > 0
          ? truncateStatus(`警告：${describeCompileWarning(warnings[0].message)}`)
          : "就绪",
    };
  }
  const hasLocated = result.errors.length > 0;
  return {
    ok: false,
    editorDiagnostics: result.errors,
    errorCount: result.errors.length,
    compileWarnings: [],
    // 非定位错误（如包不存在 / 访问模型异常）单独记录，供徽标弹窗展示
    lastNonPosError: hasLocated ? null : result.error,
    // 非定位错误必须可见；`error` 为空串时仍回到「编译错误：0 处」——与拆分前逐字一致
    statusText: hasLocated
      ? `编译错误：${result.errors.length} 处`
      : result.error
        ? formatCompileFailMessage(0, result.error)
        : `编译错误：${result.errors.length} 处`,
  };
}
