// 所见即所得（公式内联渲染）的浏览器端验证：真实输入 + 真实选区 + 截图取证。
//
// 前置：
//   1) npm run dev -- --host 0.0.0.0 --port 1420
//   2) Windows headless Chrome（见 cdp.mjs 顶部注释）打开
//      http://localhost:1420/?browserdev=1
// 运行：node scripts/browser-check/wysiwyg.mjs
//
// 说明：浏览器开发模式下 compile_math 由桩实现（假 SVG，尺寸量级合理），
// 因此这里验证的是**编辑器的装饰/选区/开关链路**；公式的真实排版由 Rust 单测覆盖
// （cargo test compile_math）。
import { connect, DEV_URL } from "./cdp.mjs";

// 截图写到仓库内（.browser-check/，见 .gitignore）：沙箱只允许写工作区，
// 而 Chrome 需要 Windows 路径 —— 故用 CDP 取 base64 后由 Node 落到仓库里。
const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;

/** 断言 + 计数 */
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    process.exitCode = 1;
  }
}

const c = await connect();
await c.goto(DEV_URL);
// 清掉上一轮遗留的界面模式 / 主题，保证从默认态（写作模式）开始：
// 否则上一轮若停在源码模式，页面加载后不渲染任何公式，第一条断言就会莫名超时（实测踩过）
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

/** 编辑器内的可见文本（widget 已替换的部分不出现，除非有 title/aria） */
const editorText = `document.querySelector(".cm-content").innerText`;
/** 行内公式 widget 数量 */
const widgetCount = `document.querySelectorAll(".cm-math-widget").length`;
/** 独占整行的行间公式块级 widget 数量 */
const blockCount = `document.querySelectorAll(".cm-math-block").length`;
/** widget 的几何（宽高 pt/px 与垂直对齐），用于核对基线对齐 */
const widgetGeo = `Array.from(document.querySelectorAll(".cm-math-widget")).map(w => {
  const r = w.getBoundingClientRect();
  const line = w.closest(".cm-line");
  const lr = line.getBoundingClientRect();
  const cs = getComputedStyle(w);
  return {
    text: w.title,
    widthPx: Math.round(r.width * 10) / 10,
    heightPx: Math.round(r.height * 10) / 10,
    inlineWidth: w.style.width,
    inlineHeight: w.style.height,
    verticalAlign: cs.verticalAlign,
    // 盒底相对所在行文本内容区底部的偏移（越大表示下沉越多）
    fromLineBottom: Math.round((lr.bottom - r.bottom) * 10) / 10,
    hasSvg: !!w.querySelector("svg"),
    svgFill: w.querySelector("text")?.getAttribute("fill") ?? null,
  };
})`;

console.log("1) 输入含行内/行间公式的文档");
await c.click(400, 300); // 点进编辑器
await c.type("行内公式 $x^2 + y^2$ 结束\n");
await c.type("$ frac(a,b) $\n");
await c.type("普通文字结尾");
await c.waitFor(widgetCount + ` === 1 && ` + blockCount + ` === 1`, { timeout: 8000 });
const text1 = await c.evaluate(editorText);
const geo1 = await c.evaluate(widgetGeo);
check("行内公式 → 行内 widget", geo1.length === 1, JSON.stringify(geo1));
check("widget 内含 SVG", geo1.every((g) => g.hasSvg));
check(
  "行内公式源码被替换（DOM 里看不到 $x^2 + y^2$）",
  !text1.includes("$x^2 + y^2$"),
  JSON.stringify(text1),
);
check(
  "行间公式源码被替换（DOM 里看不到带定界符的 $ frac(a,b) $）",
  !text1.includes("$ frac(a,b) $"),
  JSON.stringify(text1),
);
// 注：widget 的假 SVG 里含公式文本（stub 用 <text> 画字），所以只断言定界符消失，
// 真实 Rust 产物是字形路径，不含可搜索文本。
check("公式外的文字仍在", text1.includes("行内公式") && text1.includes("普通文字结尾"));
check(
  "尺寸按 pt 内联样式给出（Rust 契约的 widthPt/heightPt）",
  geo1.every((g) => g.inlineWidth.endsWith("pt") && g.inlineHeight.endsWith("pt")),
  JSON.stringify(geo1.map((g) => [g.inlineWidth, g.inlineHeight])),
);
// 独占整行的行间公式走块级 widget（居中），比行内 widget 高（display 风格）
const blockGeo = await c.evaluate(`(() => {
  const b = document.querySelector(".cm-math-block-box");
  const r = b.getBoundingClientRect();
  return { widthPx: Math.round(r.width * 10) / 10, heightPx: Math.round(r.height * 10) / 10 };
})()`);
check(
  "行间公式（块级）明显高于行内公式（display 风格）",
  blockGeo.heightPx > geo1[0].heightPx * 1.8,
  JSON.stringify([geo1[0].heightPx, blockGeo.heightPx]),
);
await c.screenshot(SHOT("wysiwyg-1-rendered"));

