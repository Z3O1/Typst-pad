// 光标驱动展开：真实全页产物、选区、调度和重排后的插入点一起验证。
import { connect, DEV_URL } from "./cdp.mjs";
import {
  boot,
  loadFixtures,
  createChecker,
  compileSettled,
  COMPILE_IDLE,
  sleep,
  finish,
  shotPath,
} from "./harness.mjs";
const expansion = loadFixtures("expansion-fixtures.json", {
  predicate: (fs) => fs.length === 32 && fs.every((f) => f.pages.length && f.cursorQueries.length),
  hint: "先跑 npm run fixtures:pages",
});
const fixtures = [...loadFixtures("page-fixtures.json"), ...expansion];
const f = (name) => {
  const value = expansion.find((f) => f.name === name);
  if (!value) throw Error(`缺少展开夹具 ${name}`);
  return value;
};
const base = f("base"),
  math = f("math"),
  edited = f("math-edited"),
  outer = f("outer"),
  block = f("block");
const { check, state } = createChecker();
const c = await connect();
await boot(c, DEV_URL, { pageFixtures: fixtures });
const count = () => c.evaluate("window.__browserDevCallCounts.compile_doc??0");
const doc = () => c.evaluate("window.__typstPadView.state.doc.toString()");
const settled = (value) => c.waitFor(compileSettled(value.doc), { timeout: 8000 });
const cursor = (head, anchor = head) =>
  c.evaluate(
    `window.__typstPadView.dispatch({selection:{anchor:${anchor},head:${head}}});window.__typstPadView.focus();true`,
  );
