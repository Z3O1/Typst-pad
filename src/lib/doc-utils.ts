// doc-utils：文档内容工具（纯函数，独立模块便于单测）

/**
 * 判断文档是否为"空文档"（无有效内容，可直接关闭、无需保存确认）：
 * 内容为空字符串或仅由空白字符（空格、制表符、换行等）组成时视为空。
 *
 * 注意：关闭判断以**内容**为准而非 dirty 标志——
 * 用户输入过内容又全部删光后 dirty 仍为 true，但此时已无可丢失的内容。
 */
export function isBlankDoc(doc: string): boolean {
  return doc.trim().length === 0;
}
