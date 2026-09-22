// 写作模式的**动态稳定性**验收（报告 T0）：把「光标进出公式 / 复杂块时少跳动」变成可测量的目标。
//
// 为什么单独一套：既有七套验收里唯一相关的 `writing-mode-scenes.mjs` 只测「中文长段落」与
// 「标题层级」两篇——那两篇现在都是持续真实文本，**代表不了代码、表格、公式的切换**（报告 §2.3）。
// 本套件按报告 §8 的验收矩阵，逐帧量几何：
//   * 收起态 / 编辑态的行对齐（V1：单行行间公式编辑后丢失居中）；
//   * 真实鼠标**点击**公式 widget 与复杂块切片后的光标锚点漂移（V2 / V4）；
//   * `Ctrl+E` 模式切换往返后光标的位置与屏幕高度（V3），并在 100/150/200% 三档几何下各测一次。
//
// 三条纪律（报告 §7 T0）：
//   1. **逐帧采样**（`requestAnimationFrame`）而不是只比 500ms 后的终态：要抓"先缩后涨"这类轨迹；
//   2. 每条测量都标清产物来源：`real-static`（命中注入夹具）／`fake`（桩的假产物）／
//      `real-dynamic`（编辑后重编译，本套件暂时只记录）——**不许把桩的假几何当引擎结论**；
//   3. 夹具缺失 / 量不到目标节点 = **硬失败**，不静默跳过（否则整套可以空转全绿）。
//
// 取视图走 `window.__typstPadView`（`src/lib/dev/editor-test-hook.ts`，只在 `?browserdev=1` 挂上），
// 不再依赖 `cmTile.root.view` 这种 CodeMirror 内部结构。
//
// 前置：dev server + headless Chromium（见 scripts/browser-check/run-all.mjs）。
// 运行：`CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-stability.mjs`
import { writeFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";
import {
  BLOCKS_URL,
  boot,
  byteToPos,
  createChecker,
  finish,
  loadFixtures,
  replaceDocument,
  shotPath as SHOT,
  sleep,
} from "./harness.mjs";

const { check, state } = createChecker();

const mathFixtures = loadFixtures("math-fixtures.json", {
  hint: "先跑 npm run fixtures:math（没有真公式产物就只能量到假 SVG）",
});
const blockFixtures = loadFixtures("block-fixtures.json", {
  hint: "先跑 npm run fixtures:blocks",
  predicate: (list) =>
    list.some((f) => f.name === "公式形态") && list.some((f) => f.name === "代码与表格"),
  what: "块级夹具里缺少本套件要用的场景（公式形态 / 代码与表格）",
});
const sceneFormula = blockFixtures.find((f) => f.name === "公式形态");
const sceneCode = blockFixtures.find((f) => f.name === "代码与表格");

/** 需要现成真产物的公式：body / display 必须与 Rust `dump_math_fixtures` 的用例逐字相同 */
const REAL_MATH = [
  ["sum_(i=1)^n i", true],
  ["frac(a,b)", true],
  ["mat(1, 2; 3, 4)", true],
  ["x^2 + y^2 = z^2", false],
];
const missingMath = REAL_MATH.filter(
  ([body, display]) => !mathFixtures.some((f) => f.body === body && f.display === display),
);

// ---------------------------------------------------------------------------
// 页面侧探针（都用 `window.__typstPadView`，不碰 CodeMirror 内部结构）
// ---------------------------------------------------------------------------

/**
 * 一次完整快照。光标纵坐标给**两个口径**：
 *  - `caretY`：相对滚动容器顶（模式切换的"屏幕高度"用这个）；
 *  - `caretCenterClientY`：视口绝对坐标下的行盒中心（点击锚定要和鼠标点的 `clientY` 比）。
 */
const SNAPSHOT = `(() => {
  const v = window.__typstPadView;
  if (!v) return null;
  const scroller = v.scrollDOM;
  const box = scroller.getBoundingClientRect();
  const head = v.state.selection.main.head;
  let caret = null;
  try { caret = v.coordsAtPos(head); } catch {}
  const lineEl = document.querySelector(".cm-math-line");
  return {
    contentHeight: +v.contentHeight.toFixed(2),
    scrollerHeight: +box.height.toFixed(2),
    scrollTop: +scroller.scrollTop.toFixed(2),
    head,
    caretY: caret ? +(caret.top - box.top).toFixed(2) : null,
    caretCenterClientY: caret ? +((caret.top + caret.bottom) / 2).toFixed(2) : null,
    line: lineEl
      ? {
          textAlign: getComputedStyle(lineEl).textAlign,
          text: lineEl.innerText.slice(0, 40),
          height: +lineEl.getBoundingClientRect().height.toFixed(2),
        }
      : null,
    inlineDisplay: document.querySelectorAll(".cm-math-block-inline").length,
    blockMath: document.querySelectorAll(".cm-math-block").length,
    inlineMath: document.querySelectorAll(".cm-math-widget").length,
    crops: document.querySelectorAll(".cm-block-crop").length,
    focused: document.activeElement === document.querySelector(".cm-content"),
    text: document.querySelector(".cm-content").innerText,
  };
})()`;

const snapshot = () => c.evaluate(SNAPSHOT);

const setCaret = (pos) =>
  c.evaluate(`(() => {
    const v = window.__typstPadView;
    v.dispatch({ selection: { anchor: ${pos} }, scrollIntoView: true });
    v.focus();
    return true;
  })()`);

/**
 * 把文档滚到"上下余量各一半"。
 *
 * 为什么必须做：报告 §8 的锚点判据只对**有滚动余量**的情形成立（"有滚动余量时…；首尾夹紧单列"）。
 * 文档比视口矮时 `scrollIntoView` 根本滚不动，光标只能跟着布局漂 —— 那时量到的"漂移"是夹紧
 * 的结果，不是锚定失效。先把文档居中，再去点，这样点击的锚点目标一定可达。
 */
async function centerDocument() {
  for (let i = 0; i < 10; i++) {
    const s = await c.evaluate(`(() => {
      const sc = window.__typstPadView.scrollDOM;
      return { top: sc.scrollTop, max: Math.max(0, sc.scrollHeight - sc.clientHeight) };
    })()`);
    const want = Math.round(s.max / 2);
    if (Math.abs(want - s.top) <= 4) return s;
    await c.wheel(300, 200, want - s.top);
    await sleep(180);
  }
  return c.evaluate(`(() => {
    const sc = window.__typstPadView.scrollDOM;
    return { top: sc.scrollTop, max: Math.max(0, sc.scrollHeight - sc.clientHeight) };
  })()`);
}

/**
 * 点击锚点的断言：报告 §8 的判据分两种情形。
 *  - 有滚动余量（内容比视口高出 40px 以上）→ 光标行盒中心偏移 ≤8px；
 *  - 没有余量（首尾夹紧）→ 只要求光标没被弹出视口。
 *
 * `samples` 是**过滤后**的有效帧数（只统计"光标已经落到目标上"的那些帧）。它太少说明这次
 * 点击压根没落到目标上（或者过滤器写错），那时的漂移指标是空的 —— 必须判失败，不能让
 * "一个空指标"冒充"锚点很稳"（实测踩过：动作前光标还在文档另一头，首帧把漂移拉到 1000px）。
 */
function assertAnchor(label, drift, snap, samples) {
  if (samples < 5) {
    check(
      `${label}：锚点指标有 ≥5 个有效帧（实测 ${samples} 帧，指标不可信）`,
      false,
      JSON.stringify({ samples, drift }),
    );
    return;
  }
  const room = (snap?.contentHeight ?? 0) - (snap?.scrollerHeight ?? 0);
  if (room >= 40) {
    check(
      `${label}：点击引起的光标锚点漂移 ≤8px（实测 ${drift}px，${samples} 帧）`,
      drift <= 8,
      JSON.stringify({ drift, room, scrollerHeight: snap?.scrollerHeight, samples }),
    );
    return;
  }
  check(
    `${label}：无滚动余量（首尾夹紧）时光标仍在视口内（内容 ${snap?.contentHeight} / 视口 ${snap?.scrollerHeight}）`,
    typeof snap?.caretY === "number" &&
      snap.caretY >= -1 &&
      snap.caretY <= (snap?.scrollerHeight ?? 0),
    JSON.stringify({ caretY: snap?.caretY, room, scrollerHeight: snap?.scrollerHeight }),
  );
}

/**
 * 逐帧记录器：动作之后最多 60 帧（≈1s @60fps），用来抓轨迹而不只是终态。
 * 记录**视口绝对**的行盒中心，方便和鼠标点的 `clientY` 直接比。
 */
const TRACE_START = `(() => {
  const rec = { frames: [] };
  window.__stabilityTrace = rec;
  window.__stabilityDone = false;
  let n = 0;
  const tick = () => {
    const v = window.__typstPadView;
    if (!v) { window.__stabilityDone = true; return; }
    const scroller = v.scrollDOM;
    let caretY = null;
    let caretCenterClientY = null;
    try {
      const c = v.coordsAtPos(v.state.selection.main.head);
      if (c) {
        caretY = +(c.top - scroller.getBoundingClientRect().top).toFixed(2);
        caretCenterClientY = +((c.top + c.bottom) / 2).toFixed(2);
      }
    } catch {}
    rec.frames.push({
      t: Math.round(performance.now()),
      contentHeight: +v.contentHeight.toFixed(2),
      scrollTop: +scroller.scrollTop.toFixed(2),
      caretY,
      caretCenterClientY,
      head: v.state.selection.main.head,
    });
    if (++n < 60) requestAnimationFrame(tick);
    else window.__stabilityDone = true;
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/**
 * 采一段轨迹：`action` 只做动作（不 sleep，帧由记录器采）。
 *
 * `targetClientY` 给了就按"行盒中心应落在该视口高度"算漂移（点击锚定用），
 * 否则按相对第一帧的漂移算（只记录、不断言）。
 *
 * `skipHead` 是**动作之前**的光标位置：那些帧一定要丢掉。记录器的第一帧和这次点击谁先到
 * 是竞态的（CDP 两个来回 vs 一个 rAF），而动作前光标往往停在文档另一头、`coordsAtPos`
 * 给出一个老远的坐标 —— 留着它就会把"漂移"算成 1000px 上下（实测：全套一起跑时
 * 这一条随机红两次，单独跑却全绿）。
 */
async function trace(action, { targetClientY = null, skipHead = null } = {}) {
  await c.evaluate(TRACE_START);
  await action();
  try {
    await c.waitFor(`window.__stabilityDone === true`, { timeout: 10000 });
  } catch {
    /* 采满就结束；轨迹照样分析，帧数会体现在报告里 */
  }
  const all = (await c.evaluate(`window.__stabilityTrace.frames`)) ?? [];
  const frames = skipHead === null ? all : all.filter((f) => f.head !== skipHead);
  const centers = frames
    .map((f) => f.caretCenterClientY)
    .filter((y) => typeof y === "number" && Number.isFinite(y));
  const base = targetClientY ?? (centers.length ? centers[0] : null);
  const drifts = base === null ? [] : centers.map((y) => Math.abs(y - base));
  // 方向反转：只看相邻差分里 >1px 的那些（忽略亚像素抖动）
  let reversals = 0;
  let lastSign = 0;
  for (let i = 1; i < centers.length; i++) {
    const d = centers[i] - centers[i - 1];
    if (Math.abs(d) <= 1) continue;
    const s = Math.sign(d);
    if (lastSign !== 0 && s !== lastSign) reversals++;
    lastSign = s;
  }
  return {
    /** 有效帧数（已丢掉动作前那些） */
    frames: frames.length,
    /** 采到的总帧数 */
    totalFrames: all.length,
    maxDrift: drifts.length ? +Math.max(...drifts).toFixed(2) : 0,
    reversals,
    heights: frames.map((f) => f.contentHeight),
  };
}

/** 收集进 JSON 诊断（不是断言）：报告 §7 T0 要求留下高度与漂移的原始指标 */
const report = { generatedAt: new Date().toISOString(), entries: [] };
const record = (entry) => {
  report.entries.push(entry);
  console.log(`  · ${JSON.stringify(entry)}`);
};

const c = await connect();

check(
  "注入的公式夹具覆盖本套件要用的真产物（缺一个就只能量假 SVG）",
  missingMath.length === 0,
  JSON.stringify({ missingMath, got: mathFixtures.length }),
);

// ===========================================================================
// A. 公式装饰路径（不开块切片）：报告里 V1 的原始复现场景
// ===========================================================================
console.log("\n=== A. 公式装饰路径：编辑前后行对齐 + 点击锚定（V1 / V2）");
await boot(c, DEV_URL, { mathFixtures, settleMs: 700 });
// 固定视口：`Emulation.setDeviceMetricsOverride` 是**跨导航留在 target 上**的，
// 上一套件（或本套件上一段）留下的尺寸会改变 `scrollerHeight`，进而改变
// "有没有滚动余量"这条判据。这里显式钉死，跑起来才可复现。
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1400,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const hooked = await c.evaluate(`!!window.__typstPadView`);
check("测试钩子可用（window.__typstPadView）", hooked === true, JSON.stringify({ hooked }));

/**
 * 把公式夹在一堆真实正文段落中间。
 *
 * 为什么：报告 §8 的锚点判据只对**有滚动余量**的情形成立。三五行的短文档比视口还矮，
 * `scrollIntoView` 一点都滚不动，光标只能跟着布局漂——那时量到的是"首尾夹紧"而不是锚定失效。
 * 垫高之后文档能居中，公式落在视口中段、上下都有余量，锚点目标才真的可达。
 * 垫的是纯正文段落（写作模式里是真实文本），**公式本身一个字都不改**，所以夹具命中不变。
 */
const filler = (n) =>
  Array.from(
    { length: n },
    (_, i) => `铺垫段落 ${i + 1}：把文档垫高，好让公式落在视口中段、上下都有滚动余量。`,
  ).join("\n\n");
const padded = (core) => `开头。\n\n${filler(20)}\n\n${core}\n\n${filler(20)}\n`;

/** 每篇文档：doc 原文、渲染态应当存在的节点、行对齐期望 */
const MATH_DOCS = [
  {
    name: "单行行间公式（真产物 sum）",
    doc: padded("前文\n\n$ sum_(i=1)^n i $\n\n后文\n"),
    body: "sum_(i=1)^n i",
    renderedSelector: ".cm-math-block-inline",
    /** 独占单行的行间公式：渲染态与编辑态都该居中（编辑态居中就是 V1 修的那条） */
    centerAt: "both",
    /** 能真实点击（点击用的是 widget 的屏幕位置） */
    clickable: true,
    real: true,
  },
  {
    name: "单行高公式（真产物 frac）",
    doc: padded("前文\n\n$ frac(a,b) $\n\n后文\n"),
    body: "frac(a,b)",
    renderedSelector: ".cm-math-block-inline",
    centerAt: "both",
    clickable: true,
    real: true,
  },
  {
    name: "行首行尾带空白的行间公式（真产物 mat）",
    doc: padded("前文\n\n  $ mat(1, 2; 3, 4) $  \n\n后文\n"),
    body: "mat(1, 2; 3, 4)",
    renderedSelector: ".cm-math-block-inline",
    centerAt: "both",
    clickable: true,
    real: true,
  },
  {
    name: "行内公式（真产物）",
    // 定界符内侧**不能有空格**：`$ x $` 是行间公式（display），`$x$` 才是行内公式。
    // 写成带空格的版本会变成"独占其行"的 display 公式，落到 MathWidget 之外的路径上。
    doc: padded("前文 $x^2 + y^2 = z^2$ 后文\n"),
    body: "x^2 + y^2 = z^2",
    renderedSelector: ".cm-math-widget",
    /** 行内公式**不许**套行级居中（那会把整行正文也居中） */
    centerAt: "never",
    clickable: true,
    real: true,
  },
  {
    name: "跨行书写的行间公式（无夹具 → 假产物）",
    doc: padded("前文\n\n$ a +\nb = c $\n\n后文\n"),
    body: "a +\nb = c",
    renderedSelector: ".cm-math-block",
    /** 多行行间公式是整行 block widget，不套单行行装饰（T1 的明确例外） */
    centerAt: "never",
    clickable: false,
    real: false,
  },
];

/** 行对齐断言：centerAt = "both" 要求渲染态与编辑态都居中；"never" 要求始终没有行装饰 */
function assertLine(name, phase, snap, centerAt) {
  if (centerAt === "never") {
    check(`${name}：${phase}不套行级居中`, snap.line === null, JSON.stringify({ line: snap.line }));
    return;
  }
  check(
    `${name}：${phase}独占单行的行间公式居中`,
    snap.line !== null && snap.line.textAlign === "center",
    JSON.stringify({ line: snap.line, text: snap.text.slice(0, 40) }),
  );
}

for (const spec of MATH_DOCS) {
  console.log(`\n--- ${spec.name}`);
  await replaceDocument(c, spec.doc, 900);
  const from = spec.doc.indexOf("$");

  // ① 渲染态：光标挪到文档开头，再把文档滚到中间 —— 公式落在视口里但不含光标，因此是渲染态
  await setCaret(0);
  await centerDocument();
  let found = true;
  try {
    await c.waitFor(`!!document.querySelector(${JSON.stringify(spec.renderedSelector)})`, {
      timeout: 8000,
    });
  } catch {
    found = false;
  }
  await sleep(200);
  const rendered = await snapshot();
  check(
    `${spec.name}：渲染态真的量到了公式节点（${spec.renderedSelector}）`,
    found && rendered !== null,
    JSON.stringify({ found, rendered: rendered && rendered.text.slice(0, 40) }),
  );
  if (rendered) assertLine(spec.name, "渲染态", rendered, spec.centerAt);

  // ② 进编辑态：能点的走**真实鼠标点击**（V2 要量的就是这条），不能点的走程序化选区
  let enter = null;
  let editing = rendered;
  if (spec.clickable) {
    const target = await c.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(spec.renderedSelector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +(r.left + r.width / 2).toFixed(1), y: +((r.top + r.bottom) / 2).toFixed(1) };
    })()`);
    const inView = target !== null && target.y > 0 && target.y < (rendered?.scrollerHeight ?? 0);
    check(
      `${spec.name}：点击前量到了公式 widget 的屏幕位置且在视口内`,
      inView,
      JSON.stringify({
        target,
        selector: spec.renderedSelector,
        scroller: rendered?.scrollerHeight,
      }),
    );
    if (target && inView) {
      enter = await trace(() => c.click(target.x, target.y), {
        targetClientY: target.y,
        skipHead: rendered?.head,
      });
      await sleep(400);
      editing = await snapshot();
      check(
        `${spec.name}：点击后光标落在公式源码起点（pos ${from}）`,
        editing?.head === from,
        JSON.stringify({ head: editing?.head, from }),
      );
      check(
        `${spec.name}：点击后焦点仍在编辑区（点完还能继续打字）`,
        editing?.focused === true,
        JSON.stringify({ focused: editing?.focused, head: editing?.head }),
      );
      assertAnchor(spec.name, enter.maxDrift, editing, enter.frames);
    }
  } else {
    enter = await trace(() => setCaret(from), { skipHead: rendered?.head });
    await sleep(400);
    editing = await snapshot();
  }

  if (editing) assertLine(spec.name, "编辑态", editing, spec.centerAt);
  check(
    `${spec.name}：编辑态展开成源码（公式 widget 已撤、能看到 $ 定界符）`,
    !!editing &&
      editing.inlineDisplay === 0 &&
      editing.inlineMath === 0 &&
      editing.blockMath === 0 &&
      editing.text.includes("$"),
    JSON.stringify({
      inlineDisplay: editing?.inlineDisplay,
      inlineMath: editing?.inlineMath,
      blockMath: editing?.blockMath,
      text: editing?.text.slice(0, 40),
    }),
  );
  record({
    scene: spec.name,
    source: spec.real ? "real-static" : "fake",
    phase: spec.clickable ? "真实点击公式 widget" : "进入公式（程序化选区）",
    contentHeightBefore: rendered?.contentHeight ?? null,
    contentHeightAfter: editing?.contentHeight ?? null,
    scrollerHeight: rendered?.scrollerHeight ?? null,
    delta:
      rendered && editing ? +(editing.contentHeight - rendered.contentHeight).toFixed(2) : null,
    maxAnchorDriftPx: enter?.maxDrift ?? null,
    directionReversals: enter?.reversals ?? null,
    frames: enter?.frames ?? null,
    lineBoxBefore: rendered?.line?.height ?? null,
    lineBoxAfter: editing?.line?.height ?? null,
  });
  await c.screenshot(SHOT(`stability-math-${spec.body.replace(/[^a-zA-Z0-9]+/g, "-")}`));
}

