# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Typst-pad：**仿 Typora 的 Typst 桌面编辑器，两套 UI**——「写作模式」（默认，单栏整页纸张：公式与标记就地排版、光标/选区进入即展开源码、无行号）与「源代码模式」（`Ctrl+/`，双栏：等宽代码编辑器 + 右栏整页预览）。前端 SvelteKit SPA（adapter-static），桌面壳 Tauri 2（Rust），编译渲染用**内嵌 typst crate**（0.15.x，Rust 进程内编译，本地字体）。代码注释与 README 均为中文。

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
node scripts/check-fonts.mjs    # 校验 src-tauri/fonts 字体有效性
npm run fixtures:math           # 导出真实公式产物到 .browser-check/（浏览器视觉验证用）
```

## 架构

```
src/routes/+page.svelte     # 唯一页面：全部状态与调度中枢（菜单/文件/编译/持久化/快捷键）
src/lib/Editor.svelte       # CodeMirror 6 封装：受控 doc、主题 Compartment、诊断波浪线、所见即所得接线
src/lib/typst-lex.ts        # 源码区域扫描：markup / code / raw / comment / string（标记识别的前提，纯函数）
src/lib/math-ranges.ts      # 公式范围扫描（$...$ / $ ... $）+ 缓存键 + 选区相交判定（纯函数）
src/lib/math-context.ts     # 公式编译上下文：前缀 + 文档内单行顶层 #let 定义（纯函数）
src/lib/markup-ranges.ts    # 常用标记拆解（标题/粗体/斜体/行内代码/围栏代码块/列表符号/链接 → 标记 + 正文/块级范围，纯函数）
src/lib/live-preview.ts     # 所见即所得 CM6 扩展：公式 replace widget + 标记隐藏 + 选区进出展开 + 渲染请求
src/lib/typst-engine.ts     # 编译引擎：Tauri invoke 包装（compile_doc/compile_math/export_pdf）+ 结构化诊断
src/lib/file-ops.ts         # Tauri dialog + invoke 封装（isTauri() 门控）
src/lib/persistence.ts      # localStorage（key: "typst-pad:state"）
src/lib/MenuBar.svelte      # 菜单栏（Alt 激活 + 字母快捷键；**不夺编辑区焦点**，见下方「菜单不夺焦」）
src/lib/pdf-export.ts       # PDF 导出文件名推导（文档标题 → "报告.pdf"，纯函数可单测）
src/lib/svg-paginate.ts     # 多页 SVG 页间分隔线（类名固定 page-separator，可单测）
src/lib/diagnostics-utils.ts # 编译源位置 → 文档位置映射（mapCompiledPosToDoc）与波浪线区间（squiggleRanges）
src/lib/doc-utils.ts        # 文档纯函数：isEffectiveDirty（空文档视为未修改）、ensureTrailingNewline（前缀末行补换行）
src/lib/startup-timing.ts   # 启动打点：首次编译完成后输出 [startup] 报告（见"启动耗时观测"）
src/lib/write-commands.ts   # 写作模式格式命令的纯逻辑：planForCommand → EditPlan（不碰 CodeMirror，可单测）
src/lib/error-list.ts       # 编译错误列表数据组装 + 前缀行定位（纯函数）
src/lib/preview-scale.ts    # 预览画布等宽缩放：pt → px（1pt = 4/3px），字号对齐编辑区
src/lib/context-menu-utils.ts # 右键菜单纯逻辑：区域判定 / 菜单项 enabled / 弹出位置收边
src/lib/ContextMenu.svelte  # 自定义右键菜单 UI（命令映射在 +page.svelte）
src/lib/menu-keys.ts        # 菜单栏按键决策纯函数（Alt / accessKey / Ctrl+单键快捷键匹配）
src/lib/debug.ts            # 调试日志通道 dbg（dev 默认开；--debug / ?debug=1 / localStorage 可开）
src/lib/browser-dev-stub.ts # 浏览器开发桩：假 __TAURI_INTERNALS__ + 假编译，供 ?browserdev=1 用（仅开发）
src/routes/+layout.ts       # SPA 模式（ssr = false），配合 adapter-static 的 index.html fallback
src-tauri/src/lib.rs        # Rust 壳：read/write/write_binary/list_dir_typ/take_pending_files/compile_doc/compile_math/export_pdf 命令 + opener/dialog 插件
src-tauri/src/packages.rs   # 包系统：@local 本地包读取 / @preview 自动下载缓存（目录规范与 CLI 一致 + 安全解压）
src-tauri/src/typst_world.rs # 内嵌编译世界：字体加载（FontBook）/ 相对 include 磁盘解析 / 包解析接线 / 诊断转换（SVG/PDF）
src-tauri/src/main.rs       # 桌面入口（调用 lib.rs 的 run）
src-tauri/fonts/            # 打包字体（见"字体"：**不放 static/**）
```

配置与辅助目录：
- `vite.config.js`：SvelteKit + wasm 插件 + **dev 白屏修复三件套**（见"原生编译后端"末尾，勿动）；Tauri 开发用 `TAURI_DEV_HOST`。
- `vitest.config.ts`：jsdom + `include: ["src/**/*.test.ts"]` + `server.fs.allow: [".."]`。
- `svelte.config.js`：`@sveltejs/adapter-static`（SPA，`fallback: index.html`）。
- `.github/workflows/`：`ci.yml`（test + build-bundles）、`release.yml`（tag 发草稿 Release），约定见"CI / 发布约定"。
- `scripts/`：`check-fonts.mjs`（字体魔数校验）、`download-fonts.mjs`（重新下载字体）、`browser-check/`（CDP 验收）、`install-vs-buildtools.bat`/`verify-app.bat`（Windows 辅助）。
  **历史遗留（wasm 时代，依赖已移除的 `@myriaddreamin/typst.ts`，跑不起来、也无人引用）**：`debug-math*.mjs`、`debug-svg.mjs`、`debug-fontinfo.mjs`、`verify-sanitize.mjs`。
- `docs/`：`WYSIWYG-调研.md`（所见即所得的方案调研）；`CHANGELOG.md` 按 Keep a Changelog 维护；`.browser-check/` 为验收产物（已 gitignore）。

### 编译数据流（核心链路）

`+page.svelte` 监听内容变化 → `scheduleCompile()` **立即**编译（无防抖）→ `runCompile` 拼接编译源（`ensureTrailingNewline(prefixCode) + doc`，前缀末行自动补换行）→ `compileToSvg(source, filePath)` invoke `compile_doc { src, documentPath }`（`documentPath` = 已保存文档绝对路径 / null = 未保存）→ Rust 侧在 `spawn_blocking` 中编译（命令层互斥锁串行化，typst 引擎进程内一次一个）→ 返回结构化 `CompileOutput { ok, pages, diagnostics, warnings }`（serde `rename_all = "camelCase"`）。

前端用 `compileSeq` 代次令牌：每次编译前自增并记录 `mySeq`，结果返回时若 `mySeq !== compileSeq` 则**丢弃过期结果**。成功：`previewHost.innerHTML = composePages(pages)`（页间 `page-separator` 分隔线）；失败：**保留最后一次成功预览**（不隐藏不报错面板），`errorLocations` 转成编辑器红色波浪线，状态栏显示错误个数。invoke/IPC 异常也收敛为错误结果（`errors` 为空，`error` 带原始消息）。首次编译完成触发一次 `reportStartup()`。

PDF 导出链路：`pdf-export.ts` 由文档标题推导文件名（"报告.pdf"）→ 前端弹原生"另存为"对话框 → `compileToPdf` invoke `export_pdf { src, documentPath, targetPath }`，Rust 侧编译 PDF 字节直接落盘（走 `validate_write_path`）。

**诊断为 Rust 侧结构化对象**（`{ message, severity, line, column, endLine, endColumn, path }`，1-based 行列，`end` 为独占终点；`path` 空/缺失 = 主文档，include 文件给出其路径）——**不再有前端 range 字符串解析**（旧 `parseDiagnosticRange` 已随 wasm 编译移除）。`diagnostics-utils.ts` 现在的职责：编译源（前缀+文档）位置 → 用户文档位置映射（`mapCompiledPosToDoc`，前缀区错误跳过）与波浪线区间计算（`squiggleRanges`）。

### 所见即所得（编辑器内联渲染）数据流

形态 = Typora / Obsidian Live Preview：**源码仍是唯一真相**，编辑器在非选区处把可渲染范围换成渲染结果，光标/选区进入即展开源码。

- **范围识别**：`typst-lex.ts` 先把文档切成 markup / code / raw / comment / string 区域（`#let a = b*c*d`、`#let s = "$5"`、`// $x$`、`` `$x$` `` 都不参与标记识别；代码里成对 `[...]` 是内容块，内部回到 markup）；`math-ranges.ts` 在 markup 区里认 `$...$`（内侧两侧空白 = 行间公式），`markup-ranges.ts` 拆标题/粗斜体/行内代码/列表符号/链接。**保守优先：宁可漏渲染，不可误渲染。**
- **公式渲染**：`live-preview.ts` 视口内出现未缓存公式 → `onRequest` 回调父组件（`+page.svelte`）→ 去重 + 120ms 防抖 → `compileMath()` invoke **`compile_math { body, display, context, documentPath }`**（与 compile_doc 共用命令层互斥锁，一次一个）→ 结果进 `mathCache`（键 = 风格 + 前缀 + 公式文本，前缀参与键）→ `mathVersion++` → 编辑器 dispatch `refreshLivePreview` 重整装饰。
- **渲染契约（`MathOutput`）**：`{ ok, svg, widthPt, heightPt, baselinePt, error }`。svg 是**贴边**（`#set page(width/height: auto, margin: 0pt)`）且**透明底**（`fill: none`）的单页 SVG；尺寸单位 pt。**基线**用「两页探针」测得：`page.frame.baseline()` 实测返回盒底（`has_baseline=false`），故第 2 页放同一公式 + 一个挂在基线下 100pt 的零宽盒，页高 = ascent + 100pt → `ascent = H2 - 100`；外层 `#box(...)` 不可省（行间公式不加盒时探针会另起段落，实测 ascent 由 11.75pt 变 31.67pt）。
- **字号**：`MATH_TEXT_PT = 10.5`（Rust）/ 编辑器正文 14px = 10.5pt，故 SVG 的 pt 与编辑器 CSS 的 pt **1:1**，前端直接写 `width/height: Npt` + `vertical-align: -(height-baseline)pt`。改字号要两侧同步。
- **暗色主题**：typst 产物是黑字透明底，暗色下看不见 → widget 带 `cm-math-dark` 类整体 `filter: invert(1)`。**不要用 `&dark` 选择器**：`EditorView.theme` 不支持该前缀（实测抛 `RangeError: Unsupported selector: &dark`，SvelteKit 会整页渲染成 500 错误页，表现为"应用没渲染"）。
- **展开规则**：`selectionTouchesRange`（光标落在区间内含两端即展开，非空选区相交即展开）。标记类构造的展开范围必须是**标记 + 正文的并集**——标题/列表只有前导标记，只取标记范围会导致光标落在正文里时 `= ` 不露出（实测踩过）。
- **块级 widget**：**独占整行**的行间公式（`$ ... $`，含跨行书写）整行替换为居中的块级 widget（`blockRangeFor` 判定"前后只有空白"）；```` ``` ```` 围栏代码块同样整段替换为等宽代码块 widget（`rawBlockFor`：围栏必须独占整行，代码按 typst 语义剔除公共缩进；纯文本展示，不需要编译）；与文字同行的 `$ x $` 仍走行内 widget（整行替换会把旁边正文一起盖掉）。块级/跨行替换**只能由 StateField 提供**——ViewPlugin 提供会抛 `Block decorations may not be specified via plugins`（实测确认：CM6 只对"函数型"动态装饰置 disallow 标记）。
- **公式编译上下文**：`math-context.ts` 把「前缀」与「文档内**单行顶层** `#let` 定义」拼成 context（多行语句、含 `[...]` 内容块的语句、`=` 后无值的半截语句一律跳过——后者若拼进去会让所有公式一起编译失败）。同名定义保留最后一次。文档定义本身有错/与前缀重名 → 父组件退回「仅前缀」重试一次。
- **性能（三处热点，都已被实测锁住，勿回退）**：
  1. `scanNonMarkupRegions` 带**单条记忆化**：编辑器一次更新里它会被用三处（StateField 装饰重建、ViewPlugin 请求收集、`buildMathContext` 的 `#let` 提取）。加缓存前 40k 字符文档每次按键要扫三遍；返回的数组被 `Object.freeze`，调用方只读。
  2. `markup-ranges` 的"是否与公式/代码区相交"判定用**二分**（`overlapsSorted`），不是 `some(...)` 线性扫描——区域表上千条时线性是 O(候选 × 区域)，实测一次重建 47ms，改二分后 2.6ms。
  3. 编译上下文在**扩展内部**算（`prefix` 选项 + 当前 doc），不要挪回页面做 `$derived`：那会让每次按键多一遍全文档扫描。
  合计：40k 字符文档一次更新 6.4ms（4k 字符 ~1.5ms）。