console.log("2) 光标进入公式区间 → 展开源码（Typora 式）");
const inlineRect = await c.evaluate(`(() => {
  const w = document.querySelectorAll(".cm-math-widget")[0];
  const r = w.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(inlineRect.x, inlineRect.y);
await c.waitFor(widgetCount + ` === 0`, { timeout: 5000 });
const text2 = await c.evaluate(editorText);
check("光标所在的公式展开为源码（行内 widget 1 → 0）", true);
check("源码重新可见", text2.includes("$x^2 + y^2$"), JSON.stringify(text2));
check(
  "另一个公式仍保持渲染（其定界符仍不可见）",
  !text2.includes("$ frac(a,b) $"),
  JSON.stringify(text2),
);
await c.screenshot(SHOT("wysiwyg-2-caret-inside"));

console.log("3) 光标移出 → 恢复渲染");
await c.key("ArrowRight", { code: "ArrowRight", keyCode: 39 });
await c.key("ArrowRight", { code: "ArrowRight", keyCode: 39 });
await c.key("End", { code: "End", keyCode: 35 });
await c.waitFor(widgetCount + ` === 1 && ` + blockCount + ` === 1`, { timeout: 5000 });
const text3 = await c.evaluate(editorText);
check("光标离开后重新渲染（行内 widget 回到 1、块级仍在）", !text3.includes("$x^2 + y^2$"), JSON.stringify(text3));
await c.screenshot(SHOT("wysiwyg-3-caret-outside"));

console.log("4) 视图菜单「源代码模式」：开启 → 全部显示源码 + 右栏预览");
const menuRect = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll("button, [role=menuitem], .menu-label, span, div"))
    .find(e => (e.textContent || "").trim() === "视图(V)");
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(menuRect.x, menuRect.y);
await c.waitFor(`document.body.innerText.includes("源代码模式")`, { timeout: 5000 });
const itemRect = await c.evaluate(`(() => {
  // 只在展开的菜单下拉里找：状态栏可能显示同名的状态文字（"源代码模式"），
  // 在全页范围内查找会点到状态栏（实测踩过）
  const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
    .find(e => (e.textContent || "").includes("源代码模式"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.screenshot(SHOT("wysiwyg-4-menu"));
await c.click(itemRect.x, itemRect.y);
await c.waitFor(widgetCount + ` === 0 && ` + blockCount + ` === 0`, { timeout: 5000 });
const text4 = await c.evaluate(editorText);
check(
  "进入源代码模式后公式全部显示源码",
  text4.includes("$x^2 + y^2$") && text4.includes("frac(a,b)"),
  JSON.stringify(text4),
);
await c.screenshot(SHOT("wysiwyg-5-off"));

console.log("5) 再切回写作模式 → 恢复渲染（缓存命中，无需重新输入）");
await c.click(menuRect.x, menuRect.y);
await c.waitFor(`document.body.innerText.includes("源代码模式")`, { timeout: 5000 });
const itemRect2 = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
    .find(e => (e.textContent || "").includes("源代码模式"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(itemRect2.x, itemRect2.y);
await c.waitFor(widgetCount + ` === 1 && ` + blockCount + ` === 1`, { timeout: 5000 });
check("切回写作模式后恢复渲染（行内 + 块级各一个）", true);
await c.screenshot(SHOT("wysiwyg-6-on-again"));

console.log("6) 常用标记：标题 / 粗体 / 斜体 / 行内代码 / 列表符号");
await c.selectAll();
await c.type("= 标题测试\n\n这是 *粗体* 与 _斜体_ 和 `代码` 的段落。\n\n- 列表项\n");
await new Promise((r) => setTimeout(r, 600));
const markup = await c.evaluate(`(() => {
  const line = (n) => document.querySelectorAll(".cm-line")[n];
  const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
  const heading = document.querySelector(".cm-markup-heading");
  const strong = document.querySelector(".cm-markup-strong");
  const emph = document.querySelector(".cm-markup-emph");
  const raw = document.querySelector(".cm-markup-raw");
  const bodySize = parseFloat(getComputedStyle(document.querySelector(".cm-content")).fontSize);
  return {
    lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText),
    headingSize: heading ? parseFloat(getComputedStyle(heading).fontSize) : null,
    bodySize,
    strongWeight: strong ? getComputedStyle(strong).fontWeight : null,
    emphStyle: emph ? getComputedStyle(emph).fontStyle : null,
    rawFamily: raw ? getComputedStyle(raw).fontFamily : null,
    replacement: document.querySelector(".cm-markup-replacement")?.textContent ?? null,
  };
})()`);
check(
  "标题标记 `= ` 被隐藏，正文可见",
  markup.lines[0].trim() === "标题测试",
  JSON.stringify(markup.lines),
);
check(
  "标题字号大于正文（所见即所得的分级标题）",
  markup.headingSize > markup.bodySize * 1.3,
  `heading=${markup.headingSize} body=${markup.bodySize}`,
);
check("粗体标记 `*` 被隐藏（文字保留）", markup.lines[2].includes("粗体") && !markup.lines[2].includes("*"), JSON.stringify(markup.lines[2]));
check("粗体字重为 700", markup.strongWeight === "700", String(markup.strongWeight));
check("斜体样式生效且 `_` 被隐藏", markup.emphStyle === "italic" && !markup.lines[2].includes("_"), String(markup.emphStyle));
check("行内代码等宽显示且反引号被隐藏", /mono/i.test(markup.rawFamily ?? "") && !markup.lines[2].includes("`"), String(markup.rawFamily));
check("无序列表符号替换为圆点", markup.replacement === "• " && markup.lines[4].trim().endsWith("列表项"), JSON.stringify(markup));
await c.screenshot(SHOT("wysiwyg-7-markup"));

console.log("7) 光标进入标题 → 标记符号重新露出（可编辑源码）");
const headingRect = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-line").getBoundingClientRect();
  return { x: r.left + 30, y: r.top + r.height / 2 };
})()`);
await c.click(headingRect.x, headingRect.y);
await c.waitFor(`document.querySelectorAll(".cm-line")[0].innerText.trim().startsWith("=")`, {
  timeout: 5000,
});
const headingText = await c.evaluate(`document.querySelectorAll(".cm-line")[0].innerText.trim()`);
check("标题行的 `= ` 重新可见", headingText.startsWith("="), JSON.stringify(headingText));
await c.screenshot(SHOT("wysiwyg-8-markup-caret"));

console.log("8) 链接文字：隐藏 #link(...) 与方括号，文字带链接样式");
await c.selectAll();
await c.type('见 #link("https://typst.app")[官网] 说明\n');
await new Promise((r) => setTimeout(r, 600));
const link = await c.evaluate(`(() => {
  const el = document.querySelector(".cm-markup-link");
  const line = document.querySelectorAll(".cm-line")[0];
  return {
    line: line.innerText,
    color: el ? getComputedStyle(el).color : null,
    underline: el ? getComputedStyle(el).textDecorationLine : null,
  };
})()`);
check("链接只留文字（#link(...) 与方括号不可见）", link.line.includes("官网") && !link.line.includes("#link") && !link.line.includes("["), JSON.stringify(link.line));
check("链接文字带颜色与下划线", link.underline === "underline" && link.color !== "rgb(0, 0, 0)", JSON.stringify(link));
await c.screenshot(SHOT("wysiwyg-9-link"));

console.log("9) 独占整行的行间公式 → 块级 widget（居中）");
await c.selectAll();
await c.type("前文\n$\n  x^2 + y^2 = z^2\n$\n后文\n");
await c.waitFor(`document.querySelectorAll(".cm-math-block").length === 1`, { timeout: 8000 });
const block = await c.evaluate(`(() => {
  const b = document.querySelector(".cm-math-block");
  const r = b.getBoundingClientRect();
  const line = b.closest(".cm-line");
  const lr = line ? line.getBoundingClientRect() : null;
  const host = document.querySelector(".cm-content").getBoundingClientRect();
  return {
    textAlign: getComputedStyle(b).textAlign,
    widthPx: Math.round(r.width),
    // 相对编辑区左右两边的留白（居中时两侧接近相等）
    leftGap: Math.round(r.left - host.left),
    rightGap: Math.round(host.right - r.right),
    lineCount: document.querySelectorAll(".cm-line").length,
    lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText.trim()),
    hasSvg: !!b.querySelector("svg"),
  };
})()`);
check("跨行行间公式渲染为块级 widget（含 SVG）", block.hasSvg);
check("块级公式居中显示", block.textAlign === "center" && Math.abs(block.leftGap - block.rightGap) < 40, JSON.stringify(block));
check(
  "源码定界符消失、前后正文保留",
  block.lines.includes("前文") && block.lines.includes("后文") && !block.lines.some((l) => l.includes("$")),
  JSON.stringify(block.lines),
);
await c.screenshot(SHOT("wysiwyg-10-block-math"));

console.log("10) 光标进入块级公式 → 整行回到源码");
const blockPoint = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-math-block").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(blockPoint.x, blockPoint.y);
await c.waitFor(`document.querySelectorAll(".cm-math-block").length === 0`, { timeout: 5000 });
const revealed = await c.evaluate(`Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText)`);
check("整行公式展开为源码（可见 $ 定界符）", revealed.join("\n").includes("$"), JSON.stringify(revealed));
await c.screenshot(SHOT("wysiwyg-11-block-caret"));

console.log("11) 文档内 #let 宏进入公式编译上下文");
await c.selectAll();
await c.type("#let R = math.bb(R)\n\n公式 $R^2$ 与 $x^2$\n");
await c.waitFor(`document.querySelectorAll(".cm-math-widget").length === 2`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 1200));
const ctx = await c.evaluate(`(() => {
  const m = window.__browserDevLastMath;
  if (!m) return null;
  return { body: m.body, context: m.context };
})()`);
check(
  "最近一次公式渲染的 context 里带上了文档内定义",
  ctx !== null && ctx.context.includes("#let R = math.bb(R)"),
  JSON.stringify(ctx),
);
// 定义变化的公式用同一上下文（体现"上下文参与缓存键"，改定义会触发重渲染）
const ctx2 = await c.evaluate(`window.__browserDevLastMath.context`);
check("上下文以换行结尾（可直接拼接探针文档）", typeof ctx2 === "string" && ctx2.endsWith("\n"), JSON.stringify(ctx2));

console.log("12) 有序列表 `+ ` → 序号");
await c.selectAll();
await c.type("+ 甲\n+ 乙\n\n正文\n+ 丙\n");
await new Promise((r) => setTimeout(r, 600));
const list = await c.evaluate(`(() => {
  const reps = Array.from(document.querySelectorAll(".cm-markup-replacement")).map(e => e.textContent);
  return { reps, lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText.trim()) };
})()`);
check("`+ ` 替换为 1. / 2. 序号", JSON.stringify(list.reps) === JSON.stringify(["1. ", "2. ", "1. "]), JSON.stringify(list));
await c.screenshot(SHOT("wysiwyg-12-ordered-list"));

console.log("13) 代码块（``` 围栏）→ 块级代码块 widget");
await c.selectAll();
await c.type("前文\n\n```typ\n#let x = 1\n  let y = 2\n```\n\n后文\n");
await c.waitFor(`document.querySelectorAll(".cm-raw-block").length === 1`, { timeout: 8000 });
const codeBlock = await c.evaluate(`(() => {
  const b = document.querySelector(".cm-raw-block");
  const pre = b.querySelector("pre");
  const cs = getComputedStyle(pre);
  return {
    code: pre.textContent,
    family: cs.fontFamily,
    lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText.trim()),
    hasFence: document.querySelector(".cm-content").innerText.includes("\u0060\u0060\u0060"),
  };
})()`);
check("围栏代码块渲染为 widget（代码内容正确、公共缩进已剔除）", codeBlock.code === "#let x = 1\n  let y = 2", JSON.stringify(codeBlock));
check("代码块等宽显示", /mono/i.test(codeBlock.family), codeBlock.family);
check("围栏不可见、前后正文保留", !codeBlock.hasFence && codeBlock.lines.includes("前文") && codeBlock.lines.includes("后文"), JSON.stringify(codeBlock.lines));
await c.screenshot(SHOT("wysiwyg-13-code-block"));

console.log("14) 光标进入代码块 → 回到源码");
const codePoint = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-raw-block").getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2 };
})()`);
await c.click(codePoint.x, codePoint.y);
await c.waitFor(`document.querySelectorAll(".cm-raw-block").length === 0`, { timeout: 5000 });
const fenceBack = await c.evaluate(`document.querySelector(".cm-content").innerText.includes("\u0060\u0060\u0060")`);
check("围栏重新可见（可编辑源码）", fenceBack === true);
await c.screenshot(SHOT("wysiwyg-14-code-block-caret"));

console.log("15) 写作模式形态：单栏、纸张居中、无行号槽");
// 回到干净的默认态：清 localStorage 后重载（默认 livePreview=true → 单栏）
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
const single = await c.evaluate(`(() => {
  const panes = document.querySelector(".panes");
  const preview = document.querySelector(".preview-pane");
  const editor = document.querySelector(".editor-pane");
  const cm = document.querySelector(".cm-editor");
  const host = document.querySelector(".panes").getBoundingClientRect();
  const cmr = cm.getBoundingClientRect();
  return {
    panesClass: panes.className,
    previewDisplay: getComputedStyle(preview).display,
    editorWidth: Math.round(editor.getBoundingClientRect().width),
    panesWidth: Math.round(host.width),
    cmWidth: Math.round(cmr.width),
    // 居中：编辑器左右到 .panes 两边的留白
    leftGap: Math.round(cmr.left - host.left),
    rightGap: Math.round(host.right - cmr.right),
    previewExistsInDom: !!document.querySelector("#preview-host"),
  };
})()`);
check("默认（写作模式）为单栏：预览栏不显示", single.previewDisplay === "none", JSON.stringify(single));
check("编辑区占满整宽", Math.abs(single.editorWidth - single.panesWidth) <= 2, JSON.stringify(single));
check("编辑器作为纸张块居中（左右留白接近）", Math.abs(single.leftGap - single.rightGap) < 20, JSON.stringify(single));
check("预览容器仍在 DOM 中（编译链路不受影响）", single.previewExistsInDom === true);
await c.screenshot(SHOT("wysiwyg-15-single-pane"));

console.log("16) 菜单可调回双栏");
const viewMenu = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menubar .menu-title"))
    .find(e => (e.textContent || "").trim().startsWith("视图"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(viewMenu.x, viewMenu.y);
await c.waitFor(`document.body.innerText.includes("显示预览栏")`, { timeout: 5000 });
const previewItem = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
    .find(e => (e.textContent || "").includes("显示预览栏"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(previewItem.x, previewItem.y);
await c.waitFor(`getComputedStyle(document.querySelector(".preview-pane")).display !== "none"`, { timeout: 5000 });
const split = await c.evaluate(`(() => {
  const editor = document.querySelector(".editor-pane").getBoundingClientRect();
  const panes = document.querySelector(".panes").getBoundingClientRect();
  return { editorWidth: Math.round(editor.width), panesWidth: Math.round(panes.width) };
})()`);
check("打开「显示预览栏」后回到双栏（编辑区约半宽）", split.editorWidth < split.panesWidth * 0.6, JSON.stringify(split));
await c.screenshot(SHOT("wysiwyg-16-split-again"));

console.log("17) 切到源代码模式 → 自动回到双栏（源码 + 预览）");
const viewMenu2 = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menubar .menu-title"))
    .find(e => (e.textContent || "").trim().startsWith("视图"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(viewMenu2.x, viewMenu2.y);
await c.waitFor(`document.body.innerText.includes("源代码模式")`, { timeout: 5000 });
const wysiwygItem = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
    .find(e => (e.textContent || "").includes("源代码模式"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(wysiwygItem.x, wysiwygItem.y);
await new Promise((r) => setTimeout(r, 400));
// 先切回源码模式前，确保预览栏是关的（上一步刚打开过），这里验证联动：关掉所见即所得 → 预览栏自动打开
const after = await c.evaluate(`({
  previewDisplay: getComputedStyle(document.querySelector(".preview-pane")).display,
  panesClass: document.querySelector(".panes").className,
})`);
check("切到源代码模式后自动回到双栏", after.previewDisplay !== "none", JSON.stringify(after));
await c.screenshot(SHOT("wysiwyg-17-source-split"));

console.log("18) 仿 Typora 写作界面：纸张观感 + 格式菜单/快捷键");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
const paper = await c.evaluate(`(() => {
  const host = document.querySelector(".editor-host");
  const cm = document.querySelector(".cm-editor");
  const content = document.querySelector(".cm-content");
  const body = document.querySelector(".editor-pane .pane-body");
  const cs = getComputedStyle(content);
  return {
    hostHasWriteClass: host.className.includes("write"),
    gutterDisplay: (() => { const g = document.querySelector(".cm-gutters"); return g ? getComputedStyle(g).display : null; })(),
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    paperBg: getComputedStyle(body).backgroundColor,
    paperMaxWidth: getComputedStyle(body).maxWidth,
    status: document.querySelector(".statusbar").innerText.split("\\n").join(" | "),
  };
})()`);
check("写作模式下编辑器带 write 类", paper.hostHasWriteClass, JSON.stringify(paper));
check("无行号槽（Typora 没有行号）", paper.gutterDisplay === "none", paper.gutterDisplay);
check("正文是衬线字体（与预览/PDF 输出一致）", /serif|Songti|Noto Serif/i.test(paper.fontFamily), paper.fontFamily);
check("字号/行距是写作排版（16px / ≥1.8）", parseFloat(paper.fontSize) >= 16 && parseFloat(paper.lineHeight) >= 1.8, JSON.stringify([paper.fontSize, paper.lineHeight]));
check("整页纸张限宽居中", paper.paperMaxWidth !== "none", paper.paperMaxWidth);
check("状态栏有模式标识且不显示行列", paper.status.includes("写作") && !paper.status.includes("行 "), paper.status);
await c.screenshot(SHOT("wysiwyg-18-write-ui"));

// 格式菜单：加粗（Ctrl+B）
await c.click(400, 300);
await c.selectAll();
await c.type("要加粗的文字\n");
await c.selectAll();
await c.key("b", { code: "KeyB", keyCode: 66, modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
const bold = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check("Ctrl+B 加粗（插入 Typst 标记）", bold.includes("*要加粗的文字*"), JSON.stringify(bold));

// 格式菜单：标题 1（Ctrl+1）
await c.key("1", { code: "Digit1", keyCode: 49, modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
const heading = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check("Ctrl+1 标题（行首加 `= `，写作模式下立刻变大）", heading.trim().startsWith("= "), JSON.stringify(heading));
const headingSize = await c.evaluate(`(() => {
  const el = document.querySelector(".cm-markup-heading");
  return el ? parseFloat(getComputedStyle(el).fontSize) : null;
})()`);
check("标题在写作模式下字号显著放大", headingSize !== null && headingSize > 24, String(headingSize));
await c.screenshot(SHOT("wysiwyg-19-write-format"));

console.log("20) 模式切换不丢内容：写作 ↔ 源码 双向切换（含在源码模式里继续输入）");
// 回归网：editorDoc 曾是"只在上次打开/新建时更新"的陈旧镜像，任何让 Editor 重挂载或让 props
// 重新生效的情形都会把旧内容当外部文档推回去（用户反馈："切换模式时未保存内容消失了"）。
// 这里用真实输入 + 真实快捷键把两条路径都走一遍。
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.evaluate(`(() => { window.__cm = document.querySelector(".cm-content"); return 1; })()`);
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.type("KEEP-A 写作输入\n");
await new Promise((r) => setTimeout(r, 400));
// Ctrl+/ 进源码模式
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const inSource = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check("Ctrl+/ 切到源码模式后内容仍在", inSource.includes("KEEP-A"), JSON.stringify(inSource));
// 在源码模式里继续输入
await c.type("KEEP-B 源码输入\n");
await new Promise((r) => setTimeout(r, 400));
// Ctrl+/ 切回写作模式
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const backWrite = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check(
  "切回写作模式后两段输入都还在",
  backWrite.includes("KEEP-A") && backWrite.includes("KEEP-B"),
  JSON.stringify(backWrite),
);
const sameNode = await c.evaluate(`document.querySelector(".cm-content") === window.__cm`);
check("模式切换不重挂载编辑器（同一个 .cm-content 节点）", sameNode === true, String(sameNode));
await c.screenshot(SHOT("wysiwyg-20-mode-switch-keeps-content"));

console.log("21) 启动恢复上次内容（会话安全网）：输入 → 重载 → 内容回来；开关关闭时不恢复");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
const emptyAtStart = await c.evaluate(`document.querySelector(".cm-content").innerText.trim()`);
check("清空存档后启动是空文档", emptyAtStart === "", JSON.stringify(emptyAtStart));
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type("RESTORE-ME 未保存内容\n");
await new Promise((r) => setTimeout(r, 700)); // 等 300ms 防抖写 localStorage
// 重载（不清 localStorage）：模拟"关掉再打开"
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));
const restored = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check("重载后内容被恢复", restored.includes("RESTORE-ME"), JSON.stringify(restored));
const restoredInfo = await c.evaluate(`(() => {
  const s = document.querySelector(".statusbar").innerText;
  return { status: s, chars: (document.querySelector(".cm-content").innerText || "").length };
})()`);
// 注意：恢复提示会很快被首次编译完成后的「就绪」覆盖（compile 是异步的），
// 所以这里断言"内容 + 字符数"，不去赌状态栏那一瞬间的文案
check(
  "重载后内容与字符数都恢复",
  restoredInfo.chars >= "RESTORE-ME 未保存内容".length,
  JSON.stringify(restoredInfo),
);
await c.screenshot(SHOT("wysiwyg-21-restore-session"));

// 关掉开关：清空存档 → 输入 → 重载 → 应该是空文档
await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  raw.restoreSession = false;
  localStorage.setItem("typst-pad:state", JSON.stringify(raw));
  return 1;
})()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));
const notRestored = await c.evaluate(`document.querySelector(".cm-content").innerText.trim()`);
check("关掉「启动时恢复」后不恢复内容", notRestored === "", JSON.stringify(notRestored));

console.log("22) Alt 激活菜单栏：编辑器不失焦、光标与滚动位置不变（用户反馈「不要改变当前编辑位置」）");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
const altDoc = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join("\n") + "\n";
await c.type(altDoc);
await new Promise((r) => setTimeout(r, 700));
// 把视口滚到中间，并记住滚动位置与焦点状态
await c.evaluate(`(() => { const sc = document.querySelector(".cm-scroller"); sc.scrollTop = Math.floor(sc.scrollHeight / 2); return 1; })()`);
await new Promise((r) => setTimeout(r, 300));
const probe = `(() => {
  const sc = document.querySelector(".cm-scroller");
  const active = document.activeElement;
  return {
    scrollTop: Math.round(sc.scrollTop),
    focusInEditor: !!active && !!active.closest(".cm-content"),
    menuSelected: !!document.querySelector(".menu-title.selected"),
    menuActive: !!document.querySelector(".menu-title.active"),
    text: document.querySelector(".cm-content").innerText.length,
  };
})()`;
const beforeAlt = await c.evaluate(probe);
check("起点：焦点在编辑区、菜单未激活、已滚动", beforeAlt.focusInEditor && !beforeAlt.menuSelected && beforeAlt.scrollTop > 0, JSON.stringify(beforeAlt));

await c.key("Alt", { code: "AltLeft", keyCode: 18, modifiers: 1 });
await new Promise((r) => setTimeout(r, 500));
const afterAlt = await c.evaluate(probe);
check("Alt 后菜单栏进入选中态", afterAlt.menuSelected, JSON.stringify(afterAlt));
check("Alt 后编辑器**仍然**持有焦点（光标没丢）", afterAlt.focusInEditor, JSON.stringify(afterAlt));
check("Alt 后滚动位置不变（编辑位置没被改）", afterAlt.scrollTop === beforeAlt.scrollTop, `${beforeAlt.scrollTop} → ${afterAlt.scrollTop}`);
check("Alt 后文档内容没变", afterAlt.text === beforeAlt.text, `${beforeAlt.text} → ${afterAlt.text}`);
await c.screenshot(SHOT("wysiwyg-22-alt-keeps-focus"));

// 再按一次 Alt 取消选中：仍然保持编辑区焦点
await c.key("Alt", { code: "AltLeft", keyCode: 18, modifiers: 1 });
await new Promise((r) => setTimeout(r, 400));
const afterAlt2 = await c.evaluate(probe);
check("再按 Alt 取消选中后焦点仍在编辑区", !afterAlt2.menuSelected && afterAlt2.focusInEditor, JSON.stringify(afterAlt2));

console.log("23) 自动更新入口（浏览器开发模式：桩固定返回「没有新版本」）");
// 桩对 plugin:updater|check 返回 null（见 browser-dev-stub.ts），所以这里断言的是
// **前端链路**：菜单项在不在、手动检查有没有明确反馈、没更新时会不会乱弹窗。
// 真实下载/安装/签名校验只能在桌面版验证（Windows NSIS），见 CLAUDE.md「测试」。
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

/** 点开菜单栏某个分类（按标签前缀找） */
const openMenu = async (prefix) => {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menubar .menu-title"))
      .find(e => (e.textContent || "").trim().startsWith(${JSON.stringify(prefix)}));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
};
/** 点开下拉里的某个菜单项（只在 .menu-dropdown 内找，避免点到状态栏同名文字） */
const clickMenuItem = async (text) => {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
      .find(e => (e.textContent || "").includes(${JSON.stringify(text)}));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
};

await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("检查更新")`, { timeout: 5000 });
const hasUpdateItem = await c.evaluate(
  `Array.from(document.querySelectorAll(".menu-dropdown .menu-item")).some(e => (e.textContent || "").includes("检查更新"))`,
);
check("「帮助」菜单里有「检查更新…」", hasUpdateItem);

