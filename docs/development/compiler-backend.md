# 编译与 Typst 后端

本文说明编译数据流、Rust 中的 Typst 世界和字体解析契约。贡献者环境见 [`testing.md`](testing.md)，文件访问边界见 [`files-and-security.md`](files-and-security.md)。

## 编译链路

前端在 `src/routes/+page.svelte` 管理编译调度与结果应用：两种模式都调用 `compile_doc`，并将当前文档源码、文档路径、字体设置与可选的预览重排页面几何传入 Tauri 命令。未保存文档的路径为 `null`。Rust 命令位于 `src-tauri/src/compile_commands.rs`，排版引擎位于 `src-tauri/src/typst_world/`。

编译在 `spawn_blocking` 中执行，并由 `CompileState` 的互斥锁串行化，避免 Typst 编译任务并行使用该状态。前端用编译序号和会话/文档/上下文指纹忽略过期结果。文档模式编译失败时，前端把主文档的出错表达式临时投影为源码并重试整页编译，保留结构化错误诊断；源码模式或无法恢复的错误保留最后一次成功的预览。诊断映射回用户文档行列并形成编辑器标记，警告则在状态栏呈现。错误回退只改变预览输入，不修改原文或 PDF 导出输入，详见[文档模式](writing-rendering.md)。

`compile_doc` 返回 `CompileOutput { ok, pages, pageKeys, geometryId, diagnostics, warnings }`。请求可携带 `knownPages`（前端已落地产物的同位置指纹）；成功时 `pages` 按页序为 SVG 字符串或 `null`，后者只引用前端持有的对应 `pageKeys`。首次请求、切换文件或没有基准时传 `null`，完整返回全部 SVG。前端验证指纹和基准后还原完整页面；缺少或错位的引用按失败处理，不猜测页面。正常的排版错误以 `ok: false` 返回，`Err` 留给任务异常终止。成功产物携带新的整页命中编号与诊断，失败产物不携带编号或页清单。诊断行列从 1 开始，结束位置为独占边界；Rust 序列化省略主文档的 `path`，前端仍把桥接桩或旧 IPC 形状里的 `null` / 空字符串归一为“主文档”，以兼容无路径诊断。前端位置换算由 `src/lib/core/diagnostics-utils.ts` 负责。

`compile_doc` 还可携带 `previewPage { widthPt, heightPt, marginPt }`（**预览重排**，见下）：Rust 把一行 `#set page(...)` 插到**文档自己的页面设置之后**再编译，因此预览的换行/分页与保存、PDF 导出的产物不同（用户明确接受），但两者使用的是同一份原文：`export_pdf` 与写盘从不带这个参数。注入点由 `typst-syntax` 的最后一个顶层 `SetRule` / `ShowRule` 的语法末尾定位，不向后寻找换行（同行可能已有正文，换行也可能位于块注释内部）；typst 的 set 规则后写的赢，插在最前面会被文档的 `#set page(paper: "a4")` 覆盖。诊断先按字节回映到注入前的源码，再计算行列；几何源区间与字素停靠点也按字节回映（`InjectedLines` / `OffsetMapping`），前端仍按“前缀 + 用户文档”的线性坐标消费。产物页宽与请求不符（注入被覆盖）时前端退回等比缩放，不硬套重排假设。

