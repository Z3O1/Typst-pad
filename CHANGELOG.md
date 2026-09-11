# 更新日志（Changelog）

本项目更新日志（中文）。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **字体目录从 `static/fonts/` 移到 `src-tauri/fonts/`**：字体只有 Rust 编译侧在用（`bundle.resources` → `resource_dir/fonts`），放在前端静态目录会被 SvelteKit 整份拷进前端产物（`build/fonts/`，前端从不引用），安装包内白多一份约 5.7MB。相关路径同步更新：`tauri.conf.json` 的 `resources`（改成 `fonts → fonts/`）、`resolve_fonts_dir` 的回退路径（`src-tauri/fonts`）、Rust 单测的字体目录、`scripts/check-fonts.mjs`、`scripts/download-fonts.mjs` 与若干调试脚本

## [0.7.0] - 2026-09-10

### Added

- **「格式」菜单 + 快捷键**（Typora 没有工具条，格式操作走菜单）：加粗 `Ctrl+B`、斜体 `Ctrl+I`、行内代码 `Ctrl+Shift+\``、行内公式 `Ctrl+M`、公式块 `Ctrl+Shift+M`、标题 1/2/3 `Ctrl+1/2/3`、正文 `Ctrl+0`、无序/有序列表 `Ctrl+Shift+]/[`、引用 `Ctrl+Shift+Q`、代码块 `Ctrl+Shift+C`、链接 `Ctrl+K`。纯逻辑在 `write-commands.ts`（`planForCommand` → `EditPlan`），可单测
- 浏览器验证脚本升级：交互验收 49 项、真实排版视觉验收 12 项（真实产物夹具按**字号**匹配，两种模式各一份）

### Changed

- **写作模式 / 源代码模式两套 UI（仿 Typora）**：写作模式为单栏整页纸张（灰底 + 居中白纸 + 轻阴影）、衬线正文（思源宋体，与预览/PDF 输出同字体）、16px 行距 1.9、无行号；源代码模式为等宽代码编辑器 + 行号 + 右栏整页预览。`Ctrl+/` 或「视图 → 源代码模式」切换，状态栏有模式标识；格式操作走「格式」菜单 + 快捷键（无工具条，与 Typora 一致）
- 版本号 0.6.0 → 0.7.0（package.json / tauri.conf.json / Cargo.toml 三处一致）
- CI 的 action 全部升级到 Node 24 运行时版本（`actions/checkout@v5`、`actions/setup-node@v5`、`actions/cache@v5`、`actions/upload-artifact@v6`、`softprops/action-gh-release@v3`），消除 GitHub Actions 的 "Node.js 20 is deprecated" 告警；缓存 key 规则不变（`Swatinem/rust-cache@v2` 本身已是 node24，未动）

### Fixed

- **写作模式下公式比正文小一圈**：正文 16px（=12pt）而公式仍按 10.5pt（旧 14px 字号）编译 → 公式字号改为由前端按编辑器实际字号传入（`compile_math` 的 `size_pt`），字号参与渲染缓存键
- **暗色主题下公式"消失"**：写作模式曾不挂 CodeMirror 主题，基础主题自带白底，而公式被 `filter: invert(1)` 反成白色 → 白底白字；现在两种模式都跟随主题
- **写作模式衬线字体不生效**：CM6 基础主题给 `.cm-content` 钉了 `monospace`，只改 `.cm-editor` 无效
- **`Ctrl+B` 等包装命令把选区末尾换行也包进去** → 变成跨行强调（Typst 里不是粗体）：首尾空白现在留在定界符外侧
- 浏览器开发模式的假渲染（桩画的假 SVG）现在带红色虚线框与控制台警告，避免被误当成真实排版

## [0.6.0] - 2026-09-10

### Added

