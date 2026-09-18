// 失败文案（纯函数，可单测）。
//
// 背景（交接文档「已知未决」里记着的那条）：状态栏此前只写「保存失败」「打开失败」，
// 把 Rust 侧那句真正的原因（`仅支持 .typ 文件` / `目录无效` / 没有写入权限 …）吞掉了 ——
// 用户看到"失败了"却不知道能改什么。现在把原因接在冒号后面，原因拿不到时才退回单句。
//
// 为什么单独一个模块：`invoke` 抛出来的东西形状不固定（字符串 / Error / 带 message 的对象），
// 而"从里面抠出一句人话 + 折成一行"是纯逻辑，放在页面里就只能靠肉眼看了。

/**
 * 折成一行：状态栏是单行省略号，`\n` 会让后面那句直接被吃掉
 * （typst 的诊断、系统错误都是多行的，实测「导出失败」后面那句以前因此看不见）。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 从 `invoke` 抛出的东西里抠出一句原因；拿不到就返回空串。
 *
 * 覆盖：字符串（Rust 命令 `Result<_, String>` 的常见形态）、`Error`、`{ message }` 对象、
 * 其它值（`String(v)`，再兜一层 `try` —— `toString` 也可能抛）。
 */
export function describeFailure(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return oneLine(error);
  if (error instanceof Error) return oneLine(error.message);
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return oneLine(message);
  }
  try {
    return oneLine(String(error));
  } catch {
    return "";
  }
}

/**
 * 状态栏的失败文案：`failureStatus("保存失败", e)` → 「保存失败：仅支持 .typ 文件」；
 * 拿不到原因时就只是「保存失败」（不写一个光秃秃的冒号）。
 */
export function failureStatus(action: string, error: unknown): string {
  const reason = describeFailure(error);
  return reason ? `${action}：${reason}` : action;
}
