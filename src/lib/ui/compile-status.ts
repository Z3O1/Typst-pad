// 编译结果 → 状态栏 / 徽标 / 波浪线这一份**派生状态**（从 +page.svelte 的两条编译路径里抽出来）。
//
// 原来这段在 runCompile（整页预览路径）与 applyBlocksResult（块级切片路径）里各写了一遍，
// 是字面量级重复：成功时清错误、有警告就顶掉「就绪」；失败时清警告、非定位错误单独记、
// 状态栏写 N 处。抽出来的直接好处是这些**用户可见字符串与计数**第一次有了单测。
//
// 语义（两条路径必须一致，改动前先读）：
// - 成功：`pageCount` / `charCount` 才更新；`previewStatus` 由调用方置 "ready"。
// - 失败：**不动页数与字符数**（保留上一次成功预览），只把错误与状态栏换掉。
// - 失败时警告清空：错误优先，避免两套提示打架（Rust 失败时本来也不返回 warnings）。

import { formatCompileFailMessage } from "./error-list";
import { describeCompileWarning } from "../core/font-warnings";
import { truncateStatus } from "./status-view";
import type { CompileErrorLocation, Diagnostic } from "../core/typst-engine";

/**
 * 两条编译路径共同的结果子集：整页 `CompileOk` / 块级 `BlocksOk` 都满足成功那一支，
 * `CompileFail` / `BlocksFail` 都满足失败那一支。
 * `BlocksUnavailable`（后端没有这个命令）**不满足** ⇒ 传不进来，只能走退回整页预览那条路。
 */
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
