// 写作模式的**动态稳定性**验收（报告 T0）：把「光标进出公式 / 复杂块时少跳动」变成可测量的目标。
//
// 为什么单独一套：既有七套验收里唯一相关的 `writing-mode-scenes.mjs` 只测「中文长段落」与
// 「标题层级」两篇——那两篇现在都是持续真实文本，**代表不了代码、表格、公式的切换**（报告 §2.3）。
// 本套件按报告 §8 的验收矩阵，逐帧量几何：
//   * 收起态 / 编辑态的行对齐（V1：单行行间公式编辑后丢失居中）；
//   * 真实鼠标**点击**公式 widget 与复杂块切片后的光标锚点漂移（V2 / V4），点击另在
//     100/150/200% 三档等效几何下各测一次；
//   * **左右键**逐格进出公式后的源码位置、行对齐与焦点（同三档）；
//   * `Ctrl+E` 模式切换往返后光标的位置与屏幕高度（V3），同三档。
//
// 三条纪律（报告 §7 T0）：
//   1. **逐帧采样**（`requestAnimationFrame`）而不是只比 500ms 后的终态：要抓"先缩后涨"这类轨迹。
//      每帧记录：光标行盒中心（视口绝对 + 相对滚动容器）、**活动行盒高度**、**上下相邻行盒 y**、
//      `contentHeight`、滚动量、**正文列宽**、光标位置；
//   2. 每条测量都标清产物来源：`real-static`（命中注入夹具）／`fake`（桩的假产物）／
//      `real-dynamic`（编辑后重编译）。**`real-dynamic` 在浏览器桩里做不到** —— 桩没有引擎，
//      文档一改就退回假切片，所以它被显式列进"未覆盖"（只有桌面版能验），不是忘了标；
//   3. 夹具缺失 / 量不到目标节点 = **硬失败**，不静默跳过（否则整套可以空转全绿）。
//
// 取视图走 `window.__typstPadView`（`src/lib/dev/editor-test-hook.ts`，只在 `?browserdev=1` 挂上），
// 不再依赖 `cmTile.root.view` 这种 CodeMirror 内部结构。
//
// **红基线**（报告 §7 T0 的纪律：先让验收红，再改产品）。本套件第一次落地时在**未改产品代码**的
// `122a654` 上连跑两次，结果一致 —— 通过 50 / 红 6：
//   * V1 编辑态丢失居中 ×4：单行行间公式 `sum` / `frac` / `mat` 三条 + 块切片路径下 1 条（`.cm-math-line` 为 null）；
//   * V2 点击公式 widget 后锚点漂移 11.26px / 10.06px（>`≤8px` 判据）；
//   * 同日量到的既有几何：进入公式 −25.45 / −14.62 / −23.08px；点击代码切片 **+94.27px**、
//     表格切片 **+82.52px**（与报告 §2.2 的 +94.266 / +82.516 一致）。
// T1 之后这 6 项全绿；T2 补了 C 段（慢编译 + 过期命中）、T3 补了 D 段（调度合并 + 合成闸门 +
// 扫描缓存）、T4 补了 E 段（展开占位 20 次进出），现在 93 项。
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
    ["公式形态", "代码与表格", "链接"].every((n) => list.some((f) => f.name === n)),
  what: "块级夹具里缺少本套件要用的场景（公式形态 / 代码与表格 / 链接）",
});
const sceneFormula = blockFixtures.find((f) => f.name === "公式形态");
const sceneCode = blockFixtures.find((f) => f.name === "代码与表格");
const sceneLink = blockFixtures.find((f) => f.name === "链接");

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
    scrollerTop: +box.top.toFixed(2),
    scrollerBottom: +box.bottom.toFixed(2),
    scrollTop: +scroller.scrollTop.toFixed(2),
    mode: document.querySelector(".mode-tag")?.textContent ?? null,
    head,
    caretY: caret ? +(caret.top - box.top).toFixed(2) : null,
    caretCenterClientY: caret ? +((caret.top + caret.bottom) / 2).toFixed(2) : null,
    line: lineEl
      ? {
          textAlign: getComputedStyle(lineEl).textAlign,
          text: lineEl.innerText.slice(0, 40),
          height: +lineEl.getBoundingClientRect().height.toFixed(2),
          // 这一行的身份：渲染态里行间公式的 widget 必须是它的后代（见 assertLine）
          hasInlineWidget: !!lineEl.querySelector(".cm-math-block-inline"),
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
function assertAnchor(label, stats, snap) {
  const room = (snap?.contentHeight ?? 0) - (snap?.scrollerHeight ?? 0);
  const drift = stats?.maxDrift ?? null;
  const finalDrift = stats?.finalDrift ?? null;
  const samples = stats?.frames ?? 0;
  if (samples < 5 || drift === null || finalDrift === null) {
    check(
      `${label}：锚点指标有 ≥5 个有效帧（实测 ${samples} 帧，指标不可信）`,
      false,
      JSON.stringify({ samples, drift, finalDrift }),
    );
    return;
  }
  if (room < 40) {
    // **不许静默降级**成"光标还在视口里"：本套件的点击用例都特意用"垫高 + 居中"的文档
    // 造出滚动余量（报告 §8 的锚点判据只在有余量时成立）。真量不到余量，说明文档/块表/布局
    // 已经塌了 —— 那本身就是回归，判红。首尾夹紧那种情形另有专门的用例（B3）。
    check(
      `${label}：点击用例必须有滚动余量（内容 ${snap?.contentHeight} 应 > 视口 ${snap?.scrollerHeight} + 40）`,
      false,
      JSON.stringify({
        room,
        scrollerHeight: snap?.scrollerHeight,
        contentHeight: snap?.contentHeight,
      }),
    );
    return;
  }
  // 判据用报告 §8 的 **max ≤8px**；稳态值只记录、不加更紧的阈值：CodeMirror 的
  // `scrollIntoView` 定位的是**光标文字盒**（`coordsAt`），而这里量的是行盒 —— 两者天然差
  // `(行高 − 字高)/2`，实测稳定在 3.3~3.8px（与修没修 V2 无关）。拿它当阈值就变成"要求锚定
  // 精确到行盒"，那是量法的定义问题、不是产品回归。真正的区分力在：**没修 V2 时**同一份文档
  // 的 max 是 10~11px（见文件头的红基线）。
  check(
    `${label}：点击引起的光标锚点漂移 ≤8px（实测 max ${drift}px / 稳态 ${finalDrift}px，${samples} 帧）`,
    drift <= 8,
    JSON.stringify({ drift, finalDrift, room, scrollerHeight: snap?.scrollerHeight, samples }),
  );
}

/**
 * 逐帧记录器：动作之后最多 60 帧（≈1s @60fps），用来抓轨迹而不只是终态。
 *
 * 每帧记报告 §7 T0 点名的那几项：光标行盒中心（**视口绝对**，好和鼠标点的 `clientY` 直接比；
 * 另有相对滚动容器顶的一份）、**活动行盒高度**、**上下相邻行盒的 y**、`contentHeight`、
 * 滚动量、**正文列宽**、光标位置。
 */
const TRACE_START = `(() => {
  // 每次采样用**自己的** rec + token：上一段若超时留下了一个还在跑的 rAF 循环，它接着写的是
  // 它自己捕获的 rec，翻不了这一段的 done（原来共用一个全局布尔，残留循环能提前把新采样判完）。
  const rec = { frames: [], done: false };
  const token = {};
  window.__stabilityTrace = rec;
  window.__stabilityTraceToken = token;
  const t0 = performance.now();
  const tick = () => {
    if (window.__stabilityTraceToken !== token) return; // 已被新一段取代，自己停下
    const v = window.__typstPadView;
    if (!v) { rec.done = true; return; }
    const scroller = v.scrollDOM;
    const box = scroller.getBoundingClientRect();
    const head = v.state.selection.main.head;
    let caretY = null;
    let caretCenterClientY = null;
    let lineBox = null;
    let lineCenterClientY = null;
    let prevLineY = null;
    let nextLineY = null;
    try {
      const c = v.coordsAtPos(head);
      if (c) {
        caretY = +(c.top - box.top).toFixed(2);
        caretCenterClientY = +((c.top + c.bottom) / 2).toFixed(2);
      }
    } catch {}
    try {
      const at = v.domAtPos(head).node;
      const el = at.nodeType === 1 ? at : at.parentElement;
      const line = el && el.closest ? el.closest(".cm-line") : null;
      if (line) {
        const lr = line.getBoundingClientRect();
        lineBox = +lr.height.toFixed(2);
        // 锚定的契约是"行盒中心落在鼠标点"（anchorYMargin 减的是 defaultLineHeight/2）。
        // 用 coordsAtPos 的**文字盒**中心去比会恒差 (行高 − 字高)/2 ≈ 4px —— 那是量法的假漂移。
        lineCenterClientY = +((lr.top + lr.bottom) / 2).toFixed(2);
        const prev = line.previousElementSibling;
        const next = line.nextElementSibling;
        if (prev && prev.classList.contains("cm-line"))
          prevLineY = +(prev.getBoundingClientRect().top - box.top).toFixed(2);
        if (next && next.classList.contains("cm-line"))
          nextLineY = +(next.getBoundingClientRect().top - box.top).toFixed(2);
      }
    } catch {}
    rec.frames.push({
      t: Math.round(performance.now() - t0),
      contentHeight: +v.contentHeight.toFixed(2),
      scrollTop: +scroller.scrollTop.toFixed(2),
      columnWidth: +v.contentDOM.getBoundingClientRect().width.toFixed(2),
      caretY,
      caretCenterClientY,
      lineCenterClientY,
      lineBox,
      prevLineY,
      nextLineY,
      head,
    });
    // **帧数与时间双上限**：慢机器上 60 帧可能要好几百毫秒，快机器上 60 帧又太短
    if (rec.frames.length < 60 && performance.now() - t0 < 1200) requestAnimationFrame(tick);
    else rec.done = true;
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
    await c.waitFor(`!!(window.__stabilityTrace && window.__stabilityTrace.done)`, {
      timeout: 10000,
    });
  } catch {
    /* 采满就结束；轨迹照样分析，帧数会体现在报告里 */
  }
  const all = (await c.evaluate(`window.__stabilityTrace.frames`)) ?? [];
  const frames = skipHead === null ? all : all.filter((f) => f.head !== skipHead);
  const centers = frames
    .map((f) =>
      typeof f.lineCenterClientY === "number" ? f.lineCenterClientY : f.caretCenterClientY,
    )
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
    // 没有有效帧时**写 null**（不是 0）：否则诊断明细里会显示一个"完美 0"的假指标
    maxDrift: drifts.length ? +Math.max(...drifts).toFixed(2) : null,
    /** 末帧漂移：锚定的**稳态**误差。点击用例用它做更紧的判据（见 assertAnchor） */
    finalDrift: drifts.length ? +drifts[drifts.length - 1].toFixed(2) : null,
    reversals: centers.length >= 2 ? reversals : null,
    heights: frames.map((f) => f.contentHeight),
    /** 报告 §7 T0 点名的逐帧指标（取首/末值，逐帧原始数据在 window.__stabilityTrace 里） */
    lineBoxFirst: frames.length ? frames[0].lineBox : null,
    lineBoxLast: frames.length ? frames[frames.length - 1].lineBox : null,
    prevLineYFirst: frames.length ? frames[0].prevLineY : null,
    nextLineYFirst: frames.length ? frames[0].nextLineY : null,
    nextLineYLast: frames.length ? frames[frames.length - 1].nextLineY : null,
    columnWidth: frames.length ? frames[0].columnWidth : null,
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
function assertLine(name, phase, snap, centerAt, body) {
  if (centerAt === "never") {
    check(`${name}：${phase}不套行级居中`, snap.line === null, JSON.stringify({ line: snap.line }));
    return;
  }
  // 身份判据（不然"页面里某个 `.cm-math-line` 居中"也能绿）：
  // 渲染态要求那一行里确实有行间公式的 widget；编辑态要求那一行里能看到公式源码。
  // 身份判据：渲染态要求那一行里确实有行间公式的 widget（SVG 的 innerText 是空的，不能按文本判）；
  // 编辑态要求那一行里能看到公式源码。
  const identity =
    phase === "渲染态"
      ? snap.line?.hasInlineWidget === true
      : snap.line?.text.includes(body.slice(0, 4)) === true;
  check(
    `${name}：${phase}独占单行的行间公式居中（且量到的就是它那一行）`,
    snap.line !== null && snap.line.textAlign === "center" && identity,
    JSON.stringify({ line: snap.line, body, text: snap.text.slice(0, 40) }),
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
  if (rendered) assertLine(spec.name, "渲染态", rendered, spec.centerAt, spec.body);

  // ② 进编辑态：能点的走**真实鼠标点击**（V2 要量的就是这条），不能点的走程序化选区
  let enter = null;
  let editing = rendered;
  if (spec.clickable) {
    // 点**所在行盒的中心**（不是 widget 自身的中心）：锚定的契约就是"行盒中心落在鼠标点"，
    // 拿 widget 的中心去比会带上 (行盒高 − widget 高) 与基线对齐带来的固定偏差（实测 ~3.6px）。
    const target = await c.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(spec.renderedSelector)});
      if (!el) return null;
      const wr = el.getBoundingClientRect();
      const lr = (el.closest(".cm-line") ?? el).getBoundingClientRect();
      // x 用 widget 的中心（行内公式那一行里还有正文，行中心可能落在公式之外、点不到），
      // y 用**行盒中心**（锚定的契约是"行盒中心落在鼠标点"）
      return { x: +(wr.left + wr.width / 2).toFixed(1), y: +((lr.top + lr.bottom) / 2).toFixed(1) };
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
      assertAnchor(spec.name, enter, editing);
    }
  } else {
    enter = await trace(() => setCaret(from), { skipHead: rendered?.head });
    await sleep(400);
    editing = await snapshot();
  }

  if (editing) assertLine(spec.name, "编辑态", editing, spec.centerAt, spec.body);
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
    // 报告 §7 T0 点名的逐帧指标（活动行盒 / 上下相邻行盒 y / 列宽）
    activeLineBox: { first: enter?.lineBoxFirst ?? null, last: enter?.lineBoxLast ?? null },
    prevLineY: enter?.prevLineYFirst ?? null,
    nextLineY: { first: enter?.nextLineYFirst ?? null, last: enter?.nextLineYLast ?? null },
    columnWidth: enter?.columnWidth ?? null,
  });
  await c.screenshot(SHOT(`stability-math-${spec.body.replace(/[^a-zA-Z0-9]+/g, "-")}`));
}

// --- 高块 widget：点它的中下部**不许把页面滚走**（PR #77 审查抓到的回归） ---------------------
// 选区只能落在块首（没有命中测试），而"把块首那一行钉到鼠标处"等价于让视图向上滚整个块的高度：
// `y:"start"` 是绝对定位，算式为负时被夹到 0 ⇒ 用户看到"点一下代码块，页面跳到文档顶部"。
console.log("\n=== 高块 widget：点击中下部不滚走页面");
{
  const fence = "```";
  const lines = Array.from({ length: 30 }, (_, i) => `let v${i} = ${i};`).join("\n");
  const tallDoc = `开头。\n\n${filler(20)}\n\n高块之前的正文。\n\n${fence}rust\n${lines}\n${fence}\n\n${filler(20)}\n`;
  await replaceDocument(c, tallDoc, 1400);
  await setCaret(0);
  await centerDocument();
  let geo = null;
  try {
    await c.waitFor(`!!document.querySelector(".cm-raw-block")`, { timeout: 8000 });
    geo = await c.evaluate(`(() => {
      const el = document.querySelector(".cm-raw-block");
      const r = el.getBoundingClientRect();
      const sc = window.__typstPadView.scrollDOM;
      return {
        h: +r.height.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height * 0.75),
        scrollTop: +sc.scrollTop.toFixed(1),
        clientH: sc.clientHeight,
      };
    })()`);
  } catch {
    geo = null;
  }
  check(
    `高块 widget 真的很高且在视口里（h=${geo?.h ?? "n/a"}px，点击 y=${geo?.y ?? "n/a"}）`,
    !!geo && geo.h > 200 && geo.y > geo.top && geo.y < geo.bottom,
    JSON.stringify(geo),
  );
  if (geo) {
    await c.click(geo.x, geo.y);
    // 等"展开成源码"这个条件，而不是干等固定时长
    await c
      .waitFor(`window.__typstPadView.state.doc.toString().includes("let v29")`, { timeout: 5000 })
      .catch(() => {});
    await sleep(300);
    const after = await c.evaluate(`(() => {
      const v = window.__typstPadView;
      const sc = v.scrollDOM;
      return {
        scrollTop: +sc.scrollTop.toFixed(1),
        head: v.state.selection.main.head,
        focused: document.activeElement === document.querySelector(".cm-content"),
        text: document.querySelector(".cm-content").innerText,
      };
    })()`);
    check(
      "点击高块 widget 中下部 → 展开成源码、光标落在块首、焦点还在编辑区",
      after.text.includes("let v29") &&
        after.head === tallDoc.indexOf(fence) &&
        after.focused === true,
      JSON.stringify({ head: after.head, want: tallDoc.indexOf(fence), focused: after.focused }),
    );
    check(
      `点击高块 widget 中下部 → 页面没有被滚走（scrollTop ${geo.scrollTop} → ${after.scrollTop}）`,
      Math.abs(after.scrollTop - geo.scrollTop) <= 4,
      JSON.stringify({ before: geo.scrollTop, after: after.scrollTop, widgetHeight: geo.h }),
    );
    record({
      scene: "高块 widget 中下部点击",
      source: "fake",
      phase: "真实点击（不钉的例外）",
      widgetHeight: geo.h,
      scrollTopBefore: geo.scrollTop,
      scrollTopAfter: after.scrollTop,
      contentHeight: (await snapshot())?.contentHeight ?? null,
    });
    await c.screenshot(SHOT("stability-tall-widget"));
  }
}

