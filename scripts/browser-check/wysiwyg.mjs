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

// ---------------------------------------------------------------------------
// 第 27 组：引擎只肯缩小不肯放大时，界面状态必须跟着引擎走（真机 bug 的回归网）
// 背景（2026-09-14 两次实机反馈）：Windows/WebView2 上引擎没接受"放大"，而前端 uiZoom 照旧涨到
// 上限 250%，于是从 250% 往下滚要滚十几档才有反应——用户先报「放大根本没用，缩小有用」，
// 接着报「最大后无法用滚轮缩小」。修法是让状态永远等于引擎实际接受的档位（+page.svelte 的
// verifyZoomApplied）：放大被拒时档位原地不动、界面与状态一致，缩小立刻有效。
// 无头环境靠桩的"模拟引擎"复现：?zoomsim=1 给 window.devicePixelRatio 装假 getter
// （dpr = 1.25 × 引擎接受的缩放），再加 &zoomcap=1 就是"放大一律按 100% 处理"那台机器。
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

/** 导航到"模拟引擎"的页面并等界面就绪 */
const gotoSim = async (extra) => {
  await c.evaluate(`localStorage.clear()`);
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
  // 等状态**稳定**再断言：调档后还有"再确认一次"的复核（ZOOM_CONFIRM_DELAY_MS=250ms）+ 存档
  // 300ms 防抖，被引擎拒绝的档位正是靠这一拍拉回来的。固定等 700ms 在负载高时会读到"最后一次
  // 复核落地之前"的中间态（实测偶发红），改成"先等够下限，再轮询到连续两次读数相同"。
  await new Promise((r) => setTimeout(r, 900));
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

// B) 引擎只肯缩小（放大一律按 100% 处理）：档位必须停在引擎给的 100%，缩小立刻有效
await gotoSim("&zoomsim=1&zoomcap=1");
await wheelOverEditor(-100, 4);
const capped = await c.evaluate(zoomProbe2);
check(
  "引擎拒绝放大时，档位被拉回引擎实际给的 100%（不再冲上限）",
  Math.abs((capped.saved ?? 0) - 1) < 0.001 && Math.abs((capped.engine ?? 0) - 1) < 0.001,
  JSON.stringify(capped),
);
check(
  "状态栏说明是引擎限制，而不是静默没反应",
  capped.status.includes("未生效") && capped.status.includes("限制在 100%"),
  JSON.stringify(capped.status),
);
// 关键：接着往下滚必须立刻见效（这就是「最大后无法用滚轮缩小」那条反馈）
await wheelOverEditor(100, 1);
const afterOut = await c.evaluate(zoomProbe2);
check(
  "被拒之后立刻往下滚就能缩小（死区消失）",
  Math.abs((afterOut.saved ?? 0) - 0.9) < 0.001 && Math.abs((afterOut.engine ?? 0) - 0.9) < 0.02,
  JSON.stringify(afterOut),
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
check("Alt+Z 打开自动换行（cm-lineWrapping 生效）", wrapped.wrapping === true, JSON.stringify(wrapped));
check(
  "长行折行显示、横向溢出消失",
  wrapped.overflowX <= 2 && wrapped.lineHeight > singleLineHeight + 10,
  `溢出 ${wrapped.overflowX}px，行高 ${singleLineHeight} → ${wrapped.lineHeight}`,
);
check("状态栏说明开关状态", wrapped.status.includes("自动换行：开"), JSON.stringify(wrapped.status));
check("换行开关写进存档（下次启动仍是开的）", wrapped.saved === true, JSON.stringify(wrapped.saved));
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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
  zoom150.textPhysPx !== null && base.textPhysPx !== null && zoom150.textPhysPx / base.textPhysPx > 1.3,
  `字高 物理 ${base.textPhysPx}px → ${zoom150.textPhysPx}px（比 ${(zoom150.textPhysPx / base.textPhysPx).toFixed(3)}）`,
);
check(
  "150%：纸张宽度 = 栏宽（重排的必然：恒铺满栏宽，物理宽度不随缩放变；变大的是字不是纸张越界）",
  zoom150.canvasCss !== null && zoom150.container !== null && Math.abs(zoom150.canvasCss - zoom150.container) <= 2,
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

// 文档自己写了 #set page(...) 时注入会被覆盖 → 必须退回等比缩放，而不是硬套重排假设
const fallback = await loadPreviewAt(WIN, 2.5, "&reflowfail=1");
check(
  "文档自带纸型（注入被覆盖）时退回等比缩放路径，不假装重排生效",
  fallback.canvasCss !== null &&
    fallback.container !== null &&
    Math.abs(fallback.canvasCss - fallback.container) > 2,
  `画布 ${fallback.canvasCss} vs 栏宽 ${fallback.container}（退回等比缩放 ⇒ 画布不再等于栏宽）`,
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
check("空行输入 $ 自动补出 `$  $`（行间公式脚手架）", scaffold === "$  $", JSON.stringify(scaffold));

await c.type("x");
await new Promise((r) => setTimeout(r, 300));
const scaffoldTyped = await c.evaluate(cmText);
check("光标在中间：接着敲字直接得到 `$ x $`", scaffoldTyped === "$ x $", JSON.stringify(scaffoldTyped));

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
check("行内有别的字时补的是行内配对，敲字得到 `前文 $y$`", inlineTyped === "前文 $y$", JSON.stringify(inlineTyped));

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
check("重来一次仍是 `$  $`（脚手架与光标位置稳定）", beforePairDelete === "$  $", JSON.stringify(beforePairDelete));
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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

// 收尾：清回空文档并回写作模式
await c.selectAll();
await c.key("Backspace", { code: "Backspace", keyCode: 8 });
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));

console.log(`\n通过 ${passed} 项检查；截图：${SHOT("wysiwyg-*")}`);
c.close();
