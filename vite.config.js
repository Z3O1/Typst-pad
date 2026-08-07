import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // 注意：编译管线 wasm（@myriaddreamin/typst.ts 三包）已随 T2 前端迁移移除，
  // 这两个插件现在仅为 codemirror-lang-typst 的语法高亮服务——其 typst() 扩展是
  // wasm-bindgen bundler 产物，内部 `import * as wasm from ".../typst_syntax_bg.wasm"`
  // 必须由 vite-plugin-wasm 处理（实测：删掉插件后 build 报
  // "ESM integration proposal for Wasm is not supported"，勿误删）。
  plugins: [sveltekit(), wasm(), topLevelAwait()],
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
