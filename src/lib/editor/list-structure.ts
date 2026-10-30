// **列表结构化退格的纯决策**：只算出「这一下退格该改哪里」，不碰 CodeMirror。
//
// 现状：`Tab` / `Shift+Tab` 已按缩进嵌套 / 反嵌套；`Enter` 由 typst 语言扩展续项。
// 缺的是 `Backspace` —— CodeMirror 默认的「删一个字符 / 并两行」会把结构弄成语法垃圾：
//   * `- 甲\n- 乙` 行首退格 → `- 甲- 乙`（第二个标记留在正文里）
//   * 体首退格 `- 乙` → `-乙`（标记和正文粘在一起，**不再是一个列表标记**）
//   * 空项 `- ` 体首退格 → `-`（留下一个不是标记的孤立横线）
//
// 口径按 Typst 语法 + Typora 习惯：
//   ① 嵌套项 → 先反嵌套一档（与 Shift+Tab 同一条缩进语义）；
//   ② 空项 → 整条抹掉，留一个空段落（再退一次才并到上一段）；
//   ③ 行首（标记之前）→ 并进上一行；已经是第一行就退成普通段落；
//   ④ 体首 / 标记内（正文非空）→ 去掉标记，正文退成普通段落。
//
// 标记口径与 typst lezer 一致：`- ` 无序、`+ ` 自动编号、`1. ` 显式编号，标记后必须有空白。

export interface ListLine {
  /** 整行起止（`lineTo` 不含换行） */
  lineFrom: number;
  lineTo: number;
  /** 行首缩进（嵌套就是靠它） */
  indent: string;
  /** 标记起点（缩进之后） */
  markerFrom: number;
  /** 标记终点 */
  markerTo: number;
  /** 正文起点（标记 + 其后的空白之后） */
  bodyFrom: number;
  body: string;
  /** 正文是否只有空白 —— 空项 */
  bodyEmpty: boolean;
  /** 有没有缩进（嵌套项） */
  nested: boolean;
}

/** 一次结构化编辑：把 `[from, to)` 换成 `insert`，光标落到 `caret` */
export interface ListEdit {
  from: number;
  to: number;
  insert: string;
  caret: number;
}

/**
 * 光标所在行是不是 Typst 列表项（`- ` / `+ ` / `1. `，允许前置缩进）。
 *
 * 用**行文本**判据而不是语法树：打字中途语法树经常还没跟上，键位判定不能等解析。
 * 调用方负责排除代码 / raw / 注释 / 公式区域（见 `editor-keymap.ts` 的 `touchesOpaqueContext`）。
 */
export function parseListItem(doc: string, pos: number): ListLine | null {
  const lineFrom = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nl = doc.indexOf("\n", lineFrom);
  const lineTo = nl < 0 ? doc.length : nl;
  const text = doc.slice(lineFrom, lineTo);
  const m = /^([ \t]*)([-+]|\d+\.)([ \t]+)(.*)$/.exec(text);
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
 * 结构化退格的计划（返回 `null` = 交回默认退格）。
 *
 * `unit` 是 Tab 一档的实际字符（见 `editor-keymap.ts` 的 `tabUnit`）：反嵌套删掉一档，
 * 与 Tab / Shift+Tab 对称 —— 按几下 Tab 缩进进去，就能按几下退格退出来。
 */
export function planListBackspace(doc: string, pos: number, unit = "  "): ListEdit | null {
  const item = parseListItem(doc, pos);
  if (!item) return null;
  // 光标在正文里（标记之后）：普通退格，交回默认行为
  if (pos > item.bodyFrom) return null;
  // ① 嵌套项：先反嵌套一档（行首制表符整只删，与 Shift+Tab 同口径）
  if (item.nested) {
    const remove = item.indent.startsWith("\t")
      ? 1
      : Math.max(1, Math.min(unit.length, item.indent.length));
    return {
      from: item.lineFrom,
      to: item.lineFrom + remove,
      insert: "",
      caret: Math.max(item.lineFrom, pos - remove),
    };
  }
  // ② 空项：整条抹掉，留一个空段落
  if (item.bodyEmpty) {
    return { from: item.lineFrom, to: item.lineTo, insert: "", caret: item.lineFrom };
  }
  // ③ 行首（标记之前）：并进上一行；文档第一行就只去掉标记
  if (pos <= item.markerFrom) {
    const prevTo = item.lineFrom - 1;
    if (prevTo >= 0) return { from: prevTo, to: item.bodyFrom, insert: "", caret: prevTo };
    return { from: item.lineFrom, to: item.bodyFrom, insert: "", caret: item.lineFrom };
  }
  // ④ 体首 / 标记内（正文非空）：去掉标记，正文退成普通段落
  return { from: item.lineFrom, to: item.bodyFrom, insert: "", caret: item.lineFrom };
}
