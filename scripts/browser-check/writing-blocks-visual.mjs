// 写作模式「块级切片几何等价」验收：用**真实 typst 产物**断言"切片摞起来 == 原版式"。
//
// 与 `writing-blocks.mjs` 的分工：
//   * `writing-blocks.mjs`          —— 桩产物，验**交互**（切片出现 / 光标进出 / 点击回源码 / 窗口化补渲）；
//   * `writing-blocks-visual.mjs`   —— **真实产物**，验**几何**（切片是按真实排版切下来的，
//                                      摞起来的高度、列宽、首尾相接关系与引擎的版式一致）。
//
// 链路（与 `wysiwyg-visual.mjs` 的公式夹具同款）：
//   1) `npm run fixtures:blocks` —— Rust 侧 `dump_block_fixtures`（#[ignore] 按需测试）把每篇样例
//      文档的**每块区间 + 几何（y/宽/高）+ 真实 SVG** 导出到 `.browser-check/block-fixtures.json`；
//   2) 本脚本在导航**之前**把夹具注入 `window.__DEV_BLOCK_FIXTURES`；
//   3) 桩的 `compile_blocks` 命中同文档的夹具时返回**真实产物**（见 browser-dev-stub.ts）；
//   4) 于是页面里量到的尺寸就是真 typst 的排版结果。
//
// 前置：`npm run dev -- --port 1425` + 一个 headless Chromium（CDP）。
// 运行：`CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks-visual.mjs`
import { readFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";

const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;
const FIXTURES = new URL("../../.browser-check/block-fixtures.json", import.meta.url).pathname;
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

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
console.log(`夹具：${fixtures.length} 篇真实块级切片产物（来自 Rust compile_blocks）`);

const c = await connect();
await c.send("Page.enable");
await c.evaluate(`localStorage.clear()`);
// 必须在导航前注入：桩在 compile_blocks 里优先取这里的产品
await c.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__DEV_BLOCK_FIXTURES = ${JSON.stringify(fixtures)};`,
});
await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));

for (const fx of fixtures) {
  console.log(`\n=== ${fx.name}（${fx.blocks.length} 块 / 列宽 ${fx.contentWidthPt}pt）`);
  // 逐篇输入同一份文档（桩按文档原文命中夹具）
  await c.click(400, 300);
  await c.selectAll();
  await c.type(fx.doc);
  await new Promise((r) => setTimeout(r, 700));

  // 量所有切片：宽度、高度、位置（都在同一坐标系里比，不假设窗口宽度）
  const measured = await c.evaluate(`(() => {
    const content = document.querySelector(".cm-content");
    const cr = content.getBoundingClientRect();
    const crops = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
      const r = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      return {
        x: r.left - cr.left,
        y: r.top - cr.top,
        w: r.width,
        h: r.height,
        svgH: svg ? svg.getBoundingClientRect().height : 0,
        // 内层 SVG 的内容盒是否也铺满（宽度靠 CSS 100%）
        svgW: svg ? svg.getBoundingClientRect().width : 0,
      };
    });
    return { columnWidth: cr.width, crops };
  })()`);

  const found = fx.blocks.filter((b) => b.svg && b.heightPt > 0.5);
  // 光标停在文档末尾 → 最后一块是"活动块"（源码形态），其余都是切片
  const expectCrops = found.length - 1;
  check(
    `切片数量 = 可渲染块数 − 1（活动块显示源码）：${measured.crops.length} / 期望 ${expectCrops}`,
    measured.crops.length === expectCrops,
    JSON.stringify({ crops: measured.crops.length, expect: expectCrops }),
  );
  if (measured.crops.length === 0) continue;

  // pt → px 换算因子：由切片实测宽度 / 夹具列宽推出（夹具在 371.25pt 下编译，
  // 浏览器里按 100% 列宽渲染 —— 不假设窗口尺寸，自己算比例）
  const factor = measured.crops[0].w / fx.contentWidthPt;
  check(`切片铺满正文列宽（±2px）`, Math.abs(measured.crops[0].w - measured.columnWidth) <= 2, JSON.stringify({
    crop: measured.crops[0].w,
    column: measured.columnWidth,
  }));

  // ① 每块高度 = 夹具高度 × 因子（切片按真实排版切出来，且没有被拉伸）
  let worstHeight = 0;
  let worstRatio = 0;
  for (let i = 0; i < measured.crops.length; i++) {
    const b = found[i];
    const expected = b.heightPt * factor;
    worstHeight = Math.max(worstHeight, Math.abs(measured.crops[i].h - expected));
    const domRatio = measured.crops[i].h / measured.crops[i].w;
    const fixtureRatio = b.heightPt / b.widthPt;
    worstRatio = Math.max(worstRatio, Math.abs(domRatio / fixtureRatio - 1));
  }
  check(
    `每块高度与真实排版一致（最大偏差 ${worstHeight.toFixed(2)}px，因子 ${factor.toFixed(3)}）`,
    worstHeight <= 2.5,
    `最大偏差 ${worstHeight.toFixed(2)}px`,
  );
  check(`切片没有被拉伸（高宽比与产物一致，最大偏差 ${(worstRatio * 100).toFixed(1)}%）`, worstRatio <= 0.02);

  // ② 相邻切片首尾相接（真实版式里各块按 y 序中点切带 ⇒ 摞起来不留缝、不重叠）
  let worstGap = 0;
  for (let i = 1; i < measured.crops.length; i++) {
    const gap = measured.crops[i].y - (measured.crops[i - 1].y + measured.crops[i - 1].h);
    worstGap = Math.max(worstGap, Math.abs(gap));
  }
  check(`相邻切片首尾相接（最大缝/重叠 ${worstGap.toFixed(2)}px）`, worstGap <= 2.5, `${worstGap.toFixed(2)}px`);

  // ③ 首尾跨度 = 夹具首块顶 → 末块底（切片摞起来的高度总和 == 原版式的纵向跨度）
  const spanPt = found[found.length - 2].yPt + found[found.length - 2].heightPt - found[0].yPt;
  const domSpan =
    measured.crops[measured.crops.length - 1].y +
    measured.crops[measured.crops.length - 1].h -
    measured.crops[0].y;
  check(
    `切片总跨度 = 真实版式跨度（DOM ${domSpan.toFixed(1)}px / 期望 ${(spanPt * factor).toFixed(1)}px）`,
    Math.abs(domSpan - spanPt * factor) <= 3,
  );

  // ④ 切片左缘对齐正文列（横向切的是"正文列"而不是墨迹 → 列表缩进、居中公式都不丢）
  check(
    "切片左缘对齐正文列左缘（±2px）",
    Math.abs(measured.crops[0].x) <= 2,
    `左缘偏移 ${measured.crops[0].x.toFixed(2)}px`,
  );

  // ⑤ 被盖住的块确实不在源码形态里（按 .cm-line 判 —— 切片 SVG 里也有渲染后的文字）
  const linesText = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent).join("\\n")`,
  );
  const covered = found[0];
  const coveredSrc = fx.doc.slice(covered.start, covered.end);
  check(
    "被切片盖住的第一块不是源码形态",
    !linesText.includes(coveredSrc.replace(/^=+\s*/, "")),
    JSON.stringify(linesText.slice(0, 80)),
  );

  // ⑥ 链接热区（阶段 3"链接可点"）：真实产物里 `#link("…")[…]` 的方框要变成可点的热区，
  //    位置按"带内相对 pt → 百分比"对得上（拿夹具里的 links 逐条比），点下去交给 opener 插件。
  const fixtureLinks = fx.blocks.flatMap((b, i) => (b.links ?? []).map((l) => ({ i, ...l })));
  if (fixtureLinks.length > 0) {
    const overlays = await c.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll(".cm-block-crop")) {
        const from = Number(el.dataset.blockFrom);
        const r = el.getBoundingClientRect();
        for (const a of el.querySelectorAll(".cm-block-crop-link")) {
          const ar = a.getBoundingClientRect();
          out.push({
            from,
            href: a.getAttribute("href"),
            left: (ar.left - r.left) / r.width,
            top: (ar.top - r.top) / r.height,
            w: ar.width / r.width,
            h: ar.height / r.height,
          });
        }
      }
      return out;
    })()`);
    const byteToPos = (doc, bytes) =>
      new TextDecoder().decode(new TextEncoder().encode(doc).slice(0, bytes)).length;
    let worst = 0;
    let matched = 0;
    for (const link of fixtureLinks) {
      const block = fx.blocks[link.i];
      if (!block.svg) continue; // 窗口外 / 活动块：这一轮没有切片
      const pos = byteToPos(fx.doc, block.start);
      const hit = overlays.find((o) => o.from === pos && o.href === link.href);
      if (!hit) continue;
      matched++;
      worst = Math.max(
        worst,
        Math.abs(hit.left - link.xPt / block.widthPt),
        Math.abs(hit.top - link.yPt / block.heightPt),
        Math.abs(hit.w - link.widthPt / block.widthPt),
        Math.abs(hit.h - link.heightPt / block.heightPt),
      );
    }
    check(
      `${fx.name}：${fixtureLinks.length} 个链接都渲染成热区、位置与真实几何一致（最大偏差 ${(worst * 100).toFixed(2)}%）`,
      matched === fixtureLinks.filter((l) => fx.blocks[l.i].svg).length && worst <= 0.02,
      JSON.stringify({ matched, overlays: overlays.length, worst }),
    );

    // 点一下热区：URL 交给 opener 插件，且**不动光标**（点链接是"打开"语义）
    const target = await c.evaluate(`(() => {
      const a = document.querySelector(".cm-block-crop-link");
      if (!a) return null;
      const r = a.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), href: a.getAttribute("href") };
    })()`);
    if (target) {
      const headBefore = await c.evaluate(
        `document.querySelector(".cm-content").cmTile.root.view.state.selection.main.head`,
      );
      await c.click(target.x, target.y);
      await new Promise((r) => setTimeout(r, 400));
      const opened = await c.evaluate(`window.__browserDevOpenUrls ?? []`);
      const headAfter = await c.evaluate(
        `document.querySelector(".cm-content").cmTile.root.view.state.selection.main.head`,
      );
      check(
        `${fx.name}：点热区 → opener 收到该 URL（${target.href}）`,
        Array.isArray(opened) && opened.includes(target.href),
        JSON.stringify({ opened }),
      );
      check(`${fx.name}：点热区不会挪动光标`, headAfter === headBefore, JSON.stringify({ headBefore, headAfter }));
      await c.evaluate(`window.__browserDevOpenUrls = []`);
    }
  }

  await c.screenshot(SHOT(`writing-blocks-visual-${fx.name}`));
}

console.log(`\n通过 ${passed} 项检查；截图：.browser-check/writing-blocks-visual-*.png`);
process.exit(process.exitCode ?? 0);
