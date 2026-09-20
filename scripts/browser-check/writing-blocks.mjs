// 写作模式「块级渲染」验收（阶段 1，2026-09-15）：真实浏览器 + 真实输入，验的是
// **非光标块显示成切片、光标所在块展开源码**这条链路。
//
// 为什么要单独一套、而且要 `&blocks=1`：
//   块切片会把非光标块整块换成图片，于是那块里的 `.cm-markup-heading`、公式 widget 等
//   **在 DOM 里不复存在**（设计如此）。既有的 `wysiwyg.mjs`（209 项）断言的是"标记装饰"
//   世界，把块渲染默认打开就会整片变红、把回归信号淹掉。所以：
//     - `wysiwyg.mjs`          → 块渲染**默认关**（走公式/标记路径，回归网原样有效）
//     - `writing-blocks.mjs`   → 带 `&blocks=1`，专验块级渲染
//   桩的开关见 src/lib/browser-dev-stub.ts 的 blocksStubEnabled。
//
// 前置：① `npm run dev -- --port 1425`；② 一个指向它的 headless Chromium（CDP）。
// 运行：`CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks.mjs`
//
// 注意：这里的切片是**桩产物**（browser-dev-stub 的 fakeBlocks），验的是"链路与交互"；
// 真实排版几何由 Rust 侧 block_geometry 的测试与真机（tauri dev）负责。
import { connect, DEV_URL } from "./cdp.mjs";

const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;
const URL_BLOCKS = `${DEV_URL}&blocks=1`;

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
await c.send("Page.enable");
await c.send("Runtime.enable"); // 第 12 组要读控制台（"装饰重建失败 / 插件崩了"）
// 先导航一次再清存档：冷启动时页面还停在 about:blank，那里读 localStorage 会抛 SecurityError
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.evaluate(`localStorage.clear()`); // 清掉上一轮验收留下的存档（可能是一篇长文档）
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

const CONTENT = `document.querySelector(".cm-content").textContent`;
/**
 * **编辑区里的正文行文本**（= 还是源码形态的那些块）。
 * 不能用 `.cm-content.textContent`：切片的 SVG 里也有渲染后的文字（真实产物同理），
 * 两者混在一起就分不出"这块是源码还是切片"了 —— 实测踩过这个坑。
 */
const LINES_TEXT = `Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent).join("\\n")`;
const CROPS = `document.querySelectorAll(".cm-block-crop").length`;
const DARK_CROPS = `document.querySelectorAll(".cm-block-crop-dark").length`;

/** 观察用的文档：标题 + 两段正文 + 列表 + 行间公式（覆盖多种块类型） */
const DOC =
  "= 章节标题\n" +
  "\n" +
  "第一段正文，用来当被切片盖住的那一块。\n" +
  "\n" +
  "第二段正文。\n" +
  "\n" +
  "$ x^2 + y^2 = z^2 $\n" +
  "\n" +
  "- 列表项\n";

console.log("1) 非光标块显示成切片，光标所在块保持源码");
await c.click(400, 300);
await c.selectAll();
await c.type(DOC);
await new Promise((r) => setTimeout(r, 600));
// 光标停在文档末尾（最后一块 = 列表项）→ 它应当是源码，其它块是切片
const crops = await c.evaluate(CROPS);
const linesText = await c.evaluate(LINES_TEXT);
const contentText = await c.evaluate(CONTENT);
check("非光标块被替换成切片（≥3 块）", crops >= 3, `实际 ${crops}`);
check("光标所在块（列表项）保持源码形态", linesText.includes("列表项"), JSON.stringify(linesText));
check(
  "被切片盖住的正文不再是源码形态",
  !linesText.includes("第一段正文"),
  JSON.stringify(linesText),
);
check("被切片盖住的标题不再是源码形态", !linesText.includes("章节标题"), JSON.stringify(linesText));
check(
  "标记只在源码形态里出现（标题的 `= ` 已随切片消失）",
  !contentText.includes("= 章节标题"),
  JSON.stringify(contentText),
);

console.log("2) 切片本身的几何：宽度贴合正文列宽、高度为正");
const geom = await c.evaluate(`(() => {
  const wrap = document.querySelector(".cm-block-crop");
  const svg = wrap?.querySelector("svg");
  const content = document.querySelector(".cm-content");
  if (!wrap || !svg || !content) return null;
  const wr = wrap.getBoundingClientRect();
  const cr = content.getBoundingClientRect();
  return { w: wr.width, h: wr.height, cw: cr.width, svgH: svg.getBoundingClientRect().height };
})()`);
check("切片铺满正文列宽（±2px）", !!geom && Math.abs(geom.w - geom.cw) <= 2, JSON.stringify(geom));
check("切片高度为正且内层 SVG 有高度", !!geom && geom.h > 4 && geom.svgH > 4, JSON.stringify(geom));

