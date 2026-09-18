# 所见即所得（WYSIWYG）调研

> 调研时间：2026-09-10。Typst 编辑器生态变动很快（见文末数据集），**时效性请自行核对**。
>
> 本文结论均来自一手资料（项目仓库 / 官方文档 / 实测）。每条事实后附来源。
>
> **未实地运行验证**的项已单独标注（见「未能验证的部分」）。

本文回答一个问题：**Typst 上能不能做出 Typora 那种"公式正常渲染、光标/选中时展开源码"的体验，怎么做？**

---

## 一、根本限制：为什么 Typst 没有真正的 Typora

**Typst 是图灵完备的**：文档中可以有任意 `#let` 自定义函数、`@preview` 包调用、条件与循环。任何"在渲染结果上直接编辑"的编辑器，都**不可能对任意源码做可靠的双向映射**。

所以所有实现最终都收敛到同一个妥协：

> **源码是唯一真相。派生的 WYSIWYG 视图只显示它能渲染的部分，渲染不了的整块降级为"代码碎片"（code chip）——用户永远必须能回到源码。**

两个独立来源的原文表述：

- Texpile 文档：「Anything the visual editor cannot show stays in place as a Typst code chip that you can still edit.」（[texpile.com/docs/visual-editing](https://texpile.com/docs/visual-editing)）
- TyX 论坛公告：full WYSIWYG 对 Typst 是 "tricky, if not impossible"（[forum.typst.app/t/3976](https://forum.typst.app/t/announcing-tyx-a-lyx-like-experience-rewritten-for-typst-and-the-modern-era/3976)）

**关键推论**：目标形态「**平时渲染、光标或选区进入时展开源码**」恰好绕开了这个限制 —— 它不要求双向映射（不需要把渲染结果反解成源码），只要求"一个可渲染范围 + 选区进出时切换表示"。**这是唯一可行、且实现成本最低的形态**，也是 Typora / Obsidian Live Preview 的做法。

---

## 二、现有实现（Windows 可用）

按"是否真 WYSIWYG"分档。

### 2.1 真 WYSIWYG

| 项目 | 形态 / 体积 | 许可 | 实现方式 | 状态与关键事实 |
|---|---|---|---|---|
| **TyX** | Tauri 桌面 + Web，**14.9 MB** | **MIT** | TipTap/ProseMirror 行内编辑 + **MathLive** 公式编辑 | 最轻的真 WYSIWYG。[仓库](https://github.com/tyx-editor/TyX)。⚠️ **默认没有 `$` 输入规则**（`src/settings.ts` 的 `DEFAULT_MATH_INLINE_SHORTCUTS = []`），公式只能靠菜单/快捷键插入；且 `MathNode` 是装饰器节点、**末尾一定是 MathLive 编辑框，不会渲染成排版结果** —— 与"平时渲染"相反 |
| **Tylina** | Electron 桌面 + Web + **DSH 插件**，**152 MB** | **专有** | 直接在**排版好的页面**上点击/输入/选择，光标与选区活在渲染结果上 | 完成度最高、最接近 Typora。作者 OrangeX4。[下载页](https://tylina.github.io/download/)（含简体中文）· [DSH 插件](https://github.com/tylina/dsh-tylina)。专有 → **不可改代码** |
| **Texpile** | Electron，`Texpile-Setup` **108.9 MB** | **AGPL-3.0** | 单栏排版视图 + `Ctrl+K` 切 Visual / Source，**切换时保留滚动位置、光标、撤销历史** | 最成熟的"开箱即用视觉编辑器"（LaTeX 顺带支持 Typst）。[仓库](https://github.com/texpile/texpile) · [视觉编辑文档](https://texpile.com/docs/visual-editing)。公式页内编辑 + 符号工具栏；表格网格化（≤10×10、可合并）；`@` 统一搜参考文献与图表公式；**界面有简体中文**。安装包只在官网 `dl.texpile.com`（GitHub Releases 资产为空，只有 rc1 老包） |
| **Obsidian + Typst Mate** | Obsidian 插件（`main.js` 0.54 MB + `typst-*.wasm` 33.4 MB） | Apache-2.0 | **借 Obsidian Live Preview 原生机制**：公式平时渲染，**光标进入即显示源码**；插件只把渲染引擎从 MathJax 换成 Typst | **行为与目标形态完全一致，且切换逻辑不用自己写。**[仓库](https://github.com/azyarashi/obsidian-typst-mate)，219★，v2.3.2 / 2026-03-02。内嵌 Typst **0.14.2**（落后当前 0.15.1 一个次版本）。代价：绑定 Obsidian 宿主 |

### 2.2 分栏（源码 + 预览，**不是** WYSIWYG）

| 项目 | 体积 | 许可 | 备注 |
|---|---|---|---|
| **Moraya** | **6.8 MB** | Apache-2.0 | 目前找到的**最小安装包**。README 明确："WYSIWYG for Markdown, source + live preview for Typst"。[仓库](https://github.com/zouwei/moraya) |
| Hilbert | 14.6 MB | MIT | 数理科学 IDE（公式/定理/图库 + Python/Julia/Wolfram 单元）。**winget 可装**：`Aburousan.Hilbert`。[仓库](https://github.com/aburousan/typsteditor) |
| Typsastra | 16.8 MB | MIT | 复杂文字（高棉/老挝）优先；驱动 Tinymist |
| Katvan | 50.8 MB | GPL-3.0 | Qt6，RTL/BiDi 支持最好；内建 Windows 拼写检查 |
| Typwriter | 41.7 MB | — | 带 typstyle 格式化 + Harper 语法检查 |
| **Typst-pad（本仓库）** | — | MIT | 写作模式**已经是**块级渲染的「渲染表面 + 源码透镜」（非光标块是引擎切片、光标块展开源码，仿 Typora；**不再**是"非所见即所得"，见 `docs/文档模式渲染保真-调研.md`）；源代码模式仍是分栏源码 + 整页预览 |

### 2.3 已死 / 用不了

| 项目 | 状态 |
|---|---|
| `typstudio` | 738★ 但**从未发布 release**，最后提交 2025-04 |
| `typst-wysiwyg` | 真 WYSIWYG 原型，但**仅网页、零 release**，自标 early prototype |
| `Typster` | 宣称 Typora 式（点击编辑 / 失焦渲染），但 README 路线图显示 **Typst 支持在 Phase 5、尚未开始**（1~2 阶段只是 Markdown） |
| `typst-lsp` | **仓库已归档（Deprecated）**，用 [Tinymist](https://github.com/Myriad-Dreamin/tinymist) 替代 |
| Glyph | Releases **只有 arm64 dmg**，Windows 需自行构建 |
| InkPond | 原生 iOS/iPadOS，非 Windows |

### 2.4 社区数据集（后续复查用）

- [days-since-last-typst-editor.samake.se](https://days-since-last-typst-editor.samake.se/) —— 跟踪 21 个 Typst 编辑器，附[机器可读 CSV](https://raw.githubusercontent.com/sermuns/days-since-last-typst-editor/main/data.csv)
- [Best of Typst § Writing](https://ydx-2147483647.github.io/best-of-typst/#writing)
- [Typst 论坛：编辑器发布节奏讨论](https://forum.typst.app/t/it-has-been-5-days-since-the-last-release-of-a-typst-editor/9516)

---

## 三、技术路线

| 路线 | 代表 | 核心机制 | 成本 |
|---|---|---|---|
| **CodeMirror 6 widget decoration** | **（推荐本仓库）** | `Decoration.replace({ widget })` 覆盖可渲染范围；**选区落在范围内即不挂 widget**，源码自然露出 | **最低** —— 本仓库编辑器已是 CM6，且已有装饰管线 |
| ProseMirror / TipTap NodeView | TyX | 自定义 node + nodeView：非选中渲染排版结果，选中渲染编辑器 | 中 |
| 自建文档模型 + code chip | Texpile、Tylina | 把源码解析成自有文档模型，渲染不了的整块保留为可编辑代码碎片 | 高（要写双向映射） |
| 借宿主已有机制 | Obsidian + Typst Mate | 用宿主"光标进入显示源码"的原生行为，只替换渲染引擎 | 最低（但受宿主约束） |

### 3.1 本仓库已具备的基础设施

好消息：**关键部件都已存在**，不需要新建架构。

| 已有能力 | 位置 | 与 WYSIWYG 的关系 |
|---|---|---|
| **CM6 装饰管线**（`Compartment` + `StateField` + `Decoration`） | `src/lib/Editor.svelte`（`diagnosticsCompartment` / `diagTheme`，现用于红色波浪线） | "选区进出切表示"与"画波浪线"是**同一套机制**，只是装饰类型从 `mark` 换成 `replace({ widget })` |
| **位置映射**：编译源（前缀+文档）位置 → 文档位置 | `src/lib/diagnostics-utils.ts`（`mapCompiledPosToDoc`、`squiggleRanges`） | 公式范围坐标换算可直接复用此模式（注意前缀区偏移） |
| **编译链路** | `src/lib/typst-engine.ts` → `compile_doc`（Rust 侧 `src-tauri/src/typst_world.rs`） | 公式级编译可复用；⚠️ 见下方风险 |
| **SVG 分页与画布缩放** | `src/lib/svg-paginate.ts`、`src/lib/preview-scale.ts` | 单公式渲染成 SVG 后可直接内联进 widget |

### 3.2 实现要点与风险（待验证的设想，非实测结论）

1. **范围扫描**：需要识别行内 `$...$` 与行间 `$ ... $`。难点是嵌套 `$`、转义、跨行、以及 `$` 出现在代码块 / 原始文本内的误判 —— 建议先用"只在非代码块、非 `raw` 区域内匹配"的保守规则，宁可漏渲染也不误渲染。
2. **widget 内容**：把公式单独编译成 SVG 内联。可参考 `preview-scale.ts` 的 pt→px 缩放，使行内公式与正文基线对齐。
3. **性能（最大风险）**：`compile_doc` 在 Rust 侧有**命令层互斥锁**且跑在 `spawn_blocking`（一次只编一个），连续输入时逐个公式编译会排队。必须做**按表达式文本 + 前缀代码的缓存**与**输入防抖**，否则会重演"每次按键整块重建预览"的开销。
4. **选区判定**：CM6 中监听选区变化（`EditorView.updateListener` 已存在），判断 `selection.main` 是否与该范围相交；相交则移除该范围的 widget。需注意**光标在范围边界**时的取舍（Typora 通常"光标进入内部才展开"）。
5. **失败回退**：公式编译失败（语法错误、缺包）时应**保持源码显示**，不要显示空 widget。

---

## 四、本仓库相关工程事实（本次会话实测）

与 WYSIWYG 本身无关，但直接影响迭代效率。

### 4.1 WSL 图形栈不可用

- 该 WSL 发行版**无 `/dev/dri`**（无 GPU 设备节点），WSLg 走 **RDP 后端**（`/mnt/wslg/stderr.log` 出现 `rdp-audio-in`）
- `libEGL warning: egl: failed to create dri2 screen` → WebKitGTK 内容画不出来
- **决定性测试：`xeyes` 也开不出窗口** → 该环境显示不了任何 GUI，桌面版在此跑不通（**不是本应用的问题**）

### 4.2 浏览器开发通路（已建好）

同一份前端代码可在浏览器里跑，用于开发纯前端功能：

```
npm run dev -- --host 0.0.0.0
# Windows 浏览器打开：
http://localhost:1420/?browserdev=1
```

- 实现：`src/lib/browser-dev-stub.ts`（假 `__TAURI_INTERNALS__` + 假 `compile_doc`，按文档生成假 SVG 分页），由 `src/app.html` 里一段模块脚本按 `?browserdev=1` 条件加载
- **坑（已踩）**：Vite **只对 JS 模块注入 `import.meta.env`**，**HTML 内联脚本一律原样透传**。守卫若写成 `import.meta.env.DEV`，在 `app.html` 里恒为 `undefined` → 桩永不安装（实测：页面停留在"请使用桌面应用版本"）。故改用运行时条件
- 真实编译 / include / 包解析 / PDF 导出**在此通路不可用**，必须回桌面版验证

### 4.3 预览区闪烁：滚动条反馈环（已修复）

**症状**：中等窗口宽度下预览区内容持续闪烁；**全屏不闪**。

**根因**（CDP 逐帧采样坐实）：`applyPreviewScale()` 把画布宽度写为"容器可用宽度"，而容器 `overflow: auto`：

```
状态 A: 容器 clientWidth=512（竖滚动条占 15px）→ 计算 host 宽度 527px
状态 B: 容器 clientWidth=527（滚动条消失）      → 计算 host 宽度 512px
```

画布略宽 → 出现竖滚动条 → `clientWidth` 少 15px → 重算变窄 → 滚动条消失 → 变宽 …… 无限循环。`previewHost.style.width` 在 `512px`/`527px` 间每秒翻转 6~7 次。

- 窗口够宽（≥ 自然缩放 840px，缩放被 `natural` 夹住）或全屏时不再随容器变化 → 反馈环断开 → 不闪。**这就是"全屏就不闪"的原因**
- 实测震荡区间：视口 1040/1060px 下 `flips=7` / `flips=6`；≤1020 与 ≥1080 时 `flips=0`

**修复**：`.preview-body` 加 `scrollbar-gutter: stable`（滚动条槽位常驻 → `clientWidth` 不再随滚动条变化）。

- 实测：修复前取值 `['512px','527px']` `flips=22`；修复后 `['512px']` `flips=0`；560~1140px 全宽度扫描 `flips` 全为 0

---

## 五、结论

1. **现成方案中，唯一与目标形态完全一致的是 Obsidian + Typst Mate**（平时渲染、光标进入显示源码），但绑定 Obsidian 宿主、且内嵌 Typst 版本落后一个次版本。
2. **若要在本仓库实现，走 CM6 widget decoration 路线** —— 装饰管线、位置映射、编译链路、SVG 缩放都已存在，缺的只是"范围扫描 + replace widget + 选区监听 + 公式级缓存防抖"。
3. **不要考虑 fork Texpile 去"去掉打开文件夹"**：文件夹是它的**数据模型**（编译配置存 `.texpile/`，菜单栏 / 协作会话 / 主文件选取全围绕 workspace 构建），不是可关闭的功能开关。其文档也明说：单文件打开时"没有文件浏览器、没有预览面板、没有编译，因为这些都需要文件夹"。
4. **TyX 的源码可读（MIT）**，但其 `MathNode` 是"永远在编辑 MathLive"的设计，与"平时渲染"相反，不宜作为基底。

---

## 六、未能验证的部分

以下条目**只做了资料核对，未实地运行**：

- Tylina、Texpile、TyX 的**实际渲染效果**与对复杂文档（自定义宏、`@preview` 包）的覆盖度
- TyX 的 Windows 安装包能否在本机正常运行（未下载安装）
- 第二节各项目的体积取自 release 资产的 `content-length`（精确字节数换算），但**未逐个核对全部资产**
- Obsidian + Typst Mate 在本机的实际手感（未安装 Obsidian 验证 `$114514$` 的渲染/展开行为）
- 第三节 3.2 的实现要点是**设计设想，尚未写代码验证**
- 本仓库 WYSIWYG 方案的性能表现（公式逐个编译在互斥锁下的排队情况）未做压测

---

## 七、实现记录（2026-09-10，本文调研后的落地）

已按第三节的「CM6 widget decoration」路线实现，形态与结论一致（平时渲染、光标/选区进入展开源码）：

| 落地内容 | 位置 |
|---|---|
| 源码区域扫描（markup / code / raw / comment / string，`[...]` 内容块回到 markup） | `src/lib/typst-lex.ts` |
| 公式范围识别（`$x$` 行内 / `$ x $` 行间）、缓存键、选区相交判定 | `src/lib/math-ranges.ts` |
| 常用标记拆解（标题/粗体/斜体/行内代码/列表符号/`#link`） | `src/lib/markup-ranges.ts` |
| CM6 装饰：公式 replace widget + 标记隐藏/替换 + 渲染请求 | `src/lib/live-preview.ts` |
| 单公式编译为贴边透明 SVG + pt 尺寸 + 基线 | `compile_math`（`src-tauri/src/typst_world.rs`） |

**实测修正了调研中的三处设想**：

1. **基线不能从 typst 的 Page 帧读**：`page.frame.baseline()` 实测返回盒底（`has_baseline=false`）。改为「两页探针法」——第 2 页放同一公式 + 挂在基线下 100pt 的零宽盒，页高 = ascent + 100pt。外层 `#box(...)` 不可省，否则行间公式的探针会另起段落（ascent 由 11.75pt 变 31.67pt）。
2. **公式编译无需单独设计缩放**：把公式按编辑器字号（14px = 10.5pt）编译，SVG 的 pt 与编辑器 CSS 的 pt 1:1，直接写 `width/height: Npt` + `vertical-align: -(height-baseline)pt`。（**2026-09-15 起**：写作模式的公式字号跟随文档实际字号 —— Rust 侧 `compile_blocks` 的 `textPt` → `--write-doc-px`，源码模式的兜底值仍是 14px = 10.5pt。）
3. **暗色主题要反色**：typst 产物是黑字透明底，深色编辑器里会看不见 → widget 整体 `filter: invert(1)`（不能用 `&dark` 选择器，`EditorView.theme` 不支持，实测会让页面整页渲染成 500）。

**第二轮补齐**（同一形态的延伸）：

- **块级 widget**：独占整行的行间公式（含跨行书写 `$\n … \n$`）整行替换为**居中**式子。CodeMirror 的块级装饰**只能由 StateField 提供**（ViewPlugin 提供会抛 `Block decorations may not be specified via plugins`；实测确认 CM6 只对"函数型"动态装饰置 disallow 标记）。与文字同行的 `$ x $` 仍走行内 widget——整行替换会把旁边的正文一起盖掉。
- **文档内宏可用**：公式编译上下文 = 前缀 + 文档自身的**单行顶层** `#let` 定义（`math-context.ts`）。只取单行、不含内容块 `[...]`、且 `=` 后有值的语句；正在输入中的半截 `#let x =` 必须排除——否则拼进上下文会让**所有**公式一起编译失败。文档定义有错/与前缀重名时退回「仅前缀」重试一次。
- **有序列表编号**：`+ ` 按缩进分别计数替换为 `1. `。
- **性能**：编辑器每次重建只跑一遍 lexer，区域扫描结果复用给公式与标记两条扫描（此前 3 遍）：40k 字符文档每次按键 13.7ms → 4.7ms（4k 字符 0.5ms）。

**第三轮**：

- **围栏代码块**：```` ``` ```` 整段（含围栏行）替换为等宽代码块 widget，围栏自动收起，代码按 typst 语义剔除公共缩进；光标进入即整段回到源码。纯文本展示，不需要编译。
- **鲁棒性网**：`typst-scan-fuzz.test.ts` 用 120 份固定种子随机文档 + 15 组病态输入（未闭合 `$`、超长围栏、全符号、嵌套方括号等）断言三个扫描器不抛异常、区间有序不越界不重叠、区域无缝覆盖全文——这些扫描器**每次按键**都跑在任意用户文本上。

**仍未覆盖**（保持源码显示，可后续增量）：多行或含内容块的 `#let` 定义不参与公式上下文；写作模式的块级结构（表格/图片/引用块）**后来由块级切片覆盖**（表格仍按整块切、切片上没有文字层，见 `docs/文档模式渲染保真-调研.md`），本文写的是加块级渲染**之前**的状态。

验证：`cargo test compile_math`（真实排版与基线测量）、`npm test`（区域扫描/标记拆解/jsdom 装饰行为）、`node scripts/browser-check/wysiwyg.mjs`（真实浏览器 + 真实输入 + 真实选区的 23 项验收与截图；**这套验收后来一直在长，现在已经是 290 项**）。
