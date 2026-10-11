// 展开由源码选区的活动端和移动意图决定；不修改选区、源码或版面。
import { sourceRevealRange, type SourceSyntaxTree } from "./document-interaction";
import type { SourceRange } from "./document-projection";

export interface SourceCursorChange {
  anchor: number;
  head: number;
  previousHead: number;
  reason: "move" | "edit" | "restore";
}
export interface SourceExpansion {
  range: SourceRange | null;
  error: SourceRange | null;
}
export type ExpansionIntent = SourceCursorChange["reason"] | "click" | "explicit";

export function sameSourceRange(a: SourceRange | null, b: SourceRange | null): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

export function resolveSourceExpansion(
  doc: string,
  current: SourceExpansion,
  cursor: { anchor: number; head: number; previousHead?: number },
  intent: ExpansionIntent,
  options: {
    errors?: SourceRange[];
    whitespace?: boolean;
    composing?: boolean;
    syntax?: SourceSyntaxTree | null;
  } = {},
): SourceExpansion {
  // 拖选在页面层处理；非空选区和合成都不能突然重排正在交互的产物。
  if (intent === "restore" || options.composing || cursor.anchor !== cursor.head) return current;
  const head = Math.max(0, Math.min(cursor.head, doc.length));
  const side = intent === "move" ? Math.sign(head - (cursor.previousHead ?? head)) : 0;
  const contains = (range: SourceRange | null) =>
    !!range &&
    range.to > range.from &&
    (side > 0
      ? head >= range.from && head < range.to
      : side < 0
        ? head > range.from && head <= range.to
        : head >= range.from && head <= range.to);
  const result = (range: SourceRange | null, error: SourceRange | null): SourceExpansion => {
    if (sameSourceRange(range, current.range)) range = current.range;
    if (sameSourceRange(error, current.error)) error = current.error;
    return range === current.range && error === current.error ? current : { range, error };
  };
  const error = options.errors?.find(contains);
  // 当前修订的错误范围可能扩大/缩小；锁跟随该范围，修好后才保留映射的旧范围。
  if (error) return result(null, error);
  if (contains(current.error)) return result(null, current.error);
  // 已展开的完整父表达式内不再切换到嵌套子表达式。
  if (contains(current.range)) return result(current.range, null);
  if (intent === "click" && options.whitespace) return result(null, null);
  const range = sourceRevealRange(doc, head, false, side as -1 | 0 | 1, options.syntax);
  return result(
    range.kind === "text" || range.to <= range.from ? null : { from: range.from, to: range.to },
    null,
  );
}
