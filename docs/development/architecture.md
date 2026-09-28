# 架构

[返回文档索引](../README.md)

## 层次与依赖方向

应用是 SvelteKit 静态 SPA，由 Tauri 承载，CodeMirror 管理编辑状态，Rust 进程内 Typst 负责排版。前端没有 Typst wasm 编译链路；包下载与更新检查是独立的网络能力。

| 位置 | 职责与边界 |
| --- | --- |
| `src/routes/` | 页面持有响应式状态，装配依赖和生命周期；不把领域算法持续堆进页面 |
| `src/lib/core/` | 文档会话、编译调度、源码投影与位置映射等纯模型与原生能力包装；不 import editor/ui/dev |
| `src/lib/editor/` | Editor、CodeMirror 扩展、输入语义与源码定位；依赖 core |
| `src/lib/ui/` | 菜单、弹窗、预览、状态栏及展示模型；依赖 core |
| `src/lib/dev/` | 浏览器桩与只读测试钩子，仅开发链路加载，不被生产模块引入 |
| `src-tauri/src/lib.rs` | 插件、setup、IPC 注册与应用事件装配 |
| `src-tauri/src/*_commands.rs` | 文件、字体、编译等原生命令与状态 |
| `src-tauri/src/typst_world/` | World、字体、项目路径、诊断、SVG/PDF |
| `src-tauri/src/block_geometry/` | 帧几何、坐标变换、命中与探针 |
| `src-tauri/src/packages.rs` | 包解析、下载缓存与安全解压 |

流程拆分采用依赖注入：例如 `document-session` 接收读写与确认回调，便于测试业务决策，不反向依赖 Svelte 页面。CodeMirror 视图行为归 editor，纯文档编译调度归 core。

## 数据流

源码编辑 → 页面同步文档与受控镜像 → 单槽整页编译调度 → `core/typst-engine.ts` 包装 IPC → Rust 编译通道 → 完整页面 SVG、诊断与几何编号 → 页面展示与独立编辑交互层。

文档模式直接显示完整编译页，点击公式或脚本后将完整表达式投影为 Typst raw，再编译整页，详见[文档模式渲染](writing-rendering.md)；源码模式显示原文与同一份整页预览。源码是唯一编辑真相，不从 SVG 反推文档结构。

编译产物、CodeMirror 文本与磁盘内容有不同生命周期。编译不能写回源码；会话恢复不能冒充显式保存。文件流程与窗口隔离见[文件与安全](files-and-security.md)。

## 配置与资源

- `svelte.config.js` 与 `src/routes/+layout.ts` 配置静态 SPA；`vite.config.js` 管开发服务器和 WebView 兼容处理。
- `vitest.config.ts` 管前端与脚本测试；格式规则见 `.editorconfig`、`.prettierrc.json`，Rust 使用默认 rustfmt。
- `src-tauri/tauri.conf.json` 管桌面打包、字体资源与更新配置；`src-tauri/capabilities/` 管窗口和插件权限。
- 打包字体的权威清单在 `scripts/download-fonts.mjs` 与资源配置；技术约束见[编译后端](compiler-backend.md)。
- `src-tauri/app-icon.svg` 是图标源。修改后运行 `npm run tauri icon src-tauri/app-icon.svg` 生成桌面图标，favicon 同源导出；清理生成的移动端目录。已安装应用需重装才能看到嵌入可执行文件的新图标。
- `.browser-check/` 是被忽略的验收产物目录；`.github/workflows/` 职责见 [CI](../maintainers/release.md)。

按具体任务继续阅读[编译后端](compiler-backend.md)、[整页交互](writing-rendering.md)与[测试](testing.md)，无需维护一份逐文件复制的模块清单。

## 编辑器与模式

`Editor.svelte` 封装 CodeMirror 创建、配置、外部文档同步、事件回调和销毁。`doc` 与传入编辑器的 `editorDoc` 必须随编辑同步更新；外部文档切换、重读时要明确替换内容并清理旧会话。编辑器销毁需要作废自身创建的后台回调。

应用提供文档模式和源码模式。两者显示同一份完整 Typst 页，文档模式通过透明输入层编辑原文档，源码模式显示源码与预览两栏。同一个 EditorView 保留文档、选区与撤销栈。源码模式折行设置独立持久化。点击定位、公式/脚本展开和页面光标见[文档模式渲染](writing-rendering.md)。

键盘处理有明确归属：菜单项快捷键由菜单匹配器管理，带 Shift 的应用快捷键由页面按键路由管理，编辑器输入语义由 CodeMirror keymap/input handler 管理。修改按键时检查优先级与事件冒泡，避免一次按键执行两个命令。格式命令是菜单与快捷键共用的纯计划函数：无选区的块级命令包装当前整行且保留原文，有选区则只替换选区；强调/行内包装把首尾空白留在定界符之外。Typst 引用块使用 `#quote(block: true)[...]`，不要插入 Markdown `>`。

页面级按键路由在 `app-keys.ts`。顺序是行为契约：Esc 只交给当前优先级最高的弹窗；`Alt+Z` 在 Ctrl/Cmd 门之前；新窗口与缩放组合在带 Shift 的格式命令表之前；源码重读只在已有文件时拦截；`Ctrl/Cmd+W` 关闭当前窗口。菜单键盘处理仍由 MenuBar 所有，避免窗口处理器重复触发。模式键为 `Ctrl/Cmd+E`，注释为 `Ctrl/Cmd+/`。不要把 Shift 组合塞进只支持 Ctrl+单键的菜单匹配器。

