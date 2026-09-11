// 对比三种字体加载方式对数学公式的影响。
// 用法：node scripts/debug-math3.mjs
import { readFile } from "node:fs/promises";
import {
  createTypstCompiler,
  createTypstFontBuilder,
  loadFonts,
} from "@myriaddreamin/typst.ts";

const MATH_DOC = `$ x^2 + y^2 = z^2 $`;

async function tryCompile(label, fonts) {
  const compiler = createTypstCompiler();
  try {
    if (typeof fonts === "function") {
      await compiler.init(); // 默认 assets（CDN text）
      await fonts(compiler);
    } else {
      await compiler.init({ fonts });
    }
  } catch (e) {
    console.log(`[${label}] init 失败:`, e.message);
    return;
  }
  compiler.addSource("/main.typ", MATH_DOC);
  const { result, diagnostics } = await compiler.compile({
    mainFilePath: "/main.typ",
    format: "vector",
    diagnostics: "full",
  });
  console.log(
    `[${label}] result=${result ? result.length + "B" : "无"} diag=${JSON.stringify(diagnostics ?? [])}`,
  );
}

// 方案 A：默认 init（CDN text assets，含 NewCMMath）
await tryCompile("A.默认CDN text assets", null);

// 方案 B：本地字节 loadFonts + assets:false
const fontFiles = [
  "src-tauri/fonts/NewCMMath-Regular.otf",
  "src-tauri/fonts/LibertinusSerif-Regular.otf",
];
const fontBytes = (await Promise.all(fontFiles.map((f) => readFile(f)))).map(
  (b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
);
await tryCompile("B.本地字节 assets:false", loadFonts(fontBytes, { assets: false }));

// 方案 C：setFonts（底层 API）
await tryCompile("C.setFonts(fontBuilder)", async (compiler) => {
  const builder = createTypstFontBuilder();
  await builder.init();
  for (const b of fontBytes) await builder.addFontData(b);
  await builder.build(async (fonts) => compiler.setFonts(fonts));
});
