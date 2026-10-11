// 同输入的新产物作废旧点击；同请求自然测量先决定最终展示纸型。
import { writeFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  createChecker,
  finish,
  loadFixtures,
  COMPILE_IDLE,
  sleep,
  shotPath,
} from "./harness.mjs";

const fixtures = loadFixtures("document-transaction-fixtures.json", {
  predicate: (fs) => fs.length === 16,
});
const paper = loadFixtures("preview-paper-fixtures.json");
const { check, state } = createChecker();
const c = await connect();
const traces = [];
let injection;
async function start(source, mode, width, pageFixtures) {
  if (injection)
    await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection });
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const seed = {
    content: source,
    prefixEnabled: false,
    viewMode: mode,
    showPreview: mode === "source",
    uiZoom: 1,
    restoreSession: true,
    autoCheckUpdates: false,
  };
  injection = (
    await c.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
    localStorage.setItem('typst-pad:state',${JSON.stringify(JSON.stringify(seed))});
    const audit=window.__transaction={requests:[],frames:[],engine:[],cursors:[],phase:'startup'};
    window.__browserDevInvoke=async (command,args,invoke)=>{
      if(command==='plugin:webview|set_webview_zoom')audit.engine.push({value:args.value,t:performance.now()});
      if(command==='document_cursor')audit.cursors.push({geometryId:args.geometryId,offset:args.offset});
      if(command!=='compile_doc')return invoke();
      const entry={src:args.src,preview:args.previewPage??null,phase:audit.phase,t:performance.now()};
      audit.requests.push(entry);
      const result=await invoke(); entry.done=performance.now();entry.geometryId=result.geometryId;
      return result;
    };
    const sample=t=>{
      const body=document.querySelector('.preview-body'),svg=document.querySelector('#preview-host .document-page')?.shadowRoot?.querySelector('svg');
      if(body&&svg)audit.frames.push({t,phase:audit.phase,pane:body.clientWidth,inlineWidth:body.style.width,overflow:body.scrollWidth-body.clientWidth,widthPt:svg.viewBox.baseVal.width,heightPt:svg.viewBox.baseVal.height,request:window.__browserDevLastCompile?.previewPage??null});
      requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
  })()`,
    })
  ).identifier;
  await boot(c, DEV_URL, { pageFixtures });
  await settle();
}
async function settle() {
  await c.waitFor(COMPILE_IDLE);
  await sleep(800);
  await c.waitFor(COMPILE_IDLE);
}
async function matches(value) {
  return c.evaluate(
    `(() => {const hosts=[...document.querySelectorAll('#preview-host .document-page')],expected=${JSON.stringify(value.pages)};return hosts.length===expected.length&&hosts.every((h,i)=>{const div=document.createElement('div');div.innerHTML=expected[i];return h.shadowRoot.querySelector('svg').isEqualNode(div.firstElementChild)})})()`,
  );
}
async function point(caret) {
  return c.evaluate(
    `(() => {const p=${JSON.stringify(caret)},svg=document.querySelectorAll('#preview-host .document-page')[p.page-1].shadowRoot.querySelector('svg'),r=svg.getBoundingClientRect(),v=svg.viewBox.baseVal;return{x:r.left+(p.xPt+.2)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2)*r.height/v.height}})()`,
  );
}
function archive() {
  writeFileSync(
    new URL("../../.browser-check/document-transaction.json", import.meta.url),
    JSON.stringify(traces, null, 2),
  );
}

for (const width of [1400, 1100])
  for (const mode of ["write", "source"]) {
    const original = "Result #(1 + 2) after",
      edited = "Result #(1 + 3) after";
    await start(original, mode, width, fixtures);
    const at = original.indexOf("2");
    if (mode === "write") {
      const displayed = await c.evaluate("window.__browserDevLastCompile.previewPage");
      const normal = fixtures.find(
        (f) =>
          f.doc === original &&
          f.previewPage &&
          ["widthPt", "heightPt", "marginPt"].every(
            (k) => Math.abs(f.previewPage[k] - displayed[k]) < 0.02,
          ),
      );
      if (!normal) throw Error("缺少正常正文激活夹具");
      const p = await point(normal.carets.find((p) => p.offset === 0));
      await c.click(p.x, p.y);
    }
    await c.evaluate(
      `window.__typstPadView.dispatch({selection:{anchor:${at}}});window.__typstPadView.focus();true`,
    );
    await settle();
    await c.evaluate(
      `window.__transaction.phase='edit';window.__typstPadView.dispatch({changes:{from:${at},to:${at + 1},insert:'3'},selection:{anchor:${at + 1}}});true`,
    );
    await settle();
    const audit = await c.evaluate("window.__transaction");
    const requests = audit.requests.filter((r) => r.phase === "edit");
    const last = requests.at(-1);
    const expected = fixtures.find(
      (f) =>
        f.doc === last?.src &&
        !!f.previewPage === !!last.preview &&
        (!last.preview ||
          ["widthPt", "heightPt", "marginPt"].every(
            (k) => Math.abs(f.previewPage[k] - last.preview[k]) < 0.02,
          )),
    );
    if (!expected) throw Error(`缺少真实最终事务夹具 ${mode}/${width}: ${JSON.stringify(last)}`);
    const identity =
      mode === "source" ||
      (await c.evaluate(`window.__transaction.cursors.at(-1)?.geometryId===${last.geometryId}`));
    const valid =
      requests.length === 2 &&
      requests[0].src === edited &&
      requests[0].preview === null &&
      last.preview &&
      last.geometryId &&
      identity &&
      (mode === "source" ? last.src === edited : last.src !== edited) &&
      (await matches(expected)) &&
      audit.frames.every((f) => !f.inlineWidth && f.overflow <= 1);
    traces.push({
      mode,
      width,
      requests,
      frames: audit.frames,
      engine: audit.engine,
      cursors: audit.cursors,
      valid,
    });
    archive();
    console.log("DOCTRANSACTION", JSON.stringify({ mode, width, requests, valid }));
    check(
      `${mode}/${width}：自然原文与最终展示同轮两次调用、真实SVG/几何且未固定栏宽无横滚`,
      valid,
    );
    await c.screenshot(shotPath(`document-transaction-${mode}-${width}`));
  }

const original = paper.find((f) => f.name === "original" && !f.previewPage),
  recovered = paper.find((f) => f.name === "recovered" && !f.previewPage),
  retained = paper.find((f) => f.name === "retained" && !f.previewPage);
await start(recovered.brokenDoc, "write", 1400, paper);
const rawCaret = recovered.carets.find(
  (p) => p.offset >= Buffer.byteLength(recovered.doc.slice(0, recovered.doc.indexOf("width"))),
);
if (!rawCaret) throw Error("缺少真实raw停靠点");
let p = await point(rawCaret);
await c.click(p.x, p.y);
await settle();
const at = original.doc.indexOf("width");
await c.evaluate(
  `(()=>{const v=window.__typstPadView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(original.doc)}},selection:{anchor:${at}}});return true})()`,
);
await settle();
if (!(await matches(retained))) throw Error("未形成修复后的同输入错误编辑锁");
const retainedCaret = retained.carets.find(
  (p) => p.offset >= Buffer.byteLength(retained.doc.slice(0, retained.doc.indexOf("width"))),
);
p = await point(retainedCaret);
await c.evaluate(`(()=>{
  const internals=window.__TAURI_INTERNALS__,invoke=internals.invoke;
  window.__compileHeld=false;window.__hitHeld=false;
  internals.invoke=async(command,args)=>{
    if(command==='compile_doc'){
      window.__compileHeld=true;await new Promise(resolve=>window.__releaseCompile=resolve);
      return invoke(command,args);
    }
    if(command==='document_hit_test'){
      const result=await invoke(command,args);window.__oldHit={geometryId:args.geometryId,result};window.__hitHeld=true;
      await new Promise(resolve=>window.__releaseHit=resolve);return result;
    }
    return invoke(command,args);
  };window.__restoreInvoke=()=>internals.invoke=invoke;return true;
})()`);
await c.key("Escape", { keyCode: 27 });
await c.waitFor("window.__compileHeld");
await c.click(p.x, p.y);
await c.waitFor("window.__hitHeld");
await c.evaluate("window.__releaseCompile();true");
await c.waitFor(COMPILE_IDLE);
if (!(await matches(original))) throw Error("新原生产物未落地");
const before = await c.evaluate(
  `({head:window.__typstPadView.state.selection.main.head,caret:document.querySelector('.document-caret')?.getAttribute('style')??null})`,
);
const oldHit = await c.evaluate("window.__oldHit");
const latest = await c.evaluate("window.__transaction.requests.at(-1).geometryId");
await c.evaluate("window.__releaseHit();window.__restoreInvoke();true");
await sleep(150);
const after = await c.evaluate(
  `({head:window.__typstPadView.state.selection.main.head,caret:document.querySelector('.document-caret')?.getAttribute('style')??null})`,
);
traces.push({ case: "same-input-late-click", oldHit, latest, before, after });
archive();
check(
  "同输入新产物落地后，旧raw命中不移动选区或写入旧caret",
  oldHit.result && oldHit.geometryId !== latest && JSON.stringify(before) === JSON.stringify(after),
);
const target = original.doc.indexOf("自然"),
  targetByte = Buffer.byteLength(original.doc.slice(0, target));
const newCaret = original.carets.find((p) => p.offset === targetByte);
if (!newCaret) throw Error("新几何缺少正文停靠点");
p = await point(newCaret);
await c.click(p.x, p.y);
await sleep(150);
check(
  "随后当前几何点击仍准确定位原文",
  await c.evaluate(
    `window.__typstPadView.state.selection.main.head===${target}&&!window.__browserDevErrors?.length&&!window.__browserDevWrites?.length`,
  ),
);
await c.screenshot(shotPath("document-transaction-current-click"));
await c.close();
finish(`通过 ${state.passed} 项检查（原文/展示事务与产物身份）`);
