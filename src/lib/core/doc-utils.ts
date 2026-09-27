// doc-utils：文档层纯函数（独立模块便于单测）。三类：
// - 内容判定：isBlankDoc / isDocModified
// - 路径 / 名字：fileNameOf / UNTITLED_TITLE / isTypPath / pickTypPath
// - 编译前缀：ensureTrailingNewline
// 名字类只有这两个、合计十来行，先放一起；**再往这里加名字类函数就该拆 `doc-names.ts`**。

/**
 * 判断文档是否为"空文档"（无有效内容）：内容为空字符串或仅由空白字符（空格、制表符、换行等）组成时视为空。
 *
 * 今天只有启动恢复用它（空白的存档不算"上次内容"，见 `session-restore` 的 `planContent`）。
 * **它不再是"未修改"的判据** —— 一篇"打开时有内容、被用户全选删光"的文档是空白文档，但它
 * 当然是改过的；判断有没有未保存修改只看 `isDocModified`。
 */
export function isBlankDoc(doc: string): boolean {
  return doc.trim().length === 0;
}

/**
 * 判断正文相对「基线」有没有未保存修改 —— 窗口标题圆点、打开/重读/新建/关闭的确认框共用这一条判据。
 *
 * 基线 = **上次打开 / 保存时**的正文（页面 `baseline` 状态）。"改过没有"只有一条标准：
 * `doc !== baseline`，**不许**退化成"正文是不是空白"或"编辑过没有"这类标志位：
 * - 打开一篇有内容的文件再全选删光：正文为空，但与基线不同 ⇒ **是**未保存修改。
 *   旧判据 `dirty && !isBlankDoc(doc)` 在这里判成"未修改"（圆点消失、关窗不问），
 *   用户报的「判断未修改的逻辑根本不对」就是它。
 * - 打字后又撤销回原样：正文与基线逐字符相同 ⇒ 圆点实时清掉，不必等保存。
 * - 「未命名.typ」新文档的基线是空串：输入过又全删光 ⇒ 与基线相同 ⇒ 不算修改。
 *
 * `baseline` 为 `null` = 基线未知：存档恢复出来的未保存文档只存了正文与脏标记、没存基线
 * （基线就是整篇正文，再存一份会把 localStorage 撑成两倍），此时按"有修改"保守处理 ——
 * 圆点留着，用户保存一次就落到真实基线。
 */
export function isDocModified(doc: string, baseline: string | null): boolean {
  return baseline === null || doc !== baseline;
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
