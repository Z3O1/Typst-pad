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
const [original, edited, mathExpanded, mathEdited, tableExpanded, imageExpanded] = fixtures;
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL, { pageFixtures: fixtures });
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
async function replace(source) {
  if (await inDocumentMode()) await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.type(source);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled({ doc: source });
}
async function hitAt(sourcePart, fixture = original) {
  const at = fixture.doc.indexOf(sourcePart),
    offset = Buffer.byteLength(fixture.doc.slice(0, at));
  const caret = fixture.carets.find(
    (p) => p.offset >= offset && p.offset < offset + Buffer.byteLength(sourcePart),
  );
  if (!caret) throw new Error(`缺少命中探针：${sourcePart}`);
  await c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},b=document.querySelector('.preview-body'),s=document.querySelectorAll('#preview-host>svg')[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal,br=b.getBoundingClientRect(),y=r.top+(p.yPt+p.heightPt/2)*r.height/v.height;b.scrollTop+=y-(br.top+br.height/2);return true})()`,
  );
  await sleep(50);
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},s=document.querySelectorAll('#preview-host>svg')[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return {x:r.left+p.xPt*r.width/v.width+.5,y:r.top+(p.yPt+p.heightPt/2)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  return caret;
}
async function compiledPagesMatch(fixture) {
  return c.evaluate(
    `(() => {const expected=${JSON.stringify(fixture.pages)};const actual=[...document.querySelectorAll('#preview-host>svg')];return actual.length===expected.length && actual.every((svg,i)=>{const host=document.createElement('div');host.innerHTML=expected[i];const copy=svg.cloneNode(true);copy.removeAttribute('style');return copy.isEqualNode(host.firstElementChild)})})()`,
  );
}
check("默认文档模式以完整页面为主体", await inDocumentMode());
await replace(original.doc);
check("每页 SVG 与原生编译结果逐节点一致", await compiledPagesMatch(original));
check(
  "两页与不同纸型保留",
  await c.evaluate(
    "[...document.querySelectorAll('#preview-host>svg')].map(s=>s.viewBox.baseVal.width).join(',')==='360,480'",
  ),
);
check("图片保留在完整页面中", await c.evaluate("!!document.querySelector('#preview-host image')"));
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
    `(() => {const p=${JSON.stringify(probe)},b=document.querySelector('.preview-body'),s=document.querySelectorAll('#preview-host>svg')[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal,br=b.getBoundingClientRect();b.scrollTop+=r.top+(p.yPt-v.y)*r.height/v.height-(br.top+br.height/2);return true})()`,
  );
  await sleep(50);
  return c.evaluate(
    `(() => {const p=${JSON.stringify(probe)},s=document.querySelectorAll('#preview-host>svg')[p.page-1],r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return {x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height}})()`,
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
      `window.__whitespaceTargetOutsideSvg=!document.elementFromPoint(${point.x},${point.y})?.closest('svg');true`,
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
const hitsBeforeDrag = await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0");
await c.drag(dragPoint.x, dragPoint.y, dragPoint.x, dragPoint.y + 20);
await sleep(100);
check(
  "拖动空白不触发光标命中",
  (await c.evaluate("window.__browserDevCallCounts.document_hit_test ?? 0")) === hitsBeforeDrag,
);
const beforeCompile = await count();
const mathCaret = await hitAt("x^2");
await settled(mathExpanded);
check("展开公式调用整页编译", (await count()) === beforeCompile + 1);
check("展开态与真实 Typst 完整产物一致", await compiledPagesMatch(mathExpanded));
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
    "!!document.querySelector('.preview-canvas>.document-caret') && !document.querySelector('#preview-host .document-caret')",
  ),
);
const textFrom = original.doc.indexOf("正文含中文");
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:${textFrom},head:${textFrom + "正文含中文".length}}})`,
);
await c.type("修改后的正文含中文");
await settled(mathEdited);
check("真实输入修改唯一源文档", (await doc()) === edited.doc);
check("展开态编辑后重新由 Typst 排版", await compiledPagesMatch(mathEdited));
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(mathExpanded);
check(
  "展开态撤销恢复原文和完整产物",
  (await doc()) === original.doc && (await compiledPagesMatch(mathExpanded)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(mathEdited);
check(
  "展开态重做恢复原文和完整产物",
  (await doc()) === edited.doc && (await compiledPagesMatch(mathEdited)),
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
const widePageWidth = await c.evaluate(
  "document.querySelector('#preview-host>svg').getBoundingClientRect().width",
);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 760,
  height: 640,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(150);
check(
  "窄窗口只缩放且不重新编译",
  (await compiledPagesMatch(original)) && (await count()) === beforeResize,
);
const narrowPageWidth = await c.evaluate(
  "document.querySelector('#preview-host>svg').getBoundingClientRect().width",
);
check("窗口变窄后页面继续缩小", narrowPageWidth < widePageWidth * 0.8);
check(
  "页面等比缩放且没有横向溢出",
  await c.evaluate(
    "(() => {const b=document.querySelector('.preview-body'),s=document.querySelector('#preview-host>svg'),r=s.getBoundingClientRect(),v=s.viewBox.baseVal;return b.scrollWidth<=b.clientWidth+1 && Math.abs(r.width/r.height-v.width/v.height)<.001})()",
  ),
);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(100);
const pageAt100 = await c.evaluate(
  "document.querySelector('#preview-host>svg').getBoundingClientRect().width",
);
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(100);
const pageAt110 = await c.evaluate(
  "document.querySelector('#preview-host>svg').getBoundingClientRect().width",
);
check("用户缩放继续影响页面内容", pageAt110 > pageAt100 * 1.05);
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
await sleep(100);
const beforeFailure = await c.evaluate("document.querySelector('#preview-host').innerHTML");
await replace("DIAG-ERROR-MARKER");
check(
  "编译失败保留上次完整结果",
  (await c.evaluate("document.querySelector('#preview-host').innerHTML")) === beforeFailure,
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
  (await doc()) === "" && (await c.evaluate("window.__browserDevLastCompile.src===''")),
);
check("没有脚本异常", await c.evaluate("!document.body.innerText.includes('脚本错误')"));
await c.screenshot(shotPath("document-mode-full-pages"));
await c.close();
finish(`通过 ${state.passed} 项检查；真实整页 + Typst 原地源码展开`);
