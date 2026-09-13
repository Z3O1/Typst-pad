import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // src 下是前端单测（TS）；scripts 下是发布/构建脚本的测试（.mjs 与脚本同目录）。
    // 脚本是普通 JS 且只用 node 内置模块，不进 svelte-check 的类型检查范围
    // （仓库没有装 @types/node，见 vite.config.js 的处理），所以这里的 include 放宽到 .mjs。
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
});