console.log("3) 点击切片 → 光标落到该块源码起点，该块展开、原活动块变成切片");
const firstCropY = await c.evaluate(`(() => {
  const r = document.querySelector(".cm-block-crop").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await c.click(firstCropY.x, firstCropY.y);
await new Promise((r) => setTimeout(r, 400));
const afterClick = await c.evaluate(LINES_TEXT);
const cropsAfter = await c.evaluate(CROPS);
check(
  "被点的那一块展开了源码（标题可见）",
  afterClick.includes("章节标题"),
  JSON.stringify(afterClick),
);
check("原来的活动块（列表项）变成切片", !afterClick.includes("列表项"), JSON.stringify(afterClick));
check("切片数量不变（换了一块而已）", cropsAfter === crops, `${crops} → ${cropsAfter}`);
check(
  "`= ` 标记重新出现在源码里（展开后能看到标记）",
  afterClick.includes("= 章节标题"),
  JSON.stringify(afterClick),
);
await c.screenshot(SHOT("writing-blocks-click"));

console.log("4) 活动块内仍可正常编辑（真实输入路径）");
await c.type("补充一句。");
await new Promise((r) => setTimeout(r, 500));
const afterType = await c.evaluate(LINES_TEXT);
check("输入的内容出现在编辑器里", afterType.includes("补充一句。"), JSON.stringify(afterType));
check("切片的块数没被输入打断", (await c.evaluate(CROPS)) === crops, "切片数变化");
check(
  "状态栏没有脚本错误（装饰异常会被上报）",
  !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"),
  "状态栏出现脚本错误",
);

console.log("5) 源码模式不受影响（Ctrl+/）：全部源码、无切片；切回来恢复切片");
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 }); // Ctrl+E 切模式（0.8.2 起 Ctrl+/ 归注释）
await new Promise((r) => setTimeout(r, 700));
check(
  "状态栏切到了源代码模式",
  (await c.evaluate(`document.querySelector(".mode-tag")?.textContent ?? ""`)) === "源码",
  "模式没切过去（Ctrl+/ 没生效）",
);
check("源码模式下没有切片", (await c.evaluate(CROPS)) === 0, "仍有切片");
check(
  "源码模式下正文全部可见",
  (await c.evaluate(LINES_TEXT)).includes("第一段正文"),
  "源码未显示",
);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
check("切回写作模式后切片回来", (await c.evaluate(CROPS)) >= 1, "没有切片");

console.log("6) 暗色主题：切片挂 cm-block-crop-dark（白底黑字的切片要整体反色）");
await c.evaluate(`localStorage.setItem("typst-pad:state", JSON.stringify({ theme: "dark" }))`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type(DOC);
await new Promise((r) => setTimeout(r, 700));
check(
  "暗色下切片带 cm-block-crop-dark",
  (await c.evaluate(DARK_CROPS)) >= 1,
  `切片 ${await c.evaluate(CROPS)} / 暗色切片 ${await c.evaluate(DARK_CROPS)}`,
);
await c.screenshot(SHOT("writing-blocks-dark"));

console.log("7) 长文档 + 窗口化：滚动到没渲过的区域 → 去抖后补渲出切片");
// 换成浅色主题 + 重新载入，再**直接输入**长文档（不依赖存档恢复）
await c.evaluate(`localStorage.setItem("typst-pad:state", JSON.stringify({ theme: "light" }))`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
// 每段 ≈ 90 字符 × 120 段 ≈ 10800 字符 > 窗口化阈值（BLOCK_WINDOW_MARGIN×2 = 8000）
const SENTENCE = "这一段用来把文档撑过写作模式块级渲染的窗口化阈值，观察滚动时的补渲行为。";
// **段落之间要有空行**：没有空行的话整篇就是一个块，光标一进去它整篇都是"活动块"，
// 切片数会是 0（实测踩过）。
const longDoc = Array.from({ length: 120 }, (_, i) => `第 ${i} 段。` + SENTENCE.repeat(3)).join(
  "\n\n",
);
await c.click(400, 300);
await c.selectAll();
await c.type(longDoc);
await new Promise((r) => setTimeout(r, 900));
const longCropsBefore = await c.evaluate(CROPS);
// 滚到底部（滚轮走真实事件路径）
await c.wheel(700, 400, 4000);
await new Promise((r) => setTimeout(r, 400));
await c.wheel(700, 400, 4000);
await new Promise((r) => setTimeout(r, 1500)); // 等去抖 150ms + 假编译
const longCropsAfter = await c.evaluate(CROPS);
const tailVisible = await c.evaluate(
  `document.querySelector(".cm-content").textContent.includes("第 119 段")`,
);
// 文档长度从状态栏读（`.cm-content` 只含视口附近的行，CM 会虚拟化，量不到全文）
const docLen = await c.evaluate(
  `Number((document.body.innerText.match(/(\\d+)\\s*字符/) ?? [0, 0])[1])`,
);
const wantWindowed = 8400; // 阈值 = BLOCK_WINDOW_MARGIN(4000) × 2 + 余量
check("文档确实超过窗口化阈值", docLen > wantWindowed, `实际 ${docLen}`);
check("长文档启动时窗口内就有切片", longCropsBefore >= 1, `实际 ${longCropsBefore}`);
check("滚动到底部后仍有切片（窗口跟着视口走）", longCropsAfter >= 1, `实际 ${longCropsAfter}`);
check("滚到的位置能看到该块的源码或切片", tailVisible || longCropsAfter > 0, "底部什么都没显示");
await c.screenshot(SHOT("writing-blocks-long"));

console.log(
  "8) 竖直移动 = 代码模式：逐源码行走、空行也停、列保留、Shift 扩选（用户：「光标移动和代码模式的光标移动一样」）",
);
// 历史：这一组以前锁的是"一次跨一整块"（从段落末行直接进下一段、向上落到上一块末字符），
// 理由写在 block-plan.verticalBlockTarget 里。用户 2026-09-16 明确要求「和代码模式一样」→
// 现在改成：默认走法**没跨过切片**就完全交回 CodeMirror（逐可见行、空行也停、列保留），
// 跨过了才按**源码行**走一行（落点在切片里 → 那一块展开）。判定见 block-plan 的
// crossesCollapsedCover + sourceVerticalTarget。
// "按上不许跳回文档开头"这条仍然锁在这里：CodeMirror 的竖直移动会跳过所有 widget，
// 一路扫到内容顶部返回**位置 0**（用户报过「在 == 6 前面按上跳回开头」）。
await c.evaluate(`localStorage.setItem("typst-pad:state", JSON.stringify({ theme: "light" }))`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type("= 标题\n\n第一段。\n\n- 列表项\n\n最后一段。\n");
await new Promise((r) => setTimeout(r, 800));

/** 当前"源码形态"的块文本（切片里的文字不算 —— 它们在 widget 里） */
const REVEALED = `Array.from(document.querySelectorAll(".cm-line")).map((el) => (el.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean)`;
const revealedNow = async () => (await c.evaluate(REVEALED)).join(" | ");
/**
 * 光标所在的**源码行**（第几行、第几列、行文本）+ 光标的屏幕 x + 当前展开的块文本。
 * 逐行移动的验收全靠它：空行上没有文本，"光标在哪一行"只能这样读。
 */
const CARET = `(() => {
  const el = document.querySelector(".cm-content");
  const view = el && el.cmTile && el.cmTile.root && el.cmTile.root.view;
  if (!view) return null;
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  const coords = view.coordsAtPos(sel.head, sel.assoc);
  return {
    head: sel.head,
    anchor: sel.anchor,
    empty: sel.empty,
    line: line.number,
    col: sel.head - line.from,
    lineText: line.text,
    docLines: view.state.doc.lines,
    docLength: view.state.doc.length,
    x: coords ? coords.left : null,
    revealed: Array.from(document.querySelectorAll(".cm-line"))
      .map((e) => (e.textContent || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .join(" | "),
  };
})()`;
const caret = () => c.evaluate(CARET);
const arrowDown = async () => {
  await c.key("ArrowDown", { code: "ArrowDown", keyCode: 40 });
  await new Promise((r) => setTimeout(r, 250));
  return caret();
};
const arrowUp = async () => {
  await c.key("ArrowUp", { code: "ArrowUp", keyCode: 38 });
  await new Promise((r) => setTimeout(r, 250));
  return caret();
};

await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home → 文档开头（第一块）
await new Promise((r) => setTimeout(r, 400));
const start = await caret();
check(
  `起点：光标在第 1 行第 1 列（标题块展开源码）`,
  start.line === 1 && start.col === 0 && start.revealed.includes("标题"),
  JSON.stringify(start),
);

// ① ↓ 逐行走：段落之间那条空行也要停一拍（代码模式如此）
const d1 = await arrowDown();
check(
  `↓ 一次 → 第 2 行（段落之间那条空行，不是直接进下一段）`,
  d1.line === 2 && d1.lineText === "" && d1.revealed.includes("标题"),
  JSON.stringify(d1),
);
const d2 = await arrowDown();
check(
  `↓ 再一次 → 第 3 行第 1 列（下一块正文开头，那一块因此展开）`,
  d2.line === 3 &&
    d2.col === 0 &&
    d2.lineText.startsWith("第一段") &&
    d2.revealed.includes("第一段"),
  JSON.stringify(d2),
);
check(
  `跨到下一块之后，上一块照旧变回切片（标题不在源码形态里）`,
  !d2.revealed.includes("标题"),
  d2.revealed,
);
// ② ↑ 逐行走：第二块行首的上面是那条空行（不是上一块的行尾、更不是文档开头）
const u1 = await arrowUp();
check(
  `↑ 一次 → 回到第 2 行（空行；不是上一块的末字符、不是文档开头）`,
  u1.line === 2 && u1.head !== 0,
  JSON.stringify(u1),
);
const u2 = await arrowUp();
// 落点允许是第 1~3 列：写作模式把标题的 `= ` 标记**藏起来**了（位置 0~2 都在被藏的那一段里），
// 所以"行首可见文本处"就是位置 2 —— 与"点在标题行最左边"落到的位置一致。
check(
  `↑ 再一次 → 第 1 行（列 ${u2.col} 落在标题行首，写作模式藏了 \`= \` 标记）`,
  u2.line === 1 && u2.col <= 2,
  JSON.stringify(u2),
);
check(`连续 ↑ 到底也没有跳回/跳过（停在位置 ${u2.head}）`, u2.head <= 2, JSON.stringify(u2));

// ③ 列保留：从段落行尾往下走两行，光标仍落在**同一水平位置**上（代码模式的目标列语义）
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
await arrowDown(); // → 空行
await arrowDown(); // → 第一段
await c.key("End", { code: "End", keyCode: 35 }); // 行尾
await new Promise((r) => setTimeout(r, 250));
const colStart = await caret();
const colStep1 = await arrowDown(); // → 空行（夹到第 1 列）
const colStep2 = await arrowDown(); // → 列表项那一行
check(
  `列保留：从「第一段。」行尾（列 ${colStart.col}）往下两行后仍在同一水平位置（x ${colStart.x?.toFixed(0) ?? "?"} → ${colStep2.x?.toFixed(0) ?? "?"}）`,
  colStep1.lineText === "" &&
    colStep2.lineText.startsWith("- 列表项") &&
    colStart.x !== null &&
    colStep2.x !== null &&
    Math.abs(colStep2.x - colStart.x) <= 16,
  JSON.stringify({ colStart, colStep1: colStep1.head, colStep2 }),
);

// ④ 从文档末尾连续 ↑：**一次一行**地往回走，绝不跳回文档开头（原来那条用户报的 bug）
await c.key("End", { code: "End", keyCode: 35, modifiers: 2 }); // Ctrl+End → 文档末尾
await new Promise((r) => setTimeout(r, 400));
const fromEnd = await caret();
check(
  "起点：光标在文档末尾（最后一块展开源码）",
  fromEnd.revealed.includes("最后一段"),
  JSON.stringify(fromEnd),
);
const ups = [fromEnd];
for (let i = 0; i < 5; i++) ups.push(await arrowUp());
const backwards = ups.slice(1).every((s, i) => s.line === ups[i].line - 1);
check(
  `连续 ↑ 每次只退一行（行号 ${ups.map((s) => s.line).join(" → ")}）`,
  backwards,
  JSON.stringify(ups.map((s) => ({ line: s.line, col: s.col, head: s.head }))),
);
check(
  `第一次按上不会直接跳回文档开头（位置 ${ups[1].head}）`,
  ups[1].head !== 0,
  JSON.stringify(ups[1]),
);
check(
  "按到第 1 行后不再动（位置 0）",
  ups[ups.length - 1].line > 1 || ups[ups.length - 1].head === 0,
  JSON.stringify(ups[ups.length - 1]),
);
check("状态栏没有脚本错误", !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"));

// ⑤ Shift+↓：扩选也走同一套语义（过去没接管 → CodeMirror 默认会跳过整块切片）
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
const shiftStart = await caret();
await c.key("ArrowDown", { code: "ArrowDown", keyCode: 40, modifiers: 8 }); // Shift+↓
await new Promise((r) => setTimeout(r, 250));
const shift1 = await caret();
await c.key("ArrowDown", { code: "ArrowDown", keyCode: 40, modifiers: 8 });
await new Promise((r) => setTimeout(r, 250));
const shift2 = await caret();
check(
  `Shift+↓ 逐行扩选（行号 ${shiftStart.line} → ${shift1.line} → ${shift2.line}，anchor 不动）`,
  !shift2.empty &&
    shift2.anchor === shiftStart.head &&
    shift1.line === shiftStart.line + 1 &&
    shift2.line === shiftStart.line + 2 &&
    shift2.head < shift2.docLength,
  JSON.stringify({ shiftStart, shift1, shift2 }),
);
await c.key("ArrowUp", { code: "ArrowUp", keyCode: 38 }); // 收起选区（非空选区按 ↑ = 收到一端）
await new Promise((r) => setTimeout(r, 250));

// ---------------------------------------------------------------------------
// 阶段 2：点击定位 / 点击与刷新时的滚动锚定 / 翻页 / 编译失败不整篇作废
// ---------------------------------------------------------------------------
/**
 * 取数小工具（验收专用）：CodeMirror 的 EditorView 挂在内容元素的 DOM 瓦片上
 * （`el.cmTile.root.view`），用它读光标位置、滚动量与视口高度 —— 比从 DOM 里反推可靠得多。
 * 页面代码本身不依赖这个钩子（只有验收脚本用）。
 */
const VIEW = `(() => {
  const el = document.querySelector(".cm-content");
  const view = el && el.cmTile && el.cmTile.root && el.cmTile.root.view;
  if (!view) return null;
  const s = view.scrollDOM;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  const line = document.querySelector(".cm-line");
  return {
    head,
    anchor: view.state.selection.main.anchor,
    docLength: view.state.doc.length,
    scrollTop: s.scrollTop,
    maxScroll: s.scrollHeight - s.clientHeight,
    clientHeight: s.clientHeight,
    caretY: coords ? (coords.top + coords.bottom) / 2 : null,
    // 行高用 CodeMirror 自己的值：.cm-line 的矩形高度在折行段落里是"好几行"的高度
    lineHeight: view.defaultLineHeight,
    text: view.state.doc.toString(),
  };
})()`;

/** 视口里"最完整地露在中间"的一张切片（矩形 + 块起点）—— 点击类用例都从它下手 */
const MIDDLE_CROP = `(() => {
  const list = Array.from(document.querySelectorAll(".cm-block-crop"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.height > 8 && r.bottom > 120 && r.top < innerHeight - 120)
    .sort((a, b) => a.r.top - b.r.top);
  const pick = list[0];
  if (!pick) return null;
  const { el, r } = pick;
  return { from: Number(el.dataset.blockFrom), left: r.left, top: r.top, width: r.width, height: r.height };
})()`;

console.log("9) 点击定位：点切片上的字 → 光标落到那一块里的对应位置（+ 点击锚定）");
await c.evaluate(`localStorage.setItem("typst-pad:state", JSON.stringify({ theme: "light" }))`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type(longDoc);
await new Promise((r) => setTimeout(r, 900));
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home：第一块成为活动块
await new Promise((r) => setTimeout(r, 400));
await c.wheel(700, 400, 1800); // 往下滚一段，让"目标块"上方还有内容（这样锚定才有滚动余量）
await new Promise((r) => setTimeout(r, 1400)); // 等窗口化补渲

const midCrop = await c.evaluate(MIDDLE_CROP);
check("视口中间找得到一张切片", midCrop !== null, JSON.stringify(midCrop));
if (!midCrop) throw new Error("视口中间没有切片，这一组（点击锚定）无法进行");
{
  // 点在切片的下半部分（横向上偏左）：光标应当落到这一块里更靠后的字符上
  const cx = Math.round(midCrop.left + midCrop.width * 0.3);
  const cyLow = Math.round(midCrop.top + midCrop.height * 0.75);
  await c.click(cx, cyLow);
  await new Promise((r) => setTimeout(r, 400));
  const st = await c.evaluate(VIEW);
  // 块正文（从块起点到第一个空行）：命中结果必须落在它里面
  const seg = st.text.slice(midCrop.from);
  const blockEnd = seg.indexOf("\n\n");
  const blockChars = blockEnd < 0 ? seg.length : blockEnd;
  check(
    "点击后光标落在被点的那一块里（不是块首、也不是别的块）",
    st.head >= midCrop.from && st.head <= midCrop.from + blockChars,
    JSON.stringify({ head: st.head, from: midCrop.from, blockChars }),
  );
  check(
    "点在切片下半部分 → 光标落在该块靠后的位置（不是块首）",
    st.head > midCrop.from,
    JSON.stringify({ head: st.head, from: midCrop.from }),
  );
  const drift = st.caretY === null ? 0 : Math.abs(st.caretY - cyLow);
  check(
    `点击锚定：被点的字符仍留在鼠标那一带（偏移 ${drift.toFixed(0)}px / 行高 ${st.lineHeight.toFixed(0)}px，滚动 ${st.scrollTop.toFixed(0)}）`,
    st.maxScroll > 0 && drift <= st.lineHeight * 0.8,
    JSON.stringify({
      drift,
      lineHeight: st.lineHeight,
      maxScroll: st.maxScroll,
      clickY: cyLow,
      caretY: st.caretY,
    }),
  );
  const cropsAfterClick = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => Number(el.dataset.blockFrom))`,
  );
  check(
    "被点的块变回源码（不再有切片）、别的块仍然是切片",
    !cropsAfterClick.includes(midCrop.from) && cropsAfterClick.length > 0,
    JSON.stringify({ cropsAfterClick: cropsAfterClick.length, from: midCrop.from }),
  );
  await c.screenshot(SHOT("writing-blocks-hit"));
}

console.log("10) 翻页：PageDown/PageUp 走一屏，不跳到文档末尾/开头");
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home
await new Promise((r) => setTimeout(r, 400));
const page0 = await c.evaluate(VIEW);
await c.key("PageDown", { code: "PageDown", keyCode: 34 });
await new Promise((r) => setTimeout(r, 500));
const page1 = await c.evaluate(VIEW);
check(
  `PageDown 从开头翻到文档中段（位置 ${page0.head} → ${page1.head}，全文 ${page1.docLength}）`,
  page1.head > page0.head && page1.head < page1.docLength * 0.6,
  JSON.stringify({ head: page1.head, docLength: page1.docLength }),
);
check(
  `PageDown 同时往下滚了（${page0.scrollTop.toFixed(0)} → ${page1.scrollTop.toFixed(0)}，视口 ${page1.clientHeight.toFixed(0)}px）`,
  page1.scrollTop > page0.scrollTop + 100,
  JSON.stringify({ from: page0.scrollTop, to: page1.scrollTop }),
);
check(
  `PageDown 后光标仍停在原来的屏幕高度（${page0.caretY?.toFixed(0) ?? "?"} → ${page1.caretY?.toFixed(0) ?? "?"}）`,
  page0.caretY === null ||
    page1.caretY === null ||
    Math.abs(page1.caretY - page0.caretY) <= page1.lineHeight * 1.5,
  JSON.stringify({ before: page0.caretY, after: page1.caretY }),
);
await c.key("PageDown", { code: "PageDown", keyCode: 34 });
await new Promise((r) => setTimeout(r, 400));
await c.key("PageDown", { code: "PageDown", keyCode: 34 });
await new Promise((r) => setTimeout(r, 400));
const page3 = await c.evaluate(VIEW);
check(
  "连续 PageDown 单调前进",
  page3.head > page1.head && page3.scrollTop > page1.scrollTop,
  JSON.stringify({ h1: page1.head, h3: page3.head }),
);
await c.key("PageUp", { code: "PageUp", keyCode: 33 });
await new Promise((r) => setTimeout(r, 400));
const pageUp = await c.evaluate(VIEW);
check(
  "PageUp 往回走（位置变小、滚动变小）",
  pageUp.head < page3.head && pageUp.scrollTop < page3.scrollTop,
  JSON.stringify({ up: pageUp.head, before: page3.head }),
);
await c.key("PageUp", { code: "PageUp", keyCode: 33, modifiers: 8 }); // Shift+PageUp
await new Promise((r) => setTimeout(r, 400));
const shiftUp = await c.evaluate(VIEW);
check(
  "Shift+PageUp 仍然是选区扩展（anchor 不动、head 往回走）",
  shiftUp.anchor > shiftUp.head,
  JSON.stringify({ anchor: shiftUp.anchor, head: shiftUp.head }),
);

// 两端：到头之后**不许绕过所有切片跳到另一头**（默认翻页在写作模式里就是这个毛病）
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home → 文档开头
await new Promise((r) => setTimeout(r, 400));
await c.key("PageUp", { code: "PageUp", keyCode: 33 });
await new Promise((r) => setTimeout(r, 400));
const topPage = await c.evaluate(VIEW);
check(
  `在文档开头按 PageUp 不会跳到文档末尾（位置 ${topPage.head} / ${topPage.docLength}）`,
  topPage.head < topPage.docLength * 0.1,
  JSON.stringify(topPage),
);
await c.key("End", { code: "End", keyCode: 35, modifiers: 2 }); // Ctrl+End → 文档末尾
await new Promise((r) => setTimeout(r, 400));
await c.key("PageDown", { code: "PageDown", keyCode: 34 });
await new Promise((r) => setTimeout(r, 400));
const botPage = await c.evaluate(VIEW);
check(
  `在文档末尾按 PageDown 不会绕回文档开头（位置 ${botPage.head} / ${botPage.docLength}）`,
  botPage.head > botPage.docLength * 0.9,
  JSON.stringify(botPage),
);
// "已经滚到底、光标还在上面"时也必须真的走一屏 —— 修前这里会把位移夹成 0、交回默认翻页（= 跳到文档末尾）
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));
await c.evaluate(`document.querySelector(".cm-scroller").scrollTop = 1e9`);
await new Promise((r) => setTimeout(r, 400));
const stuck0 = await c.evaluate(VIEW);
await c.key("PageDown", { code: "PageDown", keyCode: 34 });
await new Promise((r) => setTimeout(r, 500));
const stuck1 = await c.evaluate(VIEW);
check(
  `滚到底再按 PageDown 仍然往前走一屏（位置 ${stuck0.head} → ${stuck1.head}，全文 ${stuck1.docLength}）`,
  stuck1.head > stuck0.head && stuck1.head < stuck1.docLength * 0.5,
  JSON.stringify({ before: stuck0.head, after: stuck1.head, docLength: stuck1.docLength }),
);

console.log("11) 编译失败：保留没被改到的切片 + 错误所在块看得到（阶段 2）");
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type(
  "第一段正文，用来验证编译失败时的取舍。\n\n第二段正文。\n\n第三段正文。\n\n第四段正文。\n\n第五段正文。\n",
);
await new Promise((r) => setTimeout(r, 900));
const beforeErr = await c.evaluate(CROPS);
check("失败前：非光标块是切片", beforeErr >= 3, `实际 ${beforeErr}`);
// 点中间那张切片 → 光标进到那一块，再插入 @err（桩据此返回"这一行有编译错误"）
const target = await c.evaluate(MIDDLE_CROP);
// 这一段下面挂着 6 条断言（编译失败时的取舍），**不能**写成 `if (target) { ... }`：
// 那样"没找到目标块"和"都验过了"看起来一样（PR #60 审查的第 12 条）。
check("编译失败这组的前提：视口中间找得到目标切片", !!target, JSON.stringify(target));
if (!target) throw new Error("中间没有切片，编译失败那组无法进行");
{
  await c.click(
    Math.round(target.left + target.width * 0.4),
    Math.round(target.top + target.height * 0.5),
  );
  await new Promise((r) => setTimeout(r, 350));
  await c.type("@err");
  await new Promise((r) => setTimeout(r, 900));
  const cropsAfterErr = await c.evaluate(CROPS);
  const cropFroms = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => Number(el.dataset.blockFrom))`,
  );
  const linesAfterErr = await c.evaluate(LINES_TEXT);
  const statusText = await c.evaluate(`document.body.innerText`);
  check(
    "编译失败后**没有整篇退回源码**（其它块的切片还在）",
    cropsAfterErr >= 2,
    `实际 ${cropsAfterErr} 张（失败前 ${beforeErr}）`,
  );
  check(
    "出错的那一块退回源码（它的起点不再有切片）",
    !cropFroms.includes(target.from),
    JSON.stringify({ cropFroms, from: target.from }),
  );
  check(
    "出错的源码可见（能读到 @err）",
    linesAfterErr.includes("@err"),
    linesAfterErr.slice(0, 120),
  );
  check(
    "状态栏仍然报出编译错误",
    /编译错误/.test(statusText),
    statusText.replace(/\s+/g, " ").slice(0, 120),
  );
  check(
    "错误位置有红色波浪线（切片盖不住它，见 revealBlocksWithDiagnostics）",
    (await c.evaluate(`document.querySelectorAll(".cm-diag-wavy").length`)) > 0,
  );
  await c.screenshot(SHOT("writing-blocks-compile-error"));
  // 改好：删掉 4 个字符 → 编译恢复 → 点到别的块之后，之前那块也变回切片
  for (let i = 0; i < 4; i++) {
    await c.key("Backspace", { code: "Backspace", keyCode: 8 });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 800));
  const other = await c.evaluate(MIDDLE_CROP);
  // **别写成 `if (other) {...}`**：那样"中间那块根本不在视口里"与"验过了"看起来一样，
  // 整条断言静默消失（PR #60 审查的第 12 条）。前置断言代替静默跳过。
  check("编译恢复后中间那块仍在视口里（下面那条断言的前提）", !!other, JSON.stringify(other));
  if (!other) throw new Error("中间块不在视口里，第 11 组的恢复断言无法进行");
  await c.click(
    Math.round(other.left + other.width * 0.4),
    Math.round(other.top + other.height * 0.5),
  );
  await new Promise((r) => setTimeout(r, 500));
  const cropFromsFixed = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => Number(el.dataset.blockFrom))`,
  );
  check(
    "改好之后那一块重新变回切片（编译恢复）",
    cropFromsFixed.includes(target.from),
    JSON.stringify({ cropFromsFixed, from: target.from }),
  );
}

console.log(
  "12) 块内按 Enter 插入新块：旧表那段时间里刚打的字不许被切片吞掉（真机编译有延迟，桩用 &blockslow=1 模拟）",
);
// 为什么单独一组：真实的 typst 编译要几十到几百毫秒，而**块表是上一次编译的产物** ——
// 这段"旧表 + 新文档"的窗口里，旧坐标放在新文档上会算错行，于是要么刚打的字被旁边那张旧切片
// 盖住（看不见）、要么同一段文字既在切片里又露成源码（重复）。桩的假编译是瞬时的，默认复现不出来。
/** 控制台事件从这一组开始算（c.events 是整场累积的，别把前面几组的旧记录算进来） */
const consoleMark = c.events.length;
await c.goto(`${URL_BLOCKS}&blockslow=1`);
await c.click(400, 300);
await c.selectAll();
await c.type("第一段。\n\n第二段。\n\n第三段。\n");
await new Promise((r) => setTimeout(r, 1200)); // 等慢编译落地
const slowCrops = await c.evaluate(CROPS);
check("慢编译下切片仍然出来（块级渲染没被延迟搞坏）", slowCrops >= 2, `实际 ${slowCrops}`);

/** 标记文本此刻**看得见吗**：要么在源码行里，要么在"渲染时确实包含了它"的切片里 */
const MARK_VISIBLE = (mark) => `(() => {
  const inSource = Array.from(document.querySelectorAll(".cm-line")).some((el) => (el.textContent || "").includes(${JSON.stringify(mark)}));
  const inCrop = Array.from(document.querySelectorAll(".cm-block-crop")).some((el) => (el.textContent || "").includes(${JSON.stringify(mark)}));
  return { inSource, inCrop, visible: inSource || inCrop };
})()`;

/**
 * **文字跑哪去了**探针：文档里每个**非空行**要么在源码行里、要么在某张切片渲染的内容里
 * （假切片的 SVG 里有 `<text>`，正文就是它渲染的文本）。两者都找不到 = 那一行被一张
 * **内容对不上的旧切片**盖住了 —— 用户看到的是"我刚按了 Enter，某一段文字变成了别的段落的样子"。
 * 这正是"旧表 + 新文档"那段时间最容易出的毛病（真机编译有延迟，桩用 &blockslow=1 模拟）。
 *
 * 另外一条：源码行**不该**同时出现在某张切片渲染的文本里（那是"同一段文字既在切片里又露成源码"，
 * 看起来像重复）。两条合起来就是"不多不少"。
 */
const TEXT_MISMATCH = `(() => {
  const crops = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => (el.textContent || "").trim());
  const lines = Array.from(document.querySelectorAll(".cm-line")).map((el) => (el.textContent || "").trim());
  const view = document.querySelector(".cm-content").cmTile.root.view;
  const docLines = view.state.doc.toString().split("\\n").map((t) => t.trim()).filter((t) => t.length >= 2);
  const missing = docLines.filter((t) => !lines.includes(t) && !crops.some((crop) => crop && crop.includes(t)));
  const dup = lines.filter((t) => t.length >= 2 && crops.some((crop) => crop && crop.includes(t)));
  return { missing, dup };
})()`;

// 场景 A：在文档**开头**插入一个新块（先 Ctrl+Home 把光标放到第一块之前）
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 300));
await c.key("Enter", { code: "Enter", keyCode: 13 });
await new Promise((r) => setTimeout(r, 40));
await c.key("Enter", { code: "Enter", keyCode: 13 });
await new Promise((r) => setTimeout(r, 40));
const headMark = "开头插入的新块。";
await c.type(headMark);
await new Promise((r) => setTimeout(r, 80)); // 仍在慢编译窗口里
const headDuring = await c.evaluate(MARK_VISIBLE(headMark));
check("在文档开头插入新块：刚打的字立刻可见", headDuring.visible, JSON.stringify(headDuring));
const mismatch = await c.evaluate(TEXT_MISMATCH);
check(
  "插入新块后正文一行都没丢（要么在源码里、要么在渲染了它的切片里）",
  mismatch.missing.length === 0,
  JSON.stringify(mismatch),
);
check(
  "也没有「重复显示」（同一段文字既在切片里又露成源码）",
  mismatch.dup.length === 0,
  JSON.stringify(mismatch.dup.slice(0, 2)),
);
await new Promise((r) => setTimeout(r, 900)); // 等慢编译回来

// 场景 B：点进第二段中间（让它展开成源码），再按 Enter 拆成两行，然后马上打字（编译还没回来）
const midCrop2 = await c.evaluate(MIDDLE_CROP);
check("慢编译下仍能点进某一块", midCrop2 !== null, JSON.stringify(midCrop2));
if (midCrop2) {
  await c.click(
    Math.round(midCrop2.left + midCrop2.width * 0.35),
    Math.round(midCrop2.top + midCrop2.height * 0.5),
  );
  await new Promise((r) => setTimeout(r, 400));
  await c.key("Enter", { code: "Enter", keyCode: 13 });
  await new Promise((r) => setTimeout(r, 60));
  const mark = "新插入的段落";
  await c.type(mark);
  await new Promise((r) => setTimeout(r, 80)); // 仍然在慢编译的窗口里
  const during = await c.evaluate(MARK_VISIBLE(mark));
  check(
    "编译还没回来时，刚打的字立刻可见（没有被旧切片吞掉）",
    during.visible,
    JSON.stringify(during),
  );
  await new Promise((r) => setTimeout(r, 900)); // 等这一轮慢编译回来
  const afterSlow = await c.evaluate(MARK_VISIBLE(mark));
  check(
    "编译回来后仍然看得见（源码或渲染时含它的切片）",
    afterSlow.visible,
    JSON.stringify(afterSlow),
  );
  const linesWithMark = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent).filter((t) => t.includes(${JSON.stringify(mark)})).length`,
  );
  check(
    "标记文本只出现一处，不重复（隐藏的那份 + 露出的一份）",
    linesWithMark <= 1,
    `出现在 ${linesWithMark} 行`,
  );
  const slowCropsNow = await c.evaluate(CROPS);
  check("插入新块之后仍然有切片（其余块照旧渲染）", slowCropsNow >= 2, `实际 ${slowCropsNow}`);
  const mismatchBefore = await c.evaluate(MARK_VISIBLE(mark));
  const mismatch2 = await c.evaluate(TEXT_MISMATCH);
  check("块内拆行之后正文一行都没丢", mismatch2.missing.length === 0, JSON.stringify(mismatch2));
  check(
    "块内拆行也没有「重复显示」",
    mismatch2.dup.length === 0,
    JSON.stringify(mismatch2.dup.slice(0, 2)),
  );
  check("拆行后的标记文本仍然可见", mismatchBefore.visible, JSON.stringify(mismatchBefore));
  await c.screenshot(SHOT("writing-blocks-enter"));
}

