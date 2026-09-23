# 开发环境与常用命令

项目使用 Node.js、Rust 和 Tauri 2。使用 Node.js 22 LTS 可覆盖仓库 CI 与日常开发；GitHub Actions 的 action 自身 Node 24 运行时与项目的 `setup-node` Node 22 版本是两回事。浏览器验收的 Node/WebSocket 运行器要求见 [`testing.md`](testing.md)，按该页面选择兼容 Node 版本即可。

桌面开发还需安装 Rust stable 和 Tauri v2 对应的系统依赖。Windows 请安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”工作负载及 Microsoft Edge WebView2 Runtime。Linux 系统包以 [CI workflow 的依赖清单](../maintainers/ci.md) 为准；macOS 使用 Xcode Command Line Tools。

克隆仓库后运行 `npm ci` 安装锁定的前端依赖。日常开发可用 `npm run tauri dev` 启动桌面应用，`npm run dev` 仅启动浏览器版开发 UI。常用验证入口：`npm run check`、`npm test` 与 `npm run format:check`。Rust、构建和浏览器验证的完整命令及选择原则统一放在[测试](testing.md)，避免环境说明维护第二份检查清单。字体文件可用 `node scripts/check-fonts.mjs` 校验。

编辑器装饰、布局或交互改动时，可运行 `npm run verify:browser` 做浏览器验收。该命令会启动验收所需的开发服务与 headless Chromium；真实文件对话框、系统字体、更新签名和安装过程仍需桌面版验证。详细测试选择与测试边界见 [`testing.md`](testing.md)。

开发应用：

```bash
npm run tauri dev
```

生产前端构建和桌面安装包构建分别使用 `npm run build` 与 `npm run tauri build`。本地打包启用更新签名，必须提供 `TAURI_SIGNING_PRIVATE_KEY_PATH`（指向已有私钥文件）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。发布维护者如何配置签名环境变量见 [`../maintainers/release.md`](../maintainers/release.md)。不要在命令、终端记录或文档中粘贴密钥内容。
