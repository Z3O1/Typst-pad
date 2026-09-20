// 编译警告的可读化：把 typst 的英文警告翻成「能照着做」的中文提示。
//
// 起因：字体族名写错时 typst **只发 warning 不报错**（`unknown font family: X`），于是静默改用
// 别的字体渲染——用户看到的现象就是"改了字体没用"（实测：写中文族名"微软雅黑"、或写本机没装的
// "Songti SC"，都只会回退到楷体）。把警告显示出来、并说明该怎么办，是唯一的补救。

/** typst 的 `unknown font family: X` → 中文可行动提示；其它警告原样返回 */
export function describeCompileWarning(message: string): string {
  const matched = /^unknown\s+font\s+family:\s*(.+)$/i.exec(message.trim());
  if (!matched) return message;
  const name = matched[1].trim();
  return (
    `未知字体族「${name}」：可用字体里没有它，typst 已改用其他字体渲染` +
    `（这就是"改了字体没生效"的原因）。系统字体的族名要用英文名` +
    `（如 Microsoft YaHei，而不是"微软雅黑"）；也可以把字体文件放进` +
    `「额外字体目录」，再到「正文字体」里选它。`
  );
}