- **所见即所得（编辑器内联渲染）**：Typora / Obsidian Live Preview 形态——公式在编辑区就地渲染成排版结果，光标或选区进入时自动展开源码；常用标记（标题分级放大、`*粗体*`、`_斜体_`、行内代码、无序列表符号、`#link("url")[文字]` 只显示文字）同样就地呈现。默认开启，视图菜单可关闭（开关随主题一起持久化）
  - 新增 `compile_math` 命令与 `typst_world::compile_math`：单公式 → 贴边透明 SVG + pt 尺寸 + 基线（两页探针法测量基线，见函数文档）
  - 新增前端模块：`typst-lex.ts`（markup / 代码 / 原始文本 / 注释 / 字符串区域扫描）、`math-ranges.ts`（公式定界符识别）、`markup-ranges.ts`（常用标记拆解）、`live-preview.ts`（CodeMirror 装饰：公式 widget + 标记隐藏 + 选区进出展开）
  - 独占整行的行间公式（含跨行书写）整行替换为**居中**的块级 widget（CodeMirror 块级装饰来自 StateField，不能用 ViewPlugin——会抛 "Block decorations may not be specified via plugins"）
  - 公式编译上下文 = 前缀 + 文档自身的单行顶层 `#let` 定义（`math-context.ts`，同名保留最后一次、半截语句跳过），失败时退回「仅前缀」重试一次
  - 有序列表 `+ ` 按缩进计数替换为 `1. ` 序号
  - ```` ``` ```` 围栏代码块整段渲染为等宽代码块 widget（围栏自动收起、公共缩进按 typst 语义剔除），光标进入即整段回到源码
  - 渲染请求管线：按公式文本 + 风格 + 编译上下文缓存、120ms 防抖、视口附近预取；请求自带上下文（避免异步批处理期间文档变化导致「新上下文结果存进旧键」）；渲染失败或未就绪时保持源码显示
  - 性能：编辑器每次重建把区域扫描结果复用给公式/标记两条扫描（40k 字符文档实测 13.7ms → 4.7ms）
- 浏览器端交互验证脚本 `scripts/browser-check/`（CDP 驱动 headless Chrome：真实输入、真实选区、DOM 断言、截图取证）；其中 `wysiwyg-visual.mjs` 把 Rust 侧真实公式产物注入页面，浏览器里即可验证真实 typst 排版（基线对齐、pt→px 尺寸、块级居中、暗色反色）
- 非 Tauri 环境的"请使用桌面应用版本"提示页在开发模式下多了一键进入浏览器开发模式的入口（生产构建不显示）

### Changed

- **所见即所得形态为单栏**：预览栏不再默认显示（编辑区即排版结果，占满整宽、作为"纸张"居中 ≤900px）；视图菜单新增「显示预览栏」，关掉所见即所得时自动回到双栏源码+预览对照。两个开关都持久化
- 公式编译上下文改由编辑器扩展自身从当前文档计算（此前是页面里的 `$derived`，每次按键多做一遍全文档扫描）
- 版本号 0.5.0 → 0.6.0（package.json / tauri.conf.json / Cargo.toml 三处一致）

### Fixed

- **每次按键的扫描成本**（两处，实测 40k 字符文档）：① 编辑器一次更新里 lexer 跑了三遍（装饰重建、渲染请求收集、编译上下文提取）→ 加单条记忆化，降为一遍；② 粗体/斜体候选与"区域是否相交"的判定是线性扫描，区域表上千条时退化到 O(候选 × 区域)，一次重建 47ms → 改二分，2.6ms。整体 13ms → 6.4ms
- 行内代码/公式/标记的判定不再误伤紧邻的代码区与公式（补 200 组区域的回归用例）
- 公式渲染失败时不再白跑一次装饰全量重建（失败结果仍进缓存，避免反复重试）
- 扫描器鲁棒性测试 `typst-scan-fuzz.test.ts`：120 份固定种子的随机文档 + 15 组病态输入，断言三个扫描器不抛异常、区间有序不越界不重叠、区域无缝覆盖全文

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
