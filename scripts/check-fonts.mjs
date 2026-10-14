// 检查打包字体魔数；数学字体还须与内嵌 Typst 的官方资产逐字节对齐。
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { MATH_FONT_ASSETS } from "./math-font-assets.mjs";

const dir = "src-tauri/fonts";
const files = await readdir(dir);
let bad = 0;
for (const name of Object.keys(MATH_FONT_ASSETS.sha256)) {
  if (!files.includes(name)) {
    console.error(`✗ 缺数学字体 ${name}`);
    bad++;
  }
}
for (const f of files) {
  const buf = await readFile(`${dir}/${f}`);
  const magic = buf.subarray(0, 4).toString("latin1");
  const expected = MATH_FONT_ASSETS.sha256[f];
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const valid =
    (magic === "OTTO" ||
      magic === "\u0000\u0001\u0000\u0000" ||
      magic === "true" ||
      magic === "typ1") &&
    (!expected || sha256 === expected);
  console.log(
    `${valid ? "✓" : "✗"} ${f}  magic=${JSON.stringify(magic)}  size=${buf.length}${expected ? `  sha256=${sha256}` : ""}`,
  );
  if (!valid) bad++;
}
process.exit(bad ? 1 : 0);
