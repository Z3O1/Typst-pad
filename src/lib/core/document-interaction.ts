// 整页交互只映射坐标与源码范围，不参与 Typst 排版。
import { parser } from "codemirror-lang-typst/lezer";

// 诊断起止点和光标移动复用同一快照；只保留一份树，编辑或换文件自动替换。
let parsed: { doc: string; tree: ReturnType<typeof parser.parse> } | null = null;
export type SourceSyntaxTree = ReturnType<typeof parser.parse>;
type SyntaxNode = SourceSyntaxTree["topNode"];
type RevealRange = { from: number; to: number; kind: "math" | "code" | "heading" | "text" };
const trivia = new Set(["Space", "LineComment", "BlockComment"]);

function sourceTree(doc: string, syntax?: SourceSyntaxTree | null): SourceSyntaxTree {
  if (syntax?.length === doc.length) return syntax;
  if (!parsed || parsed.doc !== doc) parsed = { doc, tree: parser.parse(doc) };
  return parsed.tree;
}

/** 只接受语法树里的闭合 Dollar；转义美元符号和未完成公式不是退出边界。 */
export function closedMathRangeAt(
  doc: string,
  pos: number,
  syntax?: SourceSyntaxTree | null,
): { from: number; to: number } | null {
  const range = sourceRevealRange(doc, pos, false, 1, syntax);
  if (range.kind !== "math") return null;
  let node = sourceTree(doc, syntax).resolveInner(range.to, -1);
  while (node.parent) {
    if (node.name === "Equation" && node.from === range.from && node.to === range.to)
      return node.lastChild?.name === "Dollar" ? { from: range.from, to: range.to } : null;
    node = node.parent;
  }
  return null;
}

function inMarkup(node: SyntaxNode): boolean {
  return node.parent?.name === "Typst" || node.parent?.name === "Markup";
}

function codeBoundary(node: SyntaxNode): RevealRange | null {
  let expression: SyntaxNode | null = node;
  if (node.name === "Hash") expression = node.nextSibling;
  else if (node.name === "Semicolon" || trivia.has(node.name)) {
    expression = node.prevSibling;
    while (expression && trivia.has(expression.name)) expression = expression.prevSibling;
  }
  const hash = expression?.prevSibling;
  if (!expression || hash?.name !== "Hash" || !inMarkup(hash)) return null;
  let to = expression.to;
  let next = expression.nextSibling;
  while (next && trivia.has(next.name)) next = next.nextSibling;
  // 分号及其前的语法空白仍属于 # 代码模式，不能留在 raw 之外变成正文。
  if (next?.name === "Semicolon") to = next.to;
  return { from: hash.from, to, kind: "code" };
}

function headingBoundary(node: SyntaxNode, doc: string): RevealRange | null {
  // Lezer 把标题行末空白放在 Heading 外；空标题的标记后也仍可输入正文。
  const heading = node.name === "Space" || node.name === "Parbreak" ? node.prevSibling : node;
  if (heading?.name !== "Heading" || !inMarkup(heading)) return null;
  let to = heading.to;
  const trailing = heading.nextSibling;
  if (trailing?.name === "Space" || trailing?.name === "Parbreak") {
    const whitespace = doc.slice(trailing.from, trailing.to);
    const lineEnd = whitespace.search(/[^ \t]/);
    to = trailing.from + (lineEnd < 0 ? whitespace.length : lineEnd);
  }
  return { from: heading.from, to, kind: "heading" };
}

export function sourceRevealRange(
  doc: string,
  pos: number,
  outermost = false,
  affinity: -1 | 0 | 1 = 0,
  syntax?: SourceSyntaxTree | null,
): RevealRange {
  const at = Math.max(0, Math.min(pos, doc.length));
  // 复用源码编辑器的无 wasm 语法树，内容块里的文字也能展开完整的外层调用。
  try {
    // 优先使用当前 EditorState 的增量树；不完整树不能确认完整替换边界。
    const tree = sourceTree(doc, syntax);
    let candidate: RevealRange | null = null;
    for (const side of affinity === 0 ? ([-1, 1] as const) : [affinity]) {
      let node = tree.resolveInner(at, side);
      while (node.parent) {
        // raw 必须落在 markup 中：数学里的 # 属于整段公式，代码里的公式属于外层 #。
        const range =
          node.name === "Equation" && inMarkup(node)
            ? { from: node.from, to: node.to, kind: "math" as const }
            : (codeBoundary(node) ?? headingBoundary(node, doc));
        if (
          range &&
          (affinity > 0
            ? at >= range.from && at < range.to
            : affinity < 0
              ? at > range.from && at <= range.to
              : at >= range.from && at <= range.to)
        ) {
          // 点击起点时左侧可能是外层代码，右侧才是内容块中的标题；比较两侧的安全范围。
          if (
            !candidate ||
            (outermost
              ? range.from <= candidate.from && range.to >= candidate.to
              : range.from >= candidate.from && range.to <= candidate.to)
          )
            candidate = range;
          if (!outermost) break;
        }
        node = node.parent;
      }
    }
    if (candidate) return candidate;
  } catch {
    /* 未完成的语法仍可从当前源码行编辑。 */
  }
  const from = at === 0 ? 0 : doc.lastIndexOf("\n", at - 1) + 1;
  const end = doc.indexOf("\n", at);
  return { from, to: end < 0 ? doc.length : end, kind: "text" };
}

// 纸张外侧和页间空白也能选中最近页；先比较纵向距离，再比较横向距离。
// 保留页外坐标，让后端按真实排版定位到行首/尾，而不是猜测源码偏移。
export function nearestPageCoordinates(
  point: { x: number; y: number },
  pages: {
    rect: { left: number; top: number; width: number; height: number };
    box: { x: number; y: number; width: number; height: number };
  }[],
): { page: number; xPt: number; yPt: number } | null {
  let best: { page: number; xPt: number; yPt: number } | null = null;
  let bestDy = Infinity;
  let bestDx = Infinity;
  pages.forEach(({ rect, box }, index) => {
    const coords = pageCoordinates(point, rect, box);
    if (!coords) return;
    const dy = Math.max(rect.top - point.y, point.y - rect.top - rect.height, 0);
    const dx = Math.max(rect.left - point.x, point.x - rect.left - rect.width, 0);
    if (dy < bestDy || (dy === bestDy && dx < bestDx)) {
      best = { page: index + 1, ...coords };
      bestDy = dy;
      bestDx = dx;
    }
  });
  return best;
}

export function pageCoordinates(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): { xPt: number; yPt: number } | null {
  if (
    ![
      point.x,
      point.y,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      box.x,
      box.y,
      box.width,
      box.height,
    ].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    box.width <= 0 ||
    box.height <= 0
  )
    return null;
  return {
    xPt: box.x + ((point.x - rect.left) * box.width) / rect.width,
    yPt: box.y + ((point.y - rect.top) * box.height) / rect.height,
  };
}