await clickMenuItem("检查更新");
// 手动检查必须给出明确反馈（自动检查才允许安静）
await c.waitFor(`document.querySelector(".statusbar").innerText.includes("已是最新版本")`, {
  timeout: 10000,
});
const afterCheck = await c.evaluate(`({
  status: document.querySelector(".statusbar").innerText,
  dialog: !!document.querySelector(".update-modal"),
  notice: !!document.querySelector(".status-update"),
  focusInEditor: !!document.activeElement && !!document.activeElement.closest(".cm-content"),
})`);
check("手动检查后状态栏显示「已是最新版本」", afterCheck.status.includes("已是最新版本"), JSON.stringify(afterCheck.status));
check("没有新版本：不弹更新窗、状态栏也不留更新入口", !afterCheck.dialog && !afterCheck.notice, JSON.stringify(afterCheck));
check("检查更新不抢编辑区焦点", afterCheck.focusInEditor, JSON.stringify(afterCheck));
await c.screenshot(SHOT("wysiwyg-23-update-check"));

await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
const autoRow = await c.evaluate(`(() => {
  const row = Array.from(document.querySelectorAll(".settings-modal .settings-row"))
    .find(e => (e.textContent || "").includes("自动检查更新"));
  return row ? { checked: row.querySelector("input").checked, text: row.textContent.trim() } : null;
})()`);
check("设置里有「启动时自动检查更新」且默认勾选", !!autoRow && autoRow.checked, JSON.stringify(autoRow));
await c.screenshot(SHOT("wysiwyg-23-update-settings"));
await c.evaluate(
  `Array.from(document.querySelectorAll(".settings-modal .modal-btn")).find(b => (b.textContent || "").includes("关闭")).click()`,
);

