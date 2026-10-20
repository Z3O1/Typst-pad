# 开发与验证

[返回文档索引](../README.md) · [贡献流程](../../CONTRIBUTING.md)

## 开发环境

前端使用 Node.js 与锁定依赖，执行 `npm ci` 安装；CI 的项目运行时为 Node 22，浏览器驱动使用全局 WebSocket，运行浏览器验收时选择具备该 API 的 Node 版本。桌面开发还需 Rust stable 和 Tauri 2 系统依赖：Windows 的 C++ Build Tools/WebView2，Linux 依赖见 `.github/workflows/ci.yml`，macOS 使用 Xcode Command Line Tools。

`npm run tauri dev` 启动真实桌面应用，`npm run dev` 仅提供前端开发服务。字体校验用 `node scripts/check-fonts.mjs`。前端构建用 `npm run build`，安装包构建与签名见[发布与更新](../maintainers/release.md)。

## 按改动选择验证

| 改动 | 最低验证与补充 |
| --- | --- |
| 纯文档、注释中的引用 | 检查相对链接、锚点、旧路径和完整 diff；不为文档迁移跑应用测试 |
| 前端逻辑 | `npm run check`、相关 Vitest；提交前跑前端 CI 门禁 |
| Rust 编译、字体、路径或 IPC | rustfmt、clippy、相关 Rust 测试；IPC 变化同时验证前端成功/失败响应 |
| 编辑器、装饰、快捷键、布局 | 相关单测 + 对应浏览器套件 |
| 整页展示、源码展开、光标、模式切换 | 真实整页夹具与交互套件；不能只用桩或 jsdom |
| Svelte 拆分、样式或布局 | 浏览器交互 + `computed-style.mjs`，关注作用域和窄窗口 |
| 文件对话框、写盘、多窗口、设置接线、更新安装 | 相关单测/静态权限检查 + 桌面验证 |

CI 门禁是类型检查、Vitest、Prettier、前端构建、rustfmt、clippy 与 Rust 测试，具体步骤以 [CI](../maintainers/release.md) 和 workflow 为准。不要把“相关测试已通过”表述为“全部 CI 已通过”。Vitest 默认用 Node 运行纯逻辑测试，需要 DOM 或 localStorage 的文件在文件首行声明 `@vitest-environment jsdom`；新测试只在确实调用浏览器 API 时才加这条声明。

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

```bash
npm run verify:browser
ONLY=document-mode.mjs npm run verify:browser
ONLY=document-cursor.mjs npm run verify:browser
ONLY=zoom-stability.mjs npm run verify:browser
ONLY=document-expansion.mjs npm run verify:browser
ONLY=document-expansion-style.mjs npm run verify:browser # 自动导出 fixtures:pages
ONLY=empty-formula.mjs npm run verify:browser
ONLY=source-scroll-sync.mjs npm run verify:browser
ONLY=dollar-completion.mjs npm run verify:browser
ONLY=document-completion.mjs npm run verify:browser
ONLY=editor-shortcuts.mjs,file-changes.mjs npm run verify:browser
CHROME_PATH=/path/to/chromium PORT=1430 CDP_PORT=9336 npm run verify:browser
```

运行器默认运行全部 16 套（期望断言数见下表），并导出套件依赖的真实夹具。运行器启动独立服务和显式 `--headless=new` Chromium，只清理自己创建的进程，避开桌面开发端口。自动验证不得弹出可见窗口；桌面抽查须用户单独明确授权，未执行的 WebView2、真实 IME 等能力应标记未验证。`ONLY` 必须匹配实际套件；期望断言数量不符、夹具为空或导出失败均直接失败。产物和截图保存在 `.browser-check/`。`SKIP_DEV=1` 可复用服务；`SKIP_FIXTURES=1` 只在夹具与当前代码一致时使用。

