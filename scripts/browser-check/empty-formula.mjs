// 用户新增 $$ 反馈：真实字符按键 → 生产投影 → 原生整页 SVG/caret，不以 doc/head 代替排版。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, loadFixtures, createChecker, compileSettled, finish, shotPath } from "./harness.mjs";
const expansion = loadFixtures("expansion-fixtures.json", {
  predicate: (fs) => fs.length === 64,
  hint: "先跑 npm run fixtures:pages",
});
const cursors = loadFixtures("cursor-fixtures.json");
const fixtures = [...loadFixtures("page-fixtures.json"), ...cursors, ...expansion];
const fixture = (name) => {
  const f = expansion.find((f) => f.name === name);
  if (!f) throw Error(`缺少 ${name}`);
  return f;
};
const empty = cursors.find((f) => f.name === "empty");
if (!empty) throw Error("缺少真实空文档夹具");
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL, { pageFixtures: fixtures });
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const head = () => c.evaluate("window.__typstPadView.state.selection.main.head");
const settled = (value) => c.waitFor(compileSettled(value.source ?? value.doc), { timeout: 8000 });
const keyText = (text) => c.send("Input.dispatchKeyEvent", { type: "char", text, key: text });
async function pagesMatch(value) {
  return c.evaluate(
    `(() => {const pages=${JSON.stringify(value.pages)},hosts=[...document.querySelectorAll('#preview-host>.document-page')];return hosts.length===pages.length&&hosts.every((h,i)=>{const div=document.createElement('div');div.innerHTML=pages[i];return h.shadowRoot.querySelector('svg').isEqualNode(div.firstElementChild)})})() `,
  );
}
async function caretMatches(value, pos) {
  let rendered = pos;
  if (value.range) {
    const blanks = value.range.blankLines ?? [];
    const relative = pos - value.range.from;
    const blank = blanks.findIndex((b) => relative >= b.from && relative <= b.at);
    rendered =
      value.range.renderedFrom +
      (blank < 0
        ? relative + blanks.filter((b) => b.at < relative).length
        : blanks[blank].at + blank);
  }
  const query = value.cursorQueries.find(
    (q) => q.offset === Buffer.byteLength(value.doc.slice(0, rendered)),
  );
  if (!query?.caret) throw Error(`实际输入位置必须有原生 caret: ${value.name}:${pos}`);
  await c.waitFor(
    `(() => {const p=${JSON.stringify(query.caret)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],caret=document.querySelector('.document-caret');if(!h||!caret)return false;const r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal,root=document.querySelector('.preview-canvas').getBoundingClientRect();return Math.abs(parseFloat(caret.style.left)+root.left-r.left-(p.xPt-v.x)*r.width/v.width)<.1&&Math.abs(parseFloat(caret.style.top)+root.top-r.top-(p.yPt-v.y)*r.height/v.height)<.1})()`,
    { timeout: 4000 },
  );
  return true;
}
async function startEmpty(activate = true) {
  if (await c.evaluate("!!document.querySelector('.document-pane')"))
    await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.key("Backspace", { keyCode: 8 });
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled(empty);
  if (!activate) return;
  const caret = empty.cursorQueries.find((q) => q.offset === 0)?.caret;
  if (!caret) throw Error("空文档真实占位必须可点击");
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return {x:r.left+(p.xPt+1-v.x)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await c.waitFor("window.__typstPadView.hasFocus");
}
await startEmpty(false);
await keyText("$");
await new Promise((resolve) => setTimeout(resolve, 400));
console.log(
  "EMPTY_FORMULA_MODE_SWITCH_REPRO",
  JSON.stringify(
    await c.evaluate(
      "({doc:window.__typstPadView.state.doc.toString(),head:window.__typstPadView.state.selection.main.head,focused:window.__typstPadView.hasFocus,compile:window.__browserDevLastCompile})",
    ),
  ),
);
const compact = fixture("empty-compact");
check(
  "源码模式往返后仍聚焦的输入层新 $ 自动展开，不要求额外鼠标点击",
  (await doc()) === "$$" && (await pagesMatch(compact)),
);
await startEmpty();
await keyText("$");
console.log(
  "EMPTY_FORMULA_REPRO",
  JSON.stringify(
    await c.evaluate(
      "({doc:window.__typstPadView.state.doc.toString(),head:window.__typstPadView.state.selection.main.head,compile:window.__browserDevLastCompile,schedule:window.__typstPadScheduleStats?.()})",
    ),
  ),
);
await settled(compact);
check(
  "空文档真实 $ 自动生成 $$ 后完整 raw/SVG 和原生 caret 可见",
  (await doc()) === "$$" &&
    (await head()) === 1 &&
    (await pagesMatch(compact)) &&
    (await caretMatches(compact, 1)),
);
await c.screenshot(shotPath("empty-formula-compact"));
await keyText(" ");
const padded = fixture("empty-padded");
await settled(padded);
check(
  "空格进入 $  $ 后保持真实展开和输入锚点",
  (await pagesMatch(padded)) && (await caretMatches(padded, 2)) && (await doc()) === "$  $",
);
await c.key("Enter", { keyCode: 13 });
const multiline = fixture("empty-multiline");
await settled(multiline);
check(
  "Enter 多行空公式占位真实可见并可停靠",
  (await doc()) === "$\n  \n$" &&
    (await head()) === 4 &&
    (await pagesMatch(multiline)) &&
    (await caretMatches(multiline, 4)),
);
await c.screenshot(shotPath("empty-formula-multiline"));
await keyText("x");
const typed = fixture("empty-multiline-typed");
await settled(typed);
check(
  "从空公式继续真实输入，不丢源码或输入锚点",
  (await doc()) === "$\n  x\n$" && (await pagesMatch(typed)) && (await caretMatches(typed, 5)),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
const undone = await doc();
console.log("EMPTY_FORMULA_UNDO", JSON.stringify({ doc: undone, head: await head() }));
await settled(padded);
check(
  "空公式输入撤销恢复真实 $  $ 原文及产物",
  undone === "$  $" && (await pagesMatch(padded)) && (await caretMatches(padded, 2)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(typed);
check(
  "空公式真实输入链路重做恢复原文及展开产物",
  (await doc()) === "$\n  x\n$" && (await pagesMatch(typed)),
);
await c.key("Escape", { keyCode: 27 });
await settled(fixture("empty-multiline-typed-base"));
check(
  "Esc 收起后恢复原生公式完整页面，无隐式写盘",
  (await pagesMatch(fixture("empty-multiline-typed-base"))) &&
    (await c.evaluate("!window.__browserDevWrites?.length")),
);

for (const mode of ["typed", "pasted"]) {
  await startEmpty();
  if (mode === "typed") await keyText("$$");
  else
    await c.evaluate(
      `(() => {const d=new DataTransfer();d.setData('text/plain','$$');window.__typstPadView.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));return true})()`,
    );
  await c.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  });
  await c.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  });
  await settled(compact);
  check(
    `${mode} $$ 左移进入后显示完整 raw 和真实 caret`,
    (await doc()) === "$$" && (await pagesMatch(compact)) && (await caretMatches(compact, 1)),
  );
  await keyText("x");
  await settled(fixture("empty-typed"));
  check(
    `${mode} $$ 可续写并保持原生展开产物`,
    (await doc()) === "$x$" &&
      (await pagesMatch(fixture("empty-typed"))) &&
      (await caretMatches(fixture("empty-typed"), 2)),
  );
}
await startEmpty();
await keyText("正文 ");
await keyText("$");
await settled(fixture("empty-end"));
check(
  "正文末尾新 $ 自动配对的 $$ 可见展开",
  (await doc()) === "正文 $$" &&
    (await pagesMatch(fixture("empty-end"))) &&
    (await caretMatches(fixture("empty-end"), 4)),
);
await c.screenshot(shotPath("empty-formula-paragraph-end"));
console.log(
  "EMPTY_FORMULA_FINAL",
  JSON.stringify(
    await c.evaluate(
      "({doc:window.__typstPadView.state.doc.toString(),compile:window.__browserDevLastCompile})",
    ),
  ),
);
// 用户新增『只在没动时回退』：所有资格都由真实 Enter 事务创建，不能用替换源码造资格。
async function createScaffold(mode) {
  await startEmpty();
  if (mode === "source") await c.key("e", { keyCode: 69, modifiers: 2 });
  await keyText("$");
  await c.key("Enter", { keyCode: 13 });
  await settled(fixture(mode === "source" ? "empty-multiline-base" : "empty-multiline"));
}
async function checkMultiline(mode, name, expected, pos) {
  const value = fixture(mode === "source" ? `${name}-base` : name);
  await settled(value);
  return (
    (await doc()) === expected &&
    (await pagesMatch(value)) &&
    (mode === "source" || (await caretMatches(value, pos)))
  );
}
for (const mode of ["write", "source"]) {
  await createScaffold(mode);
  await c.key("Backspace", { keyCode: 8 });
  await settled(fixture(mode === "source" ? "empty-compact-base" : "empty-compact"));
  check(
    `${mode} 刚 Enter 未动脚手架立即 Backspace 可折回 $$`,
    (await doc()) === "$$" &&
      (await head()) === 1 &&
      (await pagesMatch(fixture(mode === "source" ? "empty-compact-base" : "empty-compact"))),
  );
  await createScaffold(mode);
  await c.key("ArrowLeft", { keyCode: 37 });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 移到空格处 Backspace 只删一格，不折回`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 2),
  );
  if (mode === "write") await c.screenshot(shotPath("empty-formula-moved-backspace"));
  await createScaffold(mode);
  await keyText(" ");
  await c.key("Backspace", { keyCode: 8 });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 添加/删除空格后仍空白，第二次 Backspace 不折回`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
  );
  await createScaffold(mode);
  for (let i = 0; i < 4; i++) await c.key("ArrowLeft", { keyCode: 37 });
  for (let i = 0; i < 4; i++) await c.key("ArrowRight", { keyCode: 39 });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 离开再回初始光标不能重新取得回退资格`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
  );
  for (const input of ["manual", "paste"]) {
    await startEmpty();
    if (mode === "source") await c.key("e", { keyCode: 69, modifiers: 2 });
    if (input === "manual") await c.type("$\n  \n$");
    else
      await c.evaluate(
        `(() => {const d=new DataTransfer();d.setData('text/plain','$\\n  \\n$');window.__typstPadView.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));return true})()`,
      );
    await c.key("ArrowLeft", { keyCode: 37 });
    await c.key("ArrowLeft", { keyCode: 37 });
    await c.key("Backspace", { keyCode: 8 });
    check(
      `${mode} ${input} 同形多行空公式从未拥有自动回退资格`,
      await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
    );
  }
  await createScaffold(mode);
  await c.key("z", { keyCode: 90, modifiers: 2 });
  const historyUndo = await doc();
  await c.key("y", { keyCode: 89, modifiers: 2 });
  console.log(
    "PRISTINE_REDO",
    JSON.stringify({ mode, undo: historyUndo, doc: await doc(), head: await head() }),
  );
  // CM 重做可能把光标放在插入末尾；真实按键回到中行，不把历史光标假定为原生成位置。
  for (let i = 0; i < 8 && (await head()) !== 4; i++)
    await c.key((await head()) > 4 ? "ArrowLeft" : "ArrowRight", {
      keyCode: (await head()) > 4 ? 37 : 39,
    });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} undo/redo 后回中行不会恢复自动折回`,
    historyUndo !== "$\n  \n$" &&
      (await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3)),
  );
  await createScaffold(mode);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 即使未编辑，模式往返也清除自动折回资格`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
  );
  await createScaffold(mode);
  await c.key("ArrowLeft", { keyCode: 37 });
  await c.key("ArrowRight", { keyCode: 39 });
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 模式往返不能恢复已移动的回退资格`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
  );
  await createScaffold(mode);
  await c.evaluate(
    "window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await c.key("Backspace", { keyCode: 8 });
  check(
    `${mode} 开始/取消 DOM 合成也只撤销资格，不改原文或折回`,
    await checkMultiline(mode, "empty-multiline-one-space", "$\n \n$", 3),
  );
}
await startEmpty();
await keyText("$");
await settled(compact);
const beforeComposition = await c.evaluate("window.__browserDevCallCounts.compile_doc??0");
await c.evaluate(
  "window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true",
);
await keyText("x");
await new Promise((resolve) => setTimeout(resolve, 180));
check(
  "空公式续写合成期间冻结真实旧产物与输入锚点，不编译过期源码",
  (await doc()) === "$x$" &&
    (await pagesMatch(compact)) &&
    (await c.evaluate("window.__browserDevCallCounts.compile_doc??0")) === beforeComposition,
);
await c.evaluate(
  "window.__typstPadView.contentDOM.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true",
);
await settled(fixture("empty-typed"));
check(
  "合成结束按最终空公式源码恢复真实展开与 caret",
  (await pagesMatch(fixture("empty-typed"))) && (await caretMatches(fixture("empty-typed"), 2)),
);

