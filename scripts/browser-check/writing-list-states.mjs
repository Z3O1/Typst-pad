// **列表结构变化的真实状态回放**（报告 2026-09-28《文档模式输入体验调查与下一步优化》第一批第 3 条）。
//
// 为什么必须单独一套、而且必须用真实产物：列表的 Enter / Tab / 退出会在**结构上**改变块表
// （新项、拆项、嵌套、空项无输出），假切片的几何不能用来判断"排版对不对"。这里每个状态的文档
// 文本都由 Rust 侧 `dump_list_state_fixtures` 用**真实 typst** 预编译过
// （`npm run fixtures:list-states` → `.browser-check/list-state-fixtures.json`），回放时：
//
//   ① 文档必须**逐字**等于夹具的 `doc`（不符 = 按键 / 自动缩进行为变了，必须同步改 Rust 夹具）；
//   ② 桩必须命中**这一份**真实产物（`__browserDevBlocksMatched === true` **且**
//      `__typstPadBlocks.exact === true`，块数也对得上）—— 报告明确警告过：桩的 matched 在下一次
//      编译返回前仍可能留着 true，不能凭它宣称"当前文档已匹配真实新产物"，所以 exact + 块数一起看；
//   ③ 渲染几何必须来自那份产物：每一个**有输出**的块（切片或展开的可编辑行）在页面里的相对纵向
//      位置要与夹具的 `yPt` 差一致（±2.5px）；没有输出的块不许在 DOM 里占位；
//   ④ 活动光标行不得零高（这是用户能看见"光标在哪里"的底线）。
//
// 另外量两条报告点名的手感不变量：
//   * **未增加可见行的单字输入**（首字 → 继续输入）：前面的项一个像素都不许动（夹具里它们的
//     `yPt` 本来就完全相同，两边一起看）；
//   * **新增一行允许向下增长，但不许先缩再恢复**：Enter 前 / 落地前 / 落地后三次采样，页面内容
//     高度不得变小（空项在 typst 里没有输出 ⇒ 编辑器为它多留一条可见行是**已知取舍**，见
//     docs/development/writing-rendering.md，绝不允许"先缩回去再弹出来"）。
//
// **它不替代桌面 / 真机回放**：真实输入法、Tauri WebView、逐帧手感仍要在真机上验（报告"剩余
// 不确定性"）。本套件的输入用 `insertText`（`c.type`），**不代表中文 IME 实机输入**。
//
// 运行：CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-list-states.mjs
import { connect } from "./cdp.mjs";
import {
  BLOCKS_URL as URL_BLOCKS,
  boot,
  byteToPos,
  createChecker,
  finish,
  loadFixtures,
  shotPath as SHOT,
  sleep,
} from "./harness.mjs";

const { check, state } = createChecker();

const fixtures = loadFixtures("list-state-fixtures.json", {
  hint: "先跑 npm run fixtures:list-states",
});
const byName = new Map(fixtures.map((f) => [f.name, f]));
console.log(
  `列表状态夹具：${fixtures.length} 个预编译状态（${fixtures.map((f) => f.name).join(" / ")}）`,
);

/** 回放的起点（与 Rust 侧 `LIST_STATE_DOCS` 的「初始」逐字相同） */
const BASE = "- 甲\n- 乙\n- 丙\n";

const c = await connect();
// blockslow：Enter 之后那一小段"编译还在飞"的窗口要量得到（报告要覆盖"编译前"）
await boot(c, `${URL_BLOCKS}&blockslow=1`, { blockFixtures: fixtures, settleMs: 800 });

/**
 * 页面几何快照：块切片 + 所有源码行的行盒 + 列表标记宽度变量 + 内容高度。
 *
 * `lineFrom` 用 `posAtDOM(line, 0)` 反读（DOM 里真实渲染出来的行），`blockFrom` 是切片 widget 上
 * 记的块起点 —— 两者都是 **CodeMirror 位置**，与夹具的**字节**偏移要用 `byteToPos` 换算。
 */