console.log("24) Ctrl+滚轮界面缩放（字太小 → 放大整个界面）");
// 这一组能锁住的是"请求了正确的缩放系数"：浏览器开发模式没有 Tauri 的 webview 缩放，
// 桩把 setZoom 的入参记在 window.__browserDevLastZoom（见 browser-dev-stub.ts），
// 真实的放大效果只能在桌面版看。手势本身的坑（Shift 把纵向滚动转成横向）、状态栏反馈、
// 上下限、持久化与菜单都在这里锁住。
// 背景：这一组原本验的是「Ctrl+滚轮改分栏宽度」——用户反馈他要的是**字变大**而不是栏变宽，
// 于是手势改成整界面缩放（Tauri setZoom，等价浏览器 Ctrl+滚轮）。
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

/** 缩放探针：桩记录的缩放系数 + 存档 + 状态栏文案 + 状态栏缩放徽标 */
const zoomProbe = `(() => {
  const editor = document.querySelector(".editor-pane").getBoundingClientRect();
  return {
    center: { x: Math.round(editor.left + editor.width / 2), y: Math.round(editor.top + editor.height / 2) },
    requested: window.__browserDevLastZoom ?? null,
    saved: JSON.parse(localStorage.getItem("typst-pad:state") || "{}").uiZoom ?? null,
    status: document.querySelector(".statusbar").innerText,
    tags: Array.from(document.querySelectorAll(".statusbar .mode-tag")).map(e => e.textContent.trim()),
  };
})()`;

