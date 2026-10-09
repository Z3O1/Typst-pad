// 不只验证“有光标”：逐字素对照真实 Typst 光标与 Chromium 变换后的盒模型，并检查实际像素。
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  loadFixtures,
  createChecker,
  finish,
  compileSettled,
  COMPILE_IDLE,
  sleep,
  shotPath,
} from "./harness.mjs";
const cursorFixtures = loadFixtures("cursor-fixtures.json", {
  predicate: (fixtures) =>
    fixtures.length === 6 && fixtures.every((f) => f.cursorQueries?.length && f.pages.length),
  hint: "先跑 npm run fixtures:pages",
});
const pageFixtures = loadFixtures("page-fixtures.json");
const fixtures = [...pageFixtures, ...cursorFixtures];
const fixture = (name) => {
  const f = cursorFixtures.find((f) => f.name === name);
  if (!f) throw new Error(`缺少光标夹具：${name}`);
  return f;
};
const mixed = fixture("mixed"),
  edited = fixture("edited");
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
const count = () => c.evaluate("window.__browserDevCallCounts.compile_doc ?? 0");
const settled = (f) => c.waitFor(compileSettled(f.doc), { timeout: 8000 });
check(
  "未聚焦输入层时不显示幽灵光标",
  await c.evaluate("!window.__typstPadView.hasFocus && !document.querySelector('.document-caret')"),
);

async function replace(f) {
  if (await c.evaluate("!!document.querySelector('.document-pane')"))
    await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  if (f.doc) await c.type(f.doc);
  else await c.key("Backspace", { keyCode: 8 });
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled(f);
}
function queryAt(f, offset) {
  const query = f.cursorQueries.find((q) => q.offset === offset);
  if (!query) throw new Error(`缺少原生源码光标查询：${f.name}:${offset}`);
  return query;
}
function byteAt(f, part) {
  const pos = f.doc.indexOf(part);
  if (pos < 0) throw new Error(`缺少测试片段：${f.name}:${part}`);
  return Buffer.byteLength(f.doc.slice(0, pos));
}
const utf16At = (f, offset) => Buffer.from(f.doc).subarray(0, offset).toString().length;

// CSS 内联值只用于等重测完成；真正断言用 CDP 盒模型，包含 transform 后的四角。
const expectedExpression = (caret) => `(() => {
  const p=${JSON.stringify(caret)},host=document.querySelectorAll('#preview-host>.document-page')[p.page-1];
  if(!host)throw Error('光标目标页缺失');const r=host.getBoundingClientRect(),v=host.shadowRoot.querySelector('svg').viewBox.baseVal;
  const angle=(p.rotationDeg??0)*Math.PI/180,dx=-Math.sin(angle)*p.heightPt*r.width/v.width,dy=Math.cos(angle)*p.heightPt*r.height/v.height;
  return {x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height,dx,dy,height:Math.max(2,Math.hypot(dx,dy))};
})()`;
const caretReady = (caret) =>
  `(() => {const p=${expectedExpression(caret)},el=document.querySelector('.document-caret'),root=document.querySelector('.preview-canvas').getBoundingClientRect();return el && Math.abs(parseFloat(el.style.left)+root.left-p.x)<.05 && Math.abs(parseFloat(el.style.top)+root.top-p.y)<.05 && Math.abs(parseFloat(el.style.height)-p.height)<.05})()`;
