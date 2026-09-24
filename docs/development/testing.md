# 测试与验证

[返回文档索引](../README.md) · [贡献流程](../../CONTRIBUTING.md)

## 按改动选择验证

| 改动 | 最低验证与补充 |
| --- | --- |
| 纯文档、注释中的引用 | 检查相对链接、锚点、旧路径和完整 diff；不为文档迁移跑应用测试 |
| 前端逻辑 | `npm run check`、相关 Vitest；提交前跑前端 CI 门禁 |
| Rust 编译、字体、路径或 IPC | rustfmt、clippy、相关 Rust 测试；IPC 变化同时验证前端成功/失败响应 |
| 编辑器、装饰、快捷键、布局 | 相关单测 + 对应浏览器套件 |
| 公式、块渲染、锚点、模式切换 | 真实夹具与稳定性套件；不能只用桩或 jsdom |
| Svelte 拆分、样式或布局 | 浏览器交互 + `computed-style.mjs`，关注作用域和窄窗口 |
| 文件对话框、写盘、多窗口、设置接线、更新安装 | 相关单测/静态权限检查 + 桌面验证 |

CI 门禁是类型检查、Vitest、Prettier、前端构建、rustfmt、clippy 与 Rust 测试，具体步骤以 [CI](../maintainers/ci.md) 和 workflow 为准。不要把“相关测试已通过”表述为“全部 CI 已通过”。

```bash
npm run check
npm test
npm run format:check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

运行单文件可用 `npm test -- src/lib/core/typst-engine.test.ts`。Rust 可在 `cargo test --manifest-path src-tauri/Cargo.toml` 后追加测试名过滤器。`clippy --all-targets` 已包含编译检查，无需再机械重复 `cargo check`。

Prettier 的写入命令是 `npm run format`，但应只格式化本次文件以免混入无关变更。`.prettierignore` 排除了 Markdown 和 workflow；它不能代替文档链接检查。仓库没有专门的 Markdown/link checker，文档修改需检查 Markdown 链接和反引号中的文档路径，并搜索脚本、代码、workflow 对旧路径的引用。

## 浏览器验收

准备可用的 Node 全局 WebSocket、Cargo、字体和 Chromium 后：

```bash
npm run verify:browser
# 只运行相关套件（仍会准备夹具）
ONLY=writing-blocks-visual.mjs,writing-stability.mjs npm run verify:browser
# 自行指定浏览器或避开已有端口
CHROME_PATH=/path/to/chromium PORT=1430 CDP_PORT=9336 npm run verify:browser
```

以上环境变量语法用于 POSIX shell。运行器 `scripts/browser-check/run-all.mjs` 启动服务、连接或启动 Chromium、导出夹具、运行套件并汇总，默认 Vite 1425 / CDP 9335，避开桌面开发端口 1420。产物在 `.browser-check/`；它只清理自己启动的进程。`SKIP_DEV=1` 可复用服务；`SKIP_FIXTURES=1` 只在确认夹具与当前代码一致时使用。

单独运行脚本时自行准备服务、CDP 和夹具，通过 `BROWSER_CHECK_PORT` 或完整 `BROWSER_CHECK_URL` 指定页面，通过 `CDP_PORT` 指定浏览器。`run-all` 的服务端口变量是 `PORT`，不要与单套件变量混淆。

| 套件（位于 `scripts/browser-check/`） | 证明的行为 |
| --- | --- |
| `wysiwyg.mjs` | 公式与标记、菜单快捷键、恢复、缩放、字体、诊断和更新 UI；不证明真实编译 |
| `writing-blocks.mjs` | 假切片下的编辑、选择、导航、补渲、输入法、模式往返 |
| `writing-blocks-visual.mjs` | 真实产物的复杂块裁剪几何与链接热区；正文是否保留文本也要断言 |
| `writing-blocks-hit.mjs` | 真实探针的点击到字符映射与 geometryId 校验 |
| `writing-mode-scenes.mjs` | 标题、中文、列表、公式、表格、默认段距、连续空行与文末输入等场景的真实呈现及截图；防空数组假绿 |
| `wysiwyg-visual.mjs` | 真实公式的基线、pt 尺寸、居中、暗色与墨迹边界 |
| `writing-stability.mjs` | 点击/键盘进入公式与复杂块、模式往返、过期命中、调度、输入法与逐帧几何 |
| `computed-style.mjs` | 作用域 box-sizing、窄视口溢出、CSS 源序与原有 content-box 边界 |
| `writing-pku-docs.mjs` | PKU 真实作业（`PKU_ROOT`）的逐块几何：正文/标题/列表/公式切片同一张位置表，同页相邻锚点 ≤2px、页内累计 ≤5px；夹具缺失/原文哈希不符直接失败 |

### PKU 真实作业验收（需要本机作业原文）

```bash
PKU_ROOT="$HOME/PKU" npm run fixtures:pku-writing   # 真实后端按源文件路径编译四份作业 + 公式产物
PKU_ROOT="$HOME/PKU" npm run verify:pku-writing     # 上面两条 + 只跑 writing-pku-docs.mjs
PKU_ROOT="$HOME/PKU" ONLY=writing-pku-docs.mjs npm run verify:browser
```

原文不复制进仓库；夹具、测量 JSON 与截图写在已忽略的 `.browser-check/pku-writing/`。命令日志会列出实际加载的路径、SHA-256 与样本数。`verify:browser` 没有 `PKU_ROOT` 也没在 `ONLY` 里点名时，这一套**跳过并明说**（不是悄悄报绿）。几何判据用文档**真实列宽**（文档自带 `#set page(...)` 会覆盖注入页设置），浏览器列宽被钉到同一宽度。

