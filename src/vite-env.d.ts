/// <reference types="vite/client" />

// Vite `?url` 静态资源导入（wasm 文件 URL），用于 typst.ts 的 getModule
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