// 场景 C：文档**大幅缩短**（全选重打 / 删一大段 / 撤销）——旧块表的坐标落在新文档之外，
// 一拍没接住就会在 CodeMirror 里抛 RangeError（"Invalid position 116 in document of length 17"），
// 表现是整篇退回源码 + 控制台一片红。
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 200));
await c.selectAll();
await c.type("短文档。\n\n第二段。\n");
await new Promise((r) => setTimeout(r, 900));
const shortState = await c.evaluate(`(() => {
  const view = document.querySelector(".cm-content").cmTile.root.view;
  return { len: view.state.doc.length, head: view.state.selection.main.head };
})()`);
check("全选重打之后文档确实变短了", shortState.len < 40, JSON.stringify(shortState));
const shortVisible = await c.evaluate(
  `document.querySelector(".cm-content").textContent.includes("短文档")`,
);
check("缩短后的正文看得见（没有整篇卡在源码/空白）", shortVisible);

// 控制台不许出现"装饰重建失败 / 插件崩了"——那段"旧表 + 新文档"的窗口最容易把它们引出来
const badConsole = [];
for (const ev of c.events.slice(consoleMark)) {
  if (ev.method !== "Runtime.consoleAPICalled") continue;
  const txt = (ev.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  if (/plugin crashed|装饰重建失败|Invalid position/.test(txt)) badConsole.push(txt.slice(0, 700));
}
if (badConsole.length) console.log("  控制台原文：\n" + badConsole.join("\n---\n"));
check(
  "整组过程中没有「装饰重建失败 / CodeMirror plugin crashed / Invalid position」",
  badConsole.length === 0,
  JSON.stringify(badConsole.slice(0, 1)),
);

console.log(
  "13) 各种输入：打字 / 回车 / 退格 / 删除 / 撤销 / 粘贴 / 缩进 / 公式 / 全选重打 —— 每个动作之后正文都得看得见",
);
// 与第 12 组同一套判据（那段"旧表 + 新文档"的窗口），但把**常见编辑动作**逐个走一遍：
// 每做完一个动作就立刻打一个标记词，然后检查「标记看得见 / 一行都没丢 / 不重复 / 切片还在 / 控制台干净」。
const CONSOLE_MARK = c.events.length;
const BASE_DOC = "第一段。\n\n第二段。\n\n第三段。\n";

const home = () => c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home → 文首
const end = () => c.key("End", { code: "End", keyCode: 35, modifiers: 2 }); // Ctrl+End → 文末
const right = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    await c.key("ArrowRight", { code: "ArrowRight", keyCode: 39 });
    await new Promise((r) => setTimeout(r, 40));
  }
};
const resetDoc = async () => {
  await c.click(400, 300);
  await c.selectAll();
  await c.type(BASE_DOC);
  await new Promise((r) => setTimeout(r, 800)); // 等这一轮慢编译落地
};

