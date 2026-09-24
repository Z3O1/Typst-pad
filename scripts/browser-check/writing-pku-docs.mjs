// **PKU 真实作业的写作模式逐块几何验收**（P0 主样本 + 三份 P1）。
//
// 与 `writing-blocks-visual.mjs` 的分工：那一套只比**复杂切片之间**的相对 y；这一套把
// **可编辑正文、标题、列表、公式切片放进同一张逐块位置表**，用真实作业当输入，回答
// "哪份文档、哪一行、从哪里开始错、偏差如何累计"。
//
// 链路：
//   1) `PKU_ROOT="$HOME/PKU" npm run fixtures:pku-writing` 用真实 Rust 后端按**源文件实际路径**
//      编译四份作业（相对资源可解析），导出每块的带几何 + **首行锚点**（`anchorYpt`）+ 真实
//      SVG，以及文档内每个公式的真编译产物（`math`）；
//   2) 本脚本把**当篇**夹具注入页面（`__DEV_BLOCK_FIXTURES` / `__DEV_MATH_FIXTURES`），
//      并把编辑列宽钉到夹具的版心（默认 371.25pt = 495px）—— 版心不一致时断行都不同，量了也白量；
//   3) 把文档打进编辑器，量每块的锚点 / 视觉行数 / 高度，和 Typst 的锚点对账。
//
// 环境变量：
//   PKU_ROOT     作业根目录（不设则报错退出：夹具不在就别跑这一套）
//   PKU_DOCS     只跑匹配这些子串的文档（调试用；设了就不做"四份齐全"断言）
//   PKU_KEEP     1 = 保留页面展开（调试）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "./cdp.mjs";
import {
  BLOCKS_URL,
  boot,
  byteToPos,
  createChecker,
  finish,
  shotPath as SHOT,
  sleep,
} from "./harness.mjs";

const OUT_DIR = new URL("../../.browser-check/pku-writing/", import.meta.url).pathname;
const { check, state } = createChecker();

