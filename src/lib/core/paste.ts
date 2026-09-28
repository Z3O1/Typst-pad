// **粘贴内容的纯决策**（typora-parity 审计 P0-4）：文件名、Typst 片段、HTML→纯文本。
//
// 只有纯函数与字符串处理，DOM 事件接线在 `editor/paste.ts`（那层不许被 core 反向依赖）。
// 写盘与路径策略在 `core/file-ops.ts`（走 Rust 侧 `write_binary` 的路径校验）。

/** `image/png` → `png`（未知类型给 `bin`，绝不用剪贴板里的原始文件名拼路径） */
export function imageExtension(mime: string): string {
  const sub = mime.startsWith("image/") ? mime.slice("image/".length) : "";
  const clean = sub.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (clean === "jpeg") return "jpg";
  return clean === "" ? "bin" : clean;
}

/**
 * 粘贴图片的文件名：`image-20260928-071530-2.png`。
 *
 * **只用时间戳 + 序号**，不碰剪贴板里的原始文件名 —— 那个字段可以在 Windows 上带路径分隔符，
 * 拼进目标路径就是一次路径穿越（Rust 侧 `validate_write_path` 会拒，但这里先不给它机会）。
 */
export function pastedImageName(mime: string, at: Date, seq = 0): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `image-${stamp}-${Math.max(0, Math.floor(seq))}.${imageExtension(mime)}`;
}

/** 插进源码的 Typst 片段（路径里的反斜线与引号要转义，Windows 路径也不至于破语法） */
export function imageSnippet(relativePath: string): string {
  return `#image(${JSON.stringify(relativePath)})`;
}

/**
 * HTML 片段 → 纯文本（**只抽文本**，不做 Markdown/Typst 转换）。
 *
 * 换行按块级标签补：`<p>`/`<br>`/`<li>`/`<div>` 等在浏览器里复制出来时是没有换行的，
 * 直接 `textContent` 会把整段挤成一行。列表项补 `- `，让"从网页复制一段列表"至少保留结构。
 */
export function htmlToText(html: string): string {
  if (html === "") return "";
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]*>/g, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return "";
  const blocks = new Set(["P", "DIV", "SECTION", "ARTICLE", "BR", "TR", "TABLE", "UL", "OL"]);
  let out = "";
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (tag === "BR") {
      out += "\n";
      return;
    }
    const listItem = tag === "LI";
    if (listItem && out !== "" && !out.endsWith("\n")) out += "\n";
    if (listItem) out += "- ";
    for (const child of Array.from(el.childNodes)) walk(child);
    // 块级标签**总是**补一个换行：空的 `<p></p>` 就是"一个空段落"，靠后面的
    // `\n{3,}` 收敛成最多一个空行（去重会把空段落整段吃掉）
    if (blocks.has(tag)) out += "\n";
  };
  walk(doc.body);
  return out.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}