const SCENARIOS = [
  {
    name: "段中打字",
    act: async () => {
      await home();
      await right(3);
      await c.type("插字");
    },
  },
  {
    name: "段尾回车（新建一段）",
    act: async () => {
      await home();
      await right(4);
      await c.key("Enter", { code: "Enter", keyCode: 13 });
    },
  },
  {
    name: "段首回车（前面插一段）",
    act: async () => {
      await home();
      await c.key("Enter", { code: "Enter", keyCode: 13 });
    },
  },
  {
    name: "段中回车（把一段拆成两行）",
    act: async () => {
      await home();
      await right(2);
      await c.key("Enter", { code: "Enter", keyCode: 13 });
    },
  },
  {
    name: "连按两次回车（插入新块）",
    act: async () => {
      await home();
      await right(4);
      await c.key("Enter", { code: "Enter", keyCode: 13 });
      await c.key("Enter", { code: "Enter", keyCode: 13 });
    },
  },
  {
    name: "退格吃掉上一行的换行（两段合并）",
    act: async () => {
      await home();
      await right(4);
      await right(1);
      await c.key("Backspace", { code: "Backspace", keyCode: 8 });
    },
  },
  {
    name: "选中一整段删掉",
    act: async () => {
      await home();
      await right(3);
      await c.key("End", { code: "End", keyCode: 35 });
      await c.key("Backspace", { code: "Backspace", keyCode: 8 });
    },
  },
  {
    name: "打完字再撤销（Ctrl+Z）",
    act: async () => {
      await home();
      await right(2);
      await c.type("临时");
      await new Promise((r) => setTimeout(r, 120));
      await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
    },
  },
  {
    name: "粘贴多段文本（一次插入一大段）",
    act: async () => {
      await home();
      await c.type("新段一。\n\n新段二。\n\n");
    },
  },
  {
    name: "Tab 缩进行首",
    act: async () => {
      await home();
      await c.key("Tab", { code: "Tab", keyCode: 9 });
    },
  },
  {
    name: "输入 `$` 起一个行间公式",
    act: async () => {
      await home();
      await c.key("Enter", { code: "Enter", keyCode: 13 });
      await c.type("$");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  {
    name: "全选重打（换一份短文档）",
    act: async () => {
      await c.selectAll();
      await c.type("短。\n\n又一段。\n");
      // CDP 的整段 insertText 替换选区之后，浏览器会把插入的文本重新选中（真实打字是一键一字，
      // 不会遇到）—— 这里显式把光标收到文末，免得后面的标记把它整段替换掉
      await c.key("End", { code: "End", keyCode: 35, modifiers: 2 });
    },
  },
];

let inputChecks = 0;
let inputBad = 0;
for (const [i, sc] of SCENARIOS.entries()) {
  await resetDoc();
  await sc.act();
  await new Promise((r) => setTimeout(r, 60));
  const mark = `标记${i}号`;
  await c.type(mark);
  await new Promise((r) => setTimeout(r, 80)); // 仍然在慢编译窗口里
  const during = await c.evaluate(MARK_VISIBLE(mark));
  const mismatch = await c.evaluate(TEXT_MISMATCH);
  await new Promise((r) => setTimeout(r, 700)); // 等这一轮慢编译落地
  const afterMark = await c.evaluate(MARK_VISIBLE(mark));
  const cropsAfter = await c.evaluate(CROPS);
  const bad = [];
  if (!during.visible) bad.push("打字后立刻看不见");
  if (!afterMark.visible) bad.push("编译回来后看不见");
  if (mismatch.missing.length) bad.push(`丢行:${JSON.stringify(mismatch.missing.slice(0, 2))}`);
  if (mismatch.dup.length) bad.push(`重复:${JSON.stringify(mismatch.dup.slice(0, 2))}`);
  // 切片数量在**编译回来之后**看：改动期间"相关块全退回源码"是设计如此
  if (cropsAfter < 1) {
    bad.push(
      `编译回来后切片全没了（${JSON.stringify(
        await c.evaluate(`(() => {
        const v = document.querySelector(".cm-content").cmTile.root.view;
        const s = v.state.selection.main;
        return { doc: v.state.doc.toString(), sel: [s.from, s.to, s.head], lines: Array.from(document.querySelectorAll(".cm-line")).map((e) => e.textContent) };
      })()`),
      )}）`,
    );
  }
  inputChecks++;
  if (bad.length) {
    inputBad++;
    console.log(`  ✗ ${sc.name}：${bad.join("；")}`);
  } else {
    console.log(`  ✓ ${sc.name}`);
  }
}

const consoleBad = [];
for (const ev of c.events.slice(CONSOLE_MARK)) {
  if (ev.method !== "Runtime.consoleAPICalled") continue;
  const txt = (ev.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
  if (/plugin crashed|装饰重建失败|Invalid position/.test(txt)) consoleBad.push(txt.slice(0, 300));
}
passed += inputChecks - inputBad;
process.exitCode = inputBad > 0 || consoleBad.length > 0 ? 1 : process.exitCode;
check(
  `${inputChecks} 种输入动作之后正文都看得见、不丢行、不重复、切片还在`,
  inputBad === 0,
  `失败 ${inputBad} 项`,
);
check(
  "这一组也没有「装饰重建失败 / CodeMirror plugin crashed / Invalid position」",
  consoleBad.length === 0,
  JSON.stringify(consoleBad.slice(0, 1)),
);

console.log(
  "14) 切片上拖选 + 复制（阶段 3）：从一张切片拖到另一张 → 选出一段跨块源码，Ctrl+C 能复制走",
);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type("第一段文字。\n\n第二段文字。\n\n第三段文字。\n");
await new Promise((r) => setTimeout(r, 900));
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // 光标回文首（第一块成为活动块）
await new Promise((r) => setTimeout(r, 400));

/** 切片矩形（按块起点取）+ 当前光标/选区（走 CM 的 view） */
const CROPS_INFO = `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
  const r = el.getBoundingClientRect();
  return { from: Number(el.dataset.blockFrom), left: r.left, top: r.top, w: r.width, h: r.height };
})`;
const SELECTION = `(() => {
  const view = document.querySelector(".cm-content").cmTile.root.view;
  const sel = view.state.selection.main;
  return { from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to), docLength: view.state.doc.length };
})()`;

// 复制事件（冒泡阶段）能拿到 CodeMirror 写进剪贴板的内容 —— 不依赖剪贴板权限
await c.evaluate(`(() => {
  window.__copied = null;
  document.addEventListener("copy", (e) => {
    try { window.__copied = e.clipboardData ? e.clipboardData.getData("text/plain") : null; } catch { window.__copied = "ERR"; }
  });
  return true;
})()`);

const dragCrops = await c.evaluate(CROPS_INFO);
check("拖选前：非活动块都是切片", dragCrops.length >= 2, JSON.stringify(dragCrops));
if (dragCrops.length >= 2) {
  const first = dragCrops[0];
  const last = dragCrops[dragCrops.length - 1];
  const x1 = Math.round(first.left + first.w * 0.2);
  const y1 = Math.round(first.top + first.h * 0.5);
  const x2 = Math.round(last.left + last.w * 0.8);
  const y2 = Math.round(last.top + last.h * 0.5);
  await c.drag(x1, y1, x2, y2);
  await new Promise((r) => setTimeout(r, 400));
  const sel = await c.evaluate(SELECTION);
  const firstEnd = first.from + 6; // 第一块正文大致长度（"第一段文字。"= 6 字符）——只用来说明"确实从第一块里起手"
  check(
    `拖出的选区从第一块跨到最后一块（选区 ${sel.from}..${sel.to}，块起点 ${first.from} / ${last.from}）`,
    sel.from <= firstEnd && sel.to >= last.from && sel.to > sel.from,
    JSON.stringify({ sel, first, last }),
  );
  check(
    `选出来的是**源码**且跨了块（${JSON.stringify(sel.text.slice(0, 24))}…，含空行=${sel.text.includes("\\n\\n")}）`,
    sel.text.includes("\n\n") && sel.text.length >= 10,
    JSON.stringify(sel.text),
  );
  const cropsAfterDrag = await c.evaluate(CROPS);
  check(
    "被选区碰到的块展开成源码、剩下的仍是切片",
    cropsAfterDrag < dragCrops.length,
    `拖前 ${dragCrops.length} → 拖后 ${cropsAfterDrag}`,
  );

  // Ctrl+C：走 CM 的复制（选区是真的，复制出来的就是源码）
  await c.key("c", { code: "KeyC", keyCode: 67, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 300));
  const copied = await c.evaluate(`window.__copied`);
  check(
    "Ctrl+C 复制到的内容与选区一致（跨块源码）",
    typeof copied === "string" && copied.length > 0 && copied === sel.text,
    JSON.stringify({
      copied: typeof copied === "string" ? copied.slice(0, 40) : copied,
      expect: sel.text.slice(0, 40),
    }),
  );
  await c.screenshot(SHOT("writing-blocks-drag-select"));

  // 拖选之后接着打字：应当替换掉选区（选区是 CM 的真选区，不是 DOM 假高亮）
  await c.type("替换");
  await new Promise((r) => setTimeout(r, 700));
  const afterType = await c.evaluate(SELECTION);
  check(
    "拖选之后直接打字 = 替换选区（说明这是 CM 的真选区）",
    afterType.text === "",
    JSON.stringify(afterType),
  );
}

console.log(
  "15) 选中整块的规则（用户要求「选中整个代码块不要展开」）：整块被盖住时保持切片外观 + 一层淡色底",
);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type(
  '#set text(size: 11pt)\n\n开头一段。\n\n```rust\nfn main() {\n    println!("hello");\n}\n```\n\n结尾一段。\n',
);
await new Promise((r) => setTimeout(r, 900));
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // 光标回文首 → 代码块是切片
await new Promise((r) => setTimeout(r, 400));

/** 取某类切片 / 某段源码的现状 */
const SNAPSHOT = `(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const sel = v.state.selection.main;
  const lines = Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent);
  const selectedEl = document.querySelector(".cm-block-crop-selected");
  const tint = selectedEl ? selectedEl.querySelector(".cm-block-crop-tint") : null;
  const svg = selectedEl ? selectedEl.querySelector("svg") : null;
  return {
    sel: [sel.from, sel.to, sel.head],
    selText: v.state.sliceDoc(sel.from, sel.to),
    crops: document.querySelectorAll(".cm-block-crop").length,
    selected: document.querySelectorAll(".cm-block-crop-selected").length,
    rawCrops: document.querySelectorAll('.cm-block-crop[data-block-kind="Raw"]').length,
    fenceInSource: lines.some((t) => t.includes("\`\`\`rust")),
    codeInSource: lines.some((t) => t.includes("fn main()")),
    // 选中态的**可见性**：染色层必须存在、不透明、盖住整张切片，而且**不许有描边**
    //（曾经只给容器加背景色 + 1px outline：切片 SVG 自带不透明白纸底 → 只看得到描边，
    //  相邻切片描边相接，全选时整页变成蓝色网格，用户截图「太丑了」）
    tintBg: tint ? getComputedStyle(tint).backgroundColor : null,
    tintCoversSvg: !!(tint && svg) &&
      Math.abs(tint.getBoundingClientRect().width - svg.getBoundingClientRect().width) <= 1 &&
      Math.abs(tint.getBoundingClientRect().height - svg.getBoundingClientRect().height) <= 1,
    tintNoPointer: tint ? getComputedStyle(tint).pointerEvents === "none" : null,
    outline: selectedEl ? getComputedStyle(selectedEl).outlineStyle : null,
  };
})()`;

const rectOf = async (kind) =>
  c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".cm-block-crop")).find((e) => e.dataset.blockKind === ${JSON.stringify(kind)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);

// 场景 A：**整块被盖住、且光标不在里面** → 保持切片外观（不展开、不露围栏）
//（拖选从"上一段"里起手、越过代码块、落进"下一段" —— 这是"把代码块整块圈进去"的手势）
const paras = await c.evaluate(`(() => {
  const list = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
    const r = el.getBoundingClientRect();
    return { kind: el.dataset.blockKind, left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const first = list.find((e) => e.kind === "Paragraph");
  const last = [...list].reverse().find((e) => e.kind === "Paragraph" && e.top > (first ? first.top : 0));
  return { first, last };
})()`);
check("场景 A 前：段落与代码块都在版面上", !!paras.first && !!paras.last, JSON.stringify(paras));
if (paras.first && paras.last) {
  await c.drag(
    Math.round(paras.first.left + paras.first.w * 0.3),
    Math.round(paras.first.top + paras.first.h * 0.5),
    Math.round(paras.last.left + paras.last.w * 0.5),
    Math.round(paras.last.top + paras.last.h * 0.5),
  );
  await new Promise((r) => setTimeout(r, 500));
  const a = await c.evaluate(SNAPSHOT);
  check(
    `整块被圈住的代码块**保持切片外观**（raw 切片 ${a.rawCrops} 张）`,
    a.rawCrops >= 1,
    JSON.stringify(a),
  );
  check("它挂上了「整块被选中」的淡色底", a.selected >= 1, JSON.stringify(a));
  check(
    "淡色底**真的看得见**（染色层盖在 SVG 之上、不拦事件）",
    a.tintBg !== null &&
      a.tintBg !== "rgba(0, 0, 0, 0)" &&
      a.tintCoversSvg === true &&
      a.tintNoPointer === true,
    JSON.stringify(a),
  );
  check(
    "选中态**没有描边**（切片铺满整块，描边相接会把整页画成网格 —— 用户截图「太丑了」）",
    a.outline === "none",
    JSON.stringify(a),
  );
  check("围栏没有露出来", a.fenceInSource === false, JSON.stringify(a));
  check(
    `选区内容照旧是源码（可复制）：${JSON.stringify(a.selText.slice(0, 18))}…`,
    a.selText.includes("fn main()"),
    JSON.stringify(a.selText),
  );
  await c.evaluate(
    `(() => { window.__copied = null; document.addEventListener("copy", (e) => { try { window.__copied = e.clipboardData.getData("text/plain"); } catch {} }); return true; })()`,
  );
  await c.key("c", { code: "KeyC", keyCode: 67, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 300));
  check("Ctrl+C 复制的是整块源码", (await c.evaluate(`window.__copied`)) === a.selText);
  await c.screenshot(SHOT("writing-blocks-codeblock-kept"));
}

// 场景 B：**在代码块里**整块拖选（光标必然在里面）→ 必须展开（否则打不了字），但**围栏藏起来**
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
await new Promise((r) => setTimeout(r, 400));
// 先在切片里点一下把这一块展开，再对着**展开后的真实源码**拖整块。
// 为什么不在切片上直接拖：mousedown 会把光标放进这一块 → 它立刻展开、版式随之变化，而此时拖动要
// 经过好几步 mouseMoved，指针底下的内容已经换过了。夹具是按 371.25pt 渲的、在 1400px 视口下被放大约
// 2.1 倍，所以"切片比展开后的源码还高"，指针最后必然落到下面那一段上（实测头部落到文档末尾）。
// 真实应用里比例是 1.333，代码块切片与源码行数相同、高度接近，拖起来不会有这个错位 ——
// "缩放后的几何是否一致"由 writing-mode-scenes.mjs 的「光标进出块时页面不许变高」在 600px 视口下量。
const blockPoint = await c.evaluate(`(() => {
  const el = document.querySelector('.cm-block-crop[data-block-kind="Raw"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
const rawRect = await rectOf("Raw");
// 同上：这里原本是 `if (rawRect && blockPoint)`，一次静默吞掉下面 6 条断言
// （PR #60 审查的第 12 条）。改成前置断言 + 断言失败即停。
check(
  "代码块切片在视口里（拖选跨块那一组的前提）",
  !!rawRect && !!blockPoint,
  JSON.stringify({ rawRect, blockPoint }),
);
if (!rawRect || !blockPoint) throw new Error("代码块切片不在视口里，拖选跨块那组无法进行");
{
  await c.click(blockPoint.x, blockPoint.y); // 点进代码块 → 它展开成源码
  await new Promise((r) => setTimeout(r, 500));
  // 展开后按**真实源码行**算起止点：第一行（```rust）的左缘 → 最后一行（```）的右缘
  const srcRect = await c.evaluate(`(() => {
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    const first = lines.find((l) => l.textContent.includes("\`\`\`rust"));
    const last = lines.filter((l) => l.textContent.trim().startsWith("\`\`\`")).pop();
    if (!first || !last) return null;
    const a = first.getBoundingClientRect();
    const b = last.getBoundingClientRect();
    return { x1: Math.round(a.left + 2), y1: Math.round(a.top + a.height / 2),
             x2: Math.round(b.left + b.width - 2), y2: Math.round(b.top + b.height / 2) };
  })()`);
  check("点进代码块后能看到它的源码行（拖选要在真实源码上做）", !!srcRect, JSON.stringify(srcRect));
  if (!srcRect) throw new Error("代码块源码行没找到");
  await c.drag(srcRect.x1, srcRect.y1, srcRect.x2, srcRect.y2);
  await new Promise((r) => setTimeout(r, 500));
  const b = await c.evaluate(SNAPSHOT);
  check(
    "在代码块里拖整块：它展开成源码（光标在里面，不展开就打不了字）",
    b.codeInSource === true,
    JSON.stringify(b),
  );
  check("但**两行围栏被藏起来**（看不到 ```rust）", b.fenceInSource === false, JSON.stringify(b));
  check(
    "代码正文仍是真实文本、选区跨了整块",
    b.selText.includes("fn main()"),
    JSON.stringify(b.selText),
  );
  // 打字仍然有效（DOM 里得有真实文本 —— 这正是"光标那一块必须展开"的原因，实测踩过）
  await c.type("// x");
  await new Promise((r) => setTimeout(r, 600));
  const typed = await c.evaluate(
    `document.querySelector(".cm-content").cmTile.root.view.state.doc.toString()`,
  );
  check("展开之后打字照样进得去", typed.includes("// x"), JSON.stringify(typed.slice(0, 40)));
  await c.screenshot(SHOT("writing-blocks-codeblock-inside"));
}

console.log(
  "16) 在行尾按 Enter 拆分块 → 光标落在新行行首（用户报「用 enter 拆分块的时候，光标会有问题」）",
);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.selectAll();
await c.type("开头一段文字。\n\n第二段文字。\n\n第三段文字。\n");
await new Promise((r) => setTimeout(r, 900));

/** 光标画在哪儿：CM 的实测坐标 + 该位置在 DOM 里落在哪个元素上 */
const CARET_GEO = `(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const head = v.state.selection.main.head;
  const co = v.coordsAtPos(head);
  const host = document.querySelector(".cm-content").getBoundingClientRect();
  let domAt = "?";
  try {
    const p = v.domAtPos(head);
    const el = p.node.nodeType === 3 ? p.node.parentElement : p.node;
    domAt = el ? el.className || el.tagName : "null";
  } catch (e) { domAt = "ERR"; }
  return { head, line: JSON.stringify(v.state.doc.lineAt(head).text),
           x: co ? Math.round(co.left) : null, left: Math.round(host.left), right: Math.round(host.right),
           domAt, crops: document.querySelectorAll(".cm-block-crop").length };
})()`;

// 光标放到第二段行尾（那一段是切片），再按 Enter —— 新空行会落在"上一块切片的结尾"那个位置上
await c.evaluate(`(() => {
  const v = document.querySelector(".cm-content").cmTile.root.view;
  const d = v.state.doc.toString();
  const i = d.indexOf("第二段文字。");
  v.dispatch({ selection: { anchor: i + "第二段文字。".length } });
  return true;
})()`);
await new Promise((r) => setTimeout(r, 400));
const beforeEnter = await c.evaluate(CARET_GEO);
await c.key("Enter", { code: "Enter", keyCode: 13 });
await new Promise((r) => setTimeout(r, 1200));
const afterEnter = await c.evaluate(CARET_GEO);
check(
  `按 Enter 前后文档结构正常（${afterEnter.crops} 张切片、光标在第 ${afterEnter.head} 位）`,
  afterEnter.crops >= 1 && afterEnter.head === beforeEnter.head + 1,
  JSON.stringify({ beforeEnter, afterEnter }),
);
check(
  // 行首的实测 x 会比正文列左缘大几像素（光标自身宽度/取整），对照过正常行的行首也是 +6px；
  // 关键是**不能**落在右半边 —— 修好之前这里是 x=正文列右缘（光标被画到最右边）
  `光标落在新行的**行首**（x=${afterEnter.x}，正文列 ${afterEnter.left}~${afterEnter.right}）`,
  afterEnter.x !== null &&
    Math.abs(afterEnter.x - afterEnter.left) <= 12 &&
    afterEnter.x < (afterEnter.left + afterEnter.right) / 2,
  JSON.stringify(afterEnter),
);
check(
  "光标那个位置有真实 DOM（不是飘在 widget / 容器上）",
  /cm-line/.test(afterEnter.domAt),
  JSON.stringify(afterEnter.domAt),
);
await c.screenshot(SHOT("writing-blocks-enter-split-caret"));

// ---------------------------------------------------------------------------
// 17) 写作模式装上打包字体：源码透镜与引擎切片**同一套字**（字号/行高/字体三条腿齐）
// ---------------------------------------------------------------------------
// 为什么值得单独验：字体那份字体本来就随应用分发（Rust 侧 resources/fonts），前端通过
// `bundled_font` 命令取字节（raw IPC → ArrayBuffer）再用 FontFace 注册；**装不上时一切照旧**
// （退回系统衬线栈），所以"代码看着对、其实没生效"完全可能发生 —— 这一组验的就是真生效。
console.log("17) 写作模式装上打包字体：源码透镜与引擎切片同一套字");
await c.evaluate(`localStorage.clear()`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 900));

const FONT_PROBE = `(() => {
  const width = (family, text) => {
    const s = document.createElement("span");
    s.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font-size:16px;font-family:" + family;
    s.textContent = text;
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    return w;
  };
  const content = document.querySelector(".cm-content");
  const cjk = "第一段正文";
  const latin = "Hamburgefonstiv";
  return {
    loadedLatin: document.fonts.check('16px "Libertinus Serif"'),
    loadedCjk: document.fonts.check('16px "Noto Serif CJK SC"'),
    family: content ? getComputedStyle(content).fontFamily : "",
    cjkInstalled: width('"Noto Serif CJK SC"', cjk),
    cjkFallback: width('"No Such Family Xyz"', cjk),
    latinInstalled: width('"Libertinus Serif"', latin),
    latinFallback: width('"No Such Family Xyz"', latin),
  };
})()`;
const fonts = await c.evaluate(FONT_PROBE);
check(
  "两份打包字体都真的装上了（document.fonts.check）",
  fonts.loadedLatin === true && fonts.loadedCjk === true,
  JSON.stringify(fonts),
);
check(
  `写作模式正文字体栈用上了它们（${String(fonts.family).slice(0, 64)}…）`,
  fonts.family.includes("Libertinus Serif") &&
    fonts.family.indexOf("Libertinus Serif") < fonts.family.indexOf("Noto Serif CJK SC"),
  fonts.family,
);
check(
  `拉丁走的是 Libertinus Serif（${fonts.latinInstalled.toFixed(1)}px，兜底族 ${fonts.latinFallback.toFixed(1)}px —— 两者不同才说明真用上了）`,
  Math.abs(fonts.latinInstalled - fonts.latinFallback) > 0.5,
  JSON.stringify(fonts),
);
check(
  `中文走的是思源宋体（5 个汉字 ${fonts.cjkInstalled.toFixed(1)}px ≈ 16px×5）`,
  Math.abs(fonts.cjkInstalled - 80) <= 16,
  JSON.stringify(fonts),
);
// 字节这一层也钉一下：dev server 提供的就是仓库里那份字体（真机走 Rust 的 raw IPC 读同一个文件，
// 名字↔文件的对齐由 scripts/editor-fonts.test.mjs 静态保证）
const fontBytes = await c.evaluate(`(async () => {
  const res = await fetch("/__bundled-fonts/NotoSerifCJKsc-Regular.otf");
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, size: buf.length, magic: String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) };
})()`);
check(
  `字体的确是那份真文件（HTTP ${fontBytes.status} / ${fontBytes.size} 字节 / 魔数 ${fontBytes.magic}）`,
  fontBytes.status === 200 && fontBytes.size > 100000 && /OTTO|true|ttcf/.test(fontBytes.magic),
  JSON.stringify(fontBytes),
);
check(
  "状态栏没有脚本错误（装字体这条路径不许弄坏编辑区）",
  !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"),
);
await c.screenshot(SHOT("writing-blocks-fonts"));

// ---------------------------------------------------------------------------
// 18) 公式字号 = 正文字号（写作模式跟着文档走，源码模式 10.5pt）
// ---------------------------------------------------------------------------
// PR #60 审查的第 2 条：`MATH_SIZE_PT = 12`（= 正文 16px 那个年代的值）写死在公式渲染里，
// 而本线让写作模式的正文字号**跟着文档走**（`--write-doc-px = textPt × 4/3`，默认 11pt）——
// 于是光标所在块里的公式比周围正文大 9%、也比同一公式在切片里的样子大。修法是字号由父组件
// 按模式给（写作模式 = 文档 textPt，源码模式 = 10.5pt = 14px 正文）。
// 这里验的是**真的传下去了**（真机上 Rust 侧按 size_pt 排版；桩把入参记在
// `window.__browserDevLastMath`，与"文档内 #let 进上下文"那条链路的验法同源）。
console.log("18) 公式字号 = 正文字号（写作模式跟文档，源码模式 10.5pt）");
await c.evaluate(`localStorage.clear()`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

// 光标停在**有公式那一行**：写作模式下这一块展开成源码，而同一块里没被光标碰到的公式
// 仍然是 widget（"光标进入即展开"只作用于光标所在的公式/标记），所以它会走 compile_math。
await c.click(400, 300);
await c.selectAll();
await c.type("第一段带公式 $a_0 + b_1$ 的正文。\n\n第二段正文。\n");
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home → 第一块
await c.key("End", { code: "End", keyCode: 35 }); // 行尾（同一块内，公式不受光标影响）
await new Promise((r) => setTimeout(r, 900));

const writeMath = await c.evaluate(`(() => {
  const m = window.__browserDevLastMath || null;
  const host = document.querySelector(".editor-host");
  const px = host ? getComputedStyle(host).getPropertyValue("--write-doc-px").trim() : "";
  const ed = document.querySelector(".cm-editor");
  return { sizePt: m && typeof m.sizePt === "number" ? m.sizePt : null, body: m ? m.body : null,
           docPx: px, editorPx: ed ? getComputedStyle(ed).fontSize : null };
})()`);
check(
  `写作模式的公式按文档字号渲染（sizePt=${writeMath.sizePt} = 正文 ${writeMath.editorPx}）`,
  writeMath.sizePt !== null &&
    Math.abs(writeMath.sizePt - parseFloat(writeMath.editorPx) * 0.75) < 0.01,
  JSON.stringify(writeMath),
);
check(
  "公式渲染字号不是写死的 12pt（= 16px 那个年代的值）",
  writeMath.sizePt !== null && Math.abs(writeMath.sizePt - 12) > 0.01,
  JSON.stringify(writeMath),
);

// 源码模式**根本没有公式 widget**（`enabled: () => mode === "write"`：源码模式要看到真正的
// Typst 源码），所以"源码模式的公式字号"这条路径今天走不到 —— 那是给"内联渲染哪天在源码模式
// 也开"留的兜底（10.5pt = 14px 正文）。这里把"看不到 widget"这条设计决定钉住：
// 顺带说明为什么这一组只验写作模式的字号。
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 }); // Ctrl+E
await new Promise((r) => setTimeout(r, 900));
const sourceMath = await c.evaluate(`(() => {
  return { widgets: document.querySelectorAll(".cm-math-widget").length,
           hasSource: document.body.innerText.includes("$a_0 + b_1$") };
})()`);
check(
  "源码模式不渲染公式 widget（内联渲染只在写作模式，源码要看得见真源码）",
  sourceMath.widgets === 0 && sourceMath.hasSource === true,
  JSON.stringify(sourceMath),
);
check(
  "状态栏没有脚本错误（改字号这条路径不许弄坏编辑区）",
  !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"),
);
await c.screenshot(SHOT("writing-blocks-math-size"));

