// Enter 使用语言树中的数学范围；渲染扫描会忽略空公式与未闭合公式，不适合输入语义。
import { typstParser } from "codemirror-lang-typst/lezer";
import type { SyntaxNode, Tree } from "@lezer/common";

export interface EnterMathRange {
  from: number;
  to: number;
  closed: boolean;
}

let cachedDoc: string | undefined;
let cachedTree: Tree;
export function mathEnterTree(doc: string, tree?: Tree): Tree {
  if (tree?.topNode.name === "Typst") return tree;
  if (cachedDoc !== doc) {
    cachedTree = typstParser.parse(doc);
    cachedDoc = doc;
  }
  return cachedTree;
}

function equationClosed(node: SyntaxNode): boolean {
  const last = node.lastChild;
  return last?.name === "Dollar" && last.from > node.from;
}

function equationEnd(node: SyntaxNode): number {
  const next = node.nextSibling;
  // 语言树把未闭合公式末端的空白恢复成同级节点，输入仍属于这段公式。
  return !equationClosed(node) && next && ["Space", "Parbreak"].includes(next.name)
    ? next.to
    : node.to;
}

export function enterMathRanges(tree: Tree): EnterMathRange[] {
  const ranges: EnterMathRange[] = [];
  tree.iterate({
    enter(node) {
      if (node.name !== "Equation") return;
      ranges.push({
        from: node.from,
        to: equationEnd(node.node),
        closed: equationClosed(node.node),
      });
    },
  });
  return ranges;
}

/** 仅延续多行公式行首的显式换行 + 对齐标记，不复制任意数学表达式。 */
export function mathContinuationPrefix(doc: string, pos: number, tree: Tree): string | null {
  let equation = tree.resolveInner(pos, -1);
  // 光标必须在数学正文中，不能在公式内嵌的代码、字符串、注释或 raw 中。
  let math = false;
  for (let node = equation; ;) {
    if (
      node.name === "Space" &&
      node.prevSibling?.name === "Equation" &&
      !equationClosed(node.prevSibling)
    ) {
      equation = node.prevSibling;
      math = true;
      break;
    }
    if (["Str", "Raw", "LineComment", "BlockComment", "Error", "Hash"].includes(node.name))
      return null;
    if (node.name === "Math" || (node.name === "Space" && node.parent?.name === "Equation"))
      math = true;
    else if (node.name === "Equation") {
      equation = node;
      break;
    } else if (
      !node.name.startsWith("Math") &&
      !(
        [
          "Space",
          "Linebreak",
          "LeftParen",
          "RightParen",
          "LeftBracket",
          "RightBracket",
          "LeftBrace",
          "RightBrace",
          "Comma",
        ].includes(node.name) && node.parent?.name.startsWith("Math")
      ) &&
      !(node.name === "Space" && node.parent?.name === "Equation")
    ) {
      return null;
    }
    if (!node.parent) return null;
    node = node.parent;
  }
  if (!math || !doc.slice(equation.from, equation.to).includes("\n")) return null;
  const last = equation.lastChild;
  const close = last?.name === "Dollar" ? last.from : equationEnd(equation);
  if (pos <= equation.from || pos > close) return null;

  const lineFrom = doc.lastIndexOf("\n", pos - 1) + 1;
  if (lineFrom <= equation.from) return null;
  const prefix = /^[ \t]*\\[ \t]*(?:=[ \t]*&|&[ \t]*=)[ \t]*/.exec(doc.slice(lineFrom, pos))?.[0];
  if (!prefix) return null;
  // 同形文本不够：反斜杠和 & 必须确实被语言树识别为当前公式的标记。
  const slash = lineFrom + prefix.indexOf("\\");
  const align = lineFrom + prefix.indexOf("&");
  if (
    tree.resolveInner(slash, 1).name !== "Linebreak" ||
    tree.resolveInner(align, 1).name !== "MathAlignPoint"
  )
    return null;
  return prefix;
}
