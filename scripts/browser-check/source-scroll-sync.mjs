// Real Typst SVG/cursor/hit fixture + actual Chromium wheel events. No synthetic percentage mapping.
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
import { writeFileSync } from "node:fs";

const { check, state } = createChecker();
const c = await connect();
const [fixture] = loadFixtures("source-scroll-fixtures.json", {
  predicate: (items) =>
    items.length === 1 && items[0].pages.length >= 5 && items[0].cursorQueries.length > 100,
});
const evidence = [];
await boot(c, DEV_URL, { pageFixtures: [fixture] });
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.evaluate(
  `(() => {const v=window.__typstPadView; v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(fixture.doc)}},selection:{anchor:0}});v.focus();return true})()`,
);
await c.waitFor(COMPILE_IDLE);
await sleep(700);

const measure = () =>
  c.evaluate(`(() => {
  const v=window.__typstPadView, s=v.scrollDOM, b=document.querySelector('.preview-body');
  const r=s.getBoundingClientRect(), content=v.contentDOM.getBoundingClientRect();
  const pos=v.posAtCoords({x:Math.max(r.left+2,content.left+2),y:r.top+s.clientHeight*.2});
  const row=pos===null?null:v.coordsAtPos(pos);
  const byte=pos===null?null:new TextEncoder().encode(v.state.doc.sliceString(0,pos)).length;
  const caret=window.__typstPageFixtures[0].cursorQueries.find(q=>q.offset===byte)?.caret;
  let error=null;
  if(caret&&row){const page=document.querySelector('.document-page[data-page="'+caret.page+'"]');const p=page.getBoundingClientRect();const vb=page.shadowRoot.querySelector('svg').viewBox.baseVal;error=(p.top+caret.yPt/vb.height*p.height-b.getBoundingClientRect().top)-(row.top-r.top)/r.height*b.clientHeight;}
  return {source:s.scrollTop,preview:b.scrollTop,left:s.scrollLeft,pos,byte,caret,error,
    selection:v.state.selection.toJSON(),doc:v.state.doc.toString(),focus:v.hasFocus,
    counts:{...window.__browserDevCallCounts},compile:window.__browserDevCompileCount,
    mode:document.querySelector('.panes').classList.contains('document-mode')?'write':'source'};
})()`);
const wheel = async (pane, delta) => {
  const p = await c.evaluate(
    `(() => {const r=${pane === "source" ? "window.__typstPadView.scrollDOM" : "document.querySelector('.preview-body')"}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
  );
  await c.wheel(p.x, p.y, delta);
  await sleep(90);
};
async function sourceLine(index) {
  const delta = await c.evaluate(
    `(() => {const v=window.__typstPadView;const lines=v.state.doc.toString().split('\\n');let n=0;let pos=0;for(const line of lines){if(line.startsWith('段落 ')&&n++===${index})break;pos+=line.length+1;}return v.lineBlockAt(pos).top-v.scrollDOM.scrollTop-v.scrollDOM.clientHeight*.2+v.documentPadding.top+v.defaultLineHeight/2})()`,
  );
  await wheel("source", delta);
  await sleep(200);
  const value = await measure();
  evidence.push(value);
  return value;
}
const initial = await measure();
check(
  "source fixture renders all real multi-page SVGs",
  await c.evaluate(
    `(() => {const pages=Array.from(document.querySelectorAll('.document-page'));return pages.length===window.__typstPageFixtures[0].pages.length&&pages.every((p,i)=>{const host=document.createElement('div');host.innerHTML=window.__typstPageFixtures[0].pages[i];return p.shadowRoot.querySelector('svg').isEqualNode(host.firstElementChild)})})()`,
  ),
);

const forward = await sourceLine(45);
check(
  "source wheel crosses pages using actual UTF-8 cursor geometry",
  forward.caret?.page > 1 && forward.preview > 500 && Math.abs(forward.error) < 25,
  JSON.stringify(forward),
);
const beforeReverse = await measure();
await wheel("preview", -700);
await sleep(250);
const reverse = await measure();
evidence.push(reverse);
const reverseOracle = await c.evaluate(`(() => {
  const v=window.__typstPadView,b=document.querySelector('.preview-body'),br=b.getBoundingClientRect();
  const y=br.top+b.clientHeight*.2;
  const pages=Array.from(document.querySelectorAll('.document-page')).map(host=>({host,rect:host.getBoundingClientRect()}));
  pages.sort((a,z)=>Math.max(a.rect.top-y,0,y-a.rect.bottom)-Math.max(z.rect.top-y,0,y-z.rect.bottom));
  const p=pages[0],box=p.host.shadowRoot.querySelector('svg').viewBox.baseVal;
  const pt=Math.max(0,Math.min(box.height,(y-p.rect.top)/p.rect.height*box.height));
  const hit=window.__typstPageFixtures[0].whitespaceHits.find(q=>q.page===Number(p.host.dataset.page)&&Math.abs(q.yPt-pt)<1)?.caret;
  if(!hit)return null;
  const pos=new TextDecoder().decode(new TextEncoder().encode(v.state.doc.toString()).slice(0,hit.offset)).length;
  const row=v.coordsAtPos(pos),sr=v.scrollDOM.getBoundingClientRect();
  return row?{pos,page:hit.page,error:row.top-sr.top-v.scrollDOM.clientHeight*.2}:null;
})()`);
evidence.push({ reverseOracle });
check(
  "preview wheel maps real native page hit to the corresponding visual source row",
  reverse.source < beforeReverse.source - 50 && reverseOracle && Math.abs(reverseOracle.error) < 25,
  JSON.stringify(reverseOracle),
);
check(
  "both directions preserve document, selection and editor focus",
  reverse.doc === initial.doc &&
    JSON.stringify(reverse.selection) === JSON.stringify(initial.selection) &&
    reverse.focus === initial.focus,
);
check(
  "scrolling never compiles or saves",
  reverse.compile === initial.compile &&
    (reverse.counts.write_file ?? 0) === (initial.counts.write_file ?? 0),
);
const quiet = reverse.counts.document_cursor + reverse.counts.document_hit_test;
await sleep(600);
const quietAfter = await measure();
check(
  "programmatic counterpart scroll emits no query echo loop",
  quietAfter.counts.document_cursor + quietAfter.counts.document_hit_test === quiet,
);

await c.key("z", { keyCode: 90, modifiers: 2 });
const undone = await c.evaluate("window.__typstPadView.state.doc.toString()");
await c.key("Z", { keyCode: 90, modifiers: 10 });
await sleep(700);
await c.waitFor(COMPILE_IDLE);
check("scroll effects add no undo history", undone === "" && (await measure()).doc === fixture.doc);

await c.key("z", { keyCode: 90, modifiers: 4 });
await sleep(200);
const wrapped = await sourceLine(70);
check(
  "wrapped visual source rows stay geometry-linked across pages",
  wrapped.caret?.page > 2 && Math.abs(wrapped.error) < 25,
  JSON.stringify(wrapped),
);
await c.evaluate(
  "window.__typstPadView.contentDOM.style.fontSize='19px';window.__typstPadView.requestMeasure();true",
);
await sleep(200);
const font = await sourceLine(35);
check(
  "source font-size measurement uses new row height, not line count",
  font.caret && Math.abs(font.error) < 25,
  JSON.stringify(font),
);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 760,
  deviceScaleFactor: 1.25,
  mobile: false,
});
await sleep(750);
await c.waitFor(COMPILE_IDLE);
const resized = await sourceLine(50);
check(
  "viewport/DPR reflow uses current page and wrapped row geometry",
  resized.caret && Math.abs(resized.error) < 25,
  JSON.stringify(resized),
);

// A comment row intentionally has no output: no guessed percentage jump.
const blankBefore = await measure();
const commentDelta = await c.evaluate(
  "(() => {const v=window.__typstPadView;const pos=v.state.doc.toString().indexOf('// no output 60');return v.lineBlockAt(pos).top-v.scrollDOM.scrollTop-v.scrollDOM.clientHeight*.2+v.documentPadding.top+v.defaultLineHeight/2})()",
);
await wheel("source", commentDelta);
await sleep(250);
const blank = await measure();
check(
  "unmapped comment/blank source rows safely leave preview alone",
  blank.caret === null || blank.caret === undefined
    ? Math.abs(blank.preview - blankBefore.preview) < 1
    : false,
  JSON.stringify(blank),
);

// Nonwrapping horizontal position is independent of the vertical counterpart scroll.
await c.key("z", { keyCode: 90, modifiers: 4 });
await sleep(200);
await c.evaluate(
  "window.__typstPadView.contentDOM.style.fontSize='14px';window.__typstPadView.requestMeasure();true",
);
await sourceLine(50);
const hp = await c.evaluate(
  "(() => {const r=window.__typstPadView.scrollDOM.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
await c.wheel(hp.x, hp.y, 0, { deltaX: 300 });
await sleep(150);
const horizontal = await measure();
await wheel("preview", 500);
await sleep(250);
const afterHorizontal = await measure();
check(
  "preview-driven vertical scroll preserves long-line horizontal scroll",
  horizontal.left > 10 && Math.abs(afterHorizontal.left - horizontal.left) < 1,
  JSON.stringify({ before: horizontal.left, after: afterHorizontal.left }),
);

await c.evaluate(
  "history.replaceState(null,'',location.pathname+'?browserdev=1&compileslow=1');true",
);
const resetX = await c.evaluate(
  "(() => {const r=window.__typstPadView.scrollDOM.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
await c.wheel(resetX.x, resetX.y, 0, { deltaX: -1000 });
await sleep(100);
await sourceLine(20);
const fontPending = await measure();
await c.key(",", { keyCode: 188, modifiers: 2 });
await c.waitFor("!!document.querySelector('.settings-select')");
await c.evaluate(
  "(() => {const s=document.querySelector('.settings-select');s.value='Noto Serif SC';s.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.settings-modal .primary').click();return true})()",
);
await sleep(170);
const fontChanged = await measure();
check(
  "font configuration change invalidates a delayed old cursor reply",
  fontPending.caret && Math.abs(fontChanged.preview - fontPending.preview) < 1,
);
await sleep(800);
await c.waitFor(COMPILE_IDLE);
await c.evaluate("window.__typstPadView.focus();true");
await sourceLine(25);
const zoomPending = await measure();
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await sleep(450);
const zoomChanged = await measure();
check(
  "UI zoom invalidates delayed cursor geometry",
  zoomPending.caret &&
    Math.abs(zoomChanged.preview - zoomPending.preview) < 1 &&
    (await c.evaluate("document.querySelector('.statusbar').textContent.includes('110%')")),
);
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 1000,
  height: 691,
  deviceScaleFactor: 1.375,
  mobile: false,
});
await sleep(600);
await c.waitFor(COMPILE_IDLE);
await c.evaluate("history.replaceState(null,'',location.pathname+'?browserdev=1');true");
const zoomed = await sourceLine(35);
check(
  "fresh scroll after zoom uses resized actual source/page geometry",
  zoomed.caret && Math.abs(zoomed.error) < 25,
  JSON.stringify(zoomed),
);
await c.screenshot(shotPath("source-scroll-sync-linked"));
await c.evaluate(
  "history.replaceState(null,'',location.pathname+'?browserdev=1&compileslow=1');true",
);

const delayedStart = await measure();
await wheel("source", 400);
await wheel("preview", -500);
const latestManual = await measure();
await sleep(650);
const delayedEnd = await measure();
check(
  "rapid opposite manual wheel wins over delayed source reply",
  Math.abs(delayedEnd.preview - latestManual.preview) < 1 &&
    delayedEnd.source !== delayedStart.source,
  JSON.stringify({ latestManual, delayedEnd }),
);
check(
  "rapid delayed roundtrip has bounded native query count",
  delayedEnd.counts.document_cursor -
    delayedStart.counts.document_cursor +
    (delayedEnd.counts.document_hit_test - delayedStart.counts.document_hit_test) <=
    3,
);

await wheel("source", 300);
await c.key("e", { keyCode: 69, modifiers: 2 });
await sleep(650);
const write = await measure();
check(
  "leaving source invalidates delayed reply and disables dual-pane link",
  write.mode === "write",
);
const writeQueries = write.counts.document_hit_test ?? 0;
await wheel("preview", 400);
await sleep(500);
const writeAfter = await measure();
check(
  "write-mode wheel never starts scroll hit queries",
  (writeAfter.counts.document_hit_test ?? 0) === writeQueries,
);

await c.key("e", { keyCode: 69, modifiers: 2 });
await sleep(700);
await c.waitFor(COMPILE_IDLE);
await sourceLine(40);
await wheel("source", 300);
const preEdit = await measure();
await c.evaluate(
  "(() => {const v=window.__typstPadView;v.dispatch({changes:{from:0,insert:'// revision change\\n'}});return true})()",
);
await sleep(180);
const edited = await measure();
check(
  "revision change prevents delayed old geometry from scrolling preview",
  Math.abs(edited.preview - preEdit.preview) < 1,
);
await sleep(900);
await c.waitFor(COMPILE_IDLE);
const staleBefore = await measure();
await wheel("source", 300);
await sleep(450);
const staleAfter = await measure();
check(
  "unmatched/failed geometry never guesses a preview target",
  Math.abs(staleAfter.preview - staleBefore.preview) < 1,
);

// Return to the same real source, then replace the document through the real session command.
await c.evaluate(
  `(() => {const v=window.__typstPadView;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:${JSON.stringify(fixture.doc)}}});return true})()`,
);
await sleep(1000);
await c.waitFor(COMPILE_IDLE);
await sourceLine(30);
await wheel("source", 350);
await c.evaluate("window.__browserDevConfirm=true;true");
await c.key("n", { keyCode: 78, modifiers: 2 });
await c.waitFor("window.__typstPadView.state.doc.length===0");
await sleep(700);
const newSession = await measure();
check(
  "new session cancels the old scroll query without selection/source restoration",
  newSession.doc === "" &&
    newSession.selection.ranges[0].anchor === 0 &&
    newSession.source === 0 &&
    newSession.preview === 0,
  JSON.stringify(newSession),
);

await c.screenshot(shotPath("source-scroll-sync"));
writeFileSync(
  new URL("../../.browser-check/source-scroll-sync-measurements.json", import.meta.url),
  JSON.stringify(evidence, null, 2),
);
finish(`通过 ${state.passed} 项检查（source-scroll-sync，失败 ${state.failed} 项）`);
