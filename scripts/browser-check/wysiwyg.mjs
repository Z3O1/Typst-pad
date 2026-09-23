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
import { boot, createChecker, finish, shotPath as SHOT } from "./harness.mjs";

// 断言 + 计数、截图路径、启动序列、收尾都来自 harness.mjs（六套件共用一份）
const { check, state } = createChecker();

const c = await connect();
await boot(c, DEV_URL);

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
check(
  "widget 内含 SVG",
  geo1.every((g) => g.hasSvg),
);
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
check(
  "光标离开后重新渲染（行内 widget 回到 1、块级仍在）",
  !text3.includes("$x^2 + y^2$"),
  JSON.stringify(text3),
);
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
  // h1 = 1.4em（typst 的 heading 梯度，见 Editor.svelte 的注释）：这里锁住"确实按 typst 放大"，
  // 而不是任意放大 —— 曾经是 1.8em，比块切片大 40%（用户报「在标题所在块，标题就会变的很大」）
  "标题字号 = 正文 × 1.4（typst 的 heading 梯度）",
  Math.abs(markup.headingSize / markup.bodySize - 1.4) < 0.02,
  `heading=${markup.headingSize} body=${markup.bodySize}`,
);
// 标题正文不许有下划线（2026-09-14 用户反馈「`== 1` 在写作模式有下划线」）：
// 那条下划线是 codemirror-lang-typst 自带高亮样式给的（`tags.heading` 带 textDecoration: underline），
// 由 typst-highlight.ts 再挂一份 `none !important` 压掉。
// **先等依赖那份规则真的落到标题元素上再断言**：解析器是异步的，实测刚挂载时一个高亮类都没有、
// 约 1 秒后才出现 —— 不等就等于恒真（把压制去掉也照样绿，这种测试没有意义）。
await c.waitFor(
  `(() => {
     const matchesUnderlineRule = (el) => {
       for (const sheet of Array.from(document.styleSheets)) {
         let rules; try { rules = sheet.cssRules; } catch { continue; }
         for (const r of rules) {
           if (!r.selectorText || !r.style || !/underline/.test(r.style.textDecoration || "")) continue;
           try { if (el.matches(r.selectorText)) return true; } catch {}
         }
       }
       return false;
     };
     const heads = Array.from(document.querySelectorAll(".cm-markup-heading"));
     return heads.some((h) => [h, ...h.querySelectorAll("*")].some(matchesUnderlineRule));
   })()`,
  { timeout: 10000 },
);
const underlinedInHeading = await c.evaluate(`(() => {
  // 判定"看得见的下划线"：看元素自己**以及整条祖先链**（祖先的 text-decoration 会透传到文字上，
  // 子元素用 none 也取消不了），这样无论依赖那条规则落在哪一层都能抓到。
  // 编译错误的红色波浪线（.cm-diag-wavy）与链接蓝线（.cm-markup-link）是另一回事，跳过。
  const visibleDeco = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.classList && (e.classList.contains("cm-diag-wavy") || e.classList.contains("cm-markup-link"))) continue;
      const d = getComputedStyle(e).textDecorationLine;
      if (d && d !== "none") return d;
    }
    return "none";
  };
  const bad = [];
  document.querySelectorAll(".cm-content *").forEach((el) => {
    const d = visibleDeco(el);
    if (d !== "none") bad.push({ cls: el.className, text: (el.textContent || "").slice(0, 12), deco: d });
  });
  return bad;
})()`);
check(
  "标题正文没有下划线（依赖自带那条已被 typst-highlight.ts 压掉）",
  Array.isArray(underlinedInHeading) && underlinedInHeading.length === 0,
  JSON.stringify(underlinedInHeading),
);
check(
  "粗体标记 `*` 被隐藏（文字保留）",
  markup.lines[2].includes("粗体") && !markup.lines[2].includes("*"),
  JSON.stringify(markup.lines[2]),
);
check("粗体字重为 700", markup.strongWeight === "700", String(markup.strongWeight));
check(
  "斜体样式生效且 `_` 被隐藏",
  markup.emphStyle === "italic" && !markup.lines[2].includes("_"),
  String(markup.emphStyle),
);
check(
  "行内代码等宽显示且反引号被隐藏",
  /mono/i.test(markup.rawFamily ?? "") && !markup.lines[2].includes("`"),
  String(markup.rawFamily),
);
check(
  "无序列表符号替换为圆点",
  markup.replacement === "• " && markup.lines[4].trim().endsWith("列表项"),
  JSON.stringify(markup),
);
await c.screenshot(SHOT("wysiwyg-7-markup"));

console.log("7) 标题正文持续保持样式，只在靠近标记时局部露出语法");
await c.evaluate(`(() => {
  const view = document.querySelector(".cm-content").cmTile.root.view;
  view.dispatch({ selection: { anchor: 3 } });
})()`);
const headingMiddle = await c.evaluate(`document.querySelectorAll(".cm-line")[0].innerText.trim()`);
check(
  "光标在标题正文中间时 `= ` 仍隐藏",
  !headingMiddle.startsWith("="),
  JSON.stringify(headingMiddle),
);
await c.evaluate(`(() => {
  const view = document.querySelector(".cm-content").cmTile.root.view;
  view.dispatch({ selection: { anchor: 2 } });
})()`);
await c.waitFor(`document.querySelectorAll(".cm-line")[0].innerText.trim().startsWith("=")`, {
  timeout: 5000,
});
const headingText = await c.evaluate(`document.querySelectorAll(".cm-line")[0].innerText.trim()`);
check("光标靠近标题标记时 `= ` 局部可见", headingText.startsWith("="), JSON.stringify(headingText));
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
check(
  "链接只留文字（#link(...) 与方括号不可见）",
  link.line.includes("官网") && !link.line.includes("#link") && !link.line.includes("["),
  JSON.stringify(link.line),
);
check(
  "链接文字带颜色与下划线",
  link.underline === "underline" && link.color !== "rgb(0, 0, 0)",
  JSON.stringify(link),
);
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
check(
  "块级公式居中显示",
  block.textAlign === "center" && Math.abs(block.leftGap - block.rightGap) < 40,
  JSON.stringify(block),
);
check(
  "源码定界符消失、前后正文保留",
  block.lines.includes("前文") &&
    block.lines.includes("后文") &&
    !block.lines.some((l) => l.includes("$")),
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
const revealed = await c.evaluate(
  `Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText)`,
);
check(
  "整行公式展开为源码（可见 $ 定界符）",
  revealed.join("\n").includes("$"),
  JSON.stringify(revealed),
);
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
check(
  "上下文以换行结尾（可直接拼接探针文档）",
  typeof ctx2 === "string" && ctx2.endsWith("\n"),
  JSON.stringify(ctx2),
);

console.log("12) 有序列表 `+ ` → 序号");
await c.selectAll();
await c.type("+ 甲\n+ 乙\n\n正文\n+ 丙\n");
await new Promise((r) => setTimeout(r, 600));
const list = await c.evaluate(`(() => {
  const reps = Array.from(document.querySelectorAll(".cm-markup-replacement")).map(e => e.textContent);
  return { reps, lines: Array.from(document.querySelectorAll(".cm-line")).map(l => l.innerText.trim()) };
})()`);
check(
  "`+ ` 替换为 1. / 2. 序号",
  JSON.stringify(list.reps) === JSON.stringify(["1. ", "2. ", "1. "]),
  JSON.stringify(list),
);
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
check(
  "围栏代码块渲染为 widget（代码内容正确、公共缩进已剔除）",
  codeBlock.code === "#let x = 1\n  let y = 2",
  JSON.stringify(codeBlock),
);
check("代码块等宽显示", /mono/i.test(codeBlock.family), codeBlock.family);
check(
  "围栏不可见、前后正文保留",
  !codeBlock.hasFence && codeBlock.lines.includes("前文") && codeBlock.lines.includes("后文"),
  JSON.stringify(codeBlock.lines),
);
await c.screenshot(SHOT("wysiwyg-13-code-block"));

console.log("14) 光标进入代码块 → 回到源码");
const codePoint = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-raw-block").getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2 };
})()`);
await c.click(codePoint.x, codePoint.y);
await c.waitFor(`document.querySelectorAll(".cm-raw-block").length === 0`, { timeout: 5000 });
const fenceBack = await c.evaluate(
  `document.querySelector(".cm-content").innerText.includes("\u0060\u0060\u0060")`,
);
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
check(
  "默认（写作模式）为单栏：预览栏不显示",
  single.previewDisplay === "none",
  JSON.stringify(single),
);
check(
  "编辑区占满整宽",
  Math.abs(single.editorWidth - single.panesWidth) <= 2,
  JSON.stringify(single),
);
check(
  "编辑器作为纸张块居中（左右留白接近）",
  Math.abs(single.leftGap - single.rightGap) < 20,
  JSON.stringify(single),
);
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
// 展开菜单固定浅色面板（用户 2026-09-18 要求「把上方菜单栏的展开菜单改成白色」）：
// 断言实测计算样式，而不是"面板出现了"——把颜色改回主题变量（--bg-toolbar/--fg）这条就会红
const menuPalette = await c.evaluate(`(() => {
  const panel = document.querySelector(".menu-dropdown");
  const item = panel ? panel.querySelector(".menu-item") : null;
  return {
    panelBg: panel ? getComputedStyle(panel).backgroundColor : null,
    itemColor: item ? getComputedStyle(item).color : null,
  };
})()`);
check(
  "展开菜单是白色面板（不跟深色主题走）",
  menuPalette.panelBg === "rgb(255, 255, 255)",
  JSON.stringify(menuPalette),
);
check(
  "菜单项文字是深色（白底可读）",
  menuPalette.itemColor === "rgb(31, 31, 31)",
  JSON.stringify(menuPalette),
);
await c.screenshot(SHOT("wysiwyg-16-menu-white"));
const previewItem = await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
    .find(e => (e.textContent || "").includes("显示预览栏"));
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(previewItem.x, previewItem.y);
await c.waitFor(`getComputedStyle(document.querySelector(".preview-pane")).display !== "none"`, {
  timeout: 5000,
});
const split = await c.evaluate(`(() => {
  const editor = document.querySelector(".editor-pane").getBoundingClientRect();
  const panes = document.querySelector(".panes").getBoundingClientRect();
  return { editorWidth: Math.round(editor.width), panesWidth: Math.round(panes.width) };
})()`);
check(
  "打开「显示预览栏」后回到双栏（编辑区约半宽）",
  split.editorWidth < split.panesWidth * 0.6,
  JSON.stringify(split),
);
await c.screenshot(SHOT("wysiwyg-16-split-again"));

// 展开菜单在**深色主题**下也必须是白底黑字（用户提这条需求时用的就是深色主题）。
// 组内前面那次是「主题：自动」，而无头 Chrome 报浅色偏好 ⇒ 上面截的是浅色主题的菜单；
// 这里显式切到「主题：暗」再验一遍，最后切回「自动」复原（后面的组不该受这次切换影响）。
const pickMenu16 = async (label) => {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menu-dropdown .menu-item"))
      .find(e => (e.textContent || "").trim().startsWith(${JSON.stringify(label)}));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
};
const openView16 = async () => {
  const rect = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".menubar .menu-title"))
      .find(e => (e.textContent || "").trim().startsWith("视图"));
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await c.click(rect.x, rect.y);
  await c.waitFor(`!!document.querySelector(".menu-dropdown")`, { timeout: 5000 });
};
await openView16();
await pickMenu16("主题：暗");
await c.waitFor(`!document.querySelector(".app").classList.contains("light")`, { timeout: 5000 });
await openView16();
const darkMenu = await c.evaluate(`(() => {
  const panel = document.querySelector(".menu-dropdown");
  const item = panel.querySelector(".menu-item");
  return {
    panelBg: getComputedStyle(panel).backgroundColor,
    itemColor: getComputedStyle(item).color,
    toolbarBg: getComputedStyle(document.querySelector(".toolbar")).backgroundColor,
  };
})()`);
check(
  "深色主题下展开菜单仍是白底（面板不跟主题走）",
  darkMenu.panelBg === "rgb(255, 255, 255)" && darkMenu.toolbarBg !== "rgb(255, 255, 255)",
  JSON.stringify(darkMenu),
);
check(
  "深色主题下菜单项文字仍是深色（白底可读）",
  darkMenu.itemColor === "rgb(31, 31, 31)",
  JSON.stringify(darkMenu),
);
await c.screenshot(SHOT("wysiwyg-16-menu-white-dark"));
await pickMenu16("主题：自动"); // 复原
await c.waitFor(`document.querySelector(".app").classList.contains("light")`, { timeout: 5000 });

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
check(
  "正文是衬线字体（与预览/PDF 输出一致）",
  /serif|Songti|Noto Serif/i.test(paper.fontFamily),
  paper.fontFamily,
);
check(
  // 写作模式的正文必须**跟文档实际字号走**（Rust 侧 textPt → --write-doc-px），行高用 typst 的
  // leading（0.65em → 1.65）：光标进出块时那一块的字号/行距才不会变（用户：「不要光标在哪里
  // 哪里就变大了」）。浏览器桩的文档没有 #set text(size:)，所以 = 11pt × 4/3 = 14.6667px。
  `正文跟随文档字号（11pt → ${paper.fontSize}）且行距 = typst leading（${paper.lineHeight}）`,
  // getComputedStyle 的 line-height 给的是**算好的 px**（24.2 = 1.65 × 14.6667），别拿 1.65 比
  Math.abs(parseFloat(paper.fontSize) - 14.6667) < 0.05 &&
    Math.abs(parseFloat(paper.lineHeight) - 14.6667 * 1.65) < 0.2,
  JSON.stringify([paper.fontSize, paper.lineHeight]),
);
check("整页纸张限宽居中", paper.paperMaxWidth !== "none", paper.paperMaxWidth);
check(
  "状态栏有模式标识且不显示行列",
  paper.status.includes("写作") && !paper.status.includes("行 "),
  paper.status,
);
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
const headingDoc = await c.evaluate(
  `document.querySelector(".cm-content").cmTile.root.view.state.doc.toString()`,
);
check(
  // 新规则（见 live-preview 的 markup-decorations）：命令把 `= ` 写进了文档，但标记只在光标
  // 触碰它时才露出 —— 所以判据是"文档行首有 `= `、而 innerText 里没有"，不是 innerText 有标记。
  "Ctrl+1 标题（行首加 `= `，标记按新规则隐藏、正文仍是真实文本）",
  headingDoc.startsWith("= ") && !heading.trim().startsWith("= "),
  JSON.stringify({ heading, headingDoc }),
);
const headingSize = await c.evaluate(`(() => {
  const el = document.querySelector(".cm-markup-heading");
  return el ? parseFloat(getComputedStyle(el).fontSize) : null;
})()`);
check(
  // 1.4em × 14.6667px = 20.53px（typst 的一级标题，文档默认 11pt）；
  // **不是**"随便放大"就行 —— 梯度与基准都必须与切片一致
  "标题在写作模式下按 typst 梯度放大（1.4em = 20.53px）",
  headingSize !== null && Math.abs(headingSize - 20.53) < 0.5,
  String(headingSize),
);
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
// Ctrl+E 进源码模式
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const inSource = await c.evaluate(`document.querySelector(".cm-content").innerText`);
check("Ctrl+/ 切到源码模式后内容仍在", inSource.includes("KEEP-A"), JSON.stringify(inSource));
// 在源码模式里继续输入
await c.type("KEEP-B 源码输入\n");
await new Promise((r) => setTimeout(r, 400));
// Ctrl+E 切回写作模式
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
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

// ── 键位归属（2026-09-18 用户要求）：`Ctrl+/` = 注释、`Ctrl+E` = 切换模式 ──
// 为什么必须分开（这就是修之前的现场）：两件事曾经**同时**挂在 `Ctrl+/` 上 ——
// 编辑器的 CM keymap 处理 `Mod-/` 时只 `preventDefault()`、不阻断冒泡，而菜单的 window 级匹配
// 不看 `defaultPrevented` ⇒ 按一次既注释又切模式（模式还会被切走，用户要的是"只注释"）。
// 这两条断言改之前是红的（当时打的是 `/* */`、模式也被切走），所以也是回退对照。
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 200));
await c.type("COMMENT-TARGET"); // 不带尾换行：光标停在唯一那一行，注释的目标就是它
await new Promise((r) => setTimeout(r, 400));
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 }); // Ctrl+/：应当只注释
await new Promise((r) => setTimeout(r, 500));
// 模式看**常驻标签**（.mode-tag 的「写作」/「源码」）而不是状态文字 ——
// 状态文字会被编译状态（「就绪」）顶掉，拿它断言就是在测别的东西（第一版就栽在这上面）。
const modeNow = () =>
  c.evaluate(
    `({
      doc: document.querySelector(".cm-content").innerText,
      tags: Array.from(document.querySelectorAll(".statusbar .mode-tag")).map((e) => e.textContent.trim()),
    })`,
  );
const ctrlSlash = await modeNow();
check(
  "Ctrl+/ 只做行注释：文档里出现 typst 的 `//`，且模式仍是写作（不再顺带把模式切走）",
  ctrlSlash.doc.includes("// COMMENT-TARGET") && ctrlSlash.tags.some((t) => t.includes("写作")),
  JSON.stringify(ctrlSlash),
);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 }); // Ctrl+E：切模式
await new Promise((r) => setTimeout(r, 500));
const ctrlE1 = await modeNow();
check(
  "Ctrl+E 切到源代码模式（新键位生效）",
  ctrlE1.tags.some((t) => t.includes("源码")),
  JSON.stringify(ctrlE1),
);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const ctrlE2 = await modeNow();
check(
  "再按一次 Ctrl+E 回到写作模式（双向都生效）",
  ctrlE2.tags.some((t) => t.includes("写作")),
  JSON.stringify(ctrlE2),
);
// 收尾：清掉这段内容，别影响后面的组
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 300));

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

console.log(
  "22) Alt 激活菜单栏：编辑器不失焦、光标与滚动位置不变（用户反馈「不要改变当前编辑位置」）",
);
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
await c.evaluate(
  `(() => { const sc = document.querySelector(".cm-scroller"); sc.scrollTop = Math.floor(sc.scrollHeight / 2); return 1; })()`,
);
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
check(
  "起点：焦点在编辑区、菜单未激活、已滚动",
  beforeAlt.focusInEditor && !beforeAlt.menuSelected && beforeAlt.scrollTop > 0,
  JSON.stringify(beforeAlt),
);

await c.key("Alt", { code: "AltLeft", keyCode: 18, modifiers: 1 });
await new Promise((r) => setTimeout(r, 500));
const afterAlt = await c.evaluate(probe);
check("Alt 后菜单栏进入选中态", afterAlt.menuSelected, JSON.stringify(afterAlt));
check("Alt 后编辑器**仍然**持有焦点（光标没丢）", afterAlt.focusInEditor, JSON.stringify(afterAlt));
check(
  "Alt 后滚动位置不变（编辑位置没被改）",
  afterAlt.scrollTop === beforeAlt.scrollTop,
  `${beforeAlt.scrollTop} → ${afterAlt.scrollTop}`,
);
check(
  "Alt 后文档内容没变",
  afterAlt.text === beforeAlt.text,
  `${beforeAlt.text} → ${afterAlt.text}`,
);
await c.screenshot(SHOT("wysiwyg-22-alt-keeps-focus"));

// 再按一次 Alt 取消选中：仍然保持编辑区焦点
await c.key("Alt", { code: "AltLeft", keyCode: 18, modifiers: 1 });
await new Promise((r) => setTimeout(r, 400));
const afterAlt2 = await c.evaluate(probe);
check(
  "再按 Alt 取消选中后焦点仍在编辑区",
  !afterAlt2.menuSelected && afterAlt2.focusInEditor,
  JSON.stringify(afterAlt2),
);

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
check(
  "手动检查后状态栏显示「已是最新版本」",
  afterCheck.status.includes("已是最新版本"),
  JSON.stringify(afterCheck.status),
);
check(
  "没有新版本：不弹更新窗、状态栏也不留更新入口",
  !afterCheck.dialog && !afterCheck.notice,
  JSON.stringify(afterCheck),
);
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
check(
  "设置里有「启动时自动检查更新」且默认勾选",
  !!autoRow && autoRow.checked,
  JSON.stringify(autoRow),
);
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
    zoomCalls: window.__browserDevZoomCalls ?? 0,
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
check(
  "默认状态栏不显示缩放徽标",
  !zoomStart.tags.some((t) => t.includes("缩放")),
  JSON.stringify(zoomStart.tags),
);

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
// 兜底重试：硬件上 WebView2 可能在 Ctrl+滚轮手势结束时把宿主设的 ZoomFactor 还原
// （WebView2Feedback #1022），所以每次调档除了立刻设一次，还要在**手势停下后**再确认一次
check(
  "调档后会再确认一次缩放（防 WebView2 手势结束时还原系数）",
  zoomedIn.zoomCalls >= 2,
  `setZoom 调用 ${zoomedIn.zoomCalls} 次`,
);
// 复核逻辑本身不能误报：桩的 setZoom 是假的（不改 devicePixelRatio），页面已按桩标记跳过复核
check(
  "正常路径不会误报「缩放未生效」",
  !zoomedIn.status.includes("未生效"),
  JSON.stringify(zoomedIn.status),
);
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