- **两套 UI（仿 Typora）**：`viewMode: "write" | "source"`（取代旧的 `livePreview` 布尔，旧存档自动迁移）。
  - **写作模式**（默认，单栏）：灰底 + 居中纸张（`.panes.single .editor-pane .pane-body` 上用 `--bg-backdrop`/`--bg-paper`）、衬线正文（Noto Serif CJK SC，与预览/PDF 输出同字体）、16px/行距 1.9、**隐藏行号槽**与当前行高亮（都在 `Editor.svelte` 的 `.editor-host.write` 样式里）、状态栏显示「写作」且不显示行列。公式/标记就地排版。
    - **字体必须写在 `.cm-content` 上**：CodeMirror 基础主题给 `.cm-content` 自己钉了 `font-family: monospace`，只改 `.cm-editor` 不生效（实测：写作模式正文仍是等宽）。
    - **暗色下必须照常挂 oneDark**：CM6 基础主题自带**白底黑字**；若写作模式不挂主题，编辑器仍是白底，而公式 widget 已被 `filter: invert(1)` 反成白色 → **白底白字，公式"消失"**（实测被反馈的就是这个）。主题变量 `--bg-paper` 同时给 `.cm-editor/.cm-scroller/.cm-gutters`，避免深色纸与编辑器底色两块色。
    - **公式字号必须等于正文字号**：写作模式 16px → `MATH_SIZE_PT = 12`（`typst-engine.ts`），随 `compile_math` 的 `size_pt` 参数传给 Rust（缺省 10.5pt = 源码模式 14px）。字号参与缓存键。曾经写死 10.5pt，写作模式下公式比正文小一圈（实测被反馈）。
  - **源代码模式**（`Ctrl+/`，双栏）：等宽 14px + 行号 + oneDark（暗），右侧整页预览；此模式下 live-preview 整体关闭（看到的是真正的 Typst 源码）。
  - **格式操作走菜单 + 快捷键，不做工具条**（Typora 没有工具条）。纯逻辑在 `write-commands.ts`（`planForCommand` → `EditPlan`），编辑器侧只有一个 `runWriteCommand` 把它们落成事务。**块级命令的选区语义**：无选区 → 替换光标所在行（该行内容成为块内容，不丢字）；有选区 → 只替换选区。**包装命令把选区首尾空白留在定界符外侧**：`*文字\n*` 在 Typst 里是跨行强调、我们自己的标记扫描也不识别 → 会退化成字面星号（实测：Ctrl+A 后按 Ctrl+B）。**引用必须用 `#quote(block: true)[...]`**——Typst 没有 Markdown 的 `>` 语法，写 `>` 只会留字面字符。
  - 快捷键分两处：无 Shift 的（Ctrl+B/I/K/1/2/3/0/M）放菜单项的 `shortcut` 由 MenuBar 统一匹配；**带 Shift 的**（Ctrl+Shift+` 行内代码、Ctrl+Shift+M 公式块、Ctrl+Shift+[ / ] 列、Ctrl+Shift+Q 引用、Ctrl+Shift+C 代码块）由 `+page.svelte` 的 window keydown 处理——MenuBar 的匹配器只支持「Ctrl+单键」，这是既有约定（见 menu-keys.ts）。
  - `showPreview` 与模式联动：写作模式单栏、源码模式双栏；预览栏隐藏时容器仍在 DOM（`display:none`），`compile_doc` 写入链路不受影响。
- **编辑器文档的受控契约（丢过内容，勿回退）**：`+page.svelte` 的 `doc`（页面状态）与 `editorDoc`（传给 `Editor` 的受控文档）是**实时镜像**——`handleDocChange` 里两个一起写，`initialDoc={editorDoc}`。原因：`editorDoc` 曾经只在打开/新建/重读时更新，是个陈旧镜像，一旦 Editor 重挂载（或 props 重新生效），旧值就被当成"外部文档"推回编辑器，把未保存的新输入覆盖成上次打开/保存的版本（用户反馈的"切换模式时未保存内容消失"）。Editor 侧另加**「同一外部值只推一次」守卫**（`appliedExternalDoc`）与替换日志（`dbg` 的 `editor` 通道）。**绝不能让 `editorDoc` 落后于编辑器内容。**
- **打开/重读的安全底线**：`openPath` 只要有未保存修改就确认（**同路径也不例外**——此前 `filePath !== path` 的豁免会让"把当前 .typ 拖进窗口"这类操作静默丢弃未保存修改）；`reloadFile`（Ctrl+R）同样确认。
- **菜单不夺焦（用户明确要求：「不要改变当前编辑位置」）**：Alt 激活菜单栏时**不再**让编辑区失焦——失焦会让光标消失、下一个非 accessKey 字母还会被菜单吃掉。菜单栏只依赖 window 上的 keydown（accessKey / 方向键 / Esc / Enter 都照常），不需要 DOM 焦点；只有「取消选中」一侧把焦点交回编辑器（鼠标点过菜单项后焦点落在按钮上，必须还回去，见 `handleMenuFocusChange`）。**别把 `el.blur()` 加回去。**
- **回退**：渲染失败 / 未就绪 / 行内跨行公式 → 不挂 widget，保持源码显示（不出现空占位、不弹错误）。
- **持久化**：`viewMode`（+ `showPreview`）与主题一起存 localStorage；旧的 `livePreview` 布尔自动迁移为 `viewMode`；视图菜单（`Ctrl+/`）切换。

### 启动耗时观测

`startup-timing.ts`：启动关键阶段打点（O(1) 无阻塞），首次编译完成后向控制台输出 `[startup]` 报告（各阶段耗时 + navigation timing 页面加载段）；Rust 侧（**仅 debug 构建**）另有 `[startup] rust phase:*` 打点（窗口创建 → webview 就绪 → 前端加载完成）。两侧同前缀，便于统一抓取对比启动性能回归。

### 原生编译后端（typst_world.rs）

typst crate（0.15.x）内嵌进 Rust 壳，`TypstWorld` 实现 `typst::World`。要点：

- **一次编译一个实例**：命令层 `CompileState` 互斥锁保证串行（避免并发 CPU 竞争与共享状态错乱），编译在 `spawn_blocking` 执行（不阻塞 UI）。
- **字体**：`load_fonts` 从字体目录全量加载 `.ttf/.otf` 注册进 `FontBook`；目录不可读时返回空集（typst 给出缺字诊断）。`resolve_fonts_dir`：优先打包产物 `resource_dir/fonts`（`bundle.resources` 映射 `fonts → fonts/`），退回仓库 `src-tauri/fonts`（开发与 cargo test 路径）。
- **文件语义**：主文档源码由前端传入（未保存也可编译）；项目根 = `document_path` 所在目录，相对 include 从磁盘按 typst 语义解析（相对路径基于引用文件所在目录）；`document_path = None`（未保存）时 `check_relative_imports` 预检 `#include`，给出"需要先保存文档"的明确诊断。
- **包支持（packages.rs）**：`@local/{name}:{version}` 从本地数据目录读取、`@preview/{name}:{version}` 从缓存目录读取（miss 时自动下载 packages.typst.org 的 tar.gz 并解压进缓存）——目录规范/环境变量覆盖（`TYPST_PACKAGE_PATH`/`TYPST_PACKAGE_CACHE_PATH`）/URL 格式均与 typst CLI 一致，见 `src-tauri/src/packages.rs` 模块文档；下载为同步调用但编译整体在 `spawn_blocking` 内，不阻塞 UI；404 与网络失败分别产出 `package not found` / `failed to download package` 引擎同款诊断（可区分）。
- **接口契约**：`compile_doc → CompileOutput { ok, pages, diagnostics, warnings }`；`compile_math → MathOutput { ok, svg, widthPt, heightPt, baselinePt, error }`（所见即所得的公式渲染，见上一节）；`export_pdf → PdfResult { ok, error }`。`Err` 仅用于编译/导出任务本身异常终止（正常编译失败仍走 `Ok(ok:false)`）。
- 无 wasm 注入/插件联动：vite 保留的 `vite-plugin-wasm` + `vite-plugin-top-level-await` 两个插件**仅为 codemirror-lang-typst 的语法高亮服务**（其 typst() 扩展是 wasm-bindgen bundler 产物，删掉插件 build 会报 "ESM integration proposal for Wasm is not supported"，勿误删）。
- **Linux/WSLg dev 白屏根因与修复（2026-09-01 实测，勿动）**：WebKitGTK 的模块求值在模块图含**顶层 await**（vite-plugin-wasm 给 codemirror-lang-typst 生成的 wasm 胶水模块是 `const __vite__wasmModule = await __vite__initWasm(...)`）时会崩掉 SvelteKit boot——`get_navigation_result_from_branch`（kit/client.js:799）在求值完成前访问节点模块的活绑定触发 TDZ（"Cannot access 'component' before initialization"），boot 整体拒绝 → 窗口纯白（无任何 UI，外观像"应用没渲染"）。Chromium 求值顺序不同无此问题（已用 Windows 无头 Chrome 对照：同一页面正常渲染）。修复三件套（均在 `vite.config.js`，**只影响 dev**）：
  1. `syncWasmInit` 插件（`apply: "serve"`）：把胶水的 `?url` 引入内联为 data:URL、`__vite__initWasm` helper 换成同步实例化（`new WebAssembly.Instance(new WebAssembly.Module(...))`，两引擎验证可用）→ 模块图无顶层 await。
  2. `optimizeDeps.exclude: ["codemirror-lang-typst"]` **不可删**：依赖预构建的 esbuild 阶段只走 `load` 不走 `transform`，插件改写不到；删了会退回带 TLA 的旧 bundle 重新白屏。清 `node_modules/.vite` 可强制重新预构建。
  3. 匹配是**按内容/字符串形状**做的（helper 是箭头函数 `export default async (opts = {}, url) =>`、胶水行尾无分号）——升级 vite-plugin-wasm 后若修复失效，先核对这两个形状。
  - 排查 WebKit 内部问题的利器：`WEBKIT_INSPECTOR_SERVER` 在新版 WebKitGTK 已废（只剩 `inspector://` 协议，普通 HTTP/WS 连不上，都是空响应）；webview 侧日志可用临时在 `src/app.html` 里挂 `window.onerror`/`unhandledrejection` + `window.__TAURI_INTERNALS__.invoke("write_file", ...)` 把日志写到 `/tmp/xxx.typ`（write_file 要求 .typ 后缀）桥接出来，用完即删。若 WSLg 下 WebKit 仍无法用 GL（libEGL DRI3 报错、白屏但有窗口），用 `GDK_BACKEND=x11 GDK_GL=disable WEBKIT_DISABLE_DMABUF_RENDERER=1` 强制软件渲染可解。

