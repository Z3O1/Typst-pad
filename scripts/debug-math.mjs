// 二分定位数学字体问题。
// 用法：node scripts/debug-math.mjs
import { readFile } from "node:fs/promises";
import { createTypstCompiler, loadFonts } from "@myriaddreamin/typst.ts";

const fontFiles = [
  "src-tauri/fonts/NewCMMath-Regular.otf",
  "src-tauri/fonts/NewCMMath-Bold.otf",
  "src-tauri/fonts/NewCMMath-Book.otf",
  "src-tauri/fonts/LibertinusSerif-Regular.otf",
  "src-tauri/fonts/LibertinusSerif-Bold.otf",
  "src-tauri/fonts/NotoSerifCJKsc-Regular.otf",
];
const fontBytes = (await Promise.all(fontFiles.map((f) => readFile(f)))).map(
  (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
);

async function tryCompile(label, fonts) {
  const compiler = createTypstCompiler();
  try {
    if (fonts) {
      await compiler.init({ fonts });
    } else {
      await compiler.init(); // 默认 assets: ['text']（CDN，含 NewCMMath）
    }
  } catch (e) {
    console.log(`[${label}] init 失败:`, e.message);
    return;
  }
  compiler.addSource("/main.typ", `$ x^2 + y^2 = z^2 $`);
  const { result, diagnostics } = await compiler.compile({
    mainFilePath: "/main.typ",
    format: "vector",
    diagnostics: "full",
  });
  console.log(
    `[${label}] result=${result ? result.length + "B" : "无"} diagnostics=${JSON.stringify(diagnostics ?? [])}`,
  );
}

await tryCompile("默认init(CDN text assets)");
await tryCompile("本地7字体(含默认CDN assets)", loadFonts(fontBytes));
await tryCompile("本地7字体+禁用默认assets", loadFonts(fontBytes, { assets: false }));
await tryCompile("仅NewCMMath三件套+禁用默认", loadFonts(fontBytes.slice(0, 3), { assets: false }));
