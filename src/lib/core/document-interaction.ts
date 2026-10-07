// 整页交互只映射坐标与源码范围，不参与 Typst 排版。
import { parser } from "codemirror-lang-typst/lezer";

// 诊断起止点和光标移动复用同一快照；只保留一份树，编辑或换文件自动替换。
let parsed: { doc: string; tree: ReturnType<typeof parser.parse> } | null = null;

export function sourceRevealRange(
  doc: string,
  pos: number,
  outermost = false,
  affinity: -1 | 0 | 1 = 0,
): {
  from: number;
  to: number;
  kind: "math" | "code" | "text";
} {
  const at = Math.max(0, Math.min(pos, doc.length));
  // 复用源码编辑器的无 wasm 语法树，内容块里的文字也能展开完整的外层调用。
  try {
    if (!parsed || parsed.doc !== doc) parsed = { doc, tree: parser.parse(doc) };
    const tree = parsed.tree;
    let candidate: ReturnType<typeof sourceRevealRange> | null = null;
    for (const side of affinity === 0 ? ([-1, 1] as const) : [affinity]) {
      let node = tree.resolveInner(at, side);
      while (node.parent) {
        let range: ReturnType<typeof sourceRevealRange> | null = null;
        if (node.name === "Equation") range = { from: node.from, to: node.to, kind: "math" };
        if (node.name === "Hash" && node.nextSibling)
          range = { from: node.from, to: node.nextSibling.to, kind: "code" };
        if (node.prevSibling?.name === "Hash")
          range = { from: node.prevSibling.from, to: node.to, kind: "code" };
        if (
          range &&
          (affinity === 0 ||
            (affinity > 0 ? at >= range.from && at < range.to : at > range.from && at <= range.to))
        ) {
          if (!outermost) return range;
          if (!candidate || (range.from <= candidate.from && range.to >= candidate.to))
            candidate = range;
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
