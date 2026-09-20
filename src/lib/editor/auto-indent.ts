// 回车换行时的缩进策略：新行沿用**上一行的缩进**（用户要求「换行时应该和上一行缩进一样」）。
//
// 纯函数，不碰 CodeMirror —— 落事务在 editor-keymap.ts 的 Enter / Shift-Enter 绑定里。
// 为什么不直接用 CodeMirror 默认的 insertNewlineAndIndent：它的缩进来自语言服务/语法树，
// 在 typst 文档里实测**时灵时不灵**（两空格缩进能抄到、四空格缩进抄不到、光标停在行中间时
// 一律丢失）——而这三种情况用户要的是同一个结果：跟上一行一样。

/** 整行只有空白（空行，或只剩一串缩进）：换行时顺手清掉这串残留空白，别再往新行续缩进 */
export function isBlankLine(lineText: string): boolean {
  return lineText.trim() === "";
}

/**
 * 一档缩进 = **4 个空格**（用户要求「Tab 应该是四格缩进」，2026-09-14）。
 *
 * 交给 CodeMirror 的 `indentUnit` facet（见 `Editor.svelte` 的 buildExtensions）：
 * Tab / Shift+Tab（`indentWithTab` → indentMore / indentLess）与任何语言侧的自动缩进都用它。
 * **回车那条不用它** —— 新行缩进是照抄上一行**实际**的空白（见 indentForNewLine），
 * 所以老文档里已有的 2 空格缩进不会被强行改成 4 格。
 *
 * typst 官方风格是 2 空格，但这是用户的选择，别再"照规范"改回去。
 */
export const INDENT_UNIT = "    ";

/**
 * 换行后新行要带的缩进 = **光标左侧那一段前导空白**（空格 / 制表符）。
 *
 * - 光标在行尾（最常见）：整行的前导空白照抄 → 新行缩进与上一行完全一致；
 * - 光标停在缩进内部：只取光标左边那一段，不会凭空多出光标右侧的空格；
 * - 纯空白行（`isBlankLine`）：返回空串 —— 连按回车不该堆出一串"带缩进的空行"，
 *   那串残留空白由调用方顺手清掉（CodeMirror 默认行为也是如此）；
 * - 没有缩进 / 光标在行首：空串，即普通的换行。
 *
 * 只认**行首**的空白，行内空格不算缩进（`abc  def` 换行后新行不缩进）。
 */
export function indentForNewLine(lineText: string, caretColumn: number): string {
  if (isBlankLine(lineText)) return "";
  const lead = /^[ \t]*/.exec(lineText)?.[0] ?? "";
  return lead.slice(0, Math.max(0, Math.min(caretColumn, lead.length)));
}