// ---------------------------------------------------------------------------
// 19) 汉字输入法合成（IME composition）
// ---------------------------------------------------------------------------
// PR #60 审查的第 5 条：`blocksVersion++` 在**每次编辑**都发生，而 Editor 里那个"重整装饰"
// 的 $effect 没有 `view.composing` 守卫 —— 合成中途换掉 widget DOM 会把候选串/合成状态一起
// 弄坏。修法是合成期间攒着、`compositionend` 后补一次刷新。
// 这一组补的是**验收里从来没有过的 composition 覆盖**（在此之前一个合成事件都没发过）：
// 用 CDP 的 `Input.imeSetComposition` / `Input.insertText` 走真实的合成 → 提交路径，
// 断言合成文本真的进了文档、提交后编辑区照常、切片照常回来、控制台干净。
console.log("19) 汉字输入法合成（composition）不弄坏编辑区");
await c.evaluate(`localStorage.clear()`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));
await c.click(400, 300);
await c.selectAll();
await c.type("第一段正文。\n\n第二段正文。\n\n第三段正文。\n");
await c.key("End", { code: "End", keyCode: 35, modifiers: 2 }); // Ctrl+End → 文档末尾
await new Promise((r) => setTimeout(r, 500));

// 合成中：拼音串 + 候选（Chrome 的 imeSetComposition = "正在合成这段文本"）
await c.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
await new Promise((r) => setTimeout(r, 250));
const composing = await c.evaluate(`(() => ({
  text: document.querySelector(".cm-content").textContent,
  crops: document.querySelectorAll(".cm-block-crop").length,
}))()`);
check(
  "合成中的文本进了编辑区（合成期间打字不会被丢掉）",
  composing.text.includes("zhong"),
  JSON.stringify(composing),
);
check(
  "合成期间切片仍在（没有因为重建装饰把版面弄空）",
  composing.crops >= 2,
  JSON.stringify(composing),
);