// 鼠标在状态栏上滚也要能缩放（监听挂在 window 捕获阶段，不是挂在 .panes 上）
const statusCenter = await c.evaluate(`(() => {
  const r = document.querySelector(".statusbar").getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
await c.wheel(statusCenter.x, statusCenter.y, -100, { modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
const overStatus = await c.evaluate(zoomProbe);
check(
  "在状态栏上 Ctrl+滚轮也能缩放（监听挂在 window，不再只有编辑区有效）",
  Math.abs((overStatus.requested ?? 0) - 1.6) < 0.001,
  String(overStatus.requested),
);

// 横向位移（按 Shift 滚轮时浏览器把纵向滚动转成横向的真机形态）也要能缩放
await c.wheel(plain.center.x, plain.center.y, 0, { modifiers: 2, deltaX: -100 });
await new Promise((r) => setTimeout(r, 300));
const horizontal = await c.evaluate(zoomProbe);
check(
  "横向位移（deltaY=0 + deltaX）也能缩放（Shift 滚轮的真机形态）",
  Math.abs((horizontal.requested ?? 0) - 1.7) < 0.001,
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
check(
  "「重置缩放」回到 100%",
  Math.abs((reset.requested ?? 0) - 1) < 0.001,
  String(reset.requested),
);
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
check(
  "下拉首项是「默认」（值 = 空串）",
  fontUi.options[0] === "",
  JSON.stringify(fontUi.options.slice(0, 3)),
);
check(
  "下拉选项来自字体列表（桩给出 SimSun / Noto Serif CJK SC）",
  fontUi.options.includes("SimSun") && fontUi.options.includes("Noto Serif CJK SC"),
  JSON.stringify(fontUi.options),
);
check(
  "有「额外字体目录」区与添加按钮",
  fontUi.hasDirBlock && fontUi.hasAddBtn,
  JSON.stringify(fontUi),
);

// 添加字体目录（桩的目录选择器返回假目录）→ 目录进列表、字体列表随之刷新
await c.evaluate(`(() => {
  const btn = Array.from(document.querySelectorAll(".settings-modal button")).find((e) =>
    (e.textContent || "").includes("添加字体目录"),
  );
  btn.click();
})()`);
await c.waitFor(`!!document.querySelector(".settings-modal .settings-dir-path")`, {
  timeout: 5000,
});
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
check(
  "保存后弹窗关闭并给出状态栏反馈",
  !saved.modalOpen && saved.status.includes("设置已保存"),
  saved.status.slice(0, 40),
);

// 字体族名写错（中文族名永远匹配不上）→ typst 只发 warning：必须可见，否则就是"改了字体没用"
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));
await c.click(400, 300);
await c.type('#set text(font: "微软雅黑")\n中文测试');
// 注意：警告徽标自 2026-09-14 起**常驻显示**（无警告时是 0），所以这里要等"可点击"
// （= 真有警告）而不是等它出现，否则会在警告到达前就点一个空徽标
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
const warnStatus = await c.evaluate(`document.querySelector(".statusbar").innerText`);
check(
  "写错的字体族名以警告形式出现在状态栏（不再静默回退）",
  warnStatus.includes("警告") && warnStatus.includes("未知字体族"),
  warnStatus.slice(0, 80),
);
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(`!!document.querySelector(".error-popover .error-item-msg")`, { timeout: 5000 });
const warnText = await c.evaluate(`document.querySelector(".error-popover").innerText`);
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
check(
  "说明里不再出现 `**` 原文（粗体渲染成 strong）",
  !notes.text.includes("**") && notes.strongs.length > 0,
  JSON.stringify(notes.strongs),
);
check(
  "行内代码渲染成 code 元素",
  notes.codes.some((t) => t.includes("font-warnings.ts")),
  JSON.stringify(notes.codes),
);
check(
  "列表渲染成 li，且两空格缩进形成嵌套列表",
  notes.bullets >= 3 && notes.nested >= 1,
  `li=${notes.bullets} nested=${notes.nested}`,
);
check(
  "说明里的 HTML 只当文本显示（转义，不注入元素）",
  notes.imgs === 0 && notes.text.includes("<img"),
  `imgs=${notes.imgs} 片段=${notes.text.slice(0, 40)}`,
);
await c.screenshot(SHOT("wysiwyg-26-update-notes"));
await c.evaluate(
  `Array.from(document.querySelectorAll(".update-modal .modal-btn")).find(b => (b.textContent || "").includes("稍后")).click()`,
);

// ---------------------------------------------------------------------------
// 第 27 组：引擎只肯缩小不肯放大时，界面状态必须跟着引擎走（真机 bug 的回归网）
// 背景（2026-09-14 用户四次反馈同一现象）：Windows/WebView2 上引擎没接受"放大"，而前端 uiZoom
// 照旧涨到上限 250%，于是从 250% 往下滚要滚十几档才有反应——「放大根本没用，缩小有用」→
// 「最大后无法用滚轮缩小」→「缩放到最大后无法从 Ctrl+滚轮缩小」→（第四次直接给了状态栏截图）
// 「引擎把 150% 限制在 100%」。修法是让状态永远等于引擎实际接受的档位（+page.svelte 的
// verifyZoomApplied），并且**多量几次**（引擎可能晚一拍才生效，或者把手势里的值抹掉）。
// 无头环境靠桩的"模拟引擎"复现：?zoomsim=1 给 window.devicePixelRatio 与
// document.documentElement.clientWidth 装假 getter（都跟着"引擎接受的缩放"走），
// 再加 &zoomcap=1 / &zoommax=2.1 / &zoomdelay=N 就是那几台机器。
// ---------------------------------------------------------------------------
console.log("27) 引擎拒绝放大时，档位跟着引擎走（模拟真机）");
const zoomProbe2 = `(() => {
  const de = document.querySelector(".statusbar");
  return {
    requested: window.__browserDevLastZoom ?? null,
    engine: window.__browserDevEngineZoom ?? null,
    saved: JSON.parse(localStorage.getItem("typst-pad:state") || "{}").uiZoom ?? null,
    status: de ? de.innerText : "",
    tags: Array.from(document.querySelectorAll(".statusbar .mode-tag")).map(e => e.textContent.trim()),
  };
})()`;

/**
 * 导航到"模拟引擎"的页面并等界面就绪，**并保证从"没有存档"的干净状态起步**（缩放 100%）。
 *
 * 为什么不能写成"在旧页面上 clear 后立刻导航"（老写法，实测偶发红）：存档是 300ms 防抖写的，
 * 旧页面在 clear 之后、被导航销毁之前的那一小段时间里仍可能把迟到的存档写回去（带着它自己的
 * uiZoom），于是新页带着上一段的缩放起步 —— 第 27 组 E 段本该从 100% 滚 3 格到 130%，
 * 偶发从 130% 起步滚出 160%，两条断言同时红（2026-09-18 实测一次）。
 * 现在改成：**先把旧页导航掉**（页面连同它的定时器一起销毁，不会再有迟到写入），
 * 再用 CDP 按 origin 清 localStorage，最后才加载目标页。
 */
const gotoSim = async (extra) => {
  await c.send("Page.navigate", { url: "about:blank" });
  try {
    await c.send("Storage.clearDataForOrigin", {
      origin: new URL(DEV_URL).origin,
      storageTypes: "local_storage",
    });
  } catch {
    await c.evaluate(`localStorage.clear()`); // CDP 域不可用时退回页面内清理（仍好过旧写法）
  }
  await c.goto(`${DEV_URL}${extra}`);
  await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 900));
};
/** 在编辑区中心连滚 N 格 */
const wheelOverEditor = async (deltaY, times) => {
  const center = await c.evaluate(`(() => {
    const r = document.querySelector(".editor-pane").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  for (let i = 0; i < times; i++) await c.wheel(center.x, center.y, deltaY, { modifiers: 2 });
  // 等状态**稳定**再断言（这条比看起来难：引擎拒绝时界面要过好几拍才把档位拉回来）：
  //   手势停下 250ms → 复核设一次 → 按 0/250/700ms 连量三次（见 zoom.ts 的 ZOOM_VERIFY_WAITS_MS）
  //   → 再重设一次并量一次 ≈ 1.2s → 拉回状态 → 存档 300ms 防抖。
  // 合计约 1.8s，所以下限取 2400ms 留足余量，再轮询到连续两次读数相同。
  // （等不够会读到"复核还没落地"的中间态：实测 1600ms 就会偶发读到还没落盘的旧档位。）
  await new Promise((r) => setTimeout(r, 2400));
  const readZoom = () =>
    c.evaluate(`JSON.parse(localStorage.getItem("typst-pad:state") || "{}").uiZoom ?? null`);
  let previous = await readZoom();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const current = await readZoom();
    if (current === previous) break;
    previous = current;
  }
};

// A) 引擎照单全收：复核不能误伤（状态 = 请求值）
await gotoSim("&zoomsim=1");
await wheelOverEditor(-100, 3);
const simOk = await c.evaluate(zoomProbe2);
check(
  "模拟引擎接受缩放时，档位与引擎一致（不误报、不被拉回）",
  Math.abs((simOk.requested ?? 0) - 1.3) < 0.001 && Math.abs((simOk.saved ?? 0) - 1.3) < 0.001,
  JSON.stringify(simOk),
);
check(
  "接受缩放时不出现「未生效」提示",
  simOk.status.includes("缩放 130%") && !simOk.status.includes("未生效"),
  JSON.stringify(simOk.status),
);
// 回归（2026-09-14 用户第五次反馈「还是会出现界面缩放未生效的 BUG」的根因）：
// 引擎改档会让 `window.innerWidth` 跟着变、浏览器随即派发一次 resize（WebView2 参考文档原话），
// 而页面里"拖窗口 → 重校 100% 基准"那条监听当时用的是**改档前**的档位，于是基准被压低成
// "新宽度"，复核把"引擎明明接受了"读成"引擎没动"、档位随即被拉回 100%。
// 假引擎现在照真引擎那样在 commit 后派发 resize（见 browser-dev-stub），所以这条路径在
// 验收里跑得到：**连续放大两档都必须落在请求值**——第一档若把基准带偏，第二档立刻露馅。
await wheelOverEditor(-100, 1);
const simSecond = await c.evaluate(zoomProbe2);
check(
  "缩放自己引发的 resize 没把 100% 基准带偏：紧接着再放大一档仍生效（1.3 → 1.4）",
  Math.abs((simSecond.requested ?? 0) - 1.4) < 0.001 &&
    Math.abs((simSecond.saved ?? 0) - 1.4) < 0.001 &&
    !simSecond.status.includes("未生效"),
  JSON.stringify(simSecond),
);
// 反方向也要立刻见效（同一根因的顺带表现：基准被带偏时往下滚也判不出档位）
await wheelOverEditor(100, 1);
const simDown = await c.evaluate(zoomProbe2);
check(
  "接上一步往下滚一档也立刻生效（1.4 → 1.3，基准没被自己带偏）",
  Math.abs((simDown.saved ?? 0) - 1.3) < 0.001 && !simDown.status.includes("未生效"),
  JSON.stringify(simDown),
);

// B) 引擎只肯缩小（放大一律按 100% 处理）：**档位保留用户请求的那个值，软件不许自己改**
// （2026-09-16 用户明确要求：「就应该缩放只有我能改，软件别自己动了」——以前这里会把档位拉回
// 引擎给的 100%，用户看到的正是「用 Ctrl+滚轮会回退」）
await gotoSim("&zoomsim=1&zoomcap=1");
await wheelOverEditor(-100, 4);
const capped = await c.evaluate(zoomProbe2);
check(
  "引擎拒绝放大时，档位**保留用户请求的 140%**（软件不再把档位拉回引擎给的 100%）",
  Math.abs((capped.saved ?? 0) - 1.4) < 0.001 && Math.abs((capped.engine ?? 0) - 1) < 0.001,
  JSON.stringify(capped),
);
check(
  "状态栏只**说明**没观察到变化（不再写「限制在 100%」，因为那只是我们的推测）",
  capped.status.includes("引擎侧没观察到变化") && capped.status.includes("已按你的操作设到 140%"),
  JSON.stringify(capped.status),
);
// 文案要带上实测数据：这个现象只在用户那台真机上出现，状态栏是唯一能读到的通道
// （"布局宽度没变" 与 "宽度变过又回来" 指向完全不同的成因）。
check(
  "文案带上了实测数据（量了几次 / 布局宽度 / dpr）",
  capped.status.includes("量了") &&
    capped.status.includes("布局宽度") &&
    capped.status.includes("dpr"),
  JSON.stringify(capped.status),
);
// 接着往下滚必须立刻见效（用户之前报过「最大后无法用滚轮缩小」；新政策下档位不会被钉在 100%，
// 所以从 140% 往下滚一格就该到 130%）
await wheelOverEditor(100, 1);
const afterOut = await c.evaluate(zoomProbe2);
check(
  "被引擎拒绝之后，往下滚一格立刻生效（140% → 130%）",
  Math.abs((afterOut.saved ?? 0) - 1.3) < 0.001,
  JSON.stringify(afterOut),
);

// C) 引擎能放大、但**只到 210%**：档位同样保留用户请求（2.2），且往下滚一档立刻见效。
// 这一版把判据从 devicePixelRatio 换成 **CSS 视口宽度比**（真机上 dpr 不跟随 ZoomFactor）；
// `&zoommax=2.1` 让桩模拟这台机器。**注意新政策**：状态可以高于引擎给的档位（死区回来了）——
// 这是用户明确接受的代价（「缩放只有我能改」优先于"档位永远等于引擎值"）。
await gotoSim("&zoomsim=1&zoommax=2.1");
await wheelOverEditor(-100, 12); // 1.0 → 请求 2.2，引擎只给 2.1
const capped210 = await c.evaluate(zoomProbe2);
check(
  "引擎上限 210%：档位保留用户请求的 2.2（不再被拉回 2.1）",
  Math.abs((capped210.saved ?? 0) - 2.2) < 0.011 && Math.abs((capped210.engine ?? 0) - 2.1) < 0.011,
  JSON.stringify(capped210),
);
await wheelOverEditor(100, 1);
const afterDown210 = await c.evaluate(zoomProbe2);
check(
  "往下滚一档立刻见效（2.2 → 2.1，用户报的「最大后无法缩小」不再出现）",
  Math.abs((afterDown210.saved ?? 0) - 2.1) < 0.011,
  JSON.stringify(afterDown210),
);
// D) 引擎**晚一拍**才生效（`&zoomdelay=300`）：设完立刻量还是旧档位。复核必须多等几次才下结论，
// 否则一台"只是慢"的机器会被误判成"引擎不接受"，把用户刚调上去的档位又拉回来 —— 这正是
// 「缩放会无效」最可能的形态之一（见 zoom.ts 的 ZOOM_VERIFY_WAITS_MS）。
await gotoSim("&zoomsim=1&zoomdelay=300");
await wheelOverEditor(-100, 3);
const delayed = await c.evaluate(zoomProbe2);
check(
  "引擎晚 300ms 才生效时，档位仍然落在请求值（多等几次就等到了）",
  Math.abs((delayed.saved ?? 0) - 1.3) < 0.001 && Math.abs((delayed.engine ?? 0) - 1.3) < 0.011,
  JSON.stringify(delayed),
);
check("慢引擎不误报「未生效」", !delayed.status.includes("未生效"), JSON.stringify(delayed.status));

// E) **宽度判据瞎了、只有 dpr 跟随的机器**（`&zoomwidthstuck=1`，2026-09-16 用户第六轮反馈
// 「改变窗口大小的时候会动缩放；用 Ctrl + 滚轮 会回退」）：桩让 `clientWidth` 永远等于 100% 基准、
// 只有 dpr 跟着引擎走 —— 那台真机上就是这句「布局宽度没变（1379px）」。
// 只认宽度判据的话，这里会把**真的生效了**的缩放判成失败并弹回原档（用户看到的「回退」），
// 修法是 zoomAcceptedByTwoJudges：两条判据任一成立即接受。修前本条会红。
await gotoSim("&zoomsim=1&zoomwidthstuck=1");
await wheelOverEditor(-100, 3);
const widthStuck = await c.evaluate(zoomProbe2);
check(
  "宽度判据读不出缩放、但 dpr 判据看得见的机器：档位照旧落在请求值（不再被弹回 120%）",
  Math.abs((widthStuck.saved ?? 0) - 1.3) < 0.001 &&
    Math.abs((widthStuck.engine ?? 0) - 1.3) < 0.011,
  JSON.stringify(widthStuck),
);
check(
  "这台机器上也不误报「未生效」（修前正是它把生效的缩放判成失败）",
  !widthStuck.status.includes("未生效") && widthStuck.status.includes("缩放 130%"),
  JSON.stringify(widthStuck.status),
);
// 正交验证：哪怕引擎真的没动、且两条判据都读不到，**也不改用户的档位**（新政策的底线）。
// 这一条替代了旧的"必须报「未生效」并拉回 100%"——那条正是用户不要的行为。
await gotoSim("&zoomsim=1&zoomcap=1&zoomwidthstuck=1");
await wheelOverEditor(-100, 2);
const stuckCapped = await c.evaluate(zoomProbe2);
check(
  "两条判据都瞎 + 引擎真拒绝：档位仍保留用户请求的 120%，只给一句说明",
  Math.abs((stuckCapped.saved ?? 0) - 1.2) < 0.001 && stuckCapped.status.includes("没观察到变化"),
  JSON.stringify(stuckCapped),
);

// ---------------------------------------------------------------------------
// 第 28 组：缩放到很大时状态栏不能"长高"（用户截图里的样子）
// 背景（2026-09-14）：用户把界面放大到 190%（等价于 CSS 视口只剩 ~660px）后，状态栏里那条很长的
// 脚本错误 + 右侧一堆标签在 flex 里被压缩 → 每个 span 各自折行 → 整条状态栏长成一大块竖排文字，
// 看起来像"界面烂了"。修法：状态栏 flex-wrap: nowrap；左侧状态文字单行省略号；右侧徽标/标签/计数
// flex: none + nowrap。同时把 Chromium 自己的 "ResizeObserver loop ..." 提示从"脚本错误"里过滤掉
// （它不是应用的错误，报出来只会吓人），并把预览画布的重算推到下一帧。
// ---------------------------------------------------------------------------
console.log("28) 大缩放下状态栏仍是一行（≈660px 的 CSS 视口）");
await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  raw.viewMode = "source";   // 双栏：状态栏项最多的情况
  raw.showPreview = true;
  localStorage.setItem("typst-pad:state", JSON.stringify(raw));
})()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
// 660px 宽的 CSS 视口 = 在 1258px 窗口里缩放到 ~190%
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 660,
  height: 460,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((r) => setTimeout(r, 500));

// ① Chromium 自己的 ResizeObserver 提示：不算应用的脚本错误，不许进状态栏
await c.evaluate(
  `window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }))`,
);
await new Promise((r) => setTimeout(r, 300));
const afterBenign = await c.evaluate(`document.querySelector(".statusbar").innerText`);
check(
  "引擎的 ResizeObserver 提示不再报成「脚本错误」",
  !afterBenign.includes("脚本错误"),
  JSON.stringify(afterBenign.slice(0, 80)),
);

