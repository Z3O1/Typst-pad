// doc-utils：文档层纯函数（独立模块便于单测）。三类：
// - 内容判定：isBlankDoc / isEffectiveDirty
// - 路径 / 名字：fileNameOf / UNTITLED_TITLE / isTypPath / pickTypPath
// - 编译前缀：ensureTrailingNewline
// 名字类只有这两个、合计十来行，先放一起；**再往这里加名字类函数就该拆 `doc-names.ts`**。

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

/** 未命名文档的标题（页面 `fileTitle` 的初值、"新建"、以及"存档里没路径时"都用它） */
export const UNTITLED_TITLE = "未命名.typ";

/** 判断路径是否为 .typ 文件（**大小写不敏感**：`.TYP` 也算，Windows 上很常见） */
export function isTypPath(path: string): boolean {
  return path.toLowerCase().endsWith(".typ");
}

/** 从一批路径里选出**第一个** `.typ` 文件（拖放 / 命令行参数里夹着别的东西时用）；没有则 null */
export function pickTypPath(paths: readonly string[]): string | null {
  return paths.find(isTypPath) ?? null;
}

/**
 * 从路径取文件名（`C:\Users\me\论文.typ` 与 `/home/me/论文.typ` 都要认，两种分隔符都切）；
 * 取不到分隔符就原样返回。窗口标题、拖放确认文案、存档恢复的标题都用它。
 */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