// 提交：IME 用 insertText 落地最终文本（这里模拟选中了「中」）
await c.send("Input.insertText", { text: "中" });
await new Promise((r) => setTimeout(r, 700));
const committed = await c.evaluate(`(() => ({
  text: document.querySelector(".cm-content").textContent,
  crops: document.querySelectorAll(".cm-block-crop").length,
  errors: document.body.innerText.includes("脚本错误"),
}))()`);
check(
  "合成提交后最终文本落进文档（`zhong` → `中`，不留拼音残留）",
  committed.text.includes("中") && !committed.text.includes("zhong"),
  JSON.stringify(committed.text.slice(-40)),
);
check(
  "合成结束后切片照常回来（攒下的那次刷新没丢）",
  committed.crops >= 2,
  String(committed.crops),
);
check("合成这条路径不产生脚本错误", committed.errors === false, JSON.stringify(committed));

// 合成之后继续正常打字（合成不该把编辑区变成只读或半死状态）
await c.type("后续输入正常");
await new Promise((r) => setTimeout(r, 400));
const after = await c.evaluate(`document.querySelector(".cm-content").textContent`);
check("合成之后继续打字照常生效", after.includes("后续输入正常"), JSON.stringify(after.slice(-30)));
await c.screenshot(SHOT("writing-blocks-ime"));