// ② 真正的长错误：状态栏必须仍然只有一行（左侧省略号、右侧标签不折行）
await c.evaluate(
  `window.dispatchEvent(new ErrorEvent("error", { message: "TypeError: 一条很长的真实脚本错误信息，用来验证状态栏不会因为它变成两行" }))`,
);
await new Promise((r) => setTimeout(r, 300));
const narrow = await c.evaluate(`(() => {
  const bar = document.querySelector(".statusbar");
  return {
    h: Math.round(bar.getBoundingClientRect().height),
    childHeights: Array.from(bar.children).map(e => Math.round(e.getBoundingClientRect().height)),
    text: bar.innerText.replace(/\\n/g, " ⏎ ").slice(0, 120),
    hasError: bar.innerText.includes("脚本错误"),
  };
})()`);
check("真正的脚本错误仍然会显示在状态栏", narrow.hasError, JSON.stringify(narrow.text));
check(
  "长状态文字不把状态栏顶高（仍是一行：高度 ≤ 30px）",
  narrow.h <= 30,
  `状态栏高 ${narrow.h}px`,
);
check(
  "右侧徽标/标签/计数在窄视口下也不折行（每项 ≤ 20px）",
  narrow.childHeights.every((h) => h <= 20),
  JSON.stringify(narrow.childHeights),
);
await c.screenshot(SHOT("wysiwyg-28-narrow-statusbar"));
await c.send("Emulation.clearDeviceMetricsOverride");

// ---------------------------------------------------------------------------
// 第 29 组：源码模式 Alt+Z 自动换行（用户要求：VS Code 同款手势）
// 背景：源码模式是"源码 + 预览"双栏，编辑区窄，而 CodeMirror 默认**不折行** —— 长行必须横向滚动
// 才看得到行尾。现在 Alt+Z 切换自动换行（`EditorView.lineWrapping`，经 Compartment 重配，
// 不重建 EditorView，所以撤销历史与光标都不丢），状态随存档持久化。
// 这里除正路之外还锁两条容易踩的边界：
//   ① **不许抢 Ctrl+Z**（撤销）——Alt+Z 的判定必须排除 Ctrl/Meta（见 word-wrap.isWrapToggleKey）；
//   ② 写作模式是按原文排版的"整页纸张"，Alt+Z 不该悄悄改它 —— 只给提示。
// ---------------------------------------------------------------------------
console.log("29) 源码模式 Alt+Z 自动换行");
// 源码模式 + 双栏（编辑区最窄的情形），并清掉上轮遗留的换行开关
await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  raw.viewMode = "source";
  raw.showPreview = true;
  delete raw.editorWrap;
  localStorage.setItem("typst-pad:state", JSON.stringify(raw));
})()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);
await c.selectAll();
// 一条远宽于编辑区的长行（中文按 2 字宽算，足够撑出横向滚动）
await c.type("= 自动换行测试 " + "一二三四五六七八九十".repeat(12));
await new Promise((r) => setTimeout(r, 400));

/** 换行状态 + 几何：cm-lineWrapping 类、横向溢出量、首行实际高度、存档值、状态栏文案 */
const wrapProbe = `(() => {
  const content = document.querySelector(".cm-content");
  const scroller = document.querySelector(".cm-scroller");
  const line = document.querySelector(".cm-line");
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  return {
    wrapping: content.classList.contains("cm-lineWrapping"),
    overflowX: Math.round(scroller.scrollWidth - scroller.clientWidth),
    lineHeight: Math.round(line.getBoundingClientRect().height),
    saved: raw.editorWrap ?? null,
    mode: document.querySelector(".statusbar .mode-tag")?.textContent ?? "",
    status: document.querySelector(".statusbar").innerText.replace(/\\n/g, " ⏎ ").slice(0, 90),
  };
})()`;

const beforeWrap = await c.evaluate(wrapProbe);
check(
  "默认不折行：长行横向溢出（这就是要 Alt+Z 的原因）",
  beforeWrap.wrapping === false && beforeWrap.overflowX > 20,
  JSON.stringify(beforeWrap),
);
const singleLineHeight = beforeWrap.lineHeight;

// Alt+Z 打开
await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 1 });
await new Promise((r) => setTimeout(r, 400));
const wrapped = await c.evaluate(wrapProbe);
check(
  "Alt+Z 打开自动换行（cm-lineWrapping 生效）",
  wrapped.wrapping === true,
  JSON.stringify(wrapped),
);
check(
  "长行折行显示、横向溢出消失",
  wrapped.overflowX <= 2 && wrapped.lineHeight > singleLineHeight + 10,
  `溢出 ${wrapped.overflowX}px，行高 ${singleLineHeight} → ${wrapped.lineHeight}`,
);
check(
  "状态栏说明开关状态",
  wrapped.status.includes("自动换行：开"),
  JSON.stringify(wrapped.status),
);
check(
  "换行开关写进存档（下次启动仍是开的）",
  wrapped.saved === true,
  JSON.stringify(wrapped.saved),
);
await c.screenshot(SHOT("wysiwyg-29-wrap-on"));

// 刷新后仍然折行（持久化真的生效，而不只是内存里的一次重配）
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
const reloadedWrap = await c.evaluate(wrapProbe);
check(
  "重新加载后仍然自动换行（存档恢复）",
  reloadedWrap.wrapping === true && reloadedWrap.overflowX <= 2,
  JSON.stringify(reloadedWrap),
);

// Ctrl+Z 绝不能被 Alt+Z 抢走：先输入一个字符，撤销后它必须消失
await c.click(400, 300);
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.key("End", { code: "End", keyCode: 35 });
await c.type("Z");
await new Promise((r) => setTimeout(r, 300));
const typed = await c.evaluate(`document.querySelector(".cm-content").innerText.length`);
await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));
const afterUndo = await c.evaluate(wrapProbe);
const undoneLen = await c.evaluate(`document.querySelector(".cm-content").innerText.length`);
check(
  "Ctrl+Z 仍是撤销（没被 Alt+Z 抢走）",
  undoneLen === typed - 1 && afterUndo.wrapping === true,
  `长度 ${typed} → ${undoneLen}，换行 ${afterUndo.wrapping}`,
);

// Alt+Z 关：回到不折行
await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 1 });
await new Promise((r) => setTimeout(r, 400));
const wrapOff = await c.evaluate(wrapProbe);
check(
  "再按一次 Alt+Z 关闭（回到横向滚动）",
  wrapOff.wrapping === false && wrapOff.overflowX > 20 && wrapOff.saved === false,
  JSON.stringify(wrapOff),
);

// 写作模式（文档模式）：**始终自动折行**，不需要 Alt+Z
// 用户要求（2026-09-14）：「预览模式和文档模式的内容不应该有横向拖动，而是自动换行，
// Alt+Z 只对代码起效」——实测改前一条长行会给写作模式带来 2855px 的横向滚动。
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const writeAuto = await c.evaluate(wrapProbe);
check(
  "写作模式默认就折行（文档形态，不靠 Alt+Z）",
  writeAuto.mode.includes("写作") && writeAuto.wrapping === true && writeAuto.overflowX <= 2,
  JSON.stringify(writeAuto),
);

// 写作模式下按 Alt+Z 不改任何状态，只说明规则
await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 1 });
await new Promise((r) => setTimeout(r, 400));
const inWrite = await c.evaluate(wrapProbe);
check(
  "写作模式下 Alt+Z 不改状态（没动源码模式那个开关），并说明规则",
  inWrite.wrapping === true && inWrite.saved === false && inWrite.status.includes("始终自动换行"),
  JSON.stringify(inWrite),
);

// 回源码模式：换行开关仍是关（两个模式互不影响）
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 500));
const backToSource = await c.evaluate(wrapProbe);
check(
  "切回源码模式仍是不折行（写作模式的自动折行不会写进这个开关）",
  backToSource.mode.includes("源码") &&
    backToSource.wrapping === false &&
    backToSource.overflowX > 20 &&
    backToSource.saved === false,
  JSON.stringify(backToSource),
);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 第 30 组：预览**按栏宽重新排版**（用户 2026-09-14：「预览模式还是有横的拖动的条」）
// 背景（三轮）：① 预览曾是"自适应铺满栏宽"，界面缩放走 webview `setZoom`、把 CSS 视口一起缩小，
// 拿缩小后的栏宽算铺满正好与放大抵消 → 用户两次反馈「预览框大小还是没变」；
// ② 修成"按缩放前的栏宽算、画布保持不变"之后，固定版心（A4）的页面在放大时必然超出预览栏
// → 出现横向滚动条（用户「预览模式还是有横的拖动的条」，实测 210% 缩放下要横滚 ~250px）；
// ③ 用户选定**重排**：预览的纸张宽度跟着预览栏走，正文按新宽度重新排版、**字号不变** ——
// 预览栏永不出现横向滚动条，而且预览字号仍与编辑器一致。代价（用户知情接受）：
// 预览的换行/分页不再等于导出的 PDF。
// 实现：栏宽 → 页宽（pt）是**编译期输入**（Rust 侧在编译源最前面注入 `#set page(...)`，
// 见 typst_world::preview_page_setup）；栏宽变化时去抖 250ms 重编译一次。
// 文档自己写了 `#set page(...)` 会覆盖注入 → 前端用产物页宽判断，退回旧的等比缩放路径
// （验收用 `&reflowfail=1` 让桩模拟这台机器）。
// 无头环境怎么造缩放：CDP `Emulation.setDeviceMetricsOverride` 把 CSS 视口压到「窗口宽 ÷ 缩放」，
// 布局上等价于 webview 缩放；画布的物理尺寸 = 画布 CSS 宽度 × 缩放（量的 rect 仍是未放大的 px）。
// ---------------------------------------------------------------------------
console.log("30) 预览按栏宽重新排版（永不横向滚动条 + 预览字号不随栏宽缩水）");
const previewProbe = `(() => {
  const body = document.querySelector(".preview-body");
  const host = document.querySelector("#preview-host");
  const svg = host?.querySelector("svg");
  const rect = svg?.getBoundingClientRect();
  const z = JSON.parse(localStorage.getItem("typst-pad:state") || "{}").uiZoom ?? 1;
  // 用户单位（pt）→ CSS px 的实际缩放：重排生效时应恒为 EDITOR_FONT_PX / 11pt ≈ 1.27
  // （预览字号与编辑器一致），且**不随栏宽/缩放变化**——这正是"重排而不是缩小"的判据
  const ctm = svg?.getScreenCTM?.();
  return {
    z,
    container: body ? body.clientWidth : null,
    canvasCss: rect ? Math.round(rect.width * 10) / 10 : null,
    canvasPhys: rect ? Math.round(rect.width * z * 10) / 10 : null,
    overflowX: body ? body.scrollWidth - body.clientWidth : null,
    scrollLeft: body ? body.scrollLeft : null,
    leftGap: rect && body ? Math.round(rect.left - body.getBoundingClientRect().left) : null,
    pages: document.querySelectorAll("#preview-host > svg").length,
    unitScale: ctm ? Math.round(ctm.a * 1000) / 1000 : null,
    // 预览里**正文**那行字的高度（CSS px / 物理 px）：重排后纸张恒等于栏宽，所以"跟着缩放
    // 变大的东西"是字而不是纸张宽度 —— 判据要量字，别量画布宽度（第一版就写错了）
    textCssPx: (() => {
      const t = host?.querySelector("text");
      const r = t?.getBoundingClientRect();
      return r ? Math.round(r.height * 10) / 10 : null;
    })(),
    textPhysPx: (() => {
      const t = host?.querySelector("text");
      const r = t?.getBoundingClientRect();
      return r ? Math.round(r.height * z * 10) / 10 : null;
    })(),
    viewBoxW: svg ? Math.round(Number((svg.getAttribute("viewBox") || "0 0 0 0").split(/[\\s,]+/)[2]) * 10) / 10 : null,
    lastPreviewWidthPt: window.__browserDevLastCompile ? window.__browserDevLastCompile.previewWidthPt : null,
  };
})()`;

/** 预置「源码模式 + 双栏 + 指定缩放」，在给定 CSS 视口宽下加载，等重排编译跑完再量 */
async function loadPreviewAt(viewportW, uiZoom, extraQuery = "") {
  await c.evaluate(`(() => {
    const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
    raw.viewMode = "source";
    raw.showPreview = true;
    raw.restoreSession = true;
    raw.uiZoom = ${uiZoom};
    // 给一段足够长的正文：本组判据之一是"窄栏下页数变多"（真的重排了），文档太短时两档都是
    // 一页、量不出区别（第一版就栽在这上面）
    const lines = [];
    for (let i = 1; i <= 60; i++) lines.push("第 " + i + " 行内容");
    raw.content = lines.join("\\n");
    localStorage.setItem("typst-pad:state", JSON.stringify(raw));
  })()`);
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: viewportW,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c.goto(`${DEV_URL}${extraQuery}`);
  await c.waitFor(`!!document.querySelector(".preview-body svg")`, { timeout: 30000 });
  // 等 ResizeObserver → 去抖 250ms → 重排编译 → 再量一次画布
  await new Promise((r) => setTimeout(r, 1800));
  return c.evaluate(previewProbe);
}

const WIN = 1040; // 中等窗口：100% 时预览栏比 A4 自然尺寸窄，正是过去要横滚的那一支
const base = await loadPreviewAt(WIN, 1);
check(
  "重排后的页宽确实传给了后端（previewWidthPt ≈ 栏宽 × 11/14）",
  base.lastPreviewWidthPt !== null &&
    Math.abs(base.lastPreviewWidthPt - (base.container * 11) / 14) <= 2,
  `栏宽 ${base.container} → 请求页宽 ${base.lastPreviewWidthPt}pt`,
);
check(
  "重排生效：产物页宽 = 请求页宽（假 SVG 的 viewBox 跟着走）",
  base.viewBoxW !== null &&
    base.lastPreviewWidthPt !== null &&
    Math.abs(base.viewBoxW - base.lastPreviewWidthPt) <= 1,
  `viewBox ${base.viewBoxW} vs 请求 ${base.lastPreviewWidthPt}`,
);
check(
  "画布铺满预览栏但**不超出**（永不横向滚动条）",
  base.canvasCss !== null && Math.abs(base.canvasCss - base.container) <= 2 && base.overflowX <= 0,
  JSON.stringify(base),
);
check(
  "预览字号与编辑器一致（用户单位→CSS px ≈ 14/11 ≈ 1.273）",
  base.unitScale !== null && Math.abs(base.unitScale - 14 / 11) < 0.05,
  `unitScale=${base.unitScale}`,
);

const zoom150 = await loadPreviewAt(Math.round(WIN / 1.5), 1.5);
check(
  "150%：仍然一根横向滚动条都没有（这是这次要修的那件事）",
  zoom150.overflowX <= 0,
  `栏宽 ${zoom150.container}，画布 ${zoom150.canvasCss}，横向溢出 ${zoom150.overflowX}px`,
);
check(
  "150%：预览里的字物理上变大了（预览跟着界面缩放一起变大，没被重排吃掉）",
  zoom150.textPhysPx !== null &&
    base.textPhysPx !== null &&
    zoom150.textPhysPx / base.textPhysPx > 1.3,
  `字高 物理 ${base.textPhysPx}px → ${zoom150.textPhysPx}px（比 ${(zoom150.textPhysPx / base.textPhysPx).toFixed(3)}）`,
);
check(
  "150%：纸张宽度 = 栏宽（重排的必然：恒铺满栏宽，物理宽度不随缩放变；变大的是字不是纸张越界）",
  zoom150.canvasCss !== null &&
    zoom150.container !== null &&
    Math.abs(zoom150.canvasCss - zoom150.container) <= 2,
  `画布 CSS ${zoom150.canvasCss} vs 栏宽 ${zoom150.container}（物理都 ≈ 窗口的一半栏宽）`,
);
check(
  "150%：预览字号没缩水（重排的是排版，不是把页面缩小——旧实现这里会掉到 ~0.6）",
  zoom150.unitScale !== null && Math.abs(zoom150.unitScale - base.unitScale) < 0.05,
  `unitScale ${base.unitScale} → ${zoom150.unitScale}`,
);

const zoom250 = await loadPreviewAt(Math.round(WIN / 2.5), 2.5);
check(
  "250%：依然不横滚（高倍缩放下栏很窄，最容易被撑出滚动条）",
  zoom250.overflowX <= 0,
  `栏宽 ${zoom250.container}，画布 ${zoom250.canvasCss}，横向溢出 ${zoom250.overflowX}px`,
);
check(
  "250%：窄栏下页数变多 = 正文真的重排了（不是裁掉/缩小）",
  zoom250.pages > base.pages,
  `页数 ${base.pages} → ${zoom250.pages}`,
);
check(
  "250%：画布左缘对齐栏内（不越界、不需要横向滚）",
  zoom250.leftGap !== null && zoom250.leftGap >= -1 && zoom250.scrollLeft === 0,
  `左缘偏移 ${zoom250.leftGap}px，scrollLeft=${zoom250.scrollLeft}`,
);
check(
  "三档缩放下预览字号逐档变大（100% → 150% → 250%，「预览跟着缩放变大」这条没有丢）",
  base.textPhysPx !== null &&
    zoom150.textPhysPx !== null &&
    zoom250.textPhysPx !== null &&
    base.textPhysPx < zoom150.textPhysPx &&
    zoom150.textPhysPx < zoom250.textPhysPx,
  `字高 物理 ${base.textPhysPx} → ${zoom150.textPhysPx} → ${zoom250.textPhysPx} px`,
);

// 文档自己写了 #set page(...) 时注入会被覆盖 → 必须退回等比缩放，而不是硬套重排假设。
// **判据换成"产物页宽"**（2026-09-18）：以前用"画布 ≠ 栏宽"当指纹，但那条路现在**也不许横滚**
// （画布同样铺满栏宽），指纹就不成立了；直接看产物的 viewBox 才是真凭据 ——
// 产物页宽 = A4（文档自己的纸型赢了），且与"请求的页宽"明显不同 = 确实没走重排。
const fallback = await loadPreviewAt(WIN, 2.5, "&reflowfail=1");
check(
  "文档自带纸型（注入被覆盖）时退回等比缩放路径，且同样不横滚",
  fallback.viewBoxW !== null &&
    fallback.lastPreviewWidthPt !== null &&
    Math.abs(fallback.viewBoxW - 595.28) <= 1 && // 产物仍是 A4 = 文档自己的纸型
    Math.abs(fallback.viewBoxW - fallback.lastPreviewWidthPt) > 2 && // 不等于请求页宽 = 没假装重排生效
    fallback.overflowX <= 0 && // 且不出现横向滚动条（2026-09-18 起）
    fallback.canvasCss !== null &&
    fallback.container !== null &&
    fallback.canvasCss <= fallback.container + 1,
  `产物页宽 ${fallback.viewBoxW} vs 请求 ${fallback.lastPreviewWidthPt}；画布 ${fallback.canvasCss} / 栏宽 ${fallback.container}；横向溢出 ${fallback.overflowX}px`,
);
await c.screenshot(SHOT("wysiwyg-30-preview-reflow"));
await c.send("Emulation.clearDeviceMetricsOverride");

// ---------------------------------------------------------------------------
// 第 31 组：输入 `$` 自动配对（用户要求「加入功能：自动补全 $$」）
// 形态：独占一行 → 补出 `$  $`（**行间**公式脚手架，内侧两侧留白才是 typst 的 display 公式），
// 光标落在中间，敲字直接得到 `$ x $`；行内（同行还有别的字）→ 补 `$$`，敲字得到 `$x$`；
// 右侧已有闭合 `$` → 只把光标移过去（连按两下 `$` 不会插出 `$ $|$  $` 这种垃圾）。
// 判定与边界（公式内部 / 代码区 / 注释 / raw / 字符串 / `\$` / 退格整对删）都在
// auto-pair.test.ts 里用纯函数锁住，这里验的是"真的敲进去、DOM 里长什么样"。
// ---------------------------------------------------------------------------
console.log("31) 输入 $ 自动配对");
await c.evaluate(`localStorage.clear()`); // 回到默认写作模式（live-preview 开着，能看见块级公式）
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 300));

const cmText = `document.querySelector(".cm-content").innerText`;

// ① 空行：行间公式脚手架
await c.type("$");
await new Promise((r) => setTimeout(r, 300));
const scaffold = await c.evaluate(cmText);
check(
  "空行输入 $ 自动补出 `$  $`（行间公式脚手架）",
  scaffold === "$  $",
  JSON.stringify(scaffold),
);

await c.type("x");
await new Promise((r) => setTimeout(r, 300));
const scaffoldTyped = await c.evaluate(cmText);
check(
  "光标在中间：接着敲字直接得到 `$ x $`",
  scaffoldTyped === "$ x $",
  JSON.stringify(scaffoldTyped),
);

