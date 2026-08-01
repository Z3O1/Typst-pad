# Typst-pad

[![CI](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml/badge.svg)](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml)

Typora 式布局的 Typst 桌面编辑器：**左侧编辑 Typst 源码，右侧实时预览**（非所见即所得）。

## 功能

- 左侧 CodeMirror 6 编辑器：Typst 语法高亮、行号、括号匹配、光标行列状态栏
- 右侧 typst.ts (WASM) 实时编译预览：内容变化后立即编译并显示，编译错误带行号显示
- 中文/数学公式完整支持（本地打包字体，离线可用）
- 打开 / 保存 `.typ` 文件（Tauri 桌面环境）；**Ctrl/Cmd + S** 快速保存
- 导出 PDF
- 主题三态：自动（跟随系统）/ 暗 / 明

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | SvelteKit + TypeScript + Vite |
| 编辑器 | CodeMirror 6 + `codemirror-lang-typst` |
| 编译渲染 | `@myriaddreamin/typst.ts` 0.8.0-rc3（WASM，本地字体） |

## 快速开始

前置：Node.js 20+；`npm run tauri dev` 需要 Rust（rustup）。

```bash
npm install          # 安装依赖
npm run dev          # 仅前端（浏览器，无文件功能）
npm run tauri dev    # 桌面应用（需要 Rust）
npm run check        # 类型检查（svelte-check）
npm test             # 单元测试（vitest）
npm run build        # 前端生产构建
npm run tauri build  # 打包桌面安装程序（需要 Rust）
```

## 测试与 CI

- 单元测试（vitest + jsdom）：`npm test`，覆盖 SVG 净化（`src/lib/svg-sanitize.test.ts`）与编译互斥队列（`src/lib/enqueue.test.ts`）
- CI（GitHub Actions，`.github/workflows/ci.yml`）：每个 PR 在 ubuntu 上跑 类型检查 → 单测 → 前端构建 → `cargo check`

## 发布（Release）

自动构建与发布由 `.github/workflows/release.yml` 完成（windows 打包 .exe/.msi → 创建草稿 Release）。

**推荐发版方式（缓存可命中）**：

1. 修改版本号：`package.json` 与 `src-tauri/tauri.conf.json` 的 `version`（两处一致；**不要**改 `src-tauri/Cargo.toml` 的 version——它是 Rust crate 版本，保持稳定以维持 CI 缓存）
2. 提交推送（合并到 `main`）
3. GitHub → **Actions → Release → Run workflow**（Branch 保持 `main`）→ 构建（命中 Rust 缓存，约 2-4 分钟）→ tauri-action 自动打 tag、生成草稿 Release
4. Releases 页面编辑草稿 → 发布

**备选（tag 触发）**：`git tag v0.2.x && git push origin v0.2.x` 同样触发构建，但注意 **GitHub Actions 缓存按分支/tag 隔离**——tag 触发的每次构建都查不到上次的缓存（scope 是各自 tag 名），会全量编译约 14 分钟。因此**优先使用手动 dispatch（main）发版**，缓存稳定跨版本命中。

> 缓存机制：`Swatinem/rust-cache` 的 key 基于 rust 版本 + `Cargo.lock` 哈希。依赖不变（Cargo.lock 不变）时跨版本命中；因此发版只改应用版本号、不动 `Cargo.toml`/依赖。

## 架构

```
src/
├── routes/+page.svelte     # 主界面：工具栏 / 双栏 / 状态栏，防抖编译调度
├── lib/Editor.svelte       # CodeMirror 6 封装（Typst 语法、主题、外部 doc 同步）
├── lib/typst-engine.ts     # 编译引擎：WASM 编译器 + 本地字体 + SVG/PDF 输出
└── lib/file-ops.ts         # 打开/保存文件（Tauri dialog + invoke）
src-tauri/
└── src/lib.rs              # Rust 壳：read_file / write_file 命令 + dialog 插件
```

### 字体

预览渲染所需字体打包在 `static/fonts/`（约 5.7MB，离线可用，无需 CDN）：

- `NotoSerifCJKsc-Regular.otf` — 中文（思源宋体）
- `NewCMMath-{Regular,Bold,Book}.otf` — 数学（New Computer Modern Math）
- `LibertinusSerif-{Regular,Bold}.otf` — 正文衬线
- `DejaVuSansMono.ttf` — 等宽

> 注：编译引擎使用 `createTypstFontBuilder().addFontData()` + `compiler.setFonts()` 注册字体。
> 不要用 `loadFonts(字节数组)`：0.8.0-rc3 下数学字体不会生效（已实测排查）。

## 验证脚本

```bash
node scripts/verify-typst.mjs   # 完整管道验证：中文+数学文档 → vector 产物 → SVG
node scripts/check-fonts.mjs    # 校验 static/fonts 字体文件有效性
node scripts/download-fonts.mjs # 重新下载字体（jsDelivr，含重试）
```

## 已知限制

- 单文件编辑，无文件树 / 多标签页
- 预览不跟随滚动（非所见即所得）
- `@myriaddreamin/typst.ts` 目前锁定 0.8.0-rc3（0.7.0 存在数学字体加载缺陷）
- `tauri.conf.json` 的 `csp` 保持 `null`：设置生产 CSP 需在打包后实机验证（wasm/blob/tauri 协议交互易误伤），当前以 `sanitizeSvg` 净化 + 文件命令路径约束作为纵深防线；如需启用请在 `npm run tauri build` 后实测

## License

[MIT](./LICENSE) © 2026 Z3O1
