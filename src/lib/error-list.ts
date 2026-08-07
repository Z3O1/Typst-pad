// 编译错误列表与前缀定位的纯函数工具（不依赖 wasm / tauri，可单元测试）。
import type { CompileErrorLocation } from "./typst-engine";

/** 可定位错误条目：点击可跳转编辑器对应行列 */
export interface LocatedErrorItem {
  kind: "located";
  message: string;
  line: number;
  col: number;
}

/** 非定位错误条目（如包不存在）：仅展示，不可跳转 */
export interface GenericErrorItem {
  kind: "generic";
  message: string;
}

export type ErrorListItem = LocatedErrorItem | GenericErrorItem;

/** 非定位错误是否存在（空字符串视为无内容，不展示）；类型谓词供调用方收窄 */
function hasNonPosError(nonPos: string | null): nonPos is string {
  return nonPos !== null && nonPos !== "";
}

/**
 * 组装弹窗列表：定位错误逐条 + （无定位错误时的）非定位错误；
 * 空数组则弹窗不可开。定位错误存在时非定位错误与其同源，不重复展示。
 */
export function buildErrorListItems(
  errors: CompileErrorLocation[],
  nonPos: string | null,
): ErrorListItem[] {
  if (errors.length > 0) {
    return errors.map((e) => ({
      kind: "located",
      message: e.message,
      line: e.line,
      col: e.col,
    }));
  }
  if (hasNonPosError(nonPos)) {
    return [{ kind: "generic", message: nonPos }];
  }
  return [];
}

/** 定位项返回 "行 {line}, 列 {col}"；generic 项返回 "—" */
export function formatErrorLoc(item: ErrorListItem): string {
  if (item.kind === "located") return `行 ${item.line}, 列 ${item.col}`;
  return "—";
}

/** 徽标可点击条件：errorCount > 0 或存在非定位错误 */
export function hasErrorToShow(errorCount: number, nonPos: string | null): boolean {
  return errorCount > 0 || hasNonPosError(nonPos);
}

/**
 * 编译失败的状态栏文案：errorCount>0 → "编译错误：N 处"；否则 →
 * "编译错误：" + error（截断到 ~120 字符，防状态栏溢出）。
 * （自 typst-libs 迁移，typst-libs 已随 wasm 链路删除）
 */
export function formatCompileFailMessage(errorCount: number, error: string): string {
  if (errorCount > 0) return `编译错误：${errorCount} 处`;
  const msg = error.length > 120 ? error.slice(0, 120) + "…" : error;
  return `编译错误：${msg}`;
}

// ---------------------------------------------------------------------------
// 前缀代码行号定位（需求 #6：错误落在前缀代码内时，打开设置定位到对应行）
// ---------------------------------------------------------------------------

/**
 * 前缀代码占用的总行数（1-based 行号语义下，第 1..N 行均属于前缀）。
 * 按 split("\n") 计行：空串视为 1 行、末尾换行不额外计行。
 */
export function prefixLineCount(prefixCode: string): number {
  return prefixCode.split("\n").length;
}

/**
 * 错误行号是否落在前缀代码内（仅应在 prefixEnabled 时调用）。
 * 行号语义：编译源（prefixCode + doc）的 1-based 行号。
 * 前缀以换行结尾时，split 计出的"末行"是空行——编译源里该位置已是用户文档第 1 行，
 * 不算前缀（此前按 prefixLineCount 含入导致用户第 1 行的错误被误判为前缀错误）。
 * 前缀未以换行结尾时最后一行与用户第 1 行拼接在同一行，行级判定整行按前缀处理
 * （保守；编辑器波浪线用 diagnostics-utils.mapCompiledPosToDoc 做列级精确判定）。
 */
export function isErrorLineInPrefix(line: number, prefixCode: string): boolean {
  const boundary = prefixLineCount(prefixCode) - (prefixCode.endsWith("\n") ? 1 : 0);
  return line >= 1 && line <= boundary;
}

/**
 * 前缀代码中第 line 行（1-based）起点在字符串中的字符偏移；
 * 行号超出总行数时钳制到最后一行起点（供 textarea.setSelectionRange 使用）。
 */
export function prefixLineCharOffset(prefixCode: string, line: number): number {
  const lines = prefixCode.split("\n");
  let offset = 0;
  const target = Math.min(Math.max(line, 1), lines.length) - 1;
  for (let i = 0; i < target; i++) {
    offset += lines[i].length + 1; // +1 为行尾换行符
  }
  return Math.min(offset, prefixCode.length);
}