// 光标移开（End 之后还要换行：光标停在公式末端时算"碰到公式"，按设计仍展开源码）看渲染
await c.key("End", { code: "End", keyCode: 35 });
await c.key("Enter", { code: "Enter", keyCode: 13 });
await new Promise((r) => setTimeout(r, 900));
const scaffoldRender = await c.evaluate(`(() => {
  const raw = window.__browserDevLastMath;
  return {
    blocks: document.querySelectorAll(".cm-math-block").length,
    inline: document.querySelectorAll(".cm-math-widget").length,
    lastMath: raw ? { body: raw.body, display: raw.display } : null,
  };
})()`);
check(
  "脚手架补出来的是**行间**公式（渲染成块级 widget，桩收到 display:true）",
  scaffoldRender.blocks === 1 &&
    scaffoldRender.inline === 0 &&
    scaffoldRender.lastMath?.display === true,
  JSON.stringify(scaffoldRender),
);
await c.screenshot(SHOT("wysiwyg-31-autopair-display"));

// ② 行内：同行还有别的字
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("前文 ");
await c.type("$");
await c.type("y");
await new Promise((r) => setTimeout(r, 400));
const inlineTyped = await c.evaluate(cmText);
check(
  "行内有别的字时补的是行内配对，敲字得到 `前文 $y$`",
  inlineTyped === "前文 $y$",
  JSON.stringify(inlineTyped),
);

// ③ 连按两下 `$`：右侧已有闭合符 → 跳过，不插垃圾
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("$");
await new Promise((r) => setTimeout(r, 300));
const beforeSecond = await c.evaluate(cmText);
await c.type("$");
await new Promise((r) => setTimeout(r, 300));
const afterSecond = await c.evaluate(cmText);
check(
  "连按两下 $ 只得到一对（第二下是跳过闭合符，不产生 `$ $|$  $`）",
  beforeSecond === "$  $" && afterSecond === beforeSecond,
  `${JSON.stringify(beforeSecond)} → ${JSON.stringify(afterSecond)}`,
);

// ④ 退格：空配对一次删干净（先把光标放回配对中间：清空重来，否则上一拍的"跳过"把光标留在闭合符之后）
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("$");
await new Promise((r) => setTimeout(r, 300));
const beforePairDelete = await c.evaluate(cmText);
check(
  "重来一次仍是 `$  $`（脚手架与光标位置稳定）",
  beforePairDelete === "$  $",
  JSON.stringify(beforePairDelete),
);
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 300));
const afterBackspace = await c.evaluate(cmText);
check(
  "在空配对里退格一次就整对删掉（不留 `$ $`）",
  afterBackspace.trim() === "",
  JSON.stringify(afterBackspace),
);

// ⑤ 代码区不配对（`#let s = 1` 末尾还在写代码）
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("#let s = 1");
await c.type("$");
await new Promise((r) => setTimeout(r, 400));
const codeCase = await c.evaluate(cmText);
check("代码区里不配对（只插入一个 `$`）", codeCase === "#let s = 1$", JSON.stringify(codeCase));

// ⑥ **公式内部但右侧就是闭合符 → 跨过去，不再插一个**（用户 2026-09-14 报的 bug：「依次按按键
// $ 1 $ 后会得到 $1$$」）。配对是 `$|$` 起手，敲完 `1` 是 `$1|$` —— 那时光标在公式**内部**，而
// "公式内部不配对"若排在"右侧已有 `$`"之前就会原样再插一个 `$`，得到永远不闭合的 `$1$$`。
// 手打序列必须是**三次独立的 `$` 输入**：`c.type` 走 Input.insertText，整串插进去不会触发配对
// （这正是本组前面几条都分开敲的原因）。
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("前文 ");
await c.type("$");
await c.type("1");
await c.type("$");
await new Promise((r) => setTimeout(r, 400));
const inlineThirdDollar = await c.evaluate(cmText);
check(
  "行内公式里按第三个 `$` 跨过已有闭合符（不会得到 `前文 $1$$`）",
  inlineThirdDollar === "前文 $1$",
  JSON.stringify(inlineThirdDollar),
);

// 行间脚手架同理：`$ 1 $` 里再按 `$` → 跨过闭合符，不得到 `$ 1$ $`
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type("$");
await c.type("1");
await c.type("$");
await new Promise((r) => setTimeout(r, 400));
const blockThirdDollar = await c.evaluate(cmText);
check(
  "行间公式里按第三个 `$` 同样跨过闭合符（不会得到 `$ 1$ $`）",
  blockThirdDollar === "$ 1 $",
  JSON.stringify(blockThirdDollar),
);

// 收尾：清回空文档
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 200));

// ---------------------------------------------------------------------------
// 第 32 组：状态栏最左的「错误 / 警告」计数（用户要求：「加入警告，用类似 vscode 的图标
// （三角形内部有感叹号）…另外，把这两个东西都移到最左边」，并随后给了参照图：⊗ 0 ⚠ 0）
// 形态：状态栏最左是一个 badge-group，里面**错误在左、警告在右**（与 VS Code 状态栏同序），
// 两者都**常驻显示**（无问题是 0，与 VS Code 的状态栏一致）；警告图标是内联 SVG 三角形+感叹号
// （currentColor 上色；不用 ⚠ 字形——跨字体渲染差异大、且常常是彩色 emoji 字体），
// 错误仍是 CSS 圆环 + ✕。
// 布局注意：状态文字靠 `:first-child` 定位的老写法会失效（它不再是第一个子元素），已改成
// `.status-text` 类名匹配，`:not(.spacer):not(.status-text)` 两条都不能漏。
// ---------------------------------------------------------------------------
console.log("32) 状态栏左侧的警告/错误计数");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

const barProbe = `(() => {
  const bar = document.querySelector(".statusbar");
  const warn = bar.querySelector(".warning-badge");
  const err = bar.querySelector(".error-badge:not(.warning-badge)");
  const group = bar.querySelector(".badge-group");
  const first = bar.children[0];
  const wr = warn?.getBoundingClientRect();
  const er = err?.getBoundingClientRect();
  const br = bar.getBoundingClientRect();
  const statusEl = bar.querySelector(".status-text");
  return {
    order: Array.from(bar.children).map((e) => e.className.split(" ")[0]).join(" > "),
    firstIsBadgeGroup: first === group,
    warnX: wr ? Math.round(wr.left) : null,
    errX: er ? Math.round(er.left) : null,
    warnCount: warn?.querySelector(".error-count")?.textContent?.trim() ?? null,
    errCount: err?.querySelector(".error-count")?.textContent?.trim() ?? null,
    warnSvgPaths: warn ? warn.querySelectorAll("svg path, svg circle").length : 0,
    warnIconText: (warn?.querySelector(".warning-icon")?.textContent ?? "").length,
    errIconTag: err?.querySelector(".error-icon")?.tagName?.toLowerCase() ?? null,
    errSvgShapes: err ? err.querySelectorAll(".error-icon circle, .error-icon path").length : 0,
    errIconText: (err?.querySelector(".error-icon")?.textContent ?? "").trim(),
    iconSizes: (() => {
      const g = (sel) => {
        const el = bar.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      };
      return { err: g(".error-icon"), warn: g(".warning-icon") };
    })(),
    statusTextLeft: statusEl ? Math.round(statusEl.getBoundingClientRect().left) : null,
    barLeft: Math.round(br.left),
    padLeft: Math.round(parseFloat(getComputedStyle(bar).paddingLeft)),
    height: Math.round(br.height),
  };
})()`;

const bar0 = await c.evaluate(barProbe);
check(
  "状态栏最左是「错误 + 警告」计数组（排在状态文字之前）",
  bar0.firstIsBadgeGroup === true,
  JSON.stringify(bar0.order),
);
check(
  "两个计数常驻显示（无问题时都是 0，与 VS Code 一致）",
  bar0.warnCount === "0" && bar0.errCount === "0",
  `警告 ${bar0.warnCount} / 错误 ${bar0.errCount}`,
);
check(
  "错误在警告左边（⊗ 0 ⚠ 0，与参照图一致），且错误紧贴状态栏左缘（移到最左边）",
  bar0.warnX !== null &&
    bar0.errX !== null &&
    bar0.errX < bar0.warnX &&
    bar0.errX - bar0.barLeft <= bar0.padLeft + 1,
  `错误 x=${bar0.errX}，警告 x=${bar0.warnX}，状态栏左缘 ${bar0.barLeft}（内边距 ${bar0.padLeft}）`,
);
check(
  "警告图标是 SVG 三角形+感叹号（不是 ⚠ 字形：有描边路径且无文字内容）",
  bar0.warnSvgPaths >= 2 && bar0.warnIconText === 0,
  `图形元素数 ${bar0.warnSvgPaths}，图标文字长度 ${bar0.warnIconText}`,
);
check(
  "错误图标也是内联 SVG（圆圈 + 叉，不再是 CSS 圆环 + ✕ 字形）",
  bar0.errIconTag === "svg" && bar0.errSvgShapes >= 2 && bar0.errIconText === "",
  `标签 ${bar0.errIconTag}，图形元素数 ${bar0.errSvgShapes}，文字 ${JSON.stringify(bar0.errIconText)}`,
);
check(
  "两个图标同尺寸（14×14，与参照图的「图标高 ≈ 数字高 × 1.6」一致）",
  JSON.stringify(bar0.iconSizes.err) === "[14,14]" &&
    JSON.stringify(bar0.iconSizes.warn) === "[14,14]",
  JSON.stringify(bar0.iconSizes),
);
check("状态栏仍是一行、没被顶高", bar0.height <= 30, `${bar0.height}px`);

// 有警告时：计数 > 0、徽标变黄可点、点开后浮层从最左边向右展开（不越出窗口）
await c.click(400, 300);
await c.type('#set text(font: "微软雅黑")\n中文测试');
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
const barWarn = await c.evaluate(barProbe);
check(
  "出现警告后该徽标计数 > 0（且仍排在错误右边）",
  barWarn.warnCount !== "0" && Number(barWarn.warnCount) > 0 && barWarn.errX < barWarn.warnX,
  `警告 ${barWarn.warnCount}（x=${barWarn.warnX}），错误 ${barWarn.errCount}（x=${barWarn.errX}）`,
);
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(`!!document.querySelector(".error-popover .error-item-msg")`, { timeout: 5000 });
const warnPopover = await c.evaluate(`(() => {
  const p = document.querySelector(".error-popover");
  const r = p.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    right: Math.round(r.right),
    win: window.innerWidth,
    text: p.innerText.split("\\n").join(" ").slice(0, 60),
  };
})()`);
check(
  "警告浮层从最左边的徽标向右展开、不越出窗口",
  warnPopover.left >= 0 && warnPopover.right <= warnPopover.win + 1,
  JSON.stringify(warnPopover),
);
await c.screenshot(SHOT("wysiwyg-32-statusbar-badges"));

// 收尾：关掉浮层、清回空文档（警告消失 → 徽标回到 0）
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 400));

// ---------------------------------------------------------------------------
// 第 33 组：切换模式不改变光标位置（用户要求：「切换模式不应该改变光标位置」）
// 根因：写作模式 ↔ 源码模式换的是**整套布局**（单栏 16px / 行距 1.9 ↔ 双栏 14px 等宽 +
// 折行开关 + 编辑区只剩一半宽），而 CodeMirror 的滚动锚点是"最上面那条可见行"、不是光标 ——
// 实测 40 行文档、光标在第 30 行（视口 y=415）时切一次模式，`scroller.scrollTop` 归零，
// 切回写作模式后光标在 **y=920**（视口只有 800）：光标跑到屏幕外 = "位置变了"。
// 不是折行重配导致的：源码模式下单独按 Alt+Z 切换折行，scrollTop 2920 纹丝不动。
// 修法：切换前记下光标在视口里的高度（toggleViewMode 调 Editor.captureCaretAnchor），
// 布局换完后把滚动调回去（被文档端点夹住时也仍在视口内）。
// 注意量法：CM6 只渲染视口内的行，DOM 里的行序号**不是**文档行号 —— 逻辑位置要看
// 源码模式状态栏的「行/列」（写作模式不显示行列），视觉位置看光标相对滚动容器的 y。
// ---------------------------------------------------------------------------
console.log("33) 切换模式不改变光标位置");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.type(Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行内容 abcdefghij`).join("\n"));
await new Promise((r) => setTimeout(r, 700));

/** 光标相对滚动容器的高度 + 是否在视口内（两种模式都能量） */
const caretProbe = `(() => {
  const sc = document.querySelector(".cm-scroller");
  const sel = document.getSelection();
  const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
  const scRect = sc.getBoundingClientRect();
  return {
    mode: document.querySelector(".statusbar .mode-tag")?.textContent ?? "",
    offset: rect ? Math.round(rect.top - scRect.top) : null,
    visible: rect ? rect.top >= scRect.top - 1 && rect.bottom <= scRect.bottom + 1 : false,
    status: document.querySelector(".status-text")?.textContent ?? "",
    clientHeight: Math.round(sc.clientHeight),
    scrollTop: Math.round(sc.scrollTop),
    maxScroll: Math.round(sc.scrollHeight - sc.clientHeight),
  };
})()`;
const cursorRow = `(() => {
  const m = (document.querySelector(".statusbar").innerText.match(/行\\s*(\\d+)/) || [])[1];
  return m ? Number(m) : null;
})()`;

// 先滚到文档中段，再在视口中部点一下：这样光标的屏幕高度上下都有调节余地，测得出"保不保持"
const center = await c.evaluate(`(() => {
  const r = document.querySelector(".editor-pane").getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
// 滚到**文档中段**再点视口中部：光标上方下方都要有足够内容，否则"保持屏幕高度"在几何上
// 不可能（实测踩过：锚点落在文档末尾附近时，源码模式内容更短，滚到底也抬不回原来的高度 ——
// 那种情况只能保证"仍在视口内"，即下面第一条断言）。
// 滚动用直接赋 scrollTop 而不是滚轮：无头环境里 CDP 滚轮的加速不可控（实测 6 格就冲到文末）。
const scrolled = await c.evaluate(`(() => {
  const sc = document.querySelector(".cm-scroller");
  sc.scrollTop = 900;
  return Math.round(sc.scrollTop);
})()`);
await new Promise((r) => setTimeout(r, 400));
await c.click(center.x, 420);
await new Promise((r) => setTimeout(r, 400));
const caretWrite = await c.evaluate(caretProbe);
check(
  "起手：写作模式里光标可见、位于视口中部（上下都有滚动余地）",
  caretWrite.visible === true &&
    caretWrite.offset > 100 &&
    caretWrite.scrollTop > 100 &&
    caretWrite.scrollTop < caretWrite.maxScroll - 200,
  `scrollTop=${scrolled}，${JSON.stringify(caretWrite)}`,
);

// ① 写作 → 源码
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
const caretSource = await c.evaluate(caretProbe);
const rowSource = await c.evaluate(cursorRow);
check(
  "切到源码模式后光标仍在视口内（修前会被甩到屏幕外）",
  caretSource.visible === true,
  `${JSON.stringify(caretSource)}（切换前 y=${caretWrite.offset}）`,
);
check(
  "切到源码模式后光标的屏幕高度基本不变（±40px 内）",
  caretSource.offset !== null && Math.abs(caretSource.offset - caretWrite.offset) <= 40,
  `y ${caretWrite.offset} → ${caretSource.offset}`,
);

// ② 源码 → 写作
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
const caretBackWrite = await c.evaluate(caretProbe);
check(
  "切回写作模式后光标仍在视口内、屏幕高度也回到原处",
  caretBackWrite.visible === true &&
    caretBackWrite.offset !== null &&
    Math.abs(caretBackWrite.offset - caretSource.offset) <= 40,
  `y ${caretSource.offset} → ${caretBackWrite.offset}`,
);

// ③ 再回源码：逻辑位置（状态栏的「行」）必须与第一次切过去时一致
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
const rowBack = await c.evaluate(cursorRow);
check(
  "来回一趟后文档内的逻辑位置没变（状态栏行号一致）",
  rowBack !== null && rowSource !== null && rowBack === rowSource,
  `行 ${rowSource} → ${rowBack}`,
);
await c.screenshot(SHOT("wysiwyg-33-mode-switch-caret"));

// ---------------------------------------------------------------------------
// 第 34 组：**启动时自己发现新版本；但用户说过不更新之后就不再自动弹窗**
// 背景（2026-09-14，三轮）：用户装了 0.7.6、0.7.7 发布后打开应用却什么都没提示，原话
// 「打开的时候没有自动更新，但是检查的时候能检查到」。根因不是网络也不是签名（那条链路
// 当时是通的：清单 200、安装包 200、签名与配置里的公钥匹配），而是启动检查被一道
// "距上次检查满 6 小时才查"的节流拦掉了 —— 而手动检查也会刷新那个时间戳，于是
// 越手动查、启动越不查。改成"每次启动都查"之后，用户又补了后半句：
// **「算了，不更新就再也别跳出来，直到点了检查更新」**（中途那版"点稍后 → 静默 6 小时"被否掉）。
//
// 现在锁住的规则：点过「稍后」→ 自动检查照做（状态栏仍留「可更新到 vX」入口）但**不再弹窗、
// 也不动状态文字**；手动检查（或点状态栏入口、或点「下载并安装」）会清掉这个标记，
// 弹窗随即恢复。种子把 lastUpdateCheckAt 种成"几十秒前"是为了复现当年被节流拦掉的那个状态。
// 桩：`&fakeupdate=1` 让 plugin:updater|check 返回一个假的可用更新（见 browser-dev-stub.ts），
// `window.__browserDevUpdaterChecks` 记的是检查次数（据此区分"没检查"和"检查了但不弹窗"）。
// ---------------------------------------------------------------------------
console.log("34) 启动自动检查 + 「选择不更新」之后不再自动弹窗");

/** 种一份存档再重载页面（跟用户"上次刚检查过、现在重新打开应用"的处境一致） */
const seedState = async (state) => {
  await c.evaluate(`localStorage.clear()`);
  await c.goto(DEV_URL); // 先落到应用源上，localStorage 才可写（about:blank 上会抛 SecurityError）
  await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
  await c.evaluate(
    `localStorage.setItem("typst-pad:state", ${JSON.stringify(JSON.stringify(state))})`,
  );
};

await seedState({ autoCheckUpdates: true, lastUpdateCheckAt: Date.now() });
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
// 种进去的"刚刚检查过"必须真的生效，否则这一组就退化成"旧存档所以当然会查"
const seeded = await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  return { at: typeof raw.lastUpdateCheckAt === "number" ? raw.lastUpdateCheckAt : null, now: Date.now() };
})()`);
check(
  "起手：存档里「上次检查时间」就是刚刚（复现被节流拦掉的那个状态）",
  seeded.at !== null && seeded.now - seeded.at < 60_000,
  JSON.stringify(seeded),
);

// 先在编辑区落一个焦点：更新窗是"自己弹出来的"，绝不能把焦点从写作位置上抢走。
// （冷启动的页面本来就没有编辑区焦点，所以这一步必须先做，否则这条断言测的是空气。）
const editorRect = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-content").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(60, r.height / 2) };
})()`);
await c.click(editorRect.x, editorRect.y);
await new Promise((r) => setTimeout(r, 200));
const focusBeforeAutoCheck = await c.evaluate(
  `(!!document.activeElement && !!document.activeElement.closest(".cm-content")) + "|" + !!document.querySelector(".update-modal")`,
);
check(
  "起手：焦点在编辑区里，且此刻还没有更新弹窗（自动检查是延迟发起的）",
  focusBeforeAutoCheck === "true|false",
  focusBeforeAutoCheck,
);

// 关键断言：**不做任何操作**，等它自己弹出来
let autoDialogAppeared = true;
try {
  await c.waitFor(`!!document.querySelector(".update-modal")`, { timeout: 15000 });
} catch {
  autoDialogAppeared = false;
}
const autoUpdate = await c.evaluate(`({
  title: document.querySelector(".update-modal .modal-title")?.textContent?.trim() || "",
  version: document.querySelector(".update-modal .modal-text")?.textContent?.trim() || "",
  status: document.querySelector(".statusbar").innerText,
  notice: !!document.querySelector(".status-update"),
  focusInEditor: !!document.activeElement && !!document.activeElement.closest(".cm-content"),
})`);
check(
  "刚检查过也要在启动时自动再查一次：弹窗自己出现（修前被 6 小时节流拦掉，永远不出现）",
  autoDialogAppeared && autoUpdate.title.includes("发现新版本"),
  `appeared=${autoDialogAppeared} ${JSON.stringify(autoUpdate)}`,
);
check(
  "自动检查的结果和手动一样落到状态栏（状态文字 + 可点开的入口）",
  autoUpdate.status.includes("发现新版本") && autoUpdate.notice,
  JSON.stringify(autoUpdate.status),
);
check(
  "自动弹出的更新窗不抢编辑区焦点（用户要求：不改变当前编辑位置）",
  autoUpdate.focusInEditor,
  JSON.stringify(autoUpdate),
);
await c.screenshot(SHOT("wysiwyg-34-startup-auto-check"));

