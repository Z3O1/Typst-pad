# Typst-pad

[![CI](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml/badge.svg)](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml)

Typora 式布局的 Typst 桌面编辑器：**左侧编辑 Typst 源码，右侧实时预览**（非所见即所得）。

## 功能

- 左侧 CodeMirror 6 编辑器：Typst 语法高亮、行号、括号匹配、光标行列状态栏
- 右侧实时编译预览：内容变化后立即编译并显示（typst crate 内嵌原生编译），编译错误带行号/波浪线显示
- 中文/数学公式完整支持（本地打包字体，离线可用）
- 打开 / 保存 `.typ` 文件（Tauri 桌面环境）；**Ctrl/Cmd + S** 快速保存
- 导出 PDF（原生"另存为"对话框）
- 主题三态：自动（跟随系统）/ 暗 / 明

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2（Rust） |
| 前端 | SvelteKit + TypeScript + Vite |
| 编辑器 | CodeMirror 6 + `codemirror-lang-typst` |
| 编译渲染 | typst crate 0.15.x 内嵌（Rust 进程内编译，本地字体） |

## 快速开始

前置：Node.js 20+；`npm run tauri dev` 需要 Rust（rustup）。

```bash
npm install          # 安装依赖
npm run dev          # 仅前端 UI（无预览/文件功能；非 Tauri 环境显示"请使用桌面应用版本"提示页）
npm run tauri dev    # 桌面应用（需要 Rust）
npm run check        # 类型检查（svelte-check）
npm test             # 前端单元测试（vitest）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测（编译/字体/诊断/include，需 static/fonts）
npm run build        # 前端生产构建
npm run tauri build  # 打包桌面安装程序（需要 Rust）
```

## 测试与 CI

- 前端单元测试（vitest + jsdom）：`npm test`，覆盖引擎调用契约（`typst-engine`）、诊断位置映射（`diagnostics-utils`）、错误列表、文件操作、持久化、SVG 分页、PDF 文件名推导、菜单/快捷键等
- Rust 单测（`typst_world.rs` / `packages.rs` 内）：`cargo test`，覆盖中文+数学文档端到端编译（SVG/PDF）、字体注册、诊断行列转换、相对 include（含未保存文档提示）、@local/@preview 包解析与下载缓存（含 404/网络失败诊断区分、路径穿越防御）
- CI（GitHub Actions，`.github/workflows/ci.yml`）：
  - `test`（ubuntu）：push 到 main / PR 时跑 类型检查 → 单测 → 前端构建 → `cargo check`（首次编译 typst 依赖树较慢，之后命中 Rust 缓存）
  - `build-bundles`（windows）：仅 main push 触发，构建 .exe/.msi 安装包并 `upload-artifact`（同时写入缓存供 Release 复用）

## 发布（Release）

**构建与发布分离**：安装包由 CI 构建上传，发布 workflow 只做发布。

1. 修改版本号：`package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的 `version` **三处一致**（0.4.0 起 Cargo.toml 参与发版）
2. 提交推送并合并到 `main` → CI 自动构建安装包并上传 artifact（依赖不变时命中 Rust 缓存，快速）
3. 打 tag 触发发布：`git tag v0.x.y && git push origin v0.x.y`
4. GitHub → Actions → **Release**：下载最新 artifact → 生成草稿 Release（自动上传安装包）
5. Releases 页面编辑草稿 → 发布

> 缓存机制：`Swatinem/rust-cache` 的 key 基于 rust 版本 + `Cargo.lock` 哈希。依赖不变（Cargo.lock 不变）时跨版本命中；改动依赖会使缓存失效全量重编（引入 typst 依赖树时已付出过一次）。

## 架构

```
src/
├── routes/+page.svelte     # 主界面：工具栏 / 双栏 / 状态栏，立即编译调度（代次令牌丢弃过期结果）
├── lib/Editor.svelte       # CodeMirror 6 封装（Typst 语法、主题、外部 doc 同步）
├── lib/typst-engine.ts     # 编译引擎：Tauri invoke 包装（compile_doc / export_pdf）+ 结构化诊断
└── lib/file-ops.ts         # 打开/保存文件（Tauri dialog + invoke）
src-tauri/
├── src/lib.rs              # Rust 壳：read_file / write_file / compile_doc / export_pdf 等命令 + dialog/opener 插件
├── src/packages.rs         # 包系统：@local 读取 / @preview 自动下载缓存（与 CLI 目录规范一致）
└── src/typst_world.rs      # 内嵌编译世界：字体加载（FontBook）/ 相对 include 磁盘解析 / 包解析接线 / 诊断转换（SVG/PDF）
```

### 字体

预览渲染所需字体打包在 `static/fonts/`（约 5.7MB，离线可用，无需 CDN）：

- `NotoSerifCJKsc-Regular.otf` — 中文（思源宋体）
- `NewCMMath-{Regular,Bold,Book}.otf` — 数学（New Computer Modern Math）
- `LibertinusSerif-{Regular,Bold}.otf` — 正文衬线
- `DejaVuSansMono.ttf` — 等宽

字体加载在 **Rust 侧**完成：编译时读取字体目录（打包后为 `resource_dir/fonts`，开发/测试兜底仓库 `static/fonts`），把全部 `.ttf/.otf` 注册进 FontBook；目录缺失时不影响编译（typst 给出缺字诊断）。打包映射见 `tauri.conf.json` 的 `bundle.resources`（`../static/fonts` → `fonts/`）。

### 启动耗时观测

`src/lib/startup-timing.ts`：启动关键阶段打点（O(1)，无阻塞），首次编译完成后向控制台输出 `[startup]` 报告（各阶段耗时 + navigation timing 页面加载段）；Rust 侧（仅 debug 构建）另有 `[startup] rust phase:*` 打点（窗口创建 → webview 就绪 → 前端加载完成）。两侧同前缀，便于统一抓取对比。

## 验证脚本

```bash
node scripts/check-fonts.mjs    # 校验 static/fonts 字体文件有效性（魔数）
node scripts/download-fonts.mjs # 重新下载字体（jsDelivr，含重试）
cargo test --manifest-path src-tauri/Cargo.toml   # 原生编译验证（中文+数学 → SVG/PDF）
```

## 已知限制

- 单文件编辑，无文件树 / 多标签页
- 预览不跟随滚动（非所见即所得）
- 支持 `@local` 本地包（读取 typst 数据目录）与 `@preview` 在线包（首次使用时自动下载到 typst 共享缓存目录，离线后直接命中缓存；网络不可用时给出明确诊断）——包目录规范与 typst CLI 一致，可通过 `TYPST_PACKAGE_PATH` / `TYPST_PACKAGE_CACHE_PATH` 环境变量覆盖
- 未保存文档时相对 `include` 无法解析磁盘路径（Rust 侧给出"需要先保存文档"的明确诊断）
- `tauri.conf.json` 的 `csp` 保持 `null`：wasm 编译管线已移除（wasm 限制解除），但 CSP 未实测启用；如需启用请在 `npm run tauri build` 后实机验证

## License

[MIT](./LICENSE) © 2026 Z3O1
