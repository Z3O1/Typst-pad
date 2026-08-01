// 调试：typst.ts renderSvg 输出为何无法被 DOMParser("image/svg+xml") 解析
// 用法：node scripts/debug-svg.mjs
import { readFile, writeFile } from "node:fs/promises";
import {
  createTypstCompiler,
  createTypstRenderer,
  createTypstFontBuilder,
} from "@myriaddreamin/typst.ts";

const source = `= Hello, Tpyst-pad

这是一段 *中文* 测试文本。

$ sum_(k=1)^n k = (n(n+1)) / 2 $
`;

console.log("typeof DOMParser in Node:", typeof DOMParser);

const fontFiles = [
  "static/fonts/NotoSerifCJKsc-Regular.otf",
  "static/fonts/NewCMMath-Regular.otf",
  "static/fonts/NewCMMath-Bold.otf",
  "static/fonts/NewCMMath-Book.otf",
  "static/fonts/LibertinusSerif-Regular.otf",
  "static/fonts/LibertinusSerif-Bold.otf",
  "static/fonts/DejaVuSansMono.ttf",
];

const compiler = createTypstCompiler();
await compiler.init();
const builder = createTypstFontBuilder();
await builder.init();
for (const f of fontFiles) {
  const buf = await readFile(f);
  await builder.addFontData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
}
await builder.build(async (fonts) => compiler.setFonts(fonts));

compiler.addSource("/main.typ", source);
const { result, diagnostics } = await compiler.compile({
  mainFilePath: "/main.typ",
  format: "vector",
  diagnostics: "full",
});
if (!result) {
  console.log("编译失败:", JSON.stringify(diagnostics ?? []));
  process.exit(1);
}

const renderer = createTypstRenderer();
await renderer.init();
const svg = await renderer.renderSvg({
  format: "vector",
  artifactContent: result,
  data_selection: { body: true, defs: true, css: true, js: false },
});
console.log("SVG 长度:", svg.length);
await writeFile("scripts/svg-debug.svg", svg);

console.log("--- 前 300 字符 ---");
console.log(JSON.stringify(svg.slice(0, 300)));
console.log("--- 控制字符检查 ---");
const ctrl = svg.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g);
console.log("控制字符数量:", ctrl ? ctrl.length : 0, ctrl ? [...new Set(ctrl)].map((c) => c.charCodeAt(0)) : []);
console.log("--- style 区域数量 ---");
console.log("(<style...>):", (svg.match(/<style/g) ?? []).length, " </style>:", (svg.match(/<\/style>/g) ?? []).length);
console.log("--- 未转义 & 检查（& 后非实体） ---");
const badAmp = svg.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g);
console.log("可疑 & 数量:", badAmp ? badAmp.length : 0);
if (badAmp) {
  const idx = svg.indexOf(badAmp[0]);
  console.log("首个可疑 & 位置:", idx, "上下文:", JSON.stringify(svg.slice(Math.max(0, idx - 60), idx + 60)));
}
console.log("--- 含 < 的文本节点粗查（< 后非标签名/!/?） ---");
const badLt = svg.match(/<(?![a-zA-Z/!?])/g);
console.log("可疑 < 数量:", badLt ? badLt.length : 0);
console.log("--- XML 声明/DOCTYPE ---");
console.log("以 <?xml 开头:", svg.trimStart().startsWith("<?xml"));
console.log("含 DOCTYPE:", svg.includes("<!DOCTYPE"));

if (typeof DOMParser !== "undefined") {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const err = doc.querySelector("parsererror");
    console.log("DOMParser 解析:", err ? "失败 - " + err.textContent?.slice(0, 300) : "成功");
  } catch (e) {
    console.log("DOMParser 异常:", e.message);
  }
} else {
  console.log("Node 无 DOMParser，需在浏览器环境验证");
}