async function assertBox(caret, label) {
  const expected = await c.evaluate(expectedExpression(caret));
  const root = await c.send("DOM.getDocument", { depth: 0 });
  const node = await c.send("DOM.querySelector", {
    nodeId: root.root.nodeId,
    selector: ".document-caret",
  });
  if (!node.nodeId) throw new Error(`光标节点丢失：${label}`);
  const { model } = await c.send("DOM.getBoxModel", { nodeId: node.nodeId });
  const actual = model.border;
  const errors = [
    actual[0] - expected.x,
    actual[1] - expected.y,
    actual[6] - actual[0] - expected.dx,
    actual[7] - actual[1] - expected.dy,
  ];
  if (errors.some((error) => Math.abs(error) > 0.2))
    throw new Error(`光标像素坐标偏移：${label} ${JSON.stringify({ actual, expected, errors })}`);
  return model;
}
async function pose(f, query, { dispatch = true, scroll = true } = {}) {
  if (dispatch)
    await c.evaluate(
      `(() => {const v=window.__typstPadView;v.dispatch({selection:{anchor:${utf16At(f, query.offset)}}});v.focus();return true})()`,
    );
  if (!query.caret) {
    await c.waitFor("!document.querySelector('.document-caret')", { timeout: 2500, interval: 16 });
    return null;
  }
  if (scroll)
    await c.evaluate(
      `(() => {const p=${expectedExpression(query.caret)},b=document.querySelector('.preview-body'),r=b.getBoundingClientRect();b.scrollTop+=p.y-(r.top+r.height/2);return true})()`,
    );
  await c.waitFor(caretReady(query.caret), { timeout: 2500, interval: 16 });
  return assertBox(query.caret, `${f.name}:${query.offset}`);
}
async function compiledPagesMatch(f) {
  return c.evaluate(
    `(() => {const expected=${JSON.stringify(f.pages)},hosts=[...document.querySelectorAll('#preview-host>.document-page')];return hosts.length===expected.length && hosts.every((host,i)=>{const div=document.createElement('div');div.innerHTML=expected[i];return host.shadowRoot.querySelector('svg').isEqualNode(div.firstElementChild)})})()`,
  );
}
async function showBlink() {
  await c.evaluate(
    "document.querySelector('.document-caret').getAnimations().forEach(a=>{a.pause();a.currentTime=0});true",
  );
}
let checkedStops = 0,
  hiddenStops = 0;
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
for (const name of ["mixed", "raw", "whitespace"]) {
  const f = fixture(name);
  await replace(f);
  check(`${name}：光标测试使用完整真实 SVG`, await compiledPagesMatch(f));
  let mapped = 0;
  for (const part of f.parts) {
    const start = f.doc.indexOf(part);
    if (start < 0) throw new Error(`缺少片段：${part}`);
    const text = part.startsWith("换行测试：")
      ? f.doc.slice(start, f.doc.indexOf("\n\n", start))
      : part;
    for (const { index } of segmenter.segment(text)) {
      const query = queryAt(f, Buffer.byteLength(f.doc.slice(0, start + index)));
      await pose(f, query);
      if (query.caret) {
        mapped++;
        checkedStops++;
      } else hiddenStops++;
    }
  }
  if (mapped === 0) throw new Error(`不允许用零光标几何验收：${name}`);
  // 空白/围栏/无可映射内容的位置不应沿用上一个光标。
  await pose(f, queryAt(f, Buffer.byteLength(f.doc)));
  check(
    `${name}：逐字素盒模型、分页、旋转、换行与不可映射位置正确`,
    (await doc()) === f.doc && (await compiledPagesMatch(f)),
  );
  await pose(f, queryAt(f, byteAt(f, f.parts[0])));
  await showBlink();
  await c.screenshot(shotPath(`document-cursor-${name}`));
}

