// 验证 typst.ts 完整编译管道：setFonts 注册本地字体 + 编译 + SVG 渲染。
// 用法：node scripts/verify-typst.mjs
import { readFile } from "node:fs/promises";
import {
  createTypstCompiler,
  createTypstRenderer,
  createTypstFontBuilder,
} from "@myriaddreamin/typst.ts";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";

const source = `= Hello, Typst-pad

这是一段 *中文* 测试文本。

$ sum_(k=1)^n k = (n(n+1)) / 2 $
`;

console.log("初始化编译器（setFonts 本地字体）...");
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

console.log("编译...");
compiler.addSource("/main.typ", source);
const { result, diagnostics } = await compiler.compile({
  mainFilePath: "/main.typ",
  format: "vector",
  diagnostics: "full",
});
console.log("diagnostics:", diagnostics ? JSON.stringify(diagnostics) : "none");

if (!result) {
  console.error("编译失败：无产物");
  process.exit(1);
}
console.log("vector 产物字节数:", result.length);

console.log("渲染 SVG...");
const renderer = createTypstRenderer();
await renderer.init();
const svg = await renderer.renderSvg({
  format: "vector",
  artifactContent: result,
  data_selection: { body: true, defs: true, css: true, js: false },
});
console.log("SVG 长度:", svg.length);
if (svg.length < 100) {
  console.error("SVG 过短，可能渲染失败:", svg.slice(0, 200));
  process.exit(1);
}
// 断言：SVG 无未转义的裸 &（XML 解析要求，此前 js 层导致 73 处裸 &）
const badAmp = svg.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g);
console.log("未转义 & 数量:", badAmp ? badAmp.length : 0);
if (badAmp && badAmp.length > 0) {
  console.error("SVG 含未转义 &，无法通过 XML 解析");
  process.exit(1);
}
console.log("SVG 头部:", svg.slice(0, 120).replace(/\n/g, " "));
console.log("✓ 编译+渲染管道验证通过（中文+数学）");

console.log("导出 PDF...");
compiler.addSource("/main.typ", source);
const pdfResult = await compiler.compile({
  mainFilePath: "/main.typ",
  format: CompileFormatEnum.pdf,
  diagnostics: "full",
});
if (!pdfResult.result) {
  console.error("PDF 导出失败：", JSON.stringify(pdfResult.diagnostics ?? []));
  process.exit(1);
}
const pdfMagic = String.fromCharCode(...pdfResult.result.subarray(0, 5));
console.log(`PDF 字节数: ${pdfResult.result.length}，文件头: ${pdfMagic}`);
if (!pdfMagic.startsWith("%PDF")) {
  console.error("PDF 文件头无效");
  process.exit(1);
}
console.log("✓ PDF 导出验证通过");
