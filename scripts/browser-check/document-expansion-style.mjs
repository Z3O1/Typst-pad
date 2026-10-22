// 样式专用探针：真实 Typst 产物、原生逐字 caret、源码模式字号与实际截图像素。
import { writeFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, loadFixtures, compileSettled, shotPath } from "./harness.mjs";

const fixtures = loadFixtures("expansion-fixtures.json");
const empty = loadFixtures("cursor-fixtures.json").find((f) => f.name === "empty");
if (!empty) throw Error("缺少真实空文档激活夹具");
const c = await connect();
const measurements = [];
const fixture = (name) => {
  const result = fixtures.find((f) => f.name === name);
  if (!result) throw Error(`缺少真实样式夹具：${name}`);
  return result;
};
const settled = (value) => c.waitFor(compileSettled(value.source ?? value.doc), { timeout: 8000 });
async function clickCaret(p) {
  if (!p) throw Error("缺少真实激活停靠点");
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return {x:r.left+(p.xPt+1-v.x)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
}
function caretAt(value, pos) {
  const { from, renderedFrom, blankLines = [] } = value.range;
  const relative = pos - from;
  const blank = blankLines.findIndex((line) => relative >= line.from && relative <= line.at);
  const rendered =
    renderedFrom +
    (blank >= 0
      ? blankLines[blank].at + blank
      : relative + blankLines.filter((line) => line.at < relative).length);
  const offset = Buffer.byteLength(value.doc.slice(0, rendered));
  const caret = value.cursorQueries.find((q) => q.offset === offset)?.caret;
  if (!caret) throw Error(`原生 caret 缺失：${value.name}:${pos}`);
  return caret;
}
try {
  await boot(c, DEV_URL, { pageFixtures: [...fixtures, empty] });
  await c.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await c.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  for (const name of ["math", "display-math", "empty-compact", "empty-multiline"]) {
    const expanded = fixture(name);
    const normal = fixture(
      name === "math" ? "base" : name === "display-math" ? "display-base" : `${name}-base`,
    );
    if (await c.evaluate("!!document.querySelector('.document-pane')"))
      await c.key("e", { keyCode: 69, modifiers: 2 });
    await c.selectAll();
    if (name.startsWith("empty-")) {
      // 从空文档真实占位点输入 $，多行场景走真实 Enter，不伪造空公式命中。
      await c.key("Backspace", { keyCode: 8 });
      await c.key("e", { keyCode: 69, modifiers: 2 });
      await settled(empty);
      await clickCaret(empty.cursorQueries.find((q) => q.offset === 0)?.caret);
      await c.send("Input.dispatchKeyEvent", { type: "char", text: "$", key: "$" });
      if (name === "empty-multiline") await c.key("Enter", { keyCode: 13 });
    } else {
      await c.type(normal.original);
      await c.key("e", { keyCode: 69, modifiers: 2 });
      await settled(normal);
      const bodyOffset = Buffer.byteLength(normal.doc.slice(0, normal.doc.indexOf("正文")));
      await clickCaret(normal.cursorQueries.find((q) => q.offset === bodyOffset)?.caret);
      await c.evaluate(
        `window.__typstPadView.dispatch({selection:{anchor:${expanded.range.from + 1}}});window.__typstPadView.focus();true`,
      );
    }
    await settled(expanded);
    const identity = await c.evaluate(
      `(() => {const expected=${JSON.stringify(expanded.pages)},hosts=[...document.querySelectorAll('#preview-host>.document-page')];return hosts.length===expected.length&&hosts.every((h,i)=>{const t=document.createElement('div');t.innerHTML=expected[i];return h.shadowRoot.querySelector('svg').isEqualNode(t.firstElementChild)})})()`,
    );
    if (!identity) throw Error(`完整 SVG 与真实夹具不同：${name}`);
    for (const theme of ["light", "dark"]) {
      await c.send("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: theme },
          { name: "prefers-reduced-motion", value: "reduce" },
        ],
      });
      await c.waitFor(
        `document.querySelector('.app').classList.contains('light')===${theme === "light"}`,
      );
      let stops = 0;
      for (let pos = expanded.range.from + 1; pos < expanded.range.to; pos++) {
        const p = caretAt(expanded, pos);
        if (name === "math" || name === "empty-compact") {
          // 真实点击每个高亮字符，不能仅把前端光标与同一份错误的原生查询互相比较。
          await clickCaret(p);
          await c.waitFor(`window.__typstPadView.state.selection.main.head===${pos}`);
        } else {
          await c.evaluate(
            `window.__typstPadView.dispatch({selection:{anchor:${pos}}});window.__typstPadView.focus();true`,
          );
        }
        await c.waitFor(
          `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],el=document.querySelector('.document-caret');if(!h||!el)return false;const r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal,actual=el.getBoundingClientRect(),x=r.left+(p.xPt-v.x)*r.width/v.width,y=r.top+(p.yPt-v.y)*r.height/v.height;return Math.abs(actual.left-x)<.1&&Math.abs(actual.top-y)<.1&&Math.abs(actual.height-p.heightPt*r.height/v.height)<.1})()`,
        );
        stops++;
      }
      const p = caretAt(expanded, expanded.range.to - 1);
      const metrics = await c.evaluate(
        `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal,cm=getComputedStyle(document.querySelector('.cm-editor')),scroll=getComputedStyle(document.querySelector('.cm-scroller')),caret=document.querySelector('.document-caret').getBoundingClientRect();return {sourceFontPx:parseFloat(cm.fontSize),sourceFontFamily:scroll.fontFamily,sourceLineHeightPx:parseFloat(scroll.lineHeight),renderedFontPx:11*r.width/v.width,caret:{x:caret.x,y:caret.y,width:caret.width,height:caret.height},filter:getComputedStyle(h).filter}})()`,
      );
      if (Math.abs(metrics.sourceFontPx - 14) > 0.01 || Math.abs(metrics.renderedFontPx - 14) > 0.1)
        throw Error(`字号不是源码模式14px：${JSON.stringify(metrics)}`);
      const clip = {
        x: metrics.caret.x,
        y: metrics.caret.y,
        width: Math.max(2, metrics.caret.width),
        height: metrics.caret.height,
        scale: 1,
      };
      const visible = await c.send("Page.captureScreenshot", { format: "png", clip });
      await c.evaluate("document.querySelector('.document-caret').style.visibility='hidden'");
      const hidden = await c.send("Page.captureScreenshot", { format: "png", clip });
      await c.evaluate("document.querySelector('.document-caret').style.visibility=''");
      const changedPixels = await c.evaluate(
        `(async()=>{async function pixels(data){const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,image.width,image.height).data}const a=await pixels(${JSON.stringify(visible.data)}),b=await pixels(${JSON.stringify(hidden.data)});let changed=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])changed++;return changed})()`,
      );
      if (changedPixels < 5) throw Error(`光标没有真实可见像素：${name}:${theme}`);
      await c.screenshot(shotPath(`style-${name}-${theme}`));
      measurements.push({ name, theme, stops, changedPixels, ...metrics });
      console.log(`STYLE_PROBE ${JSON.stringify(measurements.at(-1))}`);
    }
    await c.key("e", { keyCode: 69, modifiers: 2 });
    await settled(normal);
    const sourceMetrics = await c.evaluate(
      "({fontPx:parseFloat(getComputedStyle(document.querySelector('.cm-editor')).fontSize),fontFamily:getComputedStyle(document.querySelector('.cm-scroller')).fontFamily,lineHeightPx:parseFloat(getComputedStyle(document.querySelector('.cm-scroller')).lineHeight)})",
    );
    if (sourceMetrics.fontPx !== 14) throw Error("源码模式实际字号应为14px");
    await c.screenshot(shotPath(`style-${name}-source`));
  }
  const totalStops = measurements.reduce((sum, m) => sum + m.stops, 0);
  if (measurements.length !== 8 || totalStops !== 44)
    throw Error(`样式探针覆盖不完整：${measurements.length}/8 场景，${totalStops}/44 停靠点`);
  writeFileSync(
    new URL("../../.browser-check/style-probe.json", import.meta.url),
    JSON.stringify(measurements, null, 2),
  );
  console.log(
    `通过 ${measurements.length} 项检查；真实明暗主题场景、${totalStops} 个原生 caret 停靠点，含多行空公式与实际光标像素。`,
  );
} finally {
  c.close();
}
