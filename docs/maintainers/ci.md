# 持续集成

CI 配置位于 `.github/workflows/ci.yml`。推送到 `main`、Pull Request 和手动触发都会运行 Ubuntu `test` job：安装 Tauri Linux 系统依赖、安装 Node 22 与稳定 Rust（含 rustfmt / clippy）、执行 `npm ci`，然后依次运行类型检查、前端单测、Prettier 检查、前端构建、rustfmt 检查、Clippy（告警视为错误）和 Rust 单测。

Windows `build-bundles` job 在 `main` 推送和手动触发时运行，Pull Request 不运行。它安装依赖、恢复 Rust 与 Tauri bundler 工具缓存、用更新签名 Secrets 构建 NSIS / MSI 安装包、生成 `latest.json` 并上传安装包和清单 artifact。

缓存配置需与 `.github/workflows/release.yml` 协调：Windows Rust cache 使用相同 `shared-key`，bundler cache 以 `package-lock.json` 哈希作为 key。不要启用 rust-cache 的失败时保存选项，避免中断任务写入不完整缓存。缓存未命中时先比较 workflow 的 restore key、Cargo.lock 和 Rust toolchain；依赖锁文件或 stable 工具链变化都会使 Rust 缓存失效。Tauri bundler cache 在 `package-lock.json` 变化时失效。怀疑缓存损坏时删除对应缓存后手动触发 `ci.yml`，该运行成功结束后，再手动触发一次确认命中。CI action 版本以 workflow 文件为准，不在文档重复维护版本列表。

修改 workflow 后检查触发条件、平台、依赖安装、密钥暴露范围、缓存共享规则及产物路径。Release workflow 自行检出 tag 并构建，不依赖 CI workflow 的 artifact；完整操作见 [`release.md`](release.md)。
