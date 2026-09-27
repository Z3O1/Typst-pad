// **输入性能基线**（报告 2026-09-28 第二批："2k/20k/100k 文档的输入到下一帧 p50/p95、主线程长任务、
// 每次输入的扫描/装饰重建次数、最后一次输入到新鲜产物的时延"）。
//
// **它不是像素级性能承诺**：报告明确"暂不凭代码量推断已经存在卡顿"，所以这里只拦**数量级**问题
// （每次按键都全文重扫、装饰重建爆炸、掉进几百毫秒的长任务），并把每次跑到的数字写成基线
// （`.browser-check/perf-baseline.json`），供前后对比。门槛故意宽松。
//
// **两条边界（不许含糊）**：
//   ① 文档由**开发桩**编译（假切片、瞬时返回）⇒ "新鲜产物时延"只反映**前端**（150ms 去抖 +
//      调度 + 重排 + 装饰重建），**不含真实 typst 编译**；真机时延要在 Tauri 里量。
//   ② 输入用 CDP 的真实按键（`Input.dispatchKeyEvent`，每键一个 ASCII 字符），**不是中文 IME**。
//
// 运行（单跑，不进默认套件；它量的是基线不是功能回归）：
//   ONLY=writing-perf.mjs SKIP_FIXTURES=1 npm run verify:browser
import { writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";
import { BLOCKS_URL as URL_BLOCKS, boot, createChecker, finish, sleep } from "./harness.mjs";

const { check, state } = createChecker();

const c = await connect();
await boot(c, URL_BLOCKS, { settleMs: 800 });

/**
 * 页面内测量夹具：
 *  - `beforeinput` / `input` 事件 → 下一帧（rAF）的间隔（"输入到下一帧"，毫秒）；
 *  - Event Timing（`event` 条目）的 `duration` = 事件 → 下一次绘制（Chrome 会按 8ms 量化）；
 *  - `longtask` 条目（> 50ms 的主线程任务）。
 */
const HARNESS = `(() => {
  if (window.__perfHarness) return true;
  const view = window.__typstPadView;
  if (!view) return false;
  const samples = [];
  const events = [];
  const longTasks = [];
  let pending = null;
  const mark = () => { pending = performance.now(); };
  view.contentDOM.addEventListener("beforeinput", mark, true);
  view.contentDOM.addEventListener("input", mark, true);
  view.contentDOM.addEventListener("keydown", mark, true);
  const frame = () => {
    if (pending !== null) {
      samples.push(+(performance.now() - pending).toFixed(2));
      pending = null;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === "keydown" || e.name === "beforeinput" || e.name === "input") {
          events.push(+e.duration.toFixed(1));
        }
      }
    }).observe({ type: "event", durationThreshold: 0, buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(+e.duration.toFixed(1));
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  window.__perfHarness = {
    reset() { samples.length = 0; events.length = 0; longTasks.length = 0; pending = null; },
    snapshot() {
      return { samples: samples.slice(), events: events.slice(), longTasks: longTasks.slice() };
    },
  };
  return true;
})()`;

const pct = (arr, p) => {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return +sorted[idx].toFixed(1);
};

/** 造文档：每段约 50 个汉字、段间空行（每段一块，逼真于真实写作） */
const PARA =
  "排版是引擎算出来的：同一段文字在不同宽度下的断行位置、行末的伸缩、标点前后的留白，都由引擎的行断算法决定。";
const block = (chars) => `${PARA}\n\n`;
function makeDoc(chars) {
  let out = "";
  while (out.length < chars) out += block();
  return `${out}\n`;
}

const setDoc = (doc) =>
  c.evaluate(
    `(() => { const v = window.__typstPadView; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: ${JSON.stringify(doc)} } }); v.focus(); return v.state.doc.length; })()`,
  );
const setCaret = (pos) =>
  c.evaluate(
    `(() => { const v = window.__typstPadView; v.dispatch({ selection: { anchor: ${pos} } }); v.focus(); return v.state.selection.main.head; })()`,
  );

const KEYS = 30;
const BUDGET = {
  nextFrameP95: 220,
  scanPerKey: 1.6,
  decoPerKey: 5,
  longTaskMax: 800,
  freshMs: 1500,
};
const results = [];

for (const chars of [2000, 20000, 100000]) {
  const doc = makeDoc(chars);
  console.log(`\n=== ${chars} 字符（实际 ${doc.length}，${doc.split("\n\n").length - 1} 段）`);
  await c.click(400, 300);
  await c.selectAll();
  await setDoc(doc);
  await c.waitFor(`window.__typstPadBlocks?.exact === true`, { timeout: 30000 });
  await sleep(600);
  const docReady = await c.evaluate(
    `({ len: window.__typstPadView.state.doc.length, exact: window.__typstPadBlocks?.exact === true })`,
  );
  check(
    `[${chars}] 基线前提：文档打字进去并**已落过一轮产物**（长度 ${docReady.len}，exact ${docReady.exact}）`,
    docReady.len === doc.length && docReady.exact === true,
    JSON.stringify(docReady),
  );
  await c.evaluate(HARNESS);
  await setCaret(doc.length - 1);
  await sleep(300);
  await c.evaluate(`window.__perfHarness.reset(); window.__typstPadResetStats(); 1`);
  const compilesBefore = await c.evaluate(`window.__browserDevCallCounts?.compile_blocks ?? 0`);

  const t0 = Date.now();
  for (let i = 0; i < KEYS; i++) {
    // 用 `Input.insertText`（真实输入路径）：CDP 的 dispatchKeyEvent 不带 `text` 时只发 keydown、
    // **不插字**，整段基线会变成"零事务零重扫"的假绿（本轮实测踩过）。
    await c.type("a");
    await sleep(30); // 比 150ms 去抖快：模拟连续输入，多次输入合并成一次编译
  }
  const lastKeyAt = Date.now();
  const snap = await c.evaluate(`({
    perf: window.__perfHarness.snapshot(),
    scan: window.__typstPadScanStats(),
    deco: window.__typstPadDecoStats(),
    compiles: window.__browserDevCallCounts?.compile_blocks ?? 0,
    docLength: window.__typstPadView.state.doc.length,
  })`);
  // 最后一次输入 → 新鲜产物落地（**只含前端**：去抖 + 调度 + 重排）
  await c
    .waitFor(`window.__typstPadBlocks && window.__typstPadBlocks.exact === false`, {
      timeout: 1500,
    })
    .catch(() => {});
  const freshStart = Date.now();
  await c.waitFor(`window.__typstPadBlocks?.exact === true`, { timeout: 15000 });
  const freshMs = Date.now() - freshStart;

  const nextFrame = snap.perf.samples;
  const timingEvents = snap.perf.events;
  const longTasks = snap.perf.longTasks;
  const scanPerKey = snap.scan.misses / KEYS;
  const decoPerKey = snap.deco.rebuilds / KEYS;
  const row = {
    chars: doc.length,
    keys: KEYS,
    inserted: snap.docLength - doc.length,
    typedMs: lastKeyAt - t0,
    nextFrameP50: pct(nextFrame, 50),
    nextFrameP95: pct(nextFrame, 95),
    nextFrameMax: nextFrame.length ? Math.max(...nextFrame) : null,
    eventP95: pct(timingEvents, 95),
    longTaskCount: longTasks.length,
    longTaskMax: longTasks.length ? Math.max(...longTasks) : 0,
    scanMisses: snap.scan.misses,
    scanHits: snap.scan.hits,
    scanPerKey: +scanPerKey.toFixed(2),
    decoRebuilds: snap.deco.rebuilds,
    decoErrors: snap.deco.errors,
    decoPerKey: +decoPerKey.toFixed(2),
    compiles: snap.compiles - compilesBefore,
    freshMs,
  };
  results.push(row);
  console.log("  " + JSON.stringify(row));

  check(
    `[${doc.length}] 基线的前提：${KEYS} 次输入真的插进去了 ${row.inserted} 个字符（否则整段基线是假绿）`,
    row.inserted === KEYS,
    JSON.stringify({ before: doc.length, after: snap.docLength }),
  );
  check(
    `[${doc.length}] 每次输入最多全文重扫一次（misses/键 ${row.scanPerKey} ≤ ${BUDGET.scanPerKey}）`,
    row.scanPerKey <= BUDGET.scanPerKey,
    JSON.stringify({ misses: row.scanMisses, keys: KEYS, hits: row.scanHits }),
  );
  check(
    `[${doc.length}] 装饰重建次数是常数级（rebuilds/键 ${row.decoPerKey} ≤ ${BUDGET.decoPerKey}，错误 ${row.decoErrors}）`,
    row.decoPerKey <= BUDGET.decoPerKey && row.decoErrors === 0,
    JSON.stringify({ rebuilds: row.decoRebuilds, errors: row.decoErrors }),
  );
  check(
    `[${doc.length}] 没有掉进长任务（最长 ${row.longTaskMax}ms < ${BUDGET.longTaskMax}ms，共 ${row.longTaskCount} 个）`,
    row.longTaskMax < BUDGET.longTaskMax,
    JSON.stringify(longTasks.slice(0, 6)),
  );
  check(
    `[${doc.length}] 输入到下一帧 p95 在一档宽松上限内（${row.nextFrameP95}ms ≤ ${BUDGET.nextFrameP95}ms；p50 ${row.nextFrameP50}ms）`,
    row.nextFrameP95 !== null && row.nextFrameP95 <= BUDGET.nextFrameP95,
    JSON.stringify(nextFrame.slice(0, 12)),
  );
  check(
    `[${doc.length}] 最后一次输入到新鲜产物（**前端**：去抖+调度+重排）≤ ${BUDGET.freshMs}ms（实测 ${row.freshMs}ms）`,
    row.freshMs <= BUDGET.freshMs,
    JSON.stringify(row),
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  note: "开发桩（假切片）下的**前端**基线：新鲜产物时延不含真实 typst 编译；输入为 CDP 按键，不是中文 IME",
  budget: BUDGET,
  rows: results,
};
writeFileSync(
  new URL("../../.browser-check/perf-baseline.json", import.meta.url).pathname,
  JSON.stringify(out, null, 1),
);
console.log("\n基线写入 .browser-check/perf-baseline.json");
finish(`通过 ${state.passed} 项检查；基线：.browser-check/perf-baseline.json`);
