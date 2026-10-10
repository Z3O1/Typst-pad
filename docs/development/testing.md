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
ONLY=document-expansion.mjs npm run verify:browser
ONLY=dollar-completion.mjs npm run verify:browser
CHROME_PATH=/path/to/chromium PORT=1430 CDP_PORT=9336 npm run verify:browser
```

运行器启动独立服务和 Chromium，只清理自己创建的进程，避开桌面开发端口。`ONLY` 必须匹配实际套件；期望断言数量不符、夹具为空或导出失败均直接失败。产物和截图保存在 `.browser-check/`。`SKIP_DEV=1` 可复用服务；`SKIP_FIXTURES=1` 只在夹具与当前代码一致时使用。

| 套件 | 证明的行为 |
| --- | --- |
| `document-mode.mjs` | 真实整页 SVG 逐节点一致，多页/不同纸型、图片、公式与脚本展开，未变页面节点复用、增量 IPC 完整还原与会话基准清空、Shadow DOM 外链，独立光标、鼠标正反向/跨页拖选、边缘自动滚动、选区缩放与异步作废、模式往返、输入替换、撤销/重做、错误区域源码回退、原位修复与撤销/重做、不可恢复错误保留旧产物、IME 与异步作废 |
| `document-cursor.mjs` | 真实 Typst 字素停靠点与 Chromium 变换后盒模型逐个对照；中英、标点、空格、emoji/组合字符、连字、标题/混合字号、换行、公式/表格、raw、旋转/缩放、分页、重复输出；空文档/连续空段/缩进空段的真实占位几何、点击与输入/撤销/模式往返；多视口/DPR、明暗主题、焦点/选区、闪烁实际像素、合成中实际修改源码与候选锚点、DOM/EditContext 两条事件路径、减少动态效果、异步作废与编辑/撤销/重做 |
| `document-expansion.mjs` | 32 份真实 Typst 展开产物：光标进入/内部保持/左右跨出边界、直接切换、最小与嵌套归属、代码/数学嵌套的安全边界、结束分号与代码空白/注释、声明保留执行及其可见源码停靠点、仅公式的下方浮动气泡、长行/高矩阵/嵌套分式根号的长公式预览不越出可见区、靠底公式翻到源码上方、数字/分式中心真实鼠标点击展开、原生 SVG 帧一致、气泡点击恢复源码焦点、普通脚本无预览、counter 副作用仅执行一次及明暗主题、用户 show raw 隐藏/替换隔离和普通 raw 规则保留、选区冻结/收拢、多行首行标点停靠点、重排后可见插入点、编辑去抖、映射/撤销/重做、合成结束最终光标、模式切换与迟到展开作废 |
| `document-performance.mjs` | 重复真实 SVG 组成 100 页 DOM 隔离探针：完整节点、引用作用域、单页更新复用、离屏尺寸与末页命中；直接 SVG 与 Shadow DOM 首屏像素一致，输出初始化及更新耗时，不设固定时间阈值 |
| `source-workflows.mjs` | 输入无隐式写盘，取消保存/新建，显式保存、路径变化重编译、打开文件、会话恢复与字体配置、Tab 档宽（tabSpaces）设置恢复后按键生效、空行 `$` 脚手架与其 Enter 展开 |
| `dollar-completion.mjs` | `$` 与原生 `(` 的词中输入/闭合符对照、默认紧凑配对、空格与 Enter 行间手势、未闭合上下文、原样选区与反向选区、多光标、缩进三行脚手架、两级退格与撤销、粘贴及 DOM/EditContext（含空格）合成护栏、两种模式共用输入且无隐式写盘 |
| `computed-style.mjs` | 弹窗和窄窗口的 box-sizing、主题颜色及溢出边界；设置弹窗含 Tab 档宽输入 |
| `preview-reflow.mjs` | 预览重排（纸张跟着预览栏走）：文档模式停在自然尺寸、源码模式按栏宽重排、请求页宽 = 栏宽 × 11/14、极窄栏的页宽下限、字号不超过编辑区且不横滚；连续缩窄去抖、变宽恢复自然纸型与编译稳定、单页 ShadowRoot 实际更新中的迟到窄栏结果作废；同会话纸型编辑（缩小、反向、页高变化）、前缀变更、快速编辑与过期自然学习隔离；真实多纸型夹具的自然比例学习、原文480×960与整正文raw的真实A4产物隔离、错误编辑锁修复/收起及迟到原文测量，以及「注入被文档自己的纸型覆盖」时退回等比缩放 |

`npm run fixtures:pages` 调用真实原生引擎，导出包含中文、emoji、公式、表格、图片和宏输出的整页夹具与命中探针，覆盖正常、编辑和源码展开状态；另导出 9 份光标渲染夹具及原生源码位置查询（含空文档、空段投影及其原文产物、不可映射位置），用于盒模型和截图像素对照；另导出 32 份正常、嵌套公式/调用、代码/数学交叉模式、多行脚本、数字/分式点击和块公式浮动预览、长行/高矩阵/嵌套分式根号、靠底公式、counter 和用户 raw 规则隔离的光标展开夹具，包含编辑与收起后的真实产物；另导出 15 份原文/整正文 raw 纸型夹具，分别匹配无注入与明确预览几何，验证自然学习不依赖开发桩对源码中页面规则的猜测。原生测试还核对有自然断点的长行折行后的宽度与字符停靠点，以及 raw 隐藏/替换/包装/字号样式规则的局部隔离、预览完整字形/分式线/根号、预览不移动后续正文、公式内部命中不误判空白、变量赋值与 counter 更新只执行一次。错误预览夹具保留原生诊断，不以空错误模拟失败。测试先确认完整显示，再确认编辑交互，不以点击覆盖率决定页面如何呈现。

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
2. 点击正文、公式、表格和宏输出定位源码；完整公式与脚本在原位置展开为源码，展开与收起都由 Typst 重新排版。
3. 在文档模式按住左键正反向、跨行、跨页拖选，检查高亮、边缘自动滚动和松开停止；复制、剪切、输入替换与源码模式往返保留真实选区。检查光标进入、内部移动、左右跨出公式/脚本时的展开与收起，选区和合成期间不应跳动重排，展开后插入点应可见；检查中英、标点/空格、连字、混合字号与旋转文字的插入点、高度和闪烁；失焦或非空选区不应残留光标。再用真实中文输入法编辑，检查候选锚点、合成常亮、撤销/重做、保存与重读。
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