const zoomStart = await c.evaluate(zoomProbe);
check(
  "启动即把缩放交给 webview（默认 100%）",
  Math.abs((zoomStart.requested ?? -1) - 1) < 0.001,
  JSON.stringify(zoomStart),
);
check("默认状态栏不显示缩放徽标", !zoomStart.tags.some((t) => t.includes("缩放")), JSON.stringify(zoomStart.tags));

// Ctrl + 滚轮向上 5 格 → 150%（一档 10%）
for (let i = 0; i < 5; i++) {
  await c.wheel(zoomStart.center.x, zoomStart.center.y, -100, { modifiers: 2 });
}
await new Promise((r) => setTimeout(r, 400));
const zoomedIn = await c.evaluate(zoomProbe);
check(
  "Ctrl+滚轮向上 5 档 → 请求 150% 缩放",
  Math.abs((zoomedIn.requested ?? 0) - 1.5) < 0.001,
  String(zoomedIn.requested),
);
check("状态栏给出实时反馈", zoomedIn.status.includes("缩放 150%"), JSON.stringify(zoomedIn.status));
check(
  "状态栏常驻显示当前缩放（非 100% 时）",
  zoomedIn.tags.some((t) => t.includes("缩放 150%")),
  JSON.stringify(zoomedIn.tags),
);
check("缩放写进存档", Math.abs((zoomedIn.saved ?? 0) - 1.5) < 0.001, String(zoomedIn.saved));
await c.screenshot(SHOT("wysiwyg-24-zoom-in"));

