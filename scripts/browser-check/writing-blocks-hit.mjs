// 写作模式「点击定位」验收：**用真实排版几何**验"点在哪儿，光标就落在哪个字符上"。
//
// 与另外两套块级验收的分工：
//   * `writing-blocks.mjs`        —— 桩产物，验**交互**（切片出现 / 光标进出 / 展开 / 窗口化 / 翻页…）；
//   * `writing-blocks-visual.mjs` —— 真实产物，验**几何**（切片摞起来 == 原版式）；
//   * 本脚本                      —— 真实产物，验**点击 → 精确字符**（阶段 2）。
//
// 链路：
//   1) `npm run fixtures:blocks`：Rust 侧的 `dump_block_fixtures` 除了每块的切片与几何，
//      还导出 `hitProbes` —— 每块 15 个网格点，**每个点的答案是真实几何上 `hit_test` 算出来的
//      字节偏移**（期望值来自引擎，不是前端自己猜的）；
//   2) 本脚本在导航前把夹具注入 `window.__DEV_BLOCK_FIXTURES`；
//   3) 桩的 `compile_blocks` 返回真实切片、`block_hit_test` 返回**离点击点最近的探针的答案**
//      （见 browser-dev-stub.ts 的 fixtureHit：只有探针点上的答案是真实的，所以本脚本
//      就照探针点原样点下去）；
//   4) 断言：点击 → 页面的块级装饰链路 → 光标位置，与夹具里记的字节偏移逐一相等。
//
// 另外两条断言（阶段 2 的手感）：
//   * 点完那一块变回源码、其余块仍是切片；
//   * 点击前后**被点的字符留在鼠标那一带**（滚动锚定；文档不够长、滚不动时按"位置本就够近"判）。
//
// 前置：`npm run dev -- --port 1425` + 一个 headless Chromium（CDP，见 cdp.mjs 注释）。
// 运行：`npm run fixtures:blocks && CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks-hit.mjs`
// 环境变量 HIT_FULL=1 → 跑全部 15 个探针（默认每块 4 个，够覆盖左中右 × 三行，跑得快）
import { readFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";

const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;
const FIXTURES = new URL("../../.browser-check/block-fixtures.json", import.meta.url).pathname;
const URL_BLOCKS = `${DEV_URL}&blocks=1`;
const FULL = process.env.HIT_FULL === "1";
/** 默认取这 4 个探针下标（0=左上 6=中上 11=中下 14=右下），完整网格见 HIT_FULL */
const PROBE_PICK = FULL ? null : [0, 6, 11, 14];

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
const withProbes = fixtures.filter((f) => Array.isArray(f.hitProbes) && f.hitProbes.length > 0);
console.log(
  `夹具：${withProbes.length} 篇带点击探针的真实产物（共 ${withProbes.reduce((n, f) => n + f.hitProbes.length, 0)} 个探针点）`,
);

const c = await connect();
await c.send("Page.enable");
await c.send("Runtime.enable");
// 必须在导航前注入：桩在 compile_blocks / block_hit_test 里优先取这里的产品
await c.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__DEV_BLOCK_FIXTURES = ${JSON.stringify(fixtures)};`,
});

/**
 * 页面里的取数小工具（注入一次，后面都用它）：
 * - `view()`：CodeMirror 的 EditorView —— 通过内容元素上的 `cmTile.root.view` 拿
 *   （CM6 把 DOM 瓦片挂在元素上；这是验收专用的取数，页面代码本身不依赖它）；
 * - 顺带记住文档原文，用来算"字节偏移 ↔ UTF-16 位置"。
 */
const INSTALL = `(() => {
  const el = document.querySelector(".cm-content");
  const view = el && el.cmTile && el.cmTile.root && el.cmTile.root.view;
  if (!view) return false;
  const scroller = document.querySelector(".cm-scroller");
  const rectOf = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
  return true;
})()`;

await c.goto(URL_BLOCKS);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 600));
await c.evaluate(INSTALL);

/** 点击点 → 页面坐标 → 视口坐标（照探针点的定义反算） */
async function probePoint(blockFrom, block, probe) {
  return c.evaluate(`(() => {
    const el = document.querySelector('.cm-block-crop[data-block-from="${blockFrom}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = r.left + ((${probe.x} - ${block.xPt}) / ${block.widthPt}) * r.width;
    const y = r.top + ((${probe.y} - ${block.yPt}) / ${block.heightPt}) * r.height;
    return { x, y, visible: y > 4 && y < innerHeight - 4 && x > 4 && x < innerWidth - 4 };
  })()`);
}

/** 当前光标（CodeMirror 位置 + 它对应多少字节 + 屏幕 y） */
async function caret() {
  return c.evaluate(`(() => {
    const el = document.querySelector(".cm-content");
    const view = el.cmTile.root.view;
    const doc = view.state.doc.toString();
    const head = view.state.selection.main.head;
    let bytes = 0;
    for (const ch of doc.slice(0, head)) {
      const cp = ch.codePointAt(0);
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    }
    const co = view.coordsAtPos(head);
    const s = view.scrollDOM;
    return {
      head,
      bytes,
      line: view.state.doc.lineAt(head).number,
      caretY: co ? (co.top + co.bottom) / 2 : null,
      // 行高用 CodeMirror 自己的值：.cm-line 的矩形高度在折行段落里是"好几行"的高度
      lineHeight: view.defaultLineHeight,
      scrollTop: s.scrollTop,
      maxScroll: s.scrollHeight - s.clientHeight,
    };
  })()`);
}

const byteToPos = (doc, bytes) => new TextDecoder().decode(new TextEncoder().encode(doc).slice(0, bytes)).length;

let totalClicks = 0;
let totalMatched = 0;
let totalSkipped = 0;

for (const fx of withProbes) {
  const picked = PROBE_PICK ? fx.hitProbes.filter((_, i) => PROBE_PICK.includes(i % 15)) : fx.hitProbes;
  console.log(`\n=== ${fx.name}（${fx.blocks.length} 块 / ${picked.length} 个探针点）`);
  // 逐篇输入同一份文档（桩按文档原文命中夹具）
  await c.click(400, 300);
  await c.selectAll();
  await c.type(fx.doc);
  await new Promise((r) => setTimeout(r, 700));
  // 光标挪到文档开头：第一块成为"活动块"（源码形态），其余块都是切片
  await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
  await new Promise((r) => setTimeout(r, 350));

  // 按块分组（每块若干探针），轮转下单：点完一块它就变源码，所以下一次点**另一块**
  const byBlock = new Map();
  for (const p of picked) {
    if (!byBlock.has(p.b)) byBlock.set(p.b, []);
    byBlock.get(p.b).push(p);
  }
  const rounds = Math.max(...[...byBlock.values()].map((v) => v.length));
  let activeIndex = 0; // 光标所在块（活动块 = 源码，没有切片可点）
  let clicked = 0;
  let matched = 0;
  let worstDrift = 0;
  let driftFail = 0;
  let lineHeight = 30;

  for (let round = 0; round < rounds; round++) {
    for (const [blockIndex, probes] of byBlock) {
      const probe = probes[round];
      if (!probe) continue;
      if (blockIndex === activeIndex) continue; // 活动块此刻是源码，跳过（下一轮它已变回切片）
      const block = fx.blocks[blockIndex];
      if (!block.svg) continue;
      const blockFrom = byteToPos(fx.doc, block.start);
      const pt = await probePoint(blockFrom, block, probe);
      if (!pt || !pt.visible) {
        totalSkipped++;
        continue;
      }
      const before = await caret();
      await c.click(Math.round(pt.x), Math.round(pt.y));
      await new Promise((r) => setTimeout(r, 220));
      const after = await caret();
      totalClicks++;
      clicked++;
      const expectPos = byteToPos(fx.doc, probe.o);
      const ok = after.bytes === probe.o && after.head === expectPos;
      if (ok) {
        matched++;
        totalMatched++;
      } else {
        console.log(
          `  ✗ 块 ${blockIndex} 探针(${probe.x}, ${probe.y}) → 期望字节 ${probe.o}/位置 ${expectPos}，实际字节 ${after.bytes}/位置 ${after.head}`,
        );
        process.exitCode = 1;
      }
      // 纵向锚定：被点的字符应当仍在鼠标那一带。判据要认"滚不动"这一档 ——
      // 夹具都是短文档（内容高度 ≤ 视口，maxScroll = 0），锚定想补偿也没有滚动余量；
      // 真有滚动余量的情况在 writing-blocks.mjs 第 9 组（长文档）里验。
      lineHeight = after.lineHeight;
      const drift = after.caretY === null ? 0 : Math.abs(after.caretY - pt.y);
      worstDrift = Math.max(worstDrift, drift);
      if (drift > lineHeight * 1.5 && after.maxScroll > 1) {
        driftFail++;
        console.log(
          `  ✗ 块 ${blockIndex} 点击后光标跑偏 ${drift.toFixed(0)}px（行高 ${lineHeight.toFixed(0)}，滚动 ${before.scrollTop}→${after.scrollTop}，可滚 ${after.maxScroll.toFixed(0)}）`,
        );
      }
      activeIndex = blockIndex;
    }
  }

  check(
    `${fx.name}：${clicked} 次点击全部落在真实几何给出的字符上`,
    clicked > 0 && matched === clicked,
    `命中 ${matched}/${clicked}`,
  );
  check(
    `${fx.name}：点击后被点的字符仍在鼠标那一带（最大偏移 ${worstDrift.toFixed(0)}px / 行高 ${lineHeight.toFixed(0)}px；短文档无滚动余量时不判）`,
    driftFail === 0,
    `跑偏 ${driftFail} 次`,
  );

  // 点完之后：被点的那一块是源码形态，别的块仍是切片
  const cropsNow = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => Number(el.dataset.blockFrom))`,
  );
  const activeFrom = byteToPos(fx.doc, fx.blocks[activeIndex].start);
  check(
    "被点的块回到源码形态、其余块仍是切片",
    !cropsNow.includes(activeFrom) && cropsNow.length > 0,
    JSON.stringify({ cropsNow, activeFrom }),
  );

  await c.screenshot(SHOT(`writing-blocks-hit-${fx.name}`));
}

console.log(
  `\n点击合计：命中 ${totalMatched}/${totalClicks}，跳过 ${totalSkipped}（探针点不在视口内）；通过 ${passed} 项检查`,
);
console.log("截图：.browser-check/writing-blocks-hit-*.png");
process.exit(process.exitCode ?? 0);