编辑回放（P0）：Rust 为同一段落的四个状态（原始 / Enter / 输入两字 / Backspace）各导一份真实编译夹具（`replay.json`），浏览器用**真实按键**驱动并逐步断言"文本与夹具逐字相同 + 命中真实夹具（`__browserDevBlocksMatched`，绝不静默退回假切片）+ 光标统一放在锚点后再量、撤销后后续行基线回到编辑前"。加新状态时 Rust 与夹具包装层要一起加，否则该状态会命中不到几何而失败（设计如此）。`PKU_REPLAY_ONLY=1` 只跑回放段（调试用）；CDP 调用有 `CDP_TIMEOUT_MS`（默认 30s）超时，避免浏览器崩了以后整段死等。

对账锚点两边都用**首行主基线**：Rust 侧从帧里取（`anchorBaselinePt`），浏览器侧用"行盒顶端 + 半 leading + 字体 ascent"算。浏览器坐标必须走 **DOM**（扫描已渲染的 `.cm-line`、用 `posAtDOM` 精确匹配目标行、`getBoundingClientRect` 取位置，文档坐标 = 元素视口顶端 − content 顶端 − padding-top），**不要用 `lineBlockAt`/`coordsAtPos` 或 `scrollTop` 换算**：高度图在长文档里会给出偏差 200px 级的位置，滚动锚定也会让 `scrollTop` 与 DOM 不同步。夹具还导出每块的 `lineSpans`（逐行源区间 + 右缘），`PKU_BREAK=1` 用它逐断点对比"Typst 折在哪 vs 浏览器折在哪"（浏览器侧用逐字符 `coordsAtPos` 看 y 何时增大——这个 CodeMirror 版本没有 `visualLineAt`）；`PKU_MATH_WIDTH=1` 打印行内公式 widget 的渲染宽与 SVG 宽（用来区分"宽度不对"与"不可断"）。`PKU_PLACEMENT=1` 做**逐块落位自检**：同一批块「逐个滚进视口量」与「滚到首块后一次性量」各量一遍（两者应完全一致，否则说明落位受滚动状态影响），并与「前面所有块带高之和」对账、打印 DOM 行高直方图与未被压缩的空行（本轮据此定位到「贴着规则行/行间公式的空行按整行渲染」）。`PKU_DIAG=1` 会打印最大偏差块附近的逐行 DOM 坐标，`PKU_LINE_SPACING=1` 是对照实验开关（把编辑器行高换成夹具量出的 `lineSpacingPt`，尚未并入产品）。

### PKU 写作模式桌面抽查清单（Tauri，需有桌面 WebView 的机器）

浏览器套件用 dev 桩跑的是"同一套产物 + 同一套前端"，**不能**替代真机：真机的字体来自 `bundled_font` IPC、编译在 Rust 侧同一进程、PDF 资源从作业原目录读。所以每次改写作链路（装饰、公式、块几何、分页）都要在一台有桌面环境的机器上按下面清单抽查一次，并把结论（通过/差异/截图）记进验收报告。

准备：`npm run tauri dev`；作业原文放在 `~/PKU/26fall/...`（只读，不复制进仓库）。