// 重载：恢复出来的缩放要重新交给 webview（否则重启后界面又变小了）
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));
const afterReload = await c.evaluate(zoomProbe);
check(
  "重载后恢复 150% 并重新应用",
  Math.abs((afterReload.requested ?? 0) - 1.5) < 0.001,
  String(afterReload.requested),
);

// 不带 Ctrl 的滚轮：不该动缩放（留给编辑器/预览区自己的滚动）
await c.wheel(afterReload.center.x, afterReload.center.y, -100, { modifiers: 0 });
await new Promise((r) => setTimeout(r, 300));
const plain = await c.evaluate(zoomProbe);
check("不带 Ctrl 的滚轮不改缩放", Math.abs((plain.saved ?? 0) - 1.5) < 0.001, String(plain.saved));

// 横向位移（按 Shift 滚轮时浏览器把纵向滚动转成横向的真机形态）也要能缩放
await c.wheel(plain.center.x, plain.center.y, 0, { modifiers: 2, deltaX: -100 });
await new Promise((r) => setTimeout(r, 300));
const horizontal = await c.evaluate(zoomProbe);
check(
  "横向位移（deltaY=0 + deltaX）也能缩放（Shift 滚轮的真机形态）",
  Math.abs((horizontal.requested ?? 0) - 1.6) < 0.001,
  String(horizontal.requested),
);