async function pagesMatch(value) {
  return c.evaluate(
    `(() => {const expected=${JSON.stringify(value.pages)},svgs=[...document.querySelectorAll('#preview-host>.document-page')].map(host=>host.shadowRoot.querySelector('svg'));return svgs.length===expected.length&&svgs.every((svg,i)=>{const div=document.createElement('div');div.innerHTML=expected[i];return svg.isEqualNode(div.firstElementChild)})})()`,
  );
}
async function bubbleMatches(value) {
  await c.waitFor("!!document.querySelector('.formula-preview-content svg')");
  return c.evaluate(
    `(() => {const div=document.createElement('div');div.innerHTML=${JSON.stringify(value.formulaPreview?.svg)};return document.querySelector('.formula-preview-content svg').isEqualNode(div.firstElementChild)})()`,
  );
}
/** 设置视口尺寸（长公式窄窗/靠底翻转需要不同窗口） */
async function viewport(width, height = 900) {
  await c.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
}
/** 等编译调度彻底稳定（覆盖预览重排的 250ms 去抖与自然纸型学习） */
async function compileQuiesce(timeoutMs = 6000) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < timeoutMs) {
    const n = await c.evaluate("window.__browserDevCompileCount ?? 0");
    if (n !== last) stableSince = Date.now();
    if (n > 0 && Date.now() - stableSince >= 600 && (await c.evaluate(COMPILE_IDLE))) return n;
    last = n;
    await sleep(100);
  }
  throw new Error("编译未在超时内稳定");
}
/** 盒外箭头真实可见：外层不裁剪（overflow=visible），且箭头三角形中部的 hit-test 命中卡片本身 */
function arrowVisible(dir) {
  return c.evaluate(`(() => {
    const card = document.querySelector('.formula-preview');
    if (!card) return false;
    const cs = getComputedStyle(card);
    if (cs.overflow !== 'visible') return false;
    const arrow = parseFloat(cs.getPropertyValue('--formula-arrow'));
    if (!Number.isFinite(arrow)) return false;
    const r = card.getBoundingClientRect();
    const x = r.left + arrow;
    const y = ${dir === "up" ? "r.top - 4" : "r.bottom + 4"};
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === card || card.contains(hit));
  })()`);
}
/** 卡片（含盒外箭头）整体都落在预览可见区内，且不撑出应用横向滚动条 */
async function cardWithinViewport() {
  const evidence = await c.evaluate(`(() => {
    const card = document.querySelector('.formula-preview');
    if (!card) return false;
    const r = card.getBoundingClientRect();
    const body = document.querySelector('.preview-body');
    const br = body.getBoundingClientRect();
    const arrow = 8;
    const top = r.top - (card.classList.contains('flipped') ? 0 : arrow);
    const bottom = r.bottom + (card.classList.contains('flipped') ? arrow : 0);
    const right = br.left + body.clientWidth, bottomEdge = br.top + body.clientHeight;
    return {
      within: top >= br.top - 0.5 && bottom <= bottomEdge + 0.5 &&
        r.left >= br.left - 0.5 && r.right <= right + 0.5 &&
        body.scrollWidth <= body.clientWidth + 1,
      cardAndArrow: {left:r.left, right:r.right, top, bottom},
      viewport: {left:br.left, right, top:br.top, bottom:bottomEdge}
    };
  })()`);
  console.log(`card bounds: ${JSON.stringify(evidence)}`);
  return !!evidence?.within;
}
/** 内容层可见窗口/滚动尺寸与 SVG 渲染尺寸：验证滚动条占位不把短高内容吃光 */
function contentView() {
  return c.evaluate(`(() => {
    const el = document.querySelector('.formula-preview-content');
    if (!el) return null;
    const svg = el.querySelector('svg');
    const r = el.getBoundingClientRect();
    return {
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      svgWidth: svg ? svg.getBoundingClientRect().width : 0,
      svgHeight: svg ? svg.getBoundingClientRect().height : 0,
      rectWidth: r.width,
      rectHeight: r.height,
    };
  })()`);
}
/** 首/末实际绘制节点必须有可见几何且命中该节点；根 SVG 与空白容器不是字形。 */
async function glyphVisible(edge, selector = ".formula-preview-content") {
  const evidence = await c.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const svg = el && el.querySelector('svg');
    if (!el || !svg || el.clientWidth <= 0 || el.clientHeight <= 0) return null;
    const r = el.getBoundingClientRect();
    const nodes = [...svg.querySelectorAll('use,text,path,rect,circle,ellipse,polygon,polyline,line')]
      .filter(node => !node.closest('defs,clipPath,mask,symbol') &&
        getComputedStyle(node).visibility === 'visible' &&
        getComputedStyle(node).display !== 'none' &&
        (getComputedStyle(node).fill !== 'none' || getComputedStyle(node).stroke !== 'none'))
      .map(node => ({node, rect: node.getBoundingClientRect()}))
      .filter(({rect}) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => ${edge === "left" ? "a.rect.left - b.rect.left" : "b.rect.right - a.rect.right"});
    const glyph = nodes[0];
    if (!glyph) return null;
    const g = glyph.rect;
    const left = Math.max(g.left, r.left), right = Math.min(g.right, r.left + el.clientWidth);
    const top = Math.max(g.top, r.top), bottom = Math.min(g.bottom, r.top + el.clientHeight);
    if (right <= left || bottom <= top) return null;
    // 字形包围盒中心可能是空洞；采样只接受所选绘制节点的真实命中。
    for (let yi = 1; yi < 8; yi++) for (let xi = 1; xi < 8; xi++) {
      const x = left + (right - left) * xi / 8, y = top + (bottom - top) * yi / 8;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === glyph.node || glyph.node.contains(hit))) return {
        tag: glyph.node.tagName, href: glyph.node.getAttribute('href') || glyph.node.getAttribute('xlink:href'),
        glyph: {left:g.left, top:g.top, right:g.right, bottom:g.bottom},
        client: {width:el.clientWidth, height:el.clientHeight}, hit: {tag:hit.tagName, x, y}
      };
    }
    return null;
  })()`);
  console.log(`glyph ${edge} ${selector}: ${JSON.stringify(evidence)}`);
  return !!evidence;
}
// 空白 SVG 的根节点命中不能证明首/末字形可见。
await c.evaluate(`(() => {
  const el = document.createElement('div');
  el.id = 'blank-glyph-probe';
  el.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:40px;z-index:999999';
  el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><defs><path d="M0 0h100v40H0z"/></defs><g></g></svg>';
  document.body.append(el);
})()`);
check(
  "空白 SVG 根命中不是首末绘制字形",
  !(await glyphVisible("left", "#blank-glyph-probe")) &&
    !(await glyphVisible("right", "#blank-glyph-probe")),
);
await c.evaluate("document.querySelector('#blank-glyph-probe').remove()");
function query(value, head) {
  let rendered = head;
  if (value.range) {
    const { from, to } = value.range;
    if (head >= from && head <= to) rendered = value.range.renderedFrom + head - from;
    else if (head > to) rendered += value.doc.length - value.original.length;
  }
  return renderedQuery(value, rendered);
}
function renderedQuery(value, rendered) {
  const offset = Buffer.byteLength(value.doc.slice(0, rendered));
  const result = value.cursorQueries.find((q) => q.offset === offset);
  if (!result?.caret) throw Error(`所测展开字素必须有原生光标：${value.name}:${rendered}`);
  return result.caret;
}
async function caretMatches(value, head, visible = false) {
  const caret = query(value, head);
  const expression = `(() => {const p=${JSON.stringify(caret)},host=document.querySelectorAll('#preview-host>.document-page')[p.page-1],el=document.querySelector('.document-caret');if(!host||!el)return false;const r=host.getBoundingClientRect(),v=host.shadowRoot.querySelector('svg').viewBox.baseVal,root=document.querySelector('.preview-canvas').getBoundingClientRect(),body=document.querySelector('.preview-body').getBoundingClientRect();const x=r.left+(p.xPt-v.x)*r.width/v.width,y=r.top+(p.yPt-v.y)*r.height/v.height;return Math.abs(parseFloat(el.style.left)+root.left-x)<.1&&Math.abs(parseFloat(el.style.top)+root.top-y)<.1&&(!${visible}||(x>=body.left&&x<body.right&&y>=body.top&&y<body.bottom))})()`;
  await c.waitFor(expression, { timeout: 4000, interval: 16 });
  return true;
}
// 字形是 Typst SVG 路径而非 CSS text；用原生光标高度与实际背景盒验证样式。
async function sourceStyleMatches(value, { formula, panel }) {
  const first = query(value, value.range.from);
  const last = query(value, value.range.to - 1);
  const result = await c.evaluate(`(() => {
    const first=${JSON.stringify(first)},last=${JSON.stringify(last)};
    const host=document.querySelectorAll('#preview-host>.document-page')[first.page-1];
    const svg=host.shadowRoot.querySelector('svg'),view=svg.viewBox.baseVal;
    const scale=host.getBoundingClientRect().width/view.width;
    const fill=${JSON.stringify(formula ? "#f4f1f8" : panel ? "#f3f5f8" : "#eef1f5")};
    const ink=${JSON.stringify(formula ? "#65458b" : "#273449")};
    const background=svg.querySelector('path[fill="'+fill+'"]');
    const glyph=svg.querySelector('use[fill="'+ink+'"]');
    if(!background||!glyph||first.page!==last.page) return false;
    const filter=getComputedStyle(host).filter;
    if(filter!=='none'&&filter!=='invert(1) contrast(0.71)') return false;
    const luminance=(color) => {
      const channels=color.match(/[0-9.]+/g).slice(0,3).map(Number).map(c=>c/255)
        .map(c=>filter==='none'?c:(1-c)*.71+.145)
        .map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
      return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
    };
    const a=luminance(getComputedStyle(glyph).fill),b=luminance(getComputedStyle(background).fill);
    const contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    const readable=first.heightPt>=10&&first.heightPt<=14&&first.heightPt*scale>=12;
    if(!${panel}) return readable&&contrast>=4.5;
    const rect=background.getBoundingClientRect(),page=host.getBoundingClientRect();
    const x=p=>page.left+(p.xPt-view.x)*scale;
    const y=p=>page.top+(p.yPt-view.y)*scale;
    const outline=background.parentElement.querySelector('path[stroke]');
    if(!outline) return false;
    const border=getComputedStyle(outline);
    const glyphs=[...svg.querySelectorAll('use[fill="'+ink+'"]')].map(el=>el.getBoundingClientRect());
    const inkTop=Math.min(...glyphs.map(r=>r.top)),inkBottom=Math.max(...glyphs.map(r=>r.bottom));
    // Typst 默认末行按 baseline 排版，descender 会进入 7pt inset；实际墨迹仍须留出 5pt。
    // 光标使用 em 高度，不等于墨迹盒，完整光标也须留在面板内。
    const valid=readable&&contrast>=4.5&&border.stroke!=='none'&&parseFloat(border.strokeWidth)>=.5
      &&/[Cc]/.test(background.getAttribute('d'))
      &&Math.abs(rect.width/scale-312)<1
      &&x(first)-rect.left>=8*scale&&rect.right-x(last)>=8*scale
      &&inkTop-rect.top>=6.5*scale&&rect.bottom-inkBottom>=5*scale
      &&y(first)>=rect.top&&y(last)+last.heightPt*scale<=rect.bottom;
    return {valid,readable,contrast,stroke:border.stroke,strokeWidth:border.strokeWidth,width:rect.width/scale,left:(x(first)-rect.left)/scale,right:(rect.right-x(last))/scale,top:(inkTop-rect.top)/scale,bottom:(rect.bottom-inkBottom)/scale,caretBottom:(rect.bottom-y(last)-last.heightPt*scale)/scale};
  })()`);
  if (typeof result === "boolean") return result;
  if (!result.valid) console.error("展开样式测量", JSON.stringify(result));
  return result.valid;
}
async function setTheme(theme) {
  await c.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  await c.waitFor(
    `document.querySelector('.app').classList.contains('light')===${theme === "light"}`,
  );
}
async function replace(value = base) {
  if (await c.evaluate("!!document.querySelector('.document-pane')"))
    await c.key("e", { keyCode: 69, modifiers: 2 });
  await c.selectAll();
  await c.type(value.original);
  await c.key("e", { keyCode: 69, modifiers: 2 });
  await settled(value);
  // 先点击实际正文激活输入；后续选择事务与真实键盘复用同一展开流程。
  const p = query(value, value.original.indexOf("正文"));
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(p)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt+1-v.x)*r.width/v.width,y:r.top+(p.yPt+p.heightPt/2-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await c.waitFor(
    `window.__typstPadView.hasFocus&&window.__typstPadView.state.selection.main.head===${value.original.indexOf("正文")}`,
  );
}
await replace();
check("正文保持完整原生页面，激活输入不展开普通文字", await pagesMatch(base));
const beforeMath = await count();
await cursor(math.range.from + 1);
await settled(math);
check(
  "键盘进入公式一次编译完整展开，源码保持不变",
  (await count()) === beforeMath + 1 && (await doc()) === base.original && (await pagesMatch(math)),
);
await caretMatches(math, math.range.from + 1, true);
check("展开后的插入点来自新原生几何且位于视口内", true);
check(
  "公式预览为源码下方黑色浮动气泡，SVG 来自真实 Typst 帧",
  (await bubbleMatches(math)) &&
    (await c.evaluate(
      "document.querySelector('.formula-preview').getBoundingClientRect().top > document.querySelector('.document-caret').getBoundingClientRect().bottom && getComputedStyle(document.querySelector('.formula-preview')).backgroundColor === 'rgb(17, 17, 17)'",
    )),
);
check(
  "向上箭头真实可见且指向源码（外层不裁剪）",
  (await arrowVisible("up")) &&
    (await c.evaluate(
      `(() => {const el=document.querySelector('.formula-preview');const cs=getComputedStyle(el,'::before');return cs.borderBottomWidth==='8px'&&cs.borderBottomColor==='rgb(17, 17, 17)'&&cs.borderBottomStyle==='solid'})()`,
    )),
);
check("向上箭头连同卡片都落在预览可见区内", await cardWithinViewport());
await c.screenshot(shotPath("document-expansion-arrow-up"));
const beforePreviewClick = await count();
const previewPoint = await c.evaluate(
  "(() => {const r=document.querySelector('.formula-preview').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()",
);
await c.click(previewPoint.x, previewPoint.y);
await c.waitFor(`window.__typstPadView.state.selection.main.head===${math.range.from + 1}`);
await caretMatches(math, math.range.from + 1, true);
check(
  "点击预览回到对应源码编辑，不重复编译或把插入点留在预览",
  (await count()) === beforePreviewClick && (await doc()) === base.original,
);
await c.screenshot(shotPath("document-expansion-inline-preview"));
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  check(
    `行内公式 ${theme}：真实字号可读，滤镜后前景/浅底对比度至少 4.5`,
    await sourceStyleMatches(math, { formula: true, panel: false }),
  );
  await c.screenshot(shotPath(`document-expansion-inline-${theme}`));
}
const stable = await count();
await c.key("ArrowRight", { keyCode: 39 });
await caretMatches(math, math.range.from + 2);
check("表达式内部逐字移动不重编译、不收起", (await count()) === stable);
await cursor(math.range.to - 1);
await settled(math);
await c.key("ArrowRight", { keyCode: 39 });
await settled(base);
check("向右跨过关闭边界恢复正常排版", await pagesMatch(base));
await cursor(math.range.to + 1);
await c.key("ArrowLeft", { keyCode: 37 });
await settled(math);
check("从右侧进入边界按左亲和性展开", await pagesMatch(math));
await cursor(math.range.from + 1);
await c.key("ArrowLeft", { keyCode: 37 });
await settled(base);
check("向左跨过开始边界收起，不立即重开旧表达式", await pagesMatch(base));
await cursor(math.range.from + 2);
await settled(math);
const beforeSwitch = await count();
await cursor(outer.range.from + 2);
await settled(outer);
check(
  "直接切换另一完整调用只请求一轮新投影",
  (await count()) === beforeSwitch + 1 && (await pagesMatch(outer)),
);
const beforeNested = await count();
await cursor(base.original.indexOf("c + d"));
await cursor(base.original.indexOf("strong"));
await sleep(200);
check(
  "已展开父调用内遍历嵌套公式与脚本不切换范围",
  (await count()) === beforeNested && (await pagesMatch(outer)),
);
const tail = base.original.indexOf("后文");
await cursor(tail, outer.range.from + 2);
await sleep(200);
check(
  "Shift/反向选区离开范围不改变排版中的父展开",
  (await count()) === beforeNested && (await pagesMatch(outer)),
);
await cursor(tail);
await settled(base);
check("选区收拢后由活动端决定收起", await pagesMatch(base));
await cursor(base.original.indexOf("c + d"));
await settled(f("nested-math"));
check("未展开父范围时定位内层公式只展开最小完整表达式", await pagesMatch(f("nested-math")));
const embeddedMath = f("embedded-math"),
  declaration = f("math-declaration"),
  codeBlock = f("code-block");
const embeddedHead = base.original.indexOf("#sym.beta");
const beforeEmbedded = await count();
await cursor(embeddedHead);
await settled(embeddedMath);
await caretMatches(embeddedMath, embeddedHead, true);
check(
  "数学模式中的 # 展开整段公式，直接使用新几何而不触发错误回退",
  (await count()) === beforeEmbedded + 1 && (await pagesMatch(embeddedMath)),
);
const declarationHead = declaration.range.from + "#let formula = ".length;
const beforeDeclaration = await count();
await cursor(declarationHead);
await settled(declaration);
await caretMatches(declaration, declarationHead, true);
check(
  "代码模式中的公式展开完整 # 声明，保留执行和后文输出",
  (await count()) === beforeDeclaration + 1 && (await pagesMatch(declaration)),
);
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  check(
    `行内脚本 ${theme}：中性前景与浅底可读，和公式使用相同字号`,
    await sourceStyleMatches(declaration, { formula: false, panel: false }),
  );
  await c.screenshot(shotPath(`document-expansion-script-inline-${theme}`));
}
const declarationStable = await count();
await cursor(declaration.range.to - 1);
await caretMatches(declaration, declaration.range.to - 1);
check(
  "# 结束分号仍在展开范围内，不成为 raw 外的正文或重复重排",
  (await count()) === declarationStable && (await pagesMatch(declaration)),
);
await c.key("ArrowRight", { keyCode: 39 });
await settled(base);
check("跨出 # 的完整语法边界后恢复原文排版", await pagesMatch(base));
const blankCodeHead = codeBlock.original.indexOf("\n\n // 代码空白") + 1;
const beforeCodeBlock = await count();
await cursor(blankCodeHead);
await settled(codeBlock);
const commentHead = codeBlock.original.indexOf("代码空白");
await cursor(commentHead);
await caretMatches(codeBlock, commentHead, true);
check(
  "# 代码块的空白和注释也按语法展开，原文与后续输出不变",
  (await count()) === beforeCodeBlock + 1 &&
    (await doc()) === base.original &&
    (await pagesMatch(codeBlock)),
);
await cursor(block.range.from + 2);
await settled(block);
const bracket = block.range.from + "#block".length;
await cursor(bracket);
await caretMatches(block, bracket, true);
check("多行展开首行标点有真实字素停靠点，不沿用函数名几何", await pagesMatch(block));
await c.screenshot(shotPath("document-expansion-multiline"));
const beforeTheme = await count();
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  check(
    `多行脚本 ${theme}：实际圆角面板、边界内距、可读字号与滤镜后对比度`,
    await sourceStyleMatches(block, { formula: false, panel: true }),
  );
  await cursor(block.range.to - 1);
  await caretMatches(block, block.range.to - 1, true);
  await cursor(bracket);
  await caretMatches(block, bracket, true);
  if (!(await pagesMatch(block))) throw Error("主题切换不能改写展开的真实 SVG");
  await c.screenshot(shotPath(`document-expansion-${theme}`));
}
check("展开面板在明暗主题下保留真实页面和光标，不重新编译", (await count()) === beforeTheme);
const blockStable = await count();
await cursor(block.original.indexOf("第二行中文"));
await cursor(block.original.indexOf("多行脚本"));
check("展开多行内容跨行移动不反复编译", (await count()) === blockStable);
const blockEnd = block.original.indexOf("多行脚本正文。") + "多行脚本正文。".length;
await cursor(blockEnd);
await c.type("续");
await settled(f("block-edited"));
check(
  "多行展开输入映射范围并由真实 Typst 保持完整页面",
  (await doc()) === f("block-edited").original && (await pagesMatch(f("block-edited"))),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(block);
check(
  "展开内撤销同步源码和投影，不丢展开归属",
  (await doc()) === base.original && (await pagesMatch(block)),
);
await cursor(math.range.to - 1);
await settled(math);
const beforeTyping = await count();
await c.evaluate(`(() => {
  window.__expansionTypingInputs=[];
  const internals=window.__TAURI_INTERNALS__,invoke=internals.invoke;
  internals.invoke=(command,args)=>{
    if(command==='compile_doc')window.__expansionTypingInputs.push(args.src);
    return invoke(command,args);
  };
  return true;
})()`);
await c.type(" + ");
await c.type("z");
const immediateTypingCount = await count();
await settled(edited);
check(
  "逐键输入共用编辑去抖，最终仅原文测量及展示各一次",
  immediateTypingCount === beforeTyping &&
    (await count()) === beforeTyping + 2 &&
    (await c.evaluate(
      `JSON.stringify(window.__expansionTypingInputs)===${JSON.stringify(JSON.stringify([edited.original, edited.doc]))}`,
    )) &&
    (await doc()) === edited.original &&
    (await pagesMatch(edited)),
);
await c.key("z", { keyCode: 90, modifiers: 2 });
await settled(math);
check(
  "公式编辑撤销保持同一展开与当前源码",
  (await doc()) === base.original && (await pagesMatch(math)),
);
await c.key("y", { keyCode: 89, modifiers: 2 });
await settled(edited);
check("公式编辑重做恢复正确范围映射和产物", await pagesMatch(edited));
await c.key("Escape", { keyCode: 27 });
await c.waitFor(compileSettled(edited.original));
check(
  "Esc 显式收起且不写入围栏或保存文件",
  (await doc()) === edited.original &&
    (await pagesMatch(f("edited-base"))) &&
    (await c.evaluate("!window.__browserDevWrites?.length")),
);
await replace();
await cursor(math.range.from + 2);
await settled(math);
const beforeComposition = await count();
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));true",
);
await cursor(outer.range.from + 2);
await sleep(250);
check(
  "合成期间移动活动端不展开另一范围或启动排版",
  (await count()) === beforeComposition && (await pagesMatch(math)),
);
await c.evaluate(
  "document.querySelector('.cm-content').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true",
);
await settled(outer);
check(
  "合成结束先按最终光标切换范围，再恢复一次调度",
  (await count()) === beforeComposition + 1 && (await pagesMatch(outer)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await c.waitFor(compileSettled(base.original));
check(
  "模式切换清除临时展开但保留真实选区和源码",
  (await doc()) === base.original &&
    (await c.evaluate(`window.__typstPadView.state.selection.main.head===${outer.range.from + 2}`)),
);
await c.key("e", { keyCode: 69, modifiers: 2 });
await settled(base);
check("返回文档不凭旧展开锁抢占当前光标", await pagesMatch(base));

await boot(c, `${DEV_URL}&compileslow=1`, { pageFixtures: fixtures });
await replace();
await cursor(math.range.from + 2);
await c.waitFor("window.__typstPadScheduleStats?.().inFlight");
await cursor(outer.range.from + 2);
await cursor(tail);
await settled(base);
check(
  "连续跨表达式移动作废迟到展开，最终产物跟随最后光标",
  (await doc()) === base.original && (await pagesMatch(base)),
);
for (const prefix of ["raw-hidden", "raw-replaced"]) {
  const original = f(`${prefix}-base`),
    expanded = f(`${prefix}-math`);
  await replace(original);
  const before = await count();
  await cursor(expanded.range.from + 1);
  await settled(expanded);
  await caretMatches(expanded, expanded.range.from + 1, true);
  check(
    `${prefix}：用户 show raw 不隐藏或替换展开源码，真实停靠点可见`,
    (await count()) === before + 1 &&
      (await doc()) === original.original &&
      (await pagesMatch(expanded)),
  );
  await c.key("Escape", { keyCode: 27 });
  await settled(original);
  check(`${prefix}：收起恢复原文，普通 raw 仍遵循用户规则`, await pagesMatch(original));
}
const display = f("display-math");
await replace(f("display-base"));
await cursor(display.range.from + 2);
await settled(display);
await caretMatches(display, display.range.from + 2, true);
check(
  "块公式同样在源码下方浮动预览，不进入正文页面",
  (await bubbleMatches(display)) &&
    (await pagesMatch(display)) &&
    (await doc()) === display.original,
);
await c.screenshot(shotPath("document-expansion-display-preview"));
for (const theme of ["dark", "light"]) {
  await setTheme(theme);
  check(
    `多行公式 ${theme}：与脚本统一的圆角/内距，保留低饱和紫色与可读对比度`,
    await sourceStyleMatches(display, { formula: true, panel: true }),
  );
  await cursor(display.range.from + 1);
  await caretMatches(display, display.range.from + 1, true);
  await cursor(display.range.to - 1);
  await caretMatches(display, display.range.to - 1, true);
  await c.screenshot(shotPath(`document-expansion-formula-panel-${theme}`));
}
const counter = f("counter");
await replace(f("counter-base"));
await cursor(counter.range.from + 2);
await settled(counter);
check(
  "普通脚本不显示预览，但仍保留一次 counter 副作用",
  /COUNT:\s*1/.test(counter.visibleText) &&
    !counter.formulaPreview &&
    (await c.evaluate("!document.querySelector('.formula-preview')")) &&
    (await pagesMatch(counter)) &&
    (await doc()) === counter.original,
);
for (const name of ["number", "fraction"]) {
  const baseValue = f(`${name}-base`),
    expanded = f(name);
  await replace(baseValue);
  const hit = baseValue.formulaHits.find(
    (h) =>
      h.caret.offset > Buffer.byteLength(baseValue.original.slice(0, expanded.range.from)) &&
      h.caret.offset < Buffer.byteLength(baseValue.original.slice(0, expanded.range.to)),
  );
  if (!hit || hit.caret.isWhitespace) throw Error("真实公式区域命中不能被误判为空白");
  const point = await c.evaluate(
    `(() => {const p=${JSON.stringify(hit)},h=document.querySelectorAll('#preview-host>.document-page')[p.page-1],r=h.getBoundingClientRect(),v=h.shadowRoot.querySelector('svg').viewBox.baseVal;return{x:r.left+(p.xPt-v.x)*r.width/v.width,y:r.top+(p.yPt-v.y)*r.height/v.height}})()`,
  );
  await c.click(point.x, point.y);
  await settled(expanded);
  check(
    `${name}：真实鼠标点击数字或分式中心正常展开`,
    (await pagesMatch(expanded)) &&
      (await bubbleMatches(expanded)) &&
      (await doc()) === expanded.original,
  );
  await c.screenshot(shotPath(`document-expansion-${name}-bubble`));
  await c.key("Escape", { keyCode: 27 });
  await settled(baseValue);
  check(
    `${name}：收起移除气泡，恢复原始页面`,
    (await pagesMatch(baseValue)) &&
      (await c.evaluate("!document.querySelector('.formula-preview')")),
  );
}
for (const name of ["long-line", "tall-matrix", "nested-fraction"]) {
  const baseValue = f(`${name}-base`),
    expanded = f(name);
  await replace(baseValue);
  await cursor(expanded.range.from + 2);
  await settled(expanded);
  await caretMatches(expanded, expanded.range.from + 2, true);
  check(
    `${name}：长公式展开并显示同次编译的真实浮动预览`,
    (await pagesMatch(expanded)) &&
      (await bubbleMatches(expanded)) &&
      (await doc()) === expanded.original,
  );
  // 长/高公式预览卡片不越出预览可见区，也不撑出横向滚动条（必要时只在卡片内滚动）。
  check(
    `${name}：预览卡片不越出预览可见区且不横滚`,
    await c.evaluate(
      `(() => {const b=document.querySelector('.formula-preview');if(!b)return false;const r=b.getBoundingClientRect();const body=document.querySelector('.preview-body');const br=body.getBoundingClientRect();return r.left>=br.left-0.5&&r.right<=br.right+0.5&&body.scrollWidth<=body.clientWidth+1})()`,
    ),
  );
  await c.screenshot(shotPath(`document-expansion-${name}-preview`));
  await c.key("Escape", { keyCode: 27 });
  await settled(baseValue);
  check(
    `${name}：收起移除气泡，恢复原始页面`,
    (await pagesMatch(baseValue)) &&
      (await c.evaluate("!document.querySelector('.formula-preview')")),
  );
}

// 窄窗长行：真实触发卡片内横向滚动，滚动条/wheel/点击不误定位、不额外编译、不丢展开与焦点。
await viewport(520, 900);
const longLine = f("long-line"),
  longLineBase = f("long-line-base");
await replace(longLineBase);
await compileQuiesce();
await cursor(longLine.range.from + 2);
await settled(longLine);
await caretMatches(longLine, longLine.range.from + 2, true);
await c.waitFor("!!document.querySelector('.formula-preview')", { timeout: 4000 });
check("窄窗长行展开且气泡不越出可见区", await cardWithinViewport());
const narrowContent = await contentView();
check(
  "窄窗长行横滚时可见高度为正且能放下完整短公式 SVG",
  narrowContent.clientHeight > 0 && narrowContent.clientHeight >= narrowContent.svgHeight - 0.5,
  JSON.stringify(narrowContent),
);
check("滚首（scrollLeft=0）有真实字形可见", await glyphVisible("left"));
const narrowScroll = await c.evaluate(`(() => {
  const el=document.querySelector('.formula-preview-content');
  const card=document.querySelector('.formula-preview').getBoundingClientRect();
  return {scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,cardLeft:card.left,cardTop:card.top};
})()`);
check(
  "窄窗长行触发卡片内横向滚动",
  narrowScroll.scrollWidth > narrowScroll.clientWidth + 1,
  JSON.stringify(narrowScroll),
);
const beforeScroll = await count();
// 拖横向滚动条到末尾：点在滚动条槽（内容区底部），drag 到最右。
const scrollbar = await c.evaluate(`(() => {
  const el=document.querySelector('.formula-preview-content').getBoundingClientRect();
  return {x:el.left+el.width/2,y:el.bottom-7};
})()`);
await c.drag(scrollbar.x, scrollbar.y, scrollbar.x + 400, scrollbar.y);
await sleep(80);
const scrollEnd = await c.evaluate(`(() => {
  const el=document.querySelector('.formula-preview-content');
  const card=document.querySelector('.formula-preview').getBoundingClientRect();
  return {scrollLeft:el.scrollLeft,max:el.scrollWidth-el.clientWidth,cardLeft:card.left,cardTop:card.top};
})()`);
check(
  "拖动滚动条能滚到横向末尾",
  scrollEnd.scrollLeft >= scrollEnd.max - 1,
  JSON.stringify(scrollEnd),
);
check("滚末（scrollLeft=max）有真实字形可见", await glyphVisible("right"));
check(
  "滚动条拖动不误定位、不额外编译、不丢展开",
  scrollEnd.cardLeft === narrowScroll.cardLeft &&
    scrollEnd.cardTop === narrowScroll.cardTop &&
    (await count()) === beforeScroll &&
    (await c.evaluate("!!document.querySelector('.formula-preview')")) &&
    (await doc()) === longLine.original,
);
// wheel 横向滚动（shift+wheel）也不触发点击/重编译。
const wheelAt = await c.evaluate(`(() => {
  const el=document.querySelector('.formula-preview-content').getBoundingClientRect();
  return {x:el.left+el.width/2,y:el.top+10};
})()`);
await c.wheel(wheelAt.x, wheelAt.y, 0, { deltaX: -120, modifiers: 8 });
await sleep(80);
check(
  "wheel 滚动不误定位、不额外编译、不丢展开",
  (await count()) === beforeScroll &&
    (await c.evaluate("!!document.querySelector('.formula-preview')")) &&
    (await doc()) === longLine.original,
);
await c.screenshot(shotPath("document-expansion-long-line-narrow-scroll"));
// 更窄 + 界面缩放后仍不横滚、气泡有界。
await viewport(360, 900);
await compileQuiesce();
await settled(longLine);
await c.waitFor("!!document.querySelector('.formula-preview')", { timeout: 4000 });
check("更窄窗口后气泡仍有界且应用不横滚", await cardWithinViewport());
await c.key("=", { code: "Equal", keyCode: 187, modifiers: 10 });
await compileQuiesce();
await settled(longLine);
await c.waitFor("!!document.querySelector('.formula-preview')", { timeout: 4000 });
check("界面缩放后气泡仍有界且应用不横滚", await cardWithinViewport());
await c.screenshot(shotPath("document-expansion-long-line-zoom"));
await c.key("-", { code: "Minus", keyCode: 189, modifiers: 10 });
await sleep(150);
await c.key("Escape", { keyCode: 27 });
await settled(longLineBase);
await viewport(1400, 900);

// 高矩阵纵滚：纵向滚动条占位不裁剪窄公式内容宽度。
await viewport(520, 220);
const tallMatrix = f("tall-matrix"),
  tallMatrixBase = f("tall-matrix-base");
await replace(tallMatrixBase);
await compileQuiesce();
await cursor(tallMatrix.range.from + 2);
await settled(tallMatrix);
await caretMatches(tallMatrix, tallMatrix.range.from + 2, true);
await c.waitFor("!!document.querySelector('.formula-preview')", { timeout: 4000 });
check("高矩阵卡片连同箭头在两轴可见边界内", await cardWithinViewport());
const tallContent = await contentView();
check(
  "高矩阵纵滚时可见宽度为正且能放下完整窄公式 SVG",
  tallContent.clientWidth > 0 && tallContent.clientWidth >= tallContent.svgWidth - 0.5,
  JSON.stringify(tallContent),
);
check(
  "高矩阵纵滚时内容层确实纵向溢出（scrollHeight > clientHeight）",
  tallContent.scrollHeight > tallContent.clientHeight + 1,
  JSON.stringify(tallContent),
);
await c.screenshot(shotPath("document-expansion-tall-matrix-scroll"));
await c.key("Escape", { keyCode: 27 });
await settled(tallMatrixBase);
await viewport(1400, 900);

// 靠底公式：气泡翻到源码上方，向下箭头（::after）真实可见且不越出可见区。
const bottomFormula = f("bottom-formula"),
  bottomBase = f("bottom-formula-base");
await replace(bottomBase);
await viewport(1200, 320);
await settled(bottomBase);
await cursor(bottomFormula.range.from + 1);
await settled(bottomFormula);
await caretMatches(bottomFormula, bottomFormula.range.from + 1, true);
check(
  "靠底公式展开且气泡翻到源码上方",
  (await bubbleMatches(bottomFormula)) &&
    (await c.evaluate("!!document.querySelector('.formula-preview.flipped')")),
);
check("向下箭头真实可见且指向源码", await arrowVisible("down"));
check("翻转后卡片连同箭头仍落在预览可见区内", await cardWithinViewport());
await c.screenshot(shotPath("document-expansion-arrow-down"));
await c.key("Escape", { keyCode: 27 });
await settled(bottomBase);
await viewport(1400, 900);

check(
  "展开流程没有隐式写盘或脚本异常",
  await c.evaluate("!window.__browserDevWrites?.length&&!window.__browserDevErrors?.length"),
);
await c.close();
finish(`通过 ${state.passed} 项检查；光标主导展开 + 32 份真实 Typst 产物`);