// --- 三档等效几何：点击 / 左右键 / Ctrl+E（报告 §7 T1 的完成标准） ----------------------------
// 桩的 `setZoom` 是假的（不改 CSS 视口），所以缩放用"压视口宽度"复现真机几何：
// 1400 / 933 / 700 CSS px ≈ 100% / 150% / 200%（与 wysiwyg.mjs 第 41 组的做法同源）。
console.log("\n=== 三档等效几何（100/150/200%）：点击、左右键、Ctrl+E");
{
  const sumDoc = MATH_DOCS[0].doc;
  const open = sumDoc.indexOf("$");
  const close = sumDoc.indexOf("$", open + 1);
  const to = close + 1;
  const longDoc = Array.from(
    { length: 60 },
    (_, i) =>
      `第 ${i + 1} 段：模式切换时这段文字用来把文档撑到足够长，好让光标停在中段、上下都有滚动余量。`,
  ).join("\n\n");
  for (const [label, width] of [
    ["100%", 1400],
    ["150%", 933],
    ["200%", 700],
  ]) {
    console.log(`\n--- ${label}`);
    await c.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // ① 真实鼠标点击公式 widget
    await replaceDocument(c, sumDoc, 900);
    await setCaret(0);
    await centerDocument();
    let widget = null;
    try {
      await c.waitFor(`!!document.querySelector(".cm-math-block-inline")`, { timeout: 8000 });
      widget = await c.evaluate(`(() => {
        const el = document.querySelector(".cm-math-block-inline");
        if (!el) return null;
        const wr = el.getBoundingClientRect();
        const lr = (el.closest(".cm-line") ?? el).getBoundingClientRect();
        return { x: +(wr.left + wr.width / 2).toFixed(1), y: +((lr.top + lr.bottom) / 2).toFixed(1) };
      })()`);
    } catch {
      widget = null;
    }
    let click = null;
    const geoNow = await snapshot();
    if (
      widget &&
      widget.y > (geoNow?.scrollerTop ?? 0) &&
      widget.y < (geoNow?.scrollerBottom ?? 0)
    ) {
      click = await trace(() => c.click(widget.x, widget.y), {
        targetClientY: widget.y,
        skipHead: 0,
      });
    }
    await sleep(400);
    const afterClick = await snapshot();
    check(
      `${label}：点击公式 widget → 光标落到公式源码起点（pos ${open}）`,
      afterClick?.head === open,
      JSON.stringify({ head: afterClick?.head, open, widget }),
    );
    check(
      `${label}：点击后焦点仍在编辑区、锚点漂移 ≤8px（实测 max ${click?.maxDrift ?? "n/a"} / 稳态 ${click?.finalDrift ?? "n/a"}px）`,
      afterClick?.focused === true && !!click && click.frames >= 5 && click.maxDrift <= 8,
      JSON.stringify({
        focused: afterClick?.focused,
        drift: click?.maxDrift,
        frames: click?.frames,
      }),
    );

    // ② 左右键逐格进出（源码位置 + 行对齐 + 焦点）
    await c.key("ArrowLeft", { code: "ArrowLeft", keyCode: 37 });
    await sleep(300);
    const outLeft = await snapshot();
    await c.key("ArrowRight", { code: "ArrowRight", keyCode: 39 });
    await sleep(300);
    const backRight = await snapshot();
    check(
      `${label}：左键退出公式、右键回到公式起点（位置 ${open - 1} → ${open}、居中、焦点）`,
      outLeft?.head === open - 1 &&
        backRight?.head === open &&
        backRight?.line?.textAlign === "center" &&
        backRight?.focused === true,
      JSON.stringify({
        outLeft: outLeft?.head,
        backRight: backRight?.head,
        line: backRight?.line,
        focused: backRight?.focused,
      }),
    );
    await setCaret(to);
    await sleep(250);
    await c.key("ArrowRight", { code: "ArrowRight", keyCode: 39 });
    await sleep(300);
    const outRight = await snapshot();
    await c.key("ArrowLeft", { code: "ArrowLeft", keyCode: 37 });
    await sleep(300);
    const backLeft = await snapshot();
    check(
      `${label}：右键退出公式、左键回到公式末尾（位置 ${to + 1} → ${to}、居中、焦点）`,
      outRight?.head === to + 1 &&
        backLeft?.head === to &&
        backLeft?.line?.textAlign === "center" &&
        backLeft?.focused === true,
      JSON.stringify({
        outRight: outRight?.head,
        backLeft: backLeft?.head,
        line: backLeft?.line,
        focused: backLeft?.focused,
      }),
    );
    record({
      scene: `三档几何 ${label}`,
      source: "real-static",
      phase: "点击 + 左右键",
      clickY: widget?.y ?? null,
      maxAnchorDriftPx: click?.maxDrift ?? null,
      frames: click?.frames ?? null,
      activeLineBox: { first: click?.lineBoxFirst ?? null, last: click?.lineBoxLast ?? null },
      nextLineY: { first: click?.nextLineYFirst ?? null, last: click?.nextLineYLast ?? null },
      columnWidth: click?.columnWidth ?? null,
    });

    // ③ Ctrl+E 往返
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

  // 连续快按 Ctrl+E：第二次 capture 必须让第一次**已经排队**的恢复作废，且最终仍在写作模式
  {
    await replaceDocument(c, longDoc, 900);
    const pos = Math.floor(longDoc.length * 0.6);
    await setCaret(pos);
    await c.wheel(700, 400, -200);
    await sleep(400);
    const before = await snapshot();
    await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
    await sleep(60); // 第一次 rAF 恢复还没跑，第二次切换就来了
    await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
    await sleep(1400);
    const after = await snapshot();
    check(
      `连续快按 Ctrl+E → 回到写作模式，光标位置与屏幕高度都不变（${before?.head} → ${after?.head}）`,
      after?.mode === "写作" &&
        after?.head === pos &&
        before?.caretY !== null &&
        after?.caretY !== null &&
        Math.abs(after.caretY - before.caretY) <= 8,
      JSON.stringify({
        beforeMode: before?.mode,
        afterMode: after?.mode,
        before: before?.caretY,
        after: after?.caretY,
        head: after?.head,
        pos,
      }),
    );
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
    activeLineBox: { first: t.lineBoxFirst, last: t.lineBoxLast },
    prevLineY: t.prevLineYFirst,
    nextLineY: { first: t.nextLineYFirst, last: t.nextLineYLast },
    columnWidth: t.columnWidth,
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
      const sc = window.__typstPadView.scrollDOM.getBoundingClientRect();
      const y = Math.round(r.top + Math.min(r.height / 2, 40));
      return { x: Math.round(r.left + r.width / 2), y, visible: r.top >= sc.top && y <= sc.bottom };
    })()`);
    check(
      `${target.name}：量到了对应的切片元素且在视口内（pos ${from}）`,
      point !== null && point.visible === true,
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
    assertAnchor(`点击${target.name}切片`, t, after);
    check(
      `点击${target.name}切片 → 轨迹没有"先缩后涨"的反向位移（反转 ${t.reversals} 次）`,
      t.reversals === 0,
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
      activeLineBox: { first: t.lineBoxFirst, last: t.lineBoxLast },
      prevLineY: t.prevLineYFirst,
      nextLineY: { first: t.nextLineYFirst, last: t.nextLineYLast },
      columnWidth: t.columnWidth,
    });
    // 回到"全部收起"再点下一个，避免上一次展开影响下一次测量
    await setCaret(sceneCode.doc.length);
    await sleep(700);
  }
  await c.screenshot(SHOT("stability-code-blocks"));
}

// B3. **没有滚动余量**（首尾夹紧）：报告 §8 对这一档的判据是"光标仍在视口内、单列合法"
{
  // 视口比内容还高 ⇒ `scrollIntoView` 滚不动，锚点只能夹在文档端点
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await replaceDocument(c, sceneCode.doc, 1200);
  await setCaret(sceneCode.doc.length);
  await sleep(500);
  const tall = await snapshot();
  check(
    `首尾夹紧用例：内容确实比视口矮（内容 ${tall?.contentHeight} / 视口 ${tall?.scrollerHeight}）`,
    (tall?.contentHeight ?? 0) < (tall?.scrollerHeight ?? 0) - 40,
    JSON.stringify({ contentHeight: tall?.contentHeight, scrollerHeight: tall?.scrollerHeight }),
  );
  const point = await c.evaluate(`(() => {
    const el = document.querySelector(".cm-block-crop");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 30)) };
  })()`);
  if (point) {
    await c.click(point.x, point.y);
    await sleep(500);
    const after = await snapshot();
    check(
      `无滚动余量时点击切片 → 光标仍在视口内（caretY ${after?.caretY}，视口 ${after?.scrollerHeight}）`,
      typeof after?.caretY === "number" &&
        after.caretY >= -1 &&
        after.caretY <= (after?.scrollerHeight ?? 0) &&
        after.focused === true,
      JSON.stringify({ caretY: after?.caretY, scrollerHeight: after?.scrollerHeight }),
    );
    record({
      scene: "首尾夹紧（无滚动余量）",
      source: "real-static",
      phase: "点击切片",
      contentHeight: tall?.contentHeight ?? null,
      scrollerHeight: tall?.scrollerHeight ?? null,
      caretY: after?.caretY ?? null,
      scrollTop: after?.scrollTop ?? null,
    });
  } else {
    check("首尾夹紧用例：量到了切片元素", false, "没有 .cm-block-crop");
  }
}

// ===========================================================================
// C. 结果与点击的一致性（报告 T2 / A1）：慢编译 + 点击命中在飞的时候文档/几何变了
// ===========================================================================
console.log("\n=== C. 过期结果与过期命中（报告 T2）");
await boot(c, `${BLOCKS_URL}&blockslow=1`, { blockFixtures, mathFixtures, settleMs: 900 });
{
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 600,
    height: 400,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await replaceDocument(c, sceneCode.doc, 1600);
  await setCaret(sceneCode.doc.length);
  await sleep(600);
  const fresh = await snapshot();
  check(
    "慢编译场景：切片已经就位（等得到第一次编译落地）",
    (fresh?.crops ?? 0) >= 2,
    JSON.stringify({ crops: fresh?.crops, contentHeight: fresh?.contentHeight }),
  );

  // 目标切片：围栏代码块（位置由夹具算，别猜）
  const rawBlock = sceneCode.blocks.find((b) => b.kind === "Raw");
  const rawFrom = byteToPos(sceneCode.doc, rawBlock.start);
  const point = await c.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll(".cm-block-crop"))
      .find((e) => Number(e.dataset.blockFrom) === ${rawFrom});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const sc = window.__typstPadView.scrollDOM.getBoundingClientRect();
    const y = Math.round(r.top + Math.min(r.height / 2, 30));
    return { x: Math.round(r.left + r.width / 2), y, visible: r.top >= sc.top && y <= sc.bottom };
  })()`);
  check(
    "慢编译场景：量到要被点的切片且在视口内",
    point !== null && point.visible === true,
    JSON.stringify({ point, rawFrom }),
  );

  if (point) {
    // ① 命中还在飞的时候**改文档**：这次点击必须整条作废（不许提交那个过时位置）
    await c.click(point.x, point.y);
    await sleep(80); // 命中测试被 blockslow 拖住了 350ms，此刻还在飞
    const beforeChange = await c.evaluate(`window.__typstPadView.state.doc.toString().length`);
    await c.evaluate(`(() => {
      const v = window.__typstPadView;
      v.dispatch({ changes: { from: 0, to: 0, insert: "改" } });
      return true;
    })()`);
    const hitResultSeen = await c.evaluate(`(() => {
      const v = window.__typstPadView;
      return { head: v.state.selection.main.head, len: v.state.doc.toString().length };
    })()`);
    await sleep(900);
    const settled = await c.evaluate(`(() => {
      const v = window.__typstPadView;
      return { head: v.state.selection.main.head, len: v.state.doc.toString().length };
    })()`);
    check(
      "命中在飞时改文档 → 这次点击作废（光标没有被那个过时位置推走）",
      settled.head === hitResultSeen.head,
      JSON.stringify({ before: beforeChange, atChange: hitResultSeen, settled }),
    );
    check(
      "命中在飞时改文档 → 文档本身没被点击流程破坏（只多了那一个字符）",
      settled.len === beforeChange + 1,
      JSON.stringify({ before: beforeChange, after: settled.len }),
    );
    record({
      scene: "慢编译 + 命中在飞时改文档",
      source: "real-static",
      phase: "点击作废（报告 T2 / A1）",
      headAtChange: hitResultSeen.head,
      headSettled: settled.head,
      docLenBefore: beforeChange,
      docLenAfter: settled.len,
      slowCompileMs: 350,
    });
  }

  // ② 版心宽变了（layoutRevision）之后：切片与链接热区必须**成套**重建
  await replaceDocument(c, sceneLink.doc, 1600);
  await setCaret(sceneLink.doc.length);
  await sleep(700);
  const linksBefore = await c.evaluate(`(() => {
    const cr = document.querySelector(".cm-content").getBoundingClientRect();
    return {
      column: +cr.width.toFixed(1),
      crops: document.querySelectorAll(".cm-block-crop").length,
      links: Array.from(document.querySelectorAll(".cm-block-crop-link")).map((a) => ({
        href: a.getAttribute("href"),
        left: a.style.left,
        top: a.style.top,
        w: a.style.width,
      })),
    };
  })()`);
  check(
    "链接场景：切片里量到了链接热区（基线）",
    Array.isArray(linksBefore.links) && linksBefore.links.length > 0,
    JSON.stringify(linksBefore),
  );
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 400,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1400); // 列宽变化 → scheduleWritingReflow（去抖 250ms）+ 慢编译 350ms
  const linksAfter = await c.evaluate(`(() => {
    const cr = document.querySelector(".cm-content").getBoundingClientRect();
    return {
      column: +cr.width.toFixed(1),
      crops: document.querySelectorAll(".cm-block-crop").length,
      links: Array.from(document.querySelectorAll(".cm-block-crop-link")).map((a) => ({
        href: a.getAttribute("href"),
        left: a.style.left,
        top: a.style.top,
        w: a.style.width,
      })),
    };
  })()`);
  check(
    `改版心宽后列宽确实变了（${linksBefore.column} → ${linksAfter.column}px）`,
    Math.abs(linksAfter.column - linksBefore.column) > 20,
    JSON.stringify({ before: linksBefore.column, after: linksAfter.column }),
  );
  check(
    "改版心宽后切片与链接热区**一起**重建（href 与百分比位置不变，说明它们随块成套走）",
    linksAfter.crops === linksBefore.crops &&
      JSON.stringify(linksAfter.links) === JSON.stringify(linksBefore.links),
    JSON.stringify({ before: linksBefore.links, after: linksAfter.links }),
  );
  record({
    scene: "改版心宽后的切片与链接",
    source: "real-static",
    phase: "layoutRevision 变化",
    columnBefore: linksBefore.column,
    columnAfter: linksAfter.column,
    crops: linksAfter.crops,
    links: linksAfter.links.length,
  });
  await c.send("Emulation.clearDeviceMetricsOverride");
}