// 一直向下滚 → 收敛在下限 50%（不会缩到看不见）
for (let i = 0; i < 40; i++) {
  await c.wheel(horizontal.center.x, horizontal.center.y, 100, { modifiers: 2 });
}
await new Promise((r) => setTimeout(r, 500));
const smallest = await c.evaluate(zoomProbe);
check(
  "向下滚到底收敛在 50%（不会缩到看不见）",
  Math.abs((smallest.requested ?? 0) - 0.5) < 0.001,
  String(smallest.requested),
);

// 视图菜单：放大 / 缩小 / 重置缩放（灰字给出 Ctrl+滚轮 这个姿势）
await openMenu("视图");
await c.waitFor(`document.body.innerText.includes("重置缩放")`, { timeout: 5000 });
const menuItems = await c.evaluate(`(() => {
  const items = Array.from(document.querySelectorAll(".menu-dropdown .menu-item")).map(e => e.textContent || "");
  return {
    zoomIn: items.some(t => t.includes("放大")),
    zoomOut: items.some(t => t.includes("缩小")),
    reset: items.some(t => t.includes("重置缩放")),
    hint: items.some(t => t.includes("Ctrl+滚轮")),
  };
})()`);
check(
  "视图菜单有 放大 / 缩小 / 重置缩放，并给出 Ctrl+滚轮 提示",
  Object.values(menuItems).every(Boolean),
  JSON.stringify(menuItems),
);
await clickMenuItem("重置缩放");
await new Promise((r) => setTimeout(r, 400));
const reset = await c.evaluate(zoomProbe);
check("「重置缩放」回到 100%", Math.abs((reset.requested ?? 0) - 1) < 0.001, String(reset.requested));
check(
  "回到 100% 后状态栏不再显示缩放徽标",
  !reset.tags.some((t) => t.includes("缩放")),
  JSON.stringify(reset.tags),
);
await c.screenshot(SHOT("wysiwyg-24-zoom-reset"));


// ---------------------------------------------------------------------------
// 第 25 组：正文字体设置（中文不再被 typst 回退成楷体）
// 背景（2026-09-14 实测）：typst 默认正文字体 Libertinus Serif 没有汉字，不指定字体时中文全走
// 自动回退，而回退打分优先「与基准字体同衬线」再比「家族名长短」→ Windows 落到楷体/隶书、
// Linux 落到日文字形黑体。现在由设置里的「正文字体」（选项来自 Rust 侧 FontBook）+ Rust 注入的
// 默认字体族决定；同时修掉"改了字体没生效"：保存立即重编译、写错的族名以警告形式可见。
// ---------------------------------------------------------------------------
console.log("25) 正文字体设置");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置…");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
await new Promise((r) => setTimeout(r, 600));

const fontUi = await c.evaluate(`(() => {
  const modal = document.querySelector(".settings-modal");
  const select = modal.querySelector("select.settings-select");
  return {
    hasSelect: !!select,
    options: select ? Array.from(select.options).map((o) => o.value) : [],
    hasDirBlock: Array.from(modal.querySelectorAll(".settings-block-title")).some((e) =>
      (e.textContent || "").includes("额外字体目录"),
    ),
    hasAddBtn: Array.from(modal.querySelectorAll("button")).some((e) =>
      (e.textContent || "").includes("添加字体目录"),
    ),
  };
})()`);
check("设置弹窗里有「正文字体（中文）」下拉", fontUi.hasSelect, JSON.stringify(fontUi));
check("下拉首项是「默认」（值 = 空串）", fontUi.options[0] === "", JSON.stringify(fontUi.options.slice(0, 3)));
check(
  "下拉选项来自字体列表（桩给出 SimSun / Noto Serif CJK SC）",
  fontUi.options.includes("SimSun") && fontUi.options.includes("Noto Serif CJK SC"),
  JSON.stringify(fontUi.options),
);
check("有「额外字体目录」区与添加按钮", fontUi.hasDirBlock && fontUi.hasAddBtn, JSON.stringify(fontUi));