// --- V3：Ctrl+E 模式切换往返（光标位置与屏幕高度），100/150/200% 三档几何 ---------------------
console.log("\n=== V3. Ctrl+E 往返：光标位置与屏幕高度（100/150/200%）");
{
  const longDoc = Array.from(
    { length: 60 },
    (_, i) =>
      `第 ${i + 1} 段：模式切换时这段文字用来把文档撑到足够长，好让光标停在中段、上下都有滚动余量。`,
  ).join("\n\n");
  // 桩的 `setZoom` 是假的（不改 CSS 视口），所以缩放用"压视口宽度"复现真机几何：
  // 1400 / 933 / 700 CSS px ≈ 100% / 150% / 200%（与 wysiwyg.mjs 第 41 组的做法同源）。
  for (const [label, width] of [
    ["100%", 1400],
    ["150%", 933],
    ["200%", 700],
  ]) {
    await c.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await replaceDocument(c, longDoc, 900);
    const pos = Math.floor(longDoc.length * 0.6);
    await setCaret(pos);
    // 往上滚一点：`scrollIntoView` 只保证"刚好可见"，光标会贴在视口下沿；而
    // `captureCaretAnchor` 对视口外（含贴边越界）的光标**故意不接管**，贴在边界上会
    // 让这条用例静默失效。往上滚 200px 让它落在视口中段。
    await c.wheel(Math.round(width / 2), 400, -200);
    await sleep(400);
    const before = await snapshot();
    await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
    await sleep(700);
    await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
    await sleep(900);
    const after = await snapshot();
    check(
      `${label}：Ctrl+E 往返后光标位置不变（${before?.head} → ${after?.head}）`,
      before?.head === after?.head && before?.head === pos,
      JSON.stringify({ before: before?.head, after: after?.head, pos }),
    );
    check(
      `${label}：往返后光标仍在原屏幕高度（±8px）且焦点还在编辑区`,
      !!before &&
        !!after &&
        before.caretY !== null &&
        after.caretY !== null &&
        Math.abs(after.caretY - before.caretY) <= 8 &&
        after.focused === true,
      JSON.stringify({ before: before?.caretY, after: after?.caretY, focused: after?.focused }),
    );
    record({
      scene: `模式切换 ${label}`,
      source: "fake",
      phase: "Ctrl+E 往返",
      caretYBefore: before?.caretY ?? null,
      caretYAfter: after?.caretY ?? null,
      scrollTopBefore: before?.scrollTop ?? null,
      scrollTopAfter: after?.scrollTop ?? null,
    });
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
}

// ===========================================================================
// B. 块切片路径：公式形态与代码/表格的进出（V1 经切片路径 / V4）
// ===========================================================================
console.log("\n=== B. 块切片路径：公式与复杂块进出");
await boot(c, BLOCKS_URL, { blockFixtures, mathFixtures, settleMs: 800 });
// 视口压到 600×400：600px 下列宽 ≈489px，与夹具的 contentWidthPt=371.25 之比 1.317 ≈ 真应用的
// 4/3（1400px 视口下切片被放大 2.1 倍，量高度全是缩放假象）；400px 高则保证短场景也**有滚动余量**，
// 报告 §8 的锚点判据（"有滚动余量时"）才适用。
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 600,
  height: 400,
  deviceScaleFactor: 1,
  mobile: false,
});