### 字体

预览字体打包在 `src-tauri/fonts/`（7 个：思源宋体 / NewCMMath×3 / LibertinusSerif×2 / DejaVuSansMono，离线可用）。**不放 `static/`**：那会被 SvelteKit 拷进前端产物（`build/fonts/`）而前端从不引用（无 `@font-face`），安装包凭空多一份 5.7MB。**加载全部在 Rust 侧**（FontBook），前端不再有字体注入（旧 `addFontData`/`loadFonts` 坑已随 wasm 移除）。新增字体时需同步：`scripts/download-fonts.mjs` 的 `FONTS` 列表、Rust 单测 `fonts_all_registered` 的计数/族名断言、README 字体清单。

### 文件操作与路径安全（src-tauri/src/lib.rs）

- 前端用 `isTauri()`（检测 `__TAURI_INTERNALS__`）区分桌面/浏览器；浏览器（非 Tauri）环境只显示"请使用桌面应用版本"提示页，不渲染应用 UI。
- Rust 侧 `validate_typ_path`：必须绝对路径、`.typ` 扩展名（大小写不敏感）、拒绝 `..` 穿越；`read_file` 先 canonicalize 复检符号链接；`write_file` 拒绝写入符号链接；`write_binary`（PDF 落盘，bytes 以 JSON 数字数组传来）与 `export_pdf` 走 `validate_write_path`——不限制扩展名，其余安全模型一致（`..`/符号链接同样拒绝）；`list_dir_typ` 递归列 `.typ`：深度 ≤ 8、最多 500 个、跳过隐藏条目、符号链接目录不递归（防环），返回 canonicalize 后路径。
- 无 single-instance 插件（每次启动独立实例）。`.typ` 文件打开走 `PendingFiles` 队列 + `emit("open-file")`：前端**先注册监听再取队列**（`take_pending_files`），避免事件落在两者之间丢失；macOS 的 Finder "打开方式" 走 `RunEvent::Opened`。
- **浏览器直开会看到"请使用桌面应用版本"**：这是刻意的 desktop gate（`+page.svelte` 的 `{#if isDesktopApp}` 分支）。开发模式下该页面额外给了一键入口（跳到 `?browserdev=1`），避免把"没带参数"误判成"应用坏了"（实测被反馈过一次）；生产构建不显示该入口。
- `capabilities/default.json` 的 `windows` 覆盖 `"main"` 与 `"editor-*"`（Ctrl+N 新窗口），权限含 `core:window:allow-create/close/destroy/set-title` + opener/dialog。**新增窗口功能时需同步此文件**——曾因 capability 未覆盖新窗口导致窗口内文件功能被 ACL 拒绝（#32）。