const GEOMETRY = `(() => {
  const view = window.__typstPadView;
  if (!view) return null;
  const content = document.querySelector(".cm-content");
  const base = content.getBoundingClientRect().top;
  const crops = Array.from(document.querySelectorAll(".cm-block-crop")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      blockFrom: Number(el.dataset.blockFrom),
      top: +(r.top - base).toFixed(2),
      height: +r.height.toFixed(2),
      width: +r.width.toFixed(2),
    };
  });
  const lines = Array.from(document.querySelectorAll(".cm-content > .cm-line")).map((el) => {
    let lineFrom = null;
    try { lineFrom = view.posAtDOM(el, 0); } catch { lineFrom = null; }
    const r = el.getBoundingClientRect();
    const style = el.getAttribute("style") || "";
    const listVar = Array.from(el.querySelectorAll("[style*='--write-list-w'], .cm-write-list-marker"))
      .map((child) => /--write-list-w:\\s*([0-9.]+)px/.exec(child.getAttribute("style") || ""))
      .map((m) => (m ? +m[1] : null))
      .filter((v) => v !== null);
    if (/--write-list-w/.test(style)) {
      const m = /--write-list-w:\\s*([0-9.]+)px/.exec(style);
      if (m) listVar.push(+m[1]);
    }
    return {
      lineFrom,
      top: +(r.top - base).toFixed(2),
      height: +r.height.toFixed(2),
      band: el.classList.contains("cm-block-band"),
      hold: el.classList.contains("cm-block-band-hold"),
      listVar,
    };
  });
  const sel = view.state.selection.main;
  const caretLine = lines.find((l) => l.lineFrom !== null && l.lineFrom <= sel.head &&
    sel.head - l.lineFrom <= 200 && view.state.doc.lineAt(sel.head).from === l.lineFrom) || null;
  return {
    doc: view.state.doc.toString(),
    head: sel.head,
    matched: window.__browserDevBlocksMatched === true,
    exact: window.__typstPadBlocks ? window.__typstPadBlocks.exact === true : null,
    blockCount: window.__typstPadBlocks ? window.__typstPadBlocks.blocks : null,
    crops, lines, caretLine,
    scrollHeight: document.querySelector(".cm-scroller").scrollHeight,
    errors: window.__probeErrors ?? null,
  };
})()`;
const geometry = () => c.evaluate(GEOMETRY);

/** 预编译状态里**有输出**的块（有产物、有高度）：它们必须在页面上有对应的行盒 / 切片 */
function visibleBlocks(fx) {
  return fx.blocks
    .map((b, i) => ({ ...b, index: i, pos: byteToPos(fx.doc, b.start) }))
    .filter((b) => b.found && b.svg && b.heightPt > 0.5);
}
/** 夹具里**没有输出**的块：编辑器不许让它们在 DOM 里占位（隐藏块高度必须是 0） */
function hiddenBlocks(fx) {
  return fx.blocks
    .map((b) => ({ ...b, pos: byteToPos(fx.doc, b.start) }))
    .filter((b) => !b.found || !b.svg || !(b.heightPt > 0.5));
}

/** 等到"文档逐字命中 + 这一份产物就是当前文档的"（`exact`） */
async function waitFresh(fx) {
  await c.waitFor(
    `(() => {
      const v = window.__typstPadView;
      return !!v && v.state.doc.toString() === ${JSON.stringify(fx.doc)}
        && window.__typstPadBlocks && window.__typstPadBlocks.exact === true;
    })()`,
    { timeout: 20000 },
  );
  return geometry();
}

/**
 * 一个状态的完整验收：文本逐字、真实产物命中、几何与夹具一致、光标行可见。
 * 返回快照供成对不变量（单字输入 / Enter 增长）使用。
 */
