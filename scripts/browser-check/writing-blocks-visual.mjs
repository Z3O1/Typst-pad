// 写作模式「局部切片几何」验收：正文/标题是真实文本，只有复杂块继续使用真实 typst 切片。
//
// 与 `writing-blocks.mjs` 的分工：
//   * `writing-blocks.mjs`          —— 桩产物，验**交互**（切片出现 / 光标进出 / 点击回源码 / 窗口化补渲）；
//   * `writing-blocks-visual.mjs`   —— **真实产物**，验**几何**（切片是按真实排版切下来的，
//                                      列宽、逐块高度、没有被拉伸、纵向位置与引擎的版式一致）。
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
  editableInFixture,
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

const directlyEditable = (fx, block) => editableInFixture(fx.doc, block);

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
  // pt → px 换算因子由复杂切片宽度推出；没有切片的纯正文场景取 CSS 的 4/3。
  const factor = measured.crops[0]?.w ? measured.crops[0].w / fx.contentWidthPt : 4 / 3;
  check(
    `复杂切片铺满正文列宽（±2px；无切片时不适用）`,
    measured.crops.every((crop) => Math.abs(crop.w - measured.columnWidth) <= 2),
    JSON.stringify({ crops: measured.crops.map((x) => x.w), column: measured.columnWidth }),
  );

  let worstHeight = 0;
  let worstRatio = 0;
  // 纵向位置：旧版有一条"切片总跨度 = 真实版式跨度"，正文不再切片后它失去前提被删掉；
  // 这里按"以首张复杂切片为基准的 y 偏移"补回覆盖（y 之前只量不用）。
  const yBase = expected[0];
  const yBaseCrop = yBase
    ? measured.crops.find((crop) => crop.from === byteToPos(fx.doc, yBase.start))
    : undefined;
  let worstY = 0;
  for (const crop of measured.crops) {
    const block = expected.find((x) => byteToPos(fx.doc, x.start) === crop.from);
    if (!block) continue;
    worstHeight = Math.max(worstHeight, Math.abs(crop.h - block.heightPt * factor));
    worstRatio = Math.max(
      worstRatio,
      Math.abs(crop.h / crop.w / (block.heightPt / block.widthPt) - 1),
    );
    if (yBase && yBaseCrop) {
      worstY = Math.max(worstY, Math.abs(crop.y - yBaseCrop.y - (block.yPt - yBase.yPt) * factor));
    }
  }
  check(`复杂切片高度与真实排版一致（最大偏差 ${worstHeight.toFixed(2)}px）`, worstHeight <= 2.5);
  check(`复杂切片没有被拉伸（最大偏差 ${(worstRatio * 100).toFixed(1)}%）`, worstRatio <= 0.02);
  check(`复杂切片纵向位置与真实排版一致（最大偏差 ${worstY.toFixed(2)}px）`, worstY <= 2.5);
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

