// **预览重排守卫**：纸张跟着预览栏走 —— 栏宽/模式变化时页面按新宽度重新排版，预览栏
// 永不出现横向滚动条，而且预览字号恒等于编辑区字号（11pt 正文 ↔ 14px）。
//
// 用户口径（2026-10-08）：「直接把纸张大小改小，且不滚动，可以接受排版变化。」
// 前史：2026-09-14 起过一版（插在编译源最前面 → 被文档自己的 `#set page` 覆盖，真实文档
// 永远拿不到重排），2026-10-08 重做成"插在文档自己的页面设置之后"（Rust 侧）并与兜底等比
// 缩放整条打通。本套件锁住前端这一侧：**永不横滚 + 字号与代码一致 + 请求真的生效**。
//
// 这套用假产物（不注入真实夹具）：桩会按请求的纸型重新折行/分页，于是"重排生效"在 DOM 上
// 看得见；把查询串换成 `&reflowfail=1`（不用重启页面，桩是每次编译时读它）模拟"文档把纸型
// 写在别处、注入被覆盖"，必须退回等比缩放。

import { connect, DEV_URL } from "./cdp.mjs";
import { boot, createChecker, finish, sleep, COMPILE_IDLE, loadFixtures } from "./harness.mjs";

const { check, state } = createChecker();
const c = await connect();

/** 等编译次数稳定：重排是"先编译学文档纸型 → 再按栏宽重编译"两步 */
async function settledCompiles() {
  let last = -1;
  let stableSince = Date.now();
  for (let i = 0; i < 60; i++) {
    const count = await c.evaluate("window.__browserDevCompileCount ?? 0");
    if (count !== last) stableSince = Date.now();
    if (count > 0 && Date.now() - stableSince >= 600 && (await c.evaluate(COMPILE_IDLE)))
      return count;
    last = count;
    await sleep(100);
  }
  throw new Error("预览编译未稳定（包括 250ms 重排去抖）");
}

async function viewport(width, height = 900) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
  await settledCompiles();
}

/** 量预览：栏宽、横向溢出、纸宽、产物页宽（pt）、预览字号（px）、请求页宽（pt） */
const measured = () =>
  c.evaluate(`(() => {
    const body = document.querySelector('.preview-body');
    const paper = document.querySelector('.preview-paper');
    const svg = document.querySelector('#preview-host .document-page')?.shadowRoot?.querySelector('svg');
    const rect = paper.getBoundingClientRect();
    const pageWidthPt = Number((svg?.getAttribute('viewBox') ?? '').trim().split(/\\s+/)[2]);
    const requested = window.__browserDevLastCompile?.previewPage ?? null;
    return {
      clientWidth: body.clientWidth,
      overflowX: body.scrollWidth - body.clientWidth,
      paperWidth: rect.width,
      pageWidthPt,
      pageHeightPt: svg?.viewBox.baseVal.height ?? 0,
      requestedWidthPt: requested ? requested.widthPt : null,
      requestedHeightPt: requested ? requested.heightPt : null,
      fontPx: pageWidthPt ? (rect.width / pageWidthPt) * 11 : NaN,
    };
  })()`);

/** 源码模式（`Ctrl+E`）与文档模式互切 */
async function toSourceMode() {
  await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
  await sleep(300);
  await settledCompiles();
}
async function toDocumentMode() {
  await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
  await sleep(300);
  await settledCompiles();
}

// `pageFixtures: []`：显式"不用真实夹具" —— 别的套件注册的注入脚本可能还挂在浏览器会话上，
// 空数组会把它盖掉，本套件必须跑在桩的假产物上（否则重排请求不会被桩照做）。
await boot(c, DEV_URL, { pageFixtures: [], settleMs: 600 });
await viewport(1400);

const wide = await measured();
check(
  "文档模式 100%：纸停在自然尺寸（A4 ≈ 757.6px），不铺满整栏",
  Math.abs(wide.paperWidth - 757.6) <= 2 && wide.paperWidth < wide.clientWidth,
  `纸 ${wide.paperWidth.toFixed(1)}px / 栏 ${wide.clientWidth}px`,
);
check(
  "文档模式 100%：预览字号 = 编辑区字号（14px）",
  Math.abs(wide.fontPx - 14) <= 0.1,
  `字号 ${wide.fontPx.toFixed(2)}px`,
);
check("文档模式 100%：没有横向滚动条", wide.overflowX <= 1, `溢出 ${wide.overflowX}px`);