async function assertState(name) {
  const fx = byName.get(name);
  if (!fx) throw new Error(`夹具里没有状态「${name}」（检查 npm run fixtures:list-states）`);
  const g = await waitFresh(fx);
  check(
    `[${name}] 文档逐字等于预编译状态：${JSON.stringify(fx.doc)}`,
    g.doc === fx.doc,
    JSON.stringify({ got: g.doc }),
  );
  check(
    `[${name}] 命中的是**这一份**真实产物（matched=${g.matched} exact=${g.exact} 块 ${g.blockCount}/${fx.blocks.length}）`,
    g.matched && g.exact === true && g.blockCount === fx.blocks.length,
    JSON.stringify({ matched: g.matched, exact: g.exact, blocks: g.blockCount }),
  );
  const expected = visibleBlocks(fx);
  /**
   * 相对位置比较：只比**块与块之间**的纵向距离（`yPt` 是页面坐标、DOM 是内容盒坐标，差一个常数
   * 偏移）。**比例必须逐元素判**：切片按**列宽**把 SVG 缩放到编辑器列宽（`crop.width /
   * contentWidthPt`），而可编辑行的带高盒是固定的 **4/3** —— 只有在同一状态里两类**没有混用**时，
   * 相对距离才在同一个比例下可加；混用时只验"每个有输出的块都在场"（报告要的是结构回放，
   * 混比例的像素级对账属于桌面 / 真机验收，见 writing-blocks-visual 对切片的同类说明）。
   */
  const observed = new Map();
  for (const crop of g.crops) observed.set(crop.blockFrom, { top: crop.top, kind: "crop", crop });
  for (const line of g.lines)
    if (line.lineFrom !== null) observed.set(line.lineFrom, { top: line.top, kind: "line" });
  const misses = [];
  const paired = [];
  for (const b of expected) {
    const hit = observed.get(b.pos);
    if (hit === undefined) {
      misses.push(`${b.index}@${b.pos}`);
      continue;
    }
    paired.push({ ...hit, y: b.yPt, pos: b.pos });
  }
  const kinds = new Set(paired.map((p) => p.kind));
  const factor =
    kinds.size === 1 && kinds.has("crop") && paired[0]?.crop?.width
      ? paired[0].crop.width / fx.contentWidthPt
      : 4 / 3;
  let worst = 0;
  for (const p of paired) {
    worst = Math.max(worst, Math.abs(p.top - paired[0].top - (p.y - paired[0].y) * factor));
  }
  if (kinds.size <= 1) {
    check(
      `[${name}] ${expected.length} 个有输出的块都在 DOM 里、相对位置与真实产物一致（比例 ${factor.toFixed(3)}，最大偏差 ${worst.toFixed(2)}px ≤ 2.5）`,
      misses.length === 0 && paired.length === expected.length && worst <= 2.5,
      JSON.stringify({
        misses,
        worst: +worst.toFixed(2),
        expected: paired.map((p) => +((p.y - paired[0].y) * factor).toFixed(2)),
        observed: paired.map((p) => +(p.top - paired[0].top).toFixed(2)),
      }),
    );
  } else {
    check(
      `[${name}] ${expected.length} 个有输出的块都在 DOM 里（切片与可编辑行混用 ⇒ 比例不可加，只验在场；缺 ${misses.length}）`,
      misses.length === 0 && paired.length === expected.length,
      JSON.stringify({ misses, kinds: [...kinds], positions: expected.map((b) => b.pos) }),
    );
  }
  const hidden = hiddenBlocks(fx);
  /**
   * 没有输出的块在夹具里的 yPt 是 0 —— 它如果在 DOM 里占高度，后面所有块就会整体偏下（上一条几何
   * 断言会先红）；这里补一条"它本身没有独立行盒"的直接证据。
   *
   * **例外是光标所在的那一行**：typst 里空列表项没有输出（没有行盒），但光标停在上面时必须看得见
   * —— 那是报告 P0 的「活动光标行不得零高」，也是已知取舍（见 docs/development/writing-rendering.md）。
   */
  const caretFrom = g.caretLine ? g.caretLine.lineFrom : null;
  const hiddenLaid = hidden.filter((b) => {
    if (b.pos === caretFrom) return false; // 光标就在这一行：它必须可见
    const line = g.lines.find((l) => l.lineFrom === b.pos);
    return line !== undefined && line.height > 6;
  });
  check(
    `[${name}] 没有输出的块不占独立行盒（${hidden.length} 个，违规 ${hiddenLaid.length}；光标行豁免）`,
    hiddenLaid.length === 0,
    JSON.stringify({ hidden: hidden.map((b) => b.pos), laid: hiddenLaid.map((b) => b.pos) }),
  );
  check(
    `[${name}] 活动光标行盒可见（位置 ${caretFrom}，${g.caretLine ? g.caretLine.height : "?"}px ≥ 8，不是那条 0~3px 的分隔行）`,
    g.caretLine !== null && g.caretLine.height >= 8,
    JSON.stringify({ head: g.head, caretLine: g.caretLine }),
  );
  return g;
}