// ---- 「选择不更新 = 再也别自动跳出来，直到手动检查」（用户 2026-09-14 的最终要求）----
// 点「稍后」：关窗 + 写"别烦我"标记 + 状态栏明说以后不再自动弹（但可以手动查）
await c.evaluate(
  `Array.from(document.querySelectorAll(".update-modal .modal-btn")).find(b => (b.textContent || "").includes("稍后")).click()`,
);
await new Promise((r) => setTimeout(r, 400));
const afterDismiss = await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  return {
    status: document.querySelector(".statusbar").innerText,
    dismissedAt: typeof raw.updateDismissedAt === "number" ? raw.updateDismissedAt : null,
    now: Date.now(),
    dialog: !!document.querySelector(".update-modal"),
  };
})()`);
check(
  "点「稍后」→ 关窗，且状态栏说明以后不再自动提示（仍可手动检查）",
  !afterDismiss.dialog && afterDismiss.status.includes("已停止自动提示更新"),
  JSON.stringify(afterDismiss),
);
check(
  "点「稍后」写进存档（updateDismissedAt，重开应用仍然有效）",
  afterDismiss.dismissedAt !== null && afterDismiss.now - afterDismiss.dismissedAt < 60_000,
  JSON.stringify(afterDismiss),
);

// 重新打开应用（存档照旧）：**更新窗不许再自己跳出来**
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
// 自动检查是 mount 后约 4 秒才发的，等 6.5 秒再断言（不能只等 1 秒就宣布"没弹"）
await new Promise((r) => setTimeout(r, 6500));
const afterDismissReload = await c.evaluate(`({
  dialog: !!document.querySelector(".update-modal"),
  checks: window.__browserDevUpdaterChecks || 0,
  notice: !!document.querySelector(".status-update"),
})`);
check(
  "说了不更新之后再开应用：更新窗不再自己弹出来（「再也别跳出来」）",
  !afterDismissReload.dialog,
  JSON.stringify(afterDismissReload),
);
check(
  "但仍照常悄悄检查（桩收到 check），只在状态栏留一个「可更新到 vX」入口",
  afterDismissReload.checks >= 1 && afterDismissReload.notice,
  JSON.stringify(afterDismissReload),
);

// ---- 「直到点了检查更新」：手动检查永远弹窗，并清掉"别烦我"标记 ----
await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("检查更新")`, { timeout: 5000 });
await clickMenuItem("检查更新");
await c.waitFor(`!!document.querySelector(".update-modal")`, { timeout: 10000 });
// 存档写入是 300ms 防抖（`schedulePersist`）：读 localStorage **之前必须等它落盘**，
// 否则读到的还是上一条状态（第一版就栽在这上面——断言"标记被清掉"时读到的仍是旧值）。
await new Promise((r) => setTimeout(r, 600));
const afterManual = await c.evaluate(`(() => {
  const raw = JSON.parse(localStorage.getItem("typst-pad:state") || "{}");
  return {
    title: document.querySelector(".update-modal .modal-title")?.textContent?.trim() || "",
    dismissedAt: raw.updateDismissedAt ?? null,
  };
})()`);
check(
  "手动点「检查更新…」→ 更新窗照常弹出来（即使刚说过不更新）",
  afterManual.title.includes("发现新版本"),
  JSON.stringify(afterManual),
);
check(
  "手动检查清掉「别再自动弹窗」标记（这就是「直到点了检查更新」）",
  afterManual.dismissedAt === null,
  JSON.stringify(afterManual),
);

// 标记清掉之后再开一次：自动弹窗恢复 —— 闭合"直到点了检查更新"这个承诺
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
let promptRestored = true;
try {
  await c.waitFor(`!!document.querySelector(".update-modal")`, { timeout: 15000 });
} catch {
  promptRestored = false;
}
check("标记清掉后自动弹窗恢复（再开应用又会自己弹）", promptRestored, `appeared=${promptRestored}`);
// 关掉弹窗（顺便把状态复位）。弹窗可能没出现（上面那条挂了），所以用 `?.` 兜一下别把整轮打崩
await c.evaluate(
  `Array.from(document.querySelectorAll(".update-modal .modal-btn")).find(b => (b.textContent || "").includes("稍后"))?.click()`,
);

// 设置里的开关仍然是这道门：关掉它，启动就一次都不该查（桩会记账）
await seedState({ autoCheckUpdates: false, lastUpdateCheckAt: Date.now() });
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
// 自动检查是启动后约 4 秒才发的，等够 8 秒再断言——不能只等 1 秒就宣布"没检查"。
// **故意不把计数器清零**：清零会把"其实查过一次"抹掉，这条断言就变成了假绿。
await new Promise((r) => setTimeout(r, 8000));
const disabled = await c.evaluate(`({
  checks: window.__browserDevUpdaterChecks || 0,
  dialog: !!document.querySelector(".update-modal"),
  status: document.querySelector(".statusbar").innerText,
})`);
check(
  "关掉「启动时自动检查更新」后启动一次都不查（开关仍然是这道门）",
  disabled.checks === 0 && !disabled.dialog,
  JSON.stringify(disabled),
);

// ---------------------------------------------------------------------------
// 第 35 组：Esc 退出设置界面 + Ctrl+Shift+N 新建窗口（用户 2026-09-14 要求「需要按 Esc 退出设置
// 界面 和 Ctrl + Shift + N 新建窗口」）
//
// 背景（别把这条当"新功能"读）：**Ctrl+Shift+N 从 0.7.0 起就彻底失效了**。仿 Typora 两套 UI 那一版
// 引入了「Shift 组合的格式表」，它对**任何**带 Shift 的组合都无条件 return，而新建窗口的判定写在
// 它后面 —— 那条路再也没走到过。现在按键路由抽到 app-keys.decideAppKey（纯函数，单测锁死顺序），
// 这里锁**接线**：手势确实走到了"创建窗口"（桩记录 create_webview_window 的入参）、且没被格式
// 命令吃掉、也没和 Ctrl+N（菜单「新建」）互相干扰。
//
// 真实多窗口（窗口本身、窗口之间的存档与 open-file 交接）只能在桌面版验证：
// 浏览器里没有真的多窗口，桩只能证明"请求发出去了、参数对"。
// ---------------------------------------------------------------------------
console.log("35) Esc 退出设置界面 + Ctrl+Shift+N 新建窗口");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);
await c.selectAll();
await c.type("= 窗口测试");
await new Promise((r) => setTimeout(r, 600)); // 等 300ms 防抖把内容落盘

/**
 * 文档内容的判据走**存档**而不是编辑器 innerText：写作模式会把标记/公式替换成 widget，
 * innerText 看到的是渲染结果，判断"按键有没有改动文档"会被渲染差异带偏。
 */
const savedContent = `JSON.parse(localStorage.getItem("typst-pad:state") || "{}").content ?? ""`;
const contentBefore = await c.evaluate(savedContent);

// —— Esc 退出设置 ——
await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
// 在弹窗里改一笔（关掉「启动时恢复上次内容」的勾）：Esc 之后这笔草稿必须**不生效**
await c.evaluate(`(() => {
  const row = Array.from(document.querySelectorAll(".settings-modal .settings-row"))
    .find(e => (e.textContent || "").includes("启动时恢复上次内容"));
  row.querySelector("input").click();
})()`);
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 400));
const afterEsc = await c.evaluate(`({
  modal: !!document.querySelector(".settings-modal"),
  restore: JSON.parse(localStorage.getItem("typst-pad:state") || "{}").restoreSession ?? null,
})`);
check("按 Esc 关掉设置弹窗", !afterEsc.modal, JSON.stringify(afterEsc));
check(
  "Esc 等于弹窗里的「关闭」（放弃草稿）：勾掉的开关没有生效",
  afterEsc.restore === true,
  JSON.stringify(afterEsc),
);
await c.screenshot(SHOT("wysiwyg-35-esc-settings"));

// 再打开一次：那一勾应该还是原样（证明 Esc 没有偷偷保存草稿）
await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
const reopened = await c.evaluate(`(() => {
  const row = Array.from(document.querySelectorAll(".settings-modal .settings-row"))
    .find(e => (e.textContent || "").includes("启动时恢复上次内容"));
  return { checked: row.querySelector("input").checked };
})()`);
check(
  "重新打开设置：那一勾回到原状（Esc 没有偷偷保存）",
  reopened.checked === true,
  JSON.stringify(reopened),
);
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 300));

// —— Ctrl+Shift+N 新建窗口 ——
const requestsBefore = await c.evaluate(`(window.__browserDevWindowRequests || []).length`);
await c.key("N", { code: "KeyN", keyCode: 78, modifiers: 10 }); // Ctrl(2)+Shift(8)
await new Promise((r) => setTimeout(r, 500));
const created = await c.evaluate(`(() => {
  const reqs = window.__browserDevWindowRequests || [];
  return {
    requests: reqs.length,
    last: reqs[reqs.length - 1] || null,
  };
})()`);
check(
  "Ctrl+Shift+N 真的走到了「创建窗口」（桩收到 create_webview_window）",
  created.requests === requestsBefore + 1,
  JSON.stringify(created),
);
check(
  "新窗口参数：label 以 editor- 开头（capabilities 覆盖 editor-*）、url 指向应用首页、标题是未命名",
  /^editor-\d+$/.test(String(created.last?.label)) &&
    created.last?.url === "/" &&
    String(created.last?.title).includes("未命名.typ"),
  JSON.stringify(created.last),
);
check(
  "Ctrl+Shift+N 没被 Shift 格式表吃掉：文档内容一字未改",
  (await c.evaluate(savedContent)) === contentBefore,
  JSON.stringify({ before: contentBefore, after: await c.evaluate(savedContent) }),
);

// 反向：Ctrl+N（无 Shift）仍然是菜单「新建」——两套手势互不干扰
//
// ⚠️ 2026-09-16 起「新建」在有未保存内容时会**先确认**（见第 38 组那道防护），
// 而这里只验"手势路由对不对"，所以先把内容清空：空文档没有可丢的东西，不弹确认，
// 按下去必然直接新建。守卫本身的行为在第 38 组验。
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 300));
await c.key("N", { code: "KeyN", keyCode: 78, modifiers: 2 }); // 只按 Ctrl
await new Promise((r) => setTimeout(r, 600));
const afterCtrlN = await c.evaluate(`({
  requests: (window.__browserDevWindowRequests || []).length,
  content: ${savedContent},
})`);
check(
  "Ctrl+N（无 Shift）仍是「新建」：文档清空、也没有多开窗口",
  afterCtrlN.requests === created.requests && afterCtrlN.content === "",
  JSON.stringify(afterCtrlN),
);

// Shift 格式表本身没被改坏：Ctrl+Shift+M 还是公式块
await c.click(400, 300);
await c.type("= 格式表");
await new Promise((r) => setTimeout(r, 300));
await c.key("M", { code: "KeyM", keyCode: 77, modifiers: 10 }); // Ctrl+Shift+M
await new Promise((r) => setTimeout(r, 600));
const afterMath = await c.evaluate(savedContent);
check(
  "Shift 格式表仍然完好：Ctrl+Shift+M 照旧插入公式块定界符",
  afterMath.includes("$"),
  JSON.stringify(afterMath.slice(0, 80)),
);

// —— Esc 关更新弹窗：只收起来，不许替用户点「稍后」——
// 「稍后」= 以后再也不自动弹更新窗（用户 2026-09-14 明确要的），一个 Esc 不该有这种后果。
await c.goto(`${DEV_URL}&fakeupdate=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
let updatePrompt = true;
try {
  await c.waitFor(`!!document.querySelector(".update-modal")`, { timeout: 15000 });
} catch {
  updatePrompt = false;
}
check("（前置）假更新弹窗自己弹出来了", updatePrompt, `appeared=${updatePrompt}`);
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 400));
const afterEscUpdate = await c.evaluate(`({
  dialog: !!document.querySelector(".update-modal"),
  dismissedAt: JSON.parse(localStorage.getItem("typst-pad:state") || "{}").updateDismissedAt ?? null,
})`);
check("Esc 收起了更新弹窗", !afterEscUpdate.dialog, JSON.stringify(afterEscUpdate));
check(
  "Esc 没有替你点「稍后」：存档里 updateDismissedAt 仍为 null（下次启动照样会提示）",
  afterEscUpdate.dismissedAt === null,
  JSON.stringify(afterEscUpdate),
);

console.log("36) 回车换行继承上一行缩进 + Tab 四格缩进（用户要求）");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);

/** 清空重来：全选 + 退格，再输入新内容（每小条独立，避免互相污染） */
async function retype(text, arrowsLeft = 0) {
  await c.selectAll();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await new Promise((r) => setTimeout(r, 150));
  await c.type(text);
  for (let i = 0; i < arrowsLeft; i++) await c.key("ArrowLeft", { code: "ArrowLeft", keyCode: 37 });
  // 等到落盘（防抖 300ms）：后面有的断言是"回车**之前**的存档"，读早了会读到上一条的残留
  await new Promise((r) => setTimeout(r, 500));
}
/** 真按回车（走 keymap，不是 insertText），并等落盘（防抖 300ms） */
async function enter(times = 1) {
  for (let i = 0; i < times; i++) await c.key("Enter", { code: "Enter", keyCode: 13 });
  await new Promise((r) => setTimeout(r, 600));
}

// ① 两空格缩进：行尾回车，新行与上一行缩进一致
await retype("前文\n  缩进行");
await enter();
check(
  "缩进行行尾回车 → 新行缩进与上一行一样（`  `）",
  (await c.evaluate(savedContent)) === "前文\n  缩进行\n\n  ",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ② 四空格也照抄（CM 默认那条时灵时不灵：两空格能抄到、四空格抄不到）
await retype("前文\n    深缩进");
await enter();
check(
  "四空格缩进同样照抄（不再出现「两空格行能继承、四空格行不能」的随机感）",
  (await c.evaluate(savedContent)) === "前文\n    深缩进\n\n    ",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ③ 光标停在正文中间：拆出来的下半行也带上同一缩进
await retype("  abcdef", 3);
await enter();
check(
  "行中间回车：下半行对齐整行缩进（`  abc` / `  def`）",
  (await c.evaluate(savedContent)) === "  abc\n\n  def",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ④ 纯空白行再按回车：清掉残留空白，不留一串"带缩进的空行"
await retype("前文\n  缩进行");
await enter(2);
check(
  "在「带缩进的空行」上再按回车：残留空白被清掉（连按回车不堆空缩进行）",
  (await c.evaluate(savedContent)) === "前文\n  缩进行\n\n\n",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ⑤ 没有缩进 → 普通换行，不多插空格
await retype("普通文本");
await enter();
check(
  "无缩进行回车就是普通换行（不凭空多出空格）",
  (await c.evaluate(savedContent)) === "普通文本\n\n",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ⑥ Tab 缩进也算缩进
await retype("前文\n\tTab 缩进");
await enter();
check(
  "制表符缩进照抄（`\\t` 不算成空格）",
  (await c.evaluate(savedContent)) === "前文\n\tTab 缩进\n\n\t",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ⑦ 代码围栏内部：继续写同一层代码
await retype("```\n  let a = 1");
await enter();
check(
  "围栏代码块内部回车也继承缩进（接着写同层代码）",
  (await c.evaluate(savedContent)) === "```\n  let a = 1\n  ",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ⑧ Tab 一档缩进 = 4 个空格（用户要求「Tab 应该是四格缩进」）
await retype("第一行");
await c.key("Tab", { code: "Tab", keyCode: 9 });
await new Promise((r) => setTimeout(r, 500));
check(
  "Tab 一档缩进 = 4 个空格（不是 CM 默认的 2 格）",
  (await c.evaluate(savedContent)) === "    第一行",
  JSON.stringify(await c.evaluate(savedContent)),
);
// ⑨ 紧接着回车：新行照抄 Tab 出来的那 4 格（两处宽度是同一套）
await c.key("End", { code: "End", keyCode: 35 });
await enter();
check(
  "Tab 缩进后的回车照抄同一宽度（4 格）",
  (await c.evaluate(savedContent)) === "    第一行\n\n    ",
  JSON.stringify(await c.evaluate(savedContent)),
);
// ⑩ Shift+Tab 反缩进一层：把光标放回第一行，它整好少掉 4 格（第二行的 4 格不动）
await c.key("ArrowUp", { code: "ArrowUp", keyCode: 38 });
await c.key("Home", { code: "Home", keyCode: 36 });
await c.key("Tab", { code: "Tab", keyCode: 9, modifiers: 8 });
await new Promise((r) => setTimeout(r, 500));
check(
  "Shift+Tab 反缩进一层（4 格 → 行首）",
  (await c.evaluate(savedContent)) === "第一行\n\n    ",
  JSON.stringify(await c.evaluate(savedContent)),
);

// ⑪ 这次换行要能被 Ctrl+Z 整体撤销（事务仍是可撤销的 input）
await retype("  缩进");
const indentBeforeUndo = await c.evaluate(savedContent);
await enter();
await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 }); // Ctrl+Z
await new Promise((r) => setTimeout(r, 600));
const indentAfterUndo = await c.evaluate(savedContent);
check(
  "回车+缩进这一笔可以一次 Ctrl+Z 撤销（撤销历史没被打断）",
  indentBeforeUndo === "  缩进" && indentAfterUndo === indentBeforeUndo,
  `${JSON.stringify(indentBeforeUndo)} → ${JSON.stringify(indentAfterUndo)}`,
);
await c.screenshot(SHOT("wysiwyg-36-auto-indent"));

console.log("37) 帮助 → 关于");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

const aboutProbe = `(() => {
  const modal = document.querySelector(".about-modal");
  return {
    open: !!modal,
    text: modal ? modal.innerText : "",
    buttons: modal ? Array.from(modal.querySelectorAll(".modal-actions .modal-close")).map((e) => e.textContent.trim()) : [],
    openUrls: window.__browserDevOpenUrls ?? [],
  };
})()`;

await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("关于 Typst-pad")`, { timeout: 5000 });
await clickMenuItem("关于 Typst-pad");
await new Promise((r) => setTimeout(r, 400));
const about = await c.evaluate(aboutProbe);
check("菜单「帮助 → 关于 Typst-pad」能打开关于弹窗", about.open, JSON.stringify(about));
check(
  "关于弹窗里的版本号来自运行时（桩给的 0.0.0-browserdev，不是页面里写死的字符串）",
  about.text.includes("版本 0.0.0-browserdev"),
  JSON.stringify(about.text.slice(0, 120)),
);
// 描述必须覆盖**默认的写作模式**（旧文案只写「左编辑 / 右实时预览」，那是源代码模式的形态）
check(
  "描述改成了两套 UI 的实际形态（写作模式 + 源代码模式），不再只写「左编辑 / 右实时预览」",
  about.text.includes("写作模式") &&
    about.text.includes("源代码模式") &&
    !about.text.includes("左编辑") &&
    !about.text.includes("右实时预览"),
  JSON.stringify(about.text.slice(0, 200)),
);
check(
  "两个动作按钮都在（项目主页 / 关闭）",
  about.buttons.includes("项目主页") && about.buttons.includes("关闭"),
  JSON.stringify(about.buttons),
);

await c.screenshot(SHOT("wysiwyg-37-about")); // 截图留在弹窗打开时（关闭后截就只有主界面）

// 点「项目主页」：必须带着项目地址走到 opener 插件（权限 opener:default 的 allow-open-url）
await c.evaluate(`(() => {
  const el = Array.from(document.querySelectorAll(".about-modal .modal-actions .modal-close"))
    .find((e) => e.textContent.trim() === "项目主页");
  el.click();
})()`);
await new Promise((r) => setTimeout(r, 500));
const opened = await c.evaluate(aboutProbe);
check(
  "点「项目主页」→ opener 收到项目地址，弹窗收起",
  opened.openUrls.includes("https://github.com/Z3O1/Typst-pad") && !opened.open,
  JSON.stringify(opened),
);

// Esc 关关于弹窗（about 在 app-keys 的弹窗优先级表里）
await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("关于 Typst-pad")`, { timeout: 5000 });
await clickMenuItem("关于 Typst-pad");
await new Promise((r) => setTimeout(r, 400));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 400));
const afterEscAbout = await c.evaluate(aboutProbe);
check("Esc 关掉关于弹窗", !afterEscAbout.open, JSON.stringify(afterEscAbout));

