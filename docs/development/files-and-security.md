# 文件操作与安全边界

贡献者环境见 [`setup.md`](setup.md)，编译与导出细节见 [`compiler-backend.md`](compiler-backend.md)。

## 文件命令

Tauri 文件 IPC 实现在 `src-tauri/src/file_commands.rs`、`dir_listing.rs`、`paths.rs`。前端通过 `isTauri()` 区分桌面端；浏览器运行模式只提供开发验收入口，不具备真实文件访问能力。

`.typ` 读写路径必须是绝对路径、扩展名为 `.typ`（大小写不敏感），并拒绝 `..` 穿越。读取前 canonicalize 并复检符号链接；写入拒绝符号链接。二进制写入和 PDF 导出由 `validate_write_path` 统一校验，不限制扩展名，但仍需满足路径安全约束。目录列表只递归 `.typ` 文件，最多深入 8 层、收集 500 个，跳过隐藏项且不递归符号链接目录。

当前 `write_file` / `write_binary` 使用 `fs::write`，语义是截断目标再写入，不是临时文件加 rename 的原子替换。若写入中途失败，目标文件可能已经被截断或部分写入；不要把现状描述成原子保存，改变写盘策略需单独评估恢复与替换语义。

文件关联打开通过 `PendingFiles` 队列和 `open-file` 事件传递。前端必须先注册事件监听，再读取待处理队列，避免两步之间到达的文件丢失。不要引入不经路径校验的读写入口。

## 文档保存与会话

持久化分为浏览器本地会话状态与显式文件保存。会话状态由 `src/lib/core/persistence.ts` 防抖写入 localStorage；文档磁盘写入唯一通路是 `document-session` 的 `save()` → `saveTypFile()` → Rust `write_file`。没有自动保存或定时写盘；编辑、切换文档或关闭窗口不得绕过该通路写入文件。

恢复上次正文受设置控制，且只恢复非空内容；正文、文件路径、标题和脏状态作为会话整体恢复。副窗口不拥有主窗口的文档会话：修改偏好时需保留已有会话字段，不能用副窗口的空文档覆盖主窗口恢复内容。只有主窗口清理主会话存档。

新建、打开、重载和关闭等可能丢弃未保存内容的操作遵循文档会话确认逻辑；打开当前文件的同一路径也必须确认未保存修改。空文档保存到现有文件时直接写入空内容，不增加额外确认步骤。保存到当前正在编辑的同一路径时，不要求“覆盖确认”；保存为另一个路径则由原生保存对话框和操作系统处理同名文件替换。

## WebView 与能力配置

Tauri 权限由 `src-tauri/capabilities/default.json` 控制。窗口标签必须与 capability 的 `windows` 模式匹配；新窗口能力还需包含 `core:webview:allow-create-webview-window`。新增窗口或插件功能时同步审查 capability，并运行 `scripts/capabilities.test.mjs` 所覆盖的权限检查。

`src-tauri/tauri.conf.json` 的 CSP 当前为 `null`。若改变 CSP，需经过生产桌面构建和实际 WebView 验证；浏览器开发模式不能代表 Tauri CSP 行为。更新器权限也由 capability 明确授予。
