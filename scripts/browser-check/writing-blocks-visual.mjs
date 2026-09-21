// 写作模式「局部切片几何」验收：正文/标题是真实文本，只有复杂块继续使用真实 typst 切片。
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
import { connect } from "./cdp.mjs";
import {
  BLOCKS_URL as URL_BLOCKS,
  boot,
  byteToPos,
  createChecker,
  finish,
  loadFixtures,
  replaceDocument,
  shotPath as SHOT,
} from "./harness.mjs";

const { check, state } = createChecker();

const fixtures = loadFixtures("block-fixtures.json", { hint: "先跑 npm run fixtures:blocks" });
console.log(`夹具：${fixtures.length} 篇真实块级切片产物（来自 Rust compile_blocks）`);

const c = await connect();
await boot(c, URL_BLOCKS, { blockFixtures: fixtures, settleMs: 600 });

/** 与前端第一阶段同口径：纯 markup 的 Paragraph / Heading 直接编辑；不确定语法保留切片。 */
const directlyEditable = (fx, block) => {
  if (!block.found || block.skipped || !["Paragraph", "Heading"].includes(block.kind)) return false;
  const from = byteToPos(fx.doc, block.start);
  const to = byteToPos(fx.doc, block.end);
  return !/(#|`|\/\/|\/\*|")/.test(fx.doc.slice(from, to));
};

for (const fx of fixtures) {
  console.log(`\n=== ${fx.name}（${fx.blocks.length} 块 / 列宽 ${fx.contentWidthPt}pt）`);
  // 逐篇输入同一份文档（桩按文档原文命中夹具）
  await replaceDocument(c, fx.doc);

  // 量所有切片：宽度、高度、位置（都在同一坐标系里比，不假设窗口宽度）
  const measured = await c.evaluate(`(() => {
    const content = document.querySelector(".cm-content");
    const cr = content.getBoundingClientRect();
    const crops = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
      const r = el.getBoundingClientRect();
      const svg = el.querySelector("svg");
      return {
        from: Number(el.dataset.blockFrom),
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
  const last = fx.blocks.at(-1);
  const expected = found.filter((b) => b !== last && !directlyEditable(fx, b));
  const expectedFrom = expected.map((b) => byteToPos(fx.doc, b.start));
  const actualFrom = measured.crops.map((b) => b.from);
  check(
    `切片只覆盖复杂块：${measured.crops.length} / 期望 ${expected.length}`,
    JSON.stringify(actualFrom) === JSON.stringify(expectedFrom),
    JSON.stringify({ actualFrom, expectedFrom }),
  );
  const directFrom = found
    .filter((b) => directlyEditable(fx, b))
    .map((b) => byteToPos(fx.doc, b.start));
  check(
    "普通正文/标题没有退回整块 SVG",
    directFrom.every((from) => !actualFrom.includes(from)),
    JSON.stringify({ directFrom, actualFrom }),
  );

  // pt → px 换算因子由复杂切片宽度推出；没有切片的纯正文场景取 CSS 的 4/3。
  const factor = measured.crops[0]?.w ? measured.crops[0].w / fx.contentWidthPt : 4 / 3;
  check(
    `复杂切片铺满正文列宽（±2px；无切片时不适用）`,
    measured.crops.every((crop) => Math.abs(crop.w - measured.columnWidth) <= 2),
    JSON.stringify({ crops: measured.crops.map((x) => x.w), column: measured.columnWidth }),
  );

  let worstHeight = 0;
  let worstRatio = 0;
  for (const crop of measured.crops) {
    const block = expected.find((x) => byteToPos(fx.doc, x.start) === crop.from);
    if (!block) continue;
    worstHeight = Math.max(worstHeight, Math.abs(crop.h - block.heightPt * factor));
    worstRatio = Math.max(
      worstRatio,
      Math.abs(crop.h / crop.w / (block.heightPt / block.widthPt) - 1),
    );
  }
  check(`复杂切片高度与真实排版一致（最大偏差 ${worstHeight.toFixed(2)}px）`, worstHeight <= 2.5);
  check(`复杂切片没有被拉伸（最大偏差 ${(worstRatio * 100).toFixed(1)}%）`, worstRatio <= 0.02);
  check(
    "复杂切片左缘对齐正文列左缘（±2px）",
    measured.crops.every((crop) => Math.abs(crop.x) <= 2),
    JSON.stringify(measured.crops.map((x) => x.x)),
  );

  const linesText = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent).join("\\n")`,
  );
  const covered = expected[0];
  const coveredSrc = covered
    ? fx.doc.slice(byteToPos(fx.doc, covered.start), byteToPos(fx.doc, covered.end))
    : "";
  check(
    covered ? "被切片盖住的复杂块不是源码形态" : "纯正文场景仍有可编辑文本",
    covered ? !linesText.includes(coveredSrc.replace(/^=+\s*/, "")) : linesText.trim().length > 0,
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
      check(
        `${fx.name}：点热区不会挪动光标`,
        headAfter === headBefore,
        JSON.stringify({ headBefore, headAfter }),
      );
      // **点完链接还得能打字**：热区的 mousedown 不 preventDefault 的话，浏览器会把焦点给这个
      // `<a>`，编辑区随之失焦（Windows WebView2 / Chromium 上都这样）——用户点完链接回来
      // 一个字都打不进去（PR #60 审查的第 6 条）。所以断言焦点仍在编辑区里。
      // 判据必须是"焦点就在 `.cm-content` 这个 contenteditable 上"，**不能**只判"焦点在
      // 编辑区里面"—— 热区 `<a>` 本身就是 `.cm-content` 的后代，永远满足 contains()，
      // 那条判据等于恒真（实测：把 preventDefault 去掉它照样绿）。
      const focused = await c.evaluate(`(() => {
        const ae = document.activeElement;
        const content = document.querySelector(".cm-content");
        return { isContent: !!ae && ae === content,
                 tag: ae ? ae.tagName : null, cls: ae ? String(ae.className) : null };
      })()`);
      check(
        `${fx.name}：点热区之后焦点仍在编辑内容元素上（不然点完链接打不进字）`,
        focused.isContent === true,
        JSON.stringify(focused),
      );
      await c.evaluate(`window.__browserDevOpenUrls = []`);
    }
  }

  await c.screenshot(SHOT(`writing-blocks-visual-${fx.name}`));
}

finish(`通过 ${state.passed} 项检查；截图：.browser-check/writing-blocks-visual-*.png`);
