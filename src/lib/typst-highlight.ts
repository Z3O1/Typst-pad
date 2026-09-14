// 标题不要下划线 —— 这条下划线是 codemirror-lang-typst 自带的高亮塞进来的，不是我们的样式。
//
// 现象：写作模式里标题正文下面挂一条下划线（用户反馈「`== 1` 在写作模式有下划线」），
// 源码模式则是整行 `== 1` 带下划线；文档里没有任何开关能关掉它。
//
// 根因在依赖里：
//   `typst()` 会装上它自己那份高亮样式 `TypstHighlightSytle`，第一条就是
//   `{ tag: tags.heading, color: "black", fontWeight: "bold", textDecoration: "underline" }`；
//   而它的 styleTags 表里写的是 `"Heading/...": tags.heading` —— `/...` 表示**整个 Heading 子树**，
//   于是标题正文（`== 1` 里的 `1`）也带上 heading 标签，跟着吃到那条下划线。
//   写作模式会把 `== ` 藏掉、正文放大加粗，所以下划线显得格外扎眼。
//
// 为什么必须写 `!important`：CM6 里多份高亮样式不是覆盖关系，而是把各自的 CSS 类**并集**加到同一个
// 元素上（见 `syntaxHighlighting` 的文档："the styling applied is the union of the classes they
// emit"），两条规则同优先级 —— 谁赢只看样式表里的先后，而各 StyleModule 的挂载顺序由扩展树顺序决定
// （`@codemirror/view` 的 mountStyles 还会 reverse 一遍），太脆。用 `!important` 让"标题没有下划线"
// 这件事不依赖挂载顺序。
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

/** 覆盖标题下划线的那份高亮样式（单独导出，便于单测直接看它生成的 CSS 规则） */
export const typstHeadingHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, textDecoration: "none !important" },
]);

/** 挂在 `typst()` 之后即可（顺序无关，靠 `!important` 取胜） */
export const typstHeadingHighlight = syntaxHighlighting(typstHeadingHighlightStyle);