// ---------------------------------------------------------------------------
// 夹具装载（fail-closed：没有夹具 / 夹具残缺 / 原文哈希变了，都直接失败，不许退回假产物）
// ---------------------------------------------------------------------------
const fixturesPath = `${OUT_DIR}fixtures.json`;
if (!existsSync(fixturesPath)) {
  console.error(
    `✗ 找不到 PKU 夹具 ${fixturesPath}\n  先跑：PKU_ROOT="$HOME/PKU" npm run fixtures:pku-writing`,
  );
  process.exit(1);
}
const allFixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
if (!Array.isArray(allFixtures) || allFixtures.length === 0) {
  console.error(`✗ 夹具为空：${fixturesPath}（别拿空夹具跑验收）`);
  process.exit(1);
}
const filter = (process.env.PKU_DOCS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const fixtures = filter.length
  ? allFixtures.filter((f) => filter.some((k) => f.relPath.includes(k) || f.name.includes(k)))
  : allFixtures;
if (fixtures.length === 0) {
  console.error(`✗ PKU_DOCS=${process.env.PKU_DOCS} 没匹配到任何样本`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

console.log(
  `PKU 写作模式验收：${fixtures.length}/${allFixtures.length} 份样本（PKU_ROOT=${process.env.PKU_ROOT ?? "（未设）"}）`,
);
for (const f of fixtures) {
  console.log(
    `  · [${f.priority}] ${f.name}  ${f.absPath}\n     版心 ${f.contentWidthPt}pt / 正文 ${f.textPt}pt / ${f.pages ?? "?"} 页 / ${f.blocks.length} 块 / ${(f.math ?? []).length} 个公式产物`,
  );
}

// ---------------------------------------------------------------------------
// 全局断言
// ---------------------------------------------------------------------------
check(
  "所有样本都带真实列宽与行距（浏览器按它排版才对得上锚点）",
  allFixtures.every((f) => f.contentWidthPt > 0 && f.parLeading >= 0),
  JSON.stringify(allFixtures.map((f) => [f.name, f.contentWidthPt, f.parLeading])),
);
let stale = [];
if (!filter.length) {
  for (const f of allFixtures) {
    let hash = null;
    try {
      hash = createHash("sha256").update(readFileSync(f.absPath)).digest("hex");
    } catch {
      hash = null;
    }
    if (hash !== f.sha256)
      stale.push(`${f.name}（夹具 ${f.sha256?.slice(0, 8)} ≠ 现在 ${hash?.slice(0, 8)}）`);
  }
  check(`原文哈希与夹具一致（改过原文要重导夹具）`, stale.length === 0, stale.join("；"));
}
check(
  "四份样本都由真实后端编译成功且有几何",
  allFixtures.every((f) => f.ok === true && f.blocks.some((b) => b.found && b.anchorYpt != null)),
  JSON.stringify(allFixtures.map((f) => [f.name, f.ok, f.blocks.length])),
);

// ---------------------------------------------------------------------------
// 判据（与实现同口径的辅助函数）
// ---------------------------------------------------------------------------
const COMPLEX_RE = /(#|`|\/\/|\/\*)/;
/** 与 `isDirectlyEditableTextBlock` 同口径：纯 markup 的段落/标题直接在编辑器里呈现 */
function directlyEditable(doc, b) {
  if (!b.found || b.skipped || !["Paragraph", "Heading"].includes(b.kind)) return false;
  const src = doc.slice(byteToPos(doc, b.start), byteToPos(doc, b.end));
  // 段内有单 LF 的段落走切片（见 isDirectlyEditableTextBlock 的说明）
  if (src.includes("\n")) return false;
  return !COMPLEX_RE.test(src);
}
/** Typst 行数：把 `lineTopsPt`（0.5pt 去重的字形顶）按"半个行距"聚类（同一行的上下标不拆行） */
function typstLineCount(block, textPt, parLeading) {
  const ys = [...new Set(block.lineTopsPt ?? [])].sort((a, b) => a - b);
  if (ys.length === 0) return 0;
  const threshold = (textPt * (1 + parLeading)) / 2;
  let lines = 1;
  for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > threshold) lines++;
  return lines;
}
/** 把体积大的切片换成等比例占位（几何不变、注入体积可控）；高代周一的整页图片有 5MB+ */
const SLIM_SVG_LIMIT = 300_000;
function slimFixture(fx) {
  let replaced = 0;
  const blocks = fx.blocks.map((b) => {
    if (directlyEditable(fx.doc, b)) return { ...b, svg: "" };
    if (b.svg && b.svg.length > SLIM_SVG_LIMIT) {
      replaced++;
      return {
        ...b,
        // 宽度用**文档真实列宽**：`#set page` 覆盖过的文档，块自带的 widthPt 是注入页的列宽，
        // 拿它当 viewBox 会让切片高度按错误比例缩放，逐块几何全错。
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fx.contentWidthPt} ${b.heightPt}"></svg>`,
      };
    }
    return b;
  });
  return { fixture: { ...fx, blocks }, replaced };
}

const c = await connect();
const reports = [];

// ---------------------------------------------------------------------------
// 编辑回放（P0）：Enter / 输入 / Backspace / Undo 的确定状态
//
// 桩只在"全文与夹具逐字相同"时给真实块几何，所以每个状态都有一份真实编译夹具
// （`replay.json`，Rust 的 `PKUREPLAY:` 导出）。回放用**真实按键**驱动，逐步断言：
//   * 文档文本与对应状态的夹具逐字相同；
//   * 该状态命中了真实夹具（`__browserDevBlocksMatched`，绝不静默退回假切片）；
//   * Undo / 连按 Backspace 回到原始文本后，后续行的基线回到编辑前的值（≤1px）。
// ---------------------------------------------------------------------------
const replayPath = `${OUT_DIR}replay.json`;
if (existsSync(replayPath) && fixtures[0] === allFixtures[0]) {
  const replay = JSON.parse(readFileSync(replayPath, "utf8"));
  const p0 = allFixtures[0];
  const docColumnPt = p0.contentWidthPt;
  // 列宽用**精确**的 pt→px 换算（4/3），不要取整：整 px 会让"列宽/版心"这个比例与
  // 正文的字号比例（docTextPt × 4/3）不一致，纵向比较时每 1000px 就偏 ~0.6px。
  const docColumnPx = (docColumnPt * 4) / 3;
  const states = replay.states; // [A 原始, B Enter, C 输入, D Backspace]
  let before = 0;
  const slimP0 = slimFixture(p0).fixture;
  const injected = [slimP0, ...states.map((s) => slimFixture({ ...p0, ...s }).fixture)];
  console.log(`\n=== 编辑回放（${p0.name}，锚点 ${replay.anchor}）`);

  await boot(c, BLOCKS_URL, {
    blockFixtures: injected,
    mathFixtures: p0.math ?? [],
    settleMs: 800,
  });
  // 列宽钉到文档真实列宽（与逐块验收同口径）
  const applyReplayWidth = (px) =>
    c.evaluate(`(() => {
      let s = document.getElementById('pku-writing-column');
      if (!s) { s = document.createElement('style'); s.id = 'pku-writing-column'; document.head.appendChild(s); }
      s.textContent = [
        '.editor-host.write .cm-scroller { scrollbar-gutter: auto !important; }',
        '.editor-host .cm-scroller::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
        '.editor-host.write .cm-content { width: ${px}px !important; min-width: ${px}px !important; max-width: ${px}px !important; }',
      ].join('\\n');
      return document.querySelector('.cm-content')?.clientWidth ?? 0;
    })()`);
  await applyReplayWidth(docColumnPx);
  await sleep(350);

  const setDoc = (doc) =>
    c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.focus();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(doc)} } });
      return view.state.doc.length;
    })()`);
  const setCursor = (pos) =>
    c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.focus();
      view.dispatch({ selection: { anchor: ${pos} } });
      return view.state.selection.main.head;
    })()`);
  // 预热：先滚到底再滚回锚点，强制 CodeMirror 把沿途的块 widget 都实测一遍。
  // 不做这一步时，刚加载完测到的绝对坐标可能还建立在"未实测 widget 的估算高度"上
  // （回放实测到过整段恒定 121px 的偏移，行间差值却完全一致）。
  const warmUp = async (pos) => {
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
      return true;
    })()`);
    await sleep(350);
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      const L = v.state.doc.lineAt(${pos});
      v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(L.from).top - 120);
      return true;
    })()`);
    await sleep(350);
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
      return true;
    })()`);
    await sleep(350);
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      const L = v.state.doc.lineAt(${pos});
      v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(L.from).top - 120);
      return true;
    })()`);
    await sleep(350);
  };

  const docText = () =>
    c.evaluate(`document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()`);
  const compileCount = () => c.evaluate(`window.__browserDevCallCounts?.compile_blocks ?? 0`);
  const waitMatched = async (before) => {
    await c.waitFor(
      `(window.__browserDevCallCounts?.compile_blocks ?? 0) > ${before} && window.__browserDevBlocksMatched === true`,
      { timeout: 20000 },
    );
  };
  const matched = () => c.evaluate(`window.__browserDevBlocksMatched === true`);
  /** 只等"重新编译过"（编辑态没有逐字夹具时要等这个，不能等 matched） */
  const waitRecompiled = async (beforeCount) => {
    await c.waitFor(`(window.__browserDevCallCounts?.compile_blocks ?? 0) > ${beforeCount}`, {
      timeout: 20000,
    });
  };
  // 按源码行号量基线（同一行号在"回到原始文本"后应对应同一内容）
  const measureLines = (nums) =>
    c.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const view = content.cmTile.root.view;
      const padTop = parseFloat(getComputedStyle(content).paddingTop) || 0;
      const docTopOf = (el) => el.getBoundingClientRect().top - content.getBoundingClientRect().top - padTop;
      const findLine = (from) => {
        for (const el of document.querySelectorAll('.cm-line')) {
          let p = -1;
          try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
          if (p === from) return el;
        }
        return null;
      };
      const out = {};
      for (const n of ${JSON.stringify(nums)}) {
        if (n < 1 || n > view.state.doc.lines) continue;
        const L = view.state.doc.line(n);
        const el = findLine(L.from);
        if (!el) continue;
        const cs = getComputedStyle(el);
        const ctx = document.createElement('canvas').getContext('2d');
        // 基线要用**真正画这些字的字体**的 ascent/descent 算：正文栈以 Libertinus 打头（没有汉字），
        // 用整个栈量出来的是回退族的度量，基线估算会差几个像素（我们追的正是这个量级）。
        ctx.font = cs.fontSize + ' "Noto Serif CJK SC"';
        const tm = ctx.measureText('字Hg');
        const asc = tm.fontBoundingBoxAscent || 0;
        const desc = tm.fontBoundingBoxDescent || 0;
        const lh = parseFloat(cs.lineHeight) || view.defaultLineHeight;
        out[n] = docTopOf(el) + (lh - (asc + desc)) / 2 + asc;
      }
      return out;
    })()`);

  // replay.anchor 是 Rust 侧的**字节**偏移；编辑器位置是 UTF-16，中文文档直接当位置用会偏
  const anchorPos = byteToPos(states[0].doc, replay.anchor);

  /** 文本不一致时给出首个不同点，便于区分"插入位置不同"和"内容不同" */
  const diffHint = (a, b) => {
    if (a === b) return "";
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `首个不同 @${i}（锚点 ${anchorPos}）：实际 ${JSON.stringify(a.slice(i, i + 12))} / 夹具 ${JSON.stringify(b.slice(i, i + 12))}`;
  };

  // 加载 A（原始）——必须在按锚点定位之前（新页面初始是空文档）
  before = await compileCount();
  await setDoc(states[0].doc);
  await waitMatched(before);
  check(`编辑回放：原始状态命中真实夹具（不退回假切片）`, (await matched()) === true);
  // 光标统一放在锚点：光标所在的复杂/多源码行块会展开成源码（比切片高），不统一就会把
  // "展开的那一块"的高度差算成几何变化（回放实测到过恒定 121px 的偏移）。
  await setCursor(anchorPos);

  // 滚到锚点附近，让待测的行在视口里
  await c.evaluate(`(() => {
    const view = document.querySelector('.cm-content').cmTile.root.view;
    const L = view.state.doc.lineAt(${anchorPos});
    view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(L.from).top - 120);
    return true;
  })()`);
  const anchorLine = await c.evaluate(
    `document.querySelector('.cm-content').cmTile.root.view.state.doc.lineAt(${anchorPos}).number`,
  );
  const refLines = [anchorLine + 1, anchorLine + 2, anchorLine + 3, anchorLine + 4, anchorLine + 5];
  await warmUp(anchorPos);
  const refBaselines = await measureLines(refLines);
  check(
    `编辑回放：参考行可测（${Object.keys(refBaselines).length}/${refLines.length} 行）`,
    Object.keys(refBaselines).length >= 3,
  );

  // ① Enter
  await setCursor(anchorPos);
  before = await compileCount();
  await c.key("Enter", { code: "Enter", keyCode: 13 });
  await sleep(400);
  const afterEnter = await docText();
  check(
    `编辑回放：Enter 在段末产生一个源码换行（${states[0].doc.length} → ${afterEnter.length} 字符）`,
    afterEnter === states[1].doc,
    diffHint(afterEnter, states[1].doc),
  );
  await waitMatched(before);
  check(`编辑回放：Enter 后命中真实夹具`, (await matched()) === true);

  // ② Ctrl+Z 撤销 → 文本与几何回到原始
  before = await compileCount();
  await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
  await sleep(400);
  check(`编辑回放：Ctrl+Z 撤销 Enter 后文本恢复原样`, (await docText()) === states[0].doc);
  await waitMatched(before);
  await setCursor(anchorPos);
  await warmUp(anchorPos);
  const afterUndo = await measureLines(refLines);
  let worstRestore = 0;
  for (const n of Object.keys(refBaselines)) {
    if (afterUndo[n] == null) continue;
    worstRestore = Math.max(worstRestore, Math.abs(afterUndo[n] - refBaselines[n]));
  }
  check(
    `编辑回放：撤销后后续行基线回到编辑前（最大偏差 ${worstRestore.toFixed(2)}px）`,
    worstRestore <= 1,
  );
  if (worstRestore > 1) {
    console.log(
      "  · 基线对比 ref=",
      JSON.stringify(refBaselines),
      " afterUndo=",
      JSON.stringify(afterUndo),
    );
  }

  // ③ 输入两个汉字
  await setCursor(anchorPos);
  before = await compileCount();
  await c.type("测试");
  await sleep(400);
  check(`编辑回放：输入两字后文本与夹具一致`, (await docText()) === states[2].doc);
  await waitMatched(before);
  check(`编辑回放：输入后命中真实夹具`, (await matched()) === true);

  // ④ 连按两次 Backspace → 回到原始
  before = await compileCount();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await sleep(400);
  check(`编辑回放：两次 Backspace 后文本恢复原样`, (await docText()) === states[0].doc);
  await waitMatched(before);

  // ⑤ 再按一次 Backspace（删掉原段末字符）
  before = await compileCount();
  await c.key("Backspace", { code: "Backspace", keyCode: 8 });
  await sleep(400);
  check(`编辑回放：Backspace 删字符后文本与夹具一致`, (await docText()) === states[3].doc);
  await waitMatched(before);
  check(`编辑回放：Backspace 后命中真实夹具`, (await matched()) === true);

  // ⑥ 撤销回原始
  before = await compileCount();
  for (let i = 0; i < 3 && (await docText()) !== states[0].doc; i++) {
    await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
    await sleep(300);
  }
  check(`编辑回放：撤销后回到原始文本`, (await docText()) === states[0].doc);
  await waitMatched(before);
  await setCursor(anchorPos);
  await warmUp(anchorPos);
  const finalBaselines = await measureLines(refLines);
  let worstFinal = 0;
  for (const n of Object.keys(refBaselines)) {
    if (finalBaselines[n] == null) continue;
    worstFinal = Math.max(worstFinal, Math.abs(finalBaselines[n] - refBaselines[n]));
  }
  check(
    `编辑回放：回放一圈后后续行基线不变（最大偏差 ${worstFinal.toFixed(2)}px）`,
    worstFinal <= 1,
  );

  // ⑦ 含单 LF 的段落（编辑器里走切片）：聚焦要**揭示成源码**、行数正确、不误改文本；
  //    再回放 Enter 分段与 Shift+Enter（`\` + 换行）两种输入。
  // M 就是 A（同一篇原文），直接用第一个状态；Enter/Shift+Enter 各备一份规范夹具
  const ml = states[0];
  const mlEnterVariants = [states[4]];
  const mlSoftVariants = [states[5]];
  if (replay.anchor2 > 0 && ml && mlEnterVariants.every(Boolean) && mlSoftVariants.every(Boolean)) {
    const mlPos = byteToPos(ml.doc, replay.anchor2);
    // 段落边界直接从 M 态夹具的块表取（比按换行回溯稳）：段末 == anchor2 的那个可编辑段
    // 注意：这一块含 `#{…}` 公式插值，是**复杂块**（走切片），不能用 directlyEditable 过滤；
    // 回放要验证的正是"聚焦把切片揭示成源码"，与它是不是纯文本无关。
    const mlBlock = ml.blocks.find((b) => b.end === replay.anchor2 && b.kind === "Paragraph");
    const mlFrom = mlBlock ? byteToPos(ml.doc, mlBlock.start) : 0;
    const srcLines = ml.doc.slice(mlFrom, mlPos).split("\n");
    const focusPos = mlFrom + 2;
    before = await compileCount();
    await setDoc(ml.doc);
    await waitMatched(before);
    // 聚焦到段落内部：只改选区，不应触发重编译，也不应改文本
    const docBeforeFocus = await docText();
    const countAfterLoad = await compileCount();
    await setCursor(focusPos);
    await sleep(300);
    const afterFocus = await c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      const doc = view.state.doc;
      const from = ${focusPos};
      const line = doc.lineAt(from);
      let lines = 0;
      for (let n = line.number; n <= doc.lines; n++) {
        const t = doc.line(n).text;
        if (t.trim() === '') break;
        lines++;
      }
      return { docLen: view.state.doc.length, sel: view.state.selection.main.head, lines };
    })()`);
    check(
      `编辑回放：聚焦单 LF 段落只改选区、不改文本（长度 ${afterFocus.docLen}，光标 ${afterFocus.sel}）`,
      (await docText()) === docBeforeFocus && afterFocus.sel === focusPos,
    );
    check(
      `编辑回放：聚焦后源码行数 = 段落源码行数（${afterFocus.lines} / ${srcLines.length}）`,
      afterFocus.lines === srcLines.length,
    );
    check(
      `编辑回放：聚焦不触发重编译（选区事务；${countAfterLoad} → ${await compileCount()}）`,
      (await compileCount()) === countAfterLoad,
    );

    // Enter：段末分段
    before = await compileCount();
    const caretBefore = await setCursor(mlPos);
    console.log(
      `  · 单 LF 段落：mlFrom=${mlFrom} mlPos=${mlPos} 段落源码行数=${srcLines.length} 落点=${caretBefore}`,
    );
    await c.key("Enter", { code: "Enter", keyCode: 13 });
    await sleep(400);
    const mlAfterEnter = await docText();
    const enterHit = mlEnterVariants.find((v) => v.doc === mlAfterEnter);
    // 夹具覆盖两种规范结果（复用行尾换行 / 插入分段）；编辑器在这个位置还可能多带一个缩进，
    // 那种变体没有逐字夹具，所以这里退一步断言**语义**：只在锚点之后动了换行、文本没被改，
    // 并且确实重新编译过（不会静默显示假切片）。
    const enterSamePrefix = mlAfterEnter.startsWith(ml.doc.slice(0, mlPos));
    const enterNewlines =
      (mlAfterEnter.match(/\n/g) ?? []).length - (ml.doc.match(/\n/g) ?? []).length;
    check(
      `编辑回放：单 LF 段落段末 Enter 产生分段（${ml.doc.length} → ${mlAfterEnter.length} 字符，换行 +${enterNewlines}${enterHit ? `，命中「${enterHit.name}」` : "，非规范变体"}）`,
      enterHit ? true : enterSamePrefix && (enterNewlines === 1 || enterNewlines === 2),
    );
    await waitRecompiled(before);
    check(
      `编辑回放：单 LF 段落 Enter 后重新编译（不静默用假切片）`,
      (await compileCount()) > before,
    );
    // 撤销回原始
    before = await compileCount();
    for (let i = 0; i < 3 && (await docText()) !== ml.doc; i++) {
      await c.key("z", { code: "KeyZ", keyCode: 90, modifiers: 2 });
      await sleep(250);
    }
    await waitMatched(before);
    check(`编辑回放：撤销回单 LF 段落原文`, (await docText()) === ml.doc);

    // Shift+Enter：写 `\` + 换行
    before = await compileCount();
    await setCursor(mlPos);
    await c.key("Enter", { code: "Enter", keyCode: 13, modifiers: 8 });
    await sleep(400);
    const mlAfterSoft = await docText();
    const softHit = mlSoftVariants.find((v) => v.doc === mlAfterSoft);
    const softSamePrefix = mlAfterSoft.startsWith(ml.doc.slice(0, mlPos));
    const softBackslashes =
      (mlAfterSoft.match(/\\/g) ?? []).length - (ml.doc.match(/\\/g) ?? []).length;
    check(
      `编辑回放：单 LF 段落 Shift+Enter 写显式换行（${ml.doc.length} → ${mlAfterSoft.length} 字符，反斜线 +${softBackslashes}${softHit ? `，命中「${softHit.name}」` : "，非规范变体"}）`,
      softHit ? true : softSamePrefix && softBackslashes === 1,
    );
    await waitRecompiled(before);
    check(
      `编辑回放：单 LF 段落 Shift+Enter 后重新编译（不静默用假切片）`,
      (await compileCount()) > before,
    );
  }

  await c.screenshot(SHOT("pku-writing-replay"));
}

for (const fx of fixtures) {
  // 只跑编辑回放（调试用）：跳过逐块测量阶段
  if (process.env.PKU_REPLAY_ONLY === "1") break;
  console.log(`\n=== ${fx.name}（${fx.blocks.length} 块 / ${fx.pages ?? "?"} 页）`);
  // 浏览器要按**文档真实列宽**排版：文档自带 `#set page(...)` 时注入的列宽不是它实际用的宽度，
  // 按注入列宽排版会让断行位置与夹具里的锚点完全对不上（见 Rust 侧 pku_true_content_pt）。
  const docColumnPt = fx.contentWidthPt;
  // 列宽用**精确**的 pt→px 换算（4/3），不要取整：整 px 会让"列宽/版心"这个比例与
  // 正文的字号比例（docTextPt × 4/3）不一致，纵向比较时每 1000px 就偏 ~0.6px。
  const docColumnPx = (docColumnPt * 4) / 3;
  const comparable = true;
  if (fx.ownPage) {
    console.log(
      `  文档自带 #set page：真实列宽 ${docColumnPt.toFixed(2)}pt（注入 ${fx.injectedContentPt}pt）${
        fx.parLeading !== 0.65 ? `；#set par(leading: ${fx.parLeading}em)` : ""
      }`,
    );
  }
  const { fixture: injected, replaced } = slimFixture(fx);
  const injectedBytes = JSON.stringify([injected]).length + JSON.stringify(fx.math ?? []).length;
  console.log(
    `  夹具注入：${(injectedBytes / 1024 / 1024).toFixed(2)}MB（大切片占位 ${replaced} 张）`,
  );

  await boot(c, BLOCKS_URL, {
    blockFixtures: [injected],
    mathFixtures: fx.math ?? [],
    runtime: process.env.PKU_CONSOLE === "1",
    settleMs: 900,
  });

  // 把编辑列宽钉到文档真实列宽：否则断行位置不同，"行数一致"根本无从谈起。
  // 直接钉 `.cm-content` 的宽度（页面侧读的就是 contentDOM.clientWidth）——比改 pane-body
  // 限宽稳：窗口宽度、留白、滚动条槽位的组合会让 pane-body 那条路量不准（实测落在 646px）。
  const applyWidth = (px) =>
    c.evaluate(`(() => {
      let s = document.getElementById('pku-writing-column');
      if (!s) { s = document.createElement('style'); s.id = 'pku-writing-column'; document.head.appendChild(s); }
      s.textContent = [
        '.editor-host.write .cm-scroller { scrollbar-gutter: auto !important; }',
        '.editor-host .cm-scroller::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
        '.editor-host.write .cm-content { width: ${px}px !important; min-width: ${px}px !important; max-width: ${px}px !important; }',
      ].join('\\n');
      return document.querySelector('.cm-content')?.clientWidth ?? 0;
    })()`);
  let widthPx = docColumnPx;
  await applyWidth(widthPx);
  await sleep(350);
  let columnPx = await c.evaluate(`document.querySelector('.cm-content').clientWidth`);
  for (let i = 0; i < 5 && Math.abs(columnPx - docColumnPx) > 0.6; i++) {
    widthPx += docColumnPx - columnPx;
    columnPx = await applyWidth(widthPx);
    await sleep(300);
  }
  check(
    `${fx.name}：编辑列宽 = 文档真实列宽（${columnPx}px ≈ ${(columnPx * 0.75).toFixed(2)}pt，期望 ${docColumnPx}px/${docColumnPt.toFixed(2)}pt）`,
    Math.abs(columnPx - docColumnPx) <= 1.5,
    `contentWidth=${widthPx}px`,
  );

  // 全部"非可直接编辑"的块都应该有切片；光标所在的那一块会被展开成源码（装饰设计如此），
  // 所以命中集合要按**实际光标位置**排除那一块，而不是假设"最后一块"（整篇替换后光标
  // 落到哪一块取决于末尾是不是复杂块，实测数分周一就多出一张）。
  const complexCrops = fx.blocks
    .filter((b) => b.found && !directlyEditable(fx.doc, b))
    .map((b) => ({ at: byteToPos(fx.doc, b.start), end: byteToPos(fx.doc, b.end) }));
  let expectedCrops = complexCrops.map((c) => c.at);

  // 实验（`PKU_NO_EMPH=1`）：把强调/粗体的字形变化关掉（`font-style: normal`），
  // 用来验证"浏览器多折一行"是不是斜体/粗体让 CJK 落到别的字体、前进宽度变大。
  if (process.env.PKU_NO_EMPH === "1") {
    await c.evaluate(`(() => {
      let s = document.getElementById('pku-no-emph');
      if (!s) { s = document.createElement('style'); s.id = 'pku-no-emph'; document.head.appendChild(s); }
      s.textContent = '.editor-host.write .cm-markup-emph { font-style: normal !important; }' +
        '.editor-host.write .cm-markup-strong { font-weight: normal !important; }';
      return true;
    })()`);
  }

  // 实验（`PKU_NO_LETTER_SPACING=1`）：关掉 CJK 前进宽度补偿（保留 geometricPrecision），
  // 用来判断"补偿是不是过量"（若 geometricPrecision 已经让 advance 回到 1em，再减 0.333px 就偏窄）。
  if (process.env.PKU_NO_LETTER_SPACING === "1") {
    await c.evaluate(`(() => {
      let s = document.getElementById('pku-no-ls');
      if (!s) { s = document.createElement('style'); s.id = 'pku-no-ls'; document.head.appendChild(s); }
      s.textContent = '.editor-host.write .cm-content { letter-spacing: normal !important; }';
      return true;
    })()`);
  }

  // 实验（`PKU_NO_PARBREAK=1`）：把分段空行的高度压到 0。
  // 动机：Typst 的段距已经算在相邻块的**带高**里，编辑器再给空行留 3px 就是重复计高——
  // P0 有 112 个空行 × 3.05px ≈ 342px，与"落位 − 带高和"量到的 ~390px 同量级。
  if (process.env.PKU_NO_PARBREAK === "1") {
    await c.evaluate(`(() => {
      let s = document.getElementById('pku-no-parbreak');
      if (!s) { s = document.createElement('style'); s.id = 'pku-no-parbreak'; document.head.appendChild(s); }
      s.textContent = '.editor-host.write .cm-write-parbreak { line-height: 0px !important; }';
      return true;
    })()`);
  }

  // 打进文档（桩按文档原文命中夹具）。**点编辑区中心**而不是固定坐标：这一套把列宽钉窄之后
  // 编辑区是居中的，固定 (400,300) 可能落在纸外 → 焦点没进编辑器、输入落空（首篇实测踩过）。
  //
  // 输入要**重试**：整套的第一篇在冷启动后偶发"块表停在半途的旧编译"——文档已经输入完整，
  // 但切片一张都没出来（首篇单跑正常、跟在别的文档后面时才会出现）。这里按"编辑器文本长度 +
  // 切片张数"判定，没到位就再全选重打一遍（最多 3 次），不让偶发时序变成假红/假绿。
  await c.evaluate(`document.fonts.ready.then(() => document.fonts.status)`);
  await c.evaluate(`window.__browserDevMathHits = { real: 0, fake: 0 }`);
  await c.evaluate(`window.__browserDevMathFake = []`);
  const wantedLen = fx.doc.length;
  let cropsNow = 0;
  let lenNow = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // **用 CodeMirror 事务整篇替换**，不走鼠标全选 + `Input.insertText`：
    //   * 编辑区可能被上一轮滚过，`.cm-content` 的 rect.top 在视口上方 → 按它算的点击点落在纸外；
    //   * `Input.insertText` 期间若有编译结果落地（remap/selection 重置），替换会变成部分追加
    //     （实测全量跑时高代周一那篇被写成 4957/3969 字符，夹具命中失败、所有切片消失）。
    // 这一套验的是**几何**，输入路径由既有套件与回放覆盖；这里要的是确定状态。
    await c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      view.focus();
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(fx.doc)} } });
      return view.state.doc.length;
    })()`);
    await sleep(900);
    lenNow = await c.evaluate(
      `document.querySelector('.cm-content').cmTile.root.view.state.doc.length`,
    );
    cropsNow = await c.evaluate(`document.querySelectorAll('.cm-block-crop').length`);
    if (lenNow === wantedLen && cropsNow >= expectedCrops.length) break;
    console.log(
      `  · 第 ${attempt} 次输入后：文本长度 ${lenNow}/${wantedLen}、切片 ${cropsNow}/${expectedCrops.length}，重试`,
    );
    await sleep(700);
  }
  await c.waitFor(`(window.__browserDevCallCounts?.compile_blocks ?? 0) > 0`, { timeout: 30000 });
  await sleep(400);
  // 等切片落地；到点还不够就**改一下列宽再改回来**，强制触发一次 `reflow` 重编译
  // （版心宽是编译期输入，改它一定会 requestNow）。仅靠 sleep 会出现"文档已完整、块表却停在
  // 半途旧编译"的偶发窗口，实测在首篇/最长篇上出现过（那时量到的几何全是假的）。
  const cropsOf = () => c.evaluate(`document.querySelectorAll('.cm-block-crop').length`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    cropsNow = await cropsOf();
    if (cropsNow >= expectedCrops.length) break;
    console.log(`  · 切片 ${cropsNow}/${expectedCrops.length}，第 ${attempt} 次改列宽强制重编译`);
    await applyWidth(widthPx + 3);
    await sleep(900);
    await applyWidth(widthPx);
    await sleep(1200);
  }
  columnPx = await c.evaluate(`document.querySelector('.cm-content').clientWidth`);
  await sleep(600);
  // 实验：Chromium 默认会把字形 advance 取整（14.667px 的 CJK 前进宽度被量成 15.00px，宽 2.3%），
  // 临界行因此比 Typst 早折一行。`text-rendering: geometricPrecision` 关掉取整，前进宽度回到
  // 分数值。`PKU_TEXT_RENDERING=1` 打开它做对照。
  if (process.env.PKU_TEXT_RENDERING === "1") {
    // 差值 = 字体栈量到的 CJK advance(15.00px) − 字号(14.667px)；Typst 的 CJK advance 是 1em。
    const ls = process.env.PKU_LETTER_SPACING;
    const extra = ls ? ` letter-spacing: ${ls}px !important;` : "";
    await c.evaluate(`(() => {
      let s = document.getElementById('pku-text-rendering');
      if (!s) { s = document.createElement('style'); s.id = 'pku-text-rendering'; document.head.appendChild(s); }
      s.textContent = '.editor-host.write .cm-content { text-rendering: geometricPrecision !important;' +
        ${JSON.stringify(extra)} + ' }';
      return true;
    })()`);
    await sleep(400);
  }
  // **实验开关**（`PKU_LINE_SPACING=1`）：把编辑器行高换成夹具量出来的文档真实行距，
  // 验证"行高跟文档走"能不能把纵向偏差压下去，而不是先把产品改了再重定一堆场景基线。
  let lineSpacingPx = null;
  let blankRowPx = null;
  if (process.env.PKU_LINE_SPACING === "1" && fx.lineSpacingPt) {
    const ratio = fx.lineSpacingPt / fx.textPt;
    // 段距 = 真实段距 − 真实行距（编辑器里两段的距离 = 段落的行盒 + 空白行）。
    // 这里直接给 `.cm-write-parbreak` 一个 pixel 行高（>1 个空行的 gap 会偏大，实验里可接受；
    // 产品实现要走每行 `count` 均分）。
    const blankEm = fx.parGapPt ? (fx.parGapPt - fx.lineSpacingPt) / fx.textPt : 0.208;
    blankRowPx = (blankEm * fx.textPt * 4) / 3;
    await c.evaluate(`(() => {
      let s = document.getElementById('pku-line-spacing');
      if (!s) { s = document.createElement('style'); s.id = 'pku-line-spacing'; document.head.appendChild(s); }
      const rules = [
        '.editor-host.write .cm-content { line-height: ${ratio} !important; }',
        '.editor-host.write .cm-markup-heading-1, .editor-host.write .cm-markup-heading-2,' +
          '.editor-host.write .cm-markup-heading-3, .editor-host.write .cm-markup-heading-4,' +
          '.editor-host.write .cm-markup-heading-5, .editor-host.write .cm-markup-heading-6' +
          ' { line-height: ${ratio} !important; }',
      ];
      // PKU_PARBREAK=0：只换行高、空白行仍用编辑器默认的 0.208em（分离两个变量的作用）
      if (${JSON.stringify(process.env.PKU_PARBREAK ?? "1")} !== '0') {
        rules.push('.editor-host.write .cm-write-parbreak { line-height: ${blankRowPx}px !important; }');
      }
      s.textContent = rules.join('\\n');
      return true;
    })()`);
    await sleep(900);
    lineSpacingPx = await c.evaluate(
      `parseFloat(getComputedStyle(document.querySelector('.cm-content')).lineHeight)`,
    );
    console.log(
      `  · 行高实验：真实行距 ${fx.lineSpacingPt}pt / 段距 ${fx.parGapPt ?? "?"}pt → 行高 ${lineSpacingPx.toFixed(2)}px、空白行 ${blankRowPx.toFixed(2)}px（比例 ${ratio.toFixed(3)}）`,
    );
  }
  check(
    `${fx.name}：作业原文已完整输入编辑器（${lenNow}/${wantedLen} 字符）`,
    lenNow === wantedLen,
  );
  const mathHits = await c.evaluate(`window.__browserDevMathHits ?? { real: 0, fake: 0 }`);
  const mathFake = await c.evaluate(`window.__browserDevMathFake ?? []`);
  check(
    `${fx.name}：行内/行间公式全部命中真实产物（真 ${mathHits.real} / 假 ${mathHits.fake}）`,
    mathHits.fake === 0 && mathHits.real > 0,
    mathFake
      .slice(0, 6)
      .map((r) => `${r.display ? "D" : "I"}@${r.sizePt} ${JSON.stringify(r.body).slice(0, 48)}`)
      .join(" | ") + `（夹具里 ${(fx.math ?? []).length} 个公式产物）`,
  );

  const fontSize = await c.evaluate(
    `parseFloat(getComputedStyle(document.querySelector('.cm-content')).fontSize)`,
  );
  const lineHeightPx = await c.evaluate(
    `parseFloat(getComputedStyle(document.querySelector('.cm-content')).lineHeight)`,
  );
  check(
    `${fx.name}：写作模式正文字号 = 文档字号（${fontSize}px ≈ ${(fontSize * 0.75).toFixed(2)}pt，期望 ${(fx.textPt * 4) / 3}px）`,
    Math.abs(fontSize - (fx.textPt * 4) / 3) <= 1,
  );

  // **字体度量**：断行位置由字体决定，字体没装上或回退到别的族时，正文每行能容的字数会变，
  // 沿全文累计成几百上千 px —— 这时调纵向间距是白调（见 docs/development/writing-rendering.md）。
  // 这里量一个 CJK 字的前进宽度：与字号同量级 = 引擎用的那套字生效了。
  const metric = await c.evaluate(`(() => {
    const content = document.querySelector('.cm-content');
    const cs = getComputedStyle(content);
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:' +
      cs.fontFamily + ';font-size:' + cs.fontSize + ';line-height:' + cs.lineHeight +
      ';letter-spacing:' + cs.letterSpacing;
    span.textContent = '字'.repeat(40);
    document.body.appendChild(span);
    const w = span.getBoundingClientRect().width;
    span.remove();
    // 逐族量同一个 CJK 字的前进宽度：判断 15.00px 是"字体本身的 advance"还是"栈里回退到了别的族"
    const families = ['Libertinus Serif', 'Noto Serif CJK SC', 'SimSun', 'Songti SC', 'serif'];
    const perFamily = {};
    for (const fam of families) {
      const c2 = document.createElement('canvas').getContext('2d');
      c2.font = cs.fontSize + ' ' + JSON.stringify(fam);
      // 回读 ctx.font：赋值解析失败时会保持上一个字体，量出来的宽度就不是这一族的
      perFamily[fam] = { w: +(c2.measureText('字').width.toFixed(3)), readback: c2.font, asc: +(c2.measureText('字Hg').fontBoundingBoxAscent ?? -1).toFixed(2) };
    }
    return {
      advance: w / 40,
      fontSize: parseFloat(cs.fontSize),
      family: cs.fontFamily,
      status: document.fonts.status,
      hasLibertinus: document.fonts.check('14px "Libertinus Serif"'),
      hasNoto: document.fonts.check('14px "Noto Serif CJK SC"'),
      perFamily,
      letterSpacing: cs.letterSpacing,
    };
  })()`);
  // **有效前进宽度**（含 letter-spacing）应等于字号（Typst 的 CJK advance = 1em）；
  // 字体没装上或补偿没生效时，浏览器会宽 ~2.3%，临界行比引擎早折一行。
  check(
    `${fx.name}：正文 CJK 有效前进宽度 = 字号（${metric.advance.toFixed(3)}px / ${metric.fontSize}px，letter-spacing=${metric.letterSpacing}；Libertinus=${metric.hasLibertinus} 思源宋体=${metric.hasNoto}）`,
    metric.hasLibertinus === true &&
      metric.hasNoto === true &&
      Math.abs(metric.advance - metric.fontSize) <= 0.6,
    JSON.stringify({ family: metric.family, status: metric.status, perFamily: metric.perFamily }),
  );
  console.log(
    `  · CJK 前进宽度：字体栈 ${metric.advance.toFixed(3)}px / 各族 ${JSON.stringify(metric.perFamily)}`,
  );

  // 段距压缩到底有没有生效：`scanParagraphGapRows` 会给普通段落间的空白行挂
  // `.cm-write-parbreak`（高度 0.208em）。数量为 0 = 整篇的空白行都按整行高排
  // （真实作业上量到过：段落之间多出近一行）。仅记录，便于把纵向偏差归因。
  const parbreak = await c.evaluate(`(() => {
    const els = Array.from(document.querySelectorAll('.cm-line.cm-write-parbreak'));
    let total = 0;
    for (const e of els) total += e.getBoundingClientRect().height;
    const one = els[0] ? parseFloat(getComputedStyle(els[0]).lineHeight) : null;
    return { count: els.length, totalHeight: total, firstLineHeight: one };
  })()`);
  console.log(
    `  · 段距压缩行：${parbreak.count} 行，合计 ${parbreak.totalHeight.toFixed(0)}px（单行 ${parbreak.firstLineHeight ?? "-"}px）`,
  );

  // 逐块滚动 + 取 DOM 实测：**不做整页展开**（把 scroller 撑开会打乱 CodeMirror 的高度图，
  // 实测所有切片会被量到同一个 top、行数变 0）。走一遍"先滚一遍让 CM 量完所有 widget、
  // 再滚一遍取数"的两趟扫掠；每块都在视口内量，坐标用文档坐标系（= 视口 y + scrollTop）。
  const specs = fx.blocks.map((b) => ({
    from: byteToPos(fx.doc, b.start),
    to: byteToPos(fx.doc, b.end),
    kind: b.kind,
    found: b.found,
    skipped: b.skipped,
    yPt: b.yPt,
    heightPt: b.heightPt,
    anchorYpt: b.anchorYpt,
    anchorBaselinePt: b.anchorBaselinePt,
    expectCrop: b.found && !directlyEditable(fx.doc, b),
  }));
  const scrollTo = (from) =>
    c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      const top = view.lineBlockAt(${from}).top;
      view.scrollDOM.scrollTop = Math.max(0, top - 260);
      return view.scrollDOM.scrollTop;
    })()`);
  // 逐块量**以 DOM 为准**（`getBoundingClientRect` + `posAtDOM` 校验 + scrollTop 换算文档坐标）：
  //   * `lineBlockAt`/`coordsAtPos` 走的是 CodeMirror 的高度图，实测在长文档里会给出明显偏离 DOM
  //     的值（一行标题被算成 278px、位置差 206px），纵向对账当场失真；
  //   * `domAtPos` 对视口外的行会退回相邻已渲染行，所以这里改成**扫描已渲染的 `.cm-line` 并按
  //     `posAtDOM` 精确匹配目标行**，找不到就用 ±400px 的滚动增量找（文本行都是 DOM 实测）。
  const measureOne = (s) =>
    c.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const view = content.cmTile.root.view;
      const scroller = view.scrollDOM;
      const baseLine = view.defaultLineHeight || 1;
      // 文档坐标 = 元素视口顶端 − content 顶端 − content 的 padding-top。
      // **不用 scrollTop**：scrollTo 之后 CodeMirror 可能还在做滚动锚定，读到的 scrollTop 与
      // DOM 矩形不同步（实测同一个 cm-line 会算出偏差 200px 的文档坐标）。
      // content 的矩形与元素矩形同在视口坐标系、同一次读取，差值天然与滚动无关。
      const padTop = parseFloat(getComputedStyle(content).paddingTop) || 0;
      const docTopOf = (el) =>
        el.getBoundingClientRect().top - content.getBoundingClientRect().top - padTop;
      // 切片：按块起点直接找（视口内才会渲染）
      let cropEl = document.querySelector('.cm-block-crop[data-block-from="${s.from}"]');
      for (let attempt = 0; cropEl === null && ${s.expectCrop ? 1 : 0} && attempt < 5; attempt++) {
        const delta = attempt % 2 === 0 ? 420 : -840;
        try { scroller.scrollTop = Math.max(0, scroller.scrollTop + delta); } catch (e) { /* ignore */ }
        cropEl = document.querySelector('.cm-block-crop[data-block-from="${s.from}"]');
      }
      if (cropEl) {
        const baselineOffset = ${s.anchorBaselinePt == null ? "null" : `(${s.anchorBaselinePt} - ${s.yPt}) * (content.clientWidth / ${docColumnPt})`};
        const anchorOffset = ${s.anchorYpt == null ? "null" : `(${s.anchorYpt} - ${s.yPt}) * (content.clientWidth / ${docColumnPt})`};
        const top = docTopOf(cropEl);
        return {
          from: ${s.from}, mode: 'crop', top, height: cropEl.getBoundingClientRect().height,
          anchor: anchorOffset == null ? null : top + anchorOffset,
          baseline: baselineOffset == null ? null : top + baselineOffset,
        };
      }
      let line, lastLineNo;
      try {
        line = view.state.doc.lineAt(${s.from});
        lastLineNo = view.state.doc.lineAt(${Math.max(s.from, s.to - 1)}).number;
      } catch (e) { return { from: ${s.from}, mode: 'missing' }; }
      const findLineEl = (from) => {
        for (const el of document.querySelectorAll('.cm-line')) {
          let p = -1;
          try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
          if (p === from) return el;
        }
        return null;
      };
      let el = findLineEl(line.from);
      for (let attempt = 0; el === null && attempt < 5; attempt++) {
        const delta = attempt % 2 === 0 ? 420 : -840;
        try { scroller.scrollTop = Math.max(0, scroller.scrollTop + delta); } catch (e) { /* ignore */ }
        el = findLineEl(line.from);
      }
      if (!el) return { from: ${s.from}, mode: 'offscreen' };
      const top = docTopOf(el);
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || baseLine;
      const ctx = document.createElement('canvas').getContext('2d');
      // 同 measureOne：用画汉字的那个族量基线度量
      ctx.font = cs.fontSize + ' "Noto Serif CJK SC"';
      const tm = ctx.measureText('字Hg');
      const asc = tm.fontBoundingBoxAscent || tm.actualBoundingBoxAscent || 0;
      const desc = tm.fontBoundingBoxDescent || tm.actualBoundingBoxDescent || 0;
      const baseline = top + (lh - (asc + desc)) / 2 + asc;
      let rows = 0, height = 0, rendered = 0;
      for (let n = line.number; n <= lastLineNo; n++) {
        const L = view.state.doc.line(n);
        const e2 = findLineEl(L.from);
        if (e2) {
          const h = e2.getBoundingClientRect().height;
          const l2 = parseFloat(getComputedStyle(e2).lineHeight) || baseLine;
          height += h;
          rows += Math.max(1, Math.round(h / l2));
          rendered++;
        } else {
          const b = view.lineBlockAt(L.from);
          height += b.height;
          rows += Math.max(1, Math.round(b.height / baseLine));
        }
      }
      return {
        from: ${s.from}, mode: 'text', top, height, anchor: top, baseline, rows,
        dom: { cls: String(el.className), h: Math.round(el.getBoundingClientRect().height), rendered },
      };
    })()`);
  for (const s of specs) {
    if (!s.found) continue;
    await scrollTo(s.from);
    await sleep(25);
  }
  const measuredResults = [];
  for (const s of specs) {
    if (!s.found) continue;
    await scrollTo(s.from);
    await sleep(35);
    measuredResults.push(await measureOne(s));
  }
  const domCrops = measuredResults.filter((r) => r.mode === "crop").map((r) => r.from);

  // 纵向 pt→px 一律用 CSS 的 4/3：字号的 px 值就是 docTextPt × 4/3 算出来的，
  // 再用"实测列宽/版心"当比例会引入 0.06% 的系统偏差（长页面累计到几个像素）。
  const measured = { columnPx, factor: 4 / 3, results: measuredResults };
  const byFrom = new Map(measured.results.map((r) => [r.from, r]));
  const rows = [];
  for (const b of fx.blocks) {
    const pos = byteToPos(fx.doc, b.start);
    const m = byFrom.get(pos);
    const typstLines = b.lineCount ?? typstLineCount(b, fx.textPt, fx.parLeading ?? 0.65);
    const item = {
      start: b.start,
      end: b.end,
      line: fx.doc.slice(0, byteToPos(fx.doc, b.start)).split("\n").length,
      endLine: fx.doc.slice(0, byteToPos(fx.doc, b.end)).split("\n").length,
      kind: b.kind,
      page: b.page,
      found: b.found,
      skipped: b.skipped,
      mode: m?.mode ?? "absent",
      typstAnchorPt: b.anchorYpt,
      browserAnchorPx: m?.anchor ?? null,
      typstBaseline: b.anchorBaselinePt ?? null,
      browserBaselinePx: m?.baseline ?? null,
      typstBandTopPt: b.yPt,
      typstHeightPt: b.heightPt,
      browserHeightPx: m?.height ?? null,
      typstLines,
      browserRows: m?.rows ?? null,
      dom: m?.dom ?? null,
      excerpt: fx.doc.slice(byteToPos(fx.doc, b.start), byteToPos(fx.doc, b.end)).slice(0, 40),
    };
    rows.push(item);
  }

  const factor = measured.factor;
  // 锚点对账：只在"有真实锚点 + 量到了 + 同页"的块之间比，按源码顺序
  // 对账用**首行主基线**（`anchorBaselinePt` ↔ 浏览器行盒算出的基线）：含义一致、
  // 不受半 leading 与首字形高低影响；拿不到基线（少见）才退回墨迹顶/行盒顶。
  const anchorOf = (r) => ({
    t: r.typstBaseline ?? r.typstAnchorPt,
    b: r.browserBaselinePx ?? r.browserAnchorPx,
  });
  const anchored = rows.filter((r) => r.found && anchorOf(r).t != null && anchorOf(r).b != null);
  const missingMeasured = rows.filter(
    (r) => r.found && anchorOf(r).t != null && anchorOf(r).b == null,
  );
  check(
    `${fx.name}：每个有几何的块都量到了锚点（缺 ${missingMeasured.length}）`,
    missingMeasured.length === 0,
    JSON.stringify(missingMeasured.slice(0, 5).map((r) => [r.line, r.kind, r.excerpt])),
  );

  // 相邻块误差 + 页内累计误差（都以"本页第一个有效锚点"为原点，常量偏置自动抵消）
  const perPage = new Map();
  for (const r of anchored) {
    if (!perPage.has(r.page)) perPage.set(r.page, []);
    perPage.get(r.page).push(r);
  }
  const adjFails = [];
  const cumFails = [];
  for (const [page, list] of perPage) {
    list.sort((a, b) => a.start - b.start);
    const t0 = anchorOf(list[0]).t;
    const b0 = anchorOf(list[0]).b;
    let prevErr = 0;
    for (let i = 1; i < list.length; i++) {
      const r = list[i];
      const typstRel = (anchorOf(r).t - t0) * factor;
      const browserRel = anchorOf(r).b - b0;
      const err = browserRel - typstRel;
      r.cumErrorPx = err;
      const adj = Math.abs(err - prevErr);
      r.adjErrorPx = adj;
      prevErr = err;
      if (adj > 2) adjFails.push(r);
      if (Math.abs(err) > 5) cumFails.push(r);
    }
    list[0].adjErrorPx = 0;
    list[0].cumErrorPx = 0;
  }
  const fmtFails = (list) =>
    list
      .slice(0, 6)
      .map(
        (r) =>
          `L${r.line}(${r.kind} p${r.page}) Δ相邻=${r.adjErrorPx?.toFixed(1)} Δ累计=${r.cumErrorPx?.toFixed(1)}px :: ${r.excerpt}`,
      )
      .join(" | ");
  check(
    `${fx.name}：同页相邻锚点偏差 ≤ 2px（越界 ${adjFails.length} 处）`,
    adjFails.length === 0,
    fmtFails(adjFails),
  );
  check(
    `${fx.name}：页内累计偏差 ≤ 5px（越界 ${cumFails.length} 处）`,
    cumFails.length === 0,
    fmtFails(cumFails),
  );

  if (process.env.PKU_DIAG === "1") {
    const worst = rows
      .filter((r) => r.mode === "text" && r.adjErrorPx != null)
      .sort((a, b) => b.adjErrorPx - a.adjErrorPx)[0];
    if (worst) {
      const diag = await c.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        const view = content.cmTile.root.view;
        const posOf = (e) => { try { return view.posAtDOM(e, 0); } catch (err) { return -1; } };
        const lines = Array.from(document.querySelectorAll('.cm-line'))
          .map((e) => ({ pos: posOf(e), cls: String(e.className), top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) }))
          .filter((x) => x.pos >= 0)
          .sort((a, b) => a.pos - b.pos);
        const crops = Array.from(document.querySelectorAll('.cm-block-crop'))
          .map((e) => ({ from: Number(e.dataset.blockFrom), top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) }));
        return { lines, crops };
      })()`);
      console.log(`  · DIAG 最大相邻偏差块 L${worst.line} from=${worst.start}:`);
      console.log("      lines:", JSON.stringify(diag.lines.slice(0, 40)));
      console.log("      crops:", JSON.stringify(diag.crops.slice(0, 20)));
    }
  }
  const cursorPos = await c.evaluate(
    `document.querySelector('.cm-content').cmTile.root.view.state.selection.main.head`,
  );
  const revealed = complexCrops.find((c) => cursorPos >= c.at && cursorPos <= c.end);
  expectedCrops = complexCrops.map((c) => c.at).filter((p) => p !== revealed?.at);
  check(
    `${fx.name}：切片集合与期望一致（DOM ${domCrops.length} / 期望 ${expectedCrops.length}）`,
    JSON.stringify(domCrops) === JSON.stringify(expectedCrops),
    JSON.stringify({
      missing: expectedCrops.filter((p) => !domCrops.includes(p)),
      extra: domCrops.filter((p) => !expectedCrops.includes(p)),
    }),
  );

  // ---- 逐块对账 ----
  // 普通段落视觉行数：**硬判据**（计划的首轮门槛之一）。
  // 行数 oracle = Rust 侧按实测行距的 0.75 倍聚类"主基线"（`lineCount`）；浏览器侧 = DOM 行盒高
  // ÷ 行高。编辑块现在都是单源码行（多源码行走切片），所以两边比的是同一件事：折行位置。
  const textRows = rows.filter(
    (r) => r.mode === "text" && r.found && r.typstLines > 0 && r.browserRows != null,
  );
  const rowFails = textRows.filter((r) => r.browserRows !== r.typstLines);
  // 诊断（`PKU_BREAK=1`）：对行数不一致的块，逐视觉行比"断点"——Typst 侧用夹具的
  // `lineSpans[].end`（该行最后一个字形的源字节），浏览器侧用 `visualLineAt().to`。
  // 第一个不同的断点就是"从哪个字开始折行不同"。
  if (process.env.PKU_BREAK === "1") {
    for (const r of rowFails.slice(0, 4)) {
      // 注意：`r.start` 是**字节**偏移（行对象直接来自夹具块），别再换算成 UTF-16 去比
      const b = fx.blocks.find((bb) => bb.start === r.start);
      const spans = b?.lineSpans ?? [];
      if (!spans.length) continue;
      const fromPos = byteToPos(fx.doc, r.start);
      const endPos = byteToPos(fx.doc, r.end);
      await c.evaluate(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view;
        v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(${fromPos}).top - 150);
        return true;
      })()`);
      await sleep(250);
      // 这个 CodeMirror 版本没有 `visualLineAt`；改用**逐字符的 coordsAtPos 看 y 何时增大**
      // 来还原浏览器的视觉行断点（块只有一两百字符，成本可忽略）。
      const visual = await c.evaluate(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view;
        const lines = [];
        let prevTop = null;
        for (let p = ${fromPos}; p < ${endPos}; p++) {
          let co = null;
          try { co = v.coordsAtPos(p); } catch (e) { co = null; }
          if (!co) continue;
          if (prevTop !== null && co.top > prevTop + 1) {
            lines.push({ to: p, head: v.state.sliceDoc(p, Math.min(p + 6, ${endPos})) });
          }
          prevTop = co.top;
        }
        lines.push({ to: ${endPos}, head: "" });
        return lines;
      })()`);
      const typstEnds = spans.map((sp) => byteToPos(fx.doc, sp.end));
      const browserEnds = visual.map((vl) => vl.to);
      let first = -1;
      for (let i = 0; i < Math.max(typstEnds.length, browserEnds.length); i++) {
        if (typstEnds[i] !== browserEnds[i]) {
          first = i;
          break;
        }
      }
      const around = (pos) => JSON.stringify(fx.doc.slice(Math.max(0, pos - 6), pos + 8));
      console.log(
        `  · BREAK L${r.line} typst 行数=${typstEnds.length} 浏览器=${browserEnds.length} 首个不同行=${first}` +
          (first >= 0
            ? ` typst 断在 ${typstEnds[first]} ${around(typstEnds[first])} / 浏览器 ${browserEnds[first]} ${around(browserEnds[first])}`
            : ""),
      );
    }
  }

  check(
    `${fx.name}：可编辑正文视觉行数 = Typst 行数（${textRows.length} 块中 ${rowFails.length} 块不一致）`,
    rowFails.length === 0,
    rowFails
      .slice(0, 8)
      .map(
        (r) =>
          `L${r.line}(${r.kind}) typst=${r.typstLines} browser=${r.browserRows} :: ${r.excerpt.slice(0, 24)}`,
      )
      .join(" | "),
  );

  if (process.env.PKU_MATH_WIDTH === "1") {
    const w = await c.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const view = content.cmTile.root.view;
      const out = [];
      for (const el of document.querySelectorAll('.cm-math-widget, .cm-math-block-inline')) {
        const r = el.getBoundingClientRect();
        const svg = el.querySelector('svg');
        const cs = getComputedStyle(el);
        out.push({
          x: +(r.width).toFixed(2),
          svgW: svg ? svg.getAttribute('width') : null,
          svgRectW: svg ? +svg.getBoundingClientRect().width.toFixed(2) : null,
          margin: cs.marginLeft + '/' + cs.marginRight,
          padding: cs.paddingLeft + '/' + cs.paddingRight,
          text: String(el.textContent ?? '').slice(0, 12),
        });
        if (out.length >= 10) break;
      }
      return out;
    })()`);
    console.log(`  · 行内公式 widget 宽度样本：${JSON.stringify(w)}`);
  }

  // 诊断（`PKU_PLACEMENT=1`，只跑第一篇）：同一批块用两种取法各量一次——
  //   A) 逐个滚进视口再量（主套件口径）；B) 滚到首块后一次性量全部。
  // 两者差多少 = CodeMirror 落位受滚动/测量状态影响的程度；再与"前面所有块带高之和"对账，
  // 用来区分"块高不对"和"落位机制不受块高控制"。
  if (process.env.PKU_PLACEMENT === "1") {
    const factor = columnPx / fx.contentWidthPt;
    const anchored = fx.blocks.filter((b) => b.found && typeof b.anchorYpt === "number");
    // 取**相邻偏差最大的前 10 块**（外加它们的前一块），比等距取样更能说明问题
    const worst = rows
      .filter((r) => r.found && r.adjErrorPx > 2)
      .sort((a, b) => b.adjErrorPx - a.adjErrorPx)
      .slice(0, 10);
    const wantStarts = new Set();
    for (const r of worst) {
      wantStarts.add(r.start);
      const i = anchored.findIndex((b) => b.start === r.start);
      if (i > 0) wantStarts.add(anchored[i - 1].start);
    }
    const picks = anchored.filter((b) => wantStarts.has(b.start));
    const posList = picks.map((b) => byteToPos(fx.doc, b.start));
    const measureAt = (positions) =>
      c.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        const view = content.cmTile.root.view;
        const padTop = parseFloat(getComputedStyle(content).paddingTop) || 0;
        const docTopOf = (el) => el.getBoundingClientRect().top - content.getBoundingClientRect().top - padTop;
        const positions = ${JSON.stringify(positions)};
        const out = [];
        for (const pos of positions) {
          let el = document.querySelector('.cm-block-crop[data-block-from="' + pos + '"]');
          if (!el) {
            for (const line of document.querySelectorAll('.cm-line')) {
              let p = -1;
              try { p = view.posAtDOM(line, 0); } catch (e) { continue; }
              if (p === pos) { el = line; break; }
            }
          }
          out.push(
            el
              ? {
                  top: +docTopOf(el).toFixed(2),
                  h: +el.getBoundingClientRect().height.toFixed(2),
                  lh: el.style.lineHeight || "",
                  cls: el.className,
                  headLh: el.querySelector('[class*="cm-markup-heading"]')
                    ? getComputedStyle(el.querySelector('[class*="cm-markup-heading"]')).lineHeight
                    : "",
                  fitVar: el.style.getPropertyValue("--heading-fit") || "",
                }
              : null,
          );
        }
        return out;
      })()`);
    console.log(
      `  · heading-fit 诊断：${JSON.stringify(await c.evaluate("window.__headingFitDiag ?? null"))}`,
    );
    console.log(
      `  · heading-fit DOM：${JSON.stringify(
        await c.evaluate(`(() => {
          const els = Array.from(document.querySelectorAll('.cm-heading-fit'));
          return {
            count: els.length,
            sample: els.slice(0, 4).map((el) => ({
              text: el.textContent.slice(0, 12),
              cls: el.className,
              varValue: el.style.getPropertyValue('--heading-fit'),
              headLh: (() => {
                const sp = el.querySelector('[class*="cm-markup-heading"]');
                return sp ? getComputedStyle(sp).lineHeight : null;
              })(),
              h: +el.getBoundingClientRect().height.toFixed(2),
            })),
          };
        })()`),
      )}`,
    );
    const gapInfo = await c.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.cm-write-parbreak'));
      const vals = {};
      for (const el of rows) {
        const v = getComputedStyle(el).getPropertyValue('--write-parbreak-height').trim() || '(空)';
        vals[v] = (vals[v] || 0) + 1;
      }
      return { rows: rows.length, vals };
    })()`);
    console.log(`  · 分段空行：${gapInfo.rows} 行，高度取值分布 ${JSON.stringify(gapInfo.vals)}`);
    const rowStats = await c.evaluate(`(() => {
      const lines = Array.from(document.querySelectorAll('.cm-line'));
      const hist = {};
      let blank = 0, blankPx = 0;
      for (const el of lines) {
        const h = +el.getBoundingClientRect().height.toFixed(1);
        hist[h] = (hist[h] || 0) + 1;
        if (el.textContent.trim() === '') { blank++; blankPx += h; }
      }
      const crops = Array.from(document.querySelectorAll('.cm-block-crop'));
      let cropPx = 0;
      for (const el of crops) cropPx += el.getBoundingClientRect().height;
      return { lines: lines.length, hist, blank, blankPx: +blankPx.toFixed(1), crops: crops.length, cropPx: +cropPx.toFixed(1), contentH: +document.querySelector('.cm-content').getBoundingClientRect().height.toFixed(1) };
    })()`);
    console.log(
      `  · DOM 行高分布（px→行数）：${JSON.stringify(rowStats.hist)}；空行 ${rowStats.blank} 行共 ${rowStats.blankPx}px；切片 ${rowStats.crops} 张共 ${rowStats.cropPx}px；内容高 ${rowStats.contentH}px`,
    );
    // 整篇扫一遍，收集**所有**未压缩空行（不只视口里的）
    const seen = new Map();
    for (const b of anchored) {
      const pos = byteToPos(fx.doc, b.start);
      const found = await c.evaluate(`(() => {
        const view = document.querySelector('.cm-content').cmTile.root.view;
        view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(${pos}).top - 260);
        const doc = view.state.doc;
        const out = [];
        for (const el of document.querySelectorAll('.cm-line')) {
          if (el.textContent.trim() !== '') continue;
          if (el.getBoundingClientRect().height < 8) continue;
          let p = -1;
          try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
          const n = doc.lineAt(p).number;
          let prev = '', next = '';
          for (let i = n - 1; i >= 1; i--) { const t = doc.line(i).text.trim(); if (t) { prev = 'L' + i + ':' + t.slice(0, 10); break; } }
          for (let i = n + 1; i <= doc.lines; i++) { const t = doc.line(i).text.trim(); if (t) { next = 'L' + i + ':' + t.slice(0, 10); break; } }
          out.push({ line: n, h: +el.getBoundingClientRect().height.toFixed(1), prev, next });
        }
        return out;
      })()`);
      for (const f of found) seen.set(f.line, f);
      await sleep(20);
    }
    const blanks = [...seen.values()].sort((a, b) => a.line - b.line);
    for (const b of blanks)
      console.log(`      · 未压缩空行 L${b.line} 高${b.h}px：上一行[${b.prev}] 下一行[${b.next}]`);
    console.log(
      `      · 全篇未压缩空行共 ${blanks.length} 行，合计 ${blanks.reduce((a, b) => a + b.h, 0).toFixed(0)}px`,
    );
    const oldBlanks = await c.evaluate(`(() => {
      const view = document.querySelector('.cm-content').cmTile.root.view;
      const doc = view.state.doc;
      const out = [];
      for (const el of document.querySelectorAll('.cm-line')) {
        if (el.textContent.trim() !== '') continue;
        const h = +el.getBoundingClientRect().height.toFixed(1);
        if (h < 8) continue; // 只列"没被压缩"的空行
        let p = -1;
        try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
        const n = doc.lineAt(p).number;
        let prev = '', next = '';
        for (let i = n - 1; i >= 1; i--) { const t = doc.line(i).text.trim(); if (t) { prev = 'L' + i + ' ' + t.slice(0, 14); break; } }
        for (let i = n + 1; i <= doc.lines; i++) { const t = doc.line(i).text.trim(); if (t) { next = 'L' + i + ' ' + t.slice(0, 14); break; } }
        out.push({ line: n, h, prev, next });
      }
      return out;
    })()`);
    void oldBlanks;
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(${posList[0]}).top - 120);
      return true;
    })()`);
    await sleep(200);
    const firstPickProbe = await c.evaluate(`(() => {
      const content = document.querySelector('.cm-content');
      const view = content.cmTile.root.view;
      let el = null;
      for (const line of document.querySelectorAll('.cm-line')) {
        let p = -1;
        try { p = view.posAtDOM(line, 0); } catch (e) { continue; }
        if (p === ${posList[0]}) { el = line; break; }
      }
      if (!el) return { missing: true };
      const spans = Array.from(el.querySelectorAll('span')).map((sp) => ({
        cls: sp.className,
        inline: sp.style.lineHeight || '',
        computed: getComputedStyle(sp).lineHeight,
      }));
      return { h: +el.getBoundingClientRect().height.toFixed(2), html: el.innerHTML.slice(0, 160), spans };
    })()`);
    console.log(`  · 首块（L33）标题探针：${JSON.stringify(firstPickProbe)}`);
    const headingProbe = await c.evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll('.cm-line')) {
        const span = el.querySelector('[class*="cm-markup-heading"]');
        if (!span) continue;
        out.push({
          text: el.textContent.slice(0, 10),
          spanClass: span.className,
          spanInline: span.style.lineHeight || '',
          spanComputed: getComputedStyle(span).lineHeight,
          lineInline: el.style.lineHeight || '',
          lineComputed: getComputedStyle(el).lineHeight,
          lineH: +el.getBoundingClientRect().height.toFixed(2),
        });
        if (out.length >= 3) break;
      }
      return out;
    })()`);
    console.log(`  · 标题行高探针：${JSON.stringify(headingProbe)}`);
    const topA = [];
    for (let i = 0; i < posList.length; i++) {
      await c.evaluate(`(() => {
        const v = document.querySelector('.cm-content').cmTile.root.view;
        v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(${posList[i]}).top - 120);
        return true;
      })()`);
      await sleep(120);
      topA.push((await measureAt([posList[i]]))[0]);
      if (picks[i].kind === "Heading" && process.env.PKU_PLACEMENT === "1") {
        const fitProbe = await c.evaluate(`(() => {
          const content = document.querySelector('.cm-content');
          const view = content.cmTile.root.view;
          const fits = Array.from(document.querySelectorAll('.cm-heading-fit'));
          const lines = Array.from(document.querySelectorAll('.cm-line'));
          const find = (pos) => {
            for (const el of lines) {
              let p = -1;
              try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
              if (p === pos) return el;
            }
            return null;
          };
          const target = find(${posList[i]});
          const first = fits[0];
          return {
            fits: fits.length,
            targetCls: target ? target.className : null,
            firstFitPos: first ? view.posAtDOM(first, 0) : null,
            firstFitText: first ? first.textContent.slice(0, 10) : null,
          };
        })()`);
        console.log(
          `      · fit 探针 L${picks[i] ? "" : ""}pos=${posList[i]} targetCls=${fitProbe.targetCls} fits=${fitProbe.fits} firstFitPos=${fitProbe.firstFitPos} firstFitText=${fitProbe.firstFitText}`,
        );
      }
    }
    await c.evaluate(`(() => {
      const v = document.querySelector('.cm-content').cmTile.root.view;
      v.scrollDOM.scrollTop = Math.max(0, v.lineBlockAt(${posList[0]}).top - 120);
      return true;
    })()`);
    await sleep(300);
    const topB = await measureAt(posList);
    // 前面所有块带高之和（pt → px），从第一个 pick 起算
    const first = anchored.indexOf(picks[0]);
    console.log(`\n=== 落位自检（${fx.name}，${picks.length} 块，factor=${factor.toFixed(3)}）`);
    picks.forEach((b, i) => {
      let sum = 0;
      for (let k = first; k < anchored.indexOf(b); k++) sum += anchored[k].heightPt;
      const bandPx = sum * factor;
      const line = fx.doc.slice(0, byteToPos(fx.doc, b.start)).split("\n").length;
      const a = topA[i];
      const b2 = topB[i];
      const bandOwn = b.heightPt * factor;
      console.log(
        `  L${line}(${b.kind}) 逐块量=${a ? a.top : null} DOM高=${a ? a.h : "?"} 自带高=${bandOwn.toFixed(1)} 差=${a ? (a.h - bandOwn).toFixed(1) : "?"}px 带高和=${bandPx.toFixed(1)}px 落位-带高和=${a && topA[0] ? (a.top - topA[0].top - bandPx).toFixed(1) : "?"}px cls=${a ? a.cls : "-"} headLh=${a ? a.headLh : "-"} fitVar=${a ? a.fitVar : "-"}`,
      );
    });
  }

  // 诊断（`PKU_WIDTH2=1`）：行数不一致的块里，行内公式 widget 的渲染宽 vs 夹具里的 Typst 宽度，
  // 用来判断"多折一行"是不是公式 widget 比引擎行内 advance 宽。
  if (process.env.PKU_WIDTH2 === "1") {
    for (const r of rowFails.slice(0, 6)) {
      const from = byteToPos(fx.doc, r.start);
      const to = byteToPos(fx.doc, r.end);
      const src = fx.doc.slice(from, to);
      const bodies = [...src.matchAll(/\$([^$]+)\$/g)].map((m) => m[1].trim());
      const byBody = new Map((fx.math ?? []).map((m) => [m.body, m]));
      const jsWidths = await c.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        const view = content.cmTile.root.view;
        let el = null;
        for (const line of document.querySelectorAll('.cm-line')) {
          let p = -1;
          try { p = view.posAtDOM(line, 0); } catch (e) { continue; }
          if (p === ${from}) { el = line; break; }
        }
        if (!el) return null;
        // 该块可能折成多行：把紧随其后的行也算进来（直到位置超过块尾）
        const els = [];
        let cur = el;
        while (cur) {
          let p = -1;
          try { p = view.posAtDOM(cur, 0); } catch (e) { p = -1; }
          if (p >= 0 && p < ${to}) els.push(cur);
          if (p < 0 || p >= ${to}) break;
          cur = cur.nextElementSibling;
        }
        const w = [];
        for (const e of els) {
          for (const m of e.querySelectorAll('.cm-math-widget, .cm-math-block-inline')) {
            w.push(+m.getBoundingClientRect().width.toFixed(2));
          }
        }
        return w;
      })()`);
      const typstPx = bodies
        .map((b) => byBody.get(b))
        .filter(Boolean)
        .map((m) => +(m.widthPt * (4 / 3)).toFixed(2));
      console.log(
        `  · WIDTH2 L${r.line} 行数 typst=${r.typstLines}/browser=${r.browserRows} widget 宽=${JSON.stringify(jsWidths)} 夹具宽px=${JSON.stringify(typstPx)}`,
      );
    }
  }

  // 诊断（`PKU_CHARWIDTH=1`）：逐字符量浏览器里一行文本的前进宽度（含标点），
  // 用来确认"浏览器比 Typst 早折一行"是不是全角标点/某类字符的前进宽度更大。
  if (process.env.PKU_CHARWIDTH === "1") {
    const target = rowFails[0];
    if (target) {
      await c.evaluate(
        `(() => {
          const view = document.querySelector('.cm-content').cmTile.root.view;
          view.scrollDOM.scrollTop = Math.max(0, view.lineBlockAt(${byteToPos(fx.doc, target.start)}).top - 120);
          return true;
        })()`,
      );
      await sleep(400);
      const lineTexts = await c.evaluate(`(() => {
        const content = document.querySelector('.cm-content');
        const view = content.cmTile.root.view;
        const doc = view.state.doc;
        const from = ${byteToPos(fx.doc, 0)};
        void from;
        const start = ${byteToPos(fx.doc, target.start)};
        const end = ${byteToPos(fx.doc, target.end)};
        // 找出该块渲染出来的行元素
        const els = [];
        for (const el of document.querySelectorAll('.cm-line')) {
          let p = -1;
          try { p = view.posAtDOM(el, 0); } catch (e) { continue; }
          if (p >= start && p < end) els.push(el);
        }
        if (!els.length) return null;
        const out = [];
        for (const el of els) {
          const lf = view.posAtDOM(el, 0);
          const lt = lf + el.textContent.length;
          const chars = [];
          let prevLeft = null;
          for (let p = lf; p <= Math.min(lt, doc.length); p++) {
            const co = view.coordsAtPos(p);
            const ch = p < lt ? doc.sliceString(p, p + 1) : '';
            if (prevLeft != null && co) chars.push({ ch, adv: +(co.left - prevLeft).toFixed(2) });
            prevLeft = co ? co.left : prevLeft;
          }
          out.push({
            text: el.textContent.slice(0, 40),
            sum: +chars.reduce((a, c) => a + c.adv, 0).toFixed(2),
            chars: chars.slice(0, 200),
          });
        }
        return out;
      })()`);
      const block = fx.blocks.find((b) => b.start === target.start);
      const spans = block?.lineSpans ?? [];
      console.log(
        `  · CHARWIDTH L${target.line}（typst=${target.typstLines}/browser=${target.browserRows}；块左缘=${block?.xPt}pt）：`,
      );
      (lineTexts ?? []).forEach((ln, i) => {
        const typstW = spans[i] ? (spans[i].x1Pt - (block?.xPt ?? 0)) * (4 / 3) : null;
        console.log(
          `      行${i}「${ln.text}」浏览器宽=${ln.sum}px${typstW != null ? ` typst宽=${typstW.toFixed(1)}px 差=${(ln.sum - typstW).toFixed(1)}px` : ""}`,
        );
        console.log(
          `      前进宽度：${ln.chars
            .slice(0, 60)
            .map((c) => `${JSON.stringify(c.ch)}:${c.adv}`)
            .join(" ")}`,
        );
      });
    }
  }

  // 记录首处失败（报告里直接指到行）
  const firstFailure = [...adjFails, ...cumFails, ...missingMeasured].sort(
    (a, b) => (anchorOf(a).t ?? 0) - (anchorOf(b).t ?? 0),
  )[0];
  if (firstFailure)
    console.log(
      `  ✗ 首处失败：L${firstFailure.line} ${firstFailure.kind} :: ${firstFailure.excerpt}`,
    );

  const report = {
    name: fx.name,
    priority: fx.priority,
    relPath: fx.relPath,
    absPath: fx.absPath,
    sha256: fx.sha256,
    comparable,
    columnPt: docColumnPt,
    columnPx: measured.columnPx,
    factor,
    typstLineSpacingPt: fx.lineSpacingPt ?? null,
    lineSpacingPx,
    lineHeightPx,
    fontSizePx: fontSize,
    pages: fx.pages,
    diagnostics: fx.diagnostics ?? [],
    mathFixtures: (fx.math ?? []).length,
    mathHits,
    mathFake,
    parbreak,
    firstFailure: firstFailure ?? null,
    rows,
  };
  const slug = `doc${reports.length + 1}`;
  writeFileSync(`${OUT_DIR}report-${slug}.json`, JSON.stringify(report, null, 1));
  reports.push({ slug, ...report });
  await c.screenshot(SHOT(`pku-writing-${slug}`));
  console.log(`  报告：${OUT_DIR}report-${slug}.json（截图 pku-writing-${slug}.png）`);
}

writeFileSync(
  `${OUT_DIR}summary.json`,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      pkuRoot: process.env.PKU_ROOT ?? null,
      columnPt: allFixtures[0].contentWidthPt,
      docs: reports.map((r) => ({
        slug: r.slug,
        name: r.name,
        priority: r.priority,
        pages: r.pages,
        comparable: r.comparable,
        firstFailure: r.firstFailure
          ? {
              line: r.firstFailure.line,
              kind: r.firstFailure.kind,
              excerpt: r.firstFailure.excerpt,
            }
          : null,
      })),
    },
    null,
    1,
  ),
);

await c.close();
finish(
  `通过 ${state.passed} 项检查（失败 ${state.failed} 项）；测量 JSON：.browser-check/pku-writing/report-doc*.json`,
);
