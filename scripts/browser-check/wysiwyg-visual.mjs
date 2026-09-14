// 浏览器端的**真实排版**视觉验证：把 Rust 侧真实 typst 产物注入浏览器开发模式页面，
// 于是在真实 Chrome 里看到/量到的是真尺寸、真基线的公式（而不是桩的假 SVG）。
//
// 前置：
//   1) 导出真实产物夹具（Rust 侧，一次即可）：
//      cargo test --manifest-path src-tauri/Cargo.toml dump_math_fixtures -- --ignored --nocapture \
//        | grep '^FIXTURE:' | sed 's/^FIXTURE://' > .browser-check/math-fixtures.json
//      （或直接跑 npm run fixtures:math，见 package.json）
//   2) npm run dev -- --host 0.0.0.0 --port 1420
//   3) Windows headless Chrome 开 CDP（见 cdp.mjs 顶部注释）
// 运行：node scripts/browser-check/wysiwyg-visual.mjs
//
// 验的是「只能在浏览器/桌面端看出来」的那几件：
//   - 行内公式的**基线**是否与同行文字基线齐平（用零宽基线探针实测，不是看样式声明）
//   - pt → px 的尺寸映射是否符合预期（1pt = 4/3 px）
//   - 行间公式块级 widget 是否居中、是否占据整行
//   - 暗色主题下公式是否可见（typst 产物是黑字，需反色）
import { readFileSync } from "node:fs";
import { connect, DEV_URL } from "./cdp.mjs";

const SHOT = (name) => new URL(`../../.browser-check/${name}.png`, import.meta.url).pathname;
const FIXTURES = new URL("../../.browser-check/math-fixtures.json", import.meta.url).pathname;

let passed = 0;
function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    process.exitCode = 1;
  }
}

const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
console.log(`夹具：${fixtures.length} 条真实公式产物（来自 Rust compile_math）`);

