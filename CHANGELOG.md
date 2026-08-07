# 更新日志（Changelog）

本项目更新日志（中文）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-08-08

### Added

- 原生编译后端：typst crate（0.15.x）内嵌进 Rust 壳（`src-tauri/src/typst_world.rs`），字体加载（FontBook）、相对 include 磁盘解析、SVG/PDF 输出全部在进程内完成；编译在 `spawn_blocking` 中串行执行，不阻塞 UI（#51）
- 新增 CHANGELOG.md（本文件）

### Changed

- 前端编译链路迁移到 Tauri invoke（`compile_doc` / `export_pdf` 命令）：编译返回结构化诊断（1-based 行列，camelCase 键名），前端以代次令牌丢弃过期结果，失败保留上次成功预览（#50）
- 版本号三处统一为 0.4.0（package.json / tauri.conf.json / Cargo.toml，Cargo.toml 自本版起参与发版）
- 关于弹窗版本号改为运行时 `getVersion()` 读取
- 前缀代码自动补尾随换行，避免前缀末行与文档首行合并（#49）

### Fixed

- 菜单栏与状态栏右键无效果（#48）

### Removed

- 移除浏览器支持：非 Tauri 环境仅显示"请使用桌面应用版本"提示页
- 移除 WASM 编译依赖（`@myriaddreamin/typst.ts` 三包）与 enqueue / svg-sanitize / font-load / typst-libs 模块（SVG 产物来自进程内可信编译，不再净化）
- 删除 `scripts/verify-typst.mjs`（WASM 编译管道验证脚本，已无意义）

## [0.3.2] - 2026-08-06

### Added

- 编辑快捷键（#35）、Ctrl+R 重新读取文件（#36）、Alt 菜单退出规则与菜单快捷键（#41）
- 自定义右键菜单（编辑器 + 预览）（#39）、编译错误 Popover 与前缀代码跳转（#40）
- 调试日志开关与 Rust 启动时序打点（#44）

### Changed

- 启动阶段耗时优化（#43）

### Fixed

- 编辑器内 import 本地 .typ 文件失败（#34）、编译错误波浪线偶发不显示（#42）
- 空文档视为未修改不再弹确认/显示圆点（#45）、未保存空文件直接关闭（#38）
- 编译错误 Popover 视口收边（#46）与二次打开位置错乱（#47）

## [0.3.1] - 2026-08-06

### Added

- 支持 `@preview` 官方包与本地 .typ 库导入（#31）

### Fixed

- 导出 PDF 弹原生"另存为"对话框并落盘（#30）
- capability 覆盖 `editor-*` 新窗口，修复 Ctrl+N 窗口内文件功能被 ACL 拒绝（#32）

### Changed

- vitest 配置允许仓库上级目录，修复 junction 场景下模块解析被拒（#33）

## [0.3.0] - 2026-08-02

### Added

- 设置前缀代码、编译错误保留预览与波浪线（#22）
- 菜单栏 Alt 焦点切换与字母快捷键（#21、#23）
- 状态栏重构（行列中文等）与编译错误徽标（#24、#27）

### Changed

- 预览改为页间分隔线排版、铺满预览区，预览框/工具栏背景跟随编辑框（#18、#25、#26）

### Fixed

- 关闭提示改为应用内模态，可靠保存/放弃/取消（close-prompt 重构）

### CI / 发布

- 修复 Release 流程并补齐 Rust 缓存（shared-key 打通 release 与 build-bundles）、缓存 Tauri 打包工具、concurrency 取消排队

## [0.2.7] - 2026-08-02

### Fixed

- 关闭确认弹窗 "Don't Save" 按钮行为修复

### Changed

- 构建与发布 workflow 拆分（release 可手动触发补跑缓存）

## [0.2.6] - 2026-08-02

### Added

- 窗口标题脏点（未保存标识）与关闭时保存提示

## [0.2.5] - 2026-08-02

### Added

- 紧凑菜单栏，Alt 激活时高亮

### Docs

- 补充发布说明与 CI 缓存作用域文档

## [0.2.4] - 2026-08-02

### Changed

- 顶栏改为经典菜单栏样式

## [0.2.3] - 2026-08-02

### Added

- 全宽文字菜单栏与键盘导航

## [0.2.2] - 2026-08-02

### Added

- 启动时打开新窗口、窗口标题显示文件名

## [0.2.1] - 2026-08-02

### Added

- Ctrl+N 新窗口 / Ctrl+W 关闭窗口快捷键
- localStorage 持久化（主题/前缀设置）与顶部菜单栏

### Changed

- MIT License；新建文档默认空白（不再预填示例内容）

### CI

- 缓存 Rust 构建产物，加速后续构建

## [0.1.1] - 2026-08-01

### Added

- 支持 `.typ` 文件关联（双击）打开与拖放打开

## [0.1.0] - 2026-08-01

### Added

- 首个可用版本：Tauri 2 桌面壳 + SvelteKit 前端，左编辑（CodeMirror 6）右实时预览（typst.ts WASM）
- Ctrl+S 保存、主题三态（自动 / 暗 / 明）

### Changed

- 产品名 Tpyst-pad 更正为 Typst-pad

### Test / CI

- SVG 净化模块化并接入 vitest 单测
- GitHub Actions 工作流与自动发布草稿流程
