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

/**
 * 保存前是否需要"空文档覆盖"二次确认。
 *
 * 判定的是**最危险的那个组合**：`filePath` 非空（= 会写在已有文件上）且文档为空（含仅空白）。
 * 2026-09-16 用户问「编辑器会清空文件吗」时问到的就是这个场景 —— 正常路径下应用**从不自己写盘**
 * （全工程只有 `saveTypFile` 一个 `.typ` 写入口，只挂在显式保存上），能在磁盘上留下空文件的
 * 只有"内容为空 + 目标是已有文件 + 用户按了保存"这一条，所以给它补一道确认。
 *
 * `filePath` 为 null（另存为对话框还没选目标）时**不需要**确认：那是新建一个文件，覆盖不到任何东西。
 */
export function needsBlankOverwriteConfirm(filePath: string | null, doc: string): boolean {
  return filePath !== null && isBlankDoc(doc);
}

/**
 * 规范化编译前缀：非空前缀且未以 `\n` 结尾时在末尾补一个换行，其余情况原样返回。
 *
 * 动机：编译/导出时拼接 `prefixCode + doc`，若前缀末行与用户文档首行直接相连
 * （如前缀是 `// 注释` 且无尾换行，会把用户首行吞成注释），两段内容边界错乱；
 * 补尾随换行后各归其行，用户文档从编译源固定第 N+1 行开始。
 *
 * 幂等性：空串、已以 `\n` 结尾的输入均原样返回，重复调用不改变结果——
 * 因此可放心同时用于「实际编译源」与「Editor 的 prefixCode prop」等各处，不会互相不一致。
 */
export function ensureTrailingNewline(prefix: string): string {
  if (prefix.length === 0 || prefix.endsWith("\n")) return prefix;
  return prefix + "\n";
}