// 第 38 组：**「编辑器会不会自己清空文件」的防护**
// （用户 2026-09-16 问「编辑器会清空文件吗？？」）
//
// 审计结论：全工程只有 `saveTypFile` 一个 `.typ` 写入口，它只挂在显式保存上（菜单/右键「保存」、
// Ctrl+S、关窗弹窗的「保存并关闭」），**没有自动保存、没有定时写盘**（页面里那几个 setTimeout
// 分别管预览重排、缩放复核、公式队列、更新检查与会话存档的 300ms 防抖——最后那个写的是
// localStorage，不是文件）。所以"应用自己把文件清空"这条路是堵住的，这一组把它钉死。
//
// 会丢内容/写空的只有两条，各配一道防护：
// ① 「新建」——它清空编辑器 + 置空 filePath + 清掉会话存档，所以先确认（`core/document-session.ts`
//    的 `confirmDiscard`，由 `createNew()` 调用；本组钉住）；
// ② 「空文档 + 已有文件 + 按保存」——唯一能把磁盘文件写成空的组合。**这道确认窗 2026-09-18 被
//    用户要求删掉了**（就是标题为「保存空文档」的那个原生对话框：「…的内容是空的（只有空白字符），
//    保存会把磁盘上的文件也清空。仍要保存吗？」），现在是**直接写空、不再问**，别再"顺手加回来"。
//    ②在本组里也只能断言"不写盘"（浏览器开发模式没有 filePath：`plugin:dialog|open` 对文件对话框
//    返回 null，拿不到路径）——判定函数与确认一起删了，**没有单测可挂**。
console.log("38) 「编辑器会清空文件吗」——新建要先确认 + 全程不自动写盘");

const writesProbe = `(window.__browserDevWrites || []).map((w) => ({
  path: w.path, bytes: w.content.length,
}))`;
const statusProbe = `document.querySelector(".statusbar").innerText`;

// ① 空文档上按 Ctrl+N：没有可丢的内容 → 不确认，直接新建（守卫不能把正常新建也拦死）
//
// 判据用**存档里的 dirty 翻转 + 内容为空**，不读状态栏、也不读 `innerText`：
//  · 状态栏会被紧接着的一次编译从「已新建」顶成「就绪」（实测 500ms 后已经是「就绪」）；
//  · `.cm-content` 的 innerText 对空文档返回的是 `"\n"`（1 个字符），不是 `""`（实测踩到，写检查时踩过一次）；
//  · 存档会先被 `clearState()` 清掉（实测 +120ms 时还是 null），约 300ms 后又被一次设置持久化
//    写回"空会话"（content 空 + dirty false），所以"存档为 null"这种瞬时状态不能当判据。
// dirty 从 true 变 false 只有 `docSession.createNew()`（本组里没有保存/打开）能做到：确认一发就会被桩取消、
// dirty 会留在 true，所以它正好能区分"弹了但被取消"和"没弹、直接新建"。
await c.click(400, 300);
await c.type("先随便写点，再删光，制造「空文档」这种状态\n");
await new Promise((r) => setTimeout(r, 500));
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 700)); // 等存档防抖落地
await c.evaluate(`(() => { window.__browserDevWrites = []; })()`);
const archiveProbe = `(() => {
  const raw = localStorage.getItem("typst-pad:state");
  const s = raw ? JSON.parse(raw) : null;
  return {
    content: s ? s.content : null,
    dirty: s ? s.dirty : null,
    writes: (window.__browserDevWrites || []).length,
  };
})()`;
const beforeBlankNew = await c.evaluate(archiveProbe);
await c.key("N", { code: "KeyN", keyCode: 78, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
const newOnBlank = await c.evaluate(archiveProbe);
check(
  "空文档上 Ctrl+N：没有可丢的内容 → 不弹确认，直接新建（dirty 被新建翻成 false）",
  beforeBlankNew.content === "" &&
    beforeBlankNew.dirty === true &&
    newOnBlank.content === "" &&
    newOnBlank.dirty === false &&
    newOnBlank.writes === 0,
  JSON.stringify({ before: beforeBlankNew, after: newOnBlank }),
);

// ② 输入内容（等过持久化防抖）→ 一次写盘都不该发生：应用从不自己写 .typ
await c.click(400, 300);
await c.type("= 不会被自动写走的内容\n这里是正文。\n");
await new Promise((r) => setTimeout(r, 1200));
const typedState = await c.evaluate(`({
  chars: (document.querySelector(".cm-content").innerText || "").length,
  writes: ${writesProbe},
  saved: ${savedContent},
})`);
check(
  "编辑内容后（含超过 300ms 持久化防抖）没有任何写盘动作：应用不会自己写文件",
  typedState.chars > 0 && typedState.writes.length === 0,
  JSON.stringify(typedState),
);
check(
  "会话存档照常更新（存档走 localStorage，与文件无关）——内容是刚敲的那段",
  String(typedState.saved).includes("不会被自动写走的内容"),
  JSON.stringify(String(typedState.saved).slice(0, 60)),
);

// ③ 有未保存内容时 Ctrl+N：先确认。浏览器验收里的 confirm 桩固定返回 false（= 用户点「取消」），
//    所以这里验的是"取消分支"：内容与存档都必须原样留着。
const beforeNew = await c.evaluate(
  `({ content: ${savedContent}, chars: (document.querySelector(".cm-content").innerText || "").length })`,
);
await c.key("N", { code: "KeyN", keyCode: 78, modifiers: 2 });
await new Promise((r) => setTimeout(r, 600));
const afterNewAttempt = await c.evaluate(`({
  status: ${statusProbe},
  content: ${savedContent},
  chars: (document.querySelector(".cm-content").innerText || "").length,
  writes: ${writesProbe},
})`);
check(
  "有未保存内容时 Ctrl+N 先确认：取消（桩 confirm=false）→ 编辑器内容一字未丢",
  afterNewAttempt.chars === beforeNew.chars && afterNewAttempt.chars > 0,
  JSON.stringify({ before: beforeNew.chars, after: afterNewAttempt.chars }),
);
check(
  "取消后没有真的新建：状态栏不是「已新建」、会话存档里的内容也还在（clearState 没执行）",
  !afterNewAttempt.status.includes("已新建") &&
    afterNewAttempt.content === beforeNew.content &&
    afterNewAttempt.content.length > 0,
  JSON.stringify({
    status: afterNewAttempt.status,
    saved: String(afterNewAttempt.content).slice(0, 40),
  }),
);

// ④ 常见操作（切模式 / 缩放 / 等编译）之后仍然一次写盘都没有——把"应用从不自己写文件"钉得更死
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 }); // Ctrl+E 切模式
await new Promise((r) => setTimeout(r, 500));
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 800));
await c.wheel(400, 300, -120, { modifiers: 2 }); // Ctrl+滚轮缩放
await new Promise((r) => setTimeout(r, 900));
const afterOps = await c.evaluate(`({ writes: ${writesProbe} })`);
check(
  "切模式 + 缩放之后依然没有任何写盘动作（写盘只可能来自显式保存）",
  afterOps.writes.length === 0,
  JSON.stringify(afterOps),
);

// 第 39 组：**`Ctrl+Shift+=` / `Ctrl+Shift+-` 调整界面缩放**（用户 2026-09-16 要求
// 「加入 Ctrl + Shift + -/+ 调整一格的快捷键」）
//
// 存在的理由不只是"多一种操作"（见 app-keys.zoomKeySteps 的注解）：Ctrl+滚轮那条路要穿过
// WebView2 的手势处理（#1022：引擎可能把手势里设的 ZoomFactor 抹回手势开始时的值），键盘不经过
// 手势 —— 它既是可用的替代操作，也是判据：键盘也推不动 ⇒ 问题在 setZoom 本身；键盘能推、
// 滚轮不能 ⇒ 问题在手势路径。所以这一组同时锁住"键位正确"与"确实改了状态/存档/引擎入参"。
//
// 断言全部**相对当前档位**写（本组跑在最后，前面的组可能把缩放留在非 100% 的位置）。
console.log("39) Ctrl+Shift+= / Ctrl+Shift+- 调整界面缩放（用户要求）");

const zoomPct = (z) => Math.round((z ?? 0) * 100);
const z0 = await c.evaluate(zoomProbe);
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 }); // Ctrl+Shift+=
await new Promise((r) => setTimeout(r, 400));
const z1 = await c.evaluate(zoomProbe);
check(
  "Ctrl+Shift+= → 放大一格（引擎入参 +10%，状态栏与存档同步）",
  Math.abs((z1.requested ?? 0) - ((z0.requested ?? 0) + 0.1)) < 0.001 &&
    z1.status.includes(`缩放 ${zoomPct(z1.requested)}%`) &&
    Math.abs((z1.saved ?? 0) - (z1.requested ?? 0)) < 0.001,
  JSON.stringify({ before: z0.requested, after: z1.requested, status: z1.status, saved: z1.saved }),
);
check(
  "状态栏出现常驻缩放徽标（与 Ctrl+滚轮那条路完全同一套反馈）",
  z1.tags.some((t) => t.includes(`${zoomPct(z1.requested)}%`)),
  JSON.stringify(z1.tags),
);

await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await new Promise((r) => setTimeout(r, 400));
const z2 = await c.evaluate(zoomProbe);
check(
  "再按一次 → 再涨一格（一格 = 10%，不是一步跳到上限）",
  Math.abs((z2.requested ?? 0) - ((z0.requested ?? 0) + 0.2)) < 0.001,
  JSON.stringify({ before: z0.requested, after: z2.requested }),
);

await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 }); // Ctrl+Shift+-
await new Promise((r) => setTimeout(r, 400));
const z3 = await c.evaluate(zoomProbe);
check(
  "Ctrl+Shift+- → 缩小一格（回到刚才那一档）",
  Math.abs((z3.requested ?? 0) - ((z0.requested ?? 0) + 0.1)) < 0.001,
  JSON.stringify({ after: z3.requested }),
);

// 反向：不带 Shift 的 Ctrl+= 不归我们管（那是引擎/系统自己的缩放手势，别抢）
const callsBeforePlain = z3.zoomCalls;
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 2 }); // 只按 Ctrl
await new Promise((r) => setTimeout(r, 400));
const z4 = await c.evaluate(zoomProbe);
check(
  "不带 Shift 的 Ctrl+= 不被我们接管（缩放没动、也没再让引擎改档）",
  Math.abs((z4.requested ?? 0) - (z3.requested ?? 0)) < 0.001 && z4.zoomCalls === callsBeforePlain,
  JSON.stringify({ requested: z4.requested, zoomCalls: z4.zoomCalls, before: callsBeforePlain }),
);

// 连按到下限：收敛在 50% 并提示"到边界了"（与滚轮同一条收敛逻辑）
for (let i = 0; i < 14; i++) {
  await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 400));
const zBottom = await c.evaluate(zoomProbe);
check(
  "连按 14 次 Ctrl+Shift+- → 收敛在 50% 并提示「到边界了」（不越界、不会冲成负数）",
  Math.abs((zBottom.requested ?? 0) - 0.5) < 0.001 && zBottom.status.includes("到边界了"),
  JSON.stringify({ requested: zBottom.requested, status: zBottom.status }),
);

// 收尾：走菜单「重置缩放」回到 100%（顺带验菜单入口没坏）
await openMenu("视图");
await c.waitFor(`document.body.innerText.includes("重置缩放")`, { timeout: 5000 });
await clickMenuItem("重置缩放");
await new Promise((r) => setTimeout(r, 500));
const zReset = await c.evaluate(zoomProbe);
check(
  "菜单「视图 → 重置缩放」回到 100%，徽标消失（缩放的三条入口共用同一套状态）",
  Math.abs((zReset.requested ?? 0) - 1) < 0.001 && !zReset.tags.some((t) => t.includes("缩放")),
  JSON.stringify({ requested: zReset.requested, tags: zReset.tags }),
);

// 第 40 组：**一次滚轮的位移不足一档时不许失灵**（用户 2026-09-16 反馈
// 「Ctrl+滚轮常态是可以的，但是到上限不知道为什么就不可以了」+ 状态栏写着「缩放已是 250%（到边界了）」）
//
// 真因（`zoom.ts` 的 accumulateWheelSteps 注解）：滚轮位移可能不足一档（高倍缩放时每格位移会变小；
// Chromium 在"浏览器→渲染器"之间会按比例缩放滚轮位移），而档位是 10% 一格、`clampZoom` 又会把
// 计算出来的 4% 圆整抹掉 —— 每个事件独立算的话，这种滚轮**永远**动不了，还会被误报成"到边界了"。
// 之前 223 项验收全绿是因为**脚本一直只发 ±100px**（正好在阈值上边），这条路径根本没被覆盖。
// 下面用真实滚轮事件（差分机发的就是 40px）锁住：不足一档要攒起来、攒够了走一档，
// 而且**没到边界时不许说"到边界了"**。
console.log("40) 位移不足一档的滚轮：攒够再走一格（用户报的「到上限就不行」）");

/** 在编辑区中心发 N 次 40px 的真实滚轮事件（Ctrl 修饰） */
const smallWheel = async (deltaY, times) => {
  const z = await c.evaluate(zoomProbe);
  for (let i = 0; i < times; i++) await c.wheel(z.center.x, z.center.y, deltaY, { modifiers: 2 });
  await new Promise((r) => setTimeout(r, 400));
  return c.evaluate(zoomProbe);
};

// 起点归到 100%（上一组结束时已经是 100%，这里再确认一次并拿基准）
const s0 = await c.evaluate(zoomProbe);
check(
  "第 40 组起点：缩放 100%（上一组收尾重置过）",
  Math.abs((s0.requested ?? 0) - 1) < 0.001,
  JSON.stringify({ requested: s0.requested }),
);

// ① 一格 40px（0.4 档）不足以走一档：档位不动，且**绝不能**说"到边界了"；
//    同时要把"攒了多少"说出来（否则"位移太小"与"事件没到页面"在用户眼里完全一样）
const s1 = await smallWheel(-40, 1);
check(
  "40px 一格：档位不动、状态栏**不出现**「到边界了」（旧代码在这里谎报边界），而是提示攒到 40%",
  Math.abs((s1.requested ?? 0) - 1) < 0.001 &&
    !s1.status.includes("到边界了") &&
    s1.status.includes("攒到 40%"),
  JSON.stringify({ requested: s1.requested, status: s1.status }),
);

// ② 再来一格（累计 0.8 档 ≥ 半档）：走一档 —— 这就是旧代码永远到不了的一步
const s2 = await smallWheel(-40, 1);
check(
  "40px 两格（累计 0.8 档）→ 放大一档到 110%（余量攒够了就走）",
  Math.abs((s2.requested ?? 0) - 1.1) < 0.001 && s2.status.includes("缩放 110%"),
  JSON.stringify({ requested: s2.requested, status: s2.status }),
);

// ③ 反方向同理：往下滚两格 40px 回到 100%
const s3 = await smallWheel(40, 2);
check(
  "40px 往下两格 → 缩回 100%（反方向也攒得起来）",
  Math.abs((s3.requested ?? 0) - 1) < 0.001,
  JSON.stringify({ requested: s3.requested }),
);

// ④ 上限处往下滚（用户报的正是这个）：先用键盘推到 250%，再用 40px 滚轮往下 —— 必须能缩小
for (let i = 0; i < 15; i++) {
  await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
  await new Promise((r) => setTimeout(r, 80));
}
await new Promise((r) => setTimeout(r, 400));
const sTop = await c.evaluate(zoomProbe);
check(
  "用键盘推到上限 250%（这一档 = 边界）",
  Math.abs((sTop.requested ?? 0) - 2.5) < 0.001,
  JSON.stringify({ requested: sTop.requested }),
);
const sTopUp = await smallWheel(-40, 4); // 已在边界，往上滚应当只提示"到边界了"
check(
  "真到边界时往上滚（40px ×4）→ 停在 250% 并提示「到边界了」（这句只许在真边界出现）",
  Math.abs((sTopUp.requested ?? 0) - 2.5) < 0.001 && sTopUp.status.includes("到边界了"),
  JSON.stringify({ requested: sTopUp.requested, status: sTopUp.status }),
);
const sDown = await smallWheel(40, 2);
check(
  "**回归**：上限处用 40px 滚轮往下两格 → 250% → 240%（用户报的「到上限就不行」）",
  Math.abs((sDown.requested ?? 0) - 2.4) < 0.001 && sDown.status.includes("缩放 240%"),
  JSON.stringify({ requested: sDown.requested, status: sDown.status }),
);

// 收尾：走菜单「重置缩放」回到 100%
await openMenu("视图");
await c.waitFor(`document.body.innerText.includes("重置缩放")`, { timeout: 5000 });
await clickMenuItem("重置缩放");
await new Promise((r) => setTimeout(r, 500));
const sReset = await c.evaluate(zoomProbe);
check(
  "第 40 组收尾：重置回 100%（滚轮余量不残留：重置后按 40px 一格仍然不动）",
  Math.abs((sReset.requested ?? 0) - 1) < 0.001,
  JSON.stringify({ requested: sReset.requested }),
);

// 第 41 组：**文档自己写了 `#set page(...)` 时，预览栏也不许出现横向滚动条**
// （用户 2026-09-18 反馈「为什么预览框还是会出现下方的滑动条」，并选定「永不横滚」）
//
// 背景：预览的页宽是**编译期**决定的，所以有两条路（见 preview-scale.ts）：
//   ① 我们注入 `#set page(width: …)` → 按栏宽重排 → 画布恒 ≤ 栏宽（第 30 组锁的就是这条）；
//   ② 文档自己写了 `#set page(...)`（`paper:` / `width:` / `height:` 都算）→ 我们的注入被它覆盖
//      → 退回「固定版心 + 等比缩放」老路：画布被自然尺寸（A4 ≈ 568 CSS px）封顶。
// 老路上界面缩放会把 **CSS 视口一起缩小**（1400px 窗口在 150% 下只有 933 CSS px，预览栏
// 685 → 451px），于是 568 > 451 —— **预览栏底部出现横向滚动条**（实测溢出 117px）。
// 而且画布在 568px 就已封顶，再放大并不会更大 ⇒ 这条横条"什么也没换来"。
//
// 真机上没法用 setZoom 放大（无头桩的 setZoom 是假的），所以用两条一起复现同一套几何：
//   键盘 `Ctrl+Shift+=` 设 uiZoom 状态（放大档位）× `Emulation.setDeviceMetricsOverride`
//   把视口压到"缩放后应有的 CSS 宽度"（真机上这一步由 webview 缩放自己完成）。
// 视口变化会触发 ResizeObserver → applyPreviewScale，正是真机上缩放时走的那条路。
console.log("41) 文档自带 #set page(...)（固定版心）时也不许横滚");

const hProbe = `(() => {
  const b = document.querySelector(".preview-body");
  const h = document.querySelector("#preview-host");
  const svg = h ? h.querySelector("svg") : null;
  const cs = getComputedStyle(b);
  return {
    clientW: b.clientWidth,
    scrollW: b.scrollWidth,
    overX: b.scrollWidth - b.clientWidth,
    // 横向滚动条是否真的"存在"（overflow-x 为 auto 且内容更宽才算）
    showsScrollbar: b.scrollWidth > b.clientWidth && cs.overflowX !== "hidden",
    hostW: h ? +h.getBoundingClientRect().width.toFixed(1) : null,
    hostStyleW: h ? h.style.width : null,
    viewBox: svg ? svg.getAttribute("viewBox") : null,
    uiZoom: JSON.parse(localStorage.getItem("typst-pad:state") || "{}").uiZoom ?? null,
  };
})()`;

