# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Typst-pad：Typora 式布局的 Typst 桌面编辑器（左编辑 / 右实时预览）。前端 SvelteKit SPA（adapter-static），桌面壳 Tauri 2（Rust），编译渲染用**内嵌 typst crate**（0.15.x，Rust 进程内编译，本地字体）。代码注释与 README 均为中文。

## 常用命令

```bash
npm install          # 安装依赖
npm run dev          # 仅前端 UI（无预览/文件功能；非 Tauri 环境显示"请使用桌面应用版本"提示页）
npm run tauri dev    # 桌面应用（需 Rust；Vite 固定端口 1420）
npm run check        # 类型检查（svelte-kit sync + svelte-check）
npm test             # 前端单元测试（vitest + jsdom，只跑 src/**/*.test.ts）
npm test -- src/lib/typst-engine.test.ts   # 跑单个测试文件
npm run build        # 前端生产构建（输出 build/）
npm run tauri build  # 打包桌面安装程序（需 Rust）
cargo check --manifest-path src-tauri/Cargo.toml   # 只查 Rust 壳
cargo test --manifest-path src-tauri/Cargo.toml    # Rust 单测（typst_world/packages：编译/字体/诊断/include/包解析下载）
node scripts/check-fonts.mjs    # 校验 static/fonts 字体有效性
```

## 架构

```
src/routes/+page.svelte     # 唯一页面：全部状态与调度中枢（菜单/文件/编译/持久化/快捷键）
src/lib/Editor.svelte       # CodeMirror 6 封装：受控 doc、主题 Compartment、诊断波浪线
src/lib/typst-engine.ts     # 编译引擎：Tauri invoke 包装（compile_doc/export_pdf）+ 结构化诊断
src/lib/file-ops.ts         # Tauri dialog + invoke 封装（isTauri() 门控）
src/lib/persistence.ts      # localStorage（key: "typst-pad:state"）
src/lib/MenuBar.svelte      # 菜单栏（Alt 焦点切换 + 字母快捷键）
src/lib/pdf-export.ts       # PDF 导出文件名推导（文档标题 → "报告.pdf"，纯函数可单测）
src/lib/svg-paginate.ts     # 多页 SVG 页间分隔线（类名固定 page-separator，可单测）
src/lib/diagnostics-utils.ts # 编译源位置 → 文档位置映射（mapCompiledPosToDoc）与波浪线区间（squiggleRanges）
src/lib/doc-utils.ts        # 文档纯函数：isEffectiveDirty（空文档视为未修改）、ensureTrailingNewline（前缀末行补换行）
src/lib/startup-timing.ts   # 启动打点：首次编译完成后输出 [startup] 报告（见"启动耗时观测"）
src-tauri/src/lib.rs        # Rust 壳：read/write/write_binary/list_dir_typ/take_pending_files/compile_doc/export_pdf 命令 + opener/dialog 插件
src-tauri/src/packages.rs   # 包系统：@local 本地包读取 / @preview 自动下载缓存（目录规范与 CLI 一致 + 安全解压）
src-tauri/src/typst_world.rs # 内嵌编译世界：字体加载（FontBook）/ 相对 include 磁盘解析 / 包解析接线 / 诊断转换（SVG/PDF）
```

### 编译数据流（核心链路）

`+page.svelte` 监听内容变化 → `scheduleCompile()` **立即**编译（无防抖）→ `runCompile` 拼接编译源（`ensureTrailingNewline(prefixCode) + doc`，前缀末行自动补换行）→ `compileToSvg(source, filePath)` invoke `compile_doc { src, documentPath }`（`documentPath` = 已保存文档绝对路径 / null = 未保存）→ Rust 侧在 `spawn_blocking` 中编译（命令层互斥锁串行化，typst 引擎进程内一次一个）→ 返回结构化 `CompileOutput { ok, pages, diagnostics, warnings }`（serde `rename_all = "camelCase"`）。

