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
  predicate: (fs) => fs.length === 9 && fs.every((f) => f.pages.length && f.cursorQueries.length),
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
function query(value, head) {
  let rendered = head;
  if (value.range) {
    const { from, to } = value.range;
    const text = value.original.slice(from, to);
    if (head >= from && head <= to) rendered = value.doc.indexOf(text) + head - from;
    else if (head > to) rendered += value.doc.length - value.original.length;
  }
  const offset = Buffer.byteLength(value.doc.slice(0, rendered));
  const result = value.cursorQueries.find((q) => q.offset === offset);
  if (!result?.caret) throw Error(`所测展开字素必须有原生光标：${value.name}:${head}`);
  return result.caret;
}
async function caretMatches(value, head, visible = false) {
  const caret = query(value, head);
  const expression = `(() => {const p=${JSON.stringify(caret)},host=document.querySelectorAll('#preview-host>.document-page')[p.page-1],el=document.querySelector('.document-caret');if(!host||!el)return false;const r=host.getBoundingClientRect(),v=host.shadowRoot.querySelector('svg').viewBox.baseVal,root=document.querySelector('.preview-canvas').getBoundingClientRect(),body=document.querySelector('.preview-body').getBoundingClientRect();const x=r.left+(p.xPt-v.x)*r.width/v.width,y=r.top+(p.yPt-v.y)*r.height/v.height;return Math.abs(parseFloat(el.style.left)+root.left-x)<.1&&Math.abs(parseFloat(el.style.top)+root.top-y)<.1&&(!${visible}||(x>=body.left&&x<body.right&&y>=body.top&&y<body.bottom))})()`;
  await c.waitFor(expression, { timeout: 4000, interval: 16 });
  return true;
}
async function replace() {
  if (await c.evaluate("!!document.querySelector('.document-pane')"))
    await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.type(base.original);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled(base);
  // 先点击实际正文激活输入；后续选择事务与真实键盘复用同一展开流程。
  const p = query(base, base.original.indexOf("正文"));
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt+1-v.x)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await c.waitFor(
    `window.__typstPadView.hasFocus&&window.__typstPadView.state.selection.main.head===${base.original.indexOf("正文")}`,
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
await cursor(block.range.from + 2);
await settled(block);
const bracket = block.range.from + "#block".length;
await cursor(bracket);
await caretMatches(block, bracket, true);
check("多行展开首行标点有真实字素停靠点，不沿用函数名几何", await pagesMatch(block));
await c.screenshot(shotPath("document-expansion-multiline"));
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
await c.type(" + ");
await c.type("z");
await settled(edited);
check(
  "逐键输入共用编辑去抖，不每键立即重编译",
  (await count()) === beforeTyping + 1 &&
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
check(
  "展开流程没有隐式写盘或脚本异常",
  await c.evaluate("!window.__browserDevWrites?.length&&!window.__browserDevErrors?.length"),
);
await c.close();
finish(`通过 ${state.passed} 项检查；光标主导展开 + 9 份真实 Typst 产物`);
