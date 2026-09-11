// 用 TypstFontBuilder 检查字体文件能否被解析（family 名等）。
// 用法：node scripts/debug-fontinfo.mjs
import { readFile } from "node:fs/promises";
import { createTypstFontBuilder } from "@myriaddreamin/typst.ts";

const files = [
  "src-tauri/fonts/NewCMMath-Regular.otf",
  "src-tauri/fonts/NewCMMath-Book.otf",
  "src-tauri/fonts/LibertinusSerif-Regular.otf",
  "src-tauri/fonts/NotoSerifCJKsc-Regular.otf",
];

const builder = createTypstFontBuilder();
await builder.init();

for (const f of files) {
  const buf = await readFile(f);
  try {
    const info = await builder.getFontInfo(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    console.log(`${f}:`, JSON.stringify(info));
  } catch (e) {
    console.log(`${f}: 解析失败 - ${e.message}`);
  }
}
