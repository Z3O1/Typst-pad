// 检查 static/fonts 下所有字体文件的魔数是否有效
import { readFile, readdir } from "node:fs/promises";

const dir = "static/fonts";
const files = await readdir(dir);
let bad = 0;
for (const f of files) {
  const buf = await readFile(`${dir}/${f}`);
  const magic = buf.subarray(0, 4).toString("latin1");
  const valid = magic === "OTTO" || magic === "\u0000\u0001\u0000\u0000" || magic === "true" || magic === "typ1";
  console.log(`${valid ? "✓" : "✗"} ${f}  magic=${JSON.stringify(magic)}  size=${buf.length}`);
  if (!valid) bad++;
}
process.exit(bad ? 1 : 0);