// ---------------------------------------------------------------------------
// ⑧ **输入抖动回归**（2026-09-26）：敲一个字之后、编译结果落地之前，版面不许"先跳、后跳回"
//
// 旧行为：编辑会让被改块的几何失效（否则旧切片会盖住新字），而带高盒与"空行归零"是整篇同生共死的
// （见 `live-preview` 的 `bandBoxes`）—— 被改块一失效，**整篇**的带高盒与段距压缩同时关掉，
// 150~350ms 后编译落地再打开。真实夹具实测：整篇高度 347.1 → 333.7px、被编辑那一段
// 99.9 → 72.6px。现在被改块带着 `layoutHold` 的**占位几何**（`cm-block-band-hold`），
// 编译落地前版面完全不动 —— 这一节就是钉住它的。
//
// 用 `&blockslow=1`（桩把 compile_blocks 拖 350ms）把那段窗口撑开：桩默认瞬时返回，
// 这个竞态在浏览器里根本复现不出来。
console.log("\n=== 输入一个字：编译落地前版面不许先跳后跳回（输入抖动回归）");
{
  // 夹具是 371.25pt 列宽渲的：视口调窄到 600px 让列宽 ≈489px（同 writing-mode-scenes），
  // 这样带高盒的数值与夹具是同一套排版输入，量到的变化才不是缩放假象。
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c.goto(`${URL_BLOCKS}&blockslow=1`);
  const fx = fixtures.find((f) => f.name === "中文长段落");
  await replaceDocument(c, fx.doc);
  await c.waitFor(`window.__browserDevBlocksMatched === true`, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));

  /**
   * 版面的可观测量。
   *
   * **不要用 `view.contentHeight`**：它是 CodeMirror 高度图上的值，在 measure 之前是**上上次**
   * 布局的数字（实测：输入后立刻读到的是夹具命中之前的 319.81，而 DOM 里逐行的高一行没变）。
   * 这里一律走**强制同步布局的 DOM 量法**：每行的高、行的屏幕 y、滚动容器 scrollHeight、
   * 光标盒的屏幕 y —— 用户看到的"跳"就是这几个量在跳。
   */
  const LAYOUT = `(() => {
    const v = window.__typstPadView;
    const lines = Array.from(document.querySelectorAll(".cm-line"));
    const caret = v.coordsAtPos(v.state.selection.main.head);
    const heights = lines.map((l) => +l.getBoundingClientRect().height.toFixed(2));
    return {
      // 逐行高之和（含 content 的 padding 之外的部分）：版面变化的直接证据
      linesTotal: +heights.reduce((s, h) => s + h, 0).toFixed(2),
      scrollHeight: +v.scrollDOM.scrollHeight.toFixed(2),
      scrollTop: +v.scrollDOM.scrollTop.toFixed(2),
      tops: lines.map((l) => +l.getBoundingClientRect().top.toFixed(2)),
      bandVars: lines.map((l) => getComputedStyle(l).getPropertyValue("--write-band-h")),
      bandVarsFilled: lines.filter((l) =>
        (getComputedStyle(l).getPropertyValue("--write-band-h") || "").trim() !== "",
      ).length,
      bands: lines.filter((l) => l.matches(".cm-line.cm-block-band, .cm-line.cm-block-band-hold"))
        .length,
      lineHeights: heights,
      lineBoxHeights: lines.map((l) => getComputedStyle(l).lineHeight),
      marks: document.querySelectorAll(".cm-write-engine-break").length,
      caretTop: caret ? +caret.top.toFixed(2) : null,
      head: v.state.selection.main.head,
      // 这一态是"索引精确的产物"还是"编辑后的估算表"：用来证明"在飞窗口"真的在飞
      exact: window.__typstPadBlocks ? window.__typstPadBlocks.exact === true : null,
      compiles: window.__browserDevCallCounts?.compile_blocks ?? 0,
    };
  })()`;

  // 光标放到**最后一行可编辑正文**（夹具里的长段落，5 个视觉行、4 枚引擎断点）的行尾：
  // 它是"多视觉行 + 有断点"的最难情形，比标题更能暴露折行/带高的抖动。
  const placed = await c.evaluate(`(() => {
    const v = window.__typstPadView;
    const line = Array.from(document.querySelectorAll(".cm-line.cm-block-band")).at(-1);
    if (!line) return null;
    let pos = null;
    try { pos = v.posAtDOM(line, line.childNodes.length); } catch {}
    if (pos == null) return null;
    v.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    v.focus();
    return { pos, text: line.textContent.slice(0, 10) };
  })()`);
  check(
    "夹具里有一行可编辑正文在带高盒里（否则这一节量不到抖动）",
    !!placed,
    JSON.stringify(placed),
  );

  const before = await c.evaluate(LAYOUT);
  await c.type("字");
  // 编译还在飞（blockslow 350ms + 150ms 去抖）：此刻必须量到"版面一动没动"
  const during = await c.evaluate(LAYOUT);
  /**
   * **fail-closed：这一态必须真的是"在飞"**。编辑一落，页面会把块表标成估算（`exact:false`）；
   * 编译落地才回到 `exact:true`。如果这里量到的已经是精确态，说明这次编辑的窗口没被采到
   * （去抖/慢编译开关没生效）—— 那时"没动"是废话（压根没有可动的中间态），必须判红而不是绿。
   */
  check(
    `量到的是编辑后、编译落地前的窗口（exact ${before.exact} → ${during.exact}，compile_blocks ${before.compiles} → ${during.compiles}）`,
    before.exact === true && during.exact === false,
    JSON.stringify({ before: before.exact, during: during.exact, compiles: during.compiles }),
  );
  check(
    `编译落地前：整篇带高盒一个都不许少（${before.bands} → ${during.bands}）`,
    before.bands > 0 && during.bands === before.bands,
    JSON.stringify({ before: before.bands, during: during.bands }),
  );
  check(
    `编译落地前：整篇高度一动没动（逐行高之和 ${before.linesTotal} → ${during.linesTotal}px，` +
      `scrollHeight ${before.scrollHeight} → ${during.scrollHeight}px）`,
    Math.abs(during.linesTotal - before.linesTotal) <= 0.5 &&
      Math.abs(during.scrollHeight - before.scrollHeight) <= 0.5,
    JSON.stringify({ before, during }),
  );
  check(
    "编译落地前：每一行的屏幕位置、高、行高、带高变量都不变（不是先跳后跳回）",
    JSON.stringify(before.tops) === JSON.stringify(during.tops) &&
      JSON.stringify(before.lineHeights) === JSON.stringify(during.lineHeights) &&
      JSON.stringify(before.lineBoxHeights) === JSON.stringify(during.lineBoxHeights) &&
      JSON.stringify(before.bandVars) === JSON.stringify(during.bandVars),
    JSON.stringify({ before, during }),
  );
  check(
    `编译落地前：光标没被弹走（caretTop ${before.caretTop} → ${during.caretTop}px）`,
    before.caretTop !== null &&
      during.caretTop !== null &&
      Math.abs(during.caretTop - before.caretTop) <= 1,
    JSON.stringify({ before: before.caretTop, during: during.caretTop }),
  );
  check(
    `编译落地前：引擎断点没有被清掉（${before.marks} → ${during.marks}）`,
    before.marks > 0 && during.marks === before.marks,
    JSON.stringify({ before: before.marks, during: during.marks }),
  );
  /**
   * 编译落地之后**不再要求"带高盒回来"**：桩的假块没有 `anchorBaselinePt`（`fakeBlocks` 不产
   * 这个字段），编辑一发生夹具就不再逐字命中，这一轮的产物必然是"没有带高的假块" —— 那是桩的
   * 局限，不是产品行为（真机上 Rust 每次都给逐块基线）。这里只钉住两条**与产物来源无关**的契约：
   *   ① 这个窗口不是空等：新一轮 `compile_blocks` 真的落地了（`exact` 回到 true）；
   *   ② 带高盒**不许半套**：有带高的行数必须正好等于真的写了 `--write-band-h` 的行数
   *      （"半套规则比不启用更差"是这条链路的既有契约）。
   */
  await c.waitFor(`window.__typstPadBlocks && window.__typstPadBlocks.exact === true`, {
    timeout: 10000,
  });
  const after = await c.evaluate(LAYOUT);
  check(
    `编译落地：精确产物真的换了一轮（exact ${during.exact} → ${after.exact}，compile_blocks ${during.compiles} → ${after.compiles}）`,
    after.exact === true && after.compiles >= during.compiles,
    JSON.stringify({ during: during.compiles, after: after.compiles }),
  );
  check(
    `编译落地后：带高盒整篇一致、不许半套（${after.bands} 行带高 / ${after.bandVarsFilled} 条变量；` +
      `逐行高之和 ${after.linesTotal}px）`,
    after.bandVarsFilled === after.bands,
    JSON.stringify({ after }),
  );
}

