# Typst-pad

[![CI](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml/badge.svg)](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml)

Typst-pad 是一款仿 Typora 的 Typst 桌面编辑器，适合数学公式与中文文档写作。文档保存在本地 `.typ` 文件中，内嵌 **Typst 0.15.1** 编译引擎，无需另装 Typst CLI。

## 功能

- 文档模式：显示完整 Typst 编译页，点击定位，公式和脚本在原位置展开完整源码，由 Typst 重新排版。
- 源码模式：`Ctrl+E` 切换，右栏显示整页预览。
- 打包中文与数学字体，支持本地文件、字体和包；首次下载在线包需要网络。
- 打开、保存 `.typ`，导出 PDF；支持编译诊断、主题、界面缩放和多窗口。

## 下载与开始使用

提供 **Windows x64** 安装包和自动更新。

1. 从 [Releases 下载](https://github.com/Z3O1/Typst-pad/releases/latest) Windows 安装包并安装。
2. 新建文档或通过「文件 → 打开」选择 `.typ` 文件。
3. 按 `Ctrl+E` 切到源码模式输入正文和公式，例如 `$x^2 + y^2$`；再按 `Ctrl+E` 回到文档模式（文档模式只显示文档本体，没有切换按钮）。
4. 按 `Ctrl+S` 保存，通过「文件 → 导出 PDF」输出文档。

编译页以字形轮廓显示，查找与复制在源码编辑器中完成；外部文件输出可能无法精确点击定位。详见[使用指南](docs/user/guide.md)。

## 开始开发

准备 Node.js、Rust 与目标平台的 Tauri 系统依赖后：

```bash
npm ci
npm run tauri dev
```

环境要求见[开发设置](docs/development/testing.md)，提交改动请读[贡献指南](CONTRIBUTING.md)。

## 文档

- [使用指南](docs/user/guide.md) · [快捷键](docs/user/shortcuts.md)
- [完整文档](docs/README.md) · [发行历史](CHANGELOG.md)

## License

[MIT](LICENSE) © 2026 Z3O1
