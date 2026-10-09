// 空段占位只进入文档模式的排版投影，原文中的两个换行仍表示一个段落边界。
import { parser } from "codemirror-lang-typst/lezer";
import type { DocumentProjection } from "./document-projection";

interface EmptyParagraph {
  from: number;
  to: number;
  at: number;
}

export const EMPTY_PARAGRAPH_SPACE = "\u00a0";

function emptyParagraphs(source: string): EmptyParagraph[] {
  const paragraphs: EmptyParagraph[] = [];
  const add = (from: number, to: number) => {
    // 在缩进之后放占位，点击空段后继续输入不会跑到已有缩进之前。
    const indent = source.slice(from, to).match(/^[ \t]*/)?.[0].length ?? 0;
    paragraphs.push({ from, to, at: from + indent });
  };
  const root = parser.parse(source).topNode;
  const children = [];
  for (let node = root.firstChild; node; node = node.nextSibling) children.push(node);
  const onlyWhitespace = children.every((node) => ["Space", "Parbreak"].includes(node.name));
  if (onlyWhitespace && !children.some((node) => node.name === "Parbreak")) {
    add(0, source.length);
    return paragraphs;
  }
  for (const node of children) {
    // 只处理文档顶层 markup，不污染公式、raw、注释、代码或宏定义中的内容块。
    if (node.name !== "Parbreak") continue;
    const ends = [
      ...source.slice(node.from, node.to).matchAll(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g),
    ].map((match) => node.from + match.index + match[0].length);
    if (node.from === 0) add(0, ends[1]);
    for (let index = 1; index < ends.length; index += 2) {
      const from = ends[index];
      const to = ends[index + 2];
      if (to !== undefined) add(from, to);
      else if (node.to === source.length) add(from, node.to);
    }
  }
  // 只有设置/声明的文档，最后一个源码换行之后也应有可继续输入的空段。
  const last = children.at(-1);
  if (
    !paragraphs.length &&
    last?.name === "Space" &&
    /[\n\r]/.test(source.slice(last.from, last.to)) &&
    children.every((node) =>
      [
        "Hash",
        "SetRule",
        "ShowRule",
        "LetBinding",
        "Import",
        "LineComment",
        "BlockComment",
        "Space",
        "Parbreak",
      ].includes(node.name),
    )
  ) {
    const newline = source.slice(last.from, last.to).match(/\r\n|[\n\r]/)!;
    add(last.from + newline.index! + newline[0].length, source.length);
  }
  return paragraphs;
}

export function hasEmptyParagraphs(source: string): boolean {
  return emptyParagraphs(source).length > 0;
}

export function projectEmptyParagraphs(
  projection: DocumentProjection,
  prefixLength = 0,
): DocumentProjection {
  const paragraphs = emptyParagraphs(projection.source.slice(prefixLength)).map((paragraph) => ({
    from: prefixLength + paragraph.from,
    to: prefixLength + paragraph.to,
    at: prefixLength + paragraph.at,
  }));
  if (!paragraphs.length) return projection;
  let source = "";
  let end = 0;
  for (const { at } of paragraphs) {
    source += projection.source.slice(end, at) + EMPTY_PARAGRAPH_SPACE;
    end = at;
  }
  source += projection.source.slice(end);
  const forward = (pos: number) => {
    let low = 0;
    let high = paragraphs.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (paragraphs[mid].at < pos) low = mid + 1;
      else high = mid;
    }
    return pos + low;
  };
  const backward = (pos: number) => {
    let delta = 0;
    for (const { at } of paragraphs) {
      if (pos <= at + delta) break;
      if (pos <= at + delta + 1) return at;
      delta++;
    }
    return pos - delta;
  };
  return {
    source,
    original: projection.original,
    sourceToRendered(pos) {
      return forward(projection.sourceToRendered(pos));
    },
    sourceToCaret(pos) {
      const rendered = projection.sourceToRendered(pos);
      // 相邻空段共享边界时归属后一个段落，尤其是末尾零长度的新段。
      let low = 0;
      let high = paragraphs.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (paragraphs[mid].from <= rendered) low = mid + 1;
        else high = mid;
      }
      const index = low - 1;
      const paragraph = paragraphs[index];
      return paragraph &&
        (rendered < paragraph.to ||
          (rendered === paragraph.to && paragraph.to === projection.source.length))
        ? paragraph.at + index
        : forward(rendered);
    },
    renderedToSource(pos) {
      return projection.renderedToSource(backward(pos));
    },
    isPreview(pos) {
      return projection.isPreview?.(backward(pos)) ?? false;
    },
  };
}