/** 夹具给的"标记 → 正文起点"（pt → px，与前端同一口径 4/3） */
function markerBodyPx(name) {
  const fx = byName.get(name);
  const marked = fx.blocks.filter((b) => b.listMarker && b.listMarker.text);
  return marked.map((b) => +((b.listMarker.bodyOffsetPt * 4) / 3).toFixed(3));
}

const docText = () => c.evaluate(`window.__typstPadView.state.doc.toString()`);
const setCaret = (pos) =>
  c.evaluate(
    `(() => { const v = window.__typstPadView; v.dispatch({ selection: { anchor: ${pos} } }); v.focus(); return v.state.selection.main.head; })()`,
  );
const resetDoc = async () => {
  await c.click(400, 300);
  await c.selectAll();
  await c.type(BASE);
  await sleep(700);
};

// ---------------------------------------------------------------------------
// 回放：初始 → 空续项 → 首字 → 继续输入 → 再续一项 → 嵌套 → 空嵌套项回车 → 退出列表
// （按键序列与 Rust 侧 `LIST_STATE_DOCS` 一一对应；光标起点用测试钩子放到最后一项行尾 11）
// ---------------------------------------------------------------------------
console.log("\n=== 列表状态回放（真实预编译产物 + 块级慢编译窗口）");
await resetDoc();
const placed = await setCaret(11);
check("回放起点：光标在最后一项行尾（位置 11）", placed === 11, String(placed));

const g0 = await assertState("初始");

await c.key("Enter", { code: "Enter", keyCode: 13 });
const gEnter = await assertState("空续项");
await c.type("丁");
const gFirstChar = await assertState("首字");
await c.type("戊");
const gTyped = await assertState("继续输入");

// ① **未增加可见行的单字输入**（首字 → 继续输入）：前面的项一个像素都不许动。
//    夹具侧同时核对：这两个状态的 yPt 本来就完全相同（"没有增加可见行"是可证的）。
const fxFirst = byName.get("首字").blocks.map((b) => b.yPt);
const fxTyped = byName.get("继续输入").blocks.map((b) => b.yPt);
const stablePrefix = fxTyped.slice(0, 3).every((y, i) => y === fxFirst[i]);
/** 某个块起点对应的屏幕 top：简单列表项是可编辑正文（源码行），复杂的才走切片 */
const topAt = (g, pos) =>
  (g.crops.find((x) => x.blockFrom === pos) ?? g.lines.find((l) => l.lineFrom === pos) ?? {}).top;
const p1 = byteToPos(BASE, 0);
const p2 = byteToPos(BASE, 6);
check(
  `单字输入（首字 → 继续输入）：夹具里前三项 yPt 完全不变（${JSON.stringify(fxFirst.slice(0, 3))}）`,
  stablePrefix,
  JSON.stringify({ fxFirst, fxTyped }),
);
check(
  `单字输入：前三项的屏幕位置也不动（${topAt(gFirstChar, p1)}/${topAt(gFirstChar, p2)} → ${topAt(gTyped, p1)}/${topAt(gTyped, p2)}px）`,
  topAt(gFirstChar, p1) !== undefined &&
    topAt(gFirstChar, p1) === topAt(gTyped, p1) &&
    topAt(gFirstChar, p2) === topAt(gTyped, p2),
  JSON.stringify({
    before: gFirstChar.crops.map((x) => x.top),
    after: gTyped.crops.map((x) => x.top),
  }),
);