await replace(mixed);
const asciiStart = byteAt(mixed, "a.Ag!");
const asciiQuery = queryAt(mixed, asciiStart);
const asciiQueries = [..."a.Ag! office affine ffi fl fi."].map((_, i) =>
  queryAt(mixed, asciiStart + i),
);
const nativeHeights = asciiQueries.filter((q) => q.caret).map((q) => q.caret.heightPt);
check(
  "同一字体的小写字母、标点、空格和连字使用稳定行高",
  nativeHeights.length > 20 && Math.max(...nativeHeights) - Math.min(...nativeHeights) < 0.001,
);
await pose(mixed, asciiQuery);
const beforeResize = await count();
for (const [width, height, deviceScaleFactor] of [
  [1200, 900, 1],
  [800, 800, 1.5],
  [480, 750, 2],
]) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor,
    mobile: false,
  });
  // 页宽是编译输入：等待 250ms 重排去抖、编译和光标查询，再对照实际盒模型。
  await sleep(600);
  await c.waitFor(COMPILE_IDLE);
  await c.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))",
  );
  await pose(mixed, asciiQuery, { dispatch: false });
  check(
    `视口 ${width}px / DPR ${deviceScaleFactor}：光标随栏宽正确重测，仅窄栏重编译`,
    (await count()) === beforeResize + (width === 480 ? 1 : 0),
  );
}
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1200,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(600);
await c.waitFor(COMPILE_IDLE);
const afterResize = await count();
await c.key("+", { code: "Equal", keyCode: 187, modifiers: 10 });
await pose(mixed, asciiQuery, { dispatch: false });
check("用户缩放后光标仍与原生字符边界重合", (await count()) === afterResize);
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
for (const theme of ["dark", "light"]) {
  await c.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await c.waitFor(
    `document.querySelector('.app').classList.contains('light')===${theme === "light"}`,
  );
  await pose(mixed, asciiQuery, { dispatch: false });
  await showBlink();
  await c.screenshot(shotPath(`document-cursor-${theme}`));
  check(
    `${theme} 主题：完整产物和光标位置保持不变`,
    (await compiledPagesMatch(mixed)) && (await count()) === afterResize,
  );
}

