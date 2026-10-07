// DOM 阶段的可复现隔离探针：重复真实 SVG 页，不冒充真实 100 页动态编译或桌面 IPC。
import { connect, DEV_URL } from "./cdp.mjs";
import { boot, loadFixtures, createChecker, finish } from "./harness.mjs";
const fixtures = loadFixtures("page-fixtures.json", { hint: "先跑 npm run fixtures:pages" });
const c = await connect();
const { check, state } = createChecker();
await boot(c, DEV_URL, { pageFixtures: fixtures });
const result = await c.evaluate(`(async () => {
  const {createDocumentPages}=await import('/src/lib/ui/document-pages.ts');
  const samples=${JSON.stringify(fixtures[0].pages)};
  const sources=Array.from({length:100},(_,i)=>samples[i%samples.length]);
  const scroller=document.createElement('div');
  scroller.style.cssText='position:fixed;inset:0 auto auto 0;width:500px;height:400px;overflow:auto;z-index:9999';
  document.querySelector('.app').append(scroller);
  const makePaper=()=>{
    const paper=document.querySelector('#preview-host').cloneNode(false);
    paper.removeAttribute('id');paper.hidden=false;paper.style.width='480px';
    scroller.replaceChildren(paper);return paper;
  };
  const legacy=makePaper();
  const joined=sources.join('<div class="page-separator" style="height:1px"></div>');
  let start=performance.now();legacy.innerHTML=joined;
  for(const svg of legacy.querySelectorAll(':scope>svg')){
    svg.style.cssText='display:block;height:auto;margin-inline:auto;width:'+svg.viewBox.baseVal.width/480*100+'%';
  }
  void legacy.offsetHeight;
  const legacyInitialMs=performance.now()-start;
  const modified=sources.slice();modified[0]=modified[0].replace('<svg','<svg data-perf="changed"');
  start=performance.now();legacy.innerHTML=modified.join('<div style="height:1px"></div>');
  for(const svg of legacy.querySelectorAll(':scope>svg')){
    svg.style.cssText='display:block;height:auto;margin-inline:auto;width:'+svg.viewBox.baseVal.width/480*100+'%';
  }
  void legacy.offsetHeight;
  const legacyUpdateMs=performance.now()-start;
  const paper=makePaper(),pages=createDocumentPages(paper);
  start=performance.now();pages.update(sources);void paper.offsetHeight;
  const isolatedInitialMs=performance.now()-start;
  const exact=sources.every((src,i)=>{
    const expected=document.createElement('div');expected.innerHTML=src;
    return pages.page(i+1).svg.isEqualNode(expected.firstChild);
  });
  const before=Array.from({length:100},(_,i)=>pages.page(i+1).svg);
  const height=paper.getBoundingClientRect().height;
  start=performance.now();const changed=pages.update(modified);void paper.offsetHeight;
  const isolatedUpdateMs=performance.now()-start;
  const reused=changed===1&&before.slice(1).every((svg,i)=>svg===pages.page(i+2).svg);
  const scoped=pages.page(1).svg.getRootNode()!==pages.page(2).svg.getRootNode()&&
    pages.page(1).svg.getRootNode().querySelector('[id]')!==pages.page(2).svg.getRootNode().querySelector('[id]');
  const stable=Math.abs(paper.getBoundingClientRect().height-height)<.1&&height>30000;
  const last=pages.page(100),rect=last.host.getBoundingClientRect();
  const target=pages.nearest({x:rect.left+rect.width/2,y:rect.top+rect.height/2});
  const nearest=target?.page===100&&Math.abs(target.xPt-last.box.width/2)<.01&&Math.abs(target.yPt-last.box.height/2)<.01;
  scroller.scrollTop=scroller.scrollHeight;
  const visible=last.host.getBoundingClientRect().top<scroller.getBoundingClientRect().bottom;
  scroller.remove();
  return {exact,reused,scoped,stable,nearest:nearest&&visible,legacyInitialMs,legacyUpdateMs,isolatedInitialMs,isolatedUpdateMs};
})()`);
check("100 页均保留真实 SVG 原始节点", result.exact);
check("重复 SVG 引用位于独立页面作用域", result.scoped);
check("单页更新复用其余 99 页节点", result.reused);
check("离屏页面保留完整纸型与总滚动高度", result.stable);
check("长文档末页坐标命中与滚动仍正确", result.nearest);
console.log(`DOCDOMPERF ${JSON.stringify(result)}`);
// 逐节点一致不足以证明 <use>/clipPath 等引用可绘制；再比较真实 Chromium 像素。
const setup = (isolated) => `(async () => {
  document.querySelector('#pixel-probe')?.remove();
  const container=document.createElement('div');container.id='pixel-probe';
  container.style.cssText='position:fixed;left:0;top:0;width:500px;height:500px;overflow:hidden;background:white;z-index:9999';
  document.querySelector('.app').append(container);
  const paper=document.querySelector('#preview-host').cloneNode(false);
  paper.removeAttribute('id');paper.hidden=false;paper.style.width='480px';
  paper.style.setProperty('--night-svg-filter','none');container.append(paper);
  const sources=${JSON.stringify(fixtures[0].pages)};
  if(${isolated}) {
    const {createDocumentPages}=await import('/src/lib/ui/document-pages.ts');
    createDocumentPages(paper).update(sources);
  } else {
    paper.innerHTML=sources.join('<div style="height:1px"></div>');
    for(const svg of paper.querySelectorAll(':scope>svg'))svg.style.cssText='display:block;height:auto;margin-inline:auto;width:'+svg.viewBox.baseVal.width/480*100+'%';
  }
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  return true;
})()`;
await c.evaluate(setup(false));
const reference = await c.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: 0, y: 0, width: 500, height: 500, scale: 1 },
});
await c.evaluate(setup(true));
const isolated = await c.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: 0, y: 0, width: 500, height: 500, scale: 1 },
});
const equalPixels = await c.evaluate(`(async () => {
  async function pixels(data) {
    const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,image.width,image.height).data;
  }
  const a=await pixels(${JSON.stringify(reference.data)}),b=await pixels(${JSON.stringify(isolated.data)});
  document.querySelector('#pixel-probe').remove();
  return a.length===b.length&&a.every((value,index)=>value===b[index]);
})()`);
check("Shadow DOM 页面与直接 SVG 的首屏像素一致", equalPixels);
await c.close();
finish(`通过 ${state.passed} 项检查；100 页 DOM 隔离性能探针`);
