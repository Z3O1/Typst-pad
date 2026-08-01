import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // vite-plugin-wasm / top-level-await: codemirror-lang-typst 与 typst.ts 依赖 wasm
  plugins: [sveltekit(), wasm(), topLevelAwait()],
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
