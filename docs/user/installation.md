# 安装与更新

[返回文档索引](../README.md) · 下一步：[入门](getting-started.md)

## 安装

仓库发布 Windows x64 的 NSIS 安装程序和 MSI 安装包。打开 [Releases](https://github.com/Z3O1/Typst-pad/releases/latest)，下载适合的安装包并运行；普通用户可选名称以 `-setup.exe` 结尾的安装程序。

无需另装 Typst CLI。应用自带编译引擎、中文与数学字体；在线包首次使用和检查更新需要联网。Linux / macOS 暂无同等发布保障，如需源码运行见[开发设置](../development/setup.md)。

## 更新

应用按设置在主窗口启动后静默检查；也可随时使用「帮助 → 检查更新」。发现版本后先显示提示，只有点击「下载并安装」才会下载和安装，Windows 安装程序负责重启应用。安装前保存文档。

「稍后」会抑制后续自动弹窗，状态栏仍可显示可用更新；手动检查或点击状态栏入口可再次打开。按 Esc 只是收起本次弹窗。设置中可关闭启动自动检查。

不带更新功能的旧安装版需要从 Releases 手动下载安装。检查或安装失败见[排障](troubleshooting.md)；维护更新服务见[更新器](../maintainers/updater.md)。
