# Typst-pad

[![CI](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml/badge.svg)](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml)

仿 Typora 的 Typst 桌面编辑器：**写作模式**下是整页纸张的所见即所得编辑（公式就地排版、标记符号自动收起，无行号），**源代码模式**下是等宽代码编辑器 + 右栏整页预览。两种模式用 `Ctrl+/` 或「视图 → 源代码模式」切换。

## 两套界面

| | 写作模式（默认，仿 Typora） | 源代码模式（`Ctrl+/`） |
|---|---|---|
| 布局 | 单栏：灰底 + 居中纸张（≤900px）+ 轻阴影 | 双栏：左源码 / 右整页预览 |
| 正文 | 衬线（思源宋体，与预览/PDF 输出一致）、16px、行距 1.9 | 等宽 14px |
| 行号 | 无 | 有 |
| 内容 | 公式与标记就地排版（所见即所得） | Typst 源码原文 |
| 状态栏 | 「写作」标识 + 字符数 | 「源码」标识 + 字符数 + 行列 |

格式操作走**菜单 + 快捷键**（Typora 没有工具条）：「格式」菜单里有加粗 `Ctrl+B`、斜体 `Ctrl+I`、行内代码、行内公式 `Ctrl+M`、公式块 `Ctrl+Shift+M`、标题 1/2/3 `Ctrl+1/2/3`、正文 `Ctrl+0`、无序/有序列表、引用、代码块、链接 `Ctrl+K`。另外：公式定界符 `$` **自动配对**（见下），代码模式 `Alt+Z` 切换自动换行，**Ctrl+Shift+N** 新建窗口（「文件 → 新建窗口」同一入口）、**Ctrl+W** 关闭当前窗口，**Esc** 关掉当前弹窗（在设置弹窗上按 Esc 等于点「关闭」，即放弃未保存的草稿）。

## 功能

- **所见即所得编辑**（写作模式默认开启，视图菜单可关；需要整页对照时可打开预览栏）：
  - 公式 `$x^2$` 在编辑区**就地渲染**成排版结果（由 Rust 侧 typst 逐公式编译为 SVG，按 pt 尺寸与基线对齐）；独占整行的行间公式 `$ … $`（含跨行书写）整行替换为**居中**排版式子；
  - 光标 / 选区进入公式或标记范围时**自动展开源码**，可直接编辑（Typora 式）；
  - 常用标记同样就地呈现：标题 `= ` 分级放大、`*粗体*`、`_斜体_`、行内 `` `代码` ``、```` ``` ```` 围栏代码块（整段渲染为等宽代码块、围栏自动收起）、无序列表 `- ` → `• `、有序列表 `+ ` → `1. `、链接 `#link("url")[文字]` 只显示文字；
  - 渲染失败或还没渲染好时**保持源码显示**，不出现空占位。