// ===========================================================================
// D. 调度与输入法安全（报告 T3）：合成期间零次新块编译、连打合并成一次、纯选区移动不重扫
// ===========================================================================
console.log("\n=== D. 编译调度与输入法安全（报告 T3）");
await boot(c, BLOCKS_URL, { blockFixtures, mathFixtures, settleMs: 900 });
{
  /** 假命令调用计数（桩写在 window.__browserDevCallCounts 上） */
  const counts = () =>
    c.evaluate(`JSON.parse(JSON.stringify(window.__browserDevCallCounts ?? {}))`);
  const blocksCalls = async () => (await counts()).compile_blocks ?? 0;

  await replaceDocument(c, sceneCode.doc, 1400);
  await setCaret(sceneCode.doc.length);
  await sleep(800);

  // ① 连续 8 次编辑：单槽调度必须把它们合并成 1~2 次块编译（不是 8 次）
  {
    await c.click(400, 300);
    await c.key("End", { code: "End", keyCode: 35, modifiers: 2 });
    await sleep(300);
    const before = await blocksCalls();
    for (let i = 0; i < 8; i++) {
      await c.type("字");
      await sleep(20); // 20ms × 8 = 160ms：跨过 150ms 去抖边界一点点
    }
    await sleep(1200); // 等最后一次去抖 + 编译落地
    const after = await blocksCalls();
    check(
      `连续 8 次编辑只落 ${after - before} 次 compile_blocks（单槽调度：≤3，未合并时是 8）`,
      after - before <= 3,
      JSON.stringify({ before, after, delta: after - before }),
    );
    record({
      scene: "连续 8 次编辑的编译次数",
      source: "fake",
      phase: "调度合并（报告 T3）",
      compileBlocksDelta: after - before,
      note: "单槽调度：最多一个在途 + 一份待执行",
    });
  }

  // ② 输入法合成期间：**零次**新的后台块编译；结束后攒下的那次照常落地
  {
    await replaceDocument(c, sceneCode.doc, 1400);
    await c.click(400, 300);
    await c.key("End", { code: "End", keyCode: 35, modifiers: 2 });
    await sleep(700);
    const before = await blocksCalls();
    // 走真实的合成路径（Chrome 的 imeSetComposition = "正在合成这段文本"）
    await c.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
    await sleep(700); // 远超过 150ms 去抖：若没有合成闸门，这里必然已经编译过
    const during = await blocksCalls();
    check(
      `合成期间没有启动新的块编译（${before} → ${during}）`,
      during === before,
      JSON.stringify({ before, during }),
    );
    const textDuring = await c.evaluate(
      `document.querySelector(".cm-content").innerText.includes("zhong")`,
    );
    check("合成中的文本照常进编辑区（暂停编译不等于暂停编辑）", textDuring === true);
    await c.send("Input.insertText", { text: "中" });
    await sleep(1400);
    const after = await blocksCalls();
    check(
      `合成结束后攒下的那次编译照常落地（${during} → ${after}）`,
      after > during,
      JSON.stringify({ during, after }),
    );
    const committed = await c.evaluate(
      `(() => { const t = document.querySelector(".cm-content").innerText; return { has中: t.includes("中"), has拼音: t.includes("zhong") }; })()`,
    );
    check(
      "合成提交后最终文本正确（`中` 在、拼音串不在）",
      committed.has中 === true && committed.has拼音 === false,
      JSON.stringify(committed),
    );
    record({
      scene: "输入法合成期间的编译",
      source: "fake",
      phase: "合成闸门（报告 T3）",
      compileBlocksBefore: before,
      compileBlocksDuring: during,
      compileBlocksAfter: after,
    });
  }

  // ③ 纯选区移动不重新扫描整篇（报告 T3 / P1：读的是文档扫描缓存的 miss 计数）
  {
    await replaceDocument(c, sceneCode.doc, 1200);
    await sleep(600);
    const statsBefore = await c.evaluate(`window.__typstPadScanStats?.() ?? null`);
    check(
      "dev 钩子暴露了文档扫描计数（不然这条断言没有判据）",
      statsBefore !== null && typeof statsBefore.misses === "number",
      JSON.stringify({ statsBefore }),
    );
    // 只动选区：上下左右各走几步、再来一次全选（都不改文档）
    for (let i = 0; i < 6; i++) {
      await c.key("ArrowDown", { code: "ArrowDown", keyCode: 40 });
      await c.key("ArrowUp", { code: "ArrowUp", keyCode: 38 });
    }
    await c.evaluate(`(() => {
      const v = window.__typstPadView;
      v.dispatch({ selection: { anchor: 0 } });
      v.dispatch({ selection: { anchor: v.state.doc.length } });
      return true;
    })()`);
    await sleep(400);
    const statsAfter = await c.evaluate(`window.__typstPadScanStats?.() ?? null`);
    check(
      `纯选区移动没有重扫全文（miss ${statsBefore?.misses} → ${statsAfter?.misses}、hit +${(statsAfter?.hits ?? 0) - (statsBefore?.hits ?? 0)}）`,
      statsAfter !== null &&
        statsAfter.misses === statsBefore.misses &&
        statsAfter.hits > statsBefore.hits,
      JSON.stringify({ statsBefore, statsAfter }),
    );
    record({
      scene: "纯选区移动的扫描缓存",
      source: "fake",
      phase: "扫描缓存（报告 T3 / P1）",
      hitsBefore: statsBefore?.hits ?? null,
      hitsAfter: statsAfter?.hits ?? null,
      missesBefore: statsBefore?.misses ?? null,
      missesAfter: statsAfter?.misses ?? null,
    });
  }
  await c.send("Emulation.clearDeviceMetricsOverride");
}