前端用 `compileSeq` 代次令牌：每次编译前自增并记录 `mySeq`，结果返回时若 `mySeq !== compileSeq` 则**丢弃过期结果**。成功：`previewHost.innerHTML = composePages(pages)`（页间 `page-separator` 分隔线）；失败：**保留最后一次成功预览**（不隐藏不报错面板），`errorLocations` 转成编辑器红色波浪线，状态栏显示错误个数。invoke/IPC 异常也收敛为错误结果（`errors` 为空，`error` 带原始消息）。首次编译完成触发一次 `reportStartup()`。

PDF 导出链路：`pdf-export.ts` 由文档标题推导文件名（"报告.pdf"）→ 前端弹原生"另存为"对话框 → `compileToPdf` invoke `export_pdf { src, documentPath, targetPath }`，Rust 侧编译 PDF 字节直接落盘（走 `validate_write_path`）。

**诊断为 Rust 侧结构化对象**（`{ message, severity, line, column, endLine, endColumn, path }`，1-based 行列，`end` 为独占终点；`path` 空/缺失 = 主文档，include 文件给出其路径）——**不再有前端 range 字符串解析**（旧 `parseDiagnosticRange` 已随 wasm 编译移除）。`diagnostics-utils.ts` 现在的职责：编译源（前缀+文档）位置 → 用户文档位置映射（`mapCompiledPosToDoc`，前缀区错误跳过）与波浪线区间计算（`squiggleRanges`）。

### 启动耗时观测

`startup-timing.ts`：启动关键阶段打点（O(1) 无阻塞），首次编译完成后向控制台输出 `[startup]` 报告（各阶段耗时 + navigation timing 页面加载段）；Rust 侧（**仅 debug 构建**）另有 `[startup] rust phase:*` 打点（窗口创建 → webview 就绪 → 前端加载完成）。两侧同前缀，便于统一抓取对比启动性能回归。

### 原生编译后端（typst_world.rs）

typst crate（0.15.x）内嵌进 Rust 壳，`TypstWorld` 实现 `typst::World`。要点：

- **一次编译一个实例**：命令层 `CompileState` 互斥锁保证串行（避免并发 CPU 竞争与共享状态错乱），编译在 `spawn_blocking` 执行（不阻塞 UI）。
- **字体**：`load_fonts` 从字体目录全量加载 `.ttf/.otf` 注册进 `FontBook`；目录不可读时返回空集（typst 给出缺字诊断）。`resolve_fonts_dir`：优先打包产物 `resource_dir/fonts`（`bundle.resources` 映射 `../static/fonts → fonts/`），退回仓库 `static/fonts`（开发与 cargo test 路径）。
- **文件语义**：主文档源码由前端传入（未保存也可编译）；项目根 = `document_path` 所在目录，相对 include 从磁盘按 typst 语义解析（相对路径基于引用文件所在目录）；`document_path = None`（未保存）时 `check_relative_imports` 预检 `#include`，给出"需要先保存文档"的明确诊断。
- **包支持（packages.rs）**：`@local/{name}:{version}` 从本地数据目录读取、`@preview/{name}:{version}` 从缓存目录读取（miss 时自动下载 packages.typst.org 的 tar.gz 并解压进缓存）——目录规范/环境变量覆盖（`TYPST_PACKAGE_PATH`/`TYPST_PACKAGE_CACHE_PATH`）/URL 格式均与 typst CLI 一致，见 `src-tauri/src/packages.rs` 模块文档；下载为同步调用但编译整体在 `spawn_blocking` 内，不阻塞 UI；404 与网络失败分别产出 `package not found` / `failed to download package` 引擎同款诊断（可区分）。
- **接口契约**：`compile_doc → CompileOutput { ok, pages, diagnostics, warnings }`；`export_pdf → PdfResult { ok, error }`。`Err` 仅用于编译/导出任务本身异常终止（正常编译失败仍走 `Ok(ok:false)`）。
- 无 wasm 注入/插件联动：vite 保留的 `vite-plugin-wasm` + `vite-plugin-top-level-await` 两个插件**仅为 codemirror-lang-typst 的语法高亮服务**（其 typst() 扩展是 wasm-bindgen bundler 产物，删掉插件 build 会报 "ESM integration proposal for Wasm is not supported"，勿误删）。

