// 所见即所得相关样式（块切片 / 公式 widget / 常用标记的排版细节）。
// 纯样式表、无逻辑依赖 —— 但**别改成 `&dark` 选择器**（见 CLAUDE.md「所见即所得」）。
import { EditorView } from "@codemirror/view";

/** 所见即所得相关样式（公式 widget + 常用标记） */
export const mathWidgetTheme = EditorView.theme({
  // 块切片（写作模式的"渲染表面"）：正文列满宽、高度由 SVG 的固有比例决定 ——
  // 不写死高度，窗口宽度变化到下一次重编译之间也不会变形。line-height 归零避免
  // 行盒在 SVG 下方多出一截（与 .cm-math-block 同一个理由）。
  ".cm-block-crop": {
    display: "block",
    lineHeight: "0",
    cursor: "text",
    // 链接热区用百分比定位，需要它当定位参照
    position: "relative",
  },
  // 切片内部的链接热区（透明，悬停时给一条下划线做提示）
  ".cm-block-crop-link": {
    position: "absolute",
    cursor: "pointer",
    borderRadius: "2px",
  },
  ".cm-block-crop-link:hover": {
    backgroundColor: "rgba(128, 128, 128, 0.18)",
    textDecoration: "underline",
  },
  ".cm-block-crop:hover": {
    backgroundColor: "rgba(128, 128, 128, 0.06)",
  },
  // 整块被选中（没展开）：整张切片罩一层淡色，表示"这块在选区里"。
  // 两条硬约束（都踩过，用户直接发来截图说「太丑了」）：
  // ① **不能只给容器加背景色**：切片 SVG 自带不透明的白纸底，容器背景只在相邻切片的缝里漏出来，
  //    整页看上去是一张细蓝线网格。所以选中色由 .cm-block-crop-tint 铺在 **SVG 之上**（见 toDOM）。
  // ② **不要 outline**：切片上下相邻、描边首尾相接，全选时同样变成网格。
  // 颜色取编辑器自己的选区底色（CodeMirror 默认 #d7d4f0）→ "被选中的切片"与"被选中的源码"
  // 看上去是同一件事，相邻切片连成一片浅紫，像一段正常选区。
  // （容器本身已经是 position: relative，见 .cm-block-crop —— 链接热区也靠它定位。）
  ".cm-block-crop-tint": {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgba(122, 112, 205, 0.3)",
    // 只负责"染色"，不拦事件：切片的点击/拖选由 mouseSelectionStyle 处理，
    // 链接热区也是绝对定位铺在上面的（pointer-events: none 才不会挡住它们）。
    pointerEvents: "none",
  },
  ".cm-block-crop svg": {
    display: "block",
    width: "100%",
    height: "auto",
  },
  // 暗色：typst 产物是白底黑字（页面自带白底），整体反色后即"深色纸 + 浅色字"，
  // 与既有公式 widget 的反色策略一致（文档自带颜色会被反掉，见调研文档第三节）
  ".cm-block-crop-dark svg": {
    filter: "invert(1)",
  },

  ".cm-math-widget": {
    display: "inline-block",
    lineHeight: "0",
    cursor: "text",
    // 悬停时给一点反馈（与源码区分，但不抢眼）
    borderRadius: "2px",
  },
  ".cm-math-widget:hover": {
    backgroundColor: "rgba(128, 128, 128, 0.18)",
  },
  // 选区**完整盖住**这个公式时保持渲染外观（用户要求「选中整个公式请不要展开」）：
  // 用一层淡色底表示"它在选区里" —— 与块切片的 .cm-block-crop-selected 同一套视觉
  //（= 编辑器选区底色 #d7d4f0）；只给底色、不加 outline，行内公式描边在整行文字里显得碎。
  ".cm-math-selected": {
    backgroundColor: "rgba(122, 112, 205, 0.3)",
  },
  ".cm-math-widget svg": {
    display: "block",
    width: "100%",
    height: "100%",
  },
  // 暗色主题：typst 产物是黑字透明底，深色背景上会看不见 → 整体反色
  // （只影响黑色笔画，透明底保持不变）。暗色标记由 Editor.svelte 按主题注入
  // （不用 `&dark` 选择器：EditorView.theme 不支持该前缀，实测抛 "Unsupported selector: &dark"）。
  ".cm-math-dark svg": {
    filter: "invert(1)",
  },
  // 独占整行的行间公式：居中显示（与 typst 的独立式子一致）
  ".cm-math-block": {
    textAlign: "center",
    padding: "4px 0",
    cursor: "text",
    lineHeight: "0",
  },
  // 单行行间公式：widget 落在行内（不是整行 block 替换），由所在行居中。
  // 这样它在被选区完整盖住时可以保持渲染而不影响打字（见 buildMathDecorations 的说明）。
  ".cm-math-block-inline": {
    display: "inline-block",
  },
  ".cm-math-line": {
    textAlign: "center",
  },
  // Typst 的段落分隔仍保留为空白源码行，但它不能沿用 1.65em 普通行高。
  // 行数因子在装饰上分配：多个连续空行共享同一段距，且每行仍有可编辑的行盒。
  ".cm-write-parbreak": {
    lineHeight: "var(--write-parbreak-height, 1.65)",
  },
  // 展开占位的空白（报告 T4）：只占高度，不参与任何交互（`ReserveWidget.ignoreEvent` 也返回
  // true，两道保险 —— 点它既不移动光标也不打断拖选）
  ".cm-reserve-spacer": {
    pointerEvents: "none",
  },
  ".cm-math-block:hover": {
    backgroundColor: "rgba(128, 128, 128, 0.12)",
  },
  ".cm-math-block-box": {
    display: "inline-block",
  },
  // 代码块（``` 围栏）：与 typst 的块级 raw 观感一致（等宽 + 浅底 + 圆角）
  ".cm-raw-block": {
    padding: "6px 8px",
    backgroundColor: "rgba(128, 128, 128, 0.14)",
    borderRadius: "4px",
    cursor: "text",
  },
  ".cm-raw-block-pre": {
    margin: "0",
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: "0.92em",
    lineHeight: "1.45",
    whiteSpace: "pre",
    overflowX: "auto",
  },
  // 列表符号替换文本：与正文同宽字符宽度，避免行首缩进跳动
  ".cm-markup-replacement": {
    color: "inherit",
  },
  // 常用标记样式：标题按级别放大加粗；粗体/斜体/行内代码沿用编辑器前景色
  ".cm-markup-heading": {
    fontWeight: "700",
  },
  ".cm-markup-strong": {
    fontWeight: "700",
  },
  ".cm-markup-emph": {
    fontStyle: "italic",
  },
  // 链接文字：蓝色下划线（两种主题下都够醒目）
  ".cm-markup-link": {
    color: "#3d8bfd",
    textDecoration: "underline",
    cursor: "pointer",
  },
  ".cm-markup-raw": {
    fontFamily: "Consolas, 'Courier New', monospace",
    backgroundColor: "rgba(128, 128, 128, 0.18)",
    borderRadius: "2px",
  },
  // 标题字号梯度**必须跟 typst 一致**（heading.rs 的 ShowSet：1.4 / 1.2 / 1.0em，level 3 起只加粗），
  // 否则块级切片与"光标进入后展开的源码"字号对不上（用户报「在标题所在块，标题就会变的很大」）。
  // 写作模式下 Editor.svelte 的同名规则（带 .editor-host.write 前缀，优先级更高）会覆盖这里。
  ".cm-markup-heading-1": { fontSize: "1.4em", lineHeight: "1.5" },
  ".cm-markup-heading-2": { fontSize: "1.2em", lineHeight: "1.45" },
  ".cm-markup-heading-3": { fontSize: "1em", lineHeight: "1.4" },
  ".cm-markup-heading-4": { fontSize: "1em" },
  ".cm-markup-heading-5": { fontSize: "1em" },
  ".cm-markup-heading-6": { fontSize: "1em" },
});