// B1. 光标进独占单行的行间公式 → 该行仍居中（V1 在切片路径下的形态）
{
  await replaceDocument(c, sceneFormula.doc, 1200);
  await setCaret(sceneFormula.doc.length);
  await centerDocument();
  await sleep(500);
  const collapsed = await snapshot();
  check(
    "公式形态场景：收起态确实有块切片（证明确实走的是切片路径）",
    (collapsed?.crops ?? 0) >= 1,
    JSON.stringify({ crops: collapsed?.crops, text: collapsed?.text.slice(0, 40) }),
  );
  // 诊断（不断言）：相邻切片之间的**纵向间距**与真实排版的差。切片之间应该严丝合缝；
  // 一旦中间夹了"可编辑正文"，浏览器行高（≈1.65）与 typst 的 leading/段距就不是一回事了
  //（报告 W2）。这里出数据，留给 T4 决定要不要做每块样式度量。
  {
    const geo = await c.evaluate(`(() => {
      const cr = document.querySelector(".cm-content").getBoundingClientRect();
      return Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
        const r = el.getBoundingClientRect();
        return { from: Number(el.dataset.blockFrom), y: +(r.top - cr.top).toFixed(2), w: +r.width.toFixed(2) };
      });
    })()`);
    let worst = 0;
    let worstPair = null;
    for (let i = 1; i < geo.length; i++) {
      const a = sceneFormula.blocks.find(
        (b) => byteToPos(sceneFormula.doc, b.start) === geo[i - 1].from,
      );
      const b = sceneFormula.blocks.find(
        (b) => byteToPos(sceneFormula.doc, b.start) === geo[i].from,
      );
      if (!a || !b) continue;
      const factor = geo[i].w / sceneFormula.contentWidthPt;
      const dev = Math.abs(geo[i].y - geo[i - 1].y - (b.yPt - a.yPt) * factor);
      if (dev > worst) {
        worst = dev;
        worstPair = [geo[i - 1].from, geo[i].from];
      }
    }
    record({
      scene: "公式形态：相邻切片纵向间距 vs 真实排版",
      source: "real-static",
      phase: "收起态几何",
      worstDeltaPx: +worst.toFixed(2),
      worstPair,
      crops: geo.length,
    });
  }
  const formulaPos = sceneFormula.doc.indexOf("$ sum_(i=1)^n i $") + 2; // 落进 `$ ... $` 内部
  const t = await trace(() => setCaret(formulaPos), { skipHead: collapsed?.head });
  await sleep(500);
  const editing = await snapshot();
  check(
    "公式形态场景：光标进入独占单行的行间公式后该行仍居中（V1）",
    editing?.line !== null && editing?.line?.textAlign === "center",
    JSON.stringify({ line: editing?.line, text: editing?.text.slice(0, 60) }),
  );
  record({
    scene: "公式形态（块切片路径）",
    source: "real-static",
    phase: "进入行间公式",
    contentHeightBefore: collapsed?.contentHeight ?? null,
    contentHeightAfter: editing?.contentHeight ?? null,
    scrollerHeight: collapsed?.scrollerHeight ?? null,
    delta:
      collapsed && editing ? +(editing.contentHeight - collapsed.contentHeight).toFixed(2) : null,
    maxAnchorDriftPx: t.maxDrift,
    directionReversals: t.reversals,
    frames: t.frames,
  });
  await c.screenshot(SHOT("stability-formula-blocks"));
}

