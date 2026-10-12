// 现有 CM/Lezer 候选在透明输入层和源码模式之间的真实 Chromium 验收。
import { writeFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  loadFixtures,
  createChecker,
  finish,
  COMPILE_IDLE,
  sleep,
  shotPath,
} from "./harness.mjs";
const fixtures = loadFixtures("page-fixtures.json");
const fixture = fixtures[0];
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL, { pageFixtures: fixtures });
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
const caret = fixture.carets.find((point) => point.page === 1 && point.offset > 165);
if (!caret) throw new Error("缺少真实页面光标夹具");
const pos = Buffer.from(fixture.doc).subarray(0, caret.offset).toString().length;
const evidence = [];
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const sourceMode = async (source) => {
  if ((await c.evaluate("!!document.querySelector('.input-proxy')")) === source)
    await c.key("e", { keyCode: 69, modifiers: 2 });
};
const replace = async (text = fixture.doc, anchor = pos) => {
  await c.evaluate(
    `(() => {const v=window.__typstPadView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(text)}},selection:{anchor:${anchor}}});v.focus();return true})()`,
  );
  await c.waitFor(COMPILE_IDLE);
};
const measure = () =>
  c.evaluate(`(() => {
  const el=document.querySelector('.cm-tooltip-autocomplete'),proxy=document.querySelector('.input-proxy');
  if(!el)return null;
  const r=el.getBoundingClientRect(),p=proxy?.getBoundingClientRect();
  let opacity=1,visible=true;for(let node=el;node;node=node.parentElement){const s=getComputedStyle(node);opacity*=Number(s.opacity);visible&&=s.visibility==='visible'&&s.display!=='none'}
  const li=el.querySelector('li'),lr=li?.getBoundingClientRect();
  const hit=lr&&document.elementFromPoint(lr.x+lr.width/2,lr.y+lr.height/2);
  return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,opacity,visible,hit:!!hit&&el.contains(hit),pointer:getComputedStyle(el).pointerEvents,
  viewport:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight},proxy:p&&{left:p.left,top:p.top,bottom:p.bottom},scroll:(()=>{const r=window.__typstPadView.scrollDOM.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}})(),labels:[...el.querySelectorAll('.cm-completionLabel')].map(x=>x.textContent),selected:el.querySelector('[aria-selected=true] .cm-completionLabel')?.textContent};
})()`);
const waitList = async () => {
  await c.waitFor("!!document.querySelector('.cm-tooltip-autocomplete li')");
  await sleep(180); // CM 默认 interactionDelay 和下一次布局测量。
  return measure();
};
const open = async (source = false, token = "#te") => {
  await sourceMode(source);
  await replace();
  if (!source) await c.waitFor("!!document.querySelector('.document-caret')");
  await c.type(token);
  const box = await waitList();
  evidence.push({ source, box });
  return box;
};
const visible = (box) =>
  box &&
  box.opacity === 1 &&
  box.visible &&
  box.hit &&
  box.width > 20 &&
  box.height > 10 &&
  box.left >= 0 &&
  box.top >= 0 &&
  box.right <= box.viewport.width &&
  box.bottom <= box.viewport.height;
const nearAnchor = (box) =>
  box?.proxy &&
  Math.abs(box.left - box.proxy.left) < 2 &&
  (Math.abs(box.top - box.proxy.bottom) < 5 || Math.abs(box.bottom - box.proxy.top) < 5);

const source = await open(true);
check("源码模式自动激活 Lezer 候选并可见", visible(source), JSON.stringify(source));
await c.key("Tab", { keyCode: 9 });
const sourceTab = await doc();
const document = await open();
check(
  "文档模式自动激活相同候选顺序",
  JSON.stringify(document.labels) === JSON.stringify(source.labels),
  JSON.stringify(document),
);
check("候选真实可见、可命中且不继承透明祖先", visible(document), JSON.stringify(document));
check("候选定位在实际文档输入锚点旁", nearAnchor(document), JSON.stringify(document));
check(
  "透明层正文仍不可见",
  await c.evaluate(
    "getComputedStyle(document.querySelector('.input-proxy')).opacity==='0' && document.querySelector('.input-proxy').contains(window.__typstPadView.dom)",
  ),
);
await c.key("Tab", { keyCode: 9 });
check("Tab 接受结果与源码模式一致", (await doc()) === sourceTab);
const mathSource = await open(true, "$al");
await c.key("Tab", { keyCode: 9 });
const mathAccepted = await doc();
const mathDocument = await open(false, "$al");
check(
  "数学模式自动候选与源码模式一致且在文档锚点可见",
  visible(mathDocument) &&
    nearAnchor(mathDocument) &&
    JSON.stringify(mathDocument.labels) === JSON.stringify(mathSource.labels),
);
await c.key("Tab", { keyCode: 9 });
check(
  "数学候选接受使用相同的源码变更",
  (await doc()) === mathAccepted && mathAccepted.includes("aleph"),
);
await c.evaluate("window.__completionViewIdentity=window.__typstPadView;true");

