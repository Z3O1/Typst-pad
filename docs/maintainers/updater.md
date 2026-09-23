# 自动更新

更新器由 Tauri updater 插件负责。配置位于 `src-tauri/tauri.conf.json`，前端流程位于 `src/lib/core/updater.ts`、`update-flow.ts` 和 `UpdateDialog.svelte`；权限见 `src-tauri/capabilities/default.json`。

启动时（仅主窗口）按用户设置延迟约数秒静默检查。发现版本后显示状态栏入口和确认弹窗；检查本身不下载或安装。用户可从菜单手动检查，手动失败会显示原因，自动检查失败仅记录诊断信息。不要以“距上次检查时间”为条件阻止启动检查。

用户选择稍后后，自动检查仍可更新状态栏，但不会再次自动弹窗；手动检查、点击状态栏入口或开始安装会清除此抑制状态。Esc 关闭更新弹窗只会收起，不等同于选择稍后，也不写入抑制标记。更新流程状态集中在 `updateFlow`，不要拆成彼此独立的状态布尔量。可用更新的插件句柄持有 Rust 资源，换版本或丢弃待安装更新时必须调用 `closeUpdate()` 释放；关闭失败可忽略。更新说明由 `update-notes.ts` 转义后渲染受控 Markdown 子集，支持范围以实现为准。

服务端清单 `latest.json` 由 `scripts/generate-latest-json.mjs` 生成，包含版本、更新说明、发布时间以及平台下载地址和签名。`pub_date` 按 RFC3339 日期时间解析。脚本读取 NSIS 安装包的 `.sig` 文件，更新说明来自 `CHANGELOG.md` 对应版本段。当前配置面向 Windows x86-64 更新；NSIS 是客户端更新器使用的安装包，尚未为其他平台提供更新资产。草稿 Release 不对客户端公开，只有发布后的 Release 资产可供 `releases/latest/download/latest.json` 获取。

签名验证是更新包完整性与来源验证的关键机制：CI 使用仓库 Secrets 中的签名私钥生成签名，客户端使用编译进应用的公钥校验。真实下载、验签和安装必须在桌面应用中验证；浏览器开发桩不执行这些步骤。签名密钥的保管与 Release 操作见 [`release.md`](release.md)。

若检查失败，先确认仓库公开可读、最新 Release 已 Publish 且含 `latest.json`，再检查网络。客户端匿名请求私有仓库时会收到 404，插件将非成功响应收敛为“无法获取有效 Release JSON”；草稿 Release 的资产同样无法由 latest 下载端点取得。故障排查时可用匿名请求检查 `https://github.com/Z3O1/Typst-pad/releases/latest/download/latest.json` 是否返回成功响应。

Windows 的 `downloadAndInstall` 在成功启动安装程序后会退出应用，安装器会重新启动应用，因此成功时 Promise 不一定返回；调用方不可把 Promise 正常 resolve 当成安装成功的唯一判据。