// ===========================================================================
// E. 展开占位（报告 T4）：高公式展开时补的临时空白 —— 20 次进出零累积、上限 1 个可视高度
// ===========================================================================
console.log("\n=== E. 展开占位：20 次进出不累积（报告 T4）");
await boot(c, DEV_URL, { mathFixtures, settleMs: 800 });
{
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const spec = MATH_DOCS.find((d) => d.body === "frac(a,b)") ?? MATH_DOCS[0];
  // 正文行高（14.6667px × 1.65 = 24.2px）：判"收缩有界"要用它
  const lineHeightPx = 24.2;
  await replaceDocument(c, spec.doc, 1000);
  await setCaret(0);
  await centerDocument();
  await c.waitFor(`!!document.querySelector(".cm-math-block-inline")`, { timeout: 8000 });
  const formulaPos = spec.doc.indexOf("$") + 2; // 落进公式内部
  const collapsed = await snapshot();
  const viewport = collapsed?.scrollerHeight ?? 0;

  const renderedHeights = [];
  const editingHeights = [];
  const spacerHeights = [];
  for (let i = 1; i <= 20; i++) {
    await setCaret(formulaPos);
    await sleep(140);
    const editing = await snapshot();
    const spacer = await c.evaluate(`(() => {
      const el = document.querySelector(".cm-reserve-spacer");
      return el ? +parseFloat(el.style.height || "0").toFixed(2) : null;
    })()`);
    editingHeights.push(editing?.contentHeight ?? null);
    spacerHeights.push(spacer);
    await setCaret(spec.doc.length);
    await sleep(140);
    const back = await snapshot();
    renderedHeights.push(back?.contentHeight ?? null);
  }
  const first = renderedHeights[0];
  const worstBack = Math.max(...renderedHeights.map((h) => Math.abs((h ?? 0) - (first ?? 0))));
  check(
    `20 次进出之后收起高度不累积（每次都回到 ${first}px，最大偏差 ${worstBack.toFixed(2)}px）`,
    worstBack <= 1.5,
    JSON.stringify({ first, renderedHeights: renderedHeights.slice(-3), worstBack }),
  );
  const minEditing = Math.min(...editingHeights.map((h) => h ?? Number.POSITIVE_INFINITY));
  // 占位补的是**公式盒**与源码行的差（实测 2.43px）；渲染态的行盒还含 leading（38.83 vs 26.63），
  // 那部分属于报告允许的"一次必要的结构收敛"。所以这里判的是：收缩有界（一行 + 占位 + 1px），
  // 而不是"编辑态不许比收起态矮"。
  const bound = lineHeightPx + (spacerHeights[0] ?? 0);
  check(
    `编辑态的收缩有界（收起 ${first}px → 编辑 ${minEditing}px，收缩 ${(first - minEditing).toFixed(1)}px ≤ 一行 + 占位 ${bound.toFixed(1)}px）`,
    typeof first === "number" && first - minEditing <= bound + 1,
    JSON.stringify({ first, minEditing, bound, spacer: spacerHeights[0] }),
  );
  check(
    `20 次进入后的编辑态高度完全一致（${[...new Set(editingHeights)].join("/")}px，只收敛一次）`,
    new Set(editingHeights).size === 1,
    JSON.stringify({ editingHeights: [...new Set(editingHeights)] }),
  );
  const maxEditing = Math.max(...editingHeights.map((h) => h ?? 0));
  check(
    `编辑态高度不超过"收起态 + 1 个可视高度"（上限 ${viewport}px，实测最高超出 ${(maxEditing - (first ?? 0)).toFixed(1)}px）`,
    typeof first === "number" && maxEditing - first <= viewport + 1,
    JSON.stringify({ first, maxEditing, viewport }),
  );
  const applied = spacerHeights.filter((h) => typeof h === "number" && h > 0);
  check(
    `占位高度存在且每次相同（${applied.length}/20 次量到，值 ${[...new Set(applied)].join("/")}px）`,
    applied.length === 20 && new Set(applied).size === 1 && applied[0] <= viewport,
    JSON.stringify({ applied: [...new Set(applied)], viewport }),
  );
  record({
    scene: `${spec.body} 的展开占位`,
    source: spec.real ? "real-static" : "fake",
    phase: "20 次进出（报告 T4）",
    collapsedHeight: first,
    editingHeightMin: minEditing,
    editingHeightMax: maxEditing,
    reservePx: applied[0] ?? null,
    viewportHeight: viewport,
    worstReturnDeviationPx: +worstBack.toFixed(2),
  });
  await c.screenshot(SHOT("stability-reserve"));
  await c.send("Emulation.clearDeviceMetricsOverride");
}

