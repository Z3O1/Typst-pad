// 写作模式（文档模式）的**场景验收**：拿真实 typst 产物，在真浏览器里逐场景过一遍文档形态。
//
// 与另外两套的分工：
//   * `writing-blocks.mjs`        —— 桩产物，验交互链路（切片出现/光标进出/点击/窗口化补渲）；
//   * `writing-blocks-visual.mjs` —— 真实产物，验**几何等价**（切片摞起来 == 原版式）；
//   * `writing-mode-scenes.mjs`   —— 真实产物，按**文档形态**逐场景过一遍
//     （标题层级 / 中文长段落 / 列表嵌套 / 公式 / 代码与表格脚注 / 文档级 #set 对照），
//     每个场景存一张截图，并在最后一个场景上走一遍编辑与模式切换。
//
// 链路：`npm run fixtures:blocks`（Rust `dump_block_fixtures`，场景集）→ 导航前注入
// `window.__DEV_BLOCK_FIXTURES` → 桩按文档原文命中夹具时给真实产物。
//
// 前置：`npm run dev -- --port 1425` + headless Chromium（CDP）。
// 运行：`CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-mode-scenes.mjs`
import { readFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";

const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;
const FIXTURES = new URL("../../.browser-check/block-fixtures.json", import.meta.url).pathname;

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

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
console.log(`场景夹具：${fixtures.length} 篇（来自 Rust compile_blocks 的真实产物）`);

const c = await connect();
await c.send("Page.enable");
await c.evaluate(`localStorage.clear()`);
await c.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__DEV_BLOCK_FIXTURES = ${JSON.stringify(fixtures)};`,
});
await c.goto(`${DEV_URL}&blocks=1`);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

/** 输入一篇文档（替换整篇），返回量到的切片几何 */
async function loadScene(doc) {
  await c.click(400, 300);
  await c.selectAll();
  await c.type(doc);
  await new Promise((r) => setTimeout(r, 700));
  return c.evaluate(`(() => {
    const content = document.querySelector(".cm-content");
    const cr = content.getBoundingClientRect();
    const crops = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
      const r = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      return {
        y: r.top - cr.top,
        w: r.width,
        h: r.height,
        svgH: svg ? svg.getBoundingClientRect().height : 0,
      };
    });
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    return {
      columnWidth: cr.width,
      crops,
      lineCount: lines.length,
      status: document.querySelector(".status-bar")?.innerText ?? "",
      mode: document.querySelector(".mode-tag")?.textContent ?? "",
    };
  })()`);
}

const summary = [];
for (const fx of fixtures) {
  console.log(`\n=== 场景：${fx.name}`);
  const found = fx.blocks.filter((b) => b.svg && b.heightPt > 0.5);
  const m = await loadScene(fx.doc);
  const expected = found.length - 1; // 光标停在文末 → 最后一块是活动块（源码形态）
  check(
    `切片数 = 可渲染块 − 1：${m.crops.length}/${expected}`,
    m.crops.length === expected,
    JSON.stringify({ crops: m.crops.length, expected }),
  );
  if (m.crops.length > 0) {
    const factor = m.crops[0].w / fx.contentWidthPt;
    check("切片铺满正文列宽（±2px）", Math.abs(m.crops[0].w - m.columnWidth) <= 2);
    // 每块高度与真实排版一致（切片没被拉伸）
    let worst = 0;
    for (let i = 0; i < m.crops.length; i++) {
      worst = Math.max(worst, Math.abs(m.crops[i].h - found[i].heightPt * factor));
    }
    check(`每块高度与真实排版一致（最大偏差 ${worst.toFixed(2)}px）`, worst <= 2.5);
    let worstGap = 0;
    for (let i = 1; i < m.crops.length; i++) {
      worstGap = Math.max(
        worstGap,
        Math.abs(m.crops[i].y - (m.crops[i - 1].y + m.crops[i - 1].h)),
      );
    }
    check(`相邻切片首尾相接（最大缝 ${worstGap.toFixed(2)}px）`, worstGap <= 2.5);
  }
  check("状态栏没有脚本错误", !m.status.includes("脚本错误"), JSON.stringify(m.status));
  await c.screenshot(SHOT(`scene-${fx.name.replace(/[（）()]/g, "")}`));
  summary.push({
    name: fx.name,
    块数: fx.blocks.length,
    切片: m.crops.length,
    最高的切片: Math.max(0, ...m.crops.map((x) => Math.round(x.h))),
    活动块行数: m.lineCount,
  });
}

// 文档级 #set 对照：同一段文字，12pt 的切片必须比默认字号高（CSS 那套做不到这一点）
console.log("\n=== 对照：文档级 #set 是否真的进到切片里");
const plain = fixtures.find((f) => f.name === "文档级设置（默认字号）");
const bigger = fixtures.find((f) => f.name === "文档级设置（12pt）");
if (plain && bigger) {
  const heightOf = (fx) => Math.max(...fx.blocks.filter((b) => b.svg).map((b) => b.heightPt));
  check(
    `12pt 的正文切片比默认字号高（${heightOf(bigger).toFixed(1)}pt vs ${heightOf(plain).toFixed(1)}pt）`,
    heightOf(bigger) > heightOf(plain) + 0.5,
  );
} else {
  check("找到 #set 对照的两篇夹具", false, "夹具缺失");
}

// 最后一个场景上走一遍"编辑 → 重编译 → 切片更新"与模式切换
console.log("\n=== 编辑与模式切换（在最后一个场景上）");
const before = await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`);
await c.click(400, 300);
await c.key("End", { code: "End", keyCode: 35 }); // 光标留在文末的活动块里
await c.type("补充一句，观察重编译后切片数量与几何是否稳定。");
await new Promise((r) => setTimeout(r, 900));
const after = await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`);
check(`编辑后切片仍然存在（${before} → ${after}）`, after >= 1);
check(
  "编辑没有把页面打坏（无脚本错误）",
  !(await c.evaluate(`document.body.innerText`)).includes("脚本错误"),
);
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
await new Promise((r) => setTimeout(r, 700));
check("Ctrl+/ 切到源码模式：切片消失", (await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`)) === 0);
await c.key("/", { code: "Slash", keyCode: 191, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
check("切回写作模式：切片回来", (await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`)) >= 1);

console.log("\n场景汇总：");
console.table(summary);
console.log(`通过 ${passed} 项检查；截图：.browser-check/scene-*.png`);
process.exit(process.exitCode ?? 0);