// 添加字体目录（桩的目录选择器返回假目录）→ 目录进列表、字体列表随之刷新
await c.evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll(".settings-modal button")).find((e) =>
    (e.textContent || "").includes("添加字体目录"),
  );
  btn.click();
})()`);
await c.waitFor(`!!document.querySelector(".settings-modal .settings-dir-path")`, { timeout: 5000 });
const afterAdd = await c.evaluate(`(() => {
  const modal = document.querySelector(".settings-modal");
  const select = modal.querySelector("select.settings-select");
  return {
    dir: (modal.querySelector(".settings-dir-path") || {}).textContent || "",
    options: Array.from(select.options).map((o) => o.value),
  };
})()`);
check("添加字体目录后，目录出现在设置里", afterAdd.dir.trim().length > 0, afterAdd.dir.trim());
check(
  "字体列表随额外目录刷新（多出用户字体）",
  afterAdd.options.includes("UserFont Demo"),
  JSON.stringify(afterAdd.options.slice(-3)),
);

// 选正文字体 + 保存：字体族列表要传下去，并且**立即重编译**（以前要再敲一个字才生效）
const compilesBefore = await c.evaluate(`window.__browserDevCompileCount || 0`);
await c.evaluate(`(() => {
  const sel = document.querySelector(".settings-modal select.settings-select");
  sel.value = "SimSun";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
})()`);
await c.evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll(".settings-modal button")).find((e) =>
    (e.textContent || "").includes("保存"),
  );
  btn.click();
})()`);
await new Promise((r) => setTimeout(r, 900));
const saved = await c.evaluate(`({
  compiles: window.__browserDevCompileCount || 0,
  last: window.__browserDevLastCompile || null,
  status: document.querySelector(".statusbar").innerText,
  modalOpen: !!document.querySelector(".settings-modal"),
})`);
check(
  "保存设置后立即重编译（不必再敲一个字）",
  saved.compiles > compilesBefore,
  `${compilesBefore} → ${saved.compiles}`,
);
check(
  "字体族列表透传给编译：拉丁基准最前、选中项其次（拉丁/数字不跟着变）",
  !!saved.last &&
    Array.isArray(saved.last.fontFamilies) &&
    saved.last.fontFamilies[0] === "Libertinus Serif" &&
    saved.last.fontFamilies[1] === "SimSun",
  JSON.stringify(saved.last && saved.last.fontFamilies),
);
check(
  "额外字体目录一并透传",
  !!saved.last && Array.isArray(saved.last.fontDirs) && saved.last.fontDirs.length === 1,
  JSON.stringify(saved.last && saved.last.fontDirs),
);
check("保存后弹窗关闭并给出状态栏反馈", !saved.modalOpen && saved.status.includes("设置已保存"), saved.status.slice(0, 40));

// 字体族名写错（中文族名永远匹配不上）→ typst 只发 warning：必须可见，否则就是"改了字体没用"
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));
await c.click(400, 300);
await c.type('#set text(font: "微软雅黑")\n中文测试');
await c.waitFor(`!!document.querySelector(".warning-badge")`, { timeout: 8000 });
const warnStatus = await c.evaluate(`document.querySelector(".statusbar").innerText`);
check(
  "写错的字体族名以警告形式出现在状态栏（不再静默回退）",
  warnStatus.includes("警告") && warnStatus.includes("未知字体族"),
  warnStatus.slice(0, 80),
);
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(`!!document.querySelector(".error-popover .error-item-msg")`, { timeout: 5000 });
const warnText = await c.evaluate(
  `document.querySelector(".error-popover").innerText`,
);
check(
  "警告弹窗给出可行动提示（英文族名 + 额外字体目录）",
  warnText.includes("Microsoft YaHei") && warnText.includes("额外字体目录"),
  warnText.replace(/\n/g, " ").slice(0, 120),
);
await c.screenshot(SHOT("wysiwyg-25-font-warning"));

// ---------------------------------------------------------------------------
// 第 26 组：更新说明的 Markdown 渲染（用户反馈：「更新说明无法渲染」）
// 背景：弹窗里的说明是 latest.json 的 notes = CHANGELOG.md 的 Markdown 原文，以前直接塞进
// <pre>，用户看到的是 `### Fixed`、`**中文…**` 这种原文。现在由 update-notes.ts 渲染成受控
// 子集的安全 HTML（先整体转义，再只生成自己那几种标签）。
// 浏览器开发模式下桩默认返回"没有新版本"（第 23 组验的就是那个安静路径），所以这里用
// `&fakeupdate=1` 让桩返回一个假的可用更新，把弹窗真正打开（真实下载/装包仍只能在桌面版验）。
// ---------------------------------------------------------------------------
console.log("26) 更新说明的 Markdown 渲染");
await c.evaluate(`localStorage.clear()`);
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("检查更新")`, { timeout: 5000 });
await clickMenuItem("检查更新");
await c.waitFor(`!!document.querySelector(".update-modal .update-notes")`, { timeout: 10000 });

const notes = await c.evaluate(`(() => {
  const box = document.querySelector(".update-modal .update-notes");
  const tag = (sel) => Array.from(box.querySelectorAll(sel)).map(e => e.textContent.trim());
  return {
    text: box.innerText,
    headings: tag("h4"),
    bullets: box.querySelectorAll("li").length,
    nested: box.querySelectorAll("ul ul li").length,
    strongs: tag("strong"),
    codes: tag("code"),
    // XSS 样本：notes 里的 <img onerror=...> 必须只有文本，不能真的造出元素
    imgs: box.querySelectorAll("img").length,
    html: box.innerHTML,
  };
})()`);

check(
  "更新说明里的小标题渲染成标题元素（不是 `### Fixed` 原文）",
  notes.headings.includes("Fixed") && notes.headings.includes("Added"),
  JSON.stringify(notes.headings),
);
check("说明里不再出现 `###` 原文", !notes.text.includes("###"), notes.text.slice(0, 60));
check("说明里不再出现 `**` 原文（粗体渲染成 strong）", !notes.text.includes("**") && notes.strongs.length > 0, JSON.stringify(notes.strongs));
check("行内代码渲染成 code 元素", notes.codes.some((t) => t.includes("font-warnings.ts")), JSON.stringify(notes.codes));
check("列表渲染成 li，且两空格缩进形成嵌套列表", notes.bullets >= 3 && notes.nested >= 1, `li=${notes.bullets} nested=${notes.nested}`);
check(
  "说明里的 HTML 只当文本显示（转义，不注入元素）",
  notes.imgs === 0 && notes.text.includes("<img"),
  `imgs=${notes.imgs} 片段=${notes.text.slice(0, 40)}`,
);
await c.screenshot(SHOT("wysiwyg-26-update-notes"));
await c.evaluate(
  `Array.from(document.querySelectorAll(".update-modal .modal-btn")).find(b => (b.textContent || "").includes("稍后")).click()`,
);

console.log(`\n通过 ${passed} 项检查；截图：${SHOT("wysiwyg-*")}`);
c.close();
