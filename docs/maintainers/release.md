# 版本与发布

发布由 `.github/workflows/release.yml` 执行，接受 `v*` tag 自动触发，也可手动触发并指定已有 tag。流程在 Windows runner 检出该 tag，安装 Node 22 / Rust 和 npm 依赖，恢复与 CI 共享的 Rust、打包工具缓存，构建 NSIS / MSI 安装包，生成 `latest.json`，最后创建包含安装包、签名文件和清单的草稿 Release。

发布前核对 `package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的版本一致，且 `CHANGELOG.md` 有对应版本说明。实际版本号以配置文件为准，历史记录以 CHANGELOG 为准。

## 签名密钥

`tauri.conf.json` 内的 updater 公钥用于客户端验签。构建更新包需配置仓库 Secrets `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；公钥配置已启用时，缺少私钥会使打包失败。CI 的 Windows 构建和 Release job 都需要这些 Secrets。不得生成替代密钥、覆盖公钥或将私钥写入仓库；失去对应私钥会使既有客户端无法信任新签名。

密钥备份应放在仓库工作区之外的受限位置，并避免在命令行参数、日志、聊天或文档中输出秘密内容。丢失私钥会导致无法为现有客户端签发可验证的更新；更换密钥也会使已安装客户端不信任新签名。

本地打包可在私钥文件路径和密码已配置到当前 shell 环境后运行：

```bash
npm run tauri build
```

设置 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指向已有私钥文件，并设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；不要把实际值写进命令示例或仓库。开发依赖安装见 [`../development/setup.md`](../development/setup.md)。

## 发布后验证

有权发布的维护者按以下顺序完成发布：先确认版本配置三处一致并补齐 CHANGELOG，再创建并推送 `vX.Y.Z` tag；workflow 自动构建并创建草稿。确认草稿资产包含 `latest.json`、NSIS 安装程序及对应 `.sig`，然后 Publish。草稿不可被客户端更新器读取。发布后运行：

```bash
node scripts/verify-release.mjs <版本>
```

该脚本匿名获取更新清单、核对版本、下载安装程序并用配置中的公钥验证签名。不要用手工解析替代它。CDN 的 latest 重定向更新可能有短暂延迟，若刚发布时验证到旧清单，应稍后重新运行。

发布操作的授权边界由根目录 [`AGENTS.md`](../../AGENTS.md) 规定；本文只记录发布技术流程。