// B2. 真实点击代码块 / 表格切片 → 展开、锚点、轨迹
{
  await replaceDocument(c, sceneCode.doc, 1200);
  await setCaret(sceneCode.doc.length);
  await centerDocument();
  await sleep(500);
  const collapsed = await snapshot();
  /** 夹具里"该出切片"的复杂块：围栏代码（Raw）与含 #table 的 Paragraph */
  const targets = [
    { name: "围栏代码块", block: sceneCode.blocks.find((b) => b.kind === "Raw") },
    {
      name: "表格块（#table）",
      block: sceneCode.blocks.find((b) =>
        sceneCode.doc
          .slice(byteToPos(sceneCode.doc, b.start), byteToPos(sceneCode.doc, b.end))
          .startsWith("#table"),
      ),
    },
  ];
  check(
    "代码与表格场景：夹具里找到围栏代码块与 #table 块",
    targets.every((t) => t.block && t.block.svg),
    JSON.stringify({ found: targets.map((t) => !!t.block?.svg) }),
  );
  check(
    "代码与表格场景：收起态量到块切片",
    (collapsed?.crops ?? 0) >= 2,
    JSON.stringify({ crops: collapsed?.crops }),
  );
  for (const target of targets) {
    if (!target.block?.svg) continue;
    // 每轮开始时重新居中：上一轮展开/收起会改变内容高度，滚动位置会跟着变，
    // 而点击坐标是**当场**从 DOM 量的（不能沿用上一轮的 rect）
    await centerDocument();
    const from = byteToPos(sceneCode.doc, target.block.start);
    const to = byteToPos(sceneCode.doc, target.block.end);
    const source = sceneCode.doc.slice(from, to);
    const point = await c.evaluate(`(() => {
      const el = Array.from(document.querySelectorAll(".cm-block-crop"))
        .find((e) => Number(e.dataset.blockFrom) === ${from});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 40)) };
    })()`);
    check(
      `${target.name}：量到了对应的切片元素且在视口内（pos ${from}）`,
      point !== null,
      JSON.stringify({ point, from, scroller: collapsed?.scrollerHeight }),
    );
    if (!point) continue;
    const t = await trace(() => c.click(point.x, point.y), {
      targetClientY: point.y,
      skipHead: collapsed?.head,
    });
    await sleep(500);
    const after = await snapshot();
    const needle = source.split("\n")[0].slice(0, 10);
    check(
      `点击${target.name}切片 → 展开成该块的真实源码（crops ${collapsed?.crops} → ${after?.crops}）`,
      !!after && after.text.includes(needle) && after.crops === (collapsed?.crops ?? 0) - 1,
      JSON.stringify({ needle, crops: after?.crops, text: after?.text.slice(0, 80) }),
    );
    assertAnchor(`点击${target.name}切片`, t.maxDrift, after, t.frames);
    check(
      `点击${target.name}切片 → 轨迹没有"先缩后涨"的反向位移（反转 ${t.reversals} 次）`,
      t.reversals <= 1,
      JSON.stringify({ reversals: t.reversals, heights: t.heights.slice(0, 20) }),
    );
    record({
      scene: `代码与表格 / ${target.name}`,
      source: "real-static",
      phase: "真实点击切片",
      contentHeightBefore: collapsed?.contentHeight ?? null,
      contentHeightAfter: after?.contentHeight ?? null,
      scrollerHeight: collapsed?.scrollerHeight ?? null,
      clickY: point.y,
      maxAnchorDriftPx: t.maxDrift,
      directionReversals: t.reversals,
      frames: t.frames,
    });
    // 回到"全部收起"再点下一个，避免上一次展开影响下一次测量
    await setCaret(sceneCode.doc.length);
    await sleep(700);
  }
  await c.screenshot(SHOT("stability-code-blocks"));
}
// 收尾把设备覆盖清掉：它是留在 CDP target 上的，不还原会污染后续套件的视口
await c.send("Emulation.clearDeviceMetricsOverride");