const c = await connect();
await c.send("Page.enable");
// 必须在导航前注入：桩在 compile_math 里优先取这里的产品（见 browser-dev-stub.ts）
await c.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__DEV_MATH_FIXTURES = ${JSON.stringify(fixtures)};`,
});

await c.goto(DEV_URL);
// 清掉上一轮遗留的界面模式 / 主题，保证从默认态（写作模式）开始：
// 否则上一轮若停在源码模式，页面加载后不渲染任何公式，第一条断言就会莫名超时（实测踩过）
await c.evaluate(`localStorage.clear()`);
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 800));

console.log("1) 行内公式：真实 typst 产物 + 基线对齐");
// 文档：中文正文 + 行内公式（含下沉的积分、上标、分数），全部用夹具里的公式
const doc =
  "中文行内公式 $x^2 + y^2 = z^2$ 结束\n" +
  "带下沉的 $integral_0^1 f(x) dif x$ 与 $y_p + g_q$\n" +
  "分数 $frac(a,b)$ 与根号 $sqrt(x^2 + y^2)$\n";
await c.click(400, 300);
await c.type(doc);
await c.waitFor(`document.querySelectorAll(".cm-math-widget").length === 5`, { timeout: 15000 });

/**
 * 量基线：往公式所在行插入一个零宽 inline-block 探针（垂直对齐 baseline），
 * 探针底边就是该行文字基线；公式自身的基线 = 盒顶 + baselinePt（pt→px ×4/3）。
 */
const measured = await c.evaluate(`(() => {
  const PX_PER_PT = 96 / 72;
  const fixtures = window.__DEV_MATH_FIXTURES;
  const out = [];
  for (const w of document.querySelectorAll(".cm-math-widget")) {
    const svg = w.querySelector("svg");
    const line = w.closest(".cm-line");
    const box = w.getBoundingClientRect();
    const svgBox = svg.getBoundingClientRect();
    // 该公式对应哪条夹具（用 pt 宽度匹配：width 内联样式）
    const widthPt = parseFloat(w.style.width);
    const fixture = fixtures.find(f => Math.abs(f.widthPt - widthPt) < 0.01 && !f.display);
    // 基线探针
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    line.appendChild(probe);
    const baselineY = probe.getBoundingClientRect().bottom;
    probe.remove();
    out.push({
      body: fixture ? fixture.body : "(未知)",
      // 实际渲染尺寸
      renderedWidthPx: svgBox.width,
      expectedWidthPx: fixture ? fixture.widthPt * PX_PER_PT : null,
      renderedHeightPx: svgBox.height,
      expectedHeightPx: fixture ? fixture.heightPt * PX_PER_PT : null,
      // 基线：公式盒顶 + baselinePt 应等于该行文字基线
      formulaBaselineY: box.top + (fixture ? fixture.baselinePt * PX_PER_PT : 0),
      baselineY,
      delta: fixture ? Math.abs(box.top + fixture.baselinePt * PX_PER_PT - baselineY) : null,
      verticalAlign: getComputedStyle(w).verticalAlign,
    });
  }
  return out;
})()`);

check("5 个行内公式都渲染出来", measured.length === 5, JSON.stringify(measured.map((m) => m.body)));
check("每个公式都匹配到真实夹具（不是桩的假 SVG）", measured.every((m) => m.body !== "(未知)"), JSON.stringify(measured.map((m) => m.body)));

const sizeErrors = measured
  .filter((m) => m.expectedWidthPx !== null)
  .map((m) => ({
    body: m.body,
    dw: Math.abs(m.renderedWidthPx - m.expectedWidthPx),
    dh: Math.abs(m.renderedHeightPx - m.expectedHeightPx),
  }));
check(
  "渲染尺寸 = 真实 pt 尺寸 × 4/3（1pt = 4/3px），误差 < 0.6px",
  sizeErrors.every((e) => e.dw < 0.6 && e.dh < 0.6),
  JSON.stringify(sizeErrors),
);

const withFixture = measured.filter((m) => m.delta !== null);
check(
  "行内公式基线与同行文字基线齐平（误差 < 1px）",
  withFixture.every((m) => m.delta < 1),
  JSON.stringify(withFixture.map((m) => ({ body: m.body, delta: Math.round(m.delta * 100) / 100 }))),
);
// 有下沉部分的公式（积分）必须真的往下沉：vertical-align 为负、且盒底低于基线
const integral = measured.find((m) => m.body.startsWith("integral"));
check(
  "有下沉的公式按深度下移（vertical-align 为负值）",
  integral !== undefined && parseFloat(integral.verticalAlign) < 0,
  JSON.stringify(integral),
);
await c.screenshot(SHOT("visual-1-inline-math"));

console.log("2) 行间公式：块级 widget 居中 + 真尺寸");
await c.selectAll();
await c.type("前文\n\n$\n sum_(i=1)^n i\n$\n\n后文\n");
await c.waitFor(`document.querySelectorAll(".cm-math-block").length === 1`, { timeout: 15000 });
const block = await c.evaluate(`(() => {
  const PX_PER_PT = 96 / 72;
  const b = document.querySelector(".cm-math-block");
  const box = b.querySelector(".cm-math-block-box");
  const svg = b.querySelector("svg");
  const r = svg.getBoundingClientRect();
  const host = document.querySelector(".cm-content").getBoundingClientRect();
  const fixtures = window.__DEV_MATH_FIXTURES;
  const f = fixtures.find(x => x.display && Math.abs(x.widthPt * PX_PER_PT - r.width) < 0.6);
  return {
    body: f ? f.body : "(未知)",
    widthPx: r.width, heightPx: r.height,
    expectedHeightPx: f ? f.heightPt * PX_PER_PT : null,
    leftGap: Math.round(r.left - host.left),
    rightGap: Math.round(host.right - r.right),
    // 块级公式是"独立成行"：其所在行不应再包含其它文字
    lineText: b.closest(".cm-line")?.innerText.trim() ?? "",
  };
})()`);
check("行间公式用真实夹具渲染", block.body !== "(未知)", JSON.stringify(block.body));
check(
  "块级公式高度 = 真实 pt 高度 × 4/3",
  Math.abs(block.heightPx - block.expectedHeightPx) < 0.6,
  JSON.stringify(block),
);
check(
  "块级公式居中（左右留白接近）",
  Math.abs(block.leftGap - block.rightGap) < 40,
  JSON.stringify({ l: block.leftGap, r: block.rightGap }),
);
check("块级公式独占整行", block.lineText === "", JSON.stringify(block.lineText));
await c.screenshot(SHOT("visual-2-block-math"));

console.log("3) 暗色主题：公式可见（反色）");
await c.send("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-color-scheme", value: "dark" }],
});
// 触发主题重算：应用监听 prefers-color-scheme 变化（仅"自动"态跟随）
await c.goto(DEV_URL);
await c.waitFor(`!!document.querySelector(".cm-content")`, { timeout: 30000 });
await c.click(400, 300);
await c.type("暗色下的公式 $x^2 + y^2 = z^2$ 与块级\n\n$ frac(a,b) $\n");
await c.waitFor(`document.querySelectorAll(".cm-math-widget").length === 1`, { timeout: 15000 });
const dark = await c.evaluate(`(() => {
  const el = document.querySelector(".cm-math-widget, .cm-math-block");
  const svg = el.querySelector("svg");
  const text = svg.querySelector("text, path, g");
  return {
    isDarkApp: document.querySelector(".app")?.classList.contains("light") === false,
    hasDarkClass: el.className.includes("cm-math-dark"),
    filter: getComputedStyle(svg).filter,
    // 深色背景挂在 .cm-editor/.cm-scroller 上（.cm-content 是透明的）
    bg: ["#preview-host", ".cm-editor", ".cm-scroller", ".cm-gutters"]
      .map((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      })
      .filter((v) => v && v !== "rgba(0, 0, 0, 0)"),
  };
})()`);
check("暗色主题下 widget 带反色类", dark.hasDarkClass, JSON.stringify(dark));
check("SVG 应用了 invert 滤镜（黑字在深底上可见）", dark.filter.includes("invert"), JSON.stringify(dark));
check(
  "编辑器背景确实是深色（亮度低于 0x60）",
  dark.bg.length > 0 &&
    dark.bg.every((v) => {
      const [r, g, b] = v.match(/\d+/g).map(Number);
      return (r + g + b) / 3 < 0x60;
    }),
  JSON.stringify(dark.bg),
);
await c.screenshot(SHOT("visual-3-dark-math"));
await c.send("Emulation.setEmulatedMedia", { features: [] });

console.log("4) 真实产物的墨迹必须整个落在 SVG 视口内（a_0 曾经被裁掉下半截）");
// typst 允许把上下标画到**帧外**（实测 `$a_0$`：帧高 8.196pt、基线就在帧底、下标基线 11.16pt），
// 而公式页是贴边页 —— 导出 SVG 后**视口就是裁剪框**，帧外的墨迹全被裁掉。修法在 Rust 侧按墨迹
// 撑画布（见 ink_bounds_of_frame）。这里把**每条真实产物**都塞进页面量 getBBox()（真实墨迹，
// 用户单位）与 viewBox —— 不依赖编辑器状态，等于对整批产物做一次几何体检。
const inkAudit = await c.evaluate(`(() => {
  const fixtures = window.__DEV_MATH_FIXTURES || [];
  const out = [];
  for (const f of fixtures) {
    const host = document.createElement("div");
    host.style.cssText = "position: fixed; left: -9999px; top: 0";
    host.innerHTML = f.svg;
    document.body.appendChild(host);
    const svg = host.querySelector("svg");
    if (svg) {
      const b = svg.getBBox();
      const vb = svg.viewBox.baseVal;
      out.push({
        body: f.body,
        sizePt: f.sizePt,
        overBottom: +(b.y + b.height - (vb.y + vb.height)).toFixed(3),
        overTop: +(vb.y - b.y).toFixed(3),
        overRight: +(b.x + b.width - (vb.x + vb.width)).toFixed(3),
        vbH: +vb.height.toFixed(2),
      });
    }
    host.remove();
  }
  return out;
})()`);
const clippedBottom = inkAudit.filter((m) => m.overBottom > 0.2);
const clippedTop = inkAudit.filter((m) => m.overTop > 0.2);
check(
  `全部 ${inkAudit.length} 条产物：墨迹底边没有超出画布（无下裁）`,
  inkAudit.length >= 20 && clippedBottom.length === 0,
  JSON.stringify(clippedBottom.slice(0, 4)),
);
check(
  `全部 ${inkAudit.length} 条产物：墨迹顶边没有超出画布（无上裁）`,
  inkAudit.length >= 20 && clippedTop.length === 0,
  JSON.stringify(clippedTop.slice(0, 4)),
);
// 下标用例必须真的"有下沉空间"：画布要明显高过基线（否则说明产物退化了）
const sub = inkAudit.filter((m) => m.body === "a_0");
// 下标基线实测 ≈0.93em（12pt 字号下 11.16pt）：画布必须高过它，下标才有落脚处
check(
  "下标公式的画布高过下标基线（≈0.93em）",
  sub.length === 2 && sub.every((m) => m.vbH / (m.sizePt ?? 12) >= 0.93),
  JSON.stringify(sub),
);
await c.screenshot(SHOT("visual-4-ink-audit"));

console.log(`\n通过 ${passed} 项检查；截图：${SHOT("visual-*")}`);
c.close();
