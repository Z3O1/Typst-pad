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
// 空夹具 = 0 项断言 + 退出码 0 的假绿（cargo test 命中 0 个用例时退出码仍是 0）⇒ 必须硬失败
if (fixtures.length === 0) {
  console.error(`夹具是空的：${FIXTURES}；先跑 npm run fixtures:blocks（别拿空夹具跑验收）`);
  process.exit(1);
}
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

// 标题字号梯度必须跟 typst 一致（用户报「在标题所在块，标题就会变的很大」）：
// 切片是引擎画的（h1 = 1.4em、h2 = 1.2em、h3 及以下 = 1.0em，只加粗），光标进标题块时那一块
// 展开成源码 —— 源码透镜若用另一套梯度（曾经是 1.8/1.5/1.25em），标题就会突然放大 36%~40%。
console.log("\n=== 标题字号梯度对齐 typst（源码透镜 vs 切片）");
const headings = fixtures.find((f) => f.name === "标题层级");
if (!headings) {
  check("找到「标题层级」场景夹具", false, "夹具缺失");
} else {
  await loadScene(headings.doc);
  /** 把光标放进含 needle 的那一行，返回该行标题的实际字号（px）与 typst 应有的字号 */
  const measureHeading = async (needle, level) => {
    await c.evaluate(`(() => {
      const v = document.querySelector(".cm-content").cmTile.root.view;
      const d = v.state.doc.toString();
      v.dispatch({ selection: { anchor: d.indexOf(${JSON.stringify(needle)}) + ${JSON.stringify(needle)}.length } });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    return c.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(`[class*="cm-markup-heading-${level}"]`)});
      // 该夹具文档没有 #set text(size:)，切片用的是 typst 默认 11pt；1pt = 4/3px
      const ladder = { 1: 1.4, 2: 1.2, 3: 1.0 }[${level}];
      return el ? {
        className: el.className,
        sourcePx: parseFloat(getComputedStyle(el).fontSize),
        typstPx: ladder * 11 * 4 / 3,
      } : null;
    })()`);
  };
  const h1 = await measureHeading("一级标题", 1);
  const h2 = await measureHeading("二级标题", 2);
  const h3 = await measureHeading("三级标题", 3);
  check("三级标题都能量到（切片展开成了源码）", !!h1 && !!h2 && !!h3, JSON.stringify({ h1, h2, h3 }));
  // 前置不成立时**不能静默跳过**下面 5 条断言（那样只是总数少 5 项、退出码仍是 0，
  // 读日志的人看不出少的是哪一组）；这里再记一次失败，把跳过的那组写出来
  if (!h1 || !h2 || !h3) {
    check("标题字号断言的前提不成立（缺 h1/h2/h3）→ 后面 5 条断言未执行", false, JSON.stringify({ h1, h2, h3 }));
  } else {
    // ① 梯度本身（与正文基准无关，只看各级之间的比例）：必须正好是 typst 的 1.4 / 1.2 / 1.0
    check(
      `h1/h3 = ${(h1.sourcePx / h3.sourcePx).toFixed(3)}（typst 1.4）`,
      Math.abs(h1.sourcePx / h3.sourcePx - 1.4) < 0.02,
      JSON.stringify({ h1: h1.sourcePx, h3: h3.sourcePx }),
    );
    check(
      `h2/h3 = ${(h2.sourcePx / h3.sourcePx).toFixed(3)}（typst 1.2）`,
      Math.abs(h2.sourcePx / h3.sourcePx - 1.2) < 0.02,
      JSON.stringify({ h2: h2.sourcePx, h3: h3.sourcePx }),
    );
    // ② 与切片里的绝对字号**必须一致**：源码透镜的字号基准已经改成"文档实际字号"
    //（Rust 侧 textPt → --write-doc-px），所以这里应当是 1.000 —— 差一点点都会让用户看到
    // "光标一进那块字就变大"（用户：「不要光标在哪里哪里就变大了」）
    for (const [name, m] of [["h1", h1], ["h2", h2], ["h3", h3]]) {
      const ratio = m.sourcePx / m.typstPx;
      check(
        `${name} 与切片字号之比 ${ratio.toFixed(3)}（1.0 ± 0.02，与引擎排版一致）`,
        ratio >= 0.98 && ratio <= 1.02,
        JSON.stringify(m),
      );
    }
  }
}

