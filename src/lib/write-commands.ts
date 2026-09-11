// 写作模式的编辑命令（纯函数）：只算出「文档该怎么改」，不碰 CodeMirror。
// 这样格式工具条的每个动作都能单测（区间、选区落点、切换语义），UI 层只负责 dispatch。
//
// 与源码模式的区别：这些命令插入的都是 **Typst 标记**（`*粗*`、`= 标题`、`$x$`），
// 写作模式下它们当场被渲染成排版结果（见 live-preview.ts），源码模式下就是普通文本。

/** 一次编辑：把 [from, to) 换成 insert，并把光标放到 anchor（可选选区 head） */
export interface EditPlan {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head?: number;
}

/** 用定界符包住所选内容（无选区时插入一对定界符并把光标放中间） */
export function planWrap(
  doc: string,
  from: number,
  to: number,
  before: string,
  after: string = before,
): EditPlan {
  const selected = doc.slice(from, to);
  // 已包着同一对定界符 → 再点一次取消（工具条按钮的"切换"语义）
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after) &&
    selected.length > before.length + after.length - 1
  ) {
    const inner = selected.slice(before.length, selected.length - after.length);
    return { from, to, insert: inner, anchor: from, head: from + inner.length };
  }
  // 选区两侧紧邻已有定界符（如选中 `*粗*` 里的"粗"）→ 一并去掉，避免 `**粗**`
  const outerFrom = from - before.length;
  if (outerFrom >= 0 && doc.slice(outerFrom, from) === before && doc.slice(to, to + after.length) === after) {
    return {
      from: outerFrom,
      to: to + after.length,
      insert: selected,
      anchor: outerFrom,
      head: outerFrom + selected.length,
    };
  }
  // 首尾空白（尤其是换行）留在定界符**外侧**：`*文字\n*` 在 Typst 里是跨行强调，
  // 我们自己的标记扫描也不识别跨行强调 → 会退化成字面星号（实测：Ctrl+A 后按 Ctrl+B）。
  const lead = /^\s*/.exec(selected)?.[0] ?? "";
  const trailMatch = /\s*$/.exec(selected.slice(lead.length));
  const trail = trailMatch?.[0] ?? "";
  const core = selected.slice(lead.length, selected.length - trail.length);
  if (core === "") {
    return {
      from,
      to,
      insert: before + selected + after,
      anchor: from + before.length,
      head: from + before.length + selected.length,
    };
  }
  return {
    from,
    to,
    insert: lead + before + core + after + trail,
    anchor: from + lead.length + before.length,
    head: from + lead.length + before.length + core.length,
  };
}

/** 取 pos 所在行的范围（不含换行符） */
function lineRangeAt(doc: string, pos: number): { from: number; to: number } {
  const from = doc.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
  const nextNl = doc.indexOf("\n", pos);
  return { from, to: nextNl < 0 ? doc.length : nextNl };
}

/**
 * 给当前行加/换行首标记（`= ` 标题、`- ` 列表、`+ ` 列表…）：
 * 已有**同族**标记时先去掉（`=`/`-`/`+` 视为互相排斥的一组），实现按钮的切换语义。
 */
export function planLinePrefix(doc: string, pos: number, prefix: string): EditPlan {
  const { from, to } = lineRangeAt(doc, pos);
  const line = doc.slice(from, to);
  const existing = /^([ \t]*)([=+\-]+[ \t]+)/.exec(line);
  if (existing && existing[2] === prefix) {
    // 再点一次：去掉标记，光标位置相应前移
    const shift = existing[2].length;
    return { from, to: from + shift, insert: "", anchor: Math.max(from, pos - shift) };
  }
  const body = line.replace(/^([ \t]*)([=+\-]+[ \t]+)/, "$1");
  const indent = /^[ \t]*/.exec(body)?.[0] ?? "";
  const content = body.slice(indent.length);
  const insert = indent + prefix + content;
  const delta = insert.length - line.length;
  return { from, to, insert, anchor: Math.max(from, pos + delta) };
}

/**
 * 把一段内容包成"整行块"（行间公式 / 代码块 / 引用共用）。
 *
 * - **无选区**（to <= from）：替换光标所在整行，该行原有内容成为块内容——
 *   在正写着的一行上按快捷键不会丢内容；结尾多带一个换行，与后面的内容自然空一行。
 * - **有选区**：只替换选区，行的其余部分原样保留（选区前后可能还有文字）。
 */