const originalAgent = await c.evaluate(
  "({userAgent:navigator.userAgent,platform:navigator.platform})",
);
try {
  await c.send("Emulation.setUserAgentOverride", {
    userAgent: originalAgent.userAgent.replace(/\([^)]*\)/, "(Linux; Android 14)"),
    platform: "Linux armv8l",
  });
  await boot(c, DEV_URL, { pageFixtures: fixtures });
  await createScaffold("write");
  await c.waitFor("!!window.__typstPadView.contentDOM.editContext");
  await c.evaluate(
    "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionstart'));window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionend'));true",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await c.key("Backspace", { keyCode: 8 });
  check(
    "原生 EditContext 开始/取消合成同样撤销脚手架资格",
    await checkMultiline("write", "empty-multiline-one-space", "$\n \n$", 3),
  );
} finally {
  await c.send("Emulation.setUserAgentOverride", originalAgent);
}
await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await startEmpty();
await c.evaluate(
  `(() => {window.__emptyRequests=[];const old=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(cmd,args)=>{if(cmd==='compile_doc')window.__emptyRequests.push(args.src);return old(cmd,args)};return true})()`,
);
await keyText("$");
await c.waitFor("window.__typstPadScheduleStats?.().inFlight");
await keyText("x");
await settled(fixture("empty-typed"));
check(
  "新 $$ 的在途原文/投影响应不能覆盖后续真实续写产物或 caret",
  (await doc()) === "$x$" &&
    (await pagesMatch(fixture("empty-typed"))) &&
    (await caretMatches(fixture("empty-typed"), 2)),
);
console.log("EMPTY_FORMULA_INFLIGHT", JSON.stringify(await c.evaluate("window.__emptyRequests")));
await boot(c, DEV_URL, { pageFixtures: fixtures });
await startEmpty();
await keyText("正文");
await c.key("Enter", { keyCode: 13 });
await keyText("$");
await settled(fixture("empty-line"));
check(
  "正文后的空行新 $ 也使用真实 raw 投影及原生 caret",
  (await doc()) === "正文\n\n$$" &&
    (await pagesMatch(fixture("empty-line"))) &&
    (await caretMatches(fixture("empty-line"), 5)),
);
await c.evaluate("window.__browserDevSavePath='/fake/empty-formula.typ';true");
await c.key("s", { keyCode: 83, modifiers: 2 });
await c.waitFor("window.__browserDevWrites?.at(-1)?.path==='/fake/empty-formula.typ'");
check(
  "显式保存空公式仅写原文，不含 raw 围栏/样式/占位",
  await c.evaluate("window.__browserDevWrites.at(-1).content==='正文\\n\\n$$'"),
);
finish(`通过 ${state.passed} 项检查；新输入 $$ 与未动脚手架真实按键/投影/原生 SVG/caret`);
