// Typst 数学定界符的纯编辑计划。复用语言解析器，空公式与未闭合公式也保留上下文；
// 不使用渲染用的 scanMathRanges（它有意忽略空公式和未闭合公式）。
import { typstParser } from "codemirror-lang-typst/lezer";
import type { SyntaxNode, Tree } from "@lezer/common";
import { regionAt, scanNonMarkupRegions } from "../core/typst-lex";

const DISPLAY_SCAFFOLD = "$  $";

export type DollarPlan =
  | { kind: "insert"; text: string; caret: number }
  | { kind: "wrap"; from: number; to: number; before: string; after: string }
  | { kind: "skip"; caret: number }
  | { kind: "none" };

type DollarContext =
  { kind: "markup" } | { kind: "blocked" } | { kind: "math"; from: number; close: number | null };

const codeNodes = new Set([
  "Code",
  "CodeBlock",
  "Hash",
  "Ident",
  "LetBinding",
  "SetRule",
  "ShowRule",
  "Contextual",
  "Conditional",
  "WhileLoop",
  "ForLoop",
  "ModuleImport",
  "ModuleInclude",
  "FuncCall",
  "Args",
  "Array",
  "Dict",
  "Closure",
  "Parenthesized",
  "Unary",
  "Binary",
]);
const opaqueNodes = new Set(["Raw", "Str", "LineComment", "BlockComment", "Shebang"]);

// 无 EditorState 的纯函数调用复用同一份解析；编辑器传入自己的语法树，不另解析全文。
let cachedDoc: string | undefined;
let cachedTree: Tree;
function treeFor(doc: string): Tree {
  if (cachedDoc !== doc) {
    cachedTree = typstParser.parse(doc);
    cachedDoc = doc;
  }
  return cachedTree;
}

function validPosition(doc: string, pos: number): boolean {
  return Number.isInteger(pos) && pos >= 0 && pos <= doc.length;
}

function escapedAt(doc: string, pos: number): boolean {
  let start = pos;
  while (start > 0 && doc[start - 1] === "\\") start--;
  return (pos - start) % 2 === 1;
}

/** 行尾不含 CR/LF；pos=0 时不能把第一个换行误当作上一行。 */
function lineBounds(doc: string, pos: number): { start: number; end: number } {
  const start = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
  const nl = doc.indexOf("\n", pos);
  const end = nl === -1 ? doc.length : nl;
  return { start, end: doc[end - 1] === "\r" ? end - 1 : end };
}

function equationContext(node: SyntaxNode, pos: number): DollarContext | null {
  const last = node.lastChild;
  const close = last?.name === "Dollar" && last.from > node.from ? last.from : null;
  if (pos > node.from && (close === null ? pos <= node.to : pos <= close)) {
    return { kind: "math", from: node.from, close };
  }
  return null;
}

function closedBlockComment(doc: string, node: SyntaxNode): boolean {
  let depth = 0;
  for (let i = node.from; i < node.to; i++) {
    if (doc[i] === "/" && doc[i + 1] === "*") {
      depth++;
      i++;
    } else if (doc[i] === "*" && doc[i + 1] === "/") {
      depth--;
      i++;
    }
  }
  return depth === 0;
}

function contextAt(doc: string, pos: number, tree: Tree): DollarContext {
  // 左亲和性用于代码末尾；闭合公式/raw/注释的右边界则应回到外层模式。
  for (let node: SyntaxNode | null = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (opaqueNodes.has(node.name) && pos > node.from) {
      if (
        pos < node.to ||
        node.name === "LineComment" ||
        node.name === "Shebang" ||
        (node.name === "BlockComment" && !closedBlockComment(doc, node))
      ) {
        return { kind: "blocked" };
      }
    }
    // 未闭合 raw 与数学字符串由上游以 Error 节点恢复，末端仍不可配对。
    if (node.name === "Error" && pos > node.from && /^[`"]/.test(doc[node.from])) {
      return { kind: "blocked" };
    }
    if (node.name === "Markup") return { kind: "markup" };
    if (node.name === "ContentBlock") {
      const markup = node.getChild("Markup");
      if (markup && pos >= markup.from && pos <= markup.to) return { kind: "markup" };
    }
    // 错误恢复会把未闭合公式末尾的空白放到 Equation 的同级节点中。
    if (node.name === "Space" || node.name === "Parbreak") {
      const previous = node.prevSibling;
      if (previous?.name === "Equation") {
        const math = equationContext(previous, previous.to);
        if (math?.kind === "math" && math.close === null) return math;
      }
    }
    if (node.name === "Equation") {
      const math = equationContext(node, pos);
      if (math) return math;
    }
    if (codeNodes.has(node.name) && pos > node.from) {
      // 数学内嵌代码刚结束、右侧紧跟闭合符：仍允许跳出公式。
      if (doc[pos] === "$") {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.name === "Markup") break;
          if (parent.name === "Equation") {
            const math = equationContext(parent, pos);
            if (math?.kind === "math" && math.close === pos) return math;
            break;
          }
        }
      }
      return { kind: "blocked" };
    }
  }
  // 不完整代码字符串可能被解析器恢复成顶层正文，沿用词法扫描的保守护栏。
  // 普通正文直引号不属于字符串；嵌套内容块的 Markup 已在上面优先返回。
  const opaque = scanNonMarkupRegions(doc);
  if (
    regionAt(opaque, pos)?.kind === "code" ||
    (pos > 0 && regionAt(opaque, pos - 1)?.kind === "code")
  ) {
    return { kind: "blocked" };
  }
  return { kind: "markup" };
}

/** 选区必须完整落在正文中；不包裹既有公式、代码或不透明文本。 */
function canWrap(doc: string, from: number, to: number, tree: Tree): boolean {
  if (contextAt(doc, from, tree).kind !== "markup" || contextAt(doc, to, tree).kind !== "markup")
    return false;
  let safe = true;
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.from >= to || node.to <= from) return false;
      if (
        opaqueNodes.has(node.name) ||
        node.name === "Equation" ||
        (node.name === "Error" && /^[`"]/.test(doc[node.from]))
      ) {
        safe = false;
        return false;
      }
      // 外层代码的内容块可以是正文，但选区不能穿过代码本身。
      if (codeNodes.has(node.name) && (node.from >= from || node.to <= to)) safe = false;
      return safe;
    },
  });
  return safe;
}

