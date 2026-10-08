// 正常态与原地展开态均消费真实 Typst 整页产物；输入与保存仍使用原文档。
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  loadFixtures,
  createChecker,
  finish,
  sleep,
  shotPath,
  compileSettled,
  COMPILE_IDLE,
} from "./harness.mjs";
const fixtures = loadFixtures("page-fixtures.json", { hint: "先跑 npm run fixtures:pages" });
const [
  original,
  edited,
  mathExpanded,
  _mathEdited,
  tableExpanded,
  imageExpanded,
  whitespaceEdited,
  errorRecovered,
] = fixtures;
const { check, state } = createChecker();
const c = await connect();
const pageQuery =
  "window.__pageSvgs=()=>[...document.querySelectorAll('#preview-host>.document-page')].map(host=>host.shadowRoot.querySelector('svg'));true";
await c.send("Page.addScriptToEvaluateOnNewDocument", { source: pageQuery });
await boot(c, DEV_URL, { pageFixtures: fixtures });
await c.evaluate(pageQuery);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const count = () => c.evaluate("window.__browserDevCallCounts?.compile_doc ?? 0");
const inDocumentMode = () => c.evaluate("!!document.querySelector('.document-pane')");
const settled = async (fixture) => c.waitFor(compileSettled(fixture.doc), { timeout: 8000 });
async function replace(source, renderedSource = source) {
  if (await inDocumentMode()) await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.type(source);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled({ doc: renderedSource });
}
async function hitAt(sourcePart, fixture = original) {
  const at = fixture.doc.indexOf(sourcePart),
    offset = Buffer.byteLength(fixture.doc.slice(0, at));
  const caret = fixture.carets.find(
    (p) => p.offset >= offset && p.offset < offset + Buffer.byteLength(sourcePart),
  );
  if (!caret) throw new Error(`缺少命中探针：${sourcePart}`);
  await c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},b=document.querySelector('.preview-body'),s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal,br=b.getBoundingClientRect(),y=r.top+(p.yPt+p.heightPt/2)*r.height/v.height;b.scrollTop+=y-(br.top+br.height/2);return true})()`,
  );
  await sleep(50);
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return {x:r.left+p.xPt*r.width/v.width+.5,y:r.top+(p.yPt+p.heightPt/2)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  return caret;
}
async function compiledPagesMatch(fixture) {
  return c.evaluate(
    `(() => {const expected=${JSON.stringify(fixture.pages)};const actual=window.__pageSvgs();return actual.length===expected.length && actual.every((svg,i)=>{const host=document.createElement('div');host.innerHTML=expected[i];return svg.isEqualNode(host.firstElementChild)})})()`,
  );
}
check("默认文档模式以完整页面为主体", await inDocumentMode());
await replace(original.doc);
check("每页 SVG 与原生编译结果逐节点一致", await compiledPagesMatch(original));
check(
  "两页与不同纸型保留",
  await c.evaluate("window.__pageSvgs().map(s=>s.viewBox.baseVal.width).join(',')==='360,480'"),
);
check(
  "图片保留在完整页面中",
  await c.evaluate("window.__pageSvgs().some(s=>!!s.querySelector('image'))"),
);
check(
  "没有公式 widget、切片或模拟断行",
  await c.evaluate(
    "!document.querySelector('.cm-math-widget,.cm-block-crop,.cm-block-band,.cm-write-engine-break')",
  ),
);
check(
  "没有单公式或块编译请求",
  await c.evaluate(
    "!(window.__browserDevCallCounts.compile_math || window.__browserDevCallCounts.compile_blocks)",
  ),
);
async function whitespacePoint(probe) {
  await c.evaluate(
    `(() => {const p=${JSON.stringify(probe)},b=document.querySelector('.preview-body'),s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal,br=b.getBoundingClientRect();b.scrollTop+=r.top+(p.yPt-v.y)*r.height/v.height-(br.top+br.height/2);return true})()`,
  );
  await sleep(50);
  return c.evaluate(
    `(() => {const p=${JSON.stringify(probe)},s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return {x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height}})()`,
  );
}
const whitespaceBefore = await count();
for (const [index, label] of [
  [0, "纸张外侧空白"],
  [1, "页内上方空白"],
  [5, "第二页下方空白"],
]) {
  const probe = original.whitespaceHits[index];
  if (!probe?.caret) throw new Error(`缺少真实空白命中探针：${label}`);
  const point = await whitespacePoint(probe);
  if (index === 0)
    await c.evaluate(
      `(() => {let target=document.elementFromPoint(${point.x},${point.y});if(target?.shadowRoot)target=target.shadowRoot.elementFromPoint(${point.x},${point.y});window.__whitespaceTargetOutsideSvg=!target?.closest('svg');return true})()`,
    );
  await c.click(point.x, point.y);
  await c.waitFor(
    `new TextEncoder().encode(window.__typstPadView.state.doc.sliceString(0,window.__typstPadView.state.selection.main.head)).length===${probe.caret.offset} && !!document.querySelector('.document-caret')`,
  );
  check(
    `${label}按原生几何定位光标且不修改源码`,
    (await doc()) === original.doc &&
      (index !== 0 || (await c.evaluate("window.__whitespaceTargetOutsideSvg"))),
  );
}
check(
  "空白点击不重新编译或写盘",
  (await count()) === whitespaceBefore && (await c.evaluate("!window.__browserDevWrites?.length")),
);
const dragPoint = await whitespacePoint(original.whitespaceHits[0]);
await c.drag(dragPoint.x, dragPoint.y, dragPoint.x, dragPoint.y + 20);
await c.waitFor("window.__typstPadView.hasFocus");
check(
  "空白拖动使用源码选区，不修改文档或重新排版",
  (await doc()) === original.doc && (await count()) === whitespaceBefore,
);
async function moveOutAndBack(distance) {
  const base = { x: dragPoint.x, y: dragPoint.y, button: "left", clickCount: 1 };
  await c.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: 1 });
  await c.send("Input.dispatchMouseEvent", {
    ...base,
    y: base.y + distance,
    type: "mouseMoved",
    buttons: 1,
  });
  await c.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 1 });
  await c.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
  await sleep(100);
}
await moveOutAndBack(20);
await c.waitFor("window.__typstPadView.state.selection.main.empty");
check(
  "拖动回到起点收拢选区且不展开源码",
  (await count()) === whitespaceBefore && (await compiledPagesMatch(original)),
);
const hitsBeforeJitter = await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0");
await moveOutAndBack(2);
await c.waitFor(`window.__browserDevCallCounts.document_hit_test===${hitsBeforeJitter + 1}`);
check(
  "轻微手抖仍视为正常点击",
  (await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0")) ===
    hitsBeforeJitter + 1,
);

function textProbe(part) {
  const at = original.doc.indexOf(part);
  if (at < 0) throw new Error(`夹具缺少源码：${part}`);
  const offset = Buffer.byteLength(original.doc.slice(0, at));
  const probe = original.carets.find((p) => p.offset === offset);
  if (!probe) throw new Error(`缺少真实文字探针：${part}`);
  return probe;
}
async function textPoint(probe) {
  return c.evaluate(
    `(() => {const p=${JSON.stringify(probe)},s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return {x:r.left+(p.xPt-v.x)*r.width/v.width+.5,y:r.top+(p.yPt-v.y+p.heightPt/2)*r.height/v.height}})()`,
  );
}
const selectionBytes = (anchor, head) =>
  `(() => {const v=window.__typstPadView,s=v.state.selection.main,b=p=>new TextEncoder().encode(v.state.doc.sliceString(0,p)).length;return b(s.anchor)===${anchor} && b(s.head)===${head}})()`;
const startProbe = textProbe("正文含");
const endProbe = textProbe("emoji");
await whitespacePoint(startProbe);
const startPoint = await textPoint(startProbe);
const endPoint = await textPoint(endProbe);
const beforeSelection = await count();
await c.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  ...startPoint,
  button: "left",
  buttons: 1,
  clickCount: 1,
});
await sleep(450);
await c.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  ...endPoint,
  button: "left",
  buttons: 1,
});
await c.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  ...endPoint,
  button: "left",
  buttons: 0,
  clickCount: 1,
});
await c.waitFor(
  `${selectionBytes(startProbe.offset, endProbe.offset)} && !!document.querySelector('.document-selection path')`,
);
check("按住鼠标后拖动选中中文，anchor/head 与真实 UTF-8 命中一致", (await doc()) === original.doc);
await c.screenshot(shotPath("document-drag-selection"));
const selectionPathBefore = await c.evaluate(
  "document.querySelector('.document-selection path').getAttribute('d')",
);
check("选区高亮来自真实帧几何且不修改原生 SVG", await compiledPagesMatch(original));
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1000,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await c.waitFor(
  `document.querySelector('.document-selection path')?.getAttribute('d')!==${JSON.stringify(selectionPathBefore)}`,
);
check("窗口缩放同步选区和光标，不触发编译", (await count()) === beforeSelection);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(100);
await c.drag(
  (await textPoint(endProbe)).x,
  (await textPoint(endProbe)).y,
  (await textPoint(startProbe)).x,
  (await textPoint(startProbe)).y,
);
await c.waitFor(selectionBytes(endProbe.offset, startProbe.offset));
check("反向拖动保留按下端点，不反转源码内容", (await doc()) === original.doc);
const contextPoint = await textPoint(startProbe);
await c.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  ...contextPoint,
  button: "right",
  buttons: 2,
  clickCount: 1,
});
await c.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  ...contextPoint,
  button: "right",
  buttons: 0,
  clickCount: 1,
});
await c.waitFor("!!document.querySelector('.context-menu')");
check(
  "文档右键菜单使用源码选区启用复制和剪切",
  await c.evaluate(
    "['剪切','复制'].every(label=>[...document.querySelectorAll('.context-menu button')].some(b=>b.textContent.trim()===label && !b.disabled))",
  ),
);
await c.evaluate(
  "[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent.trim()==='复制').click()",
);
check(
  "拖选后复制原始源码而非 SVG 或选区标记",
  await c.evaluate("window.__browserDevCopied.at(-1)==='正文含中文与 '"),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor("!document.querySelector('.document-pane')");
check(
  "切到源码模式保留真实选区",
  await c.evaluate(selectionBytes(endProbe.offset, startProbe.offset)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor("!!document.querySelector('.document-selection path')");
check("返回文档模式恢复选区高亮而不重新编译", (await count()) === beforeSelection);
await whitespacePoint(startProbe);
const acrossStart = await textPoint(startProbe);
await c.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  ...acrossStart,
  button: "left",
  buttons: 1,
  clickCount: 1,
});
await c.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: acrossStart.x + 10,
  y: acrossStart.y,
  button: "left",
  buttons: 1,
});
// 页面滚动时重新换算坐标；pointer capture 保持同一个按下锚点。
await whitespacePoint(textProbe("第二页使用"));
const visibleEnd = await textPoint(textProbe("第二页使用"));
await c.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  ...visibleEnd,
  button: "left",
  buttons: 1,
});
await c.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  ...visibleEnd,
  button: "left",
  buttons: 0,
  clickCount: 1,
});
await c.waitFor(selectionBytes(startProbe.offset, textProbe("第二页使用").offset));
check(
  "跨行跨页拖选不自动展开穿过的公式或脚本",
  (await count()) === beforeSelection && (await compiledPagesMatch(original)),
);
// 让手势离开预览区，验证捕获和自动滚动，松开之后滚动必须停止。
await whitespacePoint(startProbe);
const edgeStart = await textPoint(startProbe);
const previewBottom = await c.evaluate(
  "document.querySelector('.preview-body').getBoundingClientRect().bottom",
);
await c.send("Input.dispatchMouseEvent", {
  type: "mousePressed",
  ...edgeStart,
  button: "left",
  buttons: 1,
  clickCount: 1,
});
const scrollAtEdgeStart = await c.evaluate("document.querySelector('.preview-body').scrollTop");
await c.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: edgeStart.x,
  y: previewBottom + 10,
  button: "left",
  buttons: 1,
});
await c.waitFor(`document.querySelector('.preview-body').scrollTop>${scrollAtEdgeStart + 40}`);
await c.send("Input.dispatchMouseEvent", {
  type: "mouseReleased",
  x: edgeStart.x,
  y: previewBottom + 10,
  button: "left",
  buttons: 0,
  clickCount: 1,
});
await sleep(100);
const stoppedScroll = await c.evaluate("document.querySelector('.preview-body').scrollTop");
await sleep(150);
check(
  "离开预览边缘仍可拖选，松开后停止自动滚动",
  (await c.evaluate("document.querySelector('.preview-body').scrollTop")) === stoppedScroll,
);
await whitespacePoint(startProbe);
await c.click((await textPoint(startProbe)).x, (await textPoint(startProbe)).y);
await c.waitFor(
  "window.__typstPadView.state.selection.main.empty && !document.querySelector('.document-selection') && !!document.querySelector('.document-caret')",
);
check(
  "单击收拢选区并恢复独立光标",
  await c.evaluate(selectionBytes(startProbe.offset, startProbe.offset)),
);
await c.key("ArrowRight", { keyCode: 39 });
const nextCaret = original.carets.find(
  (p) => p.offset === startProbe.offset + Buffer.byteLength("正"),
);
if (!nextCaret) throw new Error("缺少中文下一字符的真实光标探针");
await c.waitFor(
  `${selectionBytes(nextCaret.offset, nextCaret.offset)} && (()=>{const p=${JSON.stringify(nextCaret)},s=window.__pageSvgs()[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal,c=document.querySelector('.document-caret')?.getBoundingClientRect();return c && Math.abs(c.left-r.left-(p.xPt-v.x)*r.width/v.width)<1 && Math.abs(c.top-r.top-(p.yPt-v.y)*r.height/v.height)<1})()`,
);
check("键盘光标按中文字符移动且叠加位置与真实几何一致", (await count()) === beforeSelection);
await c.drag(
  (await textPoint(endProbe)).x,
  (await textPoint(endProbe)).y,
  (await textPoint(startProbe)).x,
  (await textPoint(startProbe)).y,
);
await c.waitFor(selectionBytes(endProbe.offset, startProbe.offset));
await c.type("修改后的正文含中文与 ");
await settled(edited);
check(
  "拖选后输入替换真实源码选区，不写入临时高亮内容",
  (await doc()) === edited.doc &&
    (await compiledPagesMatch(edited)) &&
    (await c.evaluate("!window.__browserDevWrites?.length")),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(original);
check("拖动选区不产生额外撤销步骤", (await doc()) === original.doc);
const macroProbe = original.whitespaceHits.find((probe) => probe.name === "macro-side");
if (!macroProbe?.caret?.isWhitespace) throw new Error("缺少宏输出旁的真实空白探针");
const macroPoint = await whitespacePoint(macroProbe);
const beforeMacroWhitespace = await count();
await c.click(macroPoint.x, macroPoint.y);
await c.waitFor(
  `new TextEncoder().encode(window.__typstPadView.state.doc.sliceString(0,window.__typstPadView.state.selection.main.head)).length===${macroProbe.caret.offset} && window.__typstPadView.hasFocus`,
);
check(
  "宏输出旁空白只移动光标，不触发源码展开或重新排版",
  (await count()) === beforeMacroWhitespace &&
    (await compiledPagesMatch(original)) &&
    (await doc()) === original.doc,
);
const scrollBeforeRepeat = await c.evaluate("document.querySelector('.preview-body').scrollTop");
await c.click(macroPoint.x, macroPoint.y);
await c.waitFor("window.__typstPadView.hasFocus");
check(
  "重复空白点击保留输入焦点且不跳滚动位置",
  Math.abs(
    (await c.evaluate("document.querySelector('.preview-body').scrollTop")) - scrollBeforeRepeat,
  ) < 1 && (await count()) === beforeMacroWhitespace,
);
const hitsBeforeTouch = await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0");
await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [macroPoint] });
await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await c.waitFor(
  `window.__browserDevCallCounts.document_hit_test===${hitsBeforeTouch + 1} && window.__typstPadView.hasFocus`,
);
await c.send("Emulation.setTouchEmulationEnabled", { enabled: false });
check(
  "触屏轻触不会被抬指后的 leave 误判为拖动",
  (await count()) === beforeMacroWhitespace && (await doc()) === original.doc,
);
const inputProbe = original.whitespaceHits[5];
const inputPoint = await whitespacePoint(inputProbe);
await c.click(inputPoint.x, inputPoint.y);
await c.waitFor(
  `new TextEncoder().encode(window.__typstPadView.state.doc.sliceString(0,window.__typstPadView.state.selection.main.head)).length===${inputProbe.caret.offset} && window.__typstPadView.hasFocus`,
);
await c.type("续");
await settled(whitespaceEdited);
check(
  "空白定位后可直接输入，仍通过唯一源码由 Typst 排版",
  (await doc()) === whitespaceEdited.doc && (await compiledPagesMatch(whitespaceEdited)),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(original);
check(
  "空白定位后的输入可撤销且没有隐式写盘",
  (await doc()) === original.doc &&
    (await compiledPagesMatch(original)) &&
    (await c.evaluate("!window.__browserDevWrites?.length")),
);
const beforeCompile = await count();
await c.evaluate("window.__unchangedPage=window.__pageSvgs()[1];true");
const mathCaret = await hitAt("x^2");
await settled(mathExpanded);
check("展开公式调用整页编译", (await count()) === beforeCompile + 1);
check("展开态与真实 Typst 完整产物一致", await compiledPagesMatch(mathExpanded));
check(
  "单页变化保留未变页面的 SVG 节点与独立引用作用域",
  original.pages[1] === mathExpanded.pages[1] &&
    (await c.evaluate(
      "window.__unchangedPage===window.__pageSvgs()[1] && window.__pageSvgs()[0].getRootNode()!==window.__pageSvgs()[1].getRootNode()",
    )),
);
check(
  "增量 IPC 只传变化页，前端仍展示完整原生产物",
  await c.evaluate(
    "window.__browserDevLastPagePayload.sent===1 && window.__browserDevLastPagePayload.reused===1 && window.__browserDevLastCompile.knownPages?.length===2",
  ),
);
check("展开没有修改原文档", (await doc()) === original.doc);
check(
  "点击公式定位到原文档 UTF-8 位置",
  await c.evaluate(
    `new TextEncoder().encode(window.__typstPadView.state.doc.sliceString(0,window.__typstPadView.state.selection.main.head)).length===${mathCaret.offset}`,
  ),
);
check(
  "浏览器源码视图只作为透明输入层",
  await c.evaluate(
    "getComputedStyle(document.querySelector('.editor-pane')).opacity==='0' && !document.querySelector('.source-overlay,.source-header')",
  ),
);
check(
  "光标保留在独立交互层",
  await c.evaluate(
    "!!document.querySelector('.preview-canvas>.document-caret') && !window.__pageSvgs().some(s=>s.querySelector('.document-caret'))",
  ),
);
const textFrom = original.doc.indexOf("正文含中文");
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:${textFrom},head:${textFrom + "正文含中文".length}}})`,
);
await c.type("修改后的正文含中文");
await settled(edited);
check("真实输入修改唯一源文档", (await doc()) === edited.doc);
check("光标在展开范围外编辑后自动恢复正常排版", await compiledPagesMatch(edited));
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(original);
check(
  "范围外编辑撤销恢复原文和完整产物，不重新打开旧展开",
  (await doc()) === original.doc && (await compiledPagesMatch(original)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(edited);
check(
  "范围外编辑重做保持当前光标的正常排版",
  (await doc()) === edited.doc && (await compiledPagesMatch(edited)),
);
await c.key("Escape", { keyCode: 27 });
await settled(edited);
check("收起重新编译正常排版", await compiledPagesMatch(edited));
check("展开与收起均不写盘", await c.evaluate("!window.__browserDevWrites?.length"));
await replace(original.doc);
await hitAt("甲");
await settled(tableExpanded);
check("表格输出原地展开完整脚本", await compiledPagesMatch(tableExpanded));
await c.key("Escape", { keyCode: 27 }); // 收起源码：只留 Esc，右上角按钮已随"文档模式只有文档"删除
await settled(original);
await hitAt("#image(");
await settled(imageExpanded);
check("图片调用起点展开完整脚本", await compiledPagesMatch(imageExpanded));
await c.key("Escape", { keyCode: 27 });
await settled(original);
const beforeLinkHits = await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0");
await hitAt("页面链接");
check(
  "Shadow DOM 页内外链仍打开系统浏览器，不提交源码命中",
  (await c.evaluate("window.__browserDevOpenUrls?.includes('https://typst.app')")) &&
    (await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0")) === beforeLinkHits,
);
await c.evaluate("window.__savedView=window.__typstPadView;true");
await c.key("e", { keyCode: 69, modifiers: 2 });
check(
  "源码模式复用同一个编辑器",
  await c.evaluate(
    "window.__savedView===window.__typstPadView && !document.querySelector('.input-proxy')",
  ),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
check(
  "正常态模式往返保留源码与完整页面",
  (await doc()) === original.doc && (await compiledPagesMatch(original)),
);
const beforeResize = await count();
const widePageWidth = await c.evaluate("window.__pageSvgs()[0].getBoundingClientRect().width");
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 760,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(700); // 重排请求有 250ms 去抖，之后再重编译
check(
  "窄窗口按新栏宽重排（页宽是编译期输入 → 会重编译）",
  (await compiledPagesMatch(original)) && (await count()) > beforeResize,
);
const narrowPageWidth = await c.evaluate("window.__pageSvgs()[0].getBoundingClientRect().width");
check(
  "窗口变窄后页面跟着缩窄且不超出栏宽",
  narrowPageWidth < widePageWidth &&
    (await c.evaluate(
      "(() => {const b=document.querySelector('.preview-body'),s=window.__pageSvgs()[0].getBoundingClientRect();return s.width<=b.clientWidth+1})()",
    )),
  `纸 ${narrowPageWidth.toFixed(1)}px / 原 ${widePageWidth.toFixed(1)}px`,
);
check(
  "页面等比缩放且没有横向溢出",
  await c.evaluate(
    "(() => {const b=document.querySelector('.preview-body'),s=window.__pageSvgs()[0],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return b.scrollWidth<=b.clientWidth+1 && Math.abs(r.width/r.height-v.width/v.height)<.001})()",
  ),
);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(100);
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(150);
check(
  "缩放不再把页面撑出栏宽，档位进状态栏",
  (await c.evaluate(
    "(() => {const b=document.querySelector('.preview-body'),s=window.__pageSvgs()[0].getBoundingClientRect();return b.scrollWidth<=b.clientWidth+1 && s.width<=b.clientWidth+1})()",
  )) && (await c.evaluate("document.querySelector('.statusbar').textContent.includes('110%')")),
);
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
await sleep(100);
await replace(errorRecovered.brokenDoc, errorRecovered.doc);
check(
  "错误区域显示源码，其余页面与真实恢复产物逐节点一致",
  await compiledPagesMatch(errorRecovered),
);
check(
  "错误回退不修改原文，且继续显示诊断",
  (await doc()) === errorRecovered.brokenDoc &&
    (await c.evaluate("document.querySelectorAll('.error-count')[0].textContent !== '0'")),
);
const beforeErrorClick = await count();
const recoveredCaret = await hitAt("unknown", errorRecovered);
await settled(errorRecovered);
check(
  "错误源码可以命中原文档位置，点击不清除诊断",
  await c.evaluate(
    `document.querySelectorAll('.error-count')[0].textContent !== '0' && window.__typstPadView.state.selection.main.head === ${errorRecovered.brokenDoc.indexOf("unknown") + Buffer.from(errorRecovered.doc).subarray(0, recoveredCaret.offset).toString().length - errorRecovered.doc.indexOf("unknown")}`,
  ),
);
check("点击已经显示的错误源码不重复编译", (await count()) === beforeErrorClick);
await c.evaluate(
  `(() => {const v=window.__typstPadView,doc=v.state.doc.toString(),at=doc.indexOf('unknown');v.dispatch({changes:{from:at,to:at+7,insert:'x^2 + y'}})})()`,
);
await settled(mathExpanded);
check(
  "修复后清除诊断但保留正在编辑的源码，原文不含临时围栏",
  (await doc()) === original.doc &&
    (await compiledPagesMatch(mathExpanded)) &&
    (await c.evaluate("document.querySelectorAll('.error-count')[0].textContent === '0'")),
);
await c.evaluate(
  `(() => {const v=window.__typstPadView,at=v.state.doc.toString().indexOf('x^2 + y');v.dispatch({changes:{from:at,to:at+7,insert:'unknown'}})})()`,
);
await settled(errorRecovered);
check(
  "保留源码继续输入仍诊断原文，不把新错误隐藏在 raw 中",
  (await compiledPagesMatch(errorRecovered)) &&
    (await c.evaluate("document.querySelectorAll('.error-count')[0].textContent !== '0'")),
);
await c.evaluate(
  `(() => {const v=window.__typstPadView,at=v.state.doc.toString().indexOf('unknown');v.dispatch({changes:{from:at,to:at+7,insert:'x^2 + y'}})})()`,
);
await settled(mathExpanded);
await c.key("Escape", { keyCode: 27 });
await settled(original);
check("Esc 收起修好的错误源码并恢复正常完整排版", await compiledPagesMatch(original));
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(errorRecovered);
check(
  "撤销修复重新显示错误源码",
  (await doc()) === errorRecovered.brokenDoc && (await compiledPagesMatch(errorRecovered)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await settled({ doc: errorRecovered.brokenDoc });
check(
  "源码模式仍编译原文并保留错误",
  !(await inDocumentMode()) &&
    (await c.evaluate("document.querySelectorAll('.error-count')[0].textContent !== '0'")),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await settled(errorRecovered);
check("返回文档模式重新启用错误区域回退", await compiledPagesMatch(errorRecovered));
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(original);
check(
  "重做修复自动恢复正常排版",
  (await doc()) === original.doc && (await compiledPagesMatch(original)),
);
await replace(errorRecovered.brokenDoc, errorRecovered.doc);
await hitAt("unknown", errorRecovered);
await c.evaluate(
  `(() => {const v=window.__typstPadView,at=v.state.doc.toString().indexOf('unknown');v.dispatch({changes:{from:at,to:at+7,insert:'x^2 + y'}})})()`,
);
await settled(mathExpanded);
await c.evaluate(
  "window.__typstPadView.dispatch({selection:{anchor:window.__typstPadView.state.doc.toString().indexOf('正文含')}})",
);
await settled(original);
check("光标移出修好的错误区域自动收起源码", await compiledPagesMatch(original));
const beforeFailure = await c.evaluate("window.__pageSvgs().map(s=>s.outerHTML).join('')");
await replace("DIAG-EXTERNAL-ERROR-MARKER");
check(
  "外部文件错误无法局部回退时保留上次完整结果",
  (await c.evaluate("window.__pageSvgs().map(s=>s.outerHTML).join('')")) === beforeFailure,
);
check(
  "失败只在状态栏报错（预览区不再画错误框）",
  await c.evaluate(
    `document.querySelector('.status-text').textContent.includes('编译错误') &&
     document.querySelectorAll('.error-count')[0].textContent !== '0' &&
     !document.querySelector('.preview-error, .preview-notice, .preview-placeholder')`,
  ),
);
const hitsBefore = await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0");
await hitAt("x^2");
await sleep(100);
check(
  "旧产物禁用源码命中",
  (await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0")) === hitsBefore &&
    (await c.evaluate(
      "document.querySelector('.status-text').textContent.includes('请先修正编译错误')",
    )),
);
await replace(original.doc);
check(
  "修复后错误清零且恢复当前产物",
  (await compiledPagesMatch(original)) &&
    (await c.evaluate("document.querySelectorAll('.error-count')[0].textContent === '0'")),
);
const imeBefore = await count();
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));window.__typstPadView.dispatch({changes:{from:0,insert:'合成中'}})",
);
await sleep(250);
check(
  "输入法合成期间不启动编译",
  (await doc()).startsWith("合成中") && (await count()) === imeBefore,
);
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))",
);
await c.waitFor(`window.__browserDevCallCounts.compile_doc>${imeBefore}`);
check("合成结束合并编译", (await count()) === imeBefore + 1);
await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await replace(original.doc);
const recoveryImeBefore = await count();
await c.evaluate(
  `window.__typstPadView.dispatch({changes:{from:0,to:window.__typstPadView.state.doc.length,insert:${JSON.stringify(errorRecovered.brokenDoc)}}})`,
);
await c.waitFor("window.__typstPadScheduleStats?.().inFlight === true");
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))",
);
await c.waitFor(
  "(() => {const s=window.__typstPadScheduleStats?.();return s?.composing && !s.inFlight})()",
);
check(
  "在途失败遇到输入法合成时不启动恢复重试",
  (await count()) === recoveryImeBefore + 1 &&
    (await c.evaluate("window.__typstPadScheduleStats?.().pending === true")),
);
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))",
);
await settled(errorRecovered);
check("合成结束重新诊断并恢复错误源码", await compiledPagesMatch(errorRecovered));
await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await replace(original.doc);
await whitespacePoint(startProbe);
await c.drag(
  (await textPoint(startProbe)).x,
  (await textPoint(startProbe)).y,
  (await textPoint(endProbe)).x,
  (await textPoint(endProbe)).y,
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await sleep(800);
check(
  "模式切换作废在途拖选，不回写迟到选区",
  await c.evaluate(
    "window.__typstPadView.state.selection.main.empty && !document.querySelector('.document-selection')",
  ),
);
await replace(original.doc);
await whitespacePoint(startProbe);
await c.drag(
  (await textPoint(startProbe)).x,
  (await textPoint(startProbe)).y,
  (await textPoint(endProbe)).x,
  (await textPoint(endProbe)).y,
);
await c.evaluate(
  "window.__typstPadView.dispatch({changes:{from:0,insert:'新'},selection:{anchor:1}})",
);
await c.waitFor(COMPILE_IDLE, { timeout: 8000 });
check(
  "编辑作废在途拖选和高亮查询",
  await c.evaluate(
    "window.__typstPadView.state.selection.main.head===1 && window.__typstPadView.state.selection.main.empty && !document.querySelector('.document-selection')",
  ),
);
await replace(original.doc);
await hitAt("x^2");
await c.evaluate(
  "window.__typstPadView.dispatch({changes:{from:0,insert:'新'},selection:{anchor:1}})",
);
await sleep(500);
// 旧的判据是 `!document.querySelector('.close-source')`（右上角按钮不存在）—— 按钮删除后
// 它会**永真**，等于这道门禁失效。改为等调度器排空后查实际编译输入：
// 迟到命中若错误地展开旧源码，会立刻发起一次带 raw 围栏的整页编译。
await c.waitFor(COMPILE_IDLE, { timeout: 8000 });
check(
  "迟到命中不能展开旧源码",
  await c.evaluate(
    "window.__typstPadView.state.selection.main.head===1 && !window.__browserDevLastCompile.src.includes('`')",
  ),
);
await replace(original.doc);
await c.evaluate("window.__browserDevConfirm=true");
await c.key("n", { keyCode: 78, modifiers: 2 });
await c.waitFor(
  "window.__typstPadView.state.doc.length===0 && !window.__typstPadScheduleStats().inFlight && !window.__typstPadScheduleStats().pending",
  { timeout: 8000 },
);
check(
  "切换文件清除旧产物与编辑镜像",
  (await doc()) === "" &&
    (await c.evaluate(
      "window.__browserDevLastCompile.src==='' && window.__browserDevLastCompile.knownPages===null",
    )),
);
check("没有脚本异常", await c.evaluate("!document.body.innerText.includes('脚本错误')"));
await c.screenshot(shotPath("document-mode-full-pages"));
await c.close();
finish(`通过 ${state.passed} 项检查；真实整页 + Typst 原地源码展开`);
