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

const FULL = process.env.HIT_FULL === "1";
/** 默认取这 4 个探针下标（0=左上 6=中上 11=中下 14=右下），完整网格见 HIT_FULL */
const PROBE_PICK = FULL ? null : [0, 6, 11, 14];

const { check, state } = createChecker();

/**
 * 这一篇夹具**期望**有几张复杂块切片（与套件末尾那三条期望判据同一口径）。
 * 纯正文/标题的夹具是 0 —— 那些夹具就不该等切片出现（见循环里的等待说明）。
 */
function fixtureBlocksNeedingCrops(fx) {
  const last = fx.blocks.at(-1);
  return fx.blocks.filter(
    (b) => b.svg && b.heightPt > 0.5 && b !== last && !editableInFixture(fx.doc, b),
  ).length;
}

// 空夹具 / 没探针 = 0 次点击 + 退出码 0 的假绿 ⇒ 必须硬失败
const fixtures = loadFixtures("block-fixtures.json", {
  predicate: (f) =>
    f.length > 0 && f.some((x) => Array.isArray(x.hitProbes) && x.hitProbes.length > 0),
  what: "点击探针夹具",
  hint: "先跑 npm run fixtures:blocks",
});
const withProbes = fixtures.filter((f) => Array.isArray(f.hitProbes) && f.hitProbes.length > 0);
console.log(
  `夹具：${withProbes.length} 篇带点击探针的真实产物（共 ${withProbes.reduce((n, f) => n + f.hitProbes.length, 0)} 个探针点）`,
);

const c = await connect();
// 这里**不需要** `Runtime.enable`：本套件不读 `c.events`（只有 writing-blocks.mjs 与 probe.mjs 读）。
// 拆分前那份代码顺手开了它，但没有任何断言用到；清掉免得后来人以为这里在查控制台。
await boot(c, URL_BLOCKS, { blockFixtures: fixtures, settleMs: 600 });

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

let totalClicks = 0;
let totalMatched = 0;
let totalSkipped = 0;
/** 全场真的出现过多少张切片：**必须无条件断言 > 0** —— 否则"复杂块再也不切片"这种真回归会让
 *  每篇都走 `clicked === 0` 的分支、两条断言都判绿（计数还是恒定的 3×N，守卫抓不到）。 */
let sawCrops = 0;

for (const fx of withProbes) {
  const picked = PROBE_PICK
    ? fx.hitProbes.filter((_, i) => PROBE_PICK.includes(i % 15))
    : fx.hitProbes;
  console.log(`\n=== ${fx.name}（${fx.blocks.length} 块 / ${picked.length} 个探针点）`);
  // 逐篇输入同一份文档（桩按文档原文命中夹具）
  await replaceDocument(c, fx.doc);
  // 光标挪到文档开头：第一块成为"活动块"（源码形态），其余块都是切片
  await c.key("Home", { code: "Home", keyCode: 36, modifiers: 2 });
  /**
   * 等这一篇的**产物真的到位**。判据是"桩命中了夹具"（`__browserDevBlocksMatched`）。
   *
   * 以前无条件等 `crop 数 > 0`：对**纯正文/标题**那几篇"本来就不该有切片"的夹具必然等满 8s
   * 超时而白等（11 篇里有一半是这种，实测每篇 8s，合计半分钟以上）；而"没有切片"恰恰是本套件
   * 对这些夹具的**期望**，不是失败信号。命中夹具才是"这一轮编译落地了、断言不跑在旧表上"的
   * 确定信号。有切片的夹具再额外等一次切片出现。
   */
  const expectCrops = fixtureBlocksNeedingCrops(fx);
  await c.waitFor(`window.__browserDevBlocksMatched === true`, { timeout: 8000 }).catch(() => {});
  if (expectCrops > 0) {
    await c
      .waitFor(`document.querySelectorAll(".cm-block-crop").length > 0`, { timeout: 8000 })
      .catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 200));
  const initialCrops = await c.evaluate(
    `Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => Number(el.dataset.blockFrom))`,
  );
  sawCrops += initialCrops.length;

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
      // **链接热区上的探针点要跳过**：那里是"打开链接"的热区（阶段 3），点下去不会挪光标，
      // 拿它去验"点击定位"只会误报。热区的坐标在夹具里（links，带内相对 pt）。
      const inLink = (block.links ?? []).some(
        (l) =>
          probe.x >= l.xPt - 1 &&
          probe.x <= l.xPt + l.widthPt + 1 &&
          probe.y >= l.yPt - 1 &&
          probe.y <= l.yPt + l.heightPt + 1,
      );
      if (inLink) {
        totalSkipped++;
        continue;
      }
      const blockFrom = byteToPos(fx.doc, block.start);
      const pt = await probePoint(blockFrom, block, probe);
      if (!pt || !pt.visible) {
        totalSkipped++;
        continue;
      }
      const before = await caret();
      await c.click(Math.round(pt.x), Math.round(pt.y));
      /**
       * **等"光标真的落到引擎给的字节偏移上"**（有超时），不是固定 sleep(220)。
       *
       * 命中结果是异步回来的（真机走 Rust IPC、桩也走一个 Promise），可"回来得慢"与"回错了"
       * 是两件事：固定 220ms 既会在慢机器上假红，又在本机白等 —— 这一套的探针点合计几百个
       * （实测 675 个），按 220ms 算是**分把钟**的空等。轮询判据就是断言本身要看的那个值。
       */
      const expectPos = byteToPos(fx.doc, probe.o);
      await c
        .waitFor(
          `document.querySelector(".cm-content").cmTile.root.view.state.selection.main.head === ${expectPos}`,
          { timeout: 1500, interval: 20 },
        )
        .catch(() => {});
      const after = await caret();
      totalClicks++;
      clicked++;
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
    clicked > 0
      ? `${fx.name}：${clicked} 次复杂块点击全部落在真实几何给出的字符上`
      : `${fx.name}：纯正文/标题没有生成可点击切片`,
    clicked > 0 ? matched === clicked : initialCrops.length === 0,
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
    clicked > 0 ? "被点的复杂块回到源码形态" : "纯正文场景始终保持真实文本",
    clicked > 0 ? !cropsNow.includes(activeFrom) : cropsNow.length === 0,
    JSON.stringify({ cropsNow, activeFrom }),
  );

  await c.screenshot(SHOT(`writing-blocks-hit-${fx.name}`));
}

// **无条件**的一条：整场至少真的量到过一张切片。没有它，一个"复杂块全都不再切片"的回归会让
// 上面两条三元断言一起判绿（它们的分支各自算 1 项，计数守卫看不出来）。
check(
  "全场至少有一篇夹具真的生成了可点击切片（否则本套等于没验点击定位）",
  sawCrops > 0,
  `初始切片合计 ${sawCrops} 张`,
);

finish(
  `点击合计：命中 ${totalMatched}/${totalClicks}，跳过 ${totalSkipped}（探针点不在视口内）；通过 ${state.passed} 项检查\n` +
    "截图：.browser-check/writing-blocks-hit-*.png",
);
