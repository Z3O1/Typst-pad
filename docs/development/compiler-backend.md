# 编译与 Typst 后端

本文说明编译数据流、Rust 中的 Typst 世界和字体解析契约。贡献者环境见 [`setup.md`](setup.md)，文件访问边界见 [`files-and-security.md`](files-and-security.md)。

## 编译链路

前端在 `src/routes/+page.svelte` 管理编译调度与结果应用：源码模式调用 `compile_doc`，写作模式调用 `compile_blocks`；两者都将当前文档源码、文档路径和字体设置传入 Tauri 命令。未保存文档的路径为 `null`。Rust 命令位于 `src-tauri/src/compile_commands.rs`，排版引擎位于 `src-tauri/src/typst_world/`。

编译在 `spawn_blocking` 中执行，并由 `CompileState` 的互斥锁串行化，避免 Typst 编译任务并行使用该状态。前端用编译序号忽略过期结果。编译失败时保留最后一次成功的预览；结构化诊断映射回用户文档行列并形成编辑器标记，警告则在状态栏呈现。

`compile_doc` 返回 `CompileOutput { ok, pages, diagnostics, warnings }`；正常的排版错误以 `ok: false` 返回，`Err` 留给任务异常终止。`compile_blocks` 即使失败也返回 `blocks` 字段。诊断行列从 1 开始，结束位置为独占边界；Rust 序列化省略主文档的 `path`，前端仍把桥接桩或旧 IPC 形状里的 `null` / 空字符串归一为“主文档”，以兼容无路径诊断。前端位置换算由 `src/lib/core/diagnostics-utils.ts` 负责，注入的页面设置行不应造成用户文档行号偏移。

前端会把启用的前缀代码拼在用户正文之前，编译偏移量按 UTF-8 字节长度计算，诊断展示时再映射到正文坐标；前缀自身的错误不应错误地标到正文行。诊断若无可定位 span（例如 detached span）会被 Rust 侧跳过；外部数据文件无法读取源文本时位置退化到起始位置。

`CompileState` 的锁在 `spawn_blocking` 中持有，锁中毒时通过 `into_inner()` 恢复，避免一次 panic 永久阻塞后续编译。任务 panic / runtime 关闭表现为 JoinError，由各命令按各自 IPC 契约转换为内部错误结果；正常 Typst 诊断仍走结构化结果。

PDF 导出由前端选择目标路径，再调用 `export_pdf`；Rust 编译 PDF 字节并通过受约束的写入路径落盘。公式编译使用独立的 `compile_math` 命令和缓存。增加或改名 Tauri 命令时，必须同时更新 `src-tauri/src/lib.rs` 的 `generate_handler!` 列表。

## 文档路径与项目根

主文档源码直接由前端传入，因此未保存文档仍可编译。相对 `#import` 和 `#include` 按 Typst 路径语义从磁盘读取；未保存文档引用磁盘文件时，编译前检查会给出先保存文档的诊断。

项目根以文档所在目录为起点，并根据文档实际引用的相对路径逐层放宽。`typst_world::resolve_project_root` / `collect_required_roots` 会递归考虑被引用文件中的引用：对每条路径按 `Normal` 组件加一、`..` 组件减一计算它越出当前目录的层数，根需至少是该目录相应层数的祖先，最后取所有引用要求的公共祖先。不要改成按目标文件位置求公共祖先，否则 Typst 虚拟路径仍可能越界。

包路径（`@`）、根相对路径（以 `/` 开始）和绝对路径不参与向上放宽。目标尚不存在时仍按词法路径计算，以便报告文件不存在而非项目根越界。单根模型不能覆盖跨卷引用。实现与测试位于 `src-tauri/src/typst_world/paths.rs`。

预览版心宽是编译输入：前端把宽度传给 `compile_doc`，Rust 注入页面设置；版心改变时需要重新编译。诊断映射需抵消这条注入行。

## Typst 包

`@local/{name}:{version}` 从应用数据目录的 `typst/packages/local/` 读取，`@preview/{name}:{version}` 从缓存目录的 `typst/packages/preview/` 读取；数据目录优先于缓存目录。根目录可由 `TYPST_PACKAGE_PATH` 和 `TYPST_PACKAGE_CACHE_PATH` 覆盖，目录约定与 Typst CLI 一致。实现位于 `src-tauri/src/packages.rs`。

找不到 `@preview` 包时，编译任务同步从 `https://packages.typst.org/preview/{name}-{version}.tar.gz` 下载（工作在线程池，不阻塞 UI），下载响应上限为 128 MiB、请求超时为 30 秒；包内继续导入其他包时会递归走相同解析。HTTP 404 映射为包或版本不存在，其他网络错误映射为下载失败，损坏归档映射为解压失败。

下载包先解压到缓存目录同一父目录的临时目录，成功后原子重命名到目标缓存路径，避免半成品污染缓存。解压前拒绝 `..`、绝对路径和盘符前缀，写入时再使用 tar 的 `unpack_in` 边界检查；不要绕过这两层校验。

## 字体解析

Typst 预览、公式和 PDF 使用 Rust `FontBook`；编辑器界面文字使用 CSS 字体栈。写作模式会把打包字体加载到 WebView，源代码模式使用等宽系统字体。字体实现位于 `src-tauri/src/typst_world/fonts.rs`，前端字体配置位于 `src/lib/core/font-settings.ts`。

字体搜索集合由打包字体、系统字体目录和用户额外目录组成。`resolve_fonts_dir` 优先使用 Tauri `resource_dir/fonts`，开发与测试退回 `src-tauri/fonts/`。缓存键必须包含打包目录和额外目录列表；修改目录列表后应重新加载字体。必须逐 face 注册 `.ttc` / `.otc` 集合字体，不能只取第一个 face。Windows 还扫描 `%LOCALAPPDATA%/Microsoft/Windows/Fonts`，Linux 扫描 `~/.fonts` 和 XDG 用户字体目录。打包字体清单和下载来源以 `scripts/download-fonts.mjs` 为准；新增字体时同步更新下载及校验流程。

字体族名以字体文件中的英文族名为准；设置列表不保证与 `typst fonts` 的本地化名称逐字一致，后者通过 fontdb 可能显示本地化族名或额外字体类型。比对可用字体时应核对英文族名。

`build_library` 注入默认字体族，使中英文和公式在不同平台得到稳定回退；注入在 Typst library 的基础样式层完成，因此文档自己的 `#set text(font: ...)` 仍优先。默认族列表以源码为准。用户字体选择顺序需保留拉丁基准族在首位，再放入所选字体和剩余兜底族。

字体族名写错时 Typst 会警告并静默回退，因此必须保留 warning 展示。正文、公式和 PDF 共用同一字体设置；保存字体设置后需要清理公式缓存并触发预览重编译。

Typst 预览和 PDF 的 SVG 含字形轮廓，不依赖用户机器上的同名字体。写作模式 WebView 透镜则通过 Rust `bundled_font` 白名单命令读取打包字体字节，再用 `FontFace` 注册到 `document.fonts`；每份字体独立捕获加载错误，缺字体时 CSS 栈退回系统字体，不应让编辑区启动失败。资源白名单与前端名单须保持一致。

前端 WASM 插件及 Linux WebKitGTK 开发启动约束见 [`debugging.md`](debugging.md)，此处不重复维护。