await open(true);
await c.key("ArrowDown", { keyCode: 40 });
await c.key("ArrowUp", { keyCode: 38 });
const sourceSelected = (await measure()).selected;
await c.key("Enter", { keyCode: 13 });
const sourceEnter = await doc();
await open();
await c.key("ArrowDown", { keyCode: 40 });
await c.key("ArrowUp", { keyCode: 38 });
check("方向键导航与源码候选相同", (await measure()).selected === sourceSelected);
await c.key("Enter", { keyCode: 13 });
check("Enter 接受候选而不是插入段落", (await doc()) === sourceEnter && sourceEnter === sourceTab);

await open();
const point = await c.evaluate(
  "(() => {const r=document.querySelector('.cm-tooltip-autocomplete li').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
);
await c.click(point.x, point.y);
check(
  "鼠标点击接受候选且输入焦点保留",
  (await doc()) === sourceTab && (await c.evaluate("window.__typstPadView.hasFocus")),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
check(
  "候选接受使用同一个撤销历史",
  (await doc()) !== sourceTab &&
    (await c.evaluate("window.__completionViewIdentity===window.__typstPadView")),
);

await open();
const beforeEscape = await doc();
await c.key("Escape", { keyCode: 27 });
check(
  "Esc 关闭候选不改源码/焦点",
  !(await measure()) &&
    (await doc()) === beforeEscape &&
    (await c.evaluate("window.__typstPadView.hasFocus")),
);
await open();
await c.evaluate("window.__typstPadView.contentDOM.blur();true");
await c.waitFor("!document.querySelector('.cm-tooltip-autocomplete')");
check("失焦不残留候选", !(await measure()));
await open();
await sourceMode(true);
check("切换源码模式关闭旧候选", !(await measure()));
await sourceMode(false);
check(
  "模式往返不重建编辑器、不残留候选",
  !(await measure()) &&
    (await c.evaluate("window.__completionViewIdentity===window.__typstPadView")),
);

// 原生光标夹具上的位置切换；透明输入层与候选共用当前视口锚点。
const movedCaret = fixture.carets.find((point) => point.page === 2);
const movedPos = Buffer.from(fixture.doc).subarray(0, movedCaret.offset).toString().length;
await replace(fixture.doc, movedPos);
await c.waitFor("!!document.querySelector('.document-caret')");
await c.type("#te");
const moved = await waitList();
evidence.push({ moved });
check(
  "移动到另一页的光标后候选跟随新锚点",
  visible(moved) && nearAnchor(moved) && Math.abs(moved.proxy.top - document.proxy.top) > 20,
  JSON.stringify(moved),
);

// 候选已打开时缩短视口，官方 tooltip 定位应翻到光标上方。
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(250);
const bottom = await measure();
evidence.push({ bottom });
check(
  "靠底边候选翻转且不越出视口",
  visible(bottom) && bottom.bottom <= bottom.proxy.top + 2,
  JSON.stringify(bottom),
);
await c.screenshot(shotPath("document-completion-bottom"));

await replace(fixture.doc, movedPos);
await c.waitFor("!!document.querySelector('.document-caret')");
const beforeScroll = await c.evaluate(
  "document.querySelector('.input-proxy').getBoundingClientRect().top",
);
await c.evaluate("document.querySelector('.preview-body').scrollTop+=80;true");
await sleep(100);
await c.type("#te");
const scrolled = await waitList();
evidence.push({ scrolled });
check(
  "滚动后的文档光标提供当前视口候选锚点",
  visible(scrolled) && nearAnchor(scrolled) && Math.abs(scrolled.proxy.top - beforeScroll) > 20,
  JSON.stringify(scrolled),
);

// 与缩放 lane 相同的 CDP 引擎布局/DPR模型，不用 CSS zoom，不宣称 Windows IPC。
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 800,
  height: 600,
  deviceScaleFactor: 1.5,
  mobile: false,
});
await replace(fixture.doc, movedPos);
await c.waitFor("!!document.querySelector('.document-caret')");
// 保证目标光标在新物理视口中；离屏光标的候选应由 CM 隐藏而非悬浮到别处。
await c.evaluate("document.querySelector('.preview-body').scrollTop+=200;true");
await sleep(100);
await c.type("#te");
const zoomed = await waitList();
evidence.push({ zoomed });
check(
  "缩放布局/DPR改变后的候选保持可见并跟随光标",
  visible(zoomed) && nearAnchor(zoomed),
  JSON.stringify(zoomed),
);
await c.screenshot(shotPath("document-completion"));

await c.evaluate("window.__browserDevConfirm=true;true");
await c.key("n", { keyCode: 78, modifiers: 2 });
await c.waitFor("window.__typstPadView.state.doc.length===0");
check(
  "新文件不残留候选且不重建视图",
  !(await measure()) &&
    (await c.evaluate("window.__completionViewIdentity===window.__typstPadView")),
);

writeFileSync(
  new URL("../../.browser-check/document-completion.json", import.meta.url),
  JSON.stringify(evidence, null, 2),
);
await c.close();
finish(`通过 ${state.passed} 项检查；文档模式与源码模式补全一致（失败 ${state.failed}）`);
