// 编译错误列表弹窗的纯函数工具（不依赖 wasm / tauri，可单元测试）。
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
