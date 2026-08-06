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

/**
 * 判断是否存在"实际未保存的修改"（打开其他文件/重新读取/窗口标题圆点等判断用）：
 * dirty 为 true 且内容非空（含仅空白视为空）时才有可丢失的内容，需要确认。
 *
 * 语义 = dirty && !isBlankDoc(doc)：用户输入过内容又全部删光后 dirty 仍为 true，
 * 但此时内容为空、无可丢失的内容，视为未修改。
 */
export function isEffectiveDirty(dirty: boolean, doc: string): boolean {
  return dirty && !isBlankDoc(doc);
}