// ② **新增一行：允许向下增长，不许先缩再恢复**（Enter 前 / 落地前 / 落地后三次采样）
const before = await geometry();
await c.key("Enter", { code: "Enter", keyCode: 13 });
await sleep(120); // blockslow=350ms：此刻编译还在飞
const preLanding = await geometry();
const gNext = await assertState("再续一项");
check(
  `新增一行：落地前页面没有**变小**（Enter 前 ${before.scrollHeight} → 落地前 ${preLanding.scrollHeight}）`,
  preLanding.scrollHeight >= before.scrollHeight - 1,
  JSON.stringify({ before: before.scrollHeight, pre: preLanding.scrollHeight }),
);
check(
  `新增一行：落地后也没缩回去（落地前 ${preLanding.scrollHeight} → 落地后 ${gNext.scrollHeight}）`,
  gNext.scrollHeight >= preLanding.scrollHeight - 1,
  JSON.stringify({ pre: preLanding.scrollHeight, after: gNext.scrollHeight }),
);
check(
  `新增一行：前面三项没有被推走（Enter 前 ${topAt(before, p1)} → 落地后 ${topAt(gNext, p1)}px）`,
  topAt(before, p1) !== undefined && topAt(before, p1) === topAt(gNext, p1),
  JSON.stringify({ before: before.crops.map((x) => x.top), after: gNext.crops.map((x) => x.top) }),
);
/** 空续项那一行（typst 里没有输出）在夹具里的起点 */
const emptyItemPos = byteToPos(byName.get("空续项").doc, byName.get("空续项").blocks[3].start);
const emptyItemLine = gEnter.lines.find((l) => l.lineFrom === emptyItemPos);
check(
  `空续项：没有输出的空项是一条**可见的自然行盒**（${emptyItemLine ? emptyItemLine.height : "?"}px，不带带高盒 band=${emptyItemLine?.band} hold=${emptyItemLine?.hold}）`,
  emptyItemLine !== undefined &&
    emptyItemLine.height >= 8 &&
    !emptyItemLine.band &&
    !emptyItemLine.hold,
  JSON.stringify(emptyItemLine),
);

// ③ 嵌套 / 空嵌套项回车 / 退出列表
await c.key("Tab", { code: "Tab", keyCode: 9 });
await assertState("嵌套");
await c.key("Enter", { code: "Enter", keyCode: 13 });
// 空嵌套项回车 → 回到"再续一项"那一份文档（同一份夹具，同样的验收）
await assertState("再续一项");
await c.key("Enter", { code: "Enter", keyCode: 13 });
await assertState("退出列表");

// ④ 撤销：连续 Ctrl+Z 必须回到**已经预编译过**的旧状态（文本 + 几何都对得上）
let undone = null;
for (let i = 0; i < 4; i++) {
  await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
  await sleep(300);
  if ((await docText()) === byName.get("继续输入").doc) {
    undone = "继续输入";
    break;
  }
}
check("撤销：连续 Ctrl+Z 回到「继续输入」那一份预编译文档", undone === "继续输入", await docText());
if (undone) await assertState("继续输入");

// ⑤ 拆分（光标在 "- 丙" 的「丙」之前，位置 10）：拆项后 乙 的带高变成两行、"－"那一行没有输出
await resetDoc();
await setCaret(10);
await c.key("Enter", { code: "Enter", keyCode: 13 });
const gSplit = await assertState("拆分");

