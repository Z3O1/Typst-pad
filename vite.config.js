import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
// node 内置模块无类型声明（项目未装 @types/node），checkJs 下逐行豁免
// @ts-ignore
import path from "node:path";
// @ts-ignore
import { readFileSync, writeFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * 构建期给 typst 的两个 wasm（30MB compiler + 1.2MB renderer）注入 <link rel="preload">
 * 到 index.html：浏览器解析 HTML 即开始下载 wasm，与 JS chunk 的下载/解析重叠，
 * 缩短「首编译就绪」关键路径。
 * 产物文件名带 hash，无法在 app.html 静态写死；且 SvelteKit 的 index.html 由
 * adapter（fallback 模式）在 closeBundle 阶段落盘，故本插件在 generateBundle 收集
 * wasm 文件名，closeBundle（注册顺序在 sveltekit 之后）读盘注入。
 * preload URL 与运行期 fetch() 的 URL 一致时走 HTTP 缓存，无重复下载；
 * 若注入失败（URL 不匹配）也只是浪费一次预取，不影响正常功能。
 */
function preloadTypstWasmPlugin() {
  /** @type {string[]} */
  const wasmAssets = [];
  return {
    name: "preload-typst-wasm",
    /**
     * @param {any} _options
     * @param {Record<string, any>} bundle
     */
    generateBundle(_options, bundle) {
      for (const key of Object.keys(bundle)) {
        if (/typst_ts_(web_compiler|renderer)_bg\.[A-Za-z0-9_-]+\.wasm$/.test(key)) {
          wasmAssets.push(key);
        }
      }
    },
    closeBundle() {
      if (wasmAssets.length === 0) return; // 开发模式 / 非客户端构建：无 wasm 资产
      const indexPath = path.resolve("build", "index.html");
      let html;
      try {
        html = readFileSync(indexPath, "utf8");
      } catch {
        return; // index.html 尚未落盘（其他构建形态），放弃注入
      }
      const links = wasmAssets.map(
        (n) => `<link rel="preload" href="/${n}" as="fetch" crossorigin="anonymous">`,
      );
      if (html.includes(links[0])) return; // 已注入过（如多次构建同进程）
      writeFileSync(
        indexPath,
        html.replace("</head>", `${links.join("\n")}\n</head>`),
        "utf8",
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  // vite-plugin-wasm / top-level-await: codemirror-lang-typst 与 typst.ts 依赖 wasm
  plugins: [sveltekit(), wasm(), topLevelAwait(), preloadTypstWasmPlugin()],
  build: {
    target: "esnext",
  },
  // 排除 typst wasm 包于依赖预构建，防止 Vite dev 将其打包进 .vite/deps 导致
  // "Cannot import wasm module without importer"（wasm 由 getModule 显式提供 URL）
  optimizeDeps: {
    exclude: [
      "@myriaddreamin/typst-ts-web-compiler",
      "@myriaddreamin/typst-ts-renderer",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
