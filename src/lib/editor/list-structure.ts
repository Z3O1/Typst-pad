// **列表结构化编辑的纯决策**（typora-parity 审计 P0-2 / 上一报告 P1「段首合并」）。
//
// 现状实测（jsdom + 原生 lezer，见 `list-structure.test.ts` 与 `editor-keymap.test.ts`）：
//  * **Tab / Shift+Tab 已经按缩进嵌套 / 反嵌套**（`indentWithTab` + lezer 的缩进服务；实测 2 / 4 / 6
//    空格都能正确进出一层），所以这一块不缺；
//  * 缺的是 **Backspace**：旧行为是 CodeMirror 默认的"删一个字符 / 并两行"，于是
//      - `- 甲\n- 乙` 行首退格 → `- 甲- 乙`（第二个标记留在了正文里）
//      - 体首退格 `- 乙` → `-乙`（标记与正文粘在一起，**不再是一个列表标记**）
//      - 空项 `- ` 体首退格 → `-`（留下一个不是标记的孤立横线，typst 会把它并进上一项）
//    这三样都会把用户"退回上一项 / 取消列表"的意图变成语法垃圾。
//
// 这里只做**决策**（纯函数、可单测）；按键的接线在 `editor-keymap.ts`。口径按 Typst 语法 +
// Typora 的习惯：
//   ① 嵌套项 → 先反嵌套一层（与 Shift+Tab 同一条缩进语义）；
//   ② 空项 → 整条标记抹掉，留一个空段落（第二次退格才并到上一段）；
//   ③ 行首（标记之前）→ 并进上一行（上一项的文字直接接上）；已经是第一行就退成普通段落；
//   ④ 体首 / 标记区内（正文非空）→ 去掉标记，正文退成普通段落。
import { INDENT_UNIT } from "./auto-indent";

export interface ListLine {
  /** 整行的起止（`lineTo` 不含换行） */
  lineFrom: number;
  lineTo: number;
  /** 行首缩进（嵌套就是靠它） */
  indent: string;
  /** 标记 `-` / `+` 的范围 */
  markerFrom: number;
  markerTo: number;
  /** 正文起点（标记 + 它后面的空白之后） */
  bodyFrom: number;
  body: string;
  /** 正文是不是空的（只有空白）—— 空项 */
  bodyEmpty: boolean;
  /** 有没有缩进（嵌套项） */
  nested: boolean;
}

/** 一次结构化编辑：替换 `[from, to)` 为 `insert`，并把光标放到 `caret` */
export interface ListEdit {
  from: number;
  to: number;
  insert: string;
  caret: number;
}

/**
 * 光标所在行是不是一个 Typst 列表项（`- ` / `+ ` 开头，允许前置缩进）。
 *
 * 用**行文本**判据而不是语法树：与 `core/editable-subset` 的 `listSimple` 同一条正则口径，
 * 而且文档在打字中途经常处于"语法树还没跟上"的状态 —— 键位判定不能等解析。
 * 调用方负责排除代码 / raw / 注释区域（见 `editor-keymap.ts` 的 `touchesOpaqueContext`）。
 */
export function parseListItem(doc: string, pos: number): ListLine | null {
  const lineFrom = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = doc.indexOf("\n", lineFrom);
  const lineTo = nl < 0 ? doc.length : nl;
  const text = doc.slice(lineFrom, lineTo);
  // 标记必须是 `-` / `+` 后面跟至少一个空白（`-乙` 不是标记，`- ` 是）
  const m = /^([ \t]*)([-+])([ \t]+)(.*)$/.exec(text);
  if (!m) return null;
  const indent = m[1];
  const markerFrom = lineFrom + indent.length;
  const markerTo = markerFrom + m[2].length;
  const bodyFrom = markerTo + m[3].length;
  const body = m[4];
  return {
    lineFrom,
    lineTo,
    indent,
    markerFrom,
    markerTo,
    bodyFrom,
    body,
    bodyEmpty: body.trim() === "",
    nested: indent.length > 0,
  };
}

/**
 * 结构化退格的计划（返回 null = 交回默认退格）。
 *
 * `indentUnit` 默认取编辑器的缩进档（4 个空格）；反嵌套一次最多去掉一档 —— 与 `indentWithTab`
 * 的 Shift 变体同一语义（实测 6 空格缩进按一次 Shift+Tab 变 2 空格）。
 */
export function planListBackspace(
  doc: string,
  pos: number,
  indentUnit: string = INDENT_UNIT,
): ListEdit | null {
  const item = parseListItem(doc, pos);
  if (!item) return null;
  // 光标在正文里（标记之后）→ 这是普通退格，交给默认行为
  if (pos > item.bodyFrom) return null;
  // ① 嵌套项：先反嵌套一层
  if (item.nested) {
    const remove = Math.max(1, Math.min(indentUnit.length, item.indent.length));
    return {
      from: item.lineFrom,
      to: item.lineFrom + remove,
      insert: "",
      caret: Math.max(item.lineFrom, pos - remove),
    };
  }
  // ② 空项：整行标记抹掉，留一个空段落（第二次退格才会并到上一段）
  if (item.bodyEmpty) {
    return { from: item.lineFrom, to: item.lineTo, insert: "", caret: item.lineFrom };
  }
  // ③ 行首（标记之前）：并进上一行；已经是文档第一行就退成普通段落
  if (pos <= item.markerFrom) {
    const prevTo = item.lineFrom - 1; // 上一行的行尾（即那个换行的位置）
    if (prevTo >= 0) return { from: prevTo, to: item.bodyFrom, insert: "", caret: prevTo };
    return { from: item.lineFrom, to: item.bodyFrom, insert: "", caret: item.lineFrom };
  }
  // ④ 体首 / 标记区内（正文非空）：去掉标记，正文退成普通段落
  return { from: item.lineFrom, to: item.bodyFrom, insert: "", caret: item.lineFrom };
}