// ---------------------------------------------------------------------------
// 20) Shift+点击切片 = **扩选**（不许把原选区收掉）
// ---------------------------------------------------------------------------
// PR #60 审查的第 6 条：`CropSelection.commit()` 一律 `EditorSelection.single(anchor, head)`，
// 而锚点是"按下那一刻解析出来的位置" —— 于是 Shift+点击/Shift+拖选切片不但没扩选，
// 反而把原选区收掉了（验收当时只覆盖了 Shift+方向键）。
// 现在与 CM 默认同一口径：扩选的固定端 = 原选区（空选区时是光标）。
console.log("20) Shift+点击切片 = 扩选");
await c.evaluate(`localStorage.clear()`);
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 700));
await c.click(400, 300);
await c.selectAll();
await c.type("第一段正文。\n\n第二段正文。\n\n第三段正文。\n\n第四段正文。\n");
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home → 第一块
await new Promise((r) => setTimeout(r, 800));

/** 视口里的前两张切片（上、下各一张） */
const TWO_CROPS = `(() => {
  const list = Array.from(document.querySelectorAll(".cm-block-crop"))
    .map((el) => ({ from: Number(el.dataset.blockFrom), rect: el.getBoundingClientRect() }))
    .filter((c) => c.from === c.from && c.rect.height > 4)
    .sort((a, b) => a.rect.top - b.rect.top);
  if (list.length < 2) return null;
  const pt = (c, fx, fy) => ({ x: Math.round(c.rect.left + c.rect.width * fx), y: Math.round(c.rect.top + c.rect.height * fy) });
  return { a: { from: list[0].from, ...pt(list[0], 0.3, 0.5) }, b: { from: list[1].from, ...pt(list[1], 0.3, 0.5) } };
})()`;