### 字体

预览字体打包在 `static/fonts/`（7 个：思源宋体 / NewCMMath×3 / LibertinusSerif×2 / DejaVuSansMono，离线可用）。**加载全部在 Rust 侧**（FontBook），前端不再有字体注入（旧 `addFontData`/`loadFonts` 坑已随 wasm 移除）。新增字体时需同步：`scripts/download-fonts.mjs` 的 `FONTS` 列表、Rust 单测 `fonts_all_registered` 的计数/族名断言、README 字体清单。

### 文件操作与路径安全（src-tauri/src/lib.rs）

- 前端用 `isTauri()`（检测 `__TAURI_INTERNALS__`）区分桌面/浏览器；浏览器（非 Tauri）环境只显示"请使用桌面应用版本"提示页，不渲染应用 UI。
- Rust 侧 `validate_typ_path`：必须绝对路径、`.typ` 扩展名（大小写不敏感）、拒绝 `..` 穿越；`read_file` 先 canonicalize 复检符号链接；`write_file` 拒绝写入符号链接；`write_binary`（PDF 落盘，bytes 以 JSON 数字数组传来）与 `export_pdf` 走 `validate_write_path`——不限制扩展名，其余安全模型一致（`..`/符号链接同样拒绝）；`list_dir_typ` 递归列 `.typ`：深度 ≤ 8、最多 500 个、跳过隐藏条目、符号链接目录不递归（防环），返回 canonicalize 后路径。
- 无 single-instance 插件（每次启动独立实例）。`.typ` 文件打开走 `PendingFiles` 队列 + `emit("open-file")`：前端**先注册监听再取队列**（`take_pending_files`），避免事件落在两者之间丢失；macOS 的 Finder "打开方式" 走 `RunEvent::Opened`。
- `capabilities/default.json` 的 `windows` 覆盖 `"main"` 与 `"editor-*"`（Ctrl+N 新窗口），权限含 `core:window:allow-create/close/destroy/set-title` + opener/dialog。**新增窗口功能时需同步此文件**——曾因 capability 未覆盖新窗口导致窗口内文件功能被 ACL 拒绝（#32）。

### 安全模型

`tauri.conf.json` 的 `csp` 保持 `null`（wasm 编译管线已移除、wasm 限制解除，但 CSP 未实测启用）。纵深防御 = **SVG 产物来自进程内可信编译**（`sanitizeSvg` 模块已随 wasm 移除，不再需要）+ Rust 路径约束（read/write/export 命令统一校验绝对路径、拒绝 `..` 穿越、拒绝符号链接）。若改动 csp，必须在 `npm run tauri build` 后实机测试。

### 持久化与版本

- `persistence.ts`：300ms 防抖写 localStorage。**启动只恢复主题与前缀设置，不恢复上次编辑内容**（每会话全新开始）。
- 版本号约定（0.4.0 起）：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 `version` **三处一致**修改（Cargo.toml 参与发版）。CI Rust 缓存（Swatinem/rust-cache）key 基于 Cargo.lock 哈希——**改动依赖会使 Cargo.lock 变化、缓存失效全量重编**（引入 typst 依赖树时已付出一次）。**实测（2026-08-10）：rust-cache 的 key 不受根 crate 的 version 字段影响**（改 lock 根 version 为 `"1"` 后 key 不变、精确命中旧缓存）——因此只改版本号发版时缓存必然命中，无需为版本号做任何占位 hack；Cargo.lock 内 version 必须保持合法三段式 semver（写 `"1"` 会致 cargo "failed to parse lock file"，实测踩过）。
- 关于弹窗版本号运行时读取：`getVersion()`（@tauri-apps/api/app）返回 tauri.conf.json 的 version（关于弹窗显示"版本 x.y.z"），发版改版本号后前端无需改动。

