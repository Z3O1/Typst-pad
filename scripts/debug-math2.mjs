// 进一步定位：字体是否真的注册成功。
// 用法：node scripts/debug-math2.mjs
import { readFile } from "node:fs/promises";
import { createTypstCompiler, loadFonts } from "@myriaddreamin/typst.ts";

const fontFiles = [
  "src-tauri/fonts/NewCMMath-Regular.otf",
  "src-tauri/fonts/LibertinusSerif-Regular.otf",
  "src-tauri/fonts/NotoSerifCJKsc-Regular.otf",
];
const fontBytes = (await Promise.all(fontFiles.map((f) => readFile(f)))).map(
  (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
);

async function tryCompile(label, source) {
  const compiler = createTypstCompiler();
  await compiler.init({ fonts: loadFonts(fontBytes, { assets: false }) });
  compiler.addSource("/main.typ", source);
  const { result, diagnostics } = await compiler.compile({
    mainFilePath: "/main.typ",
    format: "vector",
    diagnostics: "full",
  });
  console.log(
    `[${label}] result=${result ? result.length + "B" : "无"} diag=${JSON.stringify(diagnostics ?? [])}`,
  );
}

await tryCompile("显式 text font=NewCM", `#set text(font: "New Computer Modern Math")\nHello 中文`);
await tryCompile("显式 text font=Libertinus", `#set text(font: "Libertinus Serif")\nHello 中文`);
await tryCompile("text.font=NewCM + 数学", `#set text(font: "New Computer Modern Math")\n$x^2$`);
await tryCompile("默认 + fallback:true + 数学", `#set text(fallback: true)\n$x^2$`);
await tryCompile("默认 + 数学", `$ x^2 $`);
