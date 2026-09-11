// 下载 Typst 渲染所需字体到 src-tauri/fonts/（带重试）。
// 用法：node scripts/download-fonts.mjs
import { writeFile, mkdir } from "node:fs/promises";

const ASSETS = "https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/";
const DEV_ASSETS = "https://cdn.jsdelivr.net/gh/typst/typst-dev-assets@v0.13.1/files/fonts/";

const FONTS = [
  [ASSETS, "NewCMMath-Bold.otf"],
  [ASSETS, "NewCMMath-Book.otf"],
  [ASSETS, "NewCMMath-Regular.otf"],
  [ASSETS, "LibertinusSerif-Regular.otf"],
  [ASSETS, "LibertinusSerif-Bold.otf"],
  [ASSETS, "DejaVuSansMono.ttf"],
  [DEV_ASSETS, "NotoSerifCJKsc-Regular.otf"],
];

await mkdir("src-tauri/fonts", { recursive: true });

let ok = 0;
for (const [prefix, name] of FONTS) {
  const url = prefix + name;
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(`src-tauri/fonts/${name}`, buf);
      console.log(`✓ ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
      ok++;
      break;
    } catch (e) {
      lastErr = e.message;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      if (attempt === 4) console.error(`✗ ${name}: ${lastErr}`);
    }
  }
}
console.log(`完成：${ok}/${FONTS.length}`);
process.exit(ok === FONTS.length ? 0 : 1);
