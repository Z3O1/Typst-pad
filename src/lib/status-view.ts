// 状态栏的「看数据」层：文案截断、两个浮层的条目组装、复制反馈文案。
// 从 +page.svelte 原样搬出来（行为零改动）。搬的理由：这一层全是纯映射，单测能钉死几条
// 只在真机上才看得见的约定 —— 主源诊断的路径归一、无定位错误什么时候单独成条、
// 复制失败统一一句话、浮层标题与「复制全部」首行是同一份原文。
import { buildErrorListItems, type ErrorListItem } from "./error-list";
import { describeCompileWarning } from "./font-warnings";
import type { CompileErrorLocation, Diagnostic } from "./typst-engine";

/** 复制诊断信息失败时的状态栏文案（execCommand 与 navigator.clipboard 两条路都没成） */
export const COPY_FAILED_NOTICE = "复制失败：剪贴板不可用";

export type DiagnosticKind = "errors" | "warnings";

/** 状态栏单行文案截断（警告可能很长，别把状态栏挤变形） */
export function truncateStatus(text: string, max = 70): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 警告列表条目：有源码位置的可点击跳转（消息已翻成中文可行动提示），否则纯展示 */
export function buildWarningItems(warnings: Diagnostic[]): ErrorListItem[] {
  return warnings.map((w) =>
    w.line > 0
      ? {
          kind: "located" as const,
          message: describeCompileWarning(w.message),
          line: w.line,
          col: w.column,
          // 复制时把路径贴在行列前面（include/import 的文件给其路径；主源没有）
          path: w.path ?? undefined,
        }
      : { kind: "generic" as const, message: describeCompileWarning(w.message) },
  );
}

/** 错误浮层当前的条目（复制/渲染共用一份来源，避免"复制的和看到的不一致"） */
export function buildErrorItems(
  diagnostics: CompileErrorLocation[],
  lastNonPosError: string | null,
): ErrorListItem[] {
  return buildErrorListItems(diagnostics, lastNonPosError);
}

/** 单条「复制」的状态栏反馈 */
export function diagnosticCopyStatus(kind: DiagnosticKind, ok: boolean): string {
  if (!ok) return COPY_FAILED_NOTICE;
  return kind === "errors" ? "已复制错误信息" : "已复制警告信息";
}

/** 「复制全部」的状态栏反馈 */
export function diagnosticCopyAllStatus(kind: DiagnosticKind, count: number, ok: boolean): string {
  if (!ok) return COPY_FAILED_NOTICE;
  return kind === "errors" ? `已复制全部 ${count} 处错误` : `已复制全部 ${count} 处警告`;
}

/** 浮层标题原文（也是「复制全部」的第一行） */
export function diagnosticListTitle(kind: DiagnosticKind, count: number): string {
  return kind === "errors" ? `编译错误（${count} 处）` : `编译警告（${count} 处）`;
}