await toSourceMode();
const source = await measured();
check(
  "源码模式：纸铺满预览栏（重排生效）",
  Math.abs(source.paperWidth - source.clientWidth) <= 2,
  `纸 ${source.paperWidth.toFixed(1)}px / 栏 ${source.clientWidth}px`,
);
check(
  "源码模式：预览字号 = 编辑区字号（14px）",
  Math.abs(source.fontPx - 14) <= 0.1,
  `字号 ${source.fontPx.toFixed(2)}px`,
);
check(
  "源码模式：请求页宽 = 栏宽 × 11/14，且产物照做",
  source.requestedWidthPt !== null &&
    Math.abs(source.requestedWidthPt - (source.clientWidth * 11) / 14) <= 1 &&
    Math.abs(source.pageWidthPt - source.requestedWidthPt) <= 1,
  `请求 ${source.requestedWidthPt}pt / 产物 ${source.pageWidthPt}pt`,
);
check("源码模式：没有横向滚动条", source.overflowX <= 1, `溢出 ${source.overflowX}px`);

await toDocumentMode();
await viewport(760);
const narrowWrite = await measured();
check(
  "窄窗口文档模式：纸跟着栏宽缩（重排），字号仍 14px",
  Math.abs(narrowWrite.paperWidth - narrowWrite.clientWidth) <= 2 &&
    Math.abs(narrowWrite.fontPx - 14) <= 0.1,
  `纸 ${narrowWrite.paperWidth.toFixed(1)}px / 栏 ${narrowWrite.clientWidth}px / 字号 ${narrowWrite.fontPx.toFixed(2)}px`,
);
check(
  "窄窗口文档模式：没有横向滚动条",
  narrowWrite.overflowX <= 1,
  `溢出 ${narrowWrite.overflowX}px`,
);

await toSourceMode();
await viewport(560);
const narrowSource = await measured();
check(
  "极窄窗口源码模式：页宽不低于下限、字号仍 14px、不横滚",
  narrowSource.pageWidthPt >= 179.5 &&
    Math.abs(narrowSource.fontPx - 14) <= 0.1 &&
    narrowSource.overflowX <= 1,
  `页宽 ${narrowSource.pageWidthPt}pt / 字号 ${narrowSource.fontPx.toFixed(2)}px / 溢出 ${narrowSource.overflowX}px`,
);

// 注入被文档自己的纸型覆盖：必须退回等比缩放（不横滚、字号不超过编辑区）。
// **不重启页面**：桩是在**每次编译**时读 `reflowfail`，改完查询串触发一次重编译即可。
await c.evaluate(
  "history.replaceState(null, '', location.pathname + '?browserdev=1&reflowfail=1'); true",
);
await toDocumentMode(); // 模式切换 → 栏宽变化 → 重排请求变化 → 重编译
await toSourceMode();
const fallback = await measured();
check(
  "重排被覆盖时退回等比缩放：产物仍是文档自己的纸型、不横滚、字号不超过编辑区",
  Math.abs(fallback.pageWidthPt - 595.28) <= 1 &&
    fallback.fontPx < 14 &&
    fallback.fontPx > 0 &&
    fallback.overflowX <= 1,
  `页宽 ${fallback.pageWidthPt}pt / 字号 ${fallback.fontPx.toFixed(2)}px / 溢出 ${fallback.overflowX}px`,
);

// 回到宽栏必须关闭重排，不能把已缩窄的产物误学为自然纸型、也不能无限重编译。
await c.evaluate("history.replaceState(null, '', location.pathname + '?browserdev=1'); true");
await toDocumentMode();
await viewport(1400);
const restored = await measured();
const stableCount = await settledCompiles();
await sleep(800);
check(
  "变宽恢复自然纸型且没有重排编译循环",
  restored.requestedWidthPt === null &&
    Math.abs(restored.pageWidthPt - 595.28) <= 1 &&
    Math.abs(restored.fontPx - 14) <= 0.1 &&
    (await c.evaluate("window.__browserDevCompileCount")) === stableCount,
);

// 连续拖动仅提交最后一份几何，旧的宽栏产物也不能在窄栏横滚。
const beforeDrag = await c.evaluate("window.__browserDevCompileCount");
for (const width of [1000, 900, 800, 700]) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(30);
}
await sleep(100);
const duringDrag = await measured();
const afterDrag = await settledCompiles();
const dragged = await measured();
check(
  "连续缩窄去抖为一次编译，过渡和最终均不横滚",
  afterDrag === beforeDrag + 1 &&
    duringDrag.overflowX <= 1 &&
    dragged.overflowX <= 1 &&
    Math.abs(dragged.pageWidthPt - dragged.requestedWidthPt) <= 1 &&
    dragged.fontPx <= 14.1,
);