| 套件（期望断言数） | 证明的行为 |
| --- | --- |
| `document-mode.mjs`（81） | 真实整页 SVG 逐节点一致，多页/不同纸型、图片、公式与脚本展开，未变页面节点复用、增量 IPC 完整还原与会话基准清空、Shadow DOM 外链，独立光标、鼠标正反向/跨页拖选、边缘自动滚动、选区缩放与异步作废、模式往返、输入替换、撤销/重做、错误区域源码回退、原位修复与撤销/重做、不可恢复错误保留旧产物、IME 与异步作废、仅移动光标也作废迟到点击 |
| `document-cursor.mjs`（42） | 真实 Typst 字素停靠点与 Chromium 变换后盒模型逐个对照；中英、标点、空格、emoji/组合字符、连字、标题/混合字号（含真实鼠标激活后完整标题源码逐字素新产物盒模型）、换行、公式/表格、raw、旋转/缩放、分页、重复输出；空文档/连续空段/缩进空段的真实占位几何、点击与输入/撤销/模式往返；无序/自动编号/显式编号/嵌套列表的空项与退出、空续行的真实光标、点击续写/删除/撤销重做/模式往返；多视口/DPR、明暗主题、焦点/选区、闪烁实际像素、合成中实际修改源码与候选锚点、DOM/EditContext 两条事件路径、减少动态效果、异步作废与编辑/撤销/重做 |
| `document-expansion.mjs`（114） | 64 份真实 Typst 展开产物：光标进入/内部保持/左右跨出边界、直接切换、最小与嵌套归属、代码/数学嵌套的安全边界、结束分号与代码空白/注释、声明保留执行及其可见源码停靠点、仅公式的下方浮动气泡、长行/高矩阵/嵌套分式根号的长公式预览不越出可见区、横滚/纵滚时滚动条占位不裁剪内容且滚首/末真实字形可见、靠底公式翻到源码上方、数字/分式中心真实鼠标点击展开、字体行高内墨迹外的真实公式点击与相同head再次点击、复杂块公式间隙、取消合成作废迟到点击、原生 SVG 帧一致、气泡点击恢复源码焦点、普通脚本无预览、counter 副作用仅执行一次及明暗主题、用户 show raw 隐藏/替换隔离和普通 raw 规则保留、选区冻结/收拢、多行首/末行真实停靠点、行内与多行公式/脚本在明暗主题下的实际 SVG 无框白底边界、零圆角和内距、原生字号及滤镜后文字对比度（至少 4.5），重排后可见插入点、编辑去抖、连续输入期间有界启动及单槽合并、源码模式独立去抖、映射/撤销/重做、完整边界删除及撤销选区恢复、合成结束最终光标、模式切换与迟到展开作废；标题真实鼠标/左右键进出、行侧原生空白不展开、完整 `=` 标记、父标题保持、空/嵌套标题、编辑撤销/重做、统一面板明暗主题及 PDF 请求原文不污染 |
| `document-expansion-style.mjs`（8） | 依赖 `fixtures:pages`：行内/块公式、紧凑/多行空公式的 8 个明暗场景，硬校验 44 个真实 Typst caret 停靠点；完整整页 SVG、无框白底源码样式、11pt ↔ 14px 字号、源码模式行距与实际光标像素；`ONLY` 选此套件也重新导出 pages 夹具 |
| `empty-formula.mjs`（39） | 新输入 `$$` 的真实字符按键/直接输入/粘贴、源码模式往返后仍聚焦的输入链路；完整 raw 投影/整页 SVG/原生 caret、续写、空格/Enter、收起、撤销/重做、正文末尾/空行与显式保存原文；两种模式下刚 Enter 生成可立即退回、移动/编辑空格/离开返回/手工/粘贴同形脚手架不退回、undo/redo 后不恢复资格、模式切换清除未动资格且往返不恢复、DOM/EditContext 合成取消资格及合成续写冻结/结束、新公式在途响应作废。临时资格策略以[渲染与交互](writing-rendering.md#在原位置展开源码)为准 |
| `document-transaction.mjs`（6） | 16 份同请求原文测量/最终展示事务夹具；同输入的新产物作废旧点击，自然测量先决定最终展示纸型 |
| `document-performance.mjs`（6） | 重复真实 SVG 组成 100 页 DOM 隔离探针：完整节点、引用作用域、单页更新复用、离屏尺寸与末页命中；直接 SVG 与 Shadow DOM 首屏像素一致，输出初始化及更新耗时，不设固定时间阈值 |
| `source-workflows.mjs`（59） | 输入无隐式写盘，取消保存/新建，显式保存、路径变化重编译、打开文件、会话恢复与字体配置、Tab 档宽（tabSpaces）设置恢复后按键生效、空行 `$` 脚手架与其 Enter 展开；闭合 `$` 后 Enter 退出公式并生成段落分隔 |
| `dollar-completion.mjs`（32） | `$` 与原生 `(` 的词中输入/闭合符对照、默认紧凑配对、空格与 Enter 行间手势、未闭合上下文、原样选区与反向选区、多光标、缩进三行脚手架、两级退格与撤销、粘贴及 DOM/EditContext（含空格）合成护栏、两种模式共用输入且无隐式写盘；多行公式行首 `\ =&` / `\ &=` 对齐标记在 Enter 时延续 |
| `document-completion.mjs`（21） | 文档模式与源码模式共用 CodeMirror/typst_lezer 补全候选；候选浮层脱离透明输入层并以页面真实光标为锚点，Enter/Tab/方向键/鼠标接受、Esc/失焦/模式切换/滚动缩放/底边翻转行为与源码模式一致（21 项断言，依赖 `fixtures:pages`） |
| `computed-style.mjs`（18） | 弹窗和窄窗口的 box-sizing、主题颜色及溢出边界；设置弹窗含 Tab 档宽输入 |
| `zoom-stability.mjs`（38） | 37份真实Typst缩放/边距夹具，保留固定栏宽隔离测试并增加1400/1100物理视口下不覆盖栏宽的write/source场景，逐档落地与连续wheel/key/menu均检查真实请求几何、完整SVG/同轮caret、逐帧自适应宿主及物理字号端点；全部引擎IPC序列和逐rAF栏宽/纸宽/字号/真实字形盒/DPR/请求采样（`zoom-frames.json`），存档150%/80%启动、write/source连续wheel/key/menu、reapply、迟到目标与模式、自然测量隔离、真实resize/DPR、延迟/拒绝/不可观测引擎；边距前后computedstyle/字形盒及截图（`zoom-margins.json`、`zoom-margin-before/after.png`），完整SVG与同轮caret身份。引擎通过CDP布局/DPR模拟，不用CSS zoom；不能替代Windows WebView2真实IPC/IME验收 |
| `preview-reflow.mjs`（28） | 预览重排（纸张跟着预览栏走）：文档模式停在自然尺寸、源码模式按栏宽重排、请求页宽 = 栏宽 × 11/14、极窄栏的页宽下限、字号不超过编辑区且不横滚；连续缩窄去抖、变宽恢复自然纸型与编译稳定、单页 ShadowRoot 实际更新中的迟到窄栏结果作废；同会话纸型编辑（缩小、反向、页高变化）、前缀变更、快速编辑与过期自然学习隔离；真实多纸型夹具的自然比例学习、原文480×960与整正文raw的真实A4产物隔离、错误恢复宽/窄栏与CDP布局/DPR引擎改档下的实际字号、完整原生SVG及有界请求，合成暂停作废迟到恢复测量、错误编辑锁修复/收起及迟到原文测量，以及「注入被文档自己的纸型覆盖」时退回等比缩放 |
| `editor-shortcuts.mjs`（22） | 文档/源码两模式的 `Ctrl+Shift+D` 首击选词、追加相同文本选区、多选区输入与撤销、Esc 收拢、`Ctrl+D` 仍删行；文档画布仅显示主选区/主光标，不宣称全部可见；无夹具依赖 |
| `file-changes.mjs`（31） | 假 IPC 与真实页面接线：clean 自动重读、dirty 选择重读/保留、同版本去重与新版本提示、显式保存冲突确认、保存快照及续写、迟到读盘/提示/写盘与跨会话串行隔离；无夹具依赖，不替代真实 OS watch、原生对话框与窗口 IPC |
| `source-scroll-sync.mjs`（22） | 源码模式双向真实滚轮与原生 cursor/hit 几何对应：跨页、折行、中文/emoji/公式、字体行高、viewport/DPR/布局缩放、UI zoom 与字体配置迟到查询作废、手动反向优先、无回声、无 selection/focus/source/保存/undo 副作用、无输出位置保守停止、纵滚保留独立横滚、模式/修订/会话取消；依赖 `fixtures:scroll`，不替代 WebView2 真实 IPC |

`npm run fixtures:pages` 调用真实原生引擎，导出包含中文、emoji、公式、表格、图片和宏输出的整页夹具与命中探针，覆盖正常、编辑和源码展开状态；另导出 26 份光标渲染夹具及原生源码位置查询（含空文档、空段与空列表项/空续行投影及其原文产物、不可映射位置），用于盒模型和截图像素对照；另导出 64 份正常、嵌套公式/调用、代码/数学交叉模式、多行脚本、数字/分式点击和块公式浮动预览、长行/高矩阵/嵌套分式根号、靠底公式、counter 和用户 raw 规则隔离的光标展开夹具，包含编辑、完整表达式删除与收起后的真实产物，以及 9 份标题正常/完整 block raw/编辑/空标题/内容块标题/mixed 标题光标产物、20 份紧凑 `$$`、`$  $`、Enter 多行空公式、增删空格、续写与正文末尾/空行产物；另导出 37 份默认/紧凑页面缩放与边距夹具（包含正常父布局缩放产生的实际请求几何），比较真实页宽、光标几何及 PDF 原文不变；另导出 17 份原文/整正文 raw 纸型夹具（含恢复展示的紧凑A4宽/窄页），分别匹配无注入与明确预览几何，验证自然学习不依赖开发桩对源码中页面规则的猜测。另导出 16 份同请求原文测量/最终展示事务夹具，覆盖原文与展开源码、自然页面与明确预览几何；原生测试还核对展开的固定字体/11pt 字号、真实行距、行内零 extent 与多行横向 0pt / 纵向 2pt 内距、跨页首/末行及逐字符停靠点，有自然断点的长行折行后的宽度与字符停靠点，以及 raw 隐藏/替换/包装/字号样式规则的局部隔离、预览完整字形/分式线/根号、预览不移动后续正文、公式内部命中不误判空白、变量赋值与 counter 更新只执行一次。错误预览夹具保留原生诊断，不以空错误模拟失败。测试先确认完整显示，再确认编辑交互，不以点击覆盖率决定页面如何呈现。

`npm run fixtures:scroll` 独立导出 1 份真实多页 `SCROLLFIXTURE`，包含逐字符 cursor 与页中线 hit 查询，严格核对非空 SVG/几何及 1/1 计数。运行器按套件依赖选择 `fixtures:pages` / `fixtures:scroll`，默认全量运行时两者都重新导出；滚动导出证据保存在 `.browser-check/source-scroll-fixtures-exports/<时间戳>-<唯一编号>/`。滚动同步实现契约见[架构](architecture.md#布局滚动与缩放)。

夹具导出每轮把 Cargo 原始 stdout/stderr、完整命令/退出状态、源码 HEAD 与工作区 diff、导出脚本快照、实际数量与夹具名字留在 `.browser-check/page-fixtures-exports/<时间戳>-<唯一编号>/`，成功和失败都保留，不覆盖前一轮。Cargo 使用 libtest `--show-output` 汇总各测试捕获的 stdout，避免并发进度前缀与原生 marker 黏连；门禁仍不接受带前缀的 marker。门禁严格核对 8/26/64/17/37/16 份产物、非空页面/对应探针以及错误回退的原生诊断；Cargo 非零退出、信号或启动/缓冲区错误不能成功。失败信息定位到 marker、原输出行号、夹具名字（无名字时为原文摘要）及缺失字段；数量不足时也记录非行首 marker 的前缀线索，但不擅自接受未知前缀。所有组通过后才写出浏览器消费的 JSON，不自动重试；先检查该轮证据，不能用之后的成功推断之前失败的首因。

浏览器桩只验证前端接线和静态真实产物；EditContext 检查仅切换验收会话的 UA 以启用 CodeMirror 对应路径，不等于移动端或桌面输入法实机验证。任意源码的动态编译、真实文件对话框、WebView 输入法、系统缩放与多个原生窗口仍需桌面验证。切片和独立公式夹具已移除。

## 文档模式性能复现

```bash
# 原生分段测量：debug，首次生成 + 三次第一页小范围修改
cargo test --manifest-path src-tauri/Cargo.toml document_performance -- --ignored --nocapture
PERF_PAGES=100 cargo test --manifest-path src-tauri/Cargo.toml document_performance -- --ignored --nocapture

# 自动导出真实夹具，比较整篇 DOM 替换与页级更新
ONLY=document-performance.mjs npm run verify:browser
```

`DOCPERF` 记录 World、Typst 编译、几何、索引建立、目标页命中，以及页面 JSON 的时间和大小。生产输出成本看 `delta_svg_ms`（页清单/缺页导出）、`delta_json_ms`、`delta_bytes` 与 `sent_pages`；`svg_ms` 是差量生成后额外运行的全量校验，此时缓存已热，不能直接与旧版 SVG 导出耗时比较。`json_ms` / `json_bytes` 是同轮全量页面序列化对照。探针同时校验差量重建与完整导出一致；热修改比较应排除 `round=0`。`DOCDOMPERF` 记录浏览器解析与强制布局耗时。原生探针绕过 Tauri，DOM 探针重复静态真实夹具，都不是 Windows WebView2 的端到端测量；当前对照见[渲染与交互](writing-rendering.md#当前性能实现与基准)。首次导出、缓存淘汰、全部页面重排和实际 IPC 应另测，不能只凭热缓存结果承诺持续输入延迟；合成探针绕过命令通道，不含 comemo 清理成本。

### 前端调度与恢复探针

```bash
npm test -- src/lib/core/document-compile-scheduler.test.ts src/lib/core/document-error-fallback.test.ts
CARGO_BUILD_JOBS=2 cargo test --manifest-path src-tauri/Cargo.toml nested_error_raw_recovers_only_the_markup_child
PORT=1457 CDP_PORT=9357 ONLY=document-mode.mjs,document-expansion.mjs,document-cursor.mjs,preview-reflow.mjs npm run verify:browser
```

假时钟单测检验去抖上限、在途剩余预算、取消/合成与单槽；同时以文档30/100ms、源码150/300ms策略核对同回合最终源码与到期后的合法中间启动。`preview-reflow.mjs`的零中间请求断言使用同一浏览器回合的多次编辑，不把独立CDP调用加sleep当成零时间；独立在途场景扣住自然测量响应，等待后续编辑预算耗尽再放行，严格要求旧测量加最终原文/展示共三次请求、最终几何与无过期纸张落地。`REFLOW_RAPID`/`REFLOW_INFLIGHT`记录各子条件、完整请求源码、序号、纸型、产物viewBox/geometryId、调度/编译计数及编辑/响应时间。范围测试检验当前错误锁变化、增量树复用、最小内容块恢复及失败后的有界扩大。原生 `nested_error_raw_recovers_only_the_markup_child` 动态编译失败原文与局部 raw 恢复输入，确认正常父内容继续排版且恢复字符有真实停靠点；它不运行前端状态机。核心依赖版本回归保持主源码与上下文不变，改变编译回调的依赖版本，核对原文新失败而 raw 展示成功时仍保留最新诊断；原生 `changed_read_dependency_can_fail_original_while_raw_expansion_still_renders` 和 `main_snapshot_reuse_does_not_cache_dependencies_or_cross_project_roots` 分别证明真实原文/raw反例与依赖快照失效。

浏览器 `DOCSCHEDULE` 记录普通文档/源码输入、光标进入/离开、错误修复及连续输入的首次请求时间与请求数。连续输入测试在输入尚未停止时就要求有请求，并核对最终完整页面；不设固定墙钟 CI 阈值。日志在 `.browser-check/run-all-document-{mode,expansion}.log`。这些请求使用静态真实 Typst 夹具与假 IPC，只证明前端调度/接线，不代表任意源码动态排版、真实 IPC 或 Windows WebView2 反馈时间。导航展开不跨请求复用原文验证，需要原文验证与展示各一次；仅在同一请求内复用原文结果为自然测量，错误修复也仍可能需要两次完整编译；源码模式保留 150ms 去抖，不能将文档模式调度改善宣称为两种模式同速。

### 只读外部文档编辑探针

[`edit_performance.rs`](../../src-tauri/src/typst_world/tests/edit_performance.rs) 可读取真实文档，在内存副本模拟连续输入、删除、段落与撤销。不会保存源文件、导出 PDF 或写夹具；结束时检查主文件字节未变。`PERF_FILES` 是绝对路径列表（Linux/macOS 用 `:`，Windows 用 `;`），样本须有可编译正文。

```bash
PERF_FILES='/absolute/path/one.typ:/absolute/path/two.typ' PERF_ROUNDS=12 \
  cargo test --manifest-path src-tauri/Cargo.toml document_edit_performance -- --ignored --nocapture
PERF_FILES='/absolute/path/one.typ' \
  cargo test --manifest-path src-tauri/Cargo.toml world_component_performance -- --ignored --nocapture
```

默认 12 轮覆盖原文、连续输入、删除、段落、撤销和重复输入；设置 `PERF_VARIETY=1 PERF_ROUNDS=50` 时，第 7 轮以后使用不同文字版本，避免只测两种内容的热缓存。`EDITPERF` 给出原生分段与 `eviction_ms`（与命令通道同样调用 `comemo::evict(10)`），`total_ms` 是分段之和；`EDITVISUAL` 对比实际 SVG 变化页与传输页数。`EDITMEM` 在 Linux 读取探针进程 RSS，其他平台为 `na`；它包含 oracle、字体与历史快照，不代表桌面应用峰值。`WORLDPERF` 拆分共享字体/标准库、根扫描与主源快照命中成本，Source 部分是相同正文命中，不代表不同输入的解析成本。

每轮用独立直接 SVG 导出校验完整重建；oracle 成本不计入产品分段。Rust 门禁还比较增量 AST 与完整解析的语法范围、编译产物和诊断，覆盖共享 UTF-8 尾字节的中文/emoji、旧世界不可变性、资源样式、依赖更新及缓存淘汰。探针不启动编辑器或真实 IPC；共享日志前注意其中含输入文件路径，不提交课程原文或生成产物。

## 桌面抽查

在目标 WebView 上使用包含表格、图片、宏、公式和多页的本地文档，依次检查：

1. 文档模式与完整编译结果一致；改变窗口尺寸/界面缩放时预览按新栏宽**重排**（页宽与分页随之变化，这是有意接受的代价），预览栏始终不出现横向滚动条；不需要缩窄时页面停在自然尺寸并居中。
2. 点击正文、公式、表格和宏输出定位源码；完整公式、脚本与标题（含全部 `=` 标记）在原位置展开为源码，展开与收起都由 Typst 重新排版。
3. 在文档模式按住左键正反向、跨行、跨页拖选，检查高亮、边缘自动滚动和松开停止；复制、剪切、输入替换与源码模式往返保留真实选区。检查光标进入、内部移动、左右跨出公式/脚本时的展开与收起，选区和合成期间不应跳动重排，展开后插入点应可见；检查中英、标点/空格、连字、混合字号与旋转文字的插入点、高度和闪烁；失焦或非空选区不应残留光标。再用真实中文输入法编辑，检查候选锚点、合成常亮、撤销/重做、保存与重读。新增空公式从真实 `$` 自动配对和直接输入/粘贴 `$$` 开始验收，不仅核对 doc/head；Enter 后立即 Backspace 应折回，但移动、增删空格、离开返回或手工/粘贴的同形多行内容只正常删字符，并抽查模式往返、undo/redo 与真实 IME 不恢复已撤销资格。
4. 制造公式、脚本、声明和残缺语法错误，确认出错区域显示可编辑源码，其余区域正常排版；点击错误区后修好仍可继续编辑源码，诊断立即清除，再次输入错误仍能报告，移出区域或按 Esc 才收起；撤销/重做能恢复对应状态，保存内容不含临时围栏；错误仍在状态栏与错误徽标出现（预览区不画错误框）。前缀、外部文件或不可定位错误不能恢复时，完整旧产物仍显示但不能提交命中。
5. 打开两个窗口，互相编译后仍用各自编号定位；打开/新建文件立即清除旧会话产物。长文档滚到首尾及页间，检查离屏占位、光标、不同纸型和外链；在 WebView2 上核对 Shadow DOM 引用与主题滤镜，不以 Chromium 像素探针替代目标平台验证。
6. 抽查主题、缩放、快捷键、文件确认与更新流程。不得把浏览器桩当作这些原生能力已通过的证据。

## 断言与隔离纪律

- 不为测试数量添加重复断言；先证明产物身份，再测对应的交互或异步契约。
- 夹具缺失、目标节点不存在或命中范围失效应硬失败，不用静默跳过制造通过。
- CodeMirror 视图通过 `window.__typstPadView` 开发钩子读取，不使用私有 DOM 字段。
- 会话恢复完成后才输入；重载前等待存档防抖完成。未保存修改、打开保存与窗口隔离见[文件与安全](files-and-security.md)。
- 沙箱无法启动子进程或监听端口时明确区分环境限制和实现失败；验证结论只覆盖实际完成的检查。

## 开发排障

浏览器的 `?browserdev=1` 使用假 IPC；任意源码的真实排版需桌面后端，整页浏览器验收使用 Rust 导出的真实夹具。不要把桩不能复现理解成桌面问题不存在。只清理本次创建的进程；无界面验收使用 headless Chromium，不需要弹出桌面窗口。

状态栏脚本错误来自 `window.onerror` / `unhandledrejection`。`debug.ts` 在 dev 默认记录日志，另支持 `--debug`、`?debug=1` 和 localStorage 开关；`startup-timing.ts` 与 Rust 的 debug 打点可区分窗口、前端与编译耗时。

WebKit 开发白屏时核对 `vite.config.js` 的同步 wasm 初始化兼容处理与预构建排除；修改前须验证目标 WebView。WSLg 图形故障可临时用 `GDK_BACKEND=x11 GDK_GL=disable WEBKIT_DISABLE_DMABUF_RENDERER=1` 诊断，不把本机参数写成统一要求。

Svelte 组件的局部 `box-sizing` 不会跨组件继承；用窄视口和计算样式确认。浏览器套件不要与 `npm run check/build` 同时运行，生成文件更新会触发预览重载。清存储前离开旧页面，防止防抖存档写回；重载后等待会话恢复，截图和诊断保存在 `.browser-check/`。`scripts/browser-check/probe.mjs` 可读取页面诊断。