## CI / 发布约定

- `ci.yml`：`test` job（ubuntu）push main/PR 跑 类型检查 → 单测 → 前端构建 → `cargo check`（**首次编译 typst 依赖树较慢**，之后命中缓存）；`build-bundles`（windows）**main push 或 workflow_dispatch 触发**（PR 不构建），Rust 缓存用 `shared-key: tauri-build-windows`（必须与 `release.yml` 相同，否则 release job 读不到缓存）。
- `release.yml`：`v*` tag 触发，自行 checkout + 构建 + 发草稿 Release（不依赖 ci.yml 的 artifact）。发布构建吃 main 分支写入的缓存。
- **缓存纪律（2026-08-10 事故后固化，勿回退）**：
  - rust-cache **禁止加 `cache-on-failure`**：被 cancel 的 run 即使编译已完成，post 上传缓存仍会被截断（实测 588MB 只传了 542MB），后续 run 精确命中同 key 不覆盖 → 半成品缓存永续，每次构建重编 55 个 crate（13 分钟）。只有成功完成的 run 才允许保存缓存。
  - **run 运行中不要 push main**：concurrency `cancel-in-progress` 会打断正在构建的 run，预热/发版构建被打断即前功尽弃。
  - 缓存损坏后的修复流程：`gh cache delete <key>` → 用 **workflow_dispatch 手动触发**（不是 push，push 会 cancel）→ 等 run 自然完成 → 再手动触发一次验证（预期仅 2 个 Compiling、~3 分钟）。
  - `tauri-bundle-tools` 缓存 key 含 `hashFiles('package-lock.json')`：依赖升级（tauri-cli 打包逻辑变化）自动失效重建，锁文件不变则稳定命中。
  - 健康缓存命中时构建 ~3 分钟（2 个 Compiling），全量 ~16 分钟（78 个 Compiling）——数字异常即缓存失效信号。
- 版本升级流程：改版本号（三处一致）→ 合并 main（自动构建）→ 打 tag → 手动发布草稿。

## 测试

- 前端 vitest + jsdom，`include: ["src/**/*.test.ts"]`；vite 的 `server.fs.allow: [".."]` 覆盖仓库上级目录（junction 场景下 node_modules 解析被拒的教训，见 #33，配置仍保留）。现有覆盖：`typst-engine`（invoke 契约映射 + 诊断转换纯函数，invoke/dialog 以 vi.mock 断言入参与消费）、`diagnostics-utils`、`error-list`、`context-menu-utils`、`doc-utils`、`editor-keymap`、`menu-keys`、`popover-utils`、`file-ops`、`persistence`、`svg-paginate`、`pdf-export`、`debug`。
- Rust 单测（`typst_world.rs`/`packages.rs` 内 `cargo test`，用 `CARGO_MANIFEST_DIR` 定位仓库 `static/fonts`）：中文+数学文档端到端编译（每页含 `<svg>`，PDF 字节非空）、字体注册（7 个文件 + 族名断言）、语法错误诊断（1-based 行列 + endLine）、相对 include（成功 / 缺失文件诊断带 path / 未保存文档提示）、JSON 序列化契约（camelCase 键名 `endLine`/`endColumn`）、@local/@preview 包（缓存命中不下载 / miss 下载与 URL 格式 / 404 与网络失败诊断区分 / 数据目录优先 / 路径穿越与损坏归档防御 / 端到端导入编译，均用临时目录注入环境变量，不触真实用户目录与网络）。
- 前端测试不接触真实编译——依赖引擎的逻辑保持"核心逻辑独立可测"（纯函数 + mock invoke）。