- 左侧 CodeMirror 6 编辑器：Typst 语法高亮、行号、括号匹配、光标行列状态栏
- 右侧实时编译预览：内容变化后立即编译并显示（typst crate 内嵌原生编译），编译错误带行号/波浪线显示
- 中文/数学公式完整支持（本地打包字体，离线可用）
- 打开 / 保存 `.typ` 文件（Tauri 桌面环境）；**Ctrl/Cmd + S** 快速保存
- 导出 PDF（原生"另存为"对话框）
- **自动更新**：启动时静默检查新版本（设置里可关），发现新版本时状态栏提示 + 弹窗确认，点「下载并安装」才下载安装；菜单「帮助 → 检查更新…」可随时手动检查（详见[自动更新](#自动更新)）
- **界面缩放**：**Ctrl+滚轮** 放大/缩小整个界面（编辑区、预览、菜单一起等比放大，50%~250%、一次一格 10%），字太小看不清时往上滚即可；状态栏实时显示当前百分比（非 100% 时右侧常驻一个「缩放 xx%」徽标），设置会被记住；视图菜单还有「放大 / 缩小 / 重置缩放」
- **输入 `$` 自动配对**：敲一个 `$` 就把定界符补成一对、光标落在中间 —— 独占一行时补的是**行间公式脚手架** `$  $`（敲字直接得到 `$ x $`，即 typst 的 display 公式），行内则补成 `$x$`；右侧已经有闭合 `$` 时只把光标移过去（连按两下不会插出多余的一对；而在公式里敲第三个 `$` 也一样 —— `$ 1 $` 敲完就是 `$1$`，不会变成 `$1$$`），代码 / 注释 / 代码块里不配对（公式内部由「补完闭合符」接管），退格在空配对上一次删干净
- **换行与预览排版的取向**：写作模式（文档形态）**始终自动折行**；源代码模式的代码编辑器默认不折行，`Alt+Z`（或视图菜单「自动换行」）切换。**预览的纸张宽度跟着预览栏走、正文按新宽度重新排版**（字号不变，仍与编辑区一致），所以预览栏**永远不会出现横向滚动条**；导出的 PDF 仍按文档自己的纸型排版 —— 代价是**预览的换行与分页不再等于导出的 PDF**（状态栏的「N 页」是重排后的页数）。文档自己写了 `#set page(...)` 时退回等比缩放（那是文档自己选的纸型，可能仍会横向滚动）。
- **回车换行继承上一行的缩进**：在想继续写同一层内容时（列表项、围栏代码块内部、自己排版的缩进段落）回车，新行自动带上一行行首的空格 / 制表符，不用每次重新敲；光标停在行中间回车时拆出来的下半行也照样对齐。空行（只剩缩进的行）上回车会顺手清掉那串残留空白，连按回车不会堆出一串「带缩进的空行」。**Tab 一档缩进 = 4 个空格**（Shift+Tab 反缩进一层），回车照抄的是上一行**实际**的空白，所以已有 2 空格缩进的老文档不会被改动
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
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测（编译/字体/诊断/include，需 src-tauri/fonts）
npm run build        # 前端生产构建
npm run tauri build  # 打包桌面安装程序（需要 Rust）
```

## 测试与 CI

- 前端单元测试（vitest + jsdom）：`npm test`，覆盖引擎调用契约（`typst-engine`）、诊断位置映射（`diagnostics-utils`）、错误列表、文件操作、持久化、SVG 分页、PDF 文件名推导、菜单/快捷键、自动更新的纯逻辑（`update-utils`：启动检查延迟 / 进度换算 / 错误文案）、页面级按键路由（`app-keys`：Esc / Alt+Z / Ctrl+Shift+N / Ctrl+R / Ctrl+W 的判定顺序）、公式定界符配对与退格（`auto-pair`）、回车换行的缩进继承（`auto-indent`）、界面缩放（`zoom`）、预览重排（`preview-scale`）、源码模式换行（`word-wrap`），所见即所得链路（`typst-lex` 区域扫描 / `math-ranges` 公式范围 / `markup-ranges` 标记 / `live-preview` 装饰行为）、字体设置（`font-settings` 把选中的正文字体拼成字体族列表、`font-warnings` 把编译警告翻成可行动提示）；发布脚本的测试在 `scripts/generate-latest-json.test.mjs`（更新清单的生成与校验）
- 浏览器端的交互验证（真实输入 + 真实选区 + 截图取证）：`node scripts/browser-check/wysiwyg.mjs`（231 项），前置为 `npm run dev -- --host 0.0.0.0` 与一个可被 CDP 驱动的 Chrome（详见脚本头部注释）
- 浏览器端的**真实排版视觉验证**：`npm run fixtures:math` 导出 Rust 侧真实公式产物 → `node scripts/browser-check/wysiwyg-visual.mjs`。它把真实产物注入浏览器开发模式页面，实测 ① 行内公式基线与同行文字基线是否齐平（用零宽基线探针量，误差 < 1px）② 渲染尺寸是否等于真实 pt 尺寸 × 4/3 ③ 行间公式块级 widget 是否居中并独占整行 ④ 暗色主题下公式是否可见
- Rust 单测（`typst_world.rs` / `packages.rs` 内）：`cargo test`，覆盖中文+数学文档端到端编译（SVG/PDF）、字体注册、诊断行列转换、相对 include（含未保存文档提示）、@local/@preview 包解析与下载缓存（含 404/网络失败诊断区分、路径穿越防御）、单公式渲染（`compile_math`：贴边 SVG、透明底、基线测量、前缀宏生效、语法错误回退）
- CI（GitHub Actions，`.github/workflows/ci.yml`）：
  - `test`（ubuntu）：push 到 main / PR 时跑 类型检查 → 单测 → 前端构建 → `cargo check`（首次编译 typst 依赖树较慢，之后命中 Rust 缓存）
  - `build-bundles`（windows）：仅 main push 触发，构建 .exe/.msi 安装包并 `upload-artifact`（同时写入缓存供 Release 复用）

## 发布（Release）

**构建与发布分离**：安装包由 CI 构建上传，发布 workflow 只做发布。

1. 修改版本号：`package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的 `version` **三处一致**（0.4.0 起 Cargo.toml 参与发版）
2. 提交推送并合并到 `main` → CI 自动构建安装包并上传 artifact（依赖不变时命中 Rust 缓存，快速）
3. 打 tag 触发发布：`git tag v0.x.y && git push origin v0.x.y`
4. GitHub → Actions → **Release**：下载最新 artifact → 生成草稿 Release（自动上传安装包）
5. Releases 页面编辑草稿 → 发布（**必须 Publish**：草稿的资产不对外，客户端拉不到 `latest.json`，自动更新不会生效）

> 缓存机制：`Swatinem/rust-cache` 的 key 基于 rust 版本 + `Cargo.lock` 哈希。依赖不变（Cargo.lock 不变）时跨版本命中；改动依赖会使缓存失效全量重编（引入 typst 依赖树时已付出过一次）。

## 自动更新

应用启动后**静默检查**一次更新（设置弹窗里可关；菜单「帮助 → 检查更新…」可随时手动检查）。发现新版本时状态栏出现提示、弹窗询问——**不会自动下载**，点「下载并安装」才下载并在安装完成后自动重启。**每次启动都会检查一次**（只受设置里「启动时自动检查更新」开关约束）；弹窗里点过「稍后」之后就不再自动弹窗，只在状态栏留一个「可更新到 vX」入口，直到手动检查（菜单「帮助 → 检查更新…」或点状态栏入口）。

- **更新源**：`https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json`（配置在 `tauri.conf.json` 的 `plugins.updater.endpoints`）。它是"最新一个**已发布** Release"的资产，所以草稿（draft）Release 里的更新包客户端拿不到——**必须 Publish 之后才生效**。
- **仓库必须是公开的**：更新检查是**匿名请求**（不带任何 GitHub 凭据），私有仓库对匿名一律 404，结果是"检查更新失败：没有取到更新清单（latest.json）"（插件对非 2xx 只记日志，最后统一报 `Could not fetch a valid release JSON from the remote`）。判断顺序：先看 `gh api repos/Z3O1/Typst-pad --jq .private` 是不是 `false`，再确认 Release 已 Publish，最后才怀疑网络。验证匿名可达性：`curl -sIL -o /dev/null -w '%{http_code}' https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json` 应为 `200`。
- **清单内容**：版本号 + 安装包下载地址 + 安装包签名；由 `scripts/generate-latest-json.mjs` 在构建后生成（更新说明默认取 `CHANGELOG.md` 里该版本的正文），与安装包一起作为 Release 资产上传。弹窗里这份说明会**渲染成排版文本**（标题 / 列表 / 粗体 / 行内代码，见 `src/lib/update-notes.ts`——先整体 HTML 转义再生成白名单标签，说明里即使带 HTML 也只当文本显示）。
- **签名校验**：安装包由 CI 用私钥签名（生成 `.sig`），客户端用**编译进应用**的公钥（`plugins.updater.pubkey`）校验，签名不符直接拒绝安装——防的是"更新通道被换成别人的安装包"。
- **密钥管理**：私钥与密码存在仓库 Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）。**私钥丢了就再也发不出自动更新**（老用户只能手动下载安装包），pubkey 一旦发布也不要再换。
- **本机打包**：`createUpdaterArtifacts` 为 true 且配置里有 pubkey 之后，任何 `tauri build` 都必须能拿到私钥（`TAURI_SIGNING_PRIVATE_KEY` 或 `TAURI_SIGNING_PRIVATE_KEY_PATH`），否则打包直接失败（Tauri 的硬约束）。
- **第一个带自动更新的版本要手动装一次**：0.7.3 之前的版本（≤ 0.7.2）里没有 updater，所以它们不会自己升级上来。

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

预览渲染所需字体打包在 `src-tauri/fonts/`（约 5.7MB，离线可用，无需 CDN）：

- `NotoSerifCJKsc-Regular.otf` — 中文（思源宋体）
- `NewCMMath-{Regular,Bold,Book}.otf` — 数学（New Computer Modern Math）
- `LibertinusSerif-{Regular,Bold}.otf` — 正文衬线
- `DejaVuSansMono.ttf` — 等宽

字体加载在 **Rust 侧**完成：编译时读取字体目录（打包后为 `resource_dir/fonts`，开发/测试为仓库 `src-tauri/fonts`），与**系统字体目录**（Windows 含 `%WINDIR%\Fonts` 与「仅为我安装」的 `%LOCALAPPDATA%\Microsoft\Windows\Fonts`）、**用户额外字体目录**（设置 → 额外字体目录，等同于 typst CLI 的 `--font-path`）合并后注册进 FontBook；`.ttf` / `.otf` / **`.ttc` / `.otc` 都收，集合里的每个 face 都会注册**（Windows 的 SimSun、微软雅黑、微软正黑体都是 .ttc 集合，只读 .ttf/.otf 会让它们整个缺席）。目录缺失时不影响编译（typst 给出缺字诊断）。打包映射见 `tauri.conf.json` 的 `bundle.resources`（`fonts` → `fonts/`）。

**中文默认字体是显式指定的，不靠 typst 自动回退**：typst 默认正文字体 `Libertinus Serif` 不含汉字，不指定时所有中文都走"自动回退"，而回退打分优先"与基准字体同衬线"（`Libertinus Serif` 的 panose 全 0，被判定无衬线，于是思源宋体等宋体全被扣分）再比"家族名长短"——实测（typst 0.15.1）Windows 会渲染成楷体/隶书、Linux 成 Noto Sans CJK 的日文字形。所以 typst-pad 在编译时把默认字体族列表注入基础样式层：`Libertinus Serif` → 打包的思源宋体 → 系统宋体兜底（打包那份是子集，生僻字靠 `SimSun`/`Songti SC` 接住）→ `Microsoft YaHei` 收尾。**文档里的 `#set text(font:)` 优先级更高**（与原生 typst 一致），设置里也可以从「正文字体」下拉直接选一个真实族名。字体族名写错时 typst 只发警告不报错（会静默改用别的字体），所以编译警告会显示在状态栏徽标里，并提示"族名要用英文名 / 可放进额外字体目录"。

字体目录刻意**不放在前端静态目录**：放 `static/` 会被 SvelteKit 整份拷进前端产物，而前端从不引用它们（编辑器用的是系统字体栈，见下），安装包里会白多一份约 5.7MB。

预览与公式的 SVG **不依赖字体**：`typst_svg` 把字形导出成矢量轮廓（`<symbol>`/`<use>`/`<path>`，无 `<text>`），所以预览在任何机器上渲染一致。编辑器自身的界面文本仍走系统字体栈（写作模式衬线、源码模式等宽），**没有** `@font-face`——界面里的中文与预览/PDF 的思源宋体不保证完全一致。

### 启动耗时观测

`src/lib/startup-timing.ts`：启动关键阶段打点（O(1)，无阻塞），首次编译完成后向控制台输出 `[startup]` 报告（各阶段耗时 + navigation timing 页面加载段）；Rust 侧（仅 debug 构建）另有 `[startup] rust phase:*` 打点（窗口创建 → webview 就绪 → 前端加载完成）。两侧同前缀，便于统一抓取对比。

## 验证脚本

```bash
node scripts/check-fonts.mjs    # 校验 src-tauri/fonts 字体文件有效性（魔数）
node scripts/download-fonts.mjs # 重新下载字体（jsDelivr，含重试）
cargo test --manifest-path src-tauri/Cargo.toml   # 原生编译验证（中文+数学 → SVG/PDF）
```

## 已知限制

- 单文件编辑，无文件树 / 多标签页（**Ctrl+Shift+N** 可以开第二个窗口，但那是「空白草稿窗口」：它不恢复上次内容，关掉应用后再打开也不会被记住 —— 只有主窗口的会话会恢复）
- 预览不跟随滚动
- 预览按预览栏宽度重新排版，所以预览里的换行与分页与导出的 PDF 不完全一致（PDF 用文档自己的纸型）
- 所见即所得的覆盖范围：公式（行内 + 独占整行的行间，含跨行书写）、常用标记与围栏代码块；表格/图片/引用块等块级结构仍显示源码（保持可编辑，不做块级 widget）
- 公式渲染的编译上下文 = 「设置里的前缀代码 + 文档自身的**单行顶层** `#let` 定义」（多行定义与内容块 `[...]` 里的定义不取；取不到时退化为仅前缀）。文档定义本身有错或与前缀重名时，会退回「仅前缀」重试一次；仍失败则保持源码显示（不渲染出错位内容）
- 前缀里若改了正文字号，编辑区公式仍按编辑器字号（14px = 10.5pt）渲染，以保证与编辑器正文对齐
- 支持 `@local` 本地包（读取 typst 数据目录）与 `@preview` 在线包（首次使用时自动下载到 typst 共享缓存目录，离线后直接命中缓存；网络不可用时给出明确诊断）——包目录规范与 typst CLI 一致，可通过 `TYPST_PACKAGE_PATH` / `TYPST_PACKAGE_CACHE_PATH` 环境变量覆盖
- 未保存文档时相对 `include` 无法解析磁盘路径（Rust 侧给出"需要先保存文档"的明确诊断）
- `tauri.conf.json` 的 `csp` 保持 `null`：wasm 编译管线已移除（wasm 限制解除），但 CSP 未实测启用；如需启用请在 `npm run tauri build` 后实机验证

## License

[MIT](./LICENSE) © 2026 Z3O1