// ===========================================================================
// F. 连续写作交互（报告 T5）：列表里回车续项 / 空项退出（真键盘事件走完整链路）
// ===========================================================================
console.log("\n=== F. 列表回车续项与退出（报告 T5）");
await boot(c, DEV_URL, { mathFixtures, settleMs: 800 });
{
  const doc = "= 清单\n\n- 第一项\n";
  await replaceDocument(c, doc, 900);
  const listPos = doc.indexOf("- 第一项") + "- 第一项".length;
  await setCaret(listPos);
  await sleep(300);
  await c.key("Enter", { code: "Enter", keyCode: 13 });
  await sleep(400);
  const afterFirst = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  check(
    "写作模式：列表项末尾按回车 → 续出同级新项（依赖的列表命令没被本地 keymap 遮住）",
    // 原文档末尾那个换行还在，所以结果末尾是「- 」+ 原换行
    afterFirst === "= 清单\n\n- 第一项\n- \n",
    JSON.stringify({ afterFirst }),
  );
  await c.key("Enter", { code: "Enter", keyCode: 13 });
  await sleep(400);
  const afterEmpty = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  check(
    "写作模式：空列表项按回车 → 退出列表（不留空标记）",
    // 空项退出：`- ` 标记被去掉，那一行成了空行（不是留下一个空标记）
    afterEmpty === "= 清单\n\n- 第一项\n\n",
    JSON.stringify({ afterEmpty }),
  );
  // 非列表行仍走"沿用上一行缩进"
  await replaceDocument(c, "正文一\n  缩进正文\n", 900);
  await setCaret("正文一\n  缩进正文".length);
  await sleep(300);
  await c.key("Enter", { code: "Enter", keyCode: 13 });
  await sleep(400);
  const afterPlain = await c.evaluate(`window.__typstPadView.state.doc.toString()`);
  check(
    "非列表行回车仍沿用上一行缩进（列表命令认不出来时落回我们那条）",
    afterPlain === "正文一\n  缩进正文\n  \n",
    JSON.stringify({ afterPlain }),
  );
  record({
    scene: "列表回车（写作模式）",
    source: "fake",
    phase: "Enter 续项 / 空项退出（报告 T5）",
    afterFirst,
    afterEmpty,
    afterPlain,
  });
}

