// 源码展开仅改变本轮排版输入；保存、撤销和编辑器始终持有原文档。
import type { CompileErrorLocation, Diagnostic } from "./typst-engine";
export interface SourceRange {
  from: number;
  to: number;
}
export interface DocumentProjection {
  source: string;
  original: string;
  sourceToRendered(pos: number): number;
  renderedToSource(pos: number): number;
}

export function projectDocument(source: string, range: SourceRange | null): DocumentProjection {
  if (!range || range.to <= range.from) {
    return {
      source,
      original: source,
      sourceToRendered: (pos) => pos,
      renderedToSource: (pos) => pos,
    };
  }
  const from = Math.max(0, Math.min(range.from, source.length));
  const to = Math.max(from, Math.min(range.to, source.length));
  const text = source.slice(from, to);
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const block = text.includes("\n") || longest >= 2;
  const fence = "`".repeat(Math.max(block ? 3 : 1, longest + 1));
  // 声明保留作用域与副作用，避免展开宏定义后让后续调用失效。
  const declaration = /^#(?:let|set|show)\b/.test(text) ? `${text}\n` : "";
  const head = declaration + (block ? `${fence}typ\n` : `${fence} `);
  const tail = block ? `\n${fence}` : ` ${fence}`;
  const renderedStart = from + head.length;
  const renderedEnd = renderedStart + text.length;
  const added = head.length + tail.length;
  return {
    source: source.slice(0, from) + head + text + tail + source.slice(to),
    original: source,
    sourceToRendered(pos) {
      if (pos < from) return pos;
      if (pos <= to) return renderedStart + pos - from;
      return pos + added;
    },
    renderedToSource(pos) {
      if (pos < from) return pos;
      if (pos < renderedStart) return from;
      if (pos <= renderedEnd) return from + pos - renderedStart;
      if (pos < to + added) return to;
      return pos - added;
    },
  };
}

function mapLocation(projection: DocumentProjection, line: number, col: number) {
  const lines = projection.source.split("\n");
  // Typst 列按 Unicode 字符计数，CodeMirror 位置按 UTF-16；emoji 不能当成一个码元。
  const columnOffset = [...(lines[line - 1] ?? "")].slice(0, col - 1).join("").length;
  const pos =
    lines.slice(0, line - 1).reduce((sum, text) => sum + text.length + 1, 0) + columnOffset;
  const original = projection.original.slice(0, projection.renderedToSource(pos));
  return { line: original.split("\n").length, col: original.length - original.lastIndexOf("\n") };
}
export function sourceDiagnostics<T extends Diagnostic | CompileErrorLocation>(
  projection: DocumentProjection,
  diagnostics: T[],
): T[] {
  return diagnostics.map((item) => {
    if (item.path) return item;
    const start = mapLocation(projection, item.line, "column" in item ? item.column : item.col);
    const end = mapLocation(
      projection,
      item.endLine ?? item.line,
      "column" in item ? (item.endColumn ?? item.column) : item.endCol,
    );
    return "column" in item
      ? { ...item, line: start.line, column: start.col, endLine: end.line, endColumn: end.col }
      : { ...item, line: start.line, col: start.col, endLine: end.line, endCol: end.col };
  });
}