// 截图像素而非仅“节点存在”：同一片段仅改变光标的闪烁相位。
await pose(mixed, asciiQuery);
await showBlink();
const screen = await c.evaluate(expectedExpression(asciiQuery.caret));
const clip = {
  x: Math.floor(screen.x) - 3,
  y: Math.floor(screen.y) - 3,
  width: 10,
  height: Math.ceil(screen.height) + 6,
  scale: 1,
};
const visible = await c.send("Page.captureScreenshot", { format: "png", clip });
await c.evaluate(
  "document.querySelector('.document-caret').getAnimations().forEach(a=>{a.pause();a.currentTime=650});true",
);
const invisible = await c.send("Page.captureScreenshot", { format: "png", clip });
const changedPixels = await c.evaluate(
  `(async()=>{async function pixels(data){const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,image.width,image.height).data}const a=await pixels(${JSON.stringify(visible.data)}),b=await pixels(${JSON.stringify(invisible.data)});let changed=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;return changed})()`,
);
check(
  "真实截图证明光标可见并能闪烁，不只是透明占位节点",
  changedPixels > screen.height / 2 && changedPixels < screen.height * 4 + 20,
);
await c.evaluate("document.querySelector('.preview-body').focus();true");
await c.waitFor("!document.querySelector('.document-caret') && !window.__typstPadView.hasFocus");
const unfocused = await c.send("Page.captureScreenshot", { format: "png", clip });
check("离开输入层后光标消失且不留下绘制残影", unfocused.data === invisible.data);
await pose(mixed, asciiQuery);
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:${utf16At(mixed, asciiStart)},head:${utf16At(mixed, asciiStart + 5)}}});true`,
);
await c.waitFor(
  "!!document.querySelector('.document-selection') && !document.querySelector('.document-caret')",
);
check("非空选区只显示高亮，不叠加伪插入光标", (await doc()) === mixed.doc);
await pose(mixed, asciiQuery);
await c.evaluate("window.dispatchEvent(new Event('blur'));true");
await c.waitFor("!document.querySelector('.document-caret')");
await c.evaluate("window.dispatchEvent(new Event('focus'));true");
await c.waitFor(caretReady(asciiQuery.caret));
check("窗口失焦隐藏光标，返回前台恢复真实插入点", (await doc()) === mixed.doc);
const compositionCount = await count();
const compositionAnchor = await c.evaluate(
  "({left:document.querySelector('.input-proxy').style.left,top:document.querySelector('.input-proxy').style.top})",
);
const compositionPath = await c.evaluate(
  "(() => {const content=window.__typstPadView.contentDOM,target=content.editContext??content;target.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));return target===content?'DOM':'EditContext'})()",
);
console.log("合成事件路径：", compositionPath);
await c.waitFor("document.querySelector('.document-caret')?.classList.contains('composing')");
// 合成测试必须真正修改源码，不能只发 start/end 后断言静态光标。
await c.evaluate(
  `window.__typstPadView.dispatch({changes:{from:${utf16At(mixed, asciiStart)},insert:'Z'},selection:{anchor:${utf16At(mixed, asciiStart) + 1}},userEvent:'input.type.compose.start'});true`,
);
await sleep(250);
await c.waitFor(caretReady(asciiQuery.caret));
await assertBox(asciiQuery.caret, "合成中的冻结起点");
check(
  "合成实际修改源码时保持光标常亮、候选锚点不跳到左上角",
  (await doc()) === edited.doc &&
    (await count()) === compositionCount &&
    (await compiledPagesMatch(mixed)) &&
    (await c.evaluate(
      `document.querySelector('.document-caret').getAnimations().length===0 && getComputedStyle(document.querySelector('.document-caret')).opacity==='1' && document.querySelector('.input-proxy').style.left===${JSON.stringify(compositionAnchor.left)} && document.querySelector('.input-proxy').style.top===${JSON.stringify(compositionAnchor.top)}`,
    )),
);
await c.evaluate(
  "(() => {const content=window.__typstPadView.contentDOM;(content.editContext??content).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return true})()",
);
await settled(edited);
await pose(edited, queryAt(edited, asciiStart + 1), { dispatch: false });
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(mixed);
await pose(mixed, asciiQuery, { dispatch: false });
await c.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await c.waitFor("document.querySelector('.document-caret').getAnimations().length===0");
check(
  "减少动态效果设置下仍保留常亮光标",
  await c.evaluate("getComputedStyle(document.querySelector('.document-caret')).opacity==='1'"),
);
await c.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
});
await pose(mixed, queryAt(mixed, asciiStart + 1));
check(
  "光标移动会重启可见闪烁相位",
  await c.evaluate(
    "document.querySelector('.document-caret').getAnimations().length===1 && getComputedStyle(document.querySelector('.document-caret')).opacity==='1'",
  ),
);
await replace(fixture("empty"));
await c.evaluate(
  "window.__typstPadView.dispatch({selection:{anchor:0}});window.__typstPadView.focus();true",
);
check(
  "空文档保留原生空页，不猜测或沿用其他文档的光标",
  (await compiledPagesMatch(fixture("empty"))) &&
    (await c.evaluate("!document.querySelector('.document-caret')")),
);

const repeated = fixture("repeated");
await replace(repeated);
if (repeated.whitespaceHits.length !== 2) throw new Error("重复输出必须有两份真实空白命中");
for (const hit of repeated.whitespaceHits) {
  await c.evaluate(
    `(() => {const p=${expectedExpression(hit.caret)},b=document.querySelector('.preview-body'),r=b.getBoundingClientRect();b.scrollTop+=p.y-(r.top+r.height/2);return true})()`,
  );
  await sleep(30);
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(hit)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await c.waitFor(caretReady(hit.caret), { interval: 16 });
  await assertBox(hit.caret, `重复输出页 ${hit.page}`);
}
check(
  "同一源码重复输出时，光标保留实际点击的那一页",
  (await compiledPagesMatch(repeated)) && (await doc()) === repeated.doc,
);

// 本仓库锁定的 CodeMirror 只在 Android 标记下启用 EditContext。
// 用同一 Chromium 的原生 API 路径验证接线，不修改生产浏览器配置。
const originalAgent = await c.evaluate(
  "({userAgent:navigator.userAgent,platform:navigator.platform})",
);
await c.send("Emulation.setUserAgentOverride", {
  userAgent: originalAgent.userAgent.replace(/\([^)]*\)/, "(Linux; Android 14)"),
  platform: "Linux armv8l",
});
await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await replace(mixed);
await c.waitFor("!!window.__typstPadView.contentDOM.editContext");
await pose(mixed, asciiQuery);
const nativeCompositionCount = await count();
await c.evaluate(
  "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionstart'));true",
);
await c.evaluate(
  `window.__typstPadView.dispatch({changes:{from:${utf16At(mixed, asciiStart)},insert:'Z'},selection:{anchor:${utf16At(mixed, asciiStart) + 1}},userEvent:'input.type.compose.start'});true`,
);
await sleep(250);
await c.waitFor(caretReady(asciiQuery.caret));
await assertBox(asciiQuery.caret, "原生 EditContext 合成起点");
check(
  "原生 EditContext 事件也暂停排版并冻结真实光标",
  (await doc()) === edited.doc &&
    (await count()) === nativeCompositionCount &&
    (await compiledPagesMatch(mixed)),
);
await c.evaluate(
  "window.__typstPadView.contentDOM.editContext.dispatchEvent(new CompositionEvent('compositionend'));true",
);
await settled(edited);
await pose(edited, queryAt(edited, asciiStart + 1), { dispatch: false });
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(mixed);
await pose(mixed, asciiQuery, { dispatch: false });
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:${utf16At(mixed, asciiStart)}}});window.__typstPadView.dispatch({selection:{anchor:${utf16At(mixed, asciiStart + 4)}}});true`,
);
await pose(mixed, queryAt(mixed, asciiStart + 4), { dispatch: false });
check("延迟的光标查询不能覆盖后续键盘落点", (await doc()) === mixed.doc);
await c.evaluate(
  `window.__typstPadView.dispatch({selection:{anchor:${utf16At(mixed, asciiStart)}}});window.__typstPadView.focus();true`,
);
const typingAnchor = await c.evaluate(
  "({left:document.querySelector('.input-proxy').style.left,top:document.querySelector('.input-proxy').style.top})",
);
await c.type("Z");
await c.waitFor("!document.querySelector('.document-caret')");
if (
  !(await c.evaluate(
    `document.querySelector('.input-proxy').style.left===${JSON.stringify(typingAnchor.left)} && document.querySelector('.input-proxy').style.top===${JSON.stringify(typingAnchor.top)}`,
  ))
)
  throw new Error("等待新编译时输入层不能跳回 (0,0)");