// 直接收窄可用栏宽到页宽下限以下，字号应减小而不能突破栏宽。
await c.evaluate("document.querySelector('.preview-body').style.width='100px'; true");
await settledCompiles();
const tiny = await measured();
check(
  "小于页宽下限的栏仍不横滚且字号不超过源码",
  tiny.requestedWidthPt === 180 &&
    Math.abs(tiny.pageWidthPt - 180) <= 1 &&
    tiny.paperWidth <= tiny.clientWidth + 1 &&
    tiny.overflowX <= 1 &&
    tiny.fontPx > 0 &&
    tiny.fontPx < 14,
);
await c.evaluate("document.querySelector('.preview-body').style.width=''; true");

async function replaceSource(src) {
  await c.evaluate(`(() => {
    const v=window.__typstPadView;
    v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(src)}},selection:{anchor:${src.length}}});
    return true;
  })()`);
}

async function trackCompileRequests() {
  await c.evaluate(`(() => {
    window.__reflowRequests=[];
    const internals=window.__TAURI_INTERNALS__, invoke=internals.invoke;
    internals.invoke=async (command,args) => {
      if(command!=='compile_doc')return invoke(command,args);
      const request={src:args.src,preview:args.previewPage??null,completed:false,widths:[]};
      window.__reflowRequests.push(request);
      const result=await invoke(command,args);
      request.completed=true;
      request.widths=(result.pages??[]).filter(Boolean).map(svg=>Number(svg.match(/viewBox="[^" ]+ [^" ]+ ([^" ]+)/)[1]));
      return result;
    };
    return true;
  })()`);
}

async function observeSinglePageUpdates() {
  await c.evaluate(`(() => {
    const hosts=[...document.querySelectorAll('#preview-host .document-page')];
    if(hosts.length!==1)throw Error('迟到场景必须从单页开始');
    window.__reflowPageHost=hosts[0];
    window.__reflowUpdates=[];
    window.__lightDomReflowUpdates=0;
    new MutationObserver(() => { window.__lightDomReflowUpdates++; })
      .observe(document.querySelector('#preview-host'),{childList:true,subtree:true});
    new MutationObserver(() => {
      const svg=hosts[0].shadowRoot.querySelector('svg');
      if(!svg)throw Error('页面应用后缺少SVG');
      window.__reflowUpdates.push({width:svg.viewBox.baseVal.width,text:svg.textContent,
        pages:document.querySelectorAll('#preview-host .document-page').length});
    }).observe(hosts[0].shadowRoot,{childList:true,subtree:true});
    return true;
  })()`);
}

// 在途的窄栏结果不能回写已经恢复宽栏的文档模式。
await viewport(1400);
await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: [], settleMs: 600 });
await settledCompiles();
await replaceSource("迟到单页初始");
await settledCompiles();
await trackCompileRequests();
await observeSinglePageUpdates();
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await c.waitFor("window.__reflowRequests.some(r=>r.preview!==null&&!r.completed)");
await c.key("e", { code: "KeyE", keyCode: 69, modifiers: 2 });
await replaceSource("迟到单页更新");
await settledCompiles();
const late = await measured();
check(
  "迟到窄栏结果不回写已恢复的宽栏文档模式",
  late.requestedWidthPt === null &&
    Math.abs(late.pageWidthPt - 595.28) <= 1 &&
    (await c.evaluate(`window.__reflowUpdates.length>0 &&
      window.__reflowUpdates.some(update=>update.text.includes('迟到单页更新')) &&
      window.__reflowUpdates.every(update=>Math.abs(update.width-595.28)<=1 && update.pages===1) &&
      window.__lightDomReflowUpdates===0 &&
      window.__reflowPageHost===document.querySelector('#preview-host .document-page') &&
      window.__reflowRequests.some(r=>r.preview!==null && r.completed && r.widths.length===1 && r.widths[0]<595)`)),
  await c.evaluate(
    "JSON.stringify({requests:window.__reflowRequests,updates:window.__reflowUpdates})",
  ),
);

