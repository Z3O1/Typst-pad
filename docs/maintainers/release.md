# 发布与更新

发布由 `.github/workflows/release.yml` 执行，接受 `v*` tag 自动触发，也可手动触发并指定已有 tag。流程在 Windows runner 检出该 tag，安装 Node 22 / Rust 和 npm 依赖，恢复与 CI 共享的 Rust、打包工具缓存，构建 NSIS / MSI 安装包，生成 `latest.json`，最后创建包含安装包、签名文件和清单的草稿 Release。

发布前核对 `package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的版本一致，且 `CHANGELOG.md` 有对应版本说明。实际版本号以配置文件为准，历史记录以 CHANGELOG 为准。

## 签名密钥

`tauri.conf.json` 内的 updater 公钥用于客户端验签。构建更新包需配置仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；公钥配置已启用时，缺少私钥会使打包失败。CI 的 Windows 构建和 Release job 都需要这些 Secrets。不得生成替代密钥、覆盖公钥或将私钥写入仓库；失去对应私钥会使既有客户端无法信任新签名。

密钥备份应放在仓库工作区之外的受限位置，并避免在命令行参数、日志、聊天或文档中输出秘密内容。丢失私钥会导致无法为现有客户端签发可验证的更新；更换密钥也会使已安装客户端不信任新签名。

本地打包可在私钥文件路径和密码已配置到当前 shell 环境后运行：

```bash
npm run tauri build
```

设置 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指向已有私钥文件，并设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；不要把实际值写进命令示例或仓库。开发依赖安装见 [`../development/testing.md`](../development/testing.md)。

## 发布后验证

有权发布的维护者按以下顺序完成发布：先确认版本配置三处一致并补齐 CHANGELOG，再创建并推送 `vX.Y.Z` tag；workflow 自动构建并创建草稿。确认草稿资产包含 `latest.json`、NSIS 安装程序及对应 `.sig`，然后 Publish。草稿不可被客户端更新器读取。发布后运行：

```bash
node scripts/verify-release.mjs <版本>
```

该脚本匿名获取更新清单、核对版本、下载安装程序并用配置中的公钥验证签名。不要用手工解析替代它。CDN 的 latest 重定向更新可能有短暂延迟，若刚发布时验证到旧清单，应稍后重新运行。

发布操作的授权边界由根目录 [`AGENTS.md`](../../AGENTS.md) 规定；本文只记录发布技术流程。

## 持续集成

CI 配置位于 `.github/workflows/ci.yml`。推送到 `main`、Pull Request 和手动触发都会运行 Ubuntu `test` job：安装 Tauri Linux 系统依赖、安装 Node 22 与稳定 Rust（含 rustfmt / clippy）、执行 `npm ci`，然后依次运行类型检查、前端单测、Prettier 检查、前端构建、rustfmt 检查、Clippy（告警视为错误）和 Rust 单测。

Windows `build-bundles` job 在 `main` 推送和手动触发时运行，Pull Request 不运行。它安装依赖、恢复 Rust 与 Tauri bundler 工具缓存、用更新签名 Secrets 构建 NSIS / MSI 安装包、生成 `latest.json` 并上传安装包和清单 artifact。

缓存配置需与 `.github/workflows/release.yml` 协调：Windows Rust cache 使用相同 `shared-key`，bundler cache 以 `package-lock.json` 哈希作为 key。不要启用 rust-cache 的失败时保存选项，避免中断任务写入不完整缓存。缓存未命中时先比较 workflow 的 restore key、Cargo.lock 和 Rust toolchain；依赖锁文件或 stable 工具链变化都会使 Rust 缓存失效。Tauri bundler cache 在 `package-lock.json` 变化时失效。怀疑缓存损坏时删除对应缓存后手动触发 `ci.yml`，该运行成功结束后，再手动触发一次确认命中。CI action 版本以 workflow 文件为准，不在文档重复维护版本列表。

修改 workflow 后检查触发条件、平台、依赖安装、密钥暴露范围、缓存共享规则及产物路径。Release workflow 自行检出 tag 并构建，不依赖 CI workflow 的 artifact；发布操作见本页前文。

## 自动更新

更新器由 Tauri updater 插件负责。配置位于 `src-tauri/tauri.conf.json`，前端流程位于 `src/lib/core/updater.ts`、`update-flow.ts` 和 `UpdateDialog.svelte`；权限见 `src-tauri/capabilities/default.json`。

启动时（仅主窗口）按用户设置延迟约数秒静默检查。发现版本后显示状态栏入口和确认弹窗；检查本身不下载或安装。用户可从菜单手动检查，手动失败会显示原因，自动检查失败仅记录诊断信息。不要以“距上次检查时间”为条件阻止启动检查。

用户选择稍后后，自动检查仍可更新状态栏，但不会再次自动弹窗；手动检查、点击状态栏入口或开始安装会清除此抑制状态。Esc 关闭更新弹窗只会收起，不等同于选择稍后，也不写入抑制标记。更新流程状态集中在 `updateFlow`，不要拆成彼此独立的状态布尔量。可用更新的插件句柄持有 Rust 资源，换版本或丢弃待安装更新时必须调用 `closeUpdate()` 释放；关闭失败可忽略。更新说明由 `update-notes.ts` 转义后渲染受控 Markdown 子集，支持范围以实现为准。

服务端清单 `latest.json` 由 `scripts/generate-latest-json.mjs` 生成，包含版本、更新说明、发布时间以及平台下载地址和签名。`pub_date` 按 RFC3339 日期时间解析。脚本读取 NSIS 安装包的 `.sig` 文件，更新说明来自 `CHANGELOG.md` 对应版本段。当前配置面向 Windows x86-64 更新；NSIS 是客户端更新器使用的安装包，尚未为其他平台提供更新资产。草稿 Release 不对客户端公开，只有发布后的 Release 资产可供 `releases/latest/download/latest.json` 获取。

签名验证是更新包完整性与来源验证的关键机制：CI 使用仓库 Secrets 中的签名私钥生成签名，客户端使用编译进应用的公钥校验。真实下载、验签和安装必须在桌面应用中验证；浏览器开发桩不执行这些步骤。签名密钥的保管与 Release 操作见本页前文。

若检查失败，先确认仓库公开可读、最新 Release 已 Publish 且含 `latest.json`，再检查网络。客户端匿名请求私有仓库时会收到 404，插件将非成功响应收敛为“无法获取有效 Release JSON”；草稿 Release 的资产同样无法由 latest 下载端点取得。故障排查时可用匿名请求检查 `https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json` 是否返回成功响应。

Windows 的 `downloadAndInstall` 在成功启动安装程序后会退出应用，安装器会重新启动应用，因此成功时 Promise 不一定返回；调用方不可把 Promise 正常 resolve 当成安装成功的唯一判据。