// --- 反空转守卫：本套件没覆盖的矩阵维度必须显式列出来，不能算作"通过" ----------------------
const UNCOVERED = [
  "输入法合成（报告 T3）",
  "异步乱序响应 / 延迟到达（报告 T2）",
  "长文 2k/20k/100k 的性能分布（报告 T4 之后）",
  "多窗口 A/B 交替（报告 T2）",
  "输入到下一帧的输入延迟（需要 release 桌面）",
  "文档 >1 页的裁剪带与脚注（报告 T6）",
];

report.matrix = {
  covered: [
    "几何稳定（光标进出公式 / 复杂块）",
    "动态轨迹（逐帧采样，60 帧窗口）",
    "窄窗 / 缩放（100/150/200% 等效几何）",
    "点击锚定（公式 widget、块切片）",
    "模式切换锚点（Ctrl+E 往返）",
  ],
  uncovered: UNCOVERED,
  invariants: { maxAnchorDriftPx: 8, directionReversals: 1 },
};
writeFileSync(
  new URL("../../.browser-check/writing-stability.json", import.meta.url).pathname,
  JSON.stringify(report, null, 1),
);
console.log("\n未覆盖的矩阵维度（留给后续任务包，不计入通过项）：");
for (const item of UNCOVERED) console.log(`  - ${item}`);
console.log("\n指标明细：.browser-check/writing-stability.json");

await c.close();
finish(`通过 ${state.passed} 项检查；截图：.browser-check/stability-*.png`);