// 收尾把设备覆盖清掉：它是留在 CDP target 上的，不还原会污染后续套件的视口
await c.send("Emulation.clearDeviceMetricsOverride");

// --- 反空转守卫：本套件没覆盖的矩阵维度必须显式列出来，不能算作"通过" ----------------------
const UNCOVERED = [
  "编辑后的**真实动态编译**（`real-dynamic`）：桩没有引擎、文档一改就退回假切片，只有桌面版能验",
  '**乱序**响应（两个在途编译的到达次序）：本套件的 C 段只用 `blockslow=1` 的 350ms 验了"命中在飞 + 文档变了"，没造出乱序',
  "长文 2k/20k/100k 的性能分布（报告 T4 之后）",
  "多窗口 A/B 交替（报告 T2）",
  "输入到下一帧的输入延迟（需要 release 桌面）",
  "文档 >1 页的裁剪带与脚注（报告 T6）",
  "**正确回退**（编译错误 / 未知宏 / 无切片 / `skipped` / 诊断块）—— 由 writing-blocks.mjs 第 11 组与 wysiwyg.mjs 的波浪线组覆盖，本套件不重复",
  "**呈现时延**（最后一次输入 → 可见新鲜结果）：属报告 T2，本套件只记 `contentHeight` 轨迹",
];