// ⑥ 嵌套后继（报告第 3 节的具体形态）：**第一项末尾 Enter** —— 后继的嵌套列表块会从切片变回
//    多行源码（报告实测后文"第三项" y +3.422px）。这里量四件事：编译前不许往上缩、新空项行
//    必须可见、落地后被编辑项的**带高来自真实产物**（typst 里新空项没有输出，但会让上一项的
//    带长大 17.221pt → 24.414pt）、落地后也不许缩。
console.log("\n=== 嵌套后继：第一项末尾 Enter（后继嵌套块从切片变回源码）");
await c.click(400, 300);
await c.selectAll();
await c.type(byName.get("嵌套列表·初始").doc);
await assertState("嵌套列表·初始");
const nestedCaret = await c.evaluate(`window.__typstPadView.state.doc.line(3).to`);
await setCaret(nestedCaret);
await sleep(200);
const nestedBefore = await geometry();
await c.key("Enter", { code: "Enter", keyCode: 13 });
await sleep(120); // 编译还在飞
const nestedPre = await geometry();
/** 末尾 n 条源码行的 top（按顺序）—— 编辑在文档中段，尾部内容不变，跨状态按顺序比 */
const tailTops = (g, n) =>
  g.lines
    .filter((l) => l.lineFrom !== null)
    .slice(-n)
    .map((l) => l.top);
const beforeTail = tailTops(nestedBefore, 3);
const preTail = tailTops(nestedPre, 3);
check(
  `嵌套后继：Enter 之后（编译还在飞）后文一个像素都没有往上缩（${beforeTail} → ${preTail}）`,
  preTail.length === 3 && preTail.every((t, i) => t >= beforeTail[i] - 1),
  JSON.stringify({ beforeTail, preTail }),
);
check(
  `嵌套后继：编译前光标（新空项）行盒可见（${nestedPre.caretLine ? nestedPre.caretLine.height : "?"}px ≥ 8）`,
  nestedPre.caretLine !== null && nestedPre.caretLine.height >= 8,
  JSON.stringify(nestedPre.caretLine),
);
const nestedPost = await assertState("嵌套列表·续项");
const nestedItemFrom = byteToPos(
  byName.get("嵌套列表·续项").doc,
  byName.get("嵌套列表·续项").blocks[1].start,
);
const nestedItemLine = nestedPost.lines.find((l) => l.lineFrom === nestedItemFrom);
const realBand = (byName.get("嵌套列表·续项").blocks[1].heightPt * 4) / 3;
check(
  `嵌套后继：落地后被编辑项的带高来自真实产物（${nestedItemLine ? nestedItemLine.height : "?"}px vs 真实 ${realBand.toFixed(2)}px ±0.6）`,
  nestedItemLine !== undefined && Math.abs(nestedItemLine.height - realBand) <= 0.6,
  JSON.stringify({ line: nestedItemLine, realBand }),
);
check(
  `嵌套后继：落地后也没有缩回去（${preTail} → ${tailTops(nestedPost, 3)}）`,
  tailTops(nestedPost, 3).every((t, i) => t >= preTail[i] - 1),
  JSON.stringify({ preTail, postTail: tailTops(nestedPost, 3) }),
);

// ---------------------------------------------------------------------------
// 标记 → 正文起点：必须来自引擎（`listMarker.bodyOffsetPt`），并且跨状态稳定
// ---------------------------------------------------------------------------
const expectedMarker = markerBodyPx("继续输入");
const allMarkerVars = [g0, gFirstChar, gTyped, gNext, gSplit].flatMap((g) =>
  g.lines.flatMap((l) => l.listVar),
);
check(
  `标记 → 正文起点来自引擎（${expectedMarker[0]}px）：实际 ${JSON.stringify([...new Set(allMarkerVars)])}`,
  allMarkerVars.length > 0 && allMarkerVars.every((v) => Math.abs(v - expectedMarker[0]) <= 0.01),
  JSON.stringify({ expected: expectedMarker, seen: allMarkerVars }),
);
check(
  `标记 → 正文起点跨状态（初始/首字/继续输入/再续一项/拆分）稳定：${JSON.stringify([...new Set(allMarkerVars)])}`,
  new Set(allMarkerVars).size === 1,
  JSON.stringify(allMarkerVars),
);
check("整段回放没有页面脚本错误", gSplit.errors === null, String(gSplit.errors));

await c.screenshot(SHOT("writing-list-states-final"));
finish(`通过 ${state.passed} 项检查；截图：.browser-check/writing-list-states-final.png`);
