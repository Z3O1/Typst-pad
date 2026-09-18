# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Typst-pad = 仿 Typora 的 Typst 桌面编辑器，两套 UI：「写作模式」（默认，单栏整页纸张，公式/标记就地排版，光标进入即展开源码）与「源代码模式」（`Ctrl+E`，双栏：等宽编辑器 + 整页预览）。前端 SvelteKit SPA（adapter-static），壳 Tauri 2（Rust），**内嵌 typst crate**（0.15.x，进程内编译，本地字体），无 wasm、无网络依赖（`@preview` 按需下载）。注释与 README 中文。

**本文档是规则版**；规则的实测数据、踩坑经过与长论证见 `docs/实现细则/`（索引：`docs/实现细则/README.md`）。

## 当前状态

- 版本 **0.9.0**；版本历史看 `CHANGELOG.md`，提交历史看 `git log`，踩坑经过看 `docs/实现细则/`。
- **仓库必须保持公开**（否则客户端检查更新全失败）；自动更新只覆盖 Windows。

## 常用命令

```bash
npm run tauri dev    # 桌面应用（Vite 固定 1420；WSL 可跑，libEGL 警告正常）
npm run check        # svelte-check（0 errors / 1 warning，遗留 previewHost）
npm test             # 单测（38 文件 / 707 项）；npm test -- <文件> 跑单个
cargo test|check --manifest-path src-tauri/Cargo.toml   # Rust（60 passed / 6 ignored）
node scripts/check-fonts.mjs
# 打包（缺签名私钥直接失败）
TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/typst-pad.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=… npm run tauri build

# 浏览器验收：换端口，别跟 tauri dev 抢 1420
npm run dev -- --port 1425
BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg.mjs         # 290 项
npm run fixtures:math && BROWSER_CHECK_PORT=1425 node scripts/browser-check/wysiwyg-visual.mjs  # 20 项
BROWSER_CHECK_PORT=1425 node scripts/browser-check/probe.mjs           # 排障
CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks.mjs        # 133 项（桩）
npm run fixtures:blocks
CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks-visual.mjs # 76 项
CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-blocks-hit.mjs    # 27 项 / 136 次点击
CDP_PORT=9335 BROWSER_CHECK_PORT=1425 node scripts/browser-check/writing-mode-scenes.mjs   # 64 项 / 9 篇

node scripts/generate-latest-json.mjs --tag v0.9.0 --out latest.json
node scripts/verify-release.mjs 0.9.0
```

## 改动前的红线（勿回退）

