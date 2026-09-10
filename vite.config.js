import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
// @ts-expect-error 仓库未装 @types/node（与下方 process 的既有处理一致）
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// WebKitGTK 的模块求值有个坑：模块图里存在顶层 await（vite-plugin-wasm 为
// codemirror-lang-typst 生成的 wasm 胶水模块是 `const x = await initWasm(...)`），
// SvelteKit 启动时 `get_navigation_result_from_branch` 会在求值完成前访问活绑定
// （TDZ："Cannot access 'component' before initialization"），boot 整体拒绝 → 白屏。
// Chromium 求值顺序不同无此问题（Windows 生产端 WebView2 正常）。因此把 wasm 初始化
// 改成同步路径：wasm 内嵌为 data:URL 后同步实例化（WebKit 与 Chromium 均已验证可行），
// 胶水模块不再有顶层 await，两种引擎都能正常启动（仅 dev，构建产物不受影响）。
/** @type {import("vite").Plugin} */
const syncWasmInit = {
  name: "typst-pad:sync-wasm-init",
  enforce: "post",
  apply: "serve", // 只作用于 dev：生产构建（WebView2/Chromium）走原路径即可，不动产物
  transform(code, id) {
    // 同步 helper：替换 vite-plugin-wasm 的异步初始化函数（data:URL → atob → 同步实例化）
    if (code.includes("url.startsWith(\"data:\")") && code.includes("export default async")) {
      return [
        "export default function initWasm(imports, url) {",
        "  if (!url.startsWith('data:')) {",
        "    throw new Error('sync wasm init: data: URL 仅由 typst-pad:sync-wasm-init 内联产生');",
        "  }",
        "  const bin = atob(url.replace(/^data:.*?base64,/, ''));",
        "  const bytes = new Uint8Array(bin.length);",
        "  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);",
        "  const mod = new WebAssembly.Module(bytes, imports);",
        "  return new WebAssembly.Instance(mod, imports).exports;",
        "}",
      ].join("\n");
    }
    // 胶水模块（id 可能带 ?import 之类的查询，按内容匹配）：
    // 1) 把 `import __vite__wasmUrl from "...wasm?..."` 内联为 data:URL；
    // 2) 去掉顶层 await（同步 helper 直接返回实例）。
    if (code.includes("__vite__wasmModule = await __vite__initWasm")) {
      code = code.replace(
        /import __vite__wasmUrl from\s*"([^"]*\.wasm)[^"]*"/,
        /**
         * @param {string} _match
         * @param {string} spec
         */
        (_match, spec) => {
        let filePath = spec.replace(/^\/@fs\//, "");
        if (!filePath.startsWith("/")) filePath = id.replace(/[^/]*$/, "") + filePath;
        // vite 的路径是相对 server root 的（如 /node_modules/...），补上项目根才可读
        // @ts-expect-error process is a nodejs global
        if (filePath.startsWith("/node_modules")) filePath = process.cwd() + filePath;
        const buf = readFileSync(filePath);
        return `const __vite__wasmUrl = "data:application/wasm;base64,${buf.toString("base64")}";`;
      });
      code = code.replace(
        "const __vite__wasmModule = await __vite__initWasm(",
        "const __vite__wasmModule = __vite__initWasm("
      );
      return code;
    }
    return null;
  },
};

// https://vite.dev/config/
export default defineConfig(async () => ({
  // 注意：编译管线 wasm（@myriaddreamin/typst.ts 三包）已随 T2 前端迁移移除，
  // 这两个插件现在仅为 codemirror-lang-typst 的语法高亮服务——其 typst() 扩展是
  // wasm-bindgen bundler 产物，内部 `import * as wasm from ".../typst_syntax_bg.wasm"`
  // 必须由 vite-plugin-wasm 处理（实测：删掉插件后 build 报
  // "ESM integration proposal for Wasm is not supported"，勿误删）。
  // syncWasmInit（见上）把 wasm 胶水从顶层 await 改为同步实例化，两台引擎都能启动。
  plugins: [sveltekit(), wasm(), topLevelAwait(), syncWasmInit],
  optimizeDeps: {
    // 不预构建 codemirror-lang-typst：dev 下走源码 + transform 管线，
    // 让 syncWasmInit 能在被 serving 前改写 wasm 胶水模块（预构建阶段只调 load 不调 transform）。
    exclude: ["codemirror-lang-typst"],
  },
  build: {
    target: "esnext",
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