/** 进「源代码模式」并压到指定视口宽度；zoomSteps = 按几次 Ctrl+Shift+= */
const enterSourceAt = async (extra, viewportW, zoomSteps) => {
  await c.goto(`${DEV_URL}${extra}`);
  await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
  await c.evaluate(`localStorage.clear()`); // 否则上次的 viewMode/缩放会残留
  await c.goto(`${DEV_URL}${extra}`);
  await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: viewportW,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 700));
  // 写作 → 源代码模式；并**确认预览栏真的可见**（clientWidth > 0）——不确认的话，
  // 一旦这次按键没生效（焦点/时序问题），后面就会拿 clientWidth=0 去断言，报错信息毫无指向性（实测踩过）
  for (let attempt = 0; attempt < 3; attempt++) {
    await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
    await new Promise((r) => setTimeout(r, 700));
    const visible = await c.evaluate(`document.querySelector(".preview-body").clientWidth > 0`);
    if (visible) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1800)); // 等预览重排（去抖 250ms + 一次编译）
  for (let i = 0; i < zoomSteps; i++) {
    await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
    await new Promise((r) => setTimeout(r, 140));
  }
  // 再抖一下视口：真机上缩放本身就会让预览栏变窄并触发 ResizeObserver，
  // 桩里 setZoom 是假的，所以用 1px 的变化把同一段代码（RO → applyPreviewScale）跑起来。
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: viewportW - 1,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 1800));
};

// ① 固定版心 + 界面 150%（真机几何：1400px 窗口 → CSS 视口 933px，预览栏约 451px）
await enterSourceAt("&reflowfail=1", 933, 5);
const fix150 = await c.evaluate(hProbe);
check(
  "文档自带 #set page(...) + 界面 150%：预览栏没有横向滚动条（修前溢出 117px）",
  fix150.overX === 0 && !fix150.showsScrollbar,
  JSON.stringify(fix150),
);
check(
  "同一档下画布**铺满**预览栏（不再是封顶的 568px 自然尺寸）",
  fix150.hostW !== null && Math.abs(fix150.hostW - fix150.clientW) <= 1,
  JSON.stringify(fix150),
);
await c.screenshot(SHOT("wysiwyg-41-fixedpage-150"));

// ② 固定版心 + 界面 250%（真机几何：1400px 窗口 → CSS 视口 560px，预览栏约 265px）
await enterSourceAt("&reflowfail=1", 560, 15);
const fix250 = await c.evaluate(hProbe);
check(
  "文档自带 #set page(...) + 界面 250%：同样不横滚、画布铺满栏宽",
  fix250.overX === 0 &&
    !fix250.showsScrollbar &&
    fix250.hostW !== null &&
    Math.abs(fix250.hostW - fix250.clientW) <= 1,
  JSON.stringify(fix250),
);

// ③ 宽栏 + 100%（1400px 窗口）：观感**不许变** —— 固定版心的页面仍停在自然尺寸居中，
//    不因为"永不横滚"就被撑满整栏（那会改变所有老文档的默认外观）。
await enterSourceAt("&reflowfail=1", 1400, 0);
const fix100 = await c.evaluate(hProbe);
check(
  "宽栏 + 100%：固定版心的页面仍停在自然尺寸（≈568px，居中，没被撑满）",
  fix100.overX === 0 && fix100.hostW !== null && Math.abs(fix100.hostW - 568) <= 2,
  JSON.stringify(fix100),
);

// ④ 对照组：干净文档走「按栏宽重排」那条路，行为必须保持不变（不横滚、画布 = 栏宽）
await enterSourceAt("", 933, 5);
const reflow150 = await c.evaluate(hProbe);
check(
  "对照组（干净文档走重排路 + 界面 150%）：不横滚、画布仍铺满栏宽（这条路径没被动过）",
  reflow150.overX === 0 &&
    reflow150.hostW !== null &&
    Math.abs(reflow150.hostW - reflow150.clientW) <= 1,
  JSON.stringify(reflow150),
);

// ── 第 42 组：编译错误的红波浪线（主源诊断必须真的画出来） ──
// 回归背景（2026-09-18 排查「还是没法 #import 别的文件」时查出来的老 bug）：
// Rust 对主源诊断发的是 `"path":null`，而 squiggleRanges 的判据只认
// `undefined` / `""` / `main.typ` ⇒ `null` 被判成"非主源文件"跳过，
// **桌面版从 0.4.0 起编译错误的波浪线一条都不画**。桩当时干脆不发 path 字段，
// 所以浏览器验收一直没覆盖这条链路 —— 现在桩按真实形状（`path: null`）发一条 error，
// 把它钉住：判据退回旧写法，这四条就会红。
console.log("42) 编译错误的红波浪线（主源诊断 path: null）");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

const diagProbe = `(() => {
  const bar = document.querySelector(".statusbar");
  const wavy = Array.from(document.querySelectorAll(".cm-diag-wavy"));
  const errBadge = bar.querySelector(".error-badge:not(.warning-badge)");
  return {
    count: wavy.length,
    texts: wavy.map((e) => e.textContent),
    errCount: errBadge?.querySelector(".error-count")?.textContent?.trim() ?? null,
  };
})()`;

await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 200));
await c.type("DIAG-ERROR-MARKER"); // 桩按这个标记回一条主源 error 诊断（见 browser-dev-stub.ts）
await new Promise((r) => setTimeout(r, 800));
const diag = await c.evaluate(diagProbe);
check("主源编译错误画出红波浪线（.cm-diag-wavy）", diag.count >= 1, JSON.stringify(diag));
check(
  "波浪线落在出错的那段文本上（不是画到别处）",
  diag.texts.some((t) => t.includes("DIAG-ERROR-MARKER")),
  JSON.stringify(diag.texts),
);
check("错误计数徽标同步为 1", diag.errCount === "1", String(diag.errCount));
await c.screenshot(SHOT("wysiwyg-42-diag-squiggle"));

// 清掉标记 ⇒ 编译成功 ⇒ 波浪线与计数一起归零（不许留"幽灵错误"）
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 800));
const diagClean = await c.evaluate(diagProbe);
check(
  "清掉标记后波浪线与错误计数一起归零",
  diagClean.count === 0 && diagClean.errCount === "0",
  JSON.stringify(diagClean),
);

// ---------------------------------------------------------------------------
// 第 43 组：状态栏两个徽标的 Popover 交互必须一致
// 背景（用户反馈 2026-09-18：「状态栏 点击警告 关闭警告的行为应该和错误是一样的」）：
// 两个徽标当时只有「点一下切换」是同款 —— 警告浮层**没有** Esc / 点外部关闭、点条目跳转后
// 不收起、窄窗口不做视口收边（错误侧这几条都有；`cursor: pointer` 倒是早就有了，因为警告
// 徽标的类名里带着 `error-badge`，`.error-badge.clickable` 那条规则对它同样生效 ——
// 本组第 1 条把它一起钉住，免得以后拆类名时悄悄丢掉）。
// 断言分三段：警告侧 8 条、错误侧做同样对照 4 条、窄视口收边 1 条。
// 「行 N, 列 M」只在源码模式的状态栏里显示（写作模式不显示行列），所以本组切到源码模式。
// 浮层的选择器按 `aria-label` 取（两个浮层共用 `.error-popover` 类名 —— 修前两侧可以同时
// 开着，用类名会取错那个）。
// ---------------------------------------------------------------------------
console.log("43) 状态栏两个徽标的 Popover 交互一致（Esc / 点外部 / 点条目 / 收边）");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

const POP43_WARN = "[aria-label='编译警告列表']";
const POP43_ERR = "[aria-label='编译错误列表']";

/** 状态栏 + 两个浮层的联合探针（本组所有断言都读它） */
const pop43Probe = `(() => {
  const bar = document.querySelector(".statusbar");
  const warn = bar.querySelector(".warning-badge");
  const err = bar.querySelector(".error-badge:not(.warning-badge)");
  const info = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      text: el.innerText.split("\\n").join(" ").slice(0, 40),
      left: Math.round(r.left),
      right: Math.round(r.right),
    };
  };
  return {
    warnCls: warn?.className ?? null,
    errCls: err?.className ?? null,
    warnCursor: warn ? getComputedStyle(warn).cursor : null,
    errCursor: err ? getComputedStyle(err).cursor : null,
    warnCount: warn?.querySelector(".error-count")?.textContent?.trim() ?? null,
    errCount: err?.querySelector(".error-count")?.textContent?.trim() ?? null,
    warnPop: info(${JSON.stringify(POP43_WARN)}),
    errPop: info(${JSON.stringify(POP43_ERR)}),
    win: window.innerWidth,
    barText: bar.innerText.split("\\n").join(" "),
  };
})()`;

/** 清空文档（先把焦点还给编辑器，否则 Ctrl+A 选的是别的东西） */
async function pop43ClearDoc() {
  await c.evaluate(`document.querySelector(".cm-content").focus()`);
  await c.selectAll();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await new Promise((r) => setTimeout(r, 250));
}

/** 每个小段开始前把两个浮层都关掉（用徽标点击，不依赖本组正在验证的那几条行为）——
 *  这样某条红了也不会连带把后面的断言卡死，控制实验里能一次看全所有红项 */
