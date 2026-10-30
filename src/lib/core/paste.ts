// **粘贴内容的纯决策**：文件名、Typst 片段、HTML→纯文本。
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
 * 拼进目标路径就是一次路径穿越（Rust 侧 `validate_write_path` 会拒，这里先不给它机会）。
 * 序号由调用方单调递增（见 `file-ops.ts`），同一秒连贴多张不会互相覆盖。
 */
export function pastedImageName(mime: string, at: Date, seq = 0): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `image-${stamp}-${Math.max(0, Math.floor(seq))}.${imageExtension(mime)}`;
}

/** 插进源码的 Typst 片段（路径里的反斜线与引号按 JSON 字符串转义，Windows 路径也不破语法） */
export function imageSnippet(relativePath: string): string {
  return `#image(${JSON.stringify(relativePath)})`;
}

/**
 * HTML 片段 → 纯文本（**只抽文本**，不做 Markdown/Typst 转换）。
 *
 * 换行按块级标签补：`<p>`/`<div>` 等在浏览器里复制出来时没有换行，直接取 `textContent`
 * 会把整段挤成一行。段落之间统一补成**一个空行**（Typst 里两个换行才是新段落，单个换行只是空格）；
 * 列表项补 `- ` 且项与项之间只隔一个换行，不把列表拆成两段。`script` / `style` 的内容丢掉。
 */
export function htmlToText(html: string): string {
  if (html === "") return "";
  if (typeof DOMParser === "undefined") return html.replace(/<[^>]*>/g, "");
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.body) return "";
  const paragraphs = new Set(["P", "DIV", "SECTION", "ARTICLE", "TR", "TABLE", "UL", "OL"]);
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
    if (tag === "LI") {
      // 项与项之间只隔一个换行：项里带 `<p>` 时空段会被清掉，不把列表拆成两个。
      out = out.replace(/\n+$/, "\n");
      if (out !== "" && !out.endsWith("\n")) out += "\n";
      out += "- ";
    }
    for (const child of Array.from(el.childNodes)) walk(child);
    // 块级标签补一个空行：空 `<p></p>` 就是一个空段落，靠后面的收敛去重。
    if (paragraphs.has(tag)) out += "\n\n";
  };
  walk(doc.body);
  return out
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
}