// ---------------------------------------------------------------------------
// ⑨ **列表项点击前后对照**（2026-09-26）：简单单行 `-`/`+` 项点项目符号露出源码之后，
//     正文的字号/字重/左缘/行高/屏幕位置、以及相邻项与邻接正文，都必须与点击前一致。
//
// 旧行为：揭示态**什么都不加**，源码 `- ` 按自然字宽画 —— 真实夹具实测正文左缘从 66.47 掉到
// 61.97px（圆点项 −4.5px）、序号项 `+ 有序一` 从 71.38 掉到 61.97（**−9.4px**），点过的那一项
// 与同级其它项的文字对不齐（用户报的"点击后缩进/排版明显不同"）。现在揭示态给源码套一个与
// 呈现态 widget **同一个盒子模型**的定宽行内 mark（盒宽 = 引擎给的正文起点），源码仍可编辑。
console.log("\n=== 点列表项的项目符号：正文左缘/行高/相邻项都不许动");
{
  await c.goto(URL_BLOCKS);
  const fx = fixtures.find((f) => f.name === "列表与嵌套");
  await replaceDocument(c, fx.doc);
  await c.waitFor(`window.__browserDevBlocksMatched === true`, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 400));

  /** 量某一行的正文左缘（找包含 `body` 的那个文本节点）、行盒几何与标记形态 */
  const measureExpr = (lineNeedle, bodyNeedle) =>
    [
      "(() => {",
      "  const lines = Array.from(document.querySelectorAll('.cm-line'));",
      "  const line = lines.find((l) => l.textContent.includes(" +
        JSON.stringify(lineNeedle) +
        "));",
      "  if (!line) return null;",
      "  const r = line.getBoundingClientRect();",
      "  const cs = getComputedStyle(line);",
      "  let bodyLeft = null;",
      "  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);",
      "  let nd;",
      "  while ((nd = walk.nextNode())) {",
      "    if (!nd.data.includes(" + JSON.stringify(bodyNeedle) + ")) continue;",
      "    const rg = document.createRange();",
      "    rg.selectNodeContents(nd);",
      "    bodyLeft = +rg.getBoundingClientRect().left.toFixed(2);",
      "    break;",
      "  }",
      "  return {",
      "    bodyLeft,",
      "    top: +r.top.toFixed(2),",
      "    height: +r.height.toFixed(2),",
      "    lineHeight: cs.lineHeight,",
      "    font: cs.fontSize + '/' + cs.fontWeight + '/' + cs.fontFamily.split(',')[0],",
      "    text: line.textContent.slice(0, 22),",
      "    widget: !!line.querySelector('.cm-markup-list-marker'),",
      "    indentBox: !!line.querySelector('.cm-markup-list-indent'),",
      "    source: line.textContent.startsWith('- ') || line.textContent.startsWith('+ '),",
      "    caret: window.__typstPadView.state.selection.main.head,",
      "  };",
      "})()",
    ].join("\n");

  const measure = (lineNeedle, bodyNeedle) => c.evaluate(measureExpr(lineNeedle, bodyNeedle));
  /** 点某一行的行首（项目符号所在处） */
  const clickBullet = async (needle) => {
    const at = await c.evaluate(
      [
        "(() => {",
        "  const lines = Array.from(document.querySelectorAll('.cm-line'));",
        "  const line = lines.find((l) => l.textContent.includes(" + JSON.stringify(needle) + "));",
        "  if (!line) return null;",
        "  const r = line.getBoundingClientRect();",
        "  return { x: r.left + 2, y: (r.top + r.bottom) / 2 };",
        "})()",
      ].join("\n"),
    );
    if (!at) throw new Error("找不到列表项 " + needle);
    await c.click(at.x, at.y);
    await new Promise((r) => setTimeout(r, 400));
  };

  const item = (source) => {
    const block = fx.blocks.find(
      (b) =>
        (b.kind === "ListItem" || b.kind === "EnumItem") &&
        fx.doc.slice(byteToPos(fx.doc, b.start), byteToPos(fx.doc, b.end)) === source,
    );
    if (!block) throw new Error("夹具里没有列表项 " + source);
    return {
      from: byteToPos(fx.doc, block.start),
      to: byteToPos(fx.doc, block.end),
      marker: block.listMarker,
    };
  };
  const first = item("- 第一项：无序列表");
  const third = item("- 第三项");
  const enumFirst = item("+ 有序一");
  const tailFrom = byteToPos(fx.doc, fx.blocks.at(-1).start);

  const before = await measure("第一项：无序列表", "第一项");
  const beforeThird = await measure("第三项", "第三项");
  const beforeTail = await measure("列表之后的收尾", "列表之后");
  const beforeEnum = await measure("有序一", "有序一");

  // ① 点项目符号 → 源码 `- ` 露出，但**版面一动没动**
  await clickBullet("第一项：无序列表");
  const afterBullet = await measure("第一项：无序列表", "第一项");
  const afterThird = await measure("第三项", "第三项");
  const afterTail = await measure("列表之后的收尾", "列表之后");
  check(
    `点项目符号：这一项露出的确实是可编辑源码（${JSON.stringify(before.text)} → ${JSON.stringify(afterBullet.text)}）`,
    before.widget === true &&
      before.source === false &&
      afterBullet.source === true &&
      afterBullet.widget === false,
    JSON.stringify({ before, afterBullet }),
  );
  check(
    `点项目符号：正文左缘不动（${before.bodyLeft} → ${afterBullet.bodyLeft}px；旧行为 −4.5px）`,
    // 定宽缩进盒（`cm-markup-list-indent`）就是"左缘不动"的实现；它和数值一起断言，
    // 免得将来有人把盒拆了却因为别的样式恰好没偏移而报绿
    afterBullet.indentBox === true &&
      afterBullet.bodyLeft !== null &&
      Math.abs(afterBullet.bodyLeft - before.bodyLeft) <= 0.5,
    JSON.stringify({
      before: before.bodyLeft,
      after: afterBullet.bodyLeft,
      box: afterBullet.indentBox,
    }),
  );
  check(
    `点项目符号：字号/字重/行高/行盒位置都不动（${before.font} / ${before.lineHeight} / top ${before.top}）`,
    afterBullet.font === before.font &&
      afterBullet.lineHeight === before.lineHeight &&
      afterBullet.top === before.top &&
      afterBullet.height === before.height,
    JSON.stringify({ before, afterBullet }),
  );
  check(
    `点项目符号：相邻项与邻接正文不动（第三项 top ${beforeThird.top} → ${afterThird.top}；` +
      `收尾段 top ${beforeTail.top} → ${afterTail.top}）`,
    afterThird.top === beforeThird.top && afterTail.top === beforeTail.top,
    JSON.stringify({ beforeThird, afterThird, beforeTail, afterTail }),
  );
  check(
    `点项目符号：光标落在**这一项**的源码里（head ${afterBullet.caret} ∈ [${first.from},${first.to}]）`,
    afterBullet.caret >= first.from && afterBullet.caret <= first.to,
    JSON.stringify({ caret: afterBullet.caret, from: first.from, to: first.to }),
  );

  // ② 点正文（不是项目符号）→ 回到呈现态（`•` widget），版面同样不许动
  const atBody = await c.evaluate(
    [
      "(() => {",
      "  const lines = Array.from(document.querySelectorAll('.cm-line'));",
      "  const line = lines.find((l) => l.textContent.includes('第一项：无序列表'));",
      "  const r = line.getBoundingClientRect();",
      "  return { x: r.left + r.width / 2, y: (r.top + r.bottom) / 2 };",
      "})()",
    ].join("\n"),
  );
  await c.click(atBody.x, atBody.y);
  await new Promise((r) => setTimeout(r, 400));
  const afterBodyClick = await measure("第一项：无序列表", "第一项");
  check(
    `点正文：标记回到呈现态且正文左缘与点击前一致（widget=${afterBodyClick.widget}，` +
      `left ${before.bodyLeft} → ${afterBodyClick.bodyLeft}px）`,
    afterBodyClick.widget === true &&
      afterBodyClick.bodyLeft !== null &&
      Math.abs(afterBodyClick.bodyLeft - before.bodyLeft) <= 0.5,
    JSON.stringify({ afterBodyClick }),
  );

  // ③ 序号项是差异最大的一档（旧行为 −9.4px）：同一套判据再量一次
  await clickBullet("有序一");
  const afterEnum = await measure("有序一", "有序一");
  check(
    `序号项点项目符号：正文左缘不动（${beforeEnum.bodyLeft} → ${afterEnum.bodyLeft}px；旧行为 −9.4px）`,
    afterEnum.bodyLeft !== null && Math.abs(afterEnum.bodyLeft - beforeEnum.bodyLeft) <= 0.5,
    JSON.stringify({ beforeEnum, afterEnum }),
  );
  check(
    `序号项点项目符号：标记位置仍取引擎值（${JSON.stringify(beforeEnum.text)} → ${JSON.stringify(afterEnum.text)}）`,
    afterEnum.source === true && afterEnum.bodyLeft >= beforeEnum.bodyLeft - 0.5,
    JSON.stringify({ beforeEnum, afterEnum }),
  );

  // ④ 源码仍然可编辑：输入一个字进这一项 → 撤销回原文（"点击落到正确项、输入改正确源码"）
  const beforeType = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  await c.type("甲");
  const typed = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 300));
  const undone = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  check(
    `点项目符号后输入：改的是**这一项**的源码，且撤销回原文（长度 ${beforeType.length} → ${typed.length} → ${undone.length}）`,
    typed.length === beforeType.length + 1 &&
      typed !== beforeType &&
      undone === fx.doc &&
      typed
        .slice(Math.max(0, Math.min(typed.length, afterEnum.caret) - 2), afterEnum.caret + 2)
        .includes("甲"),
    JSON.stringify({ head: afterEnum.caret, typed: typed.slice(0, 40) }),
  );
}

finish(`通过 ${state.passed} 项检查；截图：.browser-check/writing-blocks-visual-*.png`);