const POP43_ERR_BADGE = `document.querySelector(".error-badge:not(.warning-badge)").click()`;
async function pop43CloseAll() {
  if (await c.evaluate(`!!document.querySelector(${JSON.stringify(POP43_WARN)})`)) {
    await c.evaluate(`document.querySelector(".warning-badge").click()`);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (await c.evaluate(`!!document.querySelector(${JSON.stringify(POP43_ERR)})`)) {
    await c.evaluate(POP43_ERR_BADGE);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 取元素中心坐标（浮层内的点击必须走真实鼠标事件：内部/外部判定的路径就是 mousedown） */
const pop43CenterOf = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(60, r.width / 2)), y: Math.round(r.top + r.height / 2) };
})()`;

const pop43OpenWarn = `!!document.querySelector(${JSON.stringify(POP43_WARN)})`;
const pop43OpenErr = `!!document.querySelector(${JSON.stringify(POP43_ERR)})`;

// ---- 警告侧（源码模式：状态栏能看到行列）----
await pop43ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type('第一行内容\n#set text(font: "微软雅黑")');
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await c.waitFor(`document.querySelector(".statusbar").innerText.includes("源码")`, {
  timeout: 5000,
});
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 400));

const pop43W0 = await c.evaluate(pop43Probe);
check(
  "警告徽标可点时鼠标指针是 pointer（与错误徽标同款）",
  pop43W0.warnCursor === "pointer" && pop43W0.warnCls.includes("clickable"),
  JSON.stringify({ cursor: pop43W0.warnCursor, cls: pop43W0.warnCls }),
);

await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
const pop43W1 = await c.evaluate(pop43Probe);
check(
  "点警告徽标开出警告浮层（标题写明「编译警告」）",
  pop43W1.warnPop !== null && pop43W1.warnPop.text.includes("编译警告"),
  JSON.stringify(pop43W1.warnPop),
);
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await new Promise((r) => setTimeout(r, 250));
check("再点一次收起（开合是同一个手势）", !(await c.evaluate(pop43OpenWarn)));

await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 250));
check("Esc 收起警告浮层", !(await c.evaluate(pop43OpenWarn)));

await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
const pop43Title = await c.evaluate(pop43CenterOf(`${POP43_WARN} .error-popover-title`));
await c.click(pop43Title.x, pop43Title.y);
await new Promise((r) => setTimeout(r, 250));
check(
  "点浮层内部（标题区）不收起 —— 外部判定按外框包含关系来",
  await c.evaluate(pop43OpenWarn),
  JSON.stringify(pop43Title),
);

// 点定位条目：跳转 + 收起。桩的警告固定报「行 1, 列 1」，而光标在文档末尾（第 2 行）
const pop43BeforeJump = await c.evaluate(pop43Probe);
const pop43Item = await c.evaluate(pop43CenterOf(`${POP43_WARN} .error-item`));
await c.click(pop43Item.x, pop43Item.y);
await new Promise((r) => setTimeout(r, 300));
const pop43AfterJump = await c.evaluate(pop43Probe);
check(
  "点定位警告条目 → 跳到 行 1, 列 1 且浮层收起",
  pop43AfterJump.barText.includes("行 1, 列 1") &&
    pop43AfterJump.warnPop === null &&
    pop43BeforeJump.barText.includes("行 2"),
  `点前…${pop43BeforeJump.barText.slice(-16)} / 点后…${pop43AfterJump.barText.slice(-16)}`,
);

await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
await c.click(400, 300); // 编辑器区（在徽标外框之外）
await new Promise((r) => setTimeout(r, 250));
check("点浮层外部（编辑器区）收起警告浮层", !(await c.evaluate(pop43OpenWarn)));

await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
await pop43ClearDoc();
await new Promise((r) => setTimeout(r, 700));
const pop43Gone = await c.evaluate(pop43Probe);
check(
  "警告消失后浮层不残留（徽标归零）",
  pop43Gone.warnPop === null && pop43Gone.warnCount === "0",
  JSON.stringify({ pop: pop43Gone.warnPop, warnCount: pop43Gone.warnCount }),
);

// 修前这里会红：`showWarnings` 还留着 true（只靠 {#if} 隐藏），警告一回来浮层自己就弹开了
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type('#set text(font: "微软雅黑")');
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 400));
const pop43Back = await c.evaluate(pop43Probe);
check(
  "警告再次出现时浮层不会自己弹回来（状态没留在「开着」）",
  pop43Back.warnPop === null && pop43Back.warnCount !== "0",
  JSON.stringify({ pop: pop43Back.warnPop, warnCount: pop43Back.warnCount }),
);

// ---- 错误侧对照（错误在文档第 1 行、光标停在末尾 ⇒ 跳转方向可辨）----
await pop43ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type("DIAG-ERROR-MARKER\n第一行内容");
await c.waitFor(`!!document.querySelector(".cm-diag-wavy")`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 400));
const pop43E0 = await c.evaluate(pop43Probe);
check(
  "错误徽标可点时鼠标指针也是 pointer（两侧一致）",
  pop43E0.errCursor === "pointer" && pop43E0.errCls.includes("clickable"),
  JSON.stringify({ cursor: pop43E0.errCursor, cls: pop43E0.errCls }),
);

await pop43CloseAll();
await c.evaluate(POP43_ERR_BADGE);
await c.waitFor(pop43OpenErr, { timeout: 3000 });
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 250));
check("Esc 收起错误浮层（警告侧要对齐的基准行为）", !(await c.evaluate(pop43OpenErr)));

await pop43CloseAll();
await c.evaluate(POP43_ERR_BADGE);
await c.waitFor(pop43OpenErr, { timeout: 3000 });
const pop43ErrItem = await c.evaluate(pop43CenterOf(`${POP43_ERR} .error-item`));
await c.click(pop43ErrItem.x, pop43ErrItem.y);
await new Promise((r) => setTimeout(r, 300));
const pop43AfterErrJump = await c.evaluate(pop43Probe);
check(
  "点定位错误条目 → 跳到 行 1, 列 1 且浮层收起",
  pop43AfterErrJump.barText.includes("行 1, 列 1") && pop43AfterErrJump.errPop === null,
  pop43AfterErrJump.barText.slice(-28),
);

// 修前这里会红：错误列表清空后 {#if showErrors} 还在，留下一个只有标题的空浮层
await pop43CloseAll();
await c.evaluate(POP43_ERR_BADGE);
await c.waitFor(pop43OpenErr, { timeout: 3000 });
await pop43ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type("普通文本");
await new Promise((r) => setTimeout(r, 800));
const pop43EGone = await c.evaluate(pop43Probe);
check(
  "错误消失后浮层不残留（修前会留一个只有标题的空浮层）",
  pop43EGone.errPop === null && pop43EGone.errCount === "0",
  JSON.stringify({ pop: pop43EGone.errPop, errCount: pop43EGone.errCount }),
);

// ---- 窄视口：警告浮层的视口收边 ----
await pop43CloseAll();
await pop43ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type('#set text(font: "微软雅黑")');
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 400,
  height: 460,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((r) => setTimeout(r, 500));
// 注意 closeAll 必须放在**警告真的出现之后**：修前 `showWarnings` 会因"只隐藏不复位"
// 留在 true，坏字体一出现浮层就自己开好了 —— 那时再点徽标反而把它关掉，waitFor 直接超时
// （实测：这一段的 closeAll 原来放在打字之前，控制实验就卡在这里）。
await pop43CloseAll();
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(pop43OpenWarn, { timeout: 3000 });
await new Promise((r) => setTimeout(r, 300));
const pop43Narrow = await c.evaluate(pop43Probe);
check(
  "窄视口（400px）下警告浮层被收进视口内",
  pop43Narrow.warnPop !== null &&
    pop43Narrow.warnPop.left >= 7 &&
    pop43Narrow.warnPop.right <= pop43Narrow.win - 7,
  JSON.stringify({ pop: pop43Narrow.warnPop, win: pop43Narrow.win }),
);
await c.screenshot(SHOT("wysiwyg-43-badge-popover"));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await c.send("Emulation.clearDeviceMetricsOverride");
await new Promise((r) => setTimeout(r, 300));

// ---------------------------------------------------------------------------
// 第 44 组：复制编译错误/警告信息（用户要求「需要功能：复制错误信息」）
// 形态：两个浮层（错误 / 警告）每条右侧一个「复制」按钮，标题行右侧一个「复制全部」。
// 复制文本 = 「路径: 行 N, 列 M：消息」，整份列表第一行是浮层标题原文（路径贴在行列前面
// 是用户当场指定的）。浏览器开发模式文档未保存 ⇒ 没有路径，省略路径前缀，这一组正好把
// 这条分支也钉住；带路径的两种情形（诊断自带路径 / 回退当前文档路径）由 error-list.test.ts 覆盖。
// 「到底往剪贴板塞了什么」由桩的假剪贴板记录（window.__browserDevCopied，
// 见 browser-dev-stub.ts）：它拦 document.execCommand("copy")，把**被选中的文本**记下来。
// 用源码模式是为了状态栏显示「行 N, 列 M」：这样才能断言"点复制没有顺带跳转"。
// ---------------------------------------------------------------------------
console.log("44) 复制编译错误/警告信息（浮层里的「复制」按钮）");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

/** 复制记录 + 浮层状态 + 状态栏（含源码模式的行列）探针 */
const copy44Probe = `(() => {
  const w = window;
  const errPop = document.querySelector("[aria-label='编译错误列表']");
  const warnPop = document.querySelector("[aria-label='编译警告列表']");
  const pop = errPop ?? warnPop;
  const copied = Array.isArray(w.__browserDevCopied) ? w.__browserDevCopied : null;
  return {
    copied,
    last: copied && copied.length > 0 ? copied[copied.length - 1] : null,
    errPop: !!errPop,
    warnPop: !!warnPop,
    itemCopies: pop ? pop.querySelectorAll(".error-item-copy").length : 0,
    copyAll: pop ? (pop.querySelector(".error-copy-all")?.textContent ?? "").trim() : "",
    userSelect: pop ? getComputedStyle(pop).userSelect : null,
    status: document.querySelector(".statusbar .status-text")?.textContent ?? "",
    barText: document.querySelector(".statusbar").innerText.split("\\n").join(" "),
  };
})()`;

/** 清空文档（焦点先还给编辑器） */
async function copy44ClearDoc() {
  await c.evaluate(`document.querySelector(".cm-content").focus()`);
  await c.selectAll();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await new Promise((r) => setTimeout(r, 250));
}

/** 取元素中心坐标（真实鼠标点击：顺带验证"点复制不会误触发跳转/关浮层"） */
const copy44CenterOf = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const COPY44_ERR_POP = "[aria-label='编译错误列表']";
const COPY44_WARN_POP = "[aria-label='编译警告列表']";
const COPY44_ERR_BADGE = `document.querySelector(".error-badge:not(.warning-badge)").click()`;

// ---- 错误侧（错误在文档第 2 行、光标停在末尾 ⇒ "有没有跳转"可辨）----
await copy44ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type("第一行内容\nDIAG-ERROR-MARKER");
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 }); // 源码模式：状态栏显示行列
await c.waitFor(`document.querySelector(".statusbar").innerText.includes("源码")`, {
  timeout: 5000,
});
await c.waitFor(`!!document.querySelector(".cm-diag-wavy")`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 500));
await c.evaluate(COPY44_ERR_BADGE);
await c.waitFor(`!!document.querySelector(${JSON.stringify(COPY44_ERR_POP)})`, { timeout: 3000 });

const copy44Err = await c.evaluate(copy44Probe);
check(
  "错误浮层每条都有「复制」按钮、标题行有「复制全部」",
  copy44Err.itemCopies === 1 && copy44Err.copyAll === "复制全部",
  JSON.stringify({ itemCopies: copy44Err.itemCopies, copyAll: copy44Err.copyAll }),
);
check(
  "浮层文字可拖选（user-select: text —— 状态栏整条是 none，必须在这一层放开）",
  copy44Err.userSelect === "text",
  String(copy44Err.userSelect),
);

// 点条目上的「复制」（真实鼠标事件；复制按钮是条目的兄弟，点击不能冒泡成"跳转"）
const copy44ItemBtn = await c.evaluate(copy44CenterOf(`${COPY44_ERR_POP} .error-item-copy`));
await c.click(copy44ItemBtn.x, copy44ItemBtn.y);
await new Promise((r) => setTimeout(r, 300));
const copy44One = await c.evaluate(copy44Probe);
check(
  "点条目「复制」→ 剪贴板拿到「行 2, 列 1：模拟编译错误：这一行是为了验收红波浪线」（未保存文档省略路径前缀）",
  Array.isArray(copy44One.copied) &&
    copy44One.copied.length === 1 &&
    copy44One.last === "行 2, 列 1：模拟编译错误：这一行是为了验收红波浪线",
  JSON.stringify(copy44One.copied),
);
check("复制之后浮层仍然开着（可以接着复制第二条）", copy44One.errPop === true);
check("状态栏给出「已复制」反馈", copy44One.status.includes("已复制"), copy44One.status);
check(
  "点「复制」没有顺带跳转（光标仍在 行 2, 列 18，没被挪到错误处）",
  copy44Err.barText.includes("行 2, 列 18") && copy44One.barText.includes("行 2, 列 18"),
  `点前 ${copy44Err.barText.slice(-14)} / 点后 ${copy44One.barText.slice(-14)}`,
);

// 「复制全部」：首行是浮层标题原文，其后每条一行
const copy44AllBtn = await c.evaluate(copy44CenterOf(`${COPY44_ERR_POP} .error-copy-all`));
await c.click(copy44AllBtn.x, copy44AllBtn.y);
await new Promise((r) => setTimeout(r, 300));
const copy44All = await c.evaluate(copy44Probe);
check(
  "点「复制全部」→ 首行是浮层标题、其后每条一行",
  copy44All.copied !== null &&
    copy44All.copied.length === 2 &&
    copy44All.last === "编译错误（1 处）\n行 2, 列 1：模拟编译错误：这一行是为了验收红波浪线",
  JSON.stringify(copy44All.last),
);

// ---- 警告侧（同款按钮，复制到的是界面上那份中文提示）----
await c.evaluate(COPY44_ERR_BADGE); // 收起错误浮层
await copy44ClearDoc();
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.type('#set text(font: "微软雅黑")');
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
await new Promise((r) => setTimeout(r, 400));
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(`!!document.querySelector(${JSON.stringify(COPY44_WARN_POP)})`, { timeout: 3000 });

const copy44WarnPop = await c.evaluate(copy44Probe);
check(
  "警告浮层同样有「复制」与「复制全部」",
  copy44WarnPop.itemCopies === 1 && copy44WarnPop.copyAll === "复制全部" && copy44WarnPop.warnPop,
  JSON.stringify({ itemCopies: copy44WarnPop.itemCopies, copyAll: copy44WarnPop.copyAll }),
);

const copy44WarnBtn = await c.evaluate(copy44CenterOf(`${COPY44_WARN_POP} .error-item-copy`));
await c.click(copy44WarnBtn.x, copy44WarnBtn.y);
await new Promise((r) => setTimeout(r, 300));
const copy44Warn = await c.evaluate(copy44Probe);
check(
  "警告复制到的是界面上那份中文提示（不是引擎原文 unknown font family）",
  typeof copy44Warn.last === "string" &&
    copy44Warn.last.startsWith("行 1, 列 1：未知字体族「微软雅黑」") &&
    copy44Warn.last.includes("额外字体目录"),
  JSON.stringify(copy44Warn.last),
);
await c.screenshot(SHOT("wysiwyg-44-copy-diagnostic"));

// 收尾：关浮层、清空文档、回写作模式
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await copy44ClearDoc();
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));

// 视口复位（后面的收尾逻辑依赖默认几何）
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1400,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await new Promise((r) => setTimeout(r, 400));

console.log(
  "31b) 选中整个公式不展开（用户要求「选中整个公式请不展开」）：完整盖住 → 保持渲染 + 淡色底",
);
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);

/** 文档 + 选区 + 公式 widget 现状（一次取齐） */
const MATH_SELECT_PROBE = `(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const s = v.state.selection.main;
  const w = document.querySelector(".cm-math-widget, .cm-math-block");
  return {
    doc: v.state.doc.toString(),
    sel: [s.from, s.to],
    selText: v.state.sliceDoc(s.from, s.to),
    widgets: document.querySelectorAll(".cm-math-widget").length,
    blocks: document.querySelectorAll(".cm-math-block").length,
    tinted: document.querySelectorAll(".cm-math-selected").length,
    inner: document.querySelector(".cm-content").innerText,
  };
})()`;

/** 清空重来（全选 + 退格），再输入新文档 */
async function retypeDoc(text, after = 900) {
  await c.click(400, 300);
  await c.selectAll();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await new Promise((r) => setTimeout(r, 200));
  await c.type(text);
  await new Promise((r) => setTimeout(r, after));
}

// ① 行内公式：选区**完整盖住** → 保持渲染 + 淡色底（不再露出 `$x^2$` 源码）
await retypeDoc("前文 $x^2$ 后文\n");
await c.waitFor(`document.querySelectorAll(".cm-math-widget").length === 1`, { timeout: 8000 });
const selInlineBefore = await c.evaluate(MATH_SELECT_PROBE);
check(
  "行内公式已渲染（初始）",
  selInlineBefore.widgets === 1 && !selInlineBefore.inner.includes("$x^2$"),
  JSON.stringify(selInlineBefore),
);
await c.evaluate(`(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const d = v.state.doc.toString();
  const from = d.indexOf("$");
  const to = d.indexOf("$", from + 1) + 1;
  v.dispatch({ selection: { anchor: from, head: to } });
  return [from, to];
})()`);
await new Promise((r) => setTimeout(r, 400));
const selInlineCovered = await c.evaluate(MATH_SELECT_PROBE);
check(
  "选区完整盖住行内公式 → 仍是渲染形态（源码 `$x^2$` 不出现）",
  selInlineCovered.widgets === 1 && !selInlineCovered.inner.includes("$x^2$"),
  JSON.stringify(selInlineCovered),
);
check(
  "整段盖住时挂了淡色底（.cm-math-selected）",
  selInlineCovered.tinted === 1,
  JSON.stringify(selInlineCovered),
);
check(
  "选中的内容仍然是源码（Ctrl+C 会复制到 `$x^2$`）",
  selInlineCovered.selText === "$x^2$",
  JSON.stringify(selInlineCovered.selText),
);

// ② 只盖住一部分 → 照旧展开源码（半个公式要能精确高亮）
await c.evaluate(`(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const d = v.state.doc.toString();
  const from = d.indexOf("$");
  v.dispatch({ selection: { anchor: from + 2, head: from + 5 } });
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
const selInlinePartial = await c.evaluate(MATH_SELECT_PROBE);
check(
  "只盖住一部分 → 展开成源码（看得见 `$`）",
  selInlinePartial.widgets === 0 && selInlinePartial.inner.includes("$x^2$"),
  JSON.stringify(selInlinePartial),
);

// ③ 整段盖住之后**打字**：必须替换掉选区（输入不能丢、更不能落到别处）
await retypeDoc("前文 $x^2$ 后文\n");
await c.waitFor(`document.querySelectorAll(".cm-math-widget").length === 1`, { timeout: 8000 });
await c.evaluate(`(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const d = v.state.doc.toString();
  const from = d.indexOf("$");
  v.dispatch({ selection: { anchor: from, head: d.indexOf("$", from + 1) + 1 } });
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
await c.type("z");
await new Promise((r) => setTimeout(r, 700));
const selInlineTyped = await c.evaluate(MATH_SELECT_PROBE);
check(
  // 选区正好是 `$x^2$`（3..8），两侧的空格不在选区里 —— 所以结果是 `前文 z 后文`
  "盖住整段行内公式后打字 → 选区被替换（`前文 z 后文`，输入真的落进文档）",
  selInlineTyped.doc === "前文 z 后文\n",
  JSON.stringify(selInlineTyped.doc),
);

// ④ 行间公式（独占整行）：整段盖住同样保持渲染；**打字必须替换到正确位置**
//（改前这里是整行 block replace，widget 是 contenteditable=false 的顶层 div —— 实测打字会把
// 字符插到**下一行**：`$ x^2 $\n后文` → `$ x^2 $\nz后文`）
await retypeDoc("$ x^2 $\n后文\n");
await c.waitFor(`document.querySelectorAll(".cm-math-block").length === 1`, { timeout: 8000 });
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await c.key("End", { code: "End", keyCode: 35, modifiers: 8 }); // Shift+End：选中整行公式
await new Promise((r) => setTimeout(r, 400));
const selBlockCovered = await c.evaluate(MATH_SELECT_PROBE);
check(
  "整行公式被完整盖住 → 仍是渲染形态 + 淡色底",
  selBlockCovered.blocks === 1 &&
    selBlockCovered.tinted === 1 &&
    !selBlockCovered.inner.includes("$ x^2 $"),
  JSON.stringify(selBlockCovered),
);
await c.type("z");
await new Promise((r) => setTimeout(r, 700));
const selBlockTyped = await c.evaluate(MATH_SELECT_PROBE);
check(
  "盖住整段行间公式后打字 → 文档变成 `z\\n后文\\n`（不是插进下一行）",
  selBlockTyped.doc === "z\n后文\n",
  JSON.stringify(selBlockTyped.doc),
);
await c.screenshot(SHOT("wysiwyg-37-math-selected"));

// ⑤ 跨行的行间公式仍然整行替换（inline 装饰不允许跨行），因此**照旧展开** —— 宁可展开，
//    也不能让输入落到别处
await retypeDoc("$\n  a+b\n$\n后文\n", 1200);
await c.waitFor(`document.querySelectorAll(".cm-math-block").length === 1`, { timeout: 8000 });
await c.evaluate(`(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  v.dispatch({ selection: { anchor: 0, head: v.state.doc.toString().indexOf("$", 1) + 1 } });
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
const selMultiLine = await c.evaluate(MATH_SELECT_PROBE);
check(
  "跨行公式被完整盖住时**仍然展开**（那种 widget 里打字会插到别处）",
  selMultiLine.blocks === 0 && selMultiLine.inner.includes("$"),
  JSON.stringify(selMultiLine),
);

// ---------------------------------------------------------------------------
// 第 45 组：「弹出来的东西」一律白底
// 背景（用户 2026-09-18 原话：「把所有弹出来的窗口，和 错误 警告 的浮窗（把每一个条目改成
// 灰色），改成白色」）：上一版只把**菜单下拉**改成固定浅色（第 16 组），这一版把同一套
// --panel-* 用到右键菜单、四个弹窗、错误/警告两个浮层上；浮层里的**条目**改浅灰
// （原来是「浅色主题下灰面板 + 白条目」，现在反过来：白面板 + 灰条目）。
//
// 断言分两段：① 先在**深色主题**下量（这几处原来跟 --bg-toolbar(#2d2d30)/--fg(#d4d4d4) 走，
// 改回主题变量这条立刻红 —— 浅色主题下改回去只是 #ececec 的白，肉眼不容易发现，恰恰是
// 用户报的那种"灰面板"）；② 再量浮层条目与文字（白底 + 浅灰字 = 看不见，所以单独钉住
// 文字颜色）。更新弹窗与这里量到的四个弹窗共用 `.modal` 一条规则，不另测。
// ---------------------------------------------------------------------------
console.log("45) 弹出来的面板一律白底（弹窗 / 错误·警告浮层 / 右键菜单），浮层条目是浅灰");
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));

/** 某个选择器上的一条计算样式（取不到元素时返回 null，不抛） */
const style45 = (sel, prop) =>
  `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e).${prop} : null; })()`;
const PANEL45_BG = "rgb(255, 255, 255)"; // --panel-bg
const PANEL45_SOFT = "rgb(240, 240, 240)"; // --panel-soft-bg（浮层里的条目）
const PANEL45_FG = "rgb(31, 31, 31)"; // --panel-fg

// 切到深色主题再量（入口同第 16 组；本组结束时切回「自动」复原）
await openMenu("视图");
await c.waitFor(`!!document.querySelector(".menu-dropdown")`, { timeout: 5000 });
await clickMenuItem("主题：暗");
await c.waitFor(`!document.querySelector(".app").classList.contains("light")`, { timeout: 5000 });
const panel45Toolbar = await c.evaluate(style45(".toolbar", "backgroundColor"));
check(
  "（前置）确实是深色主题：工具栏仍是深色",
  panel45Toolbar !== PANEL45_BG,
  String(panel45Toolbar),
);

// —— 设置弹窗（弹窗里元素最多的一种：标题 / 正文 / 说明文字 / 下拉 / 多行输入框 / 按钮）——
await openMenu("文件");
await c.waitFor(`document.body.innerText.includes("设置")`, { timeout: 5000 });
await clickMenuItem("设置");
await c.waitFor(`!!document.querySelector(".settings-modal")`, { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
const set45 = {
  bg: await c.evaluate(style45(".settings-modal", "backgroundColor")),
  color: await c.evaluate(style45(".settings-modal .modal-text", "color")),
  dim: await c.evaluate(style45(".settings-modal .settings-hint", "color")),
  areaBg: await c.evaluate(style45(".settings-modal .settings-textarea", "backgroundColor")),
  areaColor: await c.evaluate(style45(".settings-modal .settings-textarea", "color")),
};
check("深色主题下设置弹窗是白底", set45.bg === PANEL45_BG, JSON.stringify(set45));
check(
  "弹窗里的正文是深色、说明是灰字（白底上都读得出来）",
  set45.color === PANEL45_FG && set45.dim === "rgb(107, 107, 107)",
  JSON.stringify(set45),
);
check(
  "多行输入框是浅灰底 + 深色字（不是深色主题的深灰底浅灰字）",
  set45.areaBg === PANEL45_SOFT && set45.areaColor === PANEL45_FG,
  JSON.stringify(set45),
);
await c.screenshot(SHOT("wysiwyg-45-settings-white-dark"));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 400));

// —— 关于弹窗（同一套 .modal）——
await openMenu("帮助");
await c.waitFor(`document.body.innerText.includes("关于 Typst-pad")`, { timeout: 5000 });
await clickMenuItem("关于 Typst-pad");
await c.waitFor(`!!document.querySelector(".about-modal")`, { timeout: 5000 });
await new Promise((r) => setTimeout(r, 300));
const about45 = {
  bg: await c.evaluate(style45(".about-modal", "backgroundColor")),
  title: await c.evaluate(style45(".about-modal .modal-title", "color")),
  note: await c.evaluate(style45(".about-modal .about-note", "color")),
};
check(
  "深色主题下关于弹窗也是白底（共用 .modal 那条规则）",
  about45.bg === PANEL45_BG &&
    about45.title === "rgb(11, 107, 181)" &&
    about45.note === "rgb(107, 107, 107)",
  JSON.stringify(about45),
);
await c.screenshot(SHOT("wysiwyg-45-about-white-dark"));
await c.evaluate(`document.querySelector(".about-modal .modal-actions .modal-close").click()`);
await new Promise((r) => setTimeout(r, 300));

// —— 警告浮层：白底 + 灰条目 ——
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 200));
await c.type('#set text(font: "微软雅黑")'); // 桩按「font 值是中文名」回一条 warning
await c.waitFor(`!!document.querySelector(".warning-badge.clickable")`, { timeout: 8000 });
await c.evaluate(`document.querySelector(".warning-badge").click()`);
await c.waitFor(`!!document.querySelector("[aria-label='编译警告列表']")`, { timeout: 3000 });
await new Promise((r) => setTimeout(r, 250));
const warn45 = {
  bg: await c.evaluate(style45(".warning-popover", "backgroundColor")),
  titleColor: await c.evaluate(style45(".warning-popover .error-popover-title", "color")),
  itemBg: await c.evaluate(style45(".warning-popover .error-item", "backgroundColor")),
  itemColor: await c.evaluate(style45(".warning-popover .error-item-msg", "color")),
};
check(
  "深色主题下警告浮层是白底、条目标题是灰字",
  warn45.bg === PANEL45_BG && warn45.titleColor === "rgb(107, 107, 107)",
  JSON.stringify(warn45),
);
check(
  "警告浮层里的每一个条目是浅灰底 + 深色字（用户指定的组合）",
  warn45.itemBg === PANEL45_SOFT && warn45.itemColor === PANEL45_FG,
  JSON.stringify(warn45),
);
await c.screenshot(SHOT("wysiwyg-45-warning-white-dark"));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 300));

// —— 错误浮层：同款（两个浮层共用 .error-popover 规则，但两边的入口各自走一遍）——
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await new Promise((r) => setTimeout(r, 200));
await c.type("DIAG-ERROR-MARKER"); // 见 group 42
await c.waitFor(`!!document.querySelector(".error-badge.clickable")`, { timeout: 8000 });
await c.evaluate(`document.querySelector(".error-badge:not(.warning-badge)").click()`);
await c.waitFor(`!!document.querySelector("[aria-label='编译错误列表']")`, { timeout: 3000 });
await new Promise((r) => setTimeout(r, 250));
const err45 = {
  bg: await c.evaluate(style45(".error-popover", "backgroundColor")),
  itemBg: await c.evaluate(style45(".error-popover .error-item", "backgroundColor")),
  itemLoc: await c.evaluate(style45(".error-popover .error-item-loc", "color")),
  copyColor: await c.evaluate(style45(".error-popover .error-item-copy", "color")),
};
check(
  "深色主题下错误浮层是白底 + 浅灰条目（与警告侧同款）",
  err45.bg === PANEL45_BG && err45.itemBg === PANEL45_SOFT,
  JSON.stringify(err45),
);
check(
  "错误浮层里的行列与「复制」按钮是灰字（白底上仍读得出来）",
  err45.itemLoc === "rgb(107, 107, 107)" && err45.copyColor === "rgb(107, 107, 107)",
  JSON.stringify(err45),
);
await c.screenshot(SHOT("wysiwyg-45-error-white-dark"));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 300));

// —— 右键菜单：同一套 --panel-*（**真实右键**：不是合成事件）——
const ctx45Point = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-content").getBoundingClientRect();
  return { x: Math.round(r.left + 60), y: Math.round(r.top + 20) };
})()`);
await c.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  x: ctx45Point.x,
  y: ctx45Point.y,
  button: "right",
  buttons: 2,
  clickCount: 1,
});
await c.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: ctx45Point.x,
  y: ctx45Point.y,
  button: "right",
  buttons: 0,
  clickCount: 1,
});
await c.waitFor(`!!document.querySelector(".context-menu")`, { timeout: 5000 });
const ctx45 = {
  bg: await c.evaluate(style45(".context-menu", "backgroundColor")),
  // 逐个条目读：空文档上「剪切 / 复制」是 disabled（灰字），别拿第一条当代表
  items:
    await c.evaluate(`Array.from(document.querySelectorAll(".context-menu .menu-item")).map((e) => ({
    text: e.textContent.trim(),
    color: getComputedStyle(e).color,
    disabled: e.disabled,
  }))`),
};
check(
  "深色主题下右键菜单是白底 + 可用条目是深色字（禁用的那几条照旧灰字）",
  ctx45.bg === PANEL45_BG &&
    ctx45.items.some((i) => !i.disabled && i.color === PANEL45_FG) &&
    ctx45.items.every((i) => i.color === PANEL45_FG || i.color === "rgb(107, 107, 107)"),
  JSON.stringify(ctx45),
);
await c.screenshot(SHOT("wysiwyg-45-context-white-dark"));
await c.key("Escape", { code: "Escape", keyCode: 27 });
await new Promise((r) => setTimeout(r, 250));
check("Esc 收起右键菜单", !(await c.evaluate(`!!document.querySelector(".context-menu")`)));

// 收尾：切回「自动」主题（后面的收尾/下一次运行不该受本组影响）
await openMenu("视图");
await c.waitFor(`!!document.querySelector(".menu-dropdown")`, { timeout: 5000 });
await clickMenuItem("主题：自动");
await c.waitFor(`document.querySelector(".app").classList.contains("light")`, { timeout: 5000 });

// 收尾：清回空文档并回写作模式
await c.evaluate(`document.querySelector(".cm-content").focus()`);
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));

finish(`通过 ${state.passed} 项检查；截图：${SHOT("wysiwyg-*")}`);