await settled(edited);
await pose(edited, queryAt(edited, asciiStart + 1), { dispatch: false });
check(
  "输入后只显示新编译几何，旧光标不回写",
  (await doc()) === edited.doc && (await compiledPagesMatch(edited)),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(mixed);
await pose(mixed, asciiQuery, { dispatch: false });
check(
  "撤销恢复对应原生页与光标位置",
  (await doc()) === mixed.doc && (await compiledPagesMatch(mixed)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(edited);
await pose(edited, queryAt(edited, asciiStart + 1), { dispatch: false });
check(
  "重做恢复对应原生页与光标位置",
  (await doc()) === edited.doc && (await compiledPagesMatch(edited)),
);
check(
  "光标渲染矩阵没有写盘或脚本异常",
  await c.evaluate(
    "!window.__browserDevWrites?.length && !document.body.innerText.includes('脚本错误')",
  ),
);
console.log(
  `累计对照 ${checkedStops} 个真实字素停靠点；${hiddenStops} 个片段内不可映射位置按契约隐藏；截图保存在 .browser-check/document-cursor-*.png`,
);
await c.send("Emulation.setUserAgentOverride", originalAgent);
await c.close();
finish(`通过 ${state.passed} 项检查；真实光标几何 + Chromium 盒模型 + 截图像素`);
