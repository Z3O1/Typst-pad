# Typst-pad

[![CI](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml/badge.svg)](https://github.com/Z3O1/Typst-pad/actions/workflows/ci.yml)

Typst-pad 是一款仿 Typora 的 Typst 桌面编辑器，适合边写边看数学公式、中文文档和排版效果。文档保存在本地 `.typ` 文件中，由内嵌 Typst 引擎编译，无需另装 Typst CLI。

## 为什么使用它

- **专注写作**：默认单栏纸张界面，普通正文可以直接编辑；公式和复杂内容就地呈现，进入编辑时露出对应源码。
- **随时查看源码**：`Ctrl+E` 切换到带行号的源代码模式，并在右栏查看整页预览。
- **本地排版**：打包中文与数学字体，支持本地文件、字体和包；首次下载在线包需要网络。
- **完整文档工作流**：打开、保存 `.typ`，导出 PDF，查看和复制编译诊断；支持主题、界面缩放和多个编辑窗口。

## 下载与开始使用

提供 **Windows x64** 安装包和自动更新。Linux / macOS 可作为源码开发目标，但没有同等的安装包发布与自动更新保障。

1. 从 [Releases 下载](https://github.com/Z3O1/Typst-pad/releases/latest) Windows 安装包并安装。
2. 新建文档或通过「文件 → 打开」选择 `.typ` 文件。
3. 输入正文和公式，例如 `$x^2 + y^2$`；需要源码与整页对照时按 `Ctrl+E`。
4. 按 `Ctrl+S` 保存，通过「文件 → 导出 PDF」输出文档。

详见[安装与更新](docs/user/installation.md)、[入门](docs/user/getting-started.md)和[快捷键](docs/user/shortcuts.md)。

## 当前主要限制

写作模式不是完整的页面排版视图：复杂块切片没有文字层，脚注正文等页底或浮动内容可能不显示。预览可按栏宽重排，分页可能不同于导出的 PDF；重要输出请检查 PDF。每个窗口编辑一份文档，副窗口不恢复会话。

完整边界与处理方式见[限制与排障](docs/user/troubleshooting.md)。

## 开始开发

准备 Node.js、Rust 与目标平台的 Tauri 系统依赖后：

```bash
npm ci
npm run tauri dev
```

环境要求见[开发设置](docs/development/setup.md)，提交改动请读[贡献指南](CONTRIBUTING.md)。

## 文档

[完整文档索引](docs/README.md)按用户、开发者、维护者和设计研究分层。Coding agent 从 [AGENTS.md](AGENTS.md) 按任务导航；发行历史见 [CHANGELOG.md](CHANGELOG.md)。文档描述当前仓库，安装版差异以发行说明为准。

## License

[MIT](LICENSE) © 2026 Z3O1