const two = await c.evaluate(TWO_CROPS);
check("视口里至少有两张切片（Shift 扩选那组的前提）", !!two, JSON.stringify(two));
if (!two) throw new Error("切片不足两张，Shift 扩选那组无法进行");
const SEL = `(() => {
  const s = document.querySelector(".cm-content").cmTile.root.view.state.selection.main;
  return { anchor: s.anchor, head: s.head, empty: s.empty, from: s.from, to: s.to };
})()`;

// ① 先点上面那张切片：光标进到它里面（选区为空）
await c.click(two.a.x, two.a.y);
await new Promise((r) => setTimeout(r, 600));
const first = await c.evaluate(SEL);
check("点第一张切片 → 光标落在这一块里（选区为空）", first.empty === true, JSON.stringify(first));

// ② Shift+点下面那张切片：应当**从原位置扩选**到这一块，而不是收掉选区
const shiftClick = async (x, y) => {
  await c.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
    buttons: 1,
    modifiers: 8,
  });
  await c.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
    buttons: 0,
    modifiers: 8,
  });
};
await shiftClick(two.b.x, two.b.y);
await new Promise((r) => setTimeout(r, 700));
const extended = await c.evaluate(SEL);
check(
  "Shift+点击另一张切片 → 选区**扩**到那一段（不是收掉）",
  extended.empty === false && extended.from <= first.head && extended.to >= first.head,
  JSON.stringify({ first: first.head, extended }),
);
check(
  "扩选的方向对：固定端仍在原来那块、活动端进到新点的那块",
  extended.anchor === first.head && extended.head !== extended.anchor,
  JSON.stringify(extended),
);

// ③ 再 Shift+点回上面那张：仍是扩选（不许因为"锚点被覆盖"而收起）
await shiftClick(two.a.x, two.a.y);
await new Promise((r) => setTimeout(r, 700));
const back = await c.evaluate(SEL);
check(
  "Shift+点回原来那块仍然是非空选区（连续扩选不收起）",
  back.empty === false,
  JSON.stringify(back),
);
await c.screenshot(SHOT("writing-blocks-shift-click"));

console.log(`\n通过 ${passed} 项检查；截图：.browser-check/writing-blocks-*.png`);
process.exit(process.exitCode ?? 0);
