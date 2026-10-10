// 光标驱动展开：真实全页产物、选区、调度和重排后的插入点一起验证。
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  loadFixtures,
  createChecker,
  compileSettled,
  sleep,
  finish,
  shotPath,
} from "./harness.mjs";
const expansion = loadFixtures("expansion-fixtures.json", {
  predicate: (fs) => fs.length === 30 && fs.every((f) => f.pages.length && f.cursorQueries.length),
  hint: "先跑 npm run fixtures:pages",
});
const fixtures = [...loadFixtures("page-fixtures.json"), ...expansion];
const f = (name) => {
  const value = expansion.find((f) => f.name === name);
  if (!value) throw Error(`缺少展开夹具 ${name}`);
  return value;
};
const base = f("base"),
  math = f("math"),
  edited = f("math-edited"),
  outer = f("outer"),
  block = f("block");
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL, { pageFixtures: fixtures });
const count = () => c.evaluate("window.__browserDevCallCounts.compile_doc??0");
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const settled = (value) => c.waitFor(compileSettled(value.doc), { timeout: 8000 });
const cursor = (head, anchor = head) =>
  c.evaluate(
    `window.__typstPadView.dispatch({selection:{anchor:${anchor},head:${head}}});window.__typstPadView.focus();true`,
  );
async function pagesMatch(value) {
  return c.evaluate(
    `(() => {const expected=${JSON.stringify(value.pages)},svgs=[...document.querySelectorAll('#preview-host>.document-page')].map(host=>host.shadowRoot.querySelector('svg'));return svgs.length===expected.length&&svgs.every((svg,i)=>{const div=document.createElement('div');div.innerHTML=expected[i];return svg.isEqualNode(div.firstElementChild)})})()`,
  );
}
async function bubbleMatches(value) {
  await c.waitFor("!!document.querySelector('.formula-preview-content svg')");
  return c.evaluate(
    `(() => {const div=document.createElement('div');div.innerHTML=${JSON.stringify(value.formulaPreview?.svg)};return document.querySelector('.formula-preview-content svg').isEqualNode(div.firstElementChild)})()`,
  );
}
function query(value, head) {
  let rendered = head;
  if (value.range) {
    const { from, to } = value.range;
    if (head >= from && head <= to) rendered = value.range.renderedFrom + head - from;
    else if (head > to) rendered += value.doc.length - value.original.length;
  }
  return renderedQuery(value, rendered);
}
function renderedQuery(value, rendered) {
  const offset = Buffer.byteLength(value.doc.slice(0, rendered));
  const result = value.cursorQueries.find((q) => q.offset === offset);
  if (!result?.caret) throw Error(`所测展开字素必须有原生光标：${value.name}:${rendered}`);
  return result.caret;
}
async function caretMatches(value, head, visible = false) {
  const caret = query(value, head);
  const expression = `(() => {const p=${JSON.stringify(caret)},host=document.querySelectorAll('#preview-host>.document-page')[p.page-1],el=document.querySelector('.document-caret');if(!host||!el)return false;const r=host.getBoundingClientRect(),v=host.shadowRoot.querySelector('svg').viewBox.baseVal,root=document.querySelector('.preview-canvas').getBoundingClientRect(),body=document.querySelector('.preview-body').getBoundingClientRect();const x=r.left+(p.xPt-v.x)*r.width/v.width,y=r.top+(p.yPt-v.y)*r.height/v.height;return Math.abs(parseFloat(el.style.left)+root.left-x)<.1&&Math.abs(parseFloat(el.style.top)+root.top-y)<.1&&(!${visible}||(x>=body.left&&x<body.right&&y>=body.top&&y<body.bottom))})()`;
  await c.waitFor(expression, { timeout: 4000, interval: 16 });
  return true;
}
async function replace(value = base) {
  if (await c.evaluate("!!document.querySelector('.document-pane')"))
    await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.type(value.original);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled(value);
  // 先点击实际正文激活输入；后续选择事务与真实键盘复用同一展开流程。
  const p = query(value, value.original.indexOf("正文"));
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt+1-v.x)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await c.waitFor(
    `window.__typstPadView.hasFocus&&window.__typstPadView.state.selection.main.head===${value.original.indexOf("正文")}`,
  );
}
await replace();
check("正文保持完整原生页面，激活输入不展开普通文字", await pagesMatch(base));
const beforeMath = await count();
await cursor(math.range.from + 1);
await settled(math);
check(
  "键盘进入公式一次编译完整展开，源码保持不变",
  (await count()) === beforeMath + 1 && (await doc()) === base.original && (await pagesMatch(math)),
);
await caretMatches(math, math.range.from + 1, true);
check("展开后的插入点来自新原生几何且位于视口内", true);
check(
  "公式预览为源码下方黑色浮动气泡，SVG 来自真实 Typst 帧",
  (await bubbleMatches(math)) &&
    (await c.evaluate(
      "document.querySelector('.formula-preview').getBoundingClientRect().top > document.querySelector('.document-caret').getBoundingClientRect().bottom && getComputedStyle(document.querySelector('.formula-preview')).backgroundColor === 'rgb(17, 17, 17)'",
    )),
);
const beforePreviewClick = await count();
const previewPoint = await c.evaluate(
  "(() => {const r=document.querySelector('.formula-preview').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
await c.click(previewPoint.x, previewPoint.y);
await c.waitFor(`window.__typstPadView.state.selection.main.head===${math.range.from + 1}`);
await caretMatches(math, math.range.from + 1, true);
check(
  "点击预览回到对应源码编辑，不重复编译或把插入点留在预览",
  (await count()) === beforePreviewClick && (await doc()) === base.original,
);
await c.screenshot(shotPath("document-expansion-inline-preview"));
const stable = await count();
await c.key("ArrowRight", { keyCode: 39 });
await caretMatches(math, math.range.from + 2);
check("表达式内部逐字移动不重编译、不收起", (await count()) === stable);
await cursor(math.range.to - 1);
await settled(math);
await c.key("ArrowRight", { keyCode: 39 });
await settled(base);
check("向右跨过关闭边界恢复正常排版", await pagesMatch(base));
await cursor(math.range.to + 1);
await c.key("ArrowLeft", { keyCode: 37 });
await settled(math);
check("从右侧进入边界按左亲和性展开", await pagesMatch(math));
await cursor(math.range.from + 1);
await c.key("ArrowLeft", { keyCode: 37 });
await settled(base);
check("向左跨过开始边界收起，不立即重开旧表达式", await pagesMatch(base));
await cursor(math.range.from + 2);
await settled(math);
const beforeSwitch = await count();
await cursor(outer.range.from + 2);
await settled(outer);
check(
  "直接切换另一完整调用只请求一轮新投影",
  (await count()) === beforeSwitch + 1 && (await pagesMatch(outer)),
);
const beforeNested = await count();
await cursor(base.original.indexOf("c + d"));
await cursor(base.original.indexOf("strong"));
await sleep(200);
check(
  "已展开父调用内遍历嵌套公式与脚本不切换范围",
  (await count()) === beforeNested && (await pagesMatch(outer)),
);
const tail = base.original.indexOf("后文");
await cursor(tail, outer.range.from + 2);
await sleep(200);
check(
  "Shift/反向选区离开范围不改变排版中的父展开",
  (await count()) === beforeNested && (await pagesMatch(outer)),
);
await cursor(tail);
await settled(base);
check("选区收拢后由活动端决定收起", await pagesMatch(base));
await cursor(base.original.indexOf("c + d"));
await settled(f("nested-math"));
check("未展开父范围时定位内层公式只展开最小完整表达式", await pagesMatch(f("nested-math")));
const embeddedMath = f("embedded-math"),
  declaration = f("math-declaration"),
  codeBlock = f("code-block");
const embeddedHead = base.original.indexOf("#sym.beta");
const beforeEmbedded = await count();
await cursor(embeddedHead);
await settled(embeddedMath);
await caretMatches(embeddedMath, embeddedHead, true);
check(
  "数学模式中的 # 展开整段公式，直接使用新几何而不触发错误回退",
  (await count()) === beforeEmbedded + 1 && (await pagesMatch(embeddedMath)),
);
const declarationHead = declaration.range.from + "#let formula = ".length;
const beforeDeclaration = await count();
await cursor(declarationHead);
await settled(declaration);
await caretMatches(declaration, declarationHead, true);
check(
  "代码模式中的公式展开完整 # 声明，保留执行和后文输出",
  (await count()) === beforeDeclaration + 1 && (await pagesMatch(declaration)),
);
const declarationStable = await count();
await cursor(declaration.range.to - 1);
await caretMatches(declaration, declaration.range.to - 1);
check(
  "# 结束分号仍在展开范围内，不成为 raw 外的正文或重复重排",
  (await count()) === declarationStable && (await pagesMatch(declaration)),
);
await c.key("ArrowRight", { keyCode: 39 });
await settled(base);
check("跨出 # 的完整语法边界后恢复原文排版", await pagesMatch(base));
const blankCodeHead = codeBlock.original.indexOf("\n\n // 代码空白") + 1;
const beforeCodeBlock = await count();
await cursor(blankCodeHead);
await settled(codeBlock);
const commentHead = codeBlock.original.indexOf("代码空白");
await cursor(commentHead);
await caretMatches(codeBlock, commentHead, true);
check(
  "# 代码块的空白和注释也按语法展开，原文与后续输出不变",
  (await count()) === beforeCodeBlock + 1 &&
    (await doc()) === base.original &&
    (await pagesMatch(codeBlock)),
);
await cursor(block.range.from + 2);
await settled(block);
const bracket = block.range.from + "#block".length;
await cursor(bracket);
await caretMatches(block, bracket, true);
check("多行展开首行标点有真实字素停靠点，不沿用函数名几何", await pagesMatch(block));
await c.screenshot(shotPath("document-expansion-multiline"));
const beforeTheme = await count();
for (const theme of ["dark", "light"]) {
  await c.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await c.waitFor(
    `document.querySelector('.app').classList.contains('light')===${theme === "light"}`,
  );
  await caretMatches(block, bracket, true);
  if (!(await pagesMatch(block))) throw Error("主题切换不能改写展开的真实 SVG");
  await c.screenshot(shotPath(`document-expansion-${theme}`));
}
check("展开面板在明暗主题下保留真实页面和光标，不重新编译", (await count()) === beforeTheme);
const blockStable = await count();
await cursor(block.original.indexOf("第二行中文"));
await cursor(block.original.indexOf("多行脚本"));
check("展开多行内容跨行移动不反复编译", (await count()) === blockStable);
const blockEnd = block.original.indexOf("多行脚本正文。") + "多行脚本正文。".length;
await cursor(blockEnd);
await c.type("续");
await settled(f("block-edited"));
check(
  "多行展开输入映射范围并由真实 Typst 保持完整页面",
  (await doc()) === f("block-edited").original && (await pagesMatch(f("block-edited"))),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(block);
check(
  "展开内撤销同步源码和投影，不丢展开归属",
  (await doc()) === base.original && (await pagesMatch(block)),
);
await cursor(math.range.to - 1);
await settled(math);
const beforeTyping = await count();
await c.evaluate(`(() => {
  window.__expansionTypingInputs=[];
  const internals=window.__TAURI_INTERNALS__,invoke=internals.invoke;
  internals.invoke=(command,args)=>{
    if(command==='compile_doc')window.__expansionTypingInputs.push(args.src);
    return invoke(command,args);
  };
  return true;
})()`);
await c.type(" + ");
await c.type("z");
const immediateTypingCount = await count();
await settled(edited);
check(
  "逐键输入共用编辑去抖，最终仅原文测量及展示各一次",
  immediateTypingCount === beforeTyping &&
    (await count()) === beforeTyping + 2 &&
    (await c.evaluate(
      `JSON.stringify(window.__expansionTypingInputs)===${JSON.stringify(JSON.stringify([edited.original, edited.doc]))}`,
    )) &&
    (await doc()) === edited.original &&
    (await pagesMatch(edited)),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(math);
check(
  "公式编辑撤销保持同一展开与当前源码",
  (await doc()) === base.original && (await pagesMatch(math)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(edited);
check("公式编辑重做恢复正确范围映射和产物", await pagesMatch(edited));
await c.key("Escape", { keyCode: 27 });
await c.waitFor(compileSettled(edited.original));
check(
  "Esc 显式收起且不写入围栏或保存文件",
  (await doc()) === edited.original &&
    (await pagesMatch(f("edited-base"))) &&
    (await c.evaluate("!window.__browserDevWrites?.length")),
);
await replace();
await cursor(math.range.from + 2);
await settled(math);
const beforeComposition = await count();
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true",
);
await cursor(outer.range.from + 2);
await sleep(250);
check(
  "合成期间移动活动端不展开另一范围或启动排版",
  (await count()) === beforeComposition && (await pagesMatch(math)),
);
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true",
);
await settled(outer);
check(
  "合成结束先按最终光标切换范围，再恢复一次调度",
  (await count()) === beforeComposition + 1 && (await pagesMatch(outer)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor(compileSettled(base.original));
check(
  "模式切换清除临时展开但保留真实选区和源码",
  (await doc()) === base.original &&
    (await c.evaluate(`window.__typstPadView.state.selection.main.head===${outer.range.from + 2}`)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await settled(base);
check("返回文档不凭旧展开锁抢占当前光标", await pagesMatch(base));

await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await replace();
await cursor(math.range.from + 2);
await c.waitFor("window.__typstPadScheduleStats?.().inFlight");
await cursor(outer.range.from + 2);
await cursor(tail);
await settled(base);
check(
  "连续跨表达式移动作废迟到展开，最终产物跟随最后光标",
  (await doc()) === base.original && (await pagesMatch(base)),
);
for (const prefix of ["raw-hidden", "raw-replaced"]) {
  const original = f(`${prefix}-base`),
    expanded = f(`${prefix}-math`);
  await replace(original);
  const before = await count();
  await cursor(expanded.range.from + 1);
  await settled(expanded);
  await caretMatches(expanded, expanded.range.from + 1, true);
  check(
    `${prefix}：用户 show raw 不隐藏或替换展开源码，真实停靠点可见`,
    (await count()) === before + 1 &&
      (await doc()) === original.original &&
      (await pagesMatch(expanded)),
  );
  await c.key("Escape", { keyCode: 27 });
  await settled(original);
  check(`${prefix}：收起恢复原文，普通 raw 仍遵循用户规则`, await pagesMatch(original));
}
const display = f("display-math");
await replace(f("display-base"));
await cursor(display.range.from + 2);
await settled(display);
await caretMatches(display, display.range.from + 2, true);
check(
  "块公式同样在源码下方浮动预览，不进入正文页面",
  (await bubbleMatches(display)) &&
    (await pagesMatch(display)) &&
    (await doc()) === display.original,
);
await c.screenshot(shotPath("document-expansion-display-preview"));
const counter = f("counter");
await replace(f("counter-base"));
await cursor(counter.range.from + 2);
await settled(counter);
check(
  "普通脚本不显示预览，但仍保留一次 counter 副作用",
  /COUNT:\s*1/.test(counter.visibleText) &&
    !counter.formulaPreview &&
    (await c.evaluate("!document.querySelector('.formula-preview')")) &&
    (await pagesMatch(counter)) &&
    (await doc()) === counter.original,
);
for (const name of ["number", "fraction"]) {
  const baseValue = f(`${name}-base`),
    expanded = f(name);
  await replace(baseValue);
  const hit = baseValue.formulaHits.find(
    (h) =>
      h.caret.offset > Buffer.byteLength(baseValue.original.slice(0, expanded.range.from)) &&
      h.caret.offset < Buffer.byteLength(baseValue.original.slice(0, expanded.range.to)),
  );
  if (!hit || hit.caret.isWhitespace) throw Error("真实公式区域命中不能被误判为空白");
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(hit)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await settled(expanded);
  check(
    `${name}：真实鼠标点击数字或分式中心正常展开`,
    (await pagesMatch(expanded)) &&
      (await bubbleMatches(expanded)) &&
      (await doc()) === expanded.original,
  );
  await c.screenshot(shotPath(`document-expansion-${name}-bubble`));
  await c.key("Escape", { keyCode: 27 });
  await settled(baseValue);
  check(
    `${name}：收起移除气泡，恢复原始页面`,
    (await pagesMatch(baseValue)) &&
      (await c.evaluate("!document.querySelector('.formula-preview')")),
  );
}
for (const name of ["long-line", "tall-matrix", "nested-fraction"]) {
  const baseValue = f(`${name}-base`),
    expanded = f(name);
  await replace(baseValue);
  await cursor(expanded.range.from + 2);
  await settled(expanded);
  await caretMatches(expanded, expanded.range.from + 2, true);
  check(
    `${name}：长公式展开并显示同次编译的真实浮动预览`,
    (await pagesMatch(expanded)) &&
      (await bubbleMatches(expanded)) &&
      (await doc()) === expanded.original,
  );
  // 长/高公式预览卡片不越出预览可见区，也不撑出横向滚动条（必要时只在卡片内滚动）。
  check(
    `${name}：预览卡片不越出预览可见区且不横滚`,
    await c.evaluate(
      `(() => {const b=document.querySelector('.formula-preview');if(!b)return false;const r=b.getBoundingClientRect();const body=document.querySelector('.preview-body');const br=body.getBoundingClientRect();return r.left>=br.left-0.5&&r.right<=br.right+0.5&&body.scrollWidth<=body.clientWidth+1})()`,
    ),
  );
  await c.screenshot(shotPath(`document-expansion-${name}-preview`));
  await c.key("Escape", { keyCode: 27 });
  await settled(baseValue);
  check(
    `${name}：收起移除气泡，恢复原始页面`,
    (await pagesMatch(baseValue)) &&
      (await c.evaluate("!document.querySelector('.formula-preview')")),
  );
}
check(
  "展开流程没有隐式写盘或脚本异常",
  await c.evaluate("!window.__browserDevWrites?.length&&!window.__browserDevErrors?.length"),
);
await c.close();
finish(`通过 ${state.passed} 项检查；光标主导展开 + 30 份真实 Typst 产物`);
