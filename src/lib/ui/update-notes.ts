// 更新说明的 Markdown 渲染（纯函数）。
//
// 为什么要自己写：更新弹窗里的「更新说明」是 `latest.json` 的 `notes` 字段，内容来自本仓库
// `CHANGELOG.md` 里该版本的正文（见 scripts/generate-latest-json.mjs）——是 Markdown。
// 以前直接塞进 `<pre>`，于是用户在弹窗里看到的是 `### Fixed`、`**中文不再被渲染成楷体**`
// 这种原文（反馈：「更新说明无法渲染」）。
//
// 只用**受控子集**，不引入 Markdown 依赖，也不允许任何 HTML 透传：
//   1. 先整体 HTML 转义（`& < > " '`），之后只由本模块生成标签 —— 即使远端清单被人塞了
//      `<img onerror=...>`，落到弹窗里也只是这几个字符的文本（这是唯一的安全边界）；
//   2. 支持 CHANGELOG 真正用到的语法：`#`~`######` 标题、`-`/`*`/`+` 无序列表（含两空格缩进的
//      嵌套）、`1.` 有序列表、`**粗体**`、`` `行内代码` ``、`---` 分隔线、空行分段；
//   3. **故意不支持**：斜体（`*x*` 与乘法/列表符号混淆，CHANGELOG 也没用）、链接（弹窗里点了
//      会把整个应用窗口导航到外站，宁可显示成 `[文字](地址)` 原文）、原始 HTML 块。
// 拿不准的一律当普通文本显示 —— 宁可少渲染，不可渲染错。

/** HTML 转义表（含引号：属性虽不来自这里，但转义齐全更省心） */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** 更新说明的长度上限：超出部分丢掉并明说（防止被人塞一份巨型清单把弹窗撑爆） */
export const NOTES_MAX_CHARS = 8192;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * 行内语法：`` `代码` `` 与 `**粗体**`。
 * 代码片段先摘出来占位，避免代码里的 `**`（如 `` `a**b**` ``）被当成粗体。
 */
function renderInline(escaped: string): string {
  const codes: string[] = [];
  // 代码片段：内容已转义，直接塞进 <code>
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // 粗体：要求星号紧贴非空白文本，避免把 "a ** b" 这种普通写法当粗体
  out = out.replace(/\*\*([^\s*][^*]*?)\*\*/g, "<strong>$1</strong>");
  // 还原代码片段（占位符不可能与正文冲突：正文里的 \u0000 已在转义阶段被清掉）
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

/** 标题层级：`#`~`###` 用 h4（CHANGELOG 的 `### Added` 就是这一档），`####` 及更深用 h5 */
function renderHeading(level: number, text: string): string {
  return level <= 3 ? `<h4>${text}</h4>` : `<h5>${text}</h5>`;
}

/**
 * 更新说明（Markdown 子集）→ 安全的 HTML 片段。调用方用 `{@html …}` 渲染。
 */
export function renderUpdateNotes(markdown: string): string {
  if (!markdown) return "";
  let text = markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  let truncated = false;
  if (text.length > NOTES_MAX_CHARS) {
    text = text.slice(0, NOTES_MAX_CHARS);
    truncated = true;
  }
  // 制表符按两空格展开，缩进层级才可计算
  text = text.replace(/\t/g, "  ");

  const out: string[] = [];
  /**
   * 已打开的列表层级：缩进宽度 + 标签 + 该层是否有一个还没闭合的 `<li>`。
   * 嵌套列表必须开在**上一层的 `<li>` 内部**（`<ul><li>a<ul>…</ul></li></ul>` 才合法），
   * 所以缩进变深时不急着闭合外层 li，等回到同层或收尾时再闭。
   */
  const lists: { tag: "ul" | "ol"; indent: number; liOpen: boolean }[] = [];
  /** 段落缓冲：连续普通行按 Markdown 语义合成一段 */
  let paragraph: string[] = [];

  /** 收尾：闭合 li 与列表（从最深层往外） */
  const closeLists = () => {
    while (lists.length > 0) {
      const level = lists.pop()!;
      if (level.liOpen) out.push("</li>");
      out.push(`</${level.tag}>`);
    }
  };
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${renderInline(escapeHtml(paragraph.join(" ")))}</p>`);
    paragraph = [];
  };
  /** 在当前缩进层级放一个列表项，必要时开关列表与嵌套层级 */
  const pushItem = (tag: "ul" | "ol", indent: number, html: string) => {
    // 回到更浅的层级：把更深的列表连同它的 li 一起闭合
    while (lists.length > 0 && lists[lists.length - 1].indent > indent) {
      const level = lists.pop()!;
      if (level.liOpen) out.push("</li>");
      out.push(`</${level.tag}>`);
    }
    const top = lists[lists.length - 1];
    if (!top || top.indent < indent) {
      // 缩进变深（或第一个列表）：开一个嵌套列表
      lists.push({ tag, indent, liOpen: false });
      out.push(`<${tag}>`);
    } else {
      // 同层级：先闭合上一个 li
      if (top.liOpen) out.push("</li>");
      if (top.tag !== tag) {
        // 同缩进但列表类型变了（无序 → 有序）：关掉再开
        lists.pop();
        out.push(`</${top.tag}>`);
        lists.push({ tag, indent, liOpen: false });
        out.push(`<${tag}>`);
      }
    }
    out.push(`<li>${html}`);
    lists[lists.length - 1].liOpen = true;
  };

  for (const line of text.split("\n")) {
    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeLists();
      out.push(renderHeading(heading[1].length, renderInline(escapeHtml(heading[2].trim()))));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      closeLists();
      out.push("<hr />");
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      pushItem("ul", bullet[1].length, renderInline(escapeHtml(bullet[2].trim())));
      continue;
    }
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      pushItem("ol", numbered[1].length, renderInline(escapeHtml(numbered[2].trim())));
      continue;
    }
    // 普通行：列表内的续行归并进段落（缩进无意义），列表外按 Markdown 合成一段
    closeLists();
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeLists();

  if (truncated) out.push("<p>…（更新说明过长，已截断）</p>");
  return out.join("");
}
