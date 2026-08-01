// 浏览器级验证：jsdom 的 DOMParser 解析 typst.ts 渲染的 SVG 并跑 sanitizeSvg 全流程。
// 用法：node scripts/verify-sanitize.mjs
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const dom = new JSDOM("", { url: "http://localhost/" });
const { DOMParser, XMLSerializer, NodeFilter, Element } = dom.window;

// —— 复制 src/lib/typst-engine.ts 的 parseSvgStrict + sanitizeSvg（验证用） ——
function parseSvgStrict(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (!doc.querySelector("parsererror")) return doc;
  const fixed = svg.replace(
    /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g,
    "&amp;",
  );
  const doc2 = new DOMParser().parseFromString(fixed, "image/svg+xml");
  if (doc2.querySelector("parsererror")) {
    throw new Error("SVG 解析失败，已阻止注入");
  }
  return doc2;
}

const URL_ATTRS = ["href", "xlink:href", "src"];
const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)([;,])/;

function isSafeUrl(value) {
  const v = value.replace(/\s+/g, "").toLowerCase();
  if (ALLOWED_DATA_IMAGE.test(v)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/.test(v)) return true;
  return ALLOWED_LINK_PROTOCOLS.some((p) => v.startsWith(p));
}

function sanitizeSvg(svg) {
  const doc = parseSvgStrict(svg);
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT);
  const toRemove = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name) && !isSafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "foreignobject") {
      toRemove.push(el);
    }
  }
  for (const el of toRemove) el.remove();
  return new XMLSerializer().serializeToString(doc);
}

// —— 验证 ——
const svg = await readFile("scripts/svg-debug.svg", "utf8");
console.log("SVG 长度:", svg.length);

// 1. 直接解析（js:false 后应成功）
try {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.querySelector("parsererror")) {
    console.error("✗ 直接解析失败（修复前行为）");
    process.exit(1);
  }
  console.log("✓ DOMParser 直接解析成功");
} catch (e) {
  console.error("✗ DOMParser 异常:", e.message);
  process.exit(1);
}

// 2. sanitizeSvg 全流程
try {
  const clean = sanitizeSvg(svg);
  if (!clean.includes("onclick") && clean.includes("<svg")) {
    console.log("✓ sanitizeSvg 全流程通过，输出长度:", clean.length);
  } else {
    console.error("✗ sanitizeSvg 输出异常");
    process.exit(1);
  }
} catch (e) {
  console.error("✗ sanitizeSvg 失败:", e.message);
  process.exit(1);
}

// 3. 容错路径：含裸 & 的 SVG 应被 parseSvgStrict 修复，合法 &amp; 保留
const mixedSvg = `<svg xmlns="http://www.w3.org/2000/svg"><text>A &amp; B & C</text><path d="M0 0 L5 5"/></svg>`;
try {
  const doc = parseSvgStrict(mixedSvg);
  const fixed = new XMLSerializer().serializeToString(doc);
  // 语义不变：A & B & C（裸 & 被修复，合法实体保留）
  if (!fixed.includes("A &amp; B &amp; C")) {
    console.error("✗ parseSvgStrict 语义错误:", fixed);
    process.exit(1);
  }
  console.log("✓ parseSvgStrict 容错（裸 & 修复 + 合法实体保留）通过");
} catch (e) {
  console.error("✗ parseSvgStrict 容错失败:", e.message);
  process.exit(1);
}

// 4. 恶意属性应被清除
const evilSvg = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)" onclick="x()"><image src="data:text/html,x"/></a><script>alert(1)</script><foreignObject>t</foreignObject></svg>`;
const cleanEvil = sanitizeSvg(evilSvg);
const checks = {
  "javascript: href 被移除": !cleanEvil.includes("javascript:"),
  "onclick 被移除": !cleanEvil.includes("onclick"),
  "data:text/html 被移除": !cleanEvil.includes("data:text/html"),
  "script 被移除": !cleanEvil.includes("<script"),
  "foreignObject 被移除": !cleanEvil.toLowerCase().includes("foreignobject"),
};
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "✓" : "✗"} ${k}`);
  if (!v) ok = false;
}
if (!ok) {
  const idx = cleanEvil.toLowerCase().indexOf("foreignobject");
  console.log("cleanEvil 中 foreignobject 位置:", idx, "上下文:", JSON.stringify(cleanEvil.slice(Math.max(0, idx - 80), idx + 80)));
  // 调试：jsdom 解析后的元素名
  const d = new DOMParser().parseFromString(evilSvg, "image/svg+xml");
  for (const el of d.documentElement.querySelectorAll("*")) {
    console.log("元素:", el.tagName, "| nodeName:", el.nodeName, "| localName:", el.localName);
  }
  process.exit(1);
}
console.log("✓ 恶意 SVG 净化全部通过");