function planLineBlock(
  doc: string,
  from: number,
  to: number,
  make: (body: string) => { insert: string; anchorOffset: number },
): EditPlan {
  if (to > from) {
    const body = doc.slice(from, to);
    const { insert, anchorOffset } = make(body);
    return { from, to, insert, anchor: from + anchorOffset, head: from + anchorOffset + body.length };
  }
  const line = lineRangeAt(doc, from);
  const body = doc.slice(line.from, line.to);
  const { insert, anchorOffset } = make(body);
  return {
    from: line.from,
    to: line.to,
    insert,
    anchor: line.from + anchorOffset,
    head: line.from + anchorOffset + body.length,
  };
}

/** 行间公式（独占整行；typst 的行间公式就是"定界符内侧带空白"，独占一行最稳） */
export function planBlockMath(doc: string, from: number, to = from): EditPlan {
  return planLineBlock(doc, from, to, (body) => ({
    insert: `$\n  ${body}\n$\n`,
    anchorOffset: 3, // `$\n  ` 之后
  }));
}

/** 代码块（``` 围栏） */
export function planCodeBlock(doc: string, from: number, to = from, lang = "typ"): EditPlan {
  return planLineBlock(doc, from, to, (body) => ({
    insert: `\`\`\`${lang}\n${body}\n\`\`\`\n`,
    anchorOffset: 3 + lang.length + 1,
  }));
}

/**
 * 引用块：Typst 没有 Markdown 的 `>` 语法，块引用是 `#quote(block: true)[...]`
 * （写 `>` 只会在文档里留下字面字符，所以这里必须用 Typst 自己的写法）。
 */
export function planQuote(doc: string, from: number, to = from): EditPlan {
  const head = "#quote(block: true)[\n  ";
  return planLineBlock(doc, from, to, (body) => ({
    insert: `${head}${body}\n]\n`,
    anchorOffset: head.length,
  }));
}

/** 链接：`#link("url")[文字]`（有选区时作为文字；否则插入占位并把光标放文字处） */
export function planLink(doc: string, from: number, to: number, url = "https://"): EditPlan {
  const selected = doc.slice(from, to);
  const text = selected === "" ? "文字" : selected;
  const insert = `#link("${url}")[${text}]`;
  const anchor = from + `#link("${url}")[`.length;
  return { from, to, insert, anchor, head: anchor + text.length };
}

/** 写作模式工具条的动作标识 */
export type WriteCommand =
  | "bold"
  | "italic"
  | "code"
  | "strike"
  | "heading1"
  | "heading2"
  | "heading3"
  | "body"
  | "bullet"
  | "ordered"
  | "quote"
  | "math-inline"
  | "math-block"
  | "code-block"
  | "link";

/**
 * 把一个动作翻译成 EditPlan（菜单 / 快捷键共用同一套语义）。
 * 块级动作（公式块 / 代码块 / 引用）的选区语义见 planLineBlock：无选区时整行、
 * 有选区时只替换选区。
 */
export function planForCommand(doc: string, from: number, to: number, command: WriteCommand): EditPlan {
  switch (command) {
    case "bold":
      return planWrap(doc, from, to, "*");
    case "italic":
      return planWrap(doc, from, to, "_");
    case "code":
      return planWrap(doc, from, to, "`");
    case "strike":
      return planWrap(doc, from, to, "#strike[", "]");
    case "math-inline":
      return planWrap(doc, from, to, "$");
    case "heading1":
      return planLinePrefix(doc, from, "= ");
    case "heading2":
      return planLinePrefix(doc, from, "== ");
    case "heading3":
      return planLinePrefix(doc, from, "=== ");
    case "body":
      return planLinePrefix(doc, from, "");
    case "bullet":
      return planLinePrefix(doc, from, "- ");
    case "ordered":
      return planLinePrefix(doc, from, "+ ");
    case "quote":
      return planQuote(doc, from, to);
    case "math-block":
      return planBlockMath(doc, from, to);
    case "code-block":
      return planCodeBlock(doc, from, to);
    case "link":
      return planLink(doc, from, to);
  }
}