report.matrix = {
  covered: [
    "几何稳定（光标进出公式 / 复杂块；真实鼠标点击 + 左右键逐格进出后的源码位置、行对齐与焦点）",
    "动态轨迹（逐帧采样：锚点 y / 活动行盒 / 上下相邻行盒 y / contentHeight / 列宽 / 滚动量，帧数与时间双上限）",
    "窄窗 / 缩放（100/150/200% 等效几何下各跑一遍点击 + 左右键 + Ctrl+E；三档的点击用单行行间公式那一篇，其余三篇公式只在 100% 下点）",
    "点击锚定（公式 widget 与块切片：有滚动余量时 max ≤8px 且稳压 ≤3px；无余量时只要求光标不出视口 —— 那一档有专门用例）",
    "点击的例外（高块 widget 中下部**不钉**，页面不被滚走；右键不钉）",
    "模式切换锚点（Ctrl+E 往返：位置 + 屏幕高度 + 焦点；含连续快按时的作废路径）",
    "过期结果与过期命中（报告 T2 / A1）：`blockslow=1`（编译与命中各 350ms）下，命中在飞时改文档 → 这次点击整条作废；改版心宽后切片与链接热区成套重建",
    "连续写作交互（报告 T5）：写作模式列表里回车续项、空项回车退出、非列表行仍沿用上一行缩进（真键盘事件）",
    "展开占位（报告 T4）：高公式展开时补的临时空白 —— 20 次进出收起高度零累积（偏差 0.00px）、编辑态只收敛一次且收缩有界、占位 ≤ 1 个可视高度（`planEditReserve` 无状态）",
    "编译调度与输入法安全（报告 T3）：连续 8 次编辑只落 ≤3 次 `compile_blocks`；合成期间零次新块编译、合成中文本照常进编辑区、合成结束后攒下的那次照常落地；纯选区移动不重扫全文（文档扫描缓存的 miss 不增）",
    "整选替换 / 跨行公式例外：由 `wysiwyg.mjs` 的「公式选区与输入」组（`$x^2$` 与整行 `$ x^2 $` 各一条）与 `live-preview.test.ts` 覆盖，本套件不重复",
  ],
  uncovered: UNCOVERED,
  invariants: { maxAnchorDriftPx: 8, directionReversals: 1, minSamplesPerAnchor: 5 },
  /** 产物来源怎么标（报告 §7 T0：不许把桩的假几何当引擎结论） */
  sourceLabels: {
    "real-static": "文档与注入夹具逐字相同 → 桩返回**引擎真产物**（块切片或公式 SVG）",
    fake: "桩自己画的假产物（公式带虚线红框）；只用来验交互与对齐，**尺寸不许外推**",
    "real-dynamic":
      "编辑之后重新编译得到的真产物 —— 浏览器桩做不到（没有引擎），见 uncovered 第一条",
  },
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
