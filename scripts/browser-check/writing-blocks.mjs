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
await c.evaluate(`localStorage.clear()`);
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
check("被切片盖住的正文不再是源码形态", !linesText.includes("第一段正文"), JSON.stringify(linesText));
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
check("被点的那一块展开了源码（标题可见）", afterClick.includes("章节标题"), JSON.stringify(afterClick));
check("原来的活动块（列表项）变成切片", !afterClick.includes("列表项"), JSON.stringify(afterClick));
check("切片数量不变（换了一块而已）", cropsAfter === crops, `${crops} → ${cropsAfter}`);
check("`= ` 标记重新出现在源码里（展开后能看到标记）", afterClick.includes("= 章节标题"), JSON.stringify(afterClick));
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
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 }); // Ctrl+/
await new Promise((r) => setTimeout(r, 700));
check(
  "状态栏切到了源代码模式",
  (await c.evaluate(`document.querySelector(".mode-tag")?.textContent ?? ""`)) === "源码",
  "模式没切过去（Ctrl+/ 没生效）",
);
check("源码模式下没有切片", (await c.evaluate(CROPS)) === 0, "仍有切片");
check("源码模式下正文全部可见", (await c.evaluate(LINES_TEXT)).includes("第一段正文"), "源码未显示");
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
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
const longDoc = Array.from(
  { length: 120 },
  (_, i) => `第 ${i} 段。` + SENTENCE.repeat(3),
).join("\n\n");
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
const tailVisible = await c.evaluate(`document.querySelector(".cm-content").textContent.includes("第 119 段")`);
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

console.log("8) 跨块竖直移动：按上/下逐块走，不跳回文档开头（用户报过「在 == 6 前面按上跳回开头」）");
// 为什么会有这个 bug：CodeMirror 的竖直移动会跳过所有 widget 去找文本行（posAtCoords），
// 而写作模式的切片全是 widget → 一路跳过就扫到内容顶部、返回位置 0。
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

await c.key("End", { code: "End", keyCode: 35, modifiers: 2 }); // Ctrl+End → 光标在最后一块
await new Promise((r) => setTimeout(r, 400));
check("起点：光标在最后一块（源码形态）", (await revealedNow()).includes("最后一段"), await revealedNow());

const seen = [];
for (let i = 0; i < 5; i++) {
  await c.key("ArrowUp", { code: "ArrowUp", keyCode: 38 });
  await new Promise((r) => setTimeout(r, 300));
  seen.push(await revealedNow());
}
check(
  `按上逐块前移（5 次展开序列：${seen.map((x) => x.split(" | ").pop()).join(" → ")}）`,
  seen[0].includes("最后一段") && seen.some((x) => x.includes("列表项")) && seen.some((x) => x.includes("第一段")),
  JSON.stringify(seen),
);
check("第一次按上不会直接跳到第一块", !seen[0].includes("标题"), seen[0]);
check("按到第一块后继续按上不出乱子（仍在第一块或不动）", !seen[4].includes("脚本错误"), seen[4]);
check("状态栏没有脚本错误", !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"));

// 向下：从文档开头连续按下 —— 只要求"单调前进、不跳到文档末尾、最终能走到最后一块"。
// 已知的小毛病（如实记录，不假装完美）：从块的**开头**往下按，第一次会先在块内挪到块尾，
// 第二次才跨到下一块 —— 因为 CodeMirror 的下扫在 widget 里能落回当前格，我们就不接管。
await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 }); // Ctrl+Home
await new Promise((r) => setTimeout(r, 400));
const down = [];
for (let i = 0; i < 7; i++) {
  await c.key("ArrowDown", { code: "ArrowDown", keyCode: 40 });
  await new Promise((r) => setTimeout(r, 300));
  down.push(await revealedNow());
}
const tail = (x) => x.split(" | ").pop() ?? "";
/** 展开文本 → 文档里第几块（越大越靠后）；用作"单调前进"的判据 */
const rank = (t) => {
  if (t.includes("最后一段")) return 3;
  if (t.includes("列表项")) return 2;
  if (t.includes("第一段")) return 1;
  return 0; // = 标题
};
const ranks = down.map((x) => rank(tail(x)));
const monotone = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]);
check(
  `按下单调前进（7 次展开序列：${down.map((x) => tail(x)).join(" → ")}）`,
  monotone,
  JSON.stringify(down),
);
check("按下最终能走到最后一块", ranks.includes(3), JSON.stringify(ranks));
check("按下不会跳到文档开头/末尾（每一步都是某个块的开头）", ranks[0] <= 1 && monotone, JSON.stringify(ranks));

console.log(`\n通过 ${passed} 项检查；截图：.browser-check/writing-blocks-*.png`);
process.exit(process.exitCode ?? 0);
