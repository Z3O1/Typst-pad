// 源码展开仅改变本轮排版输入；保存、撤销和编辑器始终持有原文档。
import { Text } from "@codemirror/state";
import expansionStyle from "./document-expansion-style.json";
import { sourceRevealRange } from "./document-interaction";
import type { CompileErrorLocation, Diagnostic } from "./typst-engine";
export interface SourceRange {
  from: number;
  to: number;
}
export interface DocumentProjection {
  source: string;
  original: string;
  sourceToRendered(pos: number): number;
  // 空段中的源码空白可共用占位字形，但选区与诊断仍使用精确位置映射。
  sourceToCaret?(pos: number): number;
  renderedToSource(pos: number): number;
  // 预览使用同一原表达式的第二份来源，命中后仍回到源码区编辑。
  isPreview?(pos: number): boolean;
}

export interface ProjectionRange extends SourceRange {
  // 错误声明不能再次执行；正常的手动展开仍保留作用域与副作用。
  preserveDeclaration?: boolean;
}

export function projectDocument(source: string, range: SourceRange | null): DocumentProjection {
  return projectDocumentRanges(source, range ? [range] : []);
}

export function mergeProjectionRanges(ranges: ProjectionRange[]): ProjectionRange[] {
  const merged: ProjectionRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    if (range.to <= range.from) continue;
    const previous = merged.at(-1);
    // 相邻 raw 的结束/开始围栏会拼成一串反引号，必须合为一个区间。
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
      if (range.preserveDeclaration === false) previous.preserveDeclaration = false;
    } else merged.push({ ...range });
  }
  return merged;
}

export function projectDocumentRanges(
  source: string,
  ranges: ProjectionRange[],
  options: { styled?: boolean; preview?: boolean } = {},
): DocumentProjection {
  const normalized = mergeProjectionRanges(
    ranges.map((range) => ({
      ...range,
      from: Math.max(0, Math.min(range.from, source.length)),
      to: Math.max(0, Math.min(range.to, source.length)),
    })),
  );
  let offset = 0;
  let previousEnd = 0;
  let rendered = "";
  const segments = normalized.map(({ from, to, preserveDeclaration }) => {
    const text = source.slice(from, to);
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
    const block =
      text.includes("\n") || longest >= 2 || (options.preview && /^\$\s[\s\S]*\s\$$/.test(text));
    const fence = "`".repeat(Math.max(block ? 3 : 1, longest + 1));
    const isDeclaration = /^#(?:let|set|show|import)\b/.test(text);
    const declaration = preserveDeclaration !== false && isDeclaration ? `${text}\n` : "";
    // Typst 0.15.1 的 typ 高亮把 raw 第一行各 token 的 span_offset 重置为 0。
    // 展开以源码停靠点为准：使用无语言 raw，保留每个实际字符的原生来源，不猜字形坐标。
    // 局部规则消费 raw 的原始行 body，防止用户 show raw 隐藏/替换源码；不重造字形来源。
    const syntax = text.startsWith("$") ? sourceRevealRange(source, from + 1) : null;
    const formula = syntax?.kind === "math" && syntax.from === from && syntax.to === to;
    const style = options.styled
      ? {
          head: options.preview && formula ? expansionStyle.formulaHead : expansionStyle.head,
          tail: expansionStyle.tail,
        }
      : { head: "", tail: "" };
    const head = declaration + style.head + (block ? `${fence}\n` : `${fence} `);
    const tail = (block ? `\n${fence}` : ` ${fence}`) + style.tail;
    const start = from + offset;
    const textStart = start + head.length;
    const textEnd = textStart + text.length;
    const previewLive = !!options.preview && preserveDeclaration !== false && !isDeclaration;
    const previewHead = previewLive
      ? formula
        ? expansionStyle.previewInlineHead
        : expansionStyle.outputHead
      : "";
    const previewBody = previewLive ? text : "";
    const preview =
      previewHead +
      previewBody +
      (previewLive ? (formula ? expansionStyle.previewTail : expansionStyle.outputTail) : "");
    const previewFrom = textEnd + tail.length;
    const previewTextStart = previewFrom + previewHead.length;
    const previewTextEnd = previewTextStart + previewBody.length;
    const added = head.length + tail.length + preview.length;
    rendered += source.slice(previousEnd, from) + head + text + tail + preview;
    previousEnd = to;
    offset += added;
    return {
      from,
      to,
      start,
      textStart,
      textEnd,
      previewFrom,
      previewTextStart,
      previewTextEnd,
      previewLive,
      end: to + offset,
      added,
    };
  });
  return {
    source: rendered + source.slice(previousEnd),
    original: source,
    sourceToRendered(pos) {
      let delta = 0;
      for (const segment of segments) {
        if (pos < segment.from) break;
        if (pos <= segment.to) return segment.textStart + pos - segment.from;
        delta += segment.added;
      }
      return pos + delta;
    },
    renderedToSource(pos) {
      let delta = 0;
      for (const segment of segments) {
        if (pos < segment.start) break;
        if (pos < segment.textStart) return segment.from;
        if (pos <= segment.textEnd) return segment.from + pos - segment.textStart;
        if (pos < segment.end) {
          if (pos >= segment.previewFrom) {
            if (
              segment.previewLive &&
              pos >= segment.previewTextStart &&
              pos <= segment.previewTextEnd
            )
              return segment.from + pos - segment.previewTextStart;
            return segment.from;
          }
          return segment.to;
        }
        delta += segment.added;
      }
      return pos - delta;
    },
    isPreview(pos) {
      return segments.some((segment) => pos >= segment.previewFrom && pos < segment.end);
    },
  };
}

function createDiagnosticMapper(projection: DocumentProjection) {
  // 每批诊断只索引两份文本一次，避免每个起止点重新扫描整篇文档。
  const rendered = Text.of(projection.source.split("\n"));
  const original = Text.of(projection.original.split("\n"));
  return (line: number, col: number) => {
    const row = rendered.line(Math.max(1, Math.min(line, rendered.lines)));
    let columnOffset = 0;
    let column = 1;
    // Typst 列按 Unicode 字符计数，CodeMirror 位置按 UTF-16。
    for (const char of row.text) {
      if (column++ >= col) break;
      columnOffset += char.length;
    }
    const pos = Math.max(
      0,
      Math.min(original.length, projection.renderedToSource(row.from + columnOffset)),
    );
    const sourceLine = original.lineAt(pos);
    return { line: sourceLine.number, col: pos - sourceLine.from + 1 };
  };
}
export function sourceDiagnostics<T extends Diagnostic | CompileErrorLocation>(
  projection: DocumentProjection,
  diagnostics: T[],
): T[] {
  let mapLocation: ReturnType<typeof createDiagnosticMapper> | null = null;
  return diagnostics.map((item) => {
    if (item.path) return item;
    mapLocation ??= createDiagnosticMapper(projection);
    const start = mapLocation(item.line, "column" in item ? item.column : item.col);
    const end = mapLocation(
      item.endLine ?? item.line,
      "column" in item ? (item.endColumn ?? item.column) : item.endCol,
    );
    return "column" in item
      ? { ...item, line: start.line, column: start.col, endLine: end.line, endColumn: end.col }
      : { ...item, line: start.line, col: start.col, endLine: end.line, endCol: end.col };
  });
}