/** caret 相对输入起点；非空选区包裹后保留原内容与选区方向。 */
export function planDollarInput(
  doc: string,
  from: number,
  to = from,
  tree = treeFor(doc),
  closeBefore = ")]}:;>$",
): DollarPlan {
  if (!validPosition(doc, from) || !validPosition(doc, to) || to < from || escapedAt(doc, from)) {
    return { kind: "none" };
  }
  if (from !== to) {
    if (!canWrap(doc, from, to, tree)) return { kind: "none" };
    if (escapedAt(doc, to)) return { kind: "none" };
    // 像 ( 一样包裹完整选区，不按所在行自动加空格，也不收缩用户选中的空白。
    return { kind: "wrap", from, to, before: "$", after: "$" };
  }
  const context = contextAt(doc, from, tree);
  if (context.kind === "blocked") return { kind: "none" };
  if (context.kind === "math") {
    // 仅提供闭合符候选；输入接线还须核对它确为自动补出的字符。
    if (context.close !== null && doc.slice(from, context.close).trim() === "") {
      return { kind: "skip", caret: context.close + 1 - from };
    }
    return { kind: "none" };
  }
  // 与 ( 同样只在行尾、空白或闭合标点前补一对；既有 $ 也可作为右侧边界。
  const next = doc[from];
  if (next && !/\s/.test(next) && !closeBefore.includes(next)) return { kind: "none" };
  return { kind: "insert", text: "$$", caret: 1 };
}

export interface ScaffoldExpand {
  from: number;
  to: number;
  insert: string;
  caret: number;
}

/** 独占一行的 $$ 或空行间脚手架展开为三行，沿用实际缩进。 */
export function planScaffoldExpand(
  doc: string,
  pos: number,
  lineBreak: string,
  unit: string,
  tree = treeFor(doc),
): ScaffoldExpand | null {
  if (!validPosition(doc, pos)) return null;
  const { start, end } = lineBounds(doc, pos);
  const line = doc.slice(start, end);
  const scaffold = line.trim();
  if (scaffold !== "$$" && scaffold !== DISPLAY_SCAFFOLD) return null;
  const indent = line.slice(0, line.length - line.trimStart().length);
  const from = start + indent.length;
  const context = contextAt(doc, pos, tree);
  if (
    context.kind !== "math" ||
    context.from !== from ||
    context.close !== from + scaffold.length - 1
  )
    return null;
  const insert = `$${lineBreak}${indent}${unit}${lineBreak}${indent}$`;
  return {
    from,
    to: from + scaffold.length,
    insert,
    caret: from + 1 + lineBreak.length + indent.length + unit.length,
  };
}

export interface PairBackspace {
  before: number;
  after: number;
}

/** 只删除真正的空公式，不能把相邻公式之间的两个 $ 或 raw 中的文本当作配对。 */
export function emptyPairBackspace(
  doc: string,
  pos: number,
  tree = treeFor(doc),
): PairBackspace | null {
  if (!validPosition(doc, pos)) return null;
  const context = contextAt(doc, pos, tree);
  if (context.kind !== "math" || context.close === null) return null;
  const { from, close } = context;
  const body = doc.slice(from + 1, close);
  if (body === "" && pos === from + 1) return { before: 1, after: 1 };
  // 空格/Enter 的行间手势先退回 $$，下一次 Backspace 才删掉配对。
  const padded = body === "  " && pos === from + 2;
  const expanded =
    /^\r?\n[ \t]*\r?\n[ \t]*$/.test(body) &&
    doc.slice(lineBounds(doc, from).start, from).trim() === "" &&
    doc.slice(close + 1, lineBounds(doc, close).end).trim() === "" &&
    pos > from + 1 &&
    pos < close &&
    doc.slice(lineBounds(doc, pos).start, lineBounds(doc, pos).end).trim() === "";
  if (!padded && !expanded) return null;
  return { before: pos - from - 1, after: close - pos };
}