### 安全模型

`tauri.conf.json` 的 `csp` 保持 `null`（wasm 编译管线已移除、wasm 限制解除，但 CSP 未实测启用）。纵深防御 = **SVG 产物来自进程内可信编译**（`sanitizeSvg` 模块已随 wasm 移除，不再需要）+ Rust 路径约束（read/write/export 命令统一校验绝对路径、拒绝 `..` 穿越、拒绝符号链接）。若改动 csp，必须在 `npm run tauri build` 后实机测试。

### 持久化与版本

- `persistence.ts`：300ms 防抖写 localStorage（含正文 `content`、`filePath`/`fileTitle`、`dirty`、`restoreSession`）。
- **启动恢复（会话安全网）**：主题/前缀/界面模式总是恢复；**上次的正文**按设置恢复（设置弹窗「启动时恢复上次内容」，默认开）——editorDoc 陈旧推送、误触重读、WebView 重载这类"内容没了"都能被它兜住。恢复时 `filePath`/`fileTitle`/`dirty` 一并还原，所以「存过盘又没再改」的文档不会平白带上未保存圆点；恢复出来的未保存内容会让打开新文件 / 关闭窗口照常追问。关掉开关即回到「每次全新开始」。**新建（Ctrl+N）会 `clearState()`**，清掉存档后下次启动自然恢复出空文档。
- 版本号约定（0.4.0 起）：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 `version` **三处一致**修改（Cargo.toml 参与发版）。CI Rust 缓存（Swatinem/rust-cache）key 基于 Cargo.lock 哈希——**改动依赖会使 Cargo.lock 变化、缓存失效全量重编**（引入 typst 依赖树时已付出一次）。**实测（2026-08-10）：rust-cache 的 key 不受根 crate 的 version 字段影响**（改 lock 根 version 为 `"1"` 后 key 不变、精确命中旧缓存）——因此只改版本号发版时缓存必然命中，无需为版本号做任何占位 hack；Cargo.lock 内 version 必须保持合法三段式 semver（写 `"1"` 会致 cargo "failed to parse lock file"，实测踩过）。
- 关于弹窗版本号运行时读取：`getVersion()`（@tauri-apps/api/app）返回 tauri.conf.json 的 version（关于弹窗显示"版本 x.y.z"），发版改版本号后前端无需改动。