// 真实不同纸型夹具不照做请求：自然纸型来自最宽页，不得学成已请求的窄页或来回编译。
const [real] = loadFixtures("page-fixtures.json");
await boot(c, DEV_URL, { pageFixtures: [real] });
await c.evaluate(`(() => {
  const v=window.__typstPadView;
  v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(real.doc)}}});
  return true;
})()`);
await settledCompiles();
await viewport(1200);
await toSourceMode();
const realSize = await c.evaluate(`(() => {
  const request=window.__browserDevLastCompile.previewPage;
  const svgs=[...document.querySelectorAll('#preview-host .document-page')].map(h=>h.shadowRoot.querySelector('svg'));
  const widest=svgs.reduce((a,b)=>a.viewBox.baseVal.width>b.viewBox.baseVal.width?a:b);
  const box=widest.viewBox.baseVal, body=document.querySelector('.preview-body');
  return {request, ratio:box.height/box.width, width:box.width, overflow:body.scrollWidth-body.clientWidth};
})()`);
const realCount = await settledCompiles();
await sleep(800);
check(
  "真实多纸型产物学最宽页比例，覆盖回退不横滚且不循环",
  realSize.request &&
    Math.abs(realSize.width - 480) <= 1 &&
    Math.abs(realSize.request.heightPt / realSize.request.widthPt - realSize.ratio) < 0.001 &&
    realSize.overflow <= 1 &&
    (await c.evaluate("window.__browserDevCompileCount")) === realCount,
  JSON.stringify(realSize),
);

// 同会话修改纸型：先学习当前原文的自然纸型，再决定是否缩窄，不能把旧投影当基准。
await viewport(1400);
await boot(c, DEV_URL, { pageFixtures: [] });
const paperSource = (width, height, text = "单页纸型") =>
  `#set page(width: ${width}pt, height: ${height}pt, margin: 20pt)\n${text}`;
const largePaper = paperSource(480, 640);
const smallPaper = paperSource(240, 320);
await replaceSource(largePaper);
await settledCompiles();
await toSourceMode();
await c.evaluate(`(() => {
  const body=document.querySelector('.preview-body');
  body.style.width=(400+body.offsetWidth-body.clientWidth)+'px';
  return true;
})()`);
await settledCompiles();
await trackCompileRequests();
const baseline = await measured();
if (Math.abs(baseline.requestedWidthPt - 314.29) > 1)
  throw new Error(`未建立约400px窄栏的重排基线：${JSON.stringify(baseline)}`);
let firstRequest = await c.evaluate("window.__reflowRequests.length");
await replaceSource(smallPaper);
await settledCompiles();
const small = await measured();
check(
  "同会话纸型缩小到能容纳时关闭投影，恢复240pt自然宽度",
  small.requestedWidthPt === null &&
    Math.abs(small.pageWidthPt - 240) <= 0.01 &&
    Math.abs(small.paperWidth - 305.45) <= 1 &&
    small.overflowX <= 1 &&
    (await c.evaluate(`window.__reflowRequests[${firstRequest}]?.preview===null`)),
  JSON.stringify(small),
);
firstRequest = await c.evaluate("window.__reflowRequests.length");
await replaceSource(largePaper);
await settledCompiles();
const enlarged = await measured();
check(
  "同会话反向改大先无投影学习，再按新自然比例缩窄",
  Math.abs(enlarged.requestedWidthPt - 314.29) <= 1 &&
    Math.abs(enlarged.requestedHeightPt / enlarged.requestedWidthPt - 640 / 480) < 0.001 &&
    (await c.evaluate(`window.__reflowRequests[${firstRequest}]?.preview===null &&
      window.__reflowRequests.slice(${firstRequest}).length===2`)),
);
await replaceSource(paperSource(480, 960));
await settledCompiles();
const taller = await measured();
check(
  "自然页宽不变而页高变化时重新学习比例",
  Math.abs(taller.requestedWidthPt - 314.29) <= 1 &&
    Math.abs(taller.requestedHeightPt / taller.requestedWidthPt - 2) < 0.001 &&
    Math.abs(taller.pageHeightPt / taller.pageWidthPt - 2) < 0.001,
  JSON.stringify(taller),
);