// 光标进出块时**页面不许变高**（用户：「不要光标在哪里哪里就变大了」）。
// 量法：`.cmContent` 的实际内容高度（`view.contentHeight`）在"光标在文末"与"光标进最大的那一块"两态之差。
// **视口要临时调窄**：夹具是按 contentWidthPt=371.25pt 渲的，1400px 视口下切片被放大 2.1 倍，
// 那样比出来的高度差全是缩放假象；600px 视口下列宽 ≈ 489px → 显示比例 1.32 ≈ 真实应用的 1.333。
console.log("\n=== 光标进出块时页面不许变高（源码透镜跟随文档字号与行距）");
{
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const CONTENT_HEIGHT = `(() => {
    const v = document.querySelector(".cm-content").cmTile.root.view;
    return Math.round(v.contentHeight);
  })()`;
  for (const name of ["中文长段落", "标题层级"]) {
    const fx = fixtures.find((f) => f.name === name);
    await loadScene(fx.doc);
    await c.evaluate(`(() => {
      const v = document.querySelector(".cm-content").cmTile.root.view;
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const atEnd = await c.evaluate(CONTENT_HEIGHT);
    const biggest = fx.blocks.filter((b) => b.svg).sort((a, b) => b.heightPt - a.heightPt)[0];
    const needle = fx.doc.slice(biggest.start, biggest.end).split("\n")[0].slice(0, 8);
    await c.evaluate(`(() => {
      const v = document.querySelector(".cm-content").cmTile.root.view;
      const d = v.state.doc.toString();
      v.dispatch({ selection: { anchor: d.indexOf(${JSON.stringify(needle)}) + 2 } });
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 500));
    const inside = await c.evaluate(CONTENT_HEIGHT);
    check(
      `${name}：光标进块后页面高度只差 ${inside - atEnd}px（≤12px）`,
      Math.abs(inside - atEnd) <= 12,
      JSON.stringify({ atEnd, inside, blockPt: biggest.heightPt }),
    );
  }
  // 字号/行距确实跟着文档走：默认 11pt → 14.6667px / 1.65
  await loadScene(fixtures.find((f) => f.name === "中文长段落").doc);
  const metrics = await c.evaluate(`(() => {
    const cs = getComputedStyle(document.querySelector(".cm-content"));
    return { font: cs.fontSize, line: cs.lineHeight, docPx: getComputedStyle(document.querySelector(".editor-host")).getPropertyValue("--write-doc-px") };
  })()`);
  check(
    `源码透镜字号 = 文档字号（${metrics.font}，--write-doc-px=${metrics.docPx.trim()}）`,
    Math.abs(parseFloat(metrics.font) - 14.6667) < 0.05 && metrics.docPx.trim().startsWith("14.66"),
    JSON.stringify(metrics),
  );
  // `#set text(size: 12pt)` 的文档 → 透镜字号必须跟着变成 16px（16px = 12pt）
  await loadScene(fixtures.find((f) => f.name === "文档级设置（12pt）").doc);
  const twelve = await c.evaluate(`(() => {
    const cs = getComputedStyle(document.querySelector(".cm-content"));
    return { font: cs.fontSize, line: cs.lineHeight };
  })()`);
  check(
    `文档写 #set text(size: 12pt) → 透镜字号 16px（${twelve.font} / ${twelve.line}）`,
    Math.abs(parseFloat(twelve.font) - 16) < 0.05 && twelve.line === "26.4px",
    JSON.stringify(twelve),
  );
  await c.send("Emulation.clearDeviceMetricsOverride");
}

// 「完全隐藏，和 PDF 一样什么都看不到」（用户 2026-09-16 选定）：
// `#set` / `#show` / `#let` / 注释行这类"规则"在真排版里没有输出（引擎对它们没有帧项、高度 0），
// 以前照旧显示源码（用户问「为什么 `#` 的代码还是会显示出来」）；现在整格隐藏、光标进去才展开。
console.log("\n=== 没有输出的块（#set / #show）：整格隐藏，光标进去才展开");
const setDoc = fixtures.find((f) => f.name === "文档级设置（12pt）");
if (!setDoc) {
  check("找到带 #set 的场景夹具", false, "夹具缺失");
} else {
  await loadScene(setDoc.doc);
  const hidden = await c.evaluate(`(() => {
    const v = document.querySelector(".cm-content").cmTile.root.view;
    const d = v.state.doc.toString();
    v.dispatch({ selection: { anchor: d.indexOf("这一段用来") + 2 } });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const a = await c.evaluate(`(() => ({
    text: document.querySelector(".cm-content").innerText,
    crops: document.querySelectorAll(".cm-block-crop").length,
    hiddenCovers: Array.from(document.querySelectorAll(".cm-block-crop")).length,
  }))()`);
  check(
    "光标在正文里时 `#set text(size: 12pt)` 那一行**不在页面上**（与 PDF 一致）",
    !a.text.includes("#set") && !a.text.includes("size: 12pt"),
    JSON.stringify(a),
  );
  check(
    // 标题那一块是切片（图片），它的文字**不会**出现在 innerText 里 —— 只能数切片
    "正文与标题照常渲染（标题那张切片还在，正文是源码形态）",
    a.text.includes("这一段用来") && a.crops >= 1,
    JSON.stringify(a),
  );
  await c.screenshot(SHOT("scene-hidden-set"));
  // 光标进那一行 → 展开成源码，能编辑
  await c.evaluate(`(() => {
    const v = document.querySelector(".cm-content").cmTile.root.view;
    v.dispatch({ selection: { anchor: 3 } });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const b = await c.evaluate(`document.querySelector(".cm-content").innerText`);
  check("光标进那一行 → 展开成源码（可编辑）", b.includes("#set text(size: 12pt)"), JSON.stringify(b.slice(0, 60)));
  // 回到正文：又藏起来（可逆）
  await c.evaluate(`(() => {
    const v = document.querySelector(".cm-content").cmTile.root.view;
    const d = v.state.doc.toString();
    v.dispatch({ selection: { anchor: d.indexOf("这一段用来") + 2 } });
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const back = await c.evaluate(`document.querySelector(".cm-content").innerText`);
  check("光标离开后又藏起来（可逆）", !back.includes("#set"), JSON.stringify(back.slice(0, 60)));
}


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
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 700));
check("Ctrl+/ 切到源码模式：切片消失", (await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`)) === 0);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await new Promise((r) => setTimeout(r, 900));
check("切回写作模式：切片回来", (await c.evaluate(`document.querySelectorAll(".cm-block-crop").length`)) >= 1);

console.log("\n场景汇总：");
console.table(summary);
console.log(`通过 ${passed} 项检查；截图：.browser-check/scene-*.png`);
process.exit(process.exitCode ?? 0);