## 环境备忘（本机 WSL）

- **`git push` 走 22 端口偶发被掐**（`Connection closed by 20.205.243.166 port 22`）：改走 GitHub 的 443 入口即可 ——
  `GIT_SSH_COMMAND="ssh -p 443" git push git@ssh.github.com:Z3O1/Typst-pad.git HEAD:main`（已实测可用；先 `ssh -T -p 443 git@ssh.github.com` 验证认证）。
- **端口归属**：`1420` = `npm run tauri dev` / `npm run dev` 的 Vite 端口；`9333` = 验收用 headless Chrome 的 CDP 端口。
  两者都可能被上一次没退干净的进程占着（"Port 1420 is already in use"）；查占用：WSL `ss -ltnp | grep :1420`、Windows `/mnt/c/Windows/System32/netstat.exe -ano | findstr :1420`（镜像网络下 Windows 侧监听同样会挡住 WSL 绑定）。
- 无显示器环境：GUI 跑不了桌面端，验收一律用 `scripts/browser-check/`（Windows 的 headless Chrome + CDP）；`gh` 用 Windows 版 `/mnt/c/Program Files/GitHub CLI/gh.exe`（需 `--repo Z3O1/Typst-pad`，WSL 路径会触发 dubious ownership）。

## CI / 发布约定