async function savePrefix(code, enabled = true) {
  await c.evaluate(`(() => {
    [...document.querySelectorAll('.menubar .menu-title')].find(e=>e.textContent.trim().startsWith('文件')).click();
    return true;
  })()`);
  await c.waitFor("!!document.querySelector('.menu-dropdown')");
  await c.evaluate(
    "[...document.querySelectorAll('.menu-dropdown .menu-item')].find(e=>e.textContent.includes('设置')).click(); true",
  );
  await c.waitFor("!!document.querySelector('.settings-modal')");
  await c.evaluate(`(() => {
    const label=[...document.querySelectorAll('.settings-row')].find(e=>e.textContent.includes('启用前缀代码'));
    const checkbox=label.querySelector('input');
    if(checkbox.checked!==${enabled})checkbox.click();
    const textarea=document.querySelector('.settings-textarea');
    textarea.value=${JSON.stringify(code)};textarea.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.settings-modal .modal-btn.primary').click();
    return true;
  })()`);
  await settledCompiles();
}
await replaceSource("前缀纸型正文");
await settledCompiles();
await savePrefix(largePaper.split("\n")[0]);
const prefixedLarge = await measured();
firstRequest = await c.evaluate("window.__reflowRequests.length");
await savePrefix(smallPaper.split("\n")[0]);
const prefixedSmall = await measured();
await savePrefix(smallPaper.split("\n")[0], false);
const prefixDisabled = await measured();
check(
  "前缀纸型修改与禁用均重新学习当前自然纸型",
  prefixedLarge.requestedWidthPt !== null &&
    prefixedSmall.requestedWidthPt === null &&
    Math.abs(prefixedSmall.pageWidthPt - 240) <= 0.01 &&
    prefixDisabled.requestedWidthPt !== null &&
    Math.abs(prefixDisabled.pageHeightPt / prefixDisabled.pageWidthPt - 841.89 / 595.28) < 0.001 &&
    (await c.evaluate(`window.__reflowRequests[${firstRequest}]?.preview===null`)),
  JSON.stringify({ prefixedLarge, prefixedSmall, prefixDisabled }),
);

// 快速连续编辑只学习最终源码；resize不应使已学习的自然纸型失效。
firstRequest = await c.evaluate("window.__reflowRequests.length");
const finalPaper = paperSource(480, 480, "快速编辑最终纸型");
for (const src of [smallPaper, largePaper, finalPaper]) {
  await replaceSource(src);
  await sleep(30);
}
const rapidCount = await settledCompiles();
await sleep(800);
const rapid = await measured();
check(
  "快速连续编辑去抖为最终源码的自然学习及一次重排，随后稳定",
  Math.abs(rapid.requestedHeightPt / rapid.requestedWidthPt - 1) < 0.001 &&
    (await c.evaluate(`window.__reflowRequests.slice(${firstRequest}).length===2 &&
      window.__reflowRequests.slice(${firstRequest}).every(r=>r.src===${JSON.stringify(finalPaper)}) &&
      window.__browserDevCompileCount===${rapidCount}`)),
);

// 旧源码的自然学习已在途时继续编辑，不能把旧的小纸型学进当前文档或短暂显示它。
await c.evaluate(
  "history.replaceState(null,'',location.pathname+'?browserdev=1&compileslow=1'); true",
);
await observeSinglePageUpdates();
firstRequest = await c.evaluate("window.__reflowRequests.length");
await replaceSource(smallPaper);
await c.waitFor(
  `window.__reflowRequests.length>${firstRequest} && window.__typstPadScheduleStats?.().inFlight`,
);
const staleNaturalRequest = await c.evaluate(`window.__reflowRequests[${firstRequest}].preview`);
await replaceSource(paperSource(480, 960, "中间编辑纸型"));
await sleep(30);
await replaceSource(finalPaper);
const latestCount = await settledCompiles();
await sleep(800);
const latest = await measured();
check(
  "过期自然学习不能落地或污染新纸型，连续编辑最终稳定",
  staleNaturalRequest === null &&
    Math.abs(latest.requestedWidthPt - 314.29) <= 1 &&
    Math.abs(latest.requestedHeightPt / latest.requestedWidthPt - 1) < 0.001 &&
    (await c.evaluate(`window.__reflowUpdates.length>0 &&
      window.__reflowUpdates.some(update=>update.text.includes('快速编辑最终纸型')) &&
      window.__reflowUpdates.every(update=>Math.abs(update.width-240)>1 && update.pages===1) &&
      window.__reflowRequests.slice(${firstRequest}).length===3 &&
      window.__browserDevCompileCount===${latestCount}`)),
  await c.evaluate(
    "JSON.stringify({requests:window.__reflowRequests.slice(-3),updates:window.__reflowUpdates})",
  ),
);

await finish(`通过 ${state.passed} 项检查（预览重排）`);