写作模式 Enter / Shift+Enter 先委托 Typst 列表语言扩展的续项/退出或续行命令；未接管时，普通 markup 中 Enter 写两个源码换行作为新段落，Shift+Enter 写 Typst 显式换行（反斜线 + 一个换行）。代码、raw、注释、代码字符串和公式内仍写单个普通换行；源码模式不套用写作段落语义。普通 markup 中的直引号仍属于可编辑正文。空白行清理残余缩进，不插入孤立反斜线。两种模式的新行都沿用光标左侧实际缩进；行尾已有换行时要复用，避免多插空行。缩进 / 反缩进是 `Ctrl+Tab` / `Ctrl+Shift+Tab`，一档四个空格；普通 `Tab` / `Shift+Tab` 自 2026-09-28 起也被编辑器接管 —— 补全候选打开时 `Tab` 先接受所选候选（公式里的候选就是 CM 补全面板），否则有选区给触碰的每行行首各加一个制表符、无选区直接插入 `\t`，`Shift+Tab` 反缩进（CM `indentLess`：制表符与四空格两种缩进都退一档）。桌面版已关掉 WebView2 浏览器加速键，Ctrl+Tab 才送得到页面（真实浏览器里它是浏览器级手势，只能在桌面版与 CDP 注入事件里验）。格式命令复用 `write-commands.ts` 的纯 EditPlan：取消带缩进的行首列表/标题标记时只删标记、保留缩进；行间公式选择锚点要由实际插入前缀长度计算，不能写死字符偏移。格式操作通过菜单/快捷键提供，不增加工具条。

## 布局、滚动与缩放

整页 SVG 保留原始版式，按共同系数等比缩放；窗口宽度只影响显示尺寸，不进入编译输入。预览使用稳定滚动条槽位，ResizeObserver 的测量推迟到下一帧。源码展开通过 Typst 重新排版；光标与透明输入层不参与页面布局。CodeMirror 的源码定位与模式切换通过编辑器滚动 API 表达，不直接写编辑器的 scrollTop。

UI 缩放使用 Tauri WebView 的 zoom 能力；CSS `zoom` 会混淆布局 CSS 像素和测量结果。缩放只能由用户命令改变，环境观察只用于报告实际比例，不能自动把用户档位改回去。布局宽度是缩放生效判定的主依据，devicePixelRatio 仅作诊断。滚轮步长不足时应累积，而不是每个事件独立取整丢掉。

缩放控制器在改档与复核期间设置沉降窗口；由缩放本身引起的 `resize` 不得重新校准 100% 布局宽度基准，否则会把有效缩放误读为未生效。读数非法时 fail-open，不据坏读数修改状态。确认/复核只观察，不回写用户档位，也不再次调用引擎；新一轮观察应作废旧代次。缩放轮次完成后才恢复正常窗口尺寸重校准。

错误与警告浮层共用一套 `openBadgePopover` 状态，关闭、Esc、点击外部、选择条目跳转和内容消失时行为一致；错误清空或警告关闭后不能留下空浮层/残余打开状态。弹出的面板（菜单下拉、右键菜单、关于/设置/更新/未保存确认四个对话框、诊断浮层）**跟随主题**，颜色由页面唯一的 `--panel-*` 变量定义：深色默认值在 `+page.svelte` 的 `:root`，浅色值在 `.app.light` 成对恢复，两条必须同改。每个面板根节点同时重绑前景、背景、边框、强调色并设置自身 `color`；悬停用深蓝底亮蓝字（浅色主题是浅蓝底蓝字），面板阴影、实心主按钮的字色（`--panel-btn-fg`，亮蓝底不能配白字）也走同一组变量。`.app` 同时声明 `color-scheme`（深色 `dark` / 浅色 `light`），让复选框、下拉框和滚动条跟随主题。状态栏诊断计数错误在前、警告在后并常驻显示 0；布局不折行，状态文本单行省略。复制诊断要保持焦点/选区，不关闭浮层或跳转。

夜间模式使用 `--night-svg-filter` 改变完整页面的屏幕显示：深色为 `invert(1) contrast(.71)`，浅色为 `none`。滤镜不修改编译产物、不触发重编译，PDF 仍按原文导出。嵌入彩色图片也会被屏幕滤镜反色，这是现有主题显示取舍。

## 交互与安全边界

- 菜单和弹层不应抢走编辑焦点；关闭菜单时按既定策略恢复焦点。
- 打开/重读文件必须尊重未保存修改确认；保存仍走统一文件会话写入链，不自动保存。
- 文档模式与源码模式复用完整页面、源码状态和单槽编译调度；展开使用临时编译投影，不修改原文档。
- 写作模式 IME 从 compositionstart 起保护；组合过程中保持编辑器状态和正文同步，但不能让异步替换组合区域的 DOM。组件卸载需取消本组件安排的所有后台工作。
- 所有用于用户文本的装饰区间必须合法且非空（对 mark 装饰），异常应在扩展边界处理并回退到源码显示。
- 多窗口的会话归属与文件安全详见[文件与安全](files-and-security.md)：副窗口是空白草稿，不恢复/覆盖主窗口会话；副窗口改偏好时保存 `session: false`；自动更新启动检查只由主窗口执行。新窗口 label `editor-*` 必须与两处 Tauri ACL 配置匹配并授予创建 webview window 能力，失败要显示状态栏错误。`open-file` 广播由焦点窗口认领；无焦点时仅主窗口延迟兜底，启动队列也只由主窗口认领。真实焦点、窗口交接和启动文件需桌面验证。