- `ci.yml`：`test` job（ubuntu）push main/PR 跑 类型检查 → 单测 → 前端构建 → `cargo check`（**首次编译 typst 依赖树较慢**，之后命中缓存）；`build-bundles`（windows）**main push 或 workflow_dispatch 触发**（PR 不构建），Rust 缓存用 `shared-key: tauri-build-windows`（必须与 `release.yml` 相同，否则 release job 读不到缓存）。
- `release.yml`：`v*` tag 触发，自行 checkout + 构建 + 发草稿 Release（不依赖 ci.yml 的 artifact）。发布构建吃 main 分支写入的缓存。
- **缓存纪律（2026-08-10 事故后固化，勿回退）**：
  - rust-cache **禁止加 `cache-on-failure`**：被 cancel 的 run 即使编译已完成，post 上传缓存仍会被截断（实测 588MB 只传了 542MB），后续 run 精确命中同 key 不覆盖 → 半成品缓存永续，每次构建重编 55 个 crate（13 分钟）。只有成功完成的 run 才允许保存缓存。
  - **run 运行中不要 push main**：concurrency `cancel-in-progress` 会打断正在构建的 run，预热/发版构建被打断即前功尽弃。
  - 缓存损坏后的修复流程：`gh cache delete <key>` → 用 **workflow_dispatch 手动触发**（不是 push，push 会 cancel）→ 等 run 自然完成 → 再手动触发一次验证（预期仅 2 个 Compiling、~3 分钟）。
  - `tauri-bundle-tools` 缓存 key 含 `hashFiles('package-lock.json')`：依赖升级（tauri-cli 打包逻辑变化）自动失效重建，锁文件不变则稳定命中。
  - 健康缓存命中时构建 ~3 分钟（2 个 Compiling），全量 ~16 分钟（78 个 Compiling）——数字异常即缓存失效信号。
  - **rust-cache 的 key 含「Rust 工具链版本哈希」**（`add-rust-environment-hash-key` 默认开）：`dtolnay/rust-toolchain@stable` 跟到新的 Rust 稳定版后 key 整片失效、全量重编（2026-09-11 实测：Rust 1.98.1 令 restore key 变为 `v0-rust-tauri-build-windows-Windows_NT-x64-2113753f`，日志 "No cache found" → 78 个 crate、30 分钟）。这是**一次性**重建、不是回归，下一次 push 即恢复 ~3 分钟；排查时先看 "Cache Rust build" 步骤里的 Restore Key 与 "No cache found"，别急着动缓存配置。