1. **加载与分页**：打开 `高等代数/week2-2026.9.24/1.typ`。逐页核对页面尺寸、页边距与 PDF 预览一致；`#set page(margin: 2.5cm)` 生效（不是注入页设置）。
2. **资源**：同一篇里的 `#image("高等代数260916计算题.pdf", page: 1, ...)` 能从**原目录**加载并显示（相对路径解析根 = 文档所在目录，不是应用目录）。
3. **切片与公式**：正文、标题、列表、行内/行间公式的呈现与浏览器套件截图一致；长行内公式在运算符处折行（`segments`），不是整块挤到下一行。
4. **模式切换**：源码 ↔ 写作来回切两次，块表与公式不残留旧产物（无"旧图配新几何"的错位）；滚动到未渲染区域会补渲而不是停留源码。
5. **输入回放**：在正文段末按 Enter（写两个换行）、Shift+Enter（写 `\` + 换行）、输入两个汉字、连按 Backspace、Ctrl+Z，表现与浏览器端 `writing-pku-docs.mjs` 的 13 项编辑回放一致（无不可解释的空行变化、无光标跳动）。
6. **打开作业目录**：从侧栏打开 `~/PKU` 下的另外三篇（数分周一/周二、高代周一），确认都能编译、无诊断、页数与 PDF 预览一致。
7. **记录**：把每步的结论与截图放进 `.browser-check/pku-writing/`，并在 `REPORT.md` 的"Tauri 抽查"一节写结论（本仓库当前的结论是"环境受限、未执行"，见报告）。

## 真实夹具与覆盖边界

`npm run fixtures:blocks` / `npm run fixtures:math` 从 Rust 的 ignored 探针提取真实产物。Cargo 必须在 PATH 上；过滤器未命中任何用例仍可能返回成功，因此生成器和消费者必须在空夹具/空探针时硬失败，不能跑零次断言而报告通过。公式夹具注入桩时须补 `{ ok: true, ...fixture }`。

块几何验收比较相邻带、纵向位置与比例，不能只检查 widget 存在；直接可编辑正文已经不是切片，不应强求每篇/每块都有 SVG。复杂块集合必须有非零断言下界。公式验收使用多字号真实产物，核对 pt × 4/3 的 CSS 尺寸、行内基线（误差小于 1px）与墨迹范围。

PKU 夹具把正文、标题、列表与公式切片放进同一张逐块位置表，用真实 Typst 的**首行锚点**对账。硬判据：同页相邻锚点 ≤2px、页内累计 ≤5px，以及**可编辑正文的视觉行数与 Typst 一致**（行数 oracle = 按 Rust 侧实测行距的 0.75 倍聚类主基线，`lineCount`；编辑块现在都是单源码行，两边比的是折行位置）。一条已知的 oracle 弱点必须写进结果、不能拿来绿：文档内的 `#let` 宏内容在使用处的字形 `Span` 指回定义处，无输出块必须按 `no_output` 跳过几何匹配（见 `SourceBlock::no_output`），否则定义块会拿到跨页假包围盒。

动态稳定性输出在 `.browser-check/writing-stability.json`。每条测量标明 `real-static` 或 `fake`；桩不能提供真实动态重编译 `real-dynamic`，应把它列为未覆盖而非通过。当前点击/模式切换的逐帧最大锚点漂移判据为 8px；改阈值必须给出几何证据，不能靠扩大容忍度掩盖回归。行盒与文字盒的固定差异可解释稳态偏移，不能与意外滚动混为一谈。高 widget 中下部点击与无滚动余量是单独边界，详见[公式与揭示](wysiwyg.md)。

浏览器开发模式的文件系统、IPC、下载与安装均为桩。真文件写盘/PDF、原生确认标题与警告图标、窗口 ACL/焦点/会话隔离、WebView 缩放和更新验签安装需桌面验证。修改设置字段后逐个点控件保存，核对页面配置、应用设置、恢复和持久化快照；单测字段清单不能证明全部接线。

## 断言与隔离纪律

- 先在未修复行为上建立可复现的失败，再验证修复；动态竞态用可控回调或排队放行，不能靠短 sleep 碰运气。
- 合并请求的计数断言同时给上下界，并证明输入确实改变；“重建/重编译”要观察新戳或计数，DOM 没变不能证明后台工作发生。
- 浏览器只读观测入口由 `src/lib/dev/editor-test-hook.ts`、`write-test-hook.ts` 提供，仅在开发桩启用。不要依赖 CodeMirror 私有 DOM 属性取得 EditorView。
- `HIT_CACHE` 是进程级共享状态。并行 Rust 用例凡读写它都先取得 `hit_cache_guard()`；只执行单个 ignored 探针不构成免锁先例。纯 `pick_hit` 与不写缓存的 `probe_blocks` 可独立测试。
- jsdom 的默认光标位于 0，可能自动展开构造；测试隐藏时把光标放在构造外。判断源码/切片用真实文本行结构，不能只查 `textContent`，SVG 也可能有文本节点。
- 浏览器段落间显式重设视口、模式和存储；CDP 设备模拟跨导航保留。逐帧采样有时间和帧数上限、独立 token，排除动作前的无关帧。
- 不恢复只验证 `.typ` 后缀、日志透传或重复收边的低价值测试；路径安全在 Rust 验证，交互风险用对应层的行为证据覆盖。

失败复现、真实文档探针和 WebView 日志见[排障](debugging.md)。
