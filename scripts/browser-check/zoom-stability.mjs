// WebView IPC 接线 + 逐 rAF 的真实 Typst 页面采样。CDP 模拟引擎布局/DPR，非 CSS zoom。
// 这不是 Windows WebView2 的 IPC/IME 实机验收。
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  createChecker,
  finish,
  sleep,
  COMPILE_IDLE,
  loadFixtures,
  shotPath,
} from "./harness.mjs";

const { check, state } = createChecker();
const fixtures = loadFixtures("zoom-fixtures.json", { predicate: (f) => f.length === 37 });
const doc = fixtures.find((f) => f.name === "compact").doc;
const beforeDoc = fixtures.find((f) => f.name === "before").doc;
const c = await connect();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT ?? 9333}`);
const page = browser.contexts()[0].pages()[0];
let physicalWidth = 1400,
  physicalHeight = 900,
  baseDpr = 1,
  accepted = 1;
let delay = 0,
  reject = false,
  blind = false;
const engineCalls = [];
const traces = [];
async function layout(zoom = accepted) {
  accepted = zoom;
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: Math.round(physicalWidth / zoom),
    height: Math.round(physicalHeight / zoom),
    deviceScaleFactor: baseDpr * zoom,
    mobile: false,
  });
}
await page.exposeFunction("__zoomEngine", async (target) => {
  const entry = { target, at: Date.now(), completed: false };
  engineCalls.push(entry);
  if (delay) await sleep(delay);
  if (reject) throw Error("拒绝测试");
  await layout(target);
  entry.completed = true;
});
let injection;
async function start({ mode = "write", level = 1.5, pane = 620, source = doc, slow = false } = {}) {
  if (injection)
    await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection });
  const seed = {
    content: source,
    prefixEnabled: false,
    prefixCode: "",
    uiZoom: level,
    viewMode: mode,
    showPreview: mode === "source",
    restoreSession: true,
    autoCheckUpdates: false,
  };
  const code = `(() => {
    localStorage.setItem('typst-pad:state', ${JSON.stringify(JSON.stringify(seed))});
    window.__zoomAudit = {sets:[],requests:[],frames:[],phase:'startup'};
    const audit=window.__zoomAudit;
    window.__browserDevInvoke=async (command,args,invoke) => {
        if(command==='plugin:webview|set_webview_zoom') {
          audit.sets.push({target:args.value,t:performance.now(),phase:audit.phase});
          return window.__zoomEngine(args.value);
        }
        if(command!=='compile_doc')return invoke();
        const entry={src:args.src,preview:args.previewPage??null,t:performance.now(),phase:audit.phase};
        audit.requests.push(entry);
        const result=await invoke();
        entry.done=performance.now(); entry.geometryId=result.geometryId;
        entry.widths=(result.pages??[]).filter(Boolean).map(svg=>+svg.match(/viewBox="[^" ]+ [^" ]+ ([^" ]+)/)[1]);
        return result;
    };
    if(${blind}) {
      Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>1});
      const installWidth=()=>{
        if(!document.documentElement)return false;
        Object.defineProperty(document.documentElement,'clientWidth',{configurable:true,get:()=>1400});
        return true;
      };
      if(!installWidth())new MutationObserver((_,observer)=>{if(installWidth())observer.disconnect()})
        .observe(document,{childList:true});
    }
    if(${pane !== null}) {
      let sized=false;
      new MutationObserver(()=>{
        const body=document.querySelector('.preview-body');
        if(body&&!sized) {sized=true;body.style.width=(${pane}+body.offsetWidth-body.clientWidth)+'px';body.style.maxWidth='100%';}
      }).observe(document,{childList:true,subtree:true});
    }
    function sample(t) {
      const body=document.querySelector('.preview-body'), paper=document.querySelector('.preview-paper');
      const host=document.querySelector('#preview-host .document-page'), svg=host?.shadowRoot?.querySelector('svg');
      if(body&&paper) {
        const w=svg?.viewBox.baseVal.width??0, paperWidth=paper.getBoundingClientRect().width;
        const glyph=svg?.querySelector('use')?.getBoundingClientRect();
        const cm=document.querySelector('.cm-editor');
        audit.frames.push({t,phase:audit.phase,pane:body.clientWidth,paper:paperWidth,
          widthPt:w,heightPt:svg?.viewBox.baseVal.height??0,font:w?11*paperWidth/w:0,
          editorFont:cm?parseFloat(getComputedStyle(cm).fontSize):0,
          overflow:body.scrollWidth-body.clientWidth,dpr:devicePixelRatio,
          physicalFont:w?11*paperWidth/w*devicePixelRatio:0,
          text:svg?.textContent??'',pages:document.querySelectorAll('#preview-host .document-page').length,
          request:window.__browserDevLastCompile?.previewPage??null,
          inlinePaneWidth:body.style.width, viewport:innerWidth,
          glyphWidth:glyph?.width??0,glyphHeight:glyph?.height??0,
          paperStyleWidth:paper.style.width, paperMaxWidth:getComputedStyle(paper).maxWidth,
          level:document.querySelector('.status-bar')?.textContent??''});
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })()`;
  injection = (await c.send("Page.addScriptToEvaluateOnNewDocument", { source: code })).identifier;
  await layout(1);
  engineCalls.length = 0;
  await boot(c, `${DEV_URL}${slow ? "&compileslow=1" : ""}`, {
    pageFixtures: fixtures,
    settleMs: 100,
  });
  await settle();
  await c.waitFor("window.__zoomAudit.frames.filter(f=>f.widthPt>0).length>5");
}
async function settle() {
  await c.waitFor(COMPILE_IDLE);
  await sleep(750);
  await c.waitFor(COMPILE_IDLE);
}
async function phase(name) {
  await c.evaluate(`window.__zoomAudit.phase=${JSON.stringify(name)};true`);
}
async function audit() {
  return c.evaluate("window.__zoomAudit");
}
async function archive(name) {
  const a = await audit();
  traces.push({ name, engineCalls: [...engineCalls], ...a });
  writeFileSync(
    new URL("../../.browser-check/zoom-frames.json", import.meta.url),
    JSON.stringify(traces, null, 2),
  );
}
async function replace(source) {
  await c.evaluate(
    `(() => {const v=window.__typstPadView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(source)}}});return true})()`,
  );
  await settle();
}
async function pane(width) {
  await c.evaluate(
    `(() => {const b=document.querySelector('.preview-body');b.style.width=(${width}+b.offsetWidth-b.clientWidth)+'px';return true})()`,
  );
  await settle();
}
function fitted(a) {
  const visible = a.frames.filter((f) => f.widthPt > 0);
  return visible.length > 5 && visible.every((f) => f.overflow <= 1 && f.paper <= f.pane + 1);
}
function noNaturalFlash(a, width) {
  const visible = a.frames.filter((f) => f.widthPt > 0);
  return (
    visible.length > 5 &&
    visible.every((f) => Math.abs(f.widthPt - width) < 1 && Math.abs(f.font - 14) < 0.15)
  );
}
async function nativeRound() {
  return c.evaluate(`(async () => {
    const r=window.__zoomAudit.requests.at(-1);
    const f=window.__typstPageFixtures.find(f=>f.doc===r.src&&f.previewPage&&r.preview&&
      ['widthPt','heightPt','marginPt'].every(k=>Math.abs(f.previewPage[k]-r.preview[k])<0.02));
    if(!f||!f.carets.length)return false;
    const hosts=[...document.querySelectorAll('#preview-host .document-page')];
    const canonical=src=>{const e=document.createElement('div');e.innerHTML=src;return e.querySelector('svg').outerHTML};
    if(hosts.length!==f.pages.length||!hosts.every((h,i)=>h.shadowRoot.querySelector('svg').outerHTML===canonical(f.pages[i])))return false;
    const caret=f.carets[0];
    const actual=await window.__TAURI_INTERNALS__.invoke('document_cursor',{geometryId:r.geometryId,offset:caret.offset});
    return JSON.stringify(actual)===JSON.stringify(caret);
  })()`);
}
async function menu(label) {
  await c.evaluate(
    "[...document.querySelectorAll('.menu-title')].find(b=>b.textContent.includes('视图')).click();true",
  );
  await c.evaluate(
    `[...document.querySelectorAll('.menu-item-label')].find(b=>b.textContent===${JSON.stringify(label)}).closest('button').click();true`,
  );
}

await start();
let a = await audit();
check(
  "存档150%启动：全部引擎序列只含目标，无100%校准或确认回写",
  a.sets.length === 1 && a.sets[0].target === 1.5,
  JSON.stringify(a.sets),
);
check(
  "首屏无注入只测量：所有可见帧直接是最终紧凑纸型/14px",
  noNaturalFlash(a, (620 * 11) / 14),
  JSON.stringify(a.frames.slice(-1)),
);
check("全部首屏帧不横滚，完整Typst多页仍存在", fitted(a) && a.frames.some((f) => f.pages > 1));
await archive("saved-startup");
await phase("keys");
for (const key of ["=", "=", "-", "-"]) {
  await c.key(key, {
    code: key === "=" ? "Equal" : "Minus",
    keyCode: key === "=" ? 187 : 189,
    modifiers: 10,
  });
  await sleep(35);
}
await settle();
a = await audit();
check(
  "连续键盘放大/缩小：只请求用户序列160/170/160/150，无迟到旧档",
  JSON.stringify(a.sets.slice(1).map((x) => x.target)) === JSON.stringify([1.6, 1.7, 1.6, 1.5]),
  JSON.stringify(a.sets),
);
await phase("wheel");
for (const deltaY of [-100, -100, 100, 100]) {
  await c.evaluate(
    `window.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:true,bubbles:true,cancelable:true}));true`,
  );
  await sleep(35);
}
await settle();
await phase("menu");
await menu("放大");
await sleep(100);
await menu("缩小");
await settle();
a = await audit();
check(
  "wheel累积/菜单接线：不请求100%，最终仍150%",
  a.sets.every((x) => x.target >= 1.5) &&
    a.sets.at(-1).target === 1.5 &&
    a.sets
      .filter((x) => x.phase === "wheel")
      .map((x) => x.target)
      .join(",") === "1.6,1.7,1.6,1.5",
  JSON.stringify(a.sets),
);
check(
  "write连续wheel/key/menu逐帧字号、纸型与栏宽没有闪缩",
  noNaturalFlash(a, (620 * 11) / 14) && fitted(a),
);
await phase("reapply");
await c.evaluate("window.dispatchEvent(new Event('focus'));true");
await settle();
a = await audit();
check(
  "reapply只请求当前150%，确认不额外写入",
  a.sets.at(-1).target === 1.5 && a.sets.filter((x) => x.phase === "reapply").length === 1,
);
await archive("write-inputs");

await phase("narrow");
await pane(400);
await phase("wide");
await pane(620);
a = await audit();
check(
  "真实夹具窄/宽重排：最终尺寸准确且所有中间帧不横滚",
  fitted(a) && Math.abs(a.frames.at(-1).widthPt - (620 * 11) / 14) < 1,
);
await pane(400);
await phase("mode");
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await settle();
await phase("source-keys");
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(100);
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
await settle();
a = await audit();
const sourceFrames = a.frames.filter((f) => f.phase === "source-keys" && f.widthPt);
check(
  "source缩放逐帧字号稳定，模式切换不额外改用户档位",
  sourceFrames.length > 10 &&
    sourceFrames.every((f) => Math.abs(f.font - 14) < 0.15) &&
    a.sets.filter((x) => x.phase === "mode").length === 0,
);
await phase("source-wheel-menu");
for (const deltaY of [-100, 100]) {
  await c.evaluate(
    `window.dispatchEvent(new WheelEvent('wheel',{deltaY:${deltaY},ctrlKey:true,bubbles:true,cancelable:true}));true`,
  );
  await sleep(35);
}
await menu("放大");
await sleep(100);
await menu("缩小");
await settle();
a = await audit();
const sourceInputs = a.frames.filter((f) => f.phase === "source-wheel-menu" && f.widthPt);
check(
  "source wheel/menu逐帧与完整调用序列稳定",
  sourceInputs.length > 10 &&
    sourceInputs.every((f) => Math.abs(f.font - 14) < 0.15) &&
    a.sets
      .filter((x) => x.phase === "source-wheel-menu")
      .map((x) => x.target)
      .join(",") === "1.6,1.5,1.6,1.5",
);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await settle();
await archive("mode-widths");

await start({ source: beforeDoc, level: 1, pane: 620 });
await c.screenshot(shotPath("zoom-margin-before"));
const before = await c.evaluate(
  "(() => {const h=document.querySelector('#preview-host .document-page'),s=h.shadowRoot.querySelector('svg');return {width:h.getBoundingClientRect().width,first:[...s.querySelectorAll('use')].slice(0,1).map(e=>e.getBoundingClientRect().left-h.getBoundingClientRect().left),bodyStyle:getComputedStyle(document.querySelector('.preview-body')).padding}})()",
);
await archive("margin-before");
await phase("measurement-edit");
await replace(doc);
await c.screenshot(shotPath("zoom-margin-after"));
a = await audit();
const after = await c.evaluate(
  "(() => {const h=document.querySelector('#preview-host .document-page'),s=h.shadowRoot.querySelector('svg');return {width:h.getBoundingClientRect().width,first:[...s.querySelectorAll('use')].slice(0,1).map(e=>e.getBoundingClientRect().left-h.getBoundingClientRect().left),bodyStyle:getComputedStyle(document.querySelector('.preview-body')).padding}})()",
);
writeFileSync(
  new URL("../../.browser-check/zoom-margins.json", import.meta.url),
  JSON.stringify({ before, after, originalMarginPt: 70.87, compactMarginPt: 24 }, null, 2),
);
check(
  "边距computedstyle/真实字形：UI padding不冒充纸内margin，正文左内距明显缩小",
  before.bodyStyle === "0px" && after.bodyStyle === "0px" && after.first[0] < before.first[0] * 0.5,
  JSON.stringify({ before, after }),
);
check(
  "原文自然测量没有在可见帧落地再缩放",
  a.requests.some((r) => r.phase === "measurement-edit" && r.preview === null) &&
    noNaturalFlash(a, (620 * 11) / 14),
);
check(
  "原文/选区/保存会话不含临时预览参数",
  await c.evaluate(
    `window.__typstPadView.state.doc.toString()===${JSON.stringify(doc)}&&JSON.parse(localStorage.getItem('typst-pad:state')).content===${JSON.stringify(doc)}`,
  ),
);
check(
  "落地完整SVG与同轮原生caret一致（不裁页/猜几何）",
  await c.evaluate(`(async () => {
  const f=window.__typstPageFixtures.find(f=>f.name==='compact'&&f.previewPage&&Math.abs(f.previewPage.widthPt-620*11/14)<0.02&&f.previewPage.marginPt<20);
  if(!f)throw Error('缺少最终真实夹具');
  const hosts=[...document.querySelectorAll('#preview-host .document-page')];
  const canonical=src=>{const e=document.createElement('div');e.innerHTML=src;return e.querySelector('svg').outerHTML};
  if(hosts.length!==f.pages.length||!hosts.every((h,i)=>h.shadowRoot.querySelector('svg').outerHTML===canonical(f.pages[i])))return false;
  const r=window.__zoomAudit.requests.at(-1), caret=f.carets[0];
  const actual=await window.__TAURI_INTERNALS__.invoke('document_cursor',{geometryId:r.geometryId,offset:caret.offset});
  return r.geometryId>0&&JSON.stringify(actual)===JSON.stringify(caret);
})()`),
);
await archive("natural-measurement");

await phase("resize-dpr");
physicalWidth = 1600;
baseDpr = 2;
await layout();
await settle();
a = await audit();
check(
  "实际resize/DPR不改变用户档位或额外调用引擎",
  a.sets.filter((x) => x.phase === "resize-dpr").length === 0 &&
    a.frames.at(-1).dpr === 2 &&
    fitted(a),
);
await archive("resize-dpr");
baseDpr = 1;
physicalWidth = 1400;

delay = 300;
await start({ level: 1.5, pane: 400, slow: true });
await phase("late-target");
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(30);
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(30);
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
await settle();
a = await audit();
check(
  "迟到引擎串行，待执行目标合并，最终目标160%不会被旧档覆盖",
  a.sets.at(-1).target === 1.6 && accepted === 1.6 && a.sets.every((x) => x.target >= 1.5),
  JSON.stringify(a.sets),
);
check("延迟引擎/迟到编译所有可见帧纸型与字号稳定", noNaturalFlash(a, (400 * 11) / 14) && fitted(a));
await archive("delayed-target");
delay = 0;

await start({ level: 1.5, pane: 400, slow: true });
await phase("late-mode");
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await sleep(280);
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await settle();
a = await audit();
check(
  "迟到source页不混用write的紧凑容器，模式不触发额外zoom",
  noNaturalFlash(a, (400 * 11) / 14) && a.sets.length === 1 && fitted(a),
);
await archive("late-mode-session");

reject = true;
await start({ level: 1.7, pane: 400 });
a = await audit();
check(
  "拒绝引擎仍保留用户170%，不回100%/旧档/无限重试",
  a.sets.length === 1 &&
    a.sets[0].target === 1.7 &&
    (await c.evaluate("JSON.parse(localStorage.getItem('typst-pad:state')).uiZoom===1.7")),
);
await archive("rejected-engine");
reject = false;
blind = true;
await start({ level: 1.5, pane: 400 });
await phase("blind");
await menu("放大");
await settle();
a = await audit();
check(
  "不可观测引擎不回写用户档位或100%，逐帧无CSS zoom",
  a.sets.map((x) => x.target).join(",") === "1.5,1.6" &&
    noNaturalFlash(a, (400 * 11) / 14) &&
    fitted(a) &&
    (await c.evaluate(
      "getComputedStyle(document.documentElement).zoom==='1'&&JSON.parse(localStorage.getItem('typst-pad:state')).uiZoom===1.6",
    )),
);
await archive("blind-engine");
blind = false;
await start({ level: 0.8, pane: 400 });
a = await audit();
check(
  "存档80%缩小启动不经过100%或旧档，所有可见帧14px",
  a.sets.length === 1 &&
    a.sets[0].target === 0.8 &&
    noNaturalFlash(a, (400 * 11) / 14) &&
    fitted(a),
);
await phase("zoom-small");
await menu("放大");
await sleep(100);
await menu("缩小");
await settle();
a = await audit();
check(
  "100%以下用户放大/缩小完整序列没有校准回跳",
  a.sets.map((x) => x.target).join(",") === "0.8,0.9,0.8" && noNaturalFlash(a, (400 * 11) / 14),
);
await archive("saved-small-startup");

// 不覆盖预览栏宽：让实际父布局随引擎缩放改变，覆盖真正的重排路径。
for (const mode of ["write", "source"]) {
  for (const width of [1400, 1100]) {
    physicalWidth = width;
    const level = width === 1400 ? 2 : 1.5;
    await start({ mode, level, pane: null });
    await archive(`fluid-${mode}-${width}-startup`);
    // 逐档落地，覆盖实际不同栏宽的真实Typst产物，而非只在去抖内回到原档。
    for (const up of [true, true, false, false]) {
      await phase(`fluid-step-${engineCalls.length}`);
      await menu(up ? "放大" : "缩小");
      await settle();
      const sameRound = await nativeRound();
      await c.evaluate(`(() => {
        const a=window.__zoomAudit, f=a.frames.at(-1), r=a.requests.at(-1);
        (a.settled??=[]).push({phase:a.phase,target:a.sets.at(-1).target,geometryId:r.geometryId,
          request:r.preview,pane:f.pane,paper:f.paper,widthPt:f.widthPt,font:f.font,sameRound:${sameRound}});
        return true;
      })()`);
    }
    for (const [name, input] of [
      [
        "key",
        async (up) =>
          c.key(up ? "=" : "-", {
            code: up ? "Equal" : "Minus",
            keyCode: up ? 187 : 189,
            modifiers: 10,
          }),
      ],
      [
        "wheel",
        async (up) =>
          c.evaluate(
            `window.dispatchEvent(new WheelEvent('wheel',{deltaY:${up ? -100 : 100},ctrlKey:true,bubbles:true,cancelable:true}));true`,
          ),
      ],
      ["menu", async (up) => menu(up ? "放大" : "缩小")],
    ]) {
      await phase(`fluid-${name}`);
      for (const up of [true, true, false, false]) {
        await input(up);
        await sleep(35);
      }
      await settle();
      await archive(`fluid-${mode}-${width}-${name}`);
    }
    a = await audit();
    check(
      `正常布局 ${mode}/${width}：栏宽随缩放变化，全部帧无横滚`,
      fitted(a) &&
        a.frames.every((f) => f.inlinePaneWidth === "") &&
        new Set(a.frames.map((f) => f.pane)).size >= 3,
      JSON.stringify(a.requests.map((r) => r.preview)),
    );
    const visible = a.frames.filter((f) => f.widthPt > 0);
    // SVG宽度保留两位小数；源码栏本身还有半像素边框。容许<1px舍入，不容许旧窄宿主。
    const staleHosts = visible.filter(
      (f) => Math.abs(f.paper - Math.min(f.pane, (f.widthPt * 14) / 11)) > 0.8,
    );
    check(
      `正常布局 ${mode}/${width}：逐rAF旧完整页立即适配收窄/放宽，不先闪缩`,
      visible.length > 30 &&
        staleHosts.length === 0 &&
        visible.every((f) => f.font <= 14.05 && f.glyphHeight > 0 && f.paperMaxWidth === "100%"),
      JSON.stringify(staleHosts.slice(0, 3)),
    );
    const dips = visible.filter((f) => {
      const step = /^fluid-step-(\d+)$/.exec(f.phase);
      const calls = a.sets;
      const low = step ? Math.min(calls[+step[1] - 1].target, calls[+step[1]].target) : level;
      return f.phase !== "startup" && f.physicalFont < 14 * low - 0.25;
    });
    check(
      `正常布局 ${mode}/${width}：单档/连续wheel-key-menu物理字号不低于用户端点`,
      dips.length === 0 &&
        a.sets.length === 17 &&
        a.sets.map((s) => s.target).join(",") ===
          [
            level,
            ...Array.from({ length: 4 }, () => [
              +(level + 0.1).toFixed(1),
              +(level + 0.2).toFixed(1),
              +(level + 0.1).toFixed(1),
              level,
            ]).flat(),
          ].join(","),
      JSON.stringify(dips.slice(0, 3)),
    );
    check(
      `正常布局 ${mode}/${width}：实际请求几何均有真实夹具，最终完整SVG/caret同轮`,
      a.requests.every(
        (r) =>
          r.geometryId > 0 &&
          r.widths?.length &&
          (!r.preview || r.widths.every((w) => Math.abs(w - r.preview.widthPt) < 0.02)),
      ) &&
        a.settled?.length === 4 &&
        a.settled.every(
          (s) =>
            s.sameRound &&
            Math.abs(s.font - 14) < 0.05 &&
            Math.abs(s.request.widthPt - (s.pane * 11) / 14) < 0.02 &&
            Math.abs(s.widthPt - s.request.widthPt) < 0.02,
        ) &&
        (await nativeRound()),
    );
    await c.screenshot(shotPath(`zoom-fluid-${mode}-${width}`));
  }
}
await c.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injection });
await c.send("Page.navigate", { url: "about:blank" });
console.log(
  `逐帧证据：${traces.reduce((n, t) => n + t.frames.length, 0)} frames；完整IPC/request见 zoom-frames.json`,
);
await browser.close();
finish(`通过 ${state.passed} 项检查，失败 ${state.failed} 项。`);