- **action 版本约定（Node 24 运行时，2026-09-11）**：`actions/checkout@v5`、`actions/setup-node@v5`、`actions/cache@v5`、`actions/upload-artifact@v6`（v5 只是预备支持、默认仍跑 Node 20，必须 v6）、`softprops/action-gh-release@v3`，两个 workflow 保持一致——消除 GitHub 的 "Node.js 20 is deprecated（被强制跑在 Node 24 上）"告警。`Swatinem/rust-cache@v2` 已是 node24、`dtolnay/rust-toolchain` 是 composite 类型，无需升级。**升级 action 不影响任何缓存 key**（rust-cache 的 key 只由 shared-key/平台/Rust 版本/Cargo.lock 决定，见上）。
- 版本升级流程：改版本号（三处一致）→ 合并 main（自动构建）→ 打 tag → 手动发布草稿。

## 测试

- 前端 vitest + jsdom，`include: ["src/**/*.test.ts"]`；vite 的 `server.fs.allow: [".."]` 覆盖仓库上级目录（junction 场景下 node_modules 解析被拒的教训，见 #33，配置仍保留）。现有覆盖：`typst-engine`（invoke 契约映射 + 诊断转换纯函数，invoke/dialog 以 vi.mock 断言入参与消费）、`diagnostics-utils`、`error-list`、`context-menu-utils`、`doc-utils`、`editor-keymap`、`menu-keys`、`popover-utils`、`file-ops`、`persistence`、`svg-paginate`、`pdf-export`、`debug`、`preview-scale`、`write-commands`。
- Rust 单测（`typst_world.rs`/`packages.rs` 内 `cargo test`，用 `CARGO_MANIFEST_DIR` 定位 `src-tauri/fonts`）：中文+数学文档端到端编译（每页含 `<svg>`，PDF 字节非空）、字体注册（7 个文件 + 族名断言）、语法错误诊断（1-based 行列 + endLine）、相对 include（成功 / 缺失文件诊断带 path / 未保存文档提示）、JSON 序列化契约（camelCase 键名 `endLine`/`endColumn`）、@local/@preview 包（缓存命中不下载 / miss 下载与 URL 格式 / 404 与网络失败诊断区分 / 数据目录优先 / 路径穿越与损坏归档防御 / 端到端导入编译，均用临时目录注入环境变量，不触真实用户目录与网络）。
- 所见即所得链路测试：`typst-lex.test.ts`（区域扫描：注释/raw/字符串/代码/`[...]` 内容块）、`markup-ranges.test.ts`（标记拆解，含"代码与公式里的 `*` `_` 不算标记"、有序列表编号、围栏代码块）、`typst-scan-fuzz.test.ts`（**鲁棒性网**：120 份固定种子随机文档 + 15 组病态输入，断言不抛异常、区间有序不越界不重叠、区域无缝覆盖全文）、`math-context.test.ts`（`#let` 提取的保守规则）、`live-preview.test.ts`（jsdom 里真挂 EditorView，断言 widget 替换 / 块级 vs 行内 / 光标进出展开 / 失败回退 / 开关关闭 / 样式类）。**坑**：jsdom 下挂视图时光标默认在 offset 0，会落在构造内部而触发"展开"，测隐藏效果必须把光标放到构造之外。
- 前端测试不接触真实编译——依赖引擎的逻辑保持"核心逻辑独立可测"（纯函数 + mock invoke）。
- **浏览器端交互验证（无显示器环境下的验收手段）**：`scripts/browser-check/`（零依赖 CDP 驱动）
  - **端口**：验收脚本默认打 `http://localhost:1420/?browserdev=1`，而 **1420 也是 `npm run tauri dev` 的 Vite 端口**——用户自己开着桌面应用时，验收脚本会被 "Port 1420 is already in use" 挡住（实测被反馈过）。换端口跑即可：`npm run dev -- --port 1425` 起服务 + `BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs`（1420 是 `vite.config.js` 里写死的 `server.port` + `strictPort: true`，CLI `--port` 可覆盖，不覆盖时宁可报错也不自动换端口；脚本侧由 `cdp.mjs` 导出的 `DEV_URL` 读取 `BROWSER_CHECK_PORT` / `BROWSER_CHECK_URL`，`probe.mjs` 仍可传 URL 参数）。
  - `cdp.mjs`：连接 Windows headless Chrome 的 CDP（WSL 里直接跑 `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe --headless=new --remote-debugging-port=9333 --remote-debugging-address=0.0.0.0 --user-data-dir=... 'http://localhost:1420/?browserdev=1'`；镜像网络下 WSL 可直连 localhost:9333）；提供 evaluate / 真实点击 / 真实输入（`Input.insertText`）/ 截图。
  - `probe.mjs`：排障小工具（导航到页面 → 打印渲染结果/页面内错误），"页面是不是坏了"先用它看。
  - `wysiwyg.mjs`：所见即所得的 **62 项验收**（输入公式 → widget 出现 → 光标进入展开 → 移出恢复 → 视图菜单开关 → 标记隐藏/标题字号/字重/圆点替换 → 光标进标题露标记 → 链接只留文字 → 跨行行间公式块级居中 → 光标进入整行展开 → 文档内 `#let` 确实进了编译上下文（桩把最近一次 `compile_math` 入参记在 `window.__browserDevLastMath`）→ 有序列表编号 → 围栏代码块渲染与光标展开 → 写作模式单栏形态 → 菜单调出预览栏 → 源代码模式自动回双栏 → 仿 Typora 写作界面（write 类、无行号槽、衬线/16px/行高 1.9、纸张限宽、状态栏「写作」无行列）→ Ctrl+B 加粗 / Ctrl+1 标题的插入与字号放大），截图落在 `.browser-check/`（已 gitignore）。
  - **实测坑（都踩过）**：① `Page.navigate` 对**相同 URL** 不重新加载，上一次停在 500 错误页时会一直复现 → `goto()` 先跳 `about:blank`；② 截图必须由 Node 写进**工作区**（写 `/mnt/c/...` 会被文件沙箱拒绝，报 EROFS），别交给 Chrome 写；③ **Windows 的 headless Chrome 必须加 `--no-proxy-server`**，否则 localhost 会被系统代理吞掉、页面报"无法访问此网站"，看起来像"WSL 端口转发坏了"（判断连通性更干净的判据是 Windows 自带 `curl.exe`：`/mnt/c/Windows/System32/curl.exe -s -o NUL -w '%{http_code}' http://localhost:1420/`）；④ 验收脚本开始前**必须清 localStorage 再重新加载**，否则上一轮遗留的「源代码模式」会让页面不渲染公式，第一条断言莫名超时；⑤ 找菜单项要限定在 `.menu-dropdown .menu-item` 里，别在全页找同名文字（状态栏会显示"源代码模式"这类同名状态文字）。
  - `wysiwyg-visual.mjs`：**真实排版的视觉验证**。先用 `npm run fixtures:math`（Rust 侧 `dump_math_fixtures`，`#[ignore]` 的按需测试）把真实 `compile_math` 产物导出到 `.browser-check/math-fixtures.json`（**两种字号各一份**：12pt 写作模式 / 10.5pt 源码模式，桩按 body+display+**sizePt** 匹配，字号对不上宁可退回假 SVG），再用 `Page.addScriptToEvaluateOnNewDocument` 注入页面；桩的 `compile_math` 命中夹具时返回**真实产物**。实测四件只有浏览器/桌面端才看得出来、单测覆盖不到的事：行内公式基线与同行文字基线齐平（零宽 inline-block 探针量基线，误差 < 1px）、渲染尺寸 = 真实 pt × 4/3、块级公式居中且独占整行、暗色主题反色后可见（12 项检查）。**坑**：夹具 json 里没有 `ok` 字段，桩返回时必须补 `{ ok: true, ...fixture }`，否则前端按"渲染失败"处理，页面里公式一直停在源码（实测踩过）。
  - 浏览器开发模式（`?browserdev=1`，见 `src/lib/browser-dev-stub.ts`）里的 `compile_doc` 是假实现（假分页 SVG），`compile_math` 在没有注入夹具时也是假 SVG；文件/PDF 等 Tauri 命令同样是假的。**真实 typst 排版可用夹具链路上浏览器验证**，只有 Tauri IPC / WebView2 那一层必须桌面端（Windows）确认。
