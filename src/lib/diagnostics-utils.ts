// 编译诊断的纯函数工具（不依赖 wasm / tauri，可单元测试）：
// 编译源 → 用户文档的位置映射、编辑器波浪线区间计算。
// 诊断已由 Rust 侧以结构化对象提供（1-based 行列，见 typst-engine.ts 的
// Diagnostic），不再需要 range 字符串解析。
import type { Text } from "@codemirror/state";
import type { CompileErrorLocation } from "./typst-engine";

/** 行/列（1-based）→ 文档 offset；越界时 clamp 到文档范围内（空文档返回 0） */
export function offsetAt(doc: Text, line: number, col: number): number {
  if (doc.lines === 0) return 0;
  const l = Math.min(Math.max(line, 1), doc.lines);
  const lineObj = doc.line(l);
  return lineObj.from + Math.min(Math.max(col, 1) - 1, lineObj.length);
}

/** 编译源（prefixCode + doc）中 1-based 行列映射到用户文档的结果 */
export type DocMappedPos = { kind: "prefix" } | { kind: "user"; line: number; col: number };

/**
 * 把编译源（prefixCode + doc 拼接而成）中的 1-based 行列映射回用户文档。
 * 返回 kind: "prefix" 表示落在前缀代码内——错误不在用户文档中，无法在编辑器里定位。
 *
 * 边界语义（与编译源的对应关系）：
 * - 前缀以换行结尾时占满编译源第 1..N 行，用户文档第 1 行即编译源第 N+1 行；
 * - 前缀不以换行结尾时，最后一行与用户第 1 行拼接在同一行——以列区分归属
 *   （列 ≤ 前缀尾行长度 → 前缀；否则属于用户第 1 行，列需减去前缀尾行长度）。
 */
export function mapCompiledPosToDoc(
  line: number,
  col: number,
  prefixCode: string,
): DocMappedPos {
  const newlineCount = (prefixCode.match(/\n/g) ?? []).length;
  const tail = prefixCode.slice(prefixCode.lastIndexOf("\n") + 1);
  const docStartLine = newlineCount + 1;
  if (line < docStartLine) return { kind: "prefix" };
  if (line === docStartLine) {
    if (tail === "") return { kind: "user", line: 1, col };
    if (col <= tail.length) return { kind: "prefix" };
    return { kind: "user", line: 1, col: col - tail.length };
  }
  return { kind: "user", line: line - docStartLine + 1, col };
}

/** 编辑器内波浪线装饰区间 [from, to)（0-based，CM6 区间语义） */
export interface SquiggleRange {
  diag: CompileErrorLocation;
  from: number;
  to: number;
}

/**
 * 计算应在编辑器中画波浪线的错误区间。
 * - 非主源文件（本地 .typ 库等）的错误不在主文档内，跳过（path 为空/缺失视为主源，
 *   兼容 Rust 契约与旧数据）；
 * - prefixCode 非空时先做编译源 → 用户文档映射，前缀区错误跳过；
 * - 越界区间 clamp 到文档范围；单点/行尾错误保证至少画出 1 个字符；空文档返回空列表。
 */
export function squiggleRanges(
  doc: Text,
  diags: CompileErrorLocation[],
  prefixCode = "",
  mainPath = "main.typ",
): SquiggleRange[] {
  const out: SquiggleRange[] = [];
  for (const d of diags) {
    if (d.path !== undefined && d.path !== "" && d.path !== mainPath) continue;
    const start = mapCompiledPosToDoc(d.line, d.col, prefixCode);
    if (start.kind === "prefix") continue;
    let from = offsetAt(doc, start.line, start.col);
    // 终点同样做映射（终点落在前缀区内只在异常数据下出现，退化为单点）
    const end = mapCompiledPosToDoc(d.endLine, d.endCol, prefixCode);
    let to = end.kind === "prefix" ? from : offsetAt(doc, end.line, end.col);
    if (to <= from) to = from + 1;
    if (to > doc.length) to = doc.length;
    if (from >= doc.length) from = Math.max(doc.length - 1, 0);
    if (to <= from) continue; // 空文档等无法构成区间
    out.push({ diag: d, from, to });
  }
  return out;
}