1. 改 `src/` = HMR 到运行中的 `tauri dev`；改 `src-tauri/` = Tauri 重启应用。
2. `editorDoc` 必须是编辑器内容的**实时镜像**（否则丢未保存内容）。
3. `Decoration.*.range(a, b)` 必须 `b > a`；装饰计算与 widget 渲染留在 try/catch 内（抛进 CM 事务 = 编辑区卡死）。
4. 写作模式留白挂 `.cm-scroller`，不是 `.cm-content` 的 padding。
5. 菜单（Alt / 鼠标）不许夺编辑区焦点。
6. `src-tauri/fonts/` 不放 `static/`。
7. `vite.config.js` 的 dev 白屏修复三件套与 `optimizeDeps.exclude: ["codemirror-lang-typst"]` 不许删；前端已无 wasm（高亮走 `codemirror-lang-typst/lezer`），那两个 wasm 插件暂无服务对象，要删先在 WSL/WebKit 验启动。
8. 版本号三处一致（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml`）；rust-cache 禁 `cache-on-failure`。
9. **绝不阻塞等 workflow**：推 main / 打 tag / 后续命令一律不等 CI、Release；不挂轮询任务；状态最多**单查**一次 `gh run list`；`job_output(wait:true)`、`gh run watch` 同样算阻塞。不要加"别在 CI 运行中 push main"这类限制（cancel 的缓存代价可接受）；一次性延时动作可以（挂后台 job）。
10. 签名密钥不许动：Secrets 删了就构建不了、换了就再也发不出更新（老用户只认旧私钥签的包）。
11. 发版权在用户手里：改版本号 / CHANGELOG 版本段 / 打 tag / 建发 Release，只在他说"发 X.Y.Z"之后做。

## 已知未决 / 可做

- `?browserdev=1` 是假编译（真实排版走 fixtures）；真保存 / 导出 PDF / 系统对话框必须桌面版。
- 「启动时恢复上次内容」默认开。
- 自动更新只覆盖 Windows（上其它平台要补构建 job + `relaunch()`）。
- 点过「稍后」后所有新版本都不再自动弹窗（要"按版本"得比 `skippedVersion`）。
- 写作模式：脚注不显示、表格整块、无每字形文字层、真机手感未验。

## 和这位用户协作的偏好

- 他自己跑桌面版，反馈是一句话/截图；**先复现再改**，复现不出就加兜底 + 让错误在状态栏可见。
- 不等慢测试：日常 `check` + 相关单测；`browser-check` 只在动编辑器/装饰/布局时跑。
- 发版两步：要不要发、发哪个号由他说；说了就"草稿一建好直接 Publish，不用再问"。
- 不可逆 / 改仓库设置的动作先问；既有约定覆盖的机械动作直接做。
- 清理现场只动自己创建的对象（别全量 taskkill）；推送被规则拦住先问"放宽还是走 PR"。
- 产品：仿 Typora（**无工具条**）、不许夺焦、界面无多余色块与凸出。

## 文档地图

架构（模块清单）｜编译数据流（诊断 / PDF / 项目根）｜写作模式的块级渲染（+`docs/文档模式渲染保真-调研.md`）｜所见即所得（+`docs/WYSIWYG-调研.md`）｜多窗口与按键路由｜自动更新 + CI / 发布约定｜字体｜文件与路径安全｜测试｜代码审查（只在 PR 时）｜环境备忘。**长论证与实测数据**：`docs/实现细则/`（6 个分册 + `README.md` 索引）。

## 架构

```
src/routes/+page.svelte     # 唯一页面：状态与调度中枢（菜单/文件/编译/持久化/快捷键/缩放/更新）
src/routes/+layout.ts       # SPA（ssr=false）+ adapter-static fallback
src/lib/Editor.svelte       # CodeMirror 6：受控 doc、主题、波浪线、所见即所得接线、写作模式样式
src/lib/editor-keymap.ts    # CM 键位：回车继承缩进、空 `$` 配对整对退格、注释
src/lib/typst-lex.ts        # 区域扫描 markup/code/raw/comment/string（纯函数）
src/lib/math-ranges.ts      # 公式范围 + 缓存键 + 选区判定（纯函数）
src/lib/math-context.ts     # 公式上下文：前缀 + 文档内单行顶层 #let（纯函数）
src/lib/markup-ranges.ts    # 标记拆解：标题/粗斜体/行内代码/围栏/列表/链接（纯函数）
src/lib/live-preview.ts     # CM6 扩展：块切片 + 公式 widget + 标记 + 选区/拖动/翻页/竖直移动
src/lib/typst-highlight.ts  # 压掉默认高亮给标题加的下划线
src/lib/typst-engine.ts     # invoke：compile_doc / compile_blocks / block_hit_test / compile_math / export_pdf
src/lib/file-ops.ts         # dialog + invoke 封装（isTauri() 门控）
src/lib/persistence.ts      # localStorage（typst-pad:state）
src/lib/MenuBar.svelte / ContextMenu.svelte / menu-keys.ts / context-menu-utils.ts / popover-utils.ts  # 菜单、右键菜单、按键匹配、位置收边
src/lib/pdf-export.ts / svg-paginate.ts           # PDF 文件名推导 / 页间分隔线
src/lib/diagnostics-utils.ts / error-list.ts      # 位置映射 + 波浪线 / 错误警告列表 + 复制文本
src/lib/doc-utils.ts / startup-timing.ts          # isEffectiveDirty / ensureTrailingNewline；[startup] 打点
src/lib/write-commands.ts   # 格式命令纯逻辑：planForCommand → EditPlan
src/lib/preview-scale.ts    # 预览缩放：栏宽重排 + 等比回退（画布 ≤ 栏宽）
src/lib/zoom.ts / word-wrap.ts                    # 界面缩放纯逻辑 / Alt+Z 折行判定
src/lib/app-keys.ts         # 页面级按键路由（顺序敏感）
src/lib/auto-pair.ts / auto-indent.ts             # `$` 配对 / INDENT_UNIT + 回车继承缩进
src/lib/updater.ts / update-utils.ts / update-notes.ts  # 更新包装层 / 纯逻辑 / 说明渲染
src/lib/editor-font.ts / font-settings.ts / font-warnings.ts  # 打包字体 / 字体设置 / 字体警告文案
src/lib/failure-text.ts / clipboard.ts            # 失败原因提取 / 写剪贴板
src/lib/block-offsets.ts / block-plan.ts / block-hit.ts / scroll-anchor.ts  # 字节↔位置 / 块规划 / 点击坐标 / 滚动锚定
src/lib/debug.ts / browser-dev-stub.ts            # dbg 日志 / 浏览器开发桩
src-tauri/src/lib.rs        # Rust 壳：文件读写 / list_dir_typ / take_pending_files / 编译命令 / bundled_font
src-tauri/src/block_geometry/  # 块级渲染：blocks 源块划分 / collect 字形遍历 / crops 切带+切片 SVG / render 矩形工具 / hit 命中 / probe 探针
src-tauri/src/packages.rs   # @local 读取 / @preview 下载缓存
src-tauri/src/typst_world/   # 内嵌编译世界：world / fonts / compile / math / pdf / diagnostics / paths
src-tauri/src/main.rs       # 桌面入口
src-tauri/fonts/            # 打包字体（**不放 static/**）
```

配置与辅助目录：

- `vite.config.js`：白屏三件套（勿动）+ `bundledFontsDev`（仅 dev，把 `src-tauri/fonts/` 借 `/__bundled-fonts/*` 给验收，白名单挡穿越）+ `server.port 1420` + `strictPort`。
- `vitest.config.ts`：jsdom + `include` src/scripts + `fs.allow: [".."]`（scripts 不进 TS program）。
- `svelte.config.js`：adapter-static（SPA）。
- `src-tauri/app-icon.svg` 改后 `npm run tauri icon …`，**删掉产出的 `android/`、`ios/`**；图标嵌进 exe，装了要重装才看得到。
- `.github/workflows/`：`ci.yml` / `release.yml`。
- `scripts/`：`check-fonts` / `download-fonts` / `verify-release` / `generate-latest-json` / `browser-check/`；`capabilities.test.mjs`（插件命令 ↔ capability 权限）、`editor-fonts.test.mjs`（字体四方对齐）。
- `docs/`：三份调研 + `实现细则/`（6 个分册 + `README.md` 索引）；`CHANGELOG.md`；`.browser-check/` 已 gitignore。

### 编译数据流

- 内容变化 → `runCompile`（`ensureTrailingNewline(prefixCode) + doc`）→ 写作模式 `compile_blocks`、源码模式 `compile_doc`（`documentPath` null = 未保存）→ Rust `spawn_blocking` + `CompileState` 互斥锁 → `CompileOutput{ok,pages,diagnostics,warnings}`；`compileSeq` 丢弃过期结果，失败保留上次预览 + 红波浪线，IPC 异常也收敛成错误结果。
- PDF：`pdf-export.ts` 推文件名 → 另存为 → `export_pdf` → Rust 编译落盘（`validate_write_path`）。
- 诊断 `{message, severity, line, column, endLine, endColumn, path}`（1-based，`end` 独占）；`diagnostics-utils.ts` 做编译源 → 文档位置映射与波浪线。
  - **`path` 主源表示只许一种**（勿回退）：主源不带该键，前端判据 `d.path != null && d.path !== "" && d.path !== mainPath`（判据要容忍 `null`，否则桌面版波浪线全丢）。桩发 `path: null`，验收第 42 组锁死。
  - **项目根跟着引用放宽**（`resolve_project_root` + `collect_required_roots`）：根 = 所有引用（递归去重）所需最低根的公共祖先，**别写成"目标文件的公共祖先"**；跳过 `@` 包 / `/` 开头 / 绝对路径；目标不存在按词法放宽（报 `file not found`）；跨卷跨盘是硬限制。单测 `project_root_widening_rules`。
  - 未保存文档预检 `#import`/`#include`，给"需要先保存"诊断。
  - `previewWidthPt` 传给 `compile_doc`（Rust 注入 `#set page(...)`），栏宽变就重编译；注入行不让诊断行号漂移。

### 写作模式的块级渲染

非光标块 = 引擎切片，光标块 = 源码；没有每字形文字层。调研见 `docs/文档模式渲染保真-调研.md`，交接见 `docs/写作模式块级渲染-现状与交接.md`。

- 写作模式走 `compile_blocks`（整篇编译一次 → 每块一张 SVG），源码模式走 `compile_doc`；后端没有该命令返回 `unavailable` 并退回原路径。
- 装饰同在一个 StateField（切片 + 公式 + 标记）：**CM 不允许重叠 replace 装饰**，被切片盖住的要跳过（`insideCovered`）；块区间首尾相接铺满全文（`planBlockCovers`）。
- **窗口化**：逐块 SVG 约 58 字节/源字符 ⇒ 只渲视口 ±4000 字符（短文档 ≤8000 全渲），窗口外按"类型 + 源码相同"沿用（`carryOverCrops`），滚到未渲区先显示源码、去抖 150ms 重编译。**别改回全渲。** 缺切片只看块表 `found && svg === ""`（不能看 `buildBlockCovers` 的 `revealed`）；`lastBlocksWindow` 防重复编译。
- **编辑期间块表必须跟着走**：每次编辑跑 `remapBlocksThroughEdit`（前后缀差分）+ `blocksVersion++`；别退回"编译失败时才平移"。`planBlockCovers` 容忍越界、**绝不抛异常**。
- **源码透镜跟随文档**：Rust `document_text_pt`（字符数众数）→ `textPt` → `--write-doc-px`（pt×4/3）；写作模式 `.cm-editor` 用该字号、`.cm-content` 行高 1.65；缺省 14.6667px，**别写死**。字用与 typst 同一套打包字体（`bundled_font` → FontFace）。验收：`writing-mode-scenes` 四条 + `writing-blocks` 第 17 组 + `editor-font.test.ts` + `editor-fonts.test.mjs`。
- **公式字号 = 正文字号**：写作模式给 `textPt`（`mathSizePt`），源码模式 `MATH_TEXT_PT = 10.5`。验收第 18 组。
- 切换文档（打开/新建/重读）必须 `resetBlocks()`。暗色：切片整体 `invert(1)`。
- 块切片 `Decoration.replace({block:true})` **必须落在整行边界**（否则 Chromium 既插 widget 又留原文，jsdom 抓不到）。
- **块间空行归「上一块」的格子**（每格 = 自己首行 → 下一块首行），别改回"归下一块"；`remapBlocksThroughEdit` 的"空行上打字"落点跟着改。验收第 16 组。
- **分块判据跟 typst 语义**：`$x$` 行内（独占整行也不断段）、`$ x $` 行间；行内 raw vs 围栏同理。测试 `block_partition_matches_typst_semantics`。
- **块纵向区间夹紧到下一块 top**；带高退化留最小带、不丢块。
- **竖直移动 = 代码模式语义**（`crossesCollapsedCover` + `sourceVerticalTarget`）：没跨过未展开切片 → 交回 CM；跨过 → 按源码行走一行（空行停一拍、列保留、落点展开）；Shift+↑/↓ 一并接管；**别退回"一次跨一整块"**。验收第 8 组。
- **翻页自己实现**：位移 `clientHeight - 5`，把光标屏幕高度平移一屏取位置，再用滚动目标钉回原高度；不按滚动余量夹。验收第 10 组。
- **打字期间不编译**：写作模式去抖 150ms（`WRITE_COMPILE_DEBOUNCE_MS`），有公式时把块编译再推后 240ms（`MATH_COMPILE_HEADSTART_MS`）；`writeCompileTimer` 用完置回 `undefined`。
- **`compile_blocks` 的 `blocks` 键永远要发**（失败时 `[]`）：前端靠它区分"后端没实现"与"这次失败"；桩故意不发来锁路径；单测 `failure_output_always_carries_blocks_key`。
- 结果回来要确认**请求时那份文档 == 当前文档**（去抖期间 `compileSeq` 不增）。合成期间不重建装饰（`view.composing` 守卫，`compositionend` 补刷）。光标所在公式不请求渲染。
- **点击定位**：`block-hit.ts` → `block_hit_test`（`pick_hit`，几何来自 `HIT_CACHE`）→ 字节 → CM 位置；失败退回块首、绝不吞点击。三道闸门：块表与文档一致、`writingBlocksExact`、`geometryId` 对得上（进程级 `HIT_CACHE` 必须带几何编号，否则多窗口点错字）。
- **滚动锚定**用 `EditorView.scrollIntoView(pos, {y:"start", yMargin})` 放同一事务（`scroll-anchor.ts`），**别自己写 scrollTop**。
- 编译失败不整篇作废（相交块退回源码、区间放宽、输出仍铺满全文）；诊断所在块不被切片盖住（`revealBlocksWithDiagnostics` 在 `applyBlockSelection` 之后）。
- 鼠标行为统一由 `mouseSelectionStyle` / `CropSelection` 接管：别在 widget 上挂 `mousedown`；判在不在切片用 `Element.closest(".cm-block-crop")`；拖动期间冻结版式（松手才交真选区）；单击不听松手；Shift 点击/拖选 = 扩选，`MouseSelectionStyle.get()` 必须返回 EditorSelection。验收第 20 组。
- 整块选中不展开（`cover.selected` 淡色底）：**光标所在那块必须展开**（否则 Ctrl+A 后打不进字）；代码块整块选中时藏两行围栏；非空选区不做兜底展开；染色层 `.cm-block-crop-tint` 排在 SVG 之后、不要 outline。验收第 15 组。
- 链接：Rust 把 `FrameItem::Link` 收成带内相对 pt 热区，前端铺透明 `<a>`，只收 `http/https/mailto`（前端另有白名单）；**热区 `mousedown` 必须 `preventDefault`**，验收判据是"焦点就在 `.cm-content` 上"。
- 列表每项一块；表格整块（有意）。切片 DOM 的 `data-block-from` / `data-block-kind` 别删。没有输出的块整格隐藏，但 remap 要把不可渲染块的 `noOutput` 清成 false。
- 验收别删：第 12 组（`&blockslow=1` 假延迟：一行不丢、不重复、控制台干净）、第 13 组（12 个输入动作）、第 14 组（拖选跨块 + Ctrl+C + 拖选后打字替换）、`block-plan-edits.test.ts`（68 项）。

### 所见即所得（编辑器内联渲染）

源码是唯一真相，非选区处换成渲染结果，光标/选区进入即展开。

- 范围识别：`typst-lex.ts` 切 markup/code/raw/comment/string，再在 markup 里认公式（`math-ranges.ts`）与标记（`markup-ranges.ts`）。**宁可漏渲染，不可误渲染。**
- 公式：视口内未缓存 → `onRequest` → 去重 + 120ms 防抖 → `compile_math {body, display, context, documentPath}` → `mathCache`（键含风格/前缀/文本/字号）→ `refreshLivePreview`。
- `MathOutput{ok, svg, widthPt, heightPt, baselinePt, error}`：贴边透明单页 SVG，单位 pt；基线用两页探针（`#box(...)` 不可省）。
- **画布按墨迹裁**：`ink_bounds_of_frame`（文本用字形包围盒 `edges`），溢出才用"显式页尺寸 + `#pad(top:)`"重编；代码模式参数写 `#pad(top: …)[#box(...)]`。验收 `wysiwyg-visual` 第 4 组。
- `MATH_TEXT_PT = 10.5`（源码模式 14px），SVG pt 与 CSS pt 1:1；写作模式跟随文档。
- 暗色：`cm-math-dark` + `invert(1)`；**不要用 `&dark` 选择器**（会整页 500）。
- 展开：`selectionTouchesRange`；标记类展开范围 = **标记 + 正文并集**。
- **标题字号梯度 = typst：1.4 / 1.2 / 1.0em、行高 1.65**（3 级及以下只加粗），标题行不加 padding。验收 `writing-mode-scenes` 对应四条。
- **选中整个公式不展开**（完整盖住 → 保持渲染 + `.cm-math-selected`）；**别套到跨行行间公式**（会把字符插到下一行）；单行行间公式用行内 widget + 行级居中；判据是"装饰实际盖住的区间"（`decorated = block ?? 公式区间`），两处必须同判据。
- **`$` 自动配对**：独占一行 → `$  $`；行内 → `$$`；**右侧已有 `$` 就跨过去，且必须排在"公式内部不配对"之前**；五类上下文不配对（代码/raw/注释/字符串、代码区右边界、公式内部、前有反斜杠、越界）；退格整对删（返回"两侧各删几个"）。
- 块级 widget：独占整行的行间公式整行替换、围栏代码块整段替换；**只能由 StateField 提供**（ViewPlugin 抛错）。
- 公式上下文 = 前缀 + 文档内单行顶层 `#let`（多行 / 含 `[...]` / `=` 后无值跳过），同名取最后；出错退回"仅前缀"重试。
- 性能热点勿回退：`scanNonMarkupRegions` 记忆化、`overlapsSorted` 二分、上下文在扩展内算。
- **两套 UI**：`viewMode: "write" | "source"`（旧 `livePreview` 自动迁移）。
  - 写作模式：灰底居中纸张、衬线打包字体、字号/行高跟随文档、隐藏行号槽与当前行高亮、状态栏「写作」；**始终折行**（`Alt+Z` 只提示）。
    - 回车继承缩进（`newlineKeepingIndent` / `auto-indent.ts`）；**一档 4 空格**（`INDENT_UNIT`；回车照抄上一行实际空白）。验收第 36 组。
    - 字体写在 `.cm-content` 上；标题下划线用 `typst-highlight.ts` 的 `none !important` 压掉；暗色必须挂 oneDark（否则公式白底白字消失）。
  - 源代码模式：等宽 14px + 行号 + oneDark；`Ctrl+/` = 注释、`Ctrl+E` = 切模式（验收第 20 组）；行注释已在包里声明、不用自己补；`Alt+Z` 折行走 `wrapCompartment`（排除 Ctrl/Meta、排在 `if (!mod) return` 前、随存档持久化）。
  - 界面缩放（`Ctrl+滚轮` / `Ctrl+Shift+=`·`-`，50%~250%，10%/格）：走 webview `setZoom`（**别用 CSS zoom**）；监听 window 捕获 + `passive:false`；命中 `preventDefault`；读 `deltaY`/`deltaX`。
    - **`setZoom` 只在用户操作时调，`observeZoomEffect` 只观察不改状态**（**别让观察结果去改档位或回改引擎**）。
    - 滚轮余量跨事件攒（`accumulateWheelSteps`），不足一档只提示「攒到 N%」。验收第 40 组。
    - **预览永不横滚**：无自带纸张 → 注入 `#set page(width:)` 按栏宽重排（pt = 栏宽 px × 11/14，夹 180pt~A4，栏宽变去抖 250ms 重编译）；自带纸张 → 等比缩放，画布 `min(缩放前栏宽, 当前栏宽, 自然尺寸)`。验收第 30 / 41 组。
    - 判据用 CSS 布局宽度（dpr 只交叉验证）；复核 fail-open；缩放自己引发的 resize 不重校基准；"未生效"文案带实测数据。缩放持久化，启动 / 切模式 / 回前台再设一遍；非 100% 有徽标。
  - 状态栏：**最左错误/警告计数，错误在左**（参照图 `⊗ 0 ⚠ 0`）、常驻；图标内联 SVG。
    - 两个徽标共用 `openBadgePopover`，行为只写一遍（Esc / 点外部 / 点条目即关 / 视口收边）。验收第 43 组。
    - 诊断可复制：`<路径>: 行 N, 列 M：<消息>`（格式化在 `error-list.ts`，剪贴板 `clipboard.ts`）；浮层要 `user-select: text`；一条诊断 = row 里两个兄弟按钮。验收第 44 组。
    - Popover 锚点 `left: 0`；状态栏 nowrap，`.status-text` 省略、其余 `:not(.spacer):not(.status-text)`（**两个 `:not()` 都不能漏**）。验收第 28 / 32 组。
    - `ResizeObserver loop` 走 `BENIGN_SCRIPT_ERRORS` 过滤。
- 受控契约：`doc` 与 `editorDoc` 实时镜像（`handleDocChange` 一起写），**绝不能让 `editorDoc` 落后**；打开/重读只要有未保存修改就确认（同路径也一样）。
- 菜单不夺焦（别把 `el.blur()` 加回去）。**所有弹出面板固定白底黑字**：色值只有 `--panel-*` 一份、在面板根重绑并写 `color: var(--panel-fg)`、别改回 `var(--bg-toolbar)`/`var(--fg)`；浮层条目浅灰。验收第 45 / 16 组。
- 渲染失败 / 未就绪 → 不挂 widget，保持源码。空正文不能建 mark 装饰（`content.to > content.from`）。
- 装饰异常不许冒泡进 CM 事务（`collect()` 与 `toDOM` 都 try/catch）。脚本错误上报状态栏（`window.onerror` / `unhandledrejection`）。
- 持久化：`viewMode` / `showPreview` / `editorWrap` / 主题 / `uiZoom`；多窗口下会话字段只有主窗口能改（副窗口 `{ session: false }`）。

### 多窗口与页面级按键路由

- `decideAppKey`（`app-keys.ts`）+ `topModal`，**顺序敏感**：① Esc（`MODAL_PRIORITY`）② Alt+Z（在 `mod` 门之前）③ **Ctrl+Shift+N 新建窗口（在 Shift 格式表之前）** ④ Ctrl+Shift+键 = 格式命令 ⑤ Ctrl+R / Ctrl+W。Esc 语义：未保存确认 = 取消、**更新弹窗只收起来（绝不写 `updateDismissedAt`）**、设置 = 放弃草稿。
- 新建窗口 `WebviewWindow("editor-<时间戳>", …)`，失败报状态栏；**ACL 两处都要**：`windows: ["main","editor-*"]` + 显式 `core:webview:allow-create-webview-window`（`capabilities.test.mjs` 兜底）。
- 副窗口 = 空白草稿：不恢复上次内容、写存档 `{session:false}`（否则会把主窗口未保存内容换成空文档）、新建不清存档、**启动自动检查更新只由主窗口做**。
- `open-file` 广播由有焦点的窗口接，都没焦点时主窗口延迟 250ms 兜底；启动队列只由主窗口取。浏览器第 35 组只锁接线。

### 自动更新（tauri-plugin-updater）

启动延迟 4 秒检查（**没有任何节流**），状态栏提示 + 弹窗，确认才下载；菜单可手动检查；设置可关。

- `plugins.updater`（endpoints + pubkey + `installMode: passive`）；`latest.json` 由脚本生成（NSIS 优先，notes 取 CHANGELOG）；客户端读 `releases/latest/download/latest.json` ⇒ **草稿不算**；签名不符拒绝安装。
- `updateFlow` 七态放一个对象里；换版本前 `closeUpdate()` 释放句柄。手动检查失败写状态栏，**自动检查失败保持安静**。
- **不许再加"上次检查时间"式节流**；**点过「稍后」= 只更新状态栏、不再弹窗，直到手动检查**（`updateDismissedAt`，**别退回时间窗口版**）；清标记 = 菜单检查 / 状态栏入口 / 点「下载并安装」。验收第 34 组。
- Windows 安装成功会退出应用。更新说明由 `update-notes.ts` 渲染成安全 HTML（**别退回 `<pre>`**），上限 8KB。桩默认"无更新"，`&fakeupdate=1` 供验收。

### 启动耗时观测

`startup-timing.ts` 首次编译后输出 `[startup]` 报告；Rust（**仅 debug**）打 `[startup] rust phase:*`，两侧同前缀便于对比回归。

### 原生编译后端（typst_world/）

- `CompileState` 互斥锁 + `spawn_blocking`，一次编译一个。
- `load_fonts` 全量加载（含 `.ttc/.otc` 每个 face）；`resolve_fonts_dir` 优先 `resource_dir/fonts`，退回 `src-tauri/fonts`。
- 契约：`compile_doc → CompileOutput`；`compile_blocks → {ok, blocks, textPt, geometryId}`（失败也带 `blocks`）；`compile_math → MathOutput`；`export_pdf → PdfResult`；`Err` 只用于任务异常终止。
- **前端已无 wasm**；vite 里保留的 wasm 插件 + `syncWasmInit` 暂无服务对象（红线 7）。WSLg 白屏 = WebKitGTK 对顶层 await 的 TDZ；修复三件套只影响 dev，`optimizeDeps.exclude` 不可删。WebKit 日志可用 `write_file` 桥出（需 `.typ` 后缀）；GL 不可用加 `GDK_BACKEND=x11 GDK_GL=disable WEBKIT_DISABLE_DMABUF_RENDERER=1`。

### 字体

typst 用 Rust `FontBook`（字形轮廓）；界面用 CSS 栈，写作模式已装打包字体（`bundled_font` → FontFace）。

- 打包字体 7 个在 `src-tauri/fonts/`（**不放 `static/`**）；新增要同步 `download-fonts.mjs`、`fonts_all_registered`、README。
- 字体集 = 打包 + 系统 + 用户额外目录；缓存**按目录列表**做 key（别用 `OnceLock` 单值）。
- **`.ttc/.otc` 逐 face 注册**（Windows 的 SimSun / YaHei / 正黑 / 细明体都是集合）；测试 `font_collection_registers_every_face`。系统目录含 `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 与 `~/.fonts`。
- 与 `typst fonts` 有差异正常（CLI 列本地化族名）；判断少不少字体看**英文族名**。
- **必须注入默认字体族**（`build_library`）：`Libertinus Serif → 打包思源宋体 → 系统宋体 → 雅黑`；文档 `#set text(font:)` 仍优先。
- 设置选项来自 `list_font_families`；`buildFontFamilies` 拉丁基准最前；**族名写错 = 静默回退**，所以 warnings 必须显示（`font-warnings.ts`）。
- 正文/公式/PDF 共用 `build_library`；`saveSettings()` 要 `resetMathCache()` + 立即重编译。

### 文件操作与路径安全（lib.rs）

- `isTauri()`：浏览器只显示"请使用桌面应用版本"。
- `validate_typ_path`（绝对路径、`.typ`、拒 `..`）；`read_file` canonicalize 复检；`write_file` 拒符号链接；`write_binary` / `export_pdf` 走 `validate_write_path`；`list_dir_typ` 深度 ≤8、≤500、跳隐藏、符号链接目录不递归。
- 无 single-instance；打开文件走 `PendingFiles` + `emit("open-file")`，前端**先注册监听再取队列**。
- **写盘只有一条路**（`handleSave` → `saveTypFile` → `write_file`，只在三处显式保存）；**没有自动保存、没有定时写盘**。能拿走内容的只有 ① `Ctrl+N` 新建（先 `confirmDiscard`）② "空文档存进已有文件"——**不弹确认窗、直接写空（勿加回）**。启动恢复安全阀 `content.trim() !== ""` 仍在；验收第 38 组锁"编辑全程 write_file 0 次"。`fs::write` 是截断写（非原子），暂未改。
- `capabilities/default.json` 的 windows = `["main","editor-*"]`，权限含窗口 / opener / dialog / updater / webview zoom；**新增功能要同步**。

### 安全模型 / 持久化与版本

- `csp` 保持 `null`；改它必须在打包后实机测。
- `persistence.ts` 300ms 防抖；启动按设置恢复正文，新建（Ctrl+N）`clearState()`。
- 版本号三处一致；改依赖会让 Cargo.lock 变化、rust-cache 全量重编，**改版本号本身不影响缓存 key**；Cargo.lock version 需合法三段式 semver。「关于」用 `getVersion()` 运行时读。

## 环境备忘（本机 WSL）

- push 22 端口被掐走 443：`GIT_SSH_COMMAND="ssh -p 443 -o StrictHostKeyChecking=accept-new" git push git@ssh.github.com:Z3O1/Typst-pad.git HEAD:main`（`accept-new` 不可省）；fetch 同理显式 443 URL + tracking ref。
- 1420 = Vite，9333 = CDP；查占用 `ss -ltnp | grep :1420` / Windows `netstat.exe -ano | findstr :1420`。无显示器验收走 `browser-check`；`gh` 用 Windows 版（`--repo Z3O1/Typst-pad`）。
- headless Chromium 用 Windows Chrome（镜像网络下 WSL 才能连 9333）或 WSL 里 Playwright 的 `chromium_headless_shell-*`；**用托管后台任务起**，收尾按记下的 job/端口关。

## CI / 发布约定

- `ci.yml`：test + build-bundles（仅 main push / dispatch），缓存 `shared-key: tauri-build-windows`（**与 `release.yml` 相同**）；`release.yml`：`v*` tag → 草稿 Release。
- 签名密钥在 Secrets，本机两份备份（`.updater-keys/`、`~/.tauri/`）；**缺私钥所有 build 直接失败**（Secrets 缺失时 main CI 红，别当缓存问题查）。
- **缓存纪律**：禁 `cache-on-failure`；不要加"run 运行中不要 push main"这类限制；损坏 = `gh cache delete` → workflow_dispatch → 等自然完成 → 再验一次。健康 ~3 分钟（2 Compiling），全量 ~16 分钟；Rust 工具链版本变化会一次性全量重编。
- action：`checkout@v5`、`setup-node@v5`、`cache@v5`、`upload-artifact@v6`、`softprops/action-gh-release@v3`。
- 仓库保持公开；ruleset 只留 `deletion` + `non_fast_forward`（可直推 main）；万一要 PR 先问用户放宽，或 `gh pr merge --squash --delete-branch`，**别 force push / 改 remote**。
- 发版：用户指令 → 改三处版本号 → 合 main → tag → **草稿一建好直接 Publish**；等构建挂后台一次性任务（不轮询）。探草稿用 `gh release view <tag> --json isDraft,assets` 或 `releases?per_page=1`（**`releases/tags/<tag>` 对草稿 404**），只在 `.draft == true` 时发；Publish 前资产齐（latest.json + exe + exe.sig）；CDN 要 1~2 分钟才切。

## 测试

- vitest + jsdom（src + scripts）；这几处**不要补测试**（低价值）：`file-ops`、`debug`、`computeMenuPosition` 收边。
- `HIT_CACHE` 是进程级全局，并行用例要 `HIT_CACHE_TEST_LOCK`；`fixtures:blocks` 要 `PATH="$HOME/.cargo/bin:$PATH"`（否则空夹具）。
- Rust 覆盖：端到端编译、字体注册、诊断契约、include / 项目根、包系统、块级渲染。前端覆盖：`typst-engine`、`diagnostics-utils`、`error-list`、`editor-keymap`、`menu-keys`、`popover-utils`、`zoom`、`update-*`、`block-plan*`、`live-preview`、`typst-scan-fuzz`。**坑**：jsdom 下光标默认在 offset 0 会触发展开。
- 浏览器验收：`wysiwyg.mjs` 290（所见即所得 + 第 16~45 组）｜`writing-blocks.mjs` 133（`&blocks=1`；桩默认返回"没有这个命令"）｜`writing-blocks-visual.mjs` 76（切片几何等价 + 链接热区，**改块级渲染必跑**）｜`writing-blocks-hit.mjs` 27 / 136 次（精确字符）｜`writing-mode-scenes.mjs` 64 / 9 篇（场景截图）｜`wysiwyg-visual.mjs` 20（三档字号真实产物；夹具 json 没 `ok`，桩要补）。
- 真实文档体检：文档存 `.browser-check/real-scene.typ` + `cargo test … dump_real_doc_fixture -- --ignored --nocapture`。
- 验收坑：`goto()` 先跳 `about:blank`；截图写工作区；Windows Chrome 加 `--no-proxy-server`；开始前清 localStorage；`gotoSim` 先导航掉旧页再按 origin 清；菜单项限定 `.menu-dropdown .menu-item`。**收尾只按 user-data-dir 杀自己启动的 Chrome**（绝不 `taskkill /IM chrome.exe /F`）。

## 代码审查：只在"处理 PR"时做

- 用：别人交来的分支要合 main；不用：自己直推的日常改动（`check` + 相关单测，动编辑器才加浏览器验收）。
- **两条腿都走**：全套绿的 PR 仍可能带"真机走不到"的 bug（桩按契约写）。腿一 = 3 个只读子代理按风险面切（后端/引擎、前端核心、集成/文档/脚本），prompt 自带六段（git 现场、PR 自述、**红线原文**、5~6 条可判定问题、证据格式 + "每类都说没发现问题"、只读纪律：不改文件、不跑测试）；腿二 = 主 agent 跑全套并把计数与自述逐条对。
- 复核：最高杀伤力自己读代码复核；只出现一次又没复核的降级；报告分清"我验过的"与"只转述的"。
- 结论写进 `gh pr comment`（复跑计数表 + 严重度清单 + 没发现问题的类别）。
- 问题不阻塞合并（除非坏**已发布**功能）；功能线用 merge commit、单笔 squash 无所谓；合并不删分支；修复归属先问；都不碰版本号 / CHANGELOG / tag / Release。