整页几何每轮按当前 World 收集：主文档 Span 区间一次建索引，字形墨迹按字体、字号和 glyph ID 在同轮复用；不跨 Source 修订缓存源码映射。SVG 指纹以 Typst 0.15.1 默认导出实际使用的字段为依据：保留字体、字形、位置、变换、裁剪、标签、链接、图片和 Paint，忽略不可见的 Span、Tag 和页码元数据；Paint/图片仍完整散列，以保留资源 ID 的输入。`v2:` 指纹不能引用旧 `v1:` 基准；更换 Typst 或导出选项时必须重新审计并更新指纹域。帧摘要 FIFO 最多 4096 项，仅存哈希，不持有 Frame/Source。SVG LRU 最多 256 页、32 MiB 文本，超大单页不缓存。已持有同位置指纹的页不复制 SVG，也不序列化页面内容；服务器缓存淘汰不影响前端引用。几何编号与诊断始终更新，前端基准只在成功结果实际落地时更新。验证与复现见[测试](testing.md#文档模式性能复现)。

每轮仍构建独立 World，但共享不可变字体元数据（最多 4 套目录配置）与标准库（最多 8 种有序字体族配置）。主源缓存按项目根与 FileId 区分，最多 8 份、2 MiB UTF-8 正文；命中后使用字符边界安全差分和 `Source::edit` 增量解析，旧 World 的 COW 快照不变。正文预算不等于 AST/RSS 上限；超预算或淘汰均可重新解析。相对依赖每轮重新读取，不把主源缓存当成依赖缓存。缺少 `import` / `include` 关键词时省去路径 AST 扫描，命中时仍执行完整解析与原有根校验。编译通道任务结束后调用官方 `typst::comemo::evict(10)` 清理冷历史，不作废已持有的页面或几何；这不是热缓存或进程内存的硬上限。

前端会把启用的前缀代码拼在用户正文之前，编译偏移量按 UTF-8 字节长度计算，诊断展示时再映射到正文坐标；前缀自身的错误不应错误地标到正文行。诊断若无可定位 span（例如 detached span）会被 Rust 侧跳过；外部数据文件无法读取源文本时位置退化到起始位置。

`CompileState` 的锁在 `spawn_blocking` 中持有，锁中毒时通过 `into_inner()` 恢复，避免一次 panic 永久阻塞后续编译。任务 panic / runtime 关闭表现为 JoinError，由各命令按各自 IPC 契约转换为内部错误结果；正常 Typst 诊断仍走结构化结果。

PDF 导出由前端选择目标路径，再调用 `export_pdf`；Rust 编译 PDF 字节并通过受约束的写入路径落盘。整页交互由 `document_hit_test` 与 `document_cursor` 读取对应编号的缓存，不重新编译；旧块/公式命令保留为原生探针能力，产品前端不再调用。增加或改名 Tauri 命令时，必须同时更新 `src-tauri/src/lib.rs` 的 `generate_handler!` 列表。

## 文档路径与项目根

主文档源码直接由前端传入，因此未保存文档仍可编译。相对 `#import` 和 `#include` 按 Typst 路径语义从磁盘读取；未保存文档引用磁盘文件时，编译前检查会给出先保存文档的诊断。

项目根以文档所在目录为起点，并根据文档实际引用的相对路径逐层放宽。`typst_world::resolve_project_root` / `collect_required_roots` 会递归考虑被引用文件中的引用：对每条路径按 `Normal` 组件加一、`..` 组件减一计算它越出当前目录的层数，根需至少是该目录相应层数的祖先，最后取所有引用要求的公共祖先。不要改成按目标文件位置求公共祖先，否则 Typst 虚拟路径仍可能越界。

包路径（`@`）、根相对路径（以 `/` 开始）和绝对路径不参与向上放宽。目标尚不存在时仍按词法路径计算，以便报告文件不存在而非项目根越界。单根模型不能覆盖跨卷引用。实现与测试位于 `src-tauri/src/typst_world/paths.rs`。

整页编译默认按源码定义的纸型、页边距和分页输出；只在带 `previewPage` 时按该几何重新排版预览（见上）。视口宽度本身仍不进编译输入，前端只传“把预览栏换算成页宽”的结果，且只在**需要缩窄**时才传。

## Typst 包

`@local/{name}:{version}` 从应用数据目录的 `typst/packages/local/` 读取，`@preview/{name}:{version}` 从缓存目录的 `typst/packages/preview/` 读取；数据目录优先于缓存目录。根目录可由 `TYPST_PACKAGE_PATH` 和 `TYPST_PACKAGE_CACHE_PATH` 覆盖，目录约定与 Typst CLI 一致。实现位于 `src-tauri/src/packages.rs`。

找不到 `@preview` 包时，编译任务同步从 `https://packages.typst.org/preview/{name}-{version}.tar.gz` 下载（工作在线程池，不阻塞 UI），下载响应上限为 128 MiB、请求超时为 30 秒；包内继续导入其他包时会递归走相同解析。HTTP 404 映射为包或版本不存在，其他网络错误映射为下载失败，损坏归档映射为解压失败。

下载包先解压到缓存目录同一父目录的临时目录，成功后原子重命名到目标缓存路径，避免半成品污染缓存。解压前拒绝 `..`、绝对路径和盘符前缀，写入时再使用 tar 的 `unpack_in` 边界检查；不要绕过这两层校验。

## 字体解析

Typst 整页和 PDF 使用 Rust `FontBook`；源码编辑器使用等宽系统字体，界面文字使用 CSS 字体栈。字体实现位于 `src-tauri/src/typst_world/fonts.rs`，前端字体配置位于 `src/lib/core/font-settings.ts`。

字体搜索集合由打包字体、系统字体目录和用户额外目录组成。`resolve_fonts_dir` 优先使用 Tauri `resource_dir/fonts`，开发与测试退回 `src-tauri/fonts/`。缓存键必须包含打包目录和额外目录列表；修改目录列表后应重新加载字体。必须逐 face 注册 `.ttc` / `.otc` 集合字体，不能只取第一个 face。Windows 还扫描 `%LOCALAPPDATA%/Microsoft/Windows/Fonts`，Linux 扫描 `~/.fonts` 和 XDG 用户字体目录。打包字体清单和下载来源以 `scripts/download-fonts.mjs` 为准；新增字体时同步更新下载及校验流程。

字体族名以字体文件中的英文族名为准；设置列表不保证与 `typst fonts` 的本地化名称逐字一致，后者通过 fontdb 可能显示本地化族名或额外字体类型。比对可用字体时应核对英文族名。

`build_library` 注入默认字体族，使中英文和公式在不同平台得到稳定回退；注入在 Typst library 的基础样式层完成，因此文档自己的 `#set text(font: ...)` 仍优先。默认族列表以源码为准。用户字体选择顺序需保留拉丁基准族在首位，再放入所选字体和剩余兜底族。

字体族名写错时 Typst 会警告并静默回退，因此必须保留 warning 展示。正文、公式和 PDF 共用同一字体设置；保存字体设置后触发整页重编译。

Typst 整页 SVG 含字形轮廓，不依赖 WebView 上的同名字体；前端不再加载打包字体或补偿字体度量。打包字体只供原生编译使用。

WebView 开发启动与排障见[开发与验证](testing.md)。
